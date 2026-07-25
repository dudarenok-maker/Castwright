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
import { qwenVoicePtPath } from '../routes/qwen-voice.js';
import { qwenVoiceSidecarPath, qwenVoiceWavPath } from './paths.js';
import { removeEntryDir } from './voice-library.js';
import { purgeVoiceSamples } from '../tts/voice-sample-cache.js';
import { getResolvedSidecarUrl } from './user-settings.js';

export async function purgeCloneArtifacts(
  voiceUuid: string,
  opts: { deleteEntryDir?: boolean } = {},
): Promise<void> {
  const key = `qwen-${voiceUuid}`;
  const files = [
    qwenVoicePtPath(key),
    qwenVoiceSidecarPath(key),
    qwenVoicePtPath(`${key}__1.7b`),
    qwenVoicePtPath(`${key}-preview`),
    qwenVoiceSidecarPath(`${key}-preview`),
    // §2.3 (fs-38 Wave 3b2, optional Task 11) — a DESIGNED voice's retained
    // reference clip. No-op (rm force) for a plain clone, which never has one.
    qwenVoiceWavPath(`${key}__master`),
  ];
  for (const f of files) await rm(f, { force: true }).catch(() => {});
  purgeVoiceSamples(key);
  // TODO(3c): when XTTS clone lands, also erase voices/xtts/xtts-<uuid>.pt here
  //   (spec §5.6). No xtts artifact exists on disk in 3b2, so omit it for now —
  //   but a future xtts clone would be un-erasable via this path if forgotten.
  if (opts.deleteEntryDir) await removeEntryDir(voiceUuid);
  try {
    await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: key }),
    });
  } catch {
    /* sidecar unreachable — non-fatal */
  }
}
