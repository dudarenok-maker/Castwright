/* In-memory manuscript store, with on-demand re-hydration from the workspace.
   The store itself is volatile — a server restart wipes it. `getOrHydrate`
   re-registers a manuscript by reading its file off disk via the workspace
   layer, so resume-after-crash and resume-after-restart both work as long as
   the book lives in the workspace tree. */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBookByManuscriptId } from '../workspace/scan.js';
import { parseManuscript } from '../parsers/index.js';

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
  /** Set when this manuscript was registered via POST /api/books (workspace
      flow). Lets the analysis route persist cast.json + state.json updates
      back into the on-disk book without scanning the whole workspace. */
  bookId?: string;
  bookDir?: string;
}

const store = new Map<string, ManuscriptRecord>();

export function putManuscript(record: ManuscriptRecord): void {
  store.set(record.manuscriptId, record);
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
}

/* In-memory lookup, with a workspace fallback that re-parses the manuscript
   file on disk if the in-memory record is missing (server restart, etc.).
   Returns undefined if the manuscript can't be located by either route. */
export async function getOrHydrateManuscript(
  manuscriptId: string,
): Promise<ManuscriptRecord | undefined> {
  const cached = store.get(manuscriptId);
  if (cached) return cached;

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

  /* Re-parse loses the excluded flag (it's set by the user, not the
     parser). Carry it forward from the on-disk state.json by matching
     on chapter id — that's the canonical key in both places. */
  const excludedById = new Map<number, boolean>();
  for (const c of book.state.chapters) {
    if (c.excluded) excludedById.set(c.id, true);
  }
  const chapterHints: ChapterHint[] = parsed.chapters.map((c) => ({
    ...c,
    excluded: excludedById.get(c.id) || undefined,
  }));

  const record: ManuscriptRecord = {
    manuscriptId,
    format: parsed.format,
    title: book.state.title,
    wordCount: parsed.sourceText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: buffer.length,
    uploadedAt: book.state.createdAt,
    sourceText: parsed.sourceText,
    chapterHints,
    bookId: book.state.bookId,
    bookDir: book.bookDir,
  };
  store.set(manuscriptId, record);
  return record;
}
