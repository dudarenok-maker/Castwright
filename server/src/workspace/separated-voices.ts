/* PR #4007 pass 13 (owner decision: a voice "Don't reuse" created is never shared
   with anyone outside the chain that moved with it) — the provenance of a voice
   uuid. A separation records the uuid it mints before any row moves onto it (and a
   decline that needed none records the decliner's own uuid), so a first design of
   that uuid is never shared, whichever row on it designs: the decliner, a follower
   that moved with it, or a same-book row on its key. Only the declining row carries
   the decline marker; this record is what covers the rest.

   One empty file per uuid (paths.ts separatedVoicePath): a uuid is minted once, so
   two writers never touch the same file, and nothing in a cast.json changes, so
   re-analysis and the analyzer grammar never see it. It survives a restart. */

import { statSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { separatedVoicePath } from './paths.js';

export async function recordSeparatedVoice(voiceUuid: string): Promise<void> {
  const p = separatedVoicePath(voiceUuid);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, '');
}

/* A rollback: the separation that recorded `voiceUuid` moved no row onto it. */
export async function forgetSeparatedVoice(voiceUuid: string): Promise<void> {
  await rm(separatedVoicePath(voiceUuid), { force: true }).catch(() => {});
}

/* Fails closed: a record that cannot be read counts as present (a share lost,
   never a separated voice shared). */
export async function isSeparatedVoice(voiceUuid: string): Promise<boolean> {
  try {
    await stat(separatedVoicePath(voiceUuid));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/* The synchronous twin, for a step inside a cast lock's sync transform. Same
   fail-closed answer. */
export function isSeparatedVoiceSync(voiceUuid: string): boolean {
  try {
    statSync(separatedVoicePath(voiceUuid));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
