/* #4952 — start-up auto-link of consent-free copies of a cloned voice. Runs on
   EVERY start (it is idempotent and cheap once done), not once.

   Before #4954, "Save to my voices" on a cloned voice copied the clone's
   `qwen-<cloneUuid>.pt` AND `.json` to `qwen-<newUuid>.*` and wrote a `designed`
   entry with `promotedFrom` and NO `consent`. `purgeCloneArtifacts` is keyed on
   the clone's own uuid, so a revoke never reached the copy.

   This re-labels each such copy as the clone it came from: provenance
   `cloned`, the clone's `consent` (incl. any `revokedAt`) and `clonedFrom`.
   `purgeCloneArtifacts` cascades from the clone (revoke or delete) to every entry
   carrying `clonedFrom`. A copy of an already-revoked clone is linked revoked
   and its voice FILES are erased, exactly as a revoke would (owner decisions,
   #4952); the library entry itself is never removed by this pass.

   EVIDENCE. A candidate is `designed` + `promotedFrom` + no `consent`, and one of:
   1. Its OWN sidecar manifest records the clone. The sidecar writes `clone: true`,
      `designModel: null` and `voiceUuid: null` (`/qwen/clone-voice` passes none),
      so the only origin is `voiceId`. `/promote` copied that file verbatim until
      494b9774 (v1.15.0), so an older copy still has `voiceId: qwen-<cloneUuid>`;
      a v1.15.0 copy had it restamped to its own key and records NO origin.
      A manifest with `designModel`/`instruct`, or without `clone: true`, is a
      designed voice and never matches.
   2. No origin recorded: `.pt` sha256 identical to a cloned entry's. A manifest
      and a byte match naming different clones link nothing.
   3. v1.15.0 copy of an already-revoked clone (no origin, bytes gone) — owner
      decision: only when the copy has the clone signature AND the cast slot at
      its `promotedFrom` is a `cloned` qwen slot naming a revoked clone with no
      `.pt` left (`revokedCloneFromSlot`). The slot is mutable (`/assign`
      rewrites it), which is why it is never evidence on its own.
   Anything that looks like a copy but links nothing is counted in the boot log.

   Idempotent without a marker file: a linked entry carries `clonedFrom` and is
   no longer a candidate. Every start also finishes a linked copy whose clone is
   revoked or gone but which a failed cascade left live (stamp, then purge).
   Writes go through `updateEntry` (per-uuid entry lock); the clone entry is only
   read, so no entry lock nests, and the one cast read is an un-nested `withBookOp`. */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { castJsonPath, qwenVoicePtPath, qwenVoiceSidecarPath } from './paths.js';
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

async function purgeLinkedCopy(copyUuid: string): Promise<void> {
  const { failed } = await purgeCloneArtifacts(copyUuid, {});
  if (failed.length > 0) {
    console.warn(
      `[clone-copy-autolink] ${failed.length} artifact(s) of revoked copy "${copyUuid}" ` +
        'could not be erased; the next start retries:',
      failed,
    );
  }
}

/** Result of reading a candidate's own sidecar manifest. */
type Origin =
  | { kind: 'clone'; cloneUuid: string } // the manifest records which clone it was copied from
  | { kind: 'signature' } // clone signature, but no recorded origin (a v1.15.0 copy)
  | { kind: 'not-a-copy' } // a manifest that says this is a designed voice
  | { kind: 'none' }; // absent / unreadable

/* What the sidecar actually writes for a clone (`/qwen/clone-voice` passes no
   voice_uuid): `{voiceId: 'qwen-<cloneUuid>', voiceUuid: null, clone: true,
   designModel: null, ...}`. `voiceUuid` is NEVER set, so the only recorded origin
   is `voiceId`. `/promote` copied that file verbatim until 494b9774 (v1.15.0)
   began restamping `voiceId` to the copy's own key, which erases the origin. */
