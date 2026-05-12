/* Resumable analysis cache. Each successful stage / chapter is written to
   server/handoff/cache/{manuscriptId}.json so a mid-analysis failure (rate
   limit, network blip, the user picking a different model and hitting retry)
   doesn't lose work. The route loads the cache on entry and short-circuits
   anything already complete. Cache is keyed by manuscriptId only — switching
   models on retry is intentional, the design lets the user keep partial
   progress from model A and finish on model B. */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '..', '..', 'handoff', 'cache');

export interface AnalysisCache {
  stage1?: Stage1Output;
  /** chapterId → sentences. Keyed by number-as-string per JSON convention. */
  chapters: Record<number, SentenceOutput[]>;
  updatedAt?: string;
}

function cachePath(manuscriptId: string): string {
  return join(CACHE_DIR, `${manuscriptId}.json`);
}

export async function loadAnalysisCache(manuscriptId: string): Promise<AnalysisCache> {
  const cache = await readJson<AnalysisCache>(cachePath(manuscriptId));
  if (!cache) return { chapters: {} };
  /* JSON parse turns the chapter-id keys into strings, but the route uses
     numeric ids. Coerce shape so callers can use cache.chapters[chapterId]
     directly. */
  return { stage1: cache.stage1, chapters: cache.chapters ?? {}, updatedAt: cache.updatedAt };
}

export async function saveAnalysisCache(manuscriptId: string, cache: AnalysisCache): Promise<void> {
  await writeJsonAtomic(cachePath(manuscriptId), {
    ...cache,
    updatedAt: new Date().toISOString(),
  });
}

/* Discard any partial progress for a manuscript so the next analysis runs
   from scratch. Idempotent — no-op if the cache file doesn't exist. */
export async function clearAnalysisCache(manuscriptId: string): Promise<void> {
  await rm(cachePath(manuscriptId), { force: true });
}
