/* Analyzer eval-rate telemetry store. One record per (manuscript, chapter,
   analysis pass), folding EVERY Ollama chat() sub-call under that pass (chunks
   × coverage retries × validation retries). Append-only JSONL, best-effort,
   serialized so N pipelined analysis workers can't race the trim. Mirrors
   resource-telemetry.ts (fs-20) + model-vram-stats.ts (fs-45). */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';

/** Raw timing off one Ollama /api/chat `done:true` line. Durations in ns. */
export interface RawEvalTiming {
  model: string;
  evalCount: number;
  evalDuration: number;
  promptEvalCount: number;
  promptEvalDuration: number;
  loadDuration: number;
}

export interface AnalyzerEvalRecord {
  at: string;
  manuscriptId: string;
  bookTitle: string | null;
  model: string;
  stage: string;
  chapterId: number | 'book';
  evalTokS: number | null;
  promptTokS: number | null;
  evalCount: number;
  loadMs: number;
  subCalls: number;
  chunkCount: number | null;
  outcome: 'ok' | 'failed';
}

export interface PassContext {
  manuscriptId: string;
  bookTitle: string | null;
  stage: string;
  chapterId: number | 'book';
  chunkCount: number | null;
  outcome: 'ok' | 'failed';
}

/* ~2000 records is many full books; past that drop the oldest. */
export const ANALYZER_EVAL_MAX_LINES = 2000;

export function analyzerEvalStatsFilePath(): string {
  return join(telemetryDir(), 'analyzer-eval-stats.jsonl');
}

/** Ollama canonical tag: a bare family name resolves to ':latest'. */
export function canonicalModel(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

const rate = (count: number, durNs: number): number | null =>
  durNs > 0 ? count / (durNs / 1e9) : null;

/** Fold a pass's raw sub-call timings. Returns null on an empty accumulator
    (nothing decoded locally — e.g. a Gemini-only pass). tok/s is token-weighted
    (ΣevalCount / ΣevalDuration), NOT a mean of per-call rates. loadMs = max. */
export function foldPassTiming(acc: RawEvalTiming[]): {
  model: string; evalTokS: number | null; promptTokS: number | null;
  evalCount: number; loadMs: number; subCalls: number;
} | null {
  if (acc.length === 0) return null;
  let evalCount = 0, evalDur = 0, promptCount = 0, promptDur = 0, loadNs = 0;
  for (const x of acc) {
    evalCount += x.evalCount; evalDur += x.evalDuration;
    promptCount += x.promptEvalCount; promptDur += x.promptEvalDuration;
    if (x.loadDuration > loadNs) loadNs = x.loadDuration;
  }
  return {
    model: canonicalModel(acc[acc.length - 1].model),
    evalTokS: rate(evalCount, evalDur),
    promptTokS: rate(promptCount, promptDur),
    evalCount,
    loadMs: loadNs / 1e6,
    subCalls: acc.length,
  };
}

/* Serialized writer — a promise-chain mutex so a concurrent trim never races an
   append and drops lines (N pipelined analysis workers append concurrently). */
let writeQueue: Promise<void> = Promise.resolve();

/* In-memory line count so the append hot path doesn't re-read the whole JSONL
   every time just to enforce the cap. `null` = unknown (process start, or after
   an IO error); the next append establishes it from disk ONCE, then tracks it
   incrementally. Safe as a module singleton because every append is serialized
   through `writeQueue` — appendAndTrim never overlaps itself.

   Assumes this process is the sole writer of the file — the same assumption the
   old read-modify-write trim already relied on (that rewrite was never atomic
   across processes). A second process sharing telemetryDir (only under the
   recycle-storm defect — see project_sidecar_recycle_storm_two_supervisors)
   would go uncounted here until the next trim re-reads; acceptable for
   best-effort telemetry. Any drift also self-heals whenever a trim re-reads. */
let cachedLineCount: number | null = null;

export function __resetAnalyzerEvalQueueForTest(): void {
  writeQueue = Promise.resolve();
  cachedLineCount = null;
}

export function appendAnalyzerEval(rec: AnalyzerEvalRecord): Promise<void> {
  writeQueue = writeQueue.then(() => appendAndTrim(rec)).catch(() => {});
  return writeQueue;
}

/* Trim `lines` (the file's current non-empty lines) down to the cap, writing
   only when a trim is actually needed. Returns the resulting line count. */
async function trimToCap(path: string, lines: string[]): Promise<number> {
  if (lines.length <= ANALYZER_EVAL_MAX_LINES) return lines.length;
  const kept = lines.slice(lines.length - ANALYZER_EVAL_MAX_LINES);
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
  return kept.length;
}

async function appendAndTrim(rec: AnalyzerEvalRecord): Promise<void> {
  const path = analyzerEvalStatsFilePath();
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
    /* Steady state: the count is known and this append kept us under the cap —
       just increment, no read. This is the whole point of the counter. */
    if (cachedLineCount !== null && cachedLineCount + 1 <= ANALYZER_EVAL_MAX_LINES) {
      cachedLineCount += 1;
      return;
    }
    /* Otherwise the count is unknown (first append this process, or after an
       error reset) OR this append crosses the cap. Read the file ONCE and reuse
       that read for the trim — no double read on the first at-cap append. */
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    cachedLineCount = await trimToCap(path, lines);
  } catch {
    /* observability, not correctness — never break a run */
    cachedLineCount = null; // truth unknown after a failed write; re-establish next time
  }
}