async function originFromManifest(cand: VoiceLibraryEntry): Promise<Origin> {
  const m = await readJson<Record<string, unknown>>(qwenVoiceSidecarPath(`qwen-${cand.voiceUuid}`)).catch(
    () => null,
  );
  if (!m || typeof m !== 'object') return { kind: 'none' };
  if (m.clone !== true || m.designModel != null || m.instruct != null) return { kind: 'not-a-copy' };
  const id = typeof m.voiceId === 'string' && m.voiceId.startsWith('qwen-') ? m.voiceId.slice(5) : '';
  if (!id || id === cand.voiceUuid) return { kind: 'signature' };
  return { kind: 'clone', cloneUuid: id };
}

/* v1.15.0 copy of a clone revoked since: no recorded origin and the clone's bytes
   are gone. Owner decision (#4952): link ONLY when the cast slot at the copy's
   `promotedFrom` is a `cloned` qwen slot naming a revoked clone with no `.pt`
   left that predates the copy. The slot is single-valued, so "exactly one". The
   caller has already required the clone signature on the copy's manifest, which
   is what keeps a VoiceDesign voice out. Read-only, un-nested `withBookOp`. */
async function revokedCloneFromSlot(
  cand: VoiceLibraryEntry,
  byUuid: Map<string, VoiceLibraryEntry>,
): Promise<string | undefined> {
  const { bookId, characterId } = cand.promotedFrom ?? {};
  if (!bookId || !characterId) return undefined;
  let cast: { characters?: { id?: string; overrideTtsVoices?: Record<string, unknown> }[] } | null = null;
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
  const clone = byUuid.get(slot.libraryUuid);
  if (clone?.provenance !== 'cloned' || !clone.consent?.revokedAt || clone.clonedFrom) return undefined;
  if (cand.createdAt < clone.createdAt) return undefined;
  if ((await ptHash(clone.voiceUuid)) !== null) return undefined;
  return clone.voiceUuid;
}

