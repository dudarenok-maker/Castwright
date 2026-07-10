/* fs-52 — durable sentence-text source for caption export. Sentence text for
   line/sentence captions comes from `manuscript-edits.json`, NOT the
   analysis cache (`server/handoff/cache/{manuscriptId}.json`): that cache is
   install-relative, transient-by-design resumable-analysis scratch space,
   and doesn't travel with the book if the workspace moves to another
   machine. `manuscript-edits.json` lives durably inside the book's own
   `.audiobook/` directory and already carries the `{id, chapterId,
   characterId, text}` shape needed — the same file `rebuildCacheFromEdits`
   (`../store/analysis-cache-rebuild.ts`) treats as the source of truth when
   the analysis cache itself is stale or absent.

   See docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §2. */

import { manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import type { SentenceOutput } from '../handoff/schemas.js';

interface EditsFile {
  sentences?: SentenceOutput[];
}

export async function loadManuscriptSentencesByChapter(
  bookDir: string,
): Promise<Record<number, Record<number, SentenceOutput>> | null> {
  const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
  const sentences = edits?.sentences ?? [];
  if (sentences.length === 0) return null;
  const byChapter: Record<number, Record<number, SentenceOutput>> = {};
  for (const s of sentences) {
    (byChapter[s.chapterId] ??= {})[s.id] = s;
  }
  return byChapter;
}
