/* In-memory manuscript store, with on-demand re-hydration from the workspace.
   The store itself is volatile — a server restart wipes it. `getOrHydrate`
   re-registers a manuscript by reading its file off disk via the workspace
   layer, so resume-after-crash and resume-after-restart both work as long as
   the book lives in the workspace tree. Chapter hints come from the restructured
   bodies persisted in .audiobook/manuscript-hints.json when that file provably
   matches state.json and the manuscript (#3703), else from a fresh parse. */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBookByManuscriptId } from '../workspace/scan.js';
import { parseManuscript } from '../parsers/index.js';
import { hintsFromPersisted, readManuscriptHints, sha256Hex } from '../workspace/manuscript-hints.js';
import { isLikelyFrontMatterTitle } from '../parsers/front-matter.js';

export type ManuscriptFormat = 'markdown' | 'plaintext' | 'epub' | 'pdf' | 'mobi';

export interface ChapterHint {
  /** 1-based index used as the canonical chapter id. */
  id: number;
  title: string;
  /** Normalised plain text body, with paragraph breaks preserved as \n\n. */
  body: string;
  /** User-controlled "skip from analysis + audio" flag. Front- or back-
      matter like Dedication, Copyright, About the Author. Mirrors the
      same field on BookStateJson.chapters[] and is rehydrated from there
      after a server restart. */
  excluded?: boolean;
  /** `true` only when the app itself made the title up (the fallback
      `Chapter N` for a chapter with no heading). Absent means the title came
      from the manuscript (heading, EPUB NCX / MOBI TOC label, PDF outline) or
      from the user. Never persisted as `false`: write `true` or omit the key.
      Server-only; not in openapi.yaml or the frontend types. */
  titleSynthesized?: boolean;
  /** The index of the parse chapter this hint's body came from, unmodified
      (#3828). Set where hints are born from a parse; carried through reorder,
      exclude, rename and refresh-titles; dropped by merge and split, whose
      bodies have no single origin. Absent on a hint of unknown origin. */
  parseIndex?: number;
}

/** Hints born from a parse, each stamped with the parse index it came from. */
export function withParseOrigin<T extends ChapterHint>(hints: readonly T[]): Array<T & { parseIndex: number }> {
  return hints.map((h, i) => ({ ...h, parseIndex: i }));
}

export interface ManuscriptRecord {
  manuscriptId: string;
  format: ManuscriptFormat;
  title: string;
  wordCount: number;
  byteSize: number;
  uploadedAt: string;
  /** Concatenated body across all chapters; what we hand to the analysis stage. */
  sourceText: string;
  chapterHints: ChapterHint[];
  /** sha256 of the manuscript file bytes `sourceText` and `chapterHints` were
      parsed from (#3703). The restructure stamps manuscript-hints.json with
      THIS, never with whatever the file holds at restructure time. Absent when
      the record was not built from a book's on-disk file. */
  sourceSha256?: string;
  /** The chapter count of the parse the hints' `parseIndex` values index into
      (#3828). Set once a restructure has persisted origins, and restored from
      the persisted file; absent while the hints are an unrestructured parse. */
  parseChapterCount?: number;
  /** Where `chapterHints` came from, set only by `hydrateFromDisk` (#3791):
      `persisted` = a validated manuscript-hints.json (its id + uuid sequence
      pairs with state.json), `parse` = the fallback fresh parse, which carries
      no identity. Absent = built alongside state.json from one parse in this
      process (import, sample, re-parse), so there is nothing to check.
      A restructure judges a `parse` record before it runs (#3837,
      `routes/chapters-restructure.ts`): by the saved analysis sentences where it
      can (`workspace/hints-proof.ts`), else by the positional title check
      (`parseTitles`). An analysis Start judges one too (`parseHintsStartCheck`,
      `routes/analysis.ts`): by the saved sentences where it can, positions
      without any on count/id alone, else (and on Start fresh) by count/id. */
  hintsSource?: 'persisted' | 'parse';
  /** The parser's own chapter titles, by position, for a `parse` record only;
      `null` where the parser made the title up (`Chapter N`), which says nothing
      about which chapter it is. `hintsFromParse` re-titles the hints from
      state.json, which hides a same-count mispairing, so the raw titles are kept
      to compare against it: at every position when the sentence check cannot
      run, and at the positions without saved sentences when it can (#3837). Also
      the purity test: a record whose hints still line up one-to-one with these
      titles, each hint at its own `parseIndex`, is an untransformed parse. */
  parseTitles?: Array<string | null>;
  /** Set when this manuscript was registered via POST /api/books (workspace
      flow). Lets the analysis route persist cast.json + state.json updates
      back into the on-disk book without scanning the whole workspace. */
  bookId?: string;
  bookDir?: string;
}

const store = new Map<string, ManuscriptRecord>();

/* PR #3714 review pass 6 -- a per-id count of every put and remove. A hydrate
   reads and parses with no lock held, so a put or remove can land between its
   read and its cache write; the hydrate compares the count it started with
   before it stores, and never reinstates a record that was superseded while it
   was reading. */
const versions = new Map<string, number>();

function bumpVersion(id: string): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
}

export function putManuscript(record: ManuscriptRecord): void {
  store.set(record.manuscriptId, record);
  bumpVersion(record.manuscriptId);
}

export function getManuscript(id: string): ManuscriptRecord | undefined {
  return store.get(id);
}

export function listManuscripts(): ManuscriptRecord[] {
  return Array.from(store.values());
}

/** Drop a manuscript record from the in-memory store. The next
    `getOrHydrateManuscript` call will re-hydrate from disk. Used by
    tests to reset between cases, and by routes that have applied a
    structural change and need to force fresh re-parse on the next
    analysis run. */