export async function autolinkCloneCopies(): Promise<{ linked: string[]; unmatched: number }> {
  const entries = await listEntries();

  /* Retry a linked copy whose source clone is revoked (or gone — a delete erases
     the copies too) but which a failed cascade left live: stamp, then purge.
     Keyed on the CLONE, not the copy's own revokedAt, so a failed stamp is
     retried too. Per-copy try/catch: one bad copy never blocks the rest. */
  const byUuid = new Map(entries.map((e) => [e.voiceUuid, e]));
  for (const e of entries) {
    if (!e.clonedFrom) continue;
    const src = byUuid.get(e.clonedFrom);
    const sourceRevoked = !src || Boolean(src.consent?.revokedAt);
    if (!sourceRevoked) continue;
    try {
      if (e.consent && !e.consent.revokedAt) {
        await updateEntry(e.voiceUuid, (fresh) =>
          fresh?.consent && !fresh.consent.revokedAt
            ? { ...fresh, consent: { ...fresh.consent, revokedAt: new Date().toISOString() } }
            : null,
        );
      }
      if (existsSync(qwenVoicePtPath(`qwen-${e.voiceUuid}`))) await purgeLinkedCopy(e.voiceUuid);
    } catch (err) {
      console.warn(`[clone-copy-autolink] could not revoke linked copy "${e.voiceUuid}":`, err);
    }
  }

  const candidates = entries.filter(
    (e) => e.provenance === 'designed' && e.promotedFrom && !e.consent && !e.clonedFrom,
  );
  if (candidates.length === 0) return { linked: [], unmatched: 0 };

  // Built lazily: ordinary designed voices never need a hash.
  let cloneByHash: Map<string, string> | null = null;
  const hashIndex = async (): Promise<Map<string, string>> => {
    if (cloneByHash) return cloneByHash;
    cloneByHash = new Map();
    // Earliest-created clone wins a (pathological) hash collision between clones.
    const clones = entries
      .filter((e) => e.provenance === 'cloned' && e.consent && !e.clonedFrom)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const c of clones) {
      const h = await ptHash(c.voiceUuid);
      if (h && !cloneByHash.has(h)) cloneByHash.set(h, c.voiceUuid);
    }
    return cloneByHash;
  };
  const usableClone = (cand: VoiceLibraryEntry, uuid: string): boolean => {
    const c = byUuid.get(uuid);
    return Boolean(
      c && c.provenance === 'cloned' && c.consent && !c.clonedFrom && cand.createdAt >= c.createdAt,
    );
  };

  const linked: string[] = [];
  let unmatched = 0;
  for (const cand of candidates) {
    const origin = await originFromManifest(cand);
    if (origin.kind === 'not-a-copy') continue;

    let cloneUuid: string | undefined;
    if (origin.kind === 'clone') {
      // Corroboration: surviving bytes that match a DIFFERENT clone are a conflict.
      const h = await ptHash(cand.voiceUuid);
      const byBytes = h ? (await hashIndex()).get(h) : undefined;
      if (!usableClone(cand, origin.cloneUuid) || (byBytes && byBytes !== origin.cloneUuid)) {
        unmatched++;
        continue;
      }
      cloneUuid = origin.cloneUuid;
    } else {
      const h = await ptHash(cand.voiceUuid);
      const byBytes = h ? (await hashIndex()).get(h) : undefined;
      if (byBytes) {
        if (!usableClone(cand, byBytes)) {
          unmatched++;
          continue;
        }
        cloneUuid = byBytes;
      } else if (origin.kind === 'signature') {
        // v1.15.0 era: clone signature, no recorded origin. Only a revoked clone's slot links it.
        const anyRevokedGone = entries.some(
          (e) => e.provenance === 'cloned' && e.consent?.revokedAt && !existsSync(qwenVoicePtPath(`qwen-${e.voiceUuid}`)),
        );
        cloneUuid = anyRevokedGone ? await revokedCloneFromSlot(cand, byUuid) : undefined;
        if (!cloneUuid) {
          unmatched++;
          continue;
        }
      } else {
        continue; // no manifest, no byte match: an ordinary designed voice
      }
    }

    const linkedTo = cloneUuid;
    let updated = await updateEntry(cand.voiceUuid, async (fresh) => {
      // Re-check under the lock: another writer may have changed it since the scan.
      if (!fresh || fresh.provenance !== 'designed' || fresh.consent || fresh.clonedFrom) return null;
      const clone = await readEntry(linkedTo);
      if (!clone?.consent) return null;
      return { ...fresh, provenance: 'cloned', consent: { ...clone.consent }, clonedFrom: linkedTo };
    });
    if (updated?.clonedFrom !== linkedTo) continue;

    // A revoke may have landed between the clone read above and this write; its
    // cascade would then have missed this copy. Re-read and mirror it.
    if (!updated.consent?.revokedAt && (await readEntry(linkedTo))?.consent?.revokedAt) {
      updated =
        (await updateEntry(cand.voiceUuid, (fresh) =>
          fresh?.consent && !fresh.consent.revokedAt
            ? { ...fresh, consent: { ...fresh.consent, revokedAt: new Date().toISOString() } }
            : null,
        )) ?? updated;
    }

    linked.push(cand.voiceUuid);
    const revoked = Boolean(updated.consent?.revokedAt);
    console.log(
      `[clone-copy-autolink] linked voice "${cand.voiceUuid}" to its source clone "${linkedTo}"` +
        (revoked ? ' (revoked — erasing its voice files)' : ''),
    );
    // Outside the entry lock: purge takes its own. A revoked source means this
    // copy must not survive as a usable voice.
    if (revoked) await purgeLinkedCopy(cand.voiceUuid);
  }
  return { linked, unmatched };
}

/* The boot pass runs un-awaited so it never delays listen, but a "Save to my
   voices" pressed while it runs could mint a copy the pass has already scanned
   past; revoke the clone before the next start and that copy is never linked.
   `/promote` therefore waits on this gate (bounded; a curated retryable 503 if
   it does not finish). Taking the entry lock in /promote would not close it:
   the copy's entry does not exist yet when the pass lists the library. */
let bootPass: Promise<void> | null = null;
export const autolinkGate = { waitMs: 30_000 };

export function runAutolinkAtBoot(
  run: () => ReturnType<typeof autolinkCloneCopies> = autolinkCloneCopies,
): ReturnType<typeof autolinkCloneCopies> {
  const p = run();
  bootPass = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** True once the boot pass has settled (or never ran); false if it is still running after `ms`. */
export async function awaitAutolinkBootPass(ms: number = autolinkGate.waitMs): Promise<boolean> {
  if (!bootPass) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([bootPass.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
