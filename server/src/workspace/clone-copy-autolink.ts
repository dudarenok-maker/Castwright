/* #4952 — one-time auto-link of consent-free copies of a cloned voice.

   Before #4954, "Save to my voices" on a cloned voice copied the clone's
   `qwen-<cloneUuid>.pt` to `qwen-<newUuid>.pt` and wrote a `designed` entry
   with `promotedFrom` and NO `consent`. `purgeCloneArtifacts` is keyed on the
   clone's own uuid, so a revoke never reached the copy.

   This re-labels each such copy as the clone it came from: provenance
   `cloned`, the clone's `consent` (incl. any `revokedAt`) and `clonedFrom`.
   `purgeCloneArtifacts` cascades from the clone to every entry carrying
   `clonedFrom`, so revoke now covers the copy. NOTHING is deleted here (owner
   decision, #4952) — a copy of an already-revoked clone is re-labelled revoked
   and then purged by the same path a revoke uses.

   A copy is identified by evidence, never a guess: `designed` + `promotedFrom`
   + no `consent` + `.pt` bytes identical to a cloned entry's. A revoke erases
   the clone's own `.pt`, so a copy of a clone revoked BEFORE this ran is
   linked by recorded origin instead (`originRevokedClone`); a copy that
   neither path identifies is counted (`unmatched`) and left alone.

   Idempotent without a marker file: a linked entry carries `clonedFrom` and is
   no longer a candidate. Writes go through `updateEntry` (per-uuid entry lock);
   the clone's entry is only read, never locked, so no lock nests. */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { castJsonPath, qwenVoicePtPath } from './paths.js';
import { BOOK_GONE, withBookOp } from './book-op-lock.js';
import { readJson } from './state-io.js';
import { listEntries, readEntry, updateEntry, type VoiceLibraryEntry } from './voice-library.js';
import { purgeCloneArtifacts } from './purge-clone-artifacts.js';

async function sha256File(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest('hex');
  } catch {
    return null;
  }
}

const ptHash = (voiceUuid: string): Promise<string | null> =>
  sha256File(qwenVoicePtPath(`qwen-${voiceUuid}`));

/* Link by RECORDED ORIGIN (owner decision, #4952) for a copy whose clone was
   revoked before this ran: revoke erased the clone's `.pt`, so bytes cannot be
   compared. `/promote` copied from the qwen slot's `libraryUuid` of the
   character named by the copy's own `promotedFrom` and never modified that
   cast.json, so that slot still names the source clone unless the character was
   reassigned since. Returns the clone's uuid only when every record agrees:
   the character's qwen slot is `cloned`, names a library entry that is a
   `cloned`, revoked clone with no `.pt` left on disk, created before the copy.
   Anything else (book/character gone, slot reassigned or not cloned, clone not
   revoked, or its bytes still present — then the hash compare already decided)
   returns undefined and the copy stays designed. */
async function originRevokedClone(
  cand: VoiceLibraryEntry,
  entries: VoiceLibraryEntry[],
): Promise<string | undefined> {
  const { bookId, characterId } = cand.promotedFrom ?? {};
  if (!bookId || !characterId) return undefined;
  let cast: { characters?: { id?: string; overrideTtsVoices?: Record<string, unknown> }[] } | null;
  try {
    const r = await withBookOp(bookId, ({ bookDir }) => readJson<typeof cast>(castJsonPath(bookDir)));
    cast = r === BOOK_GONE ? null : r;
  } catch {
    return undefined;
  }
  const slot = cast?.characters?.find((c) => c.id === characterId)?.overrideTtsVoices?.qwen as
    | { provenance?: unknown; libraryUuid?: unknown }
    | undefined;
  if (slot?.provenance !== 'cloned' || typeof slot.libraryUuid !== 'string') return undefined;
  const clone = entries.find((e) => e.voiceUuid === slot.libraryUuid);
  if (clone?.provenance !== 'cloned' || !clone.consent?.revokedAt || clone.clonedFrom) return undefined;
  if (cand.createdAt < clone.createdAt) return undefined;
  if ((await ptHash(clone.voiceUuid)) !== null) return undefined;
  return clone.voiceUuid;
}

export async function autolinkCloneCopies(): Promise<{ linked: string[]; unmatched: number }> {
  const entries = await listEntries();
  const candidates = entries.filter(
    (e) => e.provenance === 'designed' && e.promotedFrom && !e.consent && !e.clonedFrom,
  );
  if (candidates.length === 0) return { linked: [], unmatched: 0 };

  // Earliest-created clone wins a (pathological) hash collision between clones.
  const clones = entries
    .filter((e) => e.provenance === 'cloned' && e.consent && !e.clonedFrom)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const cloneByHash = new Map<string, string>();
  for (const c of clones) {
    const h = await ptHash(c.voiceUuid);
    if (h && !cloneByHash.has(h)) cloneByHash.set(h, c.voiceUuid);
  }

  const linked: string[] = [];
  let unmatched = 0;
  for (const cand of candidates) {
    const h = await ptHash(cand.voiceUuid);
    const cloneUuid = (h ? cloneByHash.get(h) : undefined) ?? (await originRevokedClone(cand, entries));
    if (!cloneUuid) {
      unmatched++;
      continue;
    }
    const updated = await updateEntry(cand.voiceUuid, async (fresh) => {
      // Re-check under the lock: another writer may have changed it since the scan.
      if (!fresh || fresh.provenance !== 'designed' || fresh.consent || fresh.clonedFrom) return null;
      const clone = await readEntry(cloneUuid);
      if (!clone?.consent) return null;
      return { ...fresh, provenance: 'cloned', consent: { ...clone.consent }, clonedFrom: cloneUuid };
    });
    if (updated?.clonedFrom !== cloneUuid) continue;
    linked.push(cand.voiceUuid);
    console.log(
      `[clone-copy-autolink] linked voice "${cand.voiceUuid}" to its source clone "${cloneUuid}"` +
        (updated.consent?.revokedAt ? ' (revoked — erasing its artifacts)' : ''),
    );
    // Outside the entry lock: purge takes its own. A revoked source means this
    // copy must not survive as a usable voice.
    if (updated.consent?.revokedAt) {
      const { failed } = await purgeCloneArtifacts(cand.voiceUuid, {});
      if (failed.length > 0) {
        console.warn(
          `[clone-copy-autolink] ${failed.length} artifact(s) of revoked copy "${cand.voiceUuid}" ` +
            'could not be erased; a later revoke/delete retries:',
          failed,
        );
      }
    }
  }
  return { linked, unmatched };
}
