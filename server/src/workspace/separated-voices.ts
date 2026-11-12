/* PR #4007 pass 13 (owner decision: a voice "Don't reuse" created is never shared
   with anyone outside the chain that moved with it) — the provenance of a voice
   uuid. A separation records the uuid it mints before any row moves onto it (and a
   decline that needed none records the decliner's own uuid), so a first design of
   that uuid is never shared, whichever row on it designs: the decliner, a follower
   that moved with it, or a same-book row on its key. Only the declining row carries
   the decline marker; this record is what covers the rest.

   One file per uuid (paths.ts separatedVoicePath): a uuid is minted once, so
   two writers never touch the same file, and nothing in a cast.json changes, so
   re-analysis and the analyzer grammar never see it. It survives a restart.

   Review pass 4 (🟠1) -- WHO a record vouches for. The file is empty for a
   "Don't reuse" separation (the uuid is shared with the followers that moved with it,
   so it proves nothing about any one row). A book-scoped mint or an isolation in an
   UNCONFIRMED book (a design before Confirm) writes an `OwnStamp` instead: the book that
   minted or isolated onto the uuid, and that book's `editEpoch` at the time. A series
   mint (a confirmed book) records nothing. Only that book, at that same epoch, may treat the uuid as its
   own (isOwnSeparatedVoice): Confirm leaves the epoch alone, but Re-parse and Start
   fresh rotate it, and another book that was later linked onto the uuid is not the
   book named. Every other reader asks only whether the file exists (isSeparatedVoice). */

import { statSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { separatedVoicePath } from './paths.js';

/** The book and generation that minted or isolated onto a uuid in an unconfirmed design. */
export interface OwnStamp {
  bookId: string;
  editEpoch: string;
}

export async function recordSeparatedVoice(voiceUuid: string, own?: OwnStamp): Promise<void> {
  const p = separatedVoicePath(voiceUuid);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, own ? JSON.stringify(own) : '');
}

/* Is `voiceUuid` recorded as THIS book's own, at this generation? Anything else (no
   record, an empty "Don't reuse" record, another book's or epoch's stamp, a record
   that cannot be read or parsed) is no: the caller isolates, which is the safe side. */
export async function isOwnSeparatedVoice(voiceUuid: string, own: OwnStamp): Promise<boolean> {
  try {
    const stamp = JSON.parse(await readFile(separatedVoicePath(voiceUuid), 'utf8')) as Partial<OwnStamp>;
    return stamp.bookId === own.bookId && stamp.editEpoch === own.editEpoch;
  } catch {
    return false;
  }
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
