/* <book>/.audiobook/manuscript-hints.json (#3703).

   A chapter restructure (merge / split / reorder / exclude / rename /
   refresh-titles) rebuilds the book's chapter bodies, but a restart re-derives
   them from a fresh parse of the manuscript, which knows nothing about the
   restructure. This file keeps the restructured bodies so a later reader can
   hydrate from them.

   The file holds up to MAX_HINTS_ENTRIES entries, newest first: the structure
   just written plus the one before it. A restructure writes this file BEFORE
   state.json, and a failed state.json write leaves the OLD structure on disk;
   keeping the previous entry means a reader still finds the entry that matches
   whichever state.json actually landed.

   Staleness key (per entry): `manuscriptId` + `manuscriptFile` + `sourceSha256` (sha256 of
   the manuscript bytes at write time) + each chapter's `uuid`. A reader proves
   the file belongs to the current state.json and manuscript by matching all of
   them. Only the BODY is persisted per chapter; titles, `excluded` and
   `titleSynthesized` stay owned by state.json.

   Written by the restructure under the state-json leaf lock, so this module
   takes no lock. It must not import store/manuscripts.ts (that module will
   import this one; a back-import would be a cycle). */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { manuscriptHintsJsonPath } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';

export const MANUSCRIPT_HINTS_SCHEMA = 1;

export const MAX_HINTS_ENTRIES = 2;

export interface PersistedManuscriptHints {
  schema: 1;
  entries: ManuscriptHintsEntry[];
}

export interface ManuscriptHintsEntry {
  manuscriptId: string;
  manuscriptFile: string;
  sourceSha256: string;
  writtenAt: string;
  chapters: Array<{ id: number; uuid: string; body: string }>;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Pair each hint with the state chapter of the SAME id, in `stateChapters`
    order. A restructure always yields matching counts and a uuid per chapter,
    so any mismatch is an invariant breach and throws. */
export function buildHintsEntry(args: {
  manuscriptId: string;
  manuscriptFile: string;
  sourceSha256: string;
  hints: ReadonlyArray<{ id: number; body: string }>;
  stateChapters: ReadonlyArray<{ id: number; uuid?: string }>;
}): ManuscriptHintsEntry {
  const { hints, stateChapters } = args;
  if (hints.length !== stateChapters.length) {
    throw new Error(
      `manuscript-hints: ${hints.length} hints but ${stateChapters.length} state chapters`,
    );
  }
  const bodyById = new Map<number, string>();
  for (const h of hints) bodyById.set(h.id, h.body);
  const chapters = stateChapters.map((sc) => {
    const body = bodyById.get(sc.id);
    if (body === undefined) throw new Error(`manuscript-hints: no hint for chapter id ${sc.id}`);
    if (!sc.uuid) throw new Error(`manuscript-hints: chapter id ${sc.id} has no uuid`);
    return { id: sc.id, uuid: sc.uuid, body };
  });
  return {
    manuscriptId: args.manuscriptId,
    manuscriptFile: args.manuscriptFile,
    sourceSha256: args.sourceSha256,
    writtenAt: new Date().toISOString(),
    chapters,
  };
}

/** The file to write: `entry` first, then the entry already on disk that
    validates against the PRE-restructure `preState` (the structure state.json
    holds until its own write lands). Entries that match nothing are dropped, so
    the file never exceeds MAX_HINTS_ENTRIES and never keeps a dead structure. */
export function composeHintsFile(
  entry: ManuscriptHintsEntry,
  previousFile: unknown,
  preState: HintsState,
  sourceSha256: string,
): PersistedManuscriptHints {
  const entries = [entry];
  const prevEntries = entriesOf(previousFile);
  for (const prev of prevEntries ?? []) {
    if (entries.length >= MAX_HINTS_ENTRIES) break;
    if (hintsFromEntry(prev, preState, sourceSha256).ok) entries.push(prev as ManuscriptHintsEntry);
  }
  return { schema: MANUSCRIPT_HINTS_SCHEMA, entries };
}

function entriesOf(file: unknown): unknown[] | null {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return null;
  const f = file as Record<string, unknown>;
  if (f.schema !== MANUSCRIPT_HINTS_SCHEMA || !Array.isArray(f.entries)) return null;
  return f.entries;
}

/** No `rotate`: nothing restores old structures from a backup. */
export async function writeManuscriptHints(
  bookDir: string,
  value: PersistedManuscriptHints,
): Promise<void> {
  await writeJsonAtomic(manuscriptHintsJsonPath(bookDir), value);
}

/** Delete the persisted file (reparse / replace-manuscript discard the
    restructure it recorded). Absent is fine; any other error throws. */
export async function removeManuscriptHints(bookDir: string): Promise<void> {
  await rm(manuscriptHintsJsonPath(bookDir), { force: true });
}

/** The persisted file, or `null` when there is none. Corrupt JSON throws a
    `SyntaxError`; any other I/O error is rethrown (the caller must not cache
    a fresh-parse record on a transient failure). */
export async function readManuscriptHints(bookDir: string): Promise<unknown | null> {
  return readJson<unknown>(manuscriptHintsJsonPath(bookDir));
}

export type HydratedHint = {
  id: number;
  title: string;
  body: string;
  excluded?: boolean;
  titleSynthesized?: true;
};

type HintsState = {
  manuscriptId?: string | null;
  manuscriptFile: string;
  chapters: ReadonlyArray<{
    id: number;
    uuid?: string;
    title: string;
    excluded?: boolean;
    titleSynthesized?: boolean;
  }>;
};

/** Validate a persisted hints file against the current state.json and the
    manuscript bytes' hash, and build the chapter hints from the first entry
    that passes (newest first; see MAX_HINTS_ENTRIES). Every check
    must pass (schema; manuscriptId + manuscriptFile; sourceSha256; and per
    position the chapter id, a non-empty uuid equal to state's, and a string
    body). The uuid check proves the file was written for a state.json with the
    same chapter uuids in the same order -- NOT that the bodies are the same: a
    split, reorder and merge that moves a passage between chapters returns to
    the same uuid sequence with different bodies. File-level invalidation covers
    the rest: reparse, replace-manuscript and an overwrite import all delete the
    file (or replace it with the bundle's).

    The file owns BODIES only. Titles, `excluded` and `titleSynthesized` come
    from state.json. Deliberately NOT re-applying the parser's front-matter
    default here (unlike the fresh-parse fallback): state.json is aligned and
    already records the user's choices, and re-applying the default would
    re-exclude a chapter the user re-included. */
export function hintsFromPersisted(
  file: unknown,
  state: HintsState,
  sourceSha256: string,
): { ok: true; hints: HydratedHint[] } | { ok: false; reason: string } {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    return { ok: false, reason: 'not an object' };
  }
  if ((file as Record<string, unknown>).schema !== MANUSCRIPT_HINTS_SCHEMA) {
    return { ok: false, reason: 'schema' };
  }
  const entries = entriesOf(file);
  if (!entries || entries.length === 0) return { ok: false, reason: 'entries' };
  let firstFailure = '';
  for (const entry of entries) {
    const r = hintsFromEntry(entry, state, sourceSha256);
    if (r.ok) return r;
    firstFailure ||= r.reason;
  }
  return { ok: false, reason: firstFailure };
}