export function removeManuscript(id: string): void {
  store.delete(id);
  bumpVersion(id);
}

/* In-memory lookup, with a workspace fallback that rebuilds the record from the
   manuscript file on disk if the in-memory record is missing (server restart,
   etc.): chapter bodies from the persisted restructure hints when valid, else
   from a fresh parse. Returns undefined if the manuscript can't be located by either route.

   The hydrate caches its record only when no put or remove landed on the id
   while it was reading (PR #3714 review pass 6). If one did, what it read may
   be the superseded manuscript: it takes the record the writer stored, or
   reads again once. A second invalidation in a row answers whatever the store
   holds, never the record read before it. */
export async function getOrHydrateManuscript(
  manuscriptId: string,
): Promise<ManuscriptRecord | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = store.get(manuscriptId);
    if (cached) return cached;
    const version = versions.get(manuscriptId) ?? 0;
    const record = await hydrateFromDisk(manuscriptId);
    if ((versions.get(manuscriptId) ?? 0) !== version) continue;
    if (record) store.set(manuscriptId, record);
    return record;
  }
  return store.get(manuscriptId);
}

async function hydrateFromDisk(manuscriptId: string): Promise<ManuscriptRecord | undefined> {
  const book = await findBookByManuscriptId(manuscriptId);
  if (!book) return undefined;

  const manuscriptPath = join(book.bookDir, book.state.manuscriptFile);
  const buffer = await readFile(manuscriptPath).catch(() => null);
  if (!buffer) return undefined;

  const parsed = await parseManuscript({
    buffer,
    fileName: book.state.manuscriptFile,
  }).catch(() => null);
  if (!parsed) return undefined;

  /* A restructured book's bodies live in manuscript-hints.json, used only when
     it provably belongs to this state.json + manuscript. A missing, corrupt or
     stale file falls back to the fresh parse below. Any OTHER read error is
     transient: do not cache a fresh-parse record (the next analysis would write
     the wrong structure back); return undefined so the next call retries. */
  let persisted: unknown = null;
  try {
    persisted = await readManuscriptHints(book.bookDir);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn(`[manuscripts] ${manuscriptId}: manuscript-hints.json is corrupt; re-parsing`);
    } else {
      console.error(`[manuscripts] ${manuscriptId}: cannot read manuscript-hints.json`, err);
      return undefined;
    }
  }
  const sourceSha256 = sha256Hex(buffer);
  let chapterHints: ChapterHint[] | null = null;
  let parseChapterCount: number | undefined;
  if (persisted !== null) {
    const checked = hintsFromPersisted(persisted, book.state, sourceSha256);
    if (checked.ok) {
      chapterHints = checked.hints;
      parseChapterCount = checked.parseChapterCount;
    } else {
      console.warn(
        `[manuscripts] ${manuscriptId}: ignoring manuscript-hints.json (${checked.reason}); re-parsing`,
      );
    }
  }
  const fromParse = !chapterHints;
  if (!chapterHints) chapterHints = hintsFromParse(book.state, parsed.chapters);

  const record: ManuscriptRecord = {
    manuscriptId,
    format: parsed.format,
    title: book.state.title,
    wordCount: parsed.sourceText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: buffer.length,
    uploadedAt: book.state.createdAt,
    sourceText: parsed.sourceText,
    chapterHints,
    sourceSha256,
    ...(parseChapterCount !== undefined ? { parseChapterCount } : {}),
    hintsSource: fromParse ? 'parse' : 'persisted',
    ...(fromParse ? { parseTitles: parsed.chapters.map((c) => (c.titleSynthesized ? null : c.title)) } : {}),
    bookId: book.state.bookId,
    bookDir: book.bookDir,
  };
  return record;
}

/* Fallback when no valid hints file exists (#3703): derive the hints from a fresh
   parse. Re-parse loses the excluded flag (it's set by the user, not the
   parser). Carry it forward from the on-disk state.json by matching
   on chapter id — that's the canonical key in both places. */
function hintsFromParse(
  state: { chapters: ReadonlyArray<{ id: number; title: string; excluded?: boolean; titleSynthesized?: boolean }> },
  parsedChapters: ChapterHint[],
): ChapterHint[] {
  const excludedById = new Map<number, boolean>();
  for (const c of state.chapters) {
    if (c.excluded) excludedById.set(c.id, true);
  }
  /* A fresh parse also loses titles state.json has since moved on (a restructure
     renumbered app-made "Chapter N" titles). Align them by id, only while the
     chapter counts agree — after a merge/split the parse's ids no longer line
     up with state's, and an id match would graft a title onto the wrong body. */
  const stateById = new Map(state.chapters.map((c) => [c.id, c]));
  const aligned = state.chapters.length === parsedChapters.length;
  return withParseOrigin(parsedChapters).map((p) => {
    /* User's prior exclusions win; otherwise fall back to the parser's
       front/back-matter default so re-parse doesn't silently re-admit
       Acknowledgments/Copyright/CONTENTS to the queue (plan 148). The default
       reads the PARSE title: a chapter the user renamed to "Introduction" and
       kept included must not come back excluded after a restart. */
    const excluded = excludedById.get(p.id) || isLikelyFrontMatterTitle(p.title) || undefined;
    const sc = aligned ? stateById.get(p.id) : undefined;
    if (!sc) return { ...p, excluded };
    const { titleSynthesized: _drop, ...rest } = p;
    return {
      ...rest,
      title: sc.title,
      ...(sc.titleSynthesized === true ? { titleSynthesized: true } : {}),
      excluded,
    };
  });
}
