/* <book>/.audiobook/manuscript-hints.json (#3703).

   A chapter restructure (merge / split / reorder / exclude / rename /
   refresh-titles) rebuilds the book's chapter bodies, but a restart re-derives
   them from a fresh parse of the manuscript, which knows nothing about the
   restructure. This file keeps the restructured bodies so a later reader can
   hydrate from them.

   Staleness key: `manuscriptId` + `manuscriptFile` + `sourceSha256` (sha256 of
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

export interface PersistedManuscriptHints {
  schema: 1;
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
export function buildPersistedHints(args: {
  manuscriptId: string;
  manuscriptFile: string;
  sourceSha256: string;
  hints: ReadonlyArray<{ id: number; body: string }>;
  stateChapters: ReadonlyArray<{ id: number; uuid?: string }>;
}): PersistedManuscriptHints {
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
    schema: MANUSCRIPT_HINTS_SCHEMA,
    manuscriptId: args.manuscriptId,
    manuscriptFile: args.manuscriptFile,
    sourceSha256: args.sourceSha256,
    writtenAt: new Date().toISOString(),
    chapters,
  };
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

/** Validate a persisted hints file against the current state.json and the
    manuscript bytes' hash, and build the chapter hints from it. Every check
    must pass (schema; manuscriptId + manuscriptFile; sourceSha256; and per
    position the chapter id, a non-empty uuid equal to state's, and a string
    body). The uuid sequence is the proof the file was written for exactly the
    structure state.json holds: a merge, split or reorder changes it, so a file
    from any other structure cannot match.

    The file owns BODIES only. Titles, `excluded` and `titleSynthesized` come
    from state.json. Deliberately NOT re-applying the parser's front-matter
    default here (unlike the fresh-parse fallback): state.json is aligned and
    already records the user's choices, and re-applying the default would
    re-exclude a chapter the user re-included. */
export function hintsFromPersisted(
  file: unknown,
  state: {
    manuscriptId?: string | null;
    manuscriptFile: string;
    chapters: ReadonlyArray<{
      id: number;
      uuid?: string;
      title: string;
      excluded?: boolean;
      titleSynthesized?: boolean;
    }>;
  },
  sourceSha256: string,
): { ok: true; hints: HydratedHint[] } | { ok: false; reason: string } {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    return { ok: false, reason: 'not an object' };
  }
  const f = file as Record<string, unknown>;
  if (f.schema !== MANUSCRIPT_HINTS_SCHEMA) return { ok: false, reason: 'schema' };
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
