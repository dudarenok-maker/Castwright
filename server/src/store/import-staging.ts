/* In-memory staging area for parsed-but-not-yet-confirmed imports.

   POST /api/import parses the file and stores the result here keyed by a
   short tempId. POST /api/books then drains the entry (writing to disk +
   creating state.json) and evicts it. Entries auto-expire after 30 minutes
   to avoid leaking memory if the user abandons the confirm screen. */

import type { ChapterHint, ManuscriptFormat } from './manuscripts.js';

export interface StagedImport {
  tempId: string;
  format: ManuscriptFormat;
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  sourceText: string;
  chapters: ChapterHint[];
  originalFileName: string | null;
  byteSize: number;
  /** Original uploaded bytes — verbatim. Persisted to disk on confirm
      so re-parse can re-run the parser over the same input later.
      Required for ALL formats: EPUB/PDF need the binary, but markdown/
      plaintext also need it because parseText strips headings and
      injects audio tags into sourceText, so sourceText is NOT a
      faithful copy of the original. */
  originalBuffer: Buffer;
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const staging = new Map<string, StagedImport>();

function evictStale(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of staging) {
    if (v.createdAt < cutoff) staging.delete(k);
  }
}

export function putStaging(entry: StagedImport): void {
  evictStale();
  staging.set(entry.tempId, entry);
}

export function getStaging(tempId: string): StagedImport | undefined {
  evictStale();
  return staging.get(tempId);
}

export function dropStaging(tempId: string): void {
  staging.delete(tempId);
}
