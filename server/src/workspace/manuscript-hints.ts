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
import { manuscriptHintsJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';

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
