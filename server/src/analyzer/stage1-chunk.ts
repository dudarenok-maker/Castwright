/* Stage-1 (cast detection) large-chapter chunking (plan 219 follow-on / srv-40).

   Stage-1 sends a chapter's whole prose to the model to detect its speaking
   roster. Unlike stage-2 (which got a chunker in #528), stage-1 had none — so a
   very large chapter overflows the model's context window (`num_ctx`): the INPUT
   alone fills the window, leaving no room for output, and Ollama stops with
   `done_reason:'length'` after ~0 bytes (`AnalyzerTruncatedError`). A Cyrillic
   book made this acute — non-Latin text tokenises to far more tokens per
   character, and the book's chapters were unusually large (the 2026-06-16
   `Ночной дозор` report: every chapter truncated after 1–1231 bytes).

   This splits an over-budget chapter into paragraph-bounded sub-bodies, detects
   the roster on each, and UNIONs the per-chunk rosters. The union is INJECTED
   (`mergeRosters`, the route's `mergeRosterChapter`) so this module stays pure —
   no I/O, no model calls, no prompt building, mirroring stage2-chunk.ts.

   Each section is detected INDEPENDENTLY against the book-level running roster
   the caller supplies — the accumulated intra-chapter roster is deliberately NOT
   threaded into later sections. Threading it amplified a small-model failure on
   non-Latin text (2026-06-16): seeing a full name like "Антон Сергеевич
   Городецкий" in the section-N prompt, qwen3.5:4b copied the surname onto
   unrelated characters in section N+1 and folded distinct names together.
   Cross-CHAPTER id stability still comes from the caller's running roster.

   A chapter that already fits the budget runs exactly one call and returns its
   raw result — byte-identical to the pre-chunking behaviour for the overwhelming
   majority of chapters. */

import type { CharacterOutput } from '../handoff/schemas.js';
import { AnalyzerTruncatedError } from './errors.js';
import { configValue } from '../config/resolver.js';
import { splitBodyIntoChunks, splitParagraphIntoSentences } from './stage2-chunk.js';

/* Per-chunk INPUT char budget. Stage-1 output is small (a roster, not a
   per-sentence list), so the binding constraint is the input fitting num_ctx
   with room for the prompt scaffolding + the (small) output — not the output
   cap that bounds stage-2. Conservative default; tuned down for local engines
   from num_ctx. */
export const DEFAULT_STAGE1_CHUNK_CHAR_BUDGET = 24000;

/* Derive a safe per-chunk char budget from the local model's context window.
   Reserve ~30% of num_ctx for the prompt header + roster + output, and assume a
   pessimistic ~2 chars/token (Cyrillic and other non-Latin scripts tokenise far
   denser than English's ~4 — budgeting for the dense case keeps a non-Latin
   chapter from overflowing). Take the MIN with the configured default so this
   only ever LOWERS the budget. Cloud engines keep the configured value. A
   residual overflow is still caught by the adaptive re-split below. */
export function stage1ChunkBudgetForEngine(
  configured: number,
  numCtxTokens: number,
  engine: 'gemini' | 'local',
): number {
  /* Cloud engines have a huge context window and a small stage-1 output, so
     there is no input-overflow to guard against — never chunk (one call per
     chapter, unchanged). Only the local model has a tight `num_ctx`. */
  if (engine !== 'local') return Number.MAX_SAFE_INTEGER;
  const numCtxDerived = Math.floor(numCtxTokens * 0.7 * 2);
  return Math.max(2000, Math.min(configured, numCtxDerived));
}

export function resolveStage1ChunkCharBudget(engine?: 'gemini' | 'local'): number {
  if (engine !== 'local') return Number.MAX_SAFE_INTEGER; // cloud: never chunk stage-1
  return stage1ChunkBudgetForEngine(
    configValue<number>('analyzer.stage1.chunkCharBudget'),
    configValue<number>('analyzer.ollama.numCtx'),
    'local',
  );
}

