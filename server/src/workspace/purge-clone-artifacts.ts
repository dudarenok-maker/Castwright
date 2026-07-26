/* fs-38 Wave 3b2, Task 2 — total consent-scoped erasure for a cloned Qwen
   voice. Both the revoke-consent flow (keep the voice-library entry, wipe
   the engine artifacts) and the delete-entry flow (wipe everything,
   including the entry dir) route through here, so neither can partially
   erase a clone and leave an orphaned artifact — the ad-hoc cleanup this
   replaces used to miss the `__1.7b.pt` variant for exactly that reason.

   Files are removed FIRST, the sidecar cache-evict LAST (best-effort): if
   the evict fails the artifacts are still gone; doing it the other way
   round risks the sidecar lazily reloading a "deleted" voice from disk
   between the evict and the unlink. */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
// Review I5 — qwenVoicePtPath now comes from paths.js, its actual home
// (alongside its qwenVoiceSidecarPath/qwenVoiceWavPath siblings), not from
// routes/qwen-voice.js. That route module re-exports it only for its own
// legacy call sites; pulling it from there dragged an Express router — and
// transitively synthesise-chapter.ts — into the workspace layer for what is
// just a path.join. No cycle exists today, but this removes a latent one.
import { qwenVoicePtPath, qwenVoiceSidecarPath, qwenVoiceWavPath } from './paths.js';
import { entryDir, readEntry, removeEntryDir, writeEntry } from './voice-library.js';
import { purgeVoiceSamples } from '../tts/voice-sample-cache.js';
import { getResolvedSidecarUrl } from './user-settings.js';

/** Review I-2 — a single file's best-effort unlink. `force: true` already
    swallows "doesn't exist" (the common case — most callers only have SOME
    of these artifacts); a `.catch` firing here means the file exists but
    couldn't be removed (e.g. Windows EBUSY/EPERM because the sidecar has it
    open mid-`torch.load`). For a contract whose whole promise is *total*
    erasure, that must not be swallowed silently — log it loudly and report
    the path back to the caller instead. */
async function unlinkTracked(f: string, voiceUuid: string, failed: string[]): Promise<void> {
  try {
    await rm(f, { force: true });
  } catch (err) {
    failed.push(f);
    console.warn(
      `[purge-clone-artifacts] failed to erase "${f}" for voice "${voiceUuid}" — artifact may still be on disk:`,
      err,
    );
  }
}

/** Review I-2 — returns the paths (if any) that could NOT be removed, so a
    caller (e.g. the revoke route) can surface a partial-erasure warning
    instead of silently claiming a clean 200. Still best-effort/never-throws
    for every other step — only the per-file removal outcome is tracked. */
export async function purgeCloneArtifacts(
  voiceUuid: string,
  opts: { deleteEntryDir?: boolean; deleteMasterClip?: boolean } = {},
): Promise<{ failed: string[] }> {
  const key = `qwen-${voiceUuid}`;
  const files = [
    qwenVoicePtPath(key),
    qwenVoiceSidecarPath(key),
    qwenVoicePtPath(`${key}__1.7b`),
    qwenVoicePtPath(`${key}-preview`),
    qwenVoiceSidecarPath(`${key}-preview`),
    // M2 (review) — the preview's own 1.7B variant, the same gap the base
    // key's `__1.7b.pt` fix (above) closed, just for the `-preview` key.
    qwenVoicePtPath(`${key}-preview__1.7b`),
    // §2.3 (fs-38 Wave 3b2, optional Task 11) — a DESIGNED voice's retained
    // reference clip. No-op (rm force) for a plain clone, which never has one.
    qwenVoiceWavPath(`${key}__master`),
    // Fix wave (consent-erasure gap) — the PREVIEW design also writes its own
    // `<key>-preview__master.wav` (see qwen-voice.ts design-voice with
    // preview:true). Never renamed onto the real key unless promoted (see the
    // promote-voice best-effort rename), so an unpromoted/rejected preview's
    // clip must be erasable here too, mirroring the preview .pt/.json above.
    qwenVoiceWavPath(`${key}-preview__master`),
  ];
  const failed: string[] = [];
  for (const f of files) await unlinkTracked(f, voiceUuid, failed);
  purgeVoiceSamples(key);
  // TODO(3c): when XTTS clone lands, also erase voices/xtts/xtts-<uuid>.pt here
  //   (spec §5.6). No xtts artifact exists on disk in 3b2, so omit it for now —
  //   but a future xtts clone would be un-erasable via this path if forgotten.
  if (opts.deleteEntryDir) {
    await removeEntryDir(voiceUuid);
  } else if (opts.deleteMasterClip) {
    /* User-directed (revoke must also erase the recording) — this is still
       revoke, not delete: the manifest + entry dir are kept so the card
       stays visible with its revoked state, but the person's actual
       recording is erased right alongside the derived engine artifacts
       above. Read the entry to find the clip's filename (it doesn't follow
       the `qwen-<uuid>*` naming convention the `files` list above uses —
       it's whatever `clipFile` the ingest step wrote), unlink it, then clear
       `master` so the manifest never points at a file that's gone. A plain
       delete (`deleteEntryDir`, above) doesn't need any of this — it removes
       the whole entry dir, clip included, in one shot. No-op when the entry
       or its `master` field is already absent. */
    const entry = await readEntry(voiceUuid);
    if (entry?.master) {
      await unlinkTracked(join(entryDir(voiceUuid), entry.master.clipFile), voiceUuid, failed);
      await writeEntry({ ...entry, master: undefined });
    }
  }
  // M2 (review) — evict both the base and `-preview` sidecar cache entries so
  // a `-preview` clone-prompt can't linger resident in sidecar memory after
  // "every artifact" was supposedly erased. Each POST is independently
  // best-effort — one failing must not skip the other.
  for (const voiceId of [key, `${key}-preview`]) {
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }
  }
  return { failed };
}
