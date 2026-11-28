/* #4952 — auto-link of consent-free copies of a cloned voice.

   Before #4954, "Save to my voices" on a cloned voice copied the clone's
   `qwen-<cloneUuid>.pt` AND `.json` to `qwen-<newUuid>.*` and wrote a `designed`
   entry with `promotedFrom` and NO `consent`. `purgeCloneArtifacts` is keyed on
   the clone's own uuid, so a revoke never reached the copy.

   This re-labels each such copy as the clone it came from: provenance
   `cloned`, the clone's `consent` (incl. any `revokedAt`) and `clonedFrom`.
   `purgeCloneArtifacts` cascades from the clone to every entry carrying
   `clonedFrom`, so revoke covers the copy. A copy of an already-revoked clone
   is linked revoked and its voice files erased, exactly as a revoke would
   (owner decisions, #4952); the entry itself is kept, never removed.

   EVIDENCE, in order. A candidate is `designed` + `promotedFrom` + no `consent`.
   1. Its OWN sidecar manifest `qwen-<uuid>.json` (the recorded origin). The
      sidecar's `clone_voice` writes `clone: true` + `voiceUuid: <cloneUuid>`;
      `/promote` copied that file and `stampKeyVoiceId` rewrites only `voiceId`,
      so a real copy still names its clone — even after the clone's own bytes
      were erased by a revoke or re-derived. A VoiceDesign voice's manifest has
      `designModel`/`instruct` and no `clone`, so it can never match. The
      writer has emitted both fields since the clone endpoint was added
      (83bad1fc); a manifest lacking them is not evidence, and the copy falls
      through to (2). A designed voice that self-healed (re-derived through
      `clone_voice`, then its designed fields restored — clone-voice-resolver
      C-1) carries `clone: true` too, but with `designModel`/`instruct` set
      and/or its own uuid: neither is an origin.
   2. No usable manifest: `.pt` sha256 identical to a cloned entry's.
   When both exist and name different clones, nothing is linked.
   The CURRENT cast slot is deliberately not evidence: `/assign` overwrites it.

   Idempotent without a marker file: a linked entry carries `clonedFrom` and is
   no longer a candidate; a linked, revoked copy whose files survived (failed
   purge, crash between link and purge) is purged again on the next run.
   Writes go through `updateEntry` (per-uuid entry lock); the clone entry is
   only read, so no lock nests. */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { qwenVoicePtPath, qwenVoiceSidecarPath } from './paths.js';
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
  | { kind: 'clone'; cloneUuid: string }
  | { kind: 'not-a-copy' } // a manifest that says this is a designed voice
  | { kind: 'none' }; // absent / unreadable / carries no origin fields

async function originFromManifest(cand: VoiceLibraryEntry): Promise<Origin> {
  const m = await readJson<Record<string, unknown>>(qwenVoiceSidecarPath(`qwen-${cand.voiceUuid}`)).catch(
    () => null,
  );
  if (!m || typeof m !== 'object') return { kind: 'none' };
  if (m.clone !== true || m.designModel != null || m.instruct != null) return { kind: 'not-a-copy' };
  if (typeof m.voiceUuid !== 'string' || !m.voiceUuid || m.voiceUuid === cand.voiceUuid) {
    return { kind: 'none' };
  }
  return { kind: 'clone', cloneUuid: m.voiceUuid };
}

export async function autolinkCloneCopies(): Promise<{ linked: string[]; unmatched: number }> {
  const entries = await listEntries();

  // A linked, revoked copy whose voice files survived is purged again.
  for (const e of entries) {
    if (e.clonedFrom && e.consent?.revokedAt && existsSync(qwenVoicePtPath(`qwen-${e.voiceUuid}`))) {
      await purgeLinkedCopy(e.voiceUuid);
    }
  }

  const candidates = entries.filter(
    (e) => e.provenance === 'designed' && e.promotedFrom && !e.consent && !e.clonedFrom,
  );
  if (candidates.length === 0) return { linked: [], unmatched: 0 };

  const byUuid = new Map(entries.map((e) => [e.voiceUuid, e]));
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
      if (!byBytes) continue; // an ordinary designed voice
      if (!usableClone(cand, byBytes)) {
        unmatched++;
        continue;
      }
      cloneUuid = byBytes;
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