export interface Stage1ChunkRunResult {
  characters: CharacterOutput[];
  /** How many chunks the chapter was split into (1 = single-call path). */
  chunkCount: number;
}

export interface Stage1ChunkRunOptions {
  /** The full chapter prose. */
  body: string;
  /** Per-chunk char budget (resolveStage1ChunkCharBudget()). */
  charBudget: number;
  /** Build + run the stage-1 detection call for a sub-body. Each section is
      detected independently against the caller's book-level running roster (the
      intra-chapter accumulation is intentionally NOT passed — see header). */
  callForBody: (subBody: string) => Promise<{ characters: CharacterOutput[] }>;
  /** Injected roster union (the route's `mergeRosterChapter`) — folds a chunk's
      characters into the accumulating Map. Keeps this module pure + testable. */
  mergeRosters: (running: Map<string, CharacterOutput>, chars: CharacterOutput[]) => void;
  /** Adaptive re-split recursion bound. Default 3. */
  maxSplitDepth?: number;
  /** Fired once per chunk before it runs (large-chapter progress). */
  onChunk?: (info: { index: number; total: number; chars: number }) => void;
}

/** Detect a chapter's roster, transparently chunking when the body is larger
    than `charBudget`. See the module header. */
export async function runStage1ChapterChunked(
  opts: Stage1ChunkRunOptions,
): Promise<Stage1ChunkRunResult> {
  const maxSplitDepth = opts.maxSplitDepth ?? 3;
  const roster = new Map<string, CharacterOutput>();

  /* Split an over-cap span for a retry: paragraph boundaries first (lossless),
     then — when the span is a single paragraph that won't divide — sentence
     boundaries. Mirrors stage2-chunk's splitSpanForRetry. */
  const splitSpanForRetry = (span: string): string[] => {
    const half = Math.max(1, Math.floor(span.length / 2));
    const byParagraph = splitBodyIntoChunks(span, half);
    if (byParagraph.length > 1) return byParagraph;
    return splitParagraphIntoSentences(span, half);
  };

  /* Detect one span, splitting it further if the model truncates on it. */
  const detectSpan = async (span: string, depth: number): Promise<void> => {
    try {
      const { characters } = await opts.callForBody(span);
      opts.mergeRosters(roster, characters);
    } catch (err) {
      if (err instanceof AnalyzerTruncatedError && depth < maxSplitDepth) {
        const sub = splitSpanForRetry(span);
        if (sub.length > 1) {
          for (const s of sub) await detectSpan(s, depth + 1);
          return;
        }
      }
      throw err;
    }
  };

  const chunks = splitBodyIntoChunks(opts.body, opts.charBudget);

  if (chunks.length <= 1) {
    /* Common case: chapter fits the char budget → one call, raw result
       (byte-identical to the pre-chunking behaviour). If that single call
       truncates anyway (a dense chapter under a smaller-than-assumed window),
       fall back to the adaptive split instead of failing the chapter. A body
       that's a single un-splittable paragraph still surfaces the truncation. */
    try {
      const { characters } = await opts.callForBody(opts.body);
      return { characters, chunkCount: 1 };
    } catch (err) {
      if (!(err instanceof AnalyzerTruncatedError)) throw err;
      const forced = splitSpanForRetry(opts.body);
      if (forced.length <= 1) throw err;
      for (let i = 0; i < forced.length; i += 1) {
        opts.onChunk?.({ index: i, total: forced.length, chars: forced[i].length });
        await detectSpan(forced[i], 1);
      }
      return { characters: Array.from(roster.values()), chunkCount: forced.length };
    }
  }

  for (let i = 0; i < chunks.length; i += 1) {
    opts.onChunk?.({ index: i, total: chunks.length, chars: chunks[i].length });
    await detectSpan(chunks[i], 0);
  }
  return { characters: Array.from(roster.values()), chunkCount: chunks.length };
}