/** Read newest-first, optionally capped. Skips a corrupt/partial trailing line;
    a missing file returns []. */
export async function readAnalyzerEvalRecords(limit?: number): Promise<AnalyzerEvalRecord[]> {
  let raw: string;
  try { raw = await readFile(analyzerEvalStatsFilePath(), 'utf8'); }
  catch { return []; }
  const out: AnalyzerEvalRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as AnalyzerEvalRecord); } catch { /* skip */ }
  }
  out.reverse();
  return limit != null && limit >= 0 ? out.slice(0, limit) : out;
}

/** Fold + append one pass's timing. No-op on an empty accumulator. Never throws. */
export function recordPassEval(acc: RawEvalTiming[], ctx: PassContext): Promise<void> {
  const folded = foldPassTiming(acc);
  if (!folded) return Promise.resolve();
  return appendAnalyzerEval({
    at: new Date().toISOString(),
    manuscriptId: ctx.manuscriptId,
    bookTitle: ctx.bookTitle,
    model: folded.model,
    stage: ctx.stage,
    chapterId: ctx.chapterId,
    evalTokS: folded.evalTokS,
    promptTokS: folded.promptTokS,
    evalCount: folded.evalCount,
    loadMs: folded.loadMs,
    subCalls: folded.subCalls,
    chunkCount: ctx.chunkCount,
    outcome: ctx.outcome,
  });
}

/** Wrap one pass invocation: install a FRESH accumulator on `call.onEvalTiming`,
    run `fn`, and emit exactly one record in a finally (outcome:'failed' if it
    threw). The fresh-per-call accumulator is the concurrency invariant — each
    pipelined pass owns a distinct `call`, so records never cross-contaminate.
    `chunkCountOf` reads chunkCount off the success result (null on failure). */
export async function withPassEval<T>(
  call: { onEvalTiming?: (t: RawEvalTiming) => void },
  ctx: Omit<PassContext, 'chunkCount' | 'outcome'>,
  fn: () => Promise<T>,
  chunkCountOf?: (result: T) => number | null,
): Promise<T> {
  const acc: RawEvalTiming[] = [];
  call.onEvalTiming = (x) => acc.push(x);
  let chunkCount: number | null = null;
  let outcome: 'ok' | 'failed' = 'ok';
  try {
    const result = await fn();
    chunkCount = chunkCountOf ? chunkCountOf(result) : null;
    return result;
  } catch (e) {
    outcome = 'failed';
    throw e;
  } finally {
    await recordPassEval(acc, { ...ctx, chunkCount, outcome });
  }
}
