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
   book named. Every other reader but the rebaseline (below) asks only whether the file
   exists (isSeparatedVoice).

   PR #4109 review pass 3 (owner decision 2026-11-13) -- WHICH records are "Don't reuse"
   voices. The rebaseline (voice-override-linked) keeps apart only a "Don't reuse" voice,
   never one first designed before Confirm, so it reads isDeclineSeparatedVoiceSync: an
   empty record (every "Don't reuse" separation, then and now), or an OwnStamp carrying
   `declined: true`, which a decline of a row already on an OwnStamp uuid adds
   (markDeclineSeparatedVoice; that decline mints nothing, so it writes no record of its
   own). An OwnStamp written before the flag existed cannot say whether such a decline
   followed it; the caller answers that from the cast (a row on the uuid carrying the
   decline marker), and without one it is not a "Don't reuse" voice, which is main's
   behaviour (the rebaseline unifies it). */

import { readFileSync, statSync } from 'node:fs';
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

/* A decline of a row whose uuid needed no new one: record that uuid as a "Don't reuse"
   voice. No record: an empty one. An OwnStamp: the same stamp plus `declined: true`, so
   isOwnSeparatedVoice still reads it. Anything else (already a "Don't reuse" record, or
   one that cannot be read, which already reads as one) is left alone. Returns the undo
   for a failed write after it, or undefined when nothing changed. */
export async function markDeclineSeparatedVoice(voiceUuid: string): Promise<(() => Promise<void>) | undefined> {
  const p = separatedVoicePath(voiceUuid);
  let body: string;
  try {
    body = await readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    await recordSeparatedVoice(voiceUuid);
    return () => forgetSeparatedVoice(voiceUuid);
  }
  const stamp = parseRecord(body);
  if (!stamp || stamp.declined === true) return undefined;
  await writeFile(p, JSON.stringify({ ...stamp, declined: true }));
  return () => writeFile(p, body).catch(() => {});
}

/* Is `voiceUuid` a "Don't reuse" voice? No record: no. An empty record, or a stamp with
   `declined: true`: yes. An OwnStamp without the flag: `heldByDecliner`, the caller's
   answer for a record written before the flag (see the header). Fails closed: a record
   that cannot be read or parsed counts as a "Don't reuse" one. Synchronous, like
   isSeparatedVoiceSync. */
export function isDeclineSeparatedVoiceSync(voiceUuid: string, heldByDecliner: boolean): boolean {
  let body: string;
  try {
    body = readFileSync(separatedVoicePath(voiceUuid), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (body.trim() === '') return true;
  const stamp = parseRecord(body);
  if (!stamp) return true;
  return stamp.declined === true || heldByDecliner;
}

/* A non-empty record's stamp, or null when it is not a JSON object. */
function parseRecord(body: string): (Partial<OwnStamp> & { declined?: unknown }) | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<OwnStamp> & { declined?: unknown }) : null;
  } catch {
    return null;
  }
}