function hintsFromEntry(
  entry: unknown,
  state: HintsState,
  sourceSha256: string,
): { ok: true; hints: HydratedHint[] } | { ok: false; reason: string } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, reason: 'entry shape' };
  }
  const f = entry as Record<string, unknown>;
  if (f.manuscriptId !== state.manuscriptId) return { ok: false, reason: 'manuscriptId' };
  if (f.manuscriptFile !== state.manuscriptFile) return { ok: false, reason: 'manuscriptFile' };
  if (f.sourceSha256 !== sourceSha256) return { ok: false, reason: 'sourceSha256' };
  const chapters = f.chapters;
  if (!Array.isArray(chapters) || chapters.length !== state.chapters.length) {
    return { ok: false, reason: 'chapter count' };
  }
  const hints: HydratedHint[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const fc = chapters[i] as Record<string, unknown> | null;
    const sc = state.chapters[i]!;
    if (typeof fc !== 'object' || fc === null) return { ok: false, reason: `chapter ${i} shape` };
    if (fc.id !== sc.id) return { ok: false, reason: `chapter ${i} id` };
    if (typeof fc.uuid !== 'string' || fc.uuid === '' || fc.uuid !== sc.uuid) {
      return { ok: false, reason: `chapter ${i} uuid` };
    }
    if (typeof fc.body !== 'string') return { ok: false, reason: `chapter ${i} body` };
    hints.push({
      id: sc.id,
      title: sc.title,
      body: fc.body,
      ...(sc.titleSynthesized === true ? { titleSynthesized: true as const } : {}),
      excluded: sc.excluded ? true : undefined,
    });
  }
  return { ok: true, hints };
}
