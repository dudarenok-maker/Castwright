/* Stage-2 large-chapter chunking (#528).

   Stage-2 attribution emits one JSON entry per sentence, so its OUTPUT scales
   with chapter size. A very large chapter (The Drowning Bell ch19 = 507 sentences)
   needs ~15–20K output tokens — past the model's output cap — so the response
   is truncated mid-JSON, fails to parse, and the call throws. The engines now
   surface that as `AnalyzerTruncatedError` (see errors.ts); this module is the
   layer that ACTS on it: it splits an over-budget chapter into paragraph-bounded
   sub-bodies, attributes each under the cap, and stitches the result back into
   the single-call shape so everything downstream (fold / reconcile / persist) is
   unaffected.

   Two safety nets compose:
     - PRE-EMPTIVE split: bodies over `charBudget` are split up front, so the
       common over-size chapter never even attempts a doomed single call.
     - ADAPTIVE re-split: if a chunk STILL truncates (a dense chunk, or a model
       with a smaller cap than assumed), the offending span is split again —
       so it self-tunes to whatever the real cap is, regardless of engine.

   A chapter that already fits the budget runs the existing single guarded call
   unchanged (byte-identical behaviour — the overwhelming majority of chapters).

   Purity: no I/O, no model calls, no prompt building. The actual call is
   injected via `callForBody`, mirroring stage2-coverage.ts / roster-coverage.ts. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { AnalyzerTruncatedError } from './errors.js';
import { configValue } from '../config/resolver.js';
import {
  runStage2WithCoverageGuard,
  validateStage2Coverage,
  type Stage2CoverageThresholds,
  type Stage2CoverageVerdict,
} from './stage2-coverage.js';

/* Per-chunk character budget. Stage-2 output is roughly the chapter prose
   re-emitted as JSON (text copied verbatim) plus structural overhead, so the
   output tokens land in the same order of magnitude as the input chars. 9000
   chars keeps a chunk's expected output comfortably under the 8192-token
   default cap with headroom for the splitting overhead. Tunable via env. */
export const DEFAULT_STAGE2_CHUNK_CHAR_BUDGET = 9000;
export function resolveStage2ChunkCharBudget(): number {
  return configValue<number>('analyzer.stage2.chunkCharBudget');
}

/** Split `body` into chunks at blank-line (paragraph) boundaries, each ≤
    `charBudget` where possible. NEVER splits inside a paragraph (so a quote and
    its dialogue tag stay in the same call). A single paragraph longer than the
    budget becomes its own chunk — it can't be split without cutting a sentence.
    Concatenating the returned chunks reproduces `body` exactly (the blank-line
    separators ride along with the paragraph before them), so no prose is dropped
    or duplicated across the seam. Returns `[body]` unchanged when it fits. */
export function splitBodyIntoChunks(body: string, charBudget: number): string[] {
  if (body.length <= charBudget) return [body];
  /* Capture the separators so reconstruction is lossless: split() with a
     capturing group yields [text, sep, text, sep, …, text]. Pair each text
     with its trailing separator into an indivisible "unit". */
  const parts = body.split(/(\n[ \t]*\n)/);
  const units: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    units.push(parts[i] + (parts[i + 1] ?? ''));
  }
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length > charBudget) {
      chunks.push(cur);
      cur = u;
    } else {
      cur += u;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length > 0 ? chunks : [body];
}

/** Last `n` paragraphs of `text`, trimmed and rejoined — used as the read-only
    "preceding context" preamble for the next chunk so a quote whose speaker was
    established earlier keeps its attribution across the seam. */
export function tailParagraphs(text: string, n: number): string {
  const paras = (text || '')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.slice(-Math.max(0, n)).join('\n\n');
}

export interface Stage2ChunkRunResult {
  sentences: SentenceOutput[];
  /** Combined coverage verdict against the FULL chapter body. */
  coverage: Stage2CoverageVerdict;
  /** How many chunks the chapter was split into (1 = single-call path). */
  chunkCount: number;
}

export interface Stage2ChunkRunOptions {
  /** The full chapter prose. */
  body: string;
  /** Per-chunk char budget (resolveStage2ChunkCharBudget()). */
  charBudget: number;
  /** Per-chunk coverage-guard retries (resolveStage2CoverageRetries()). */
  coverageRetries: number;
  /** Build + run the stage-2 model call for a sub-body. `precedingContext` is
      null on the single-call path and the first chunk (preserves byte-identical
      prompts); non-null on later chunks (prepend it as read-only context). */
  callForBody: (
    subBody: string,
    precedingContext: string | null,
  ) => Promise<{ sentences: SentenceOutput[] }>;
  /** Preceding-context paragraph count. Default 2. */
  contextParagraphs?: number;
  /** Adaptive re-split recursion bound. Default 3. */
  maxSplitDepth?: number;
  coverageThresholds?: Stage2CoverageThresholds;
  onRetry?: (attempt: number, verdict: Stage2CoverageVerdict) => void;
  /** Fired once per chunk before it runs (large-chapter progress). */
  onChunk?: (info: { index: number; total: number; chars: number }) => void;
}

/** Attribute a chapter's sentences, transparently chunking when the body is
    larger than `charBudget`. See the module header. */
export async function runStage2ChapterChunked(
  opts: Stage2ChunkRunOptions,
): Promise<Stage2ChunkRunResult> {
  const contextParagraphs = opts.contextParagraphs ?? 2;
  const maxSplitDepth = opts.maxSplitDepth ?? 3;

  /* Attribute one span, splitting it further if the model truncates on it. */
  const attributeSpan = async (
    span: string,
    depth: number,
    preceding: string | null,
  ): Promise<SentenceOutput[]> => {
    try {
      const { result } = await runStage2WithCoverageGuard({
        body: span,
        maxRetries: opts.coverageRetries,
        call: () => opts.callForBody(span, preceding),
        thresholds: opts.coverageThresholds,
        onRetry: opts.onRetry,
      });
      return result.sentences;
    } catch (err) {
      if (err instanceof AnalyzerTruncatedError && depth < maxSplitDepth) {
        const sub = splitBodyIntoChunks(span, Math.max(1, Math.floor(span.length / 2)));
        if (sub.length > 1) {
          const out: SentenceOutput[] = [];
          let prev = preceding;
          for (const s of sub) {
            out.push(...(await attributeSpan(s, depth + 1, prev)));
            prev = tailParagraphs(s, contextParagraphs);
          }
          return out;
        }
      }
      throw err;
    }
  };

  /* Run a pre-split chunk list and stitch the result back into the single-call
     shape (ids renumbered 1..N — each chunk numbered its own 1..M, which would
     collide on concat; a single call would have produced one contiguous 1..N).
     chapterId is the caller's to stamp (it already does
     `for (s of result.sentences) s.chapterId = ch.id`). */
  const runChunks = async (chunks: string[]): Promise<Stage2ChunkRunResult> => {
    const all: SentenceOutput[] = [];
    let preceding: string | null = null;
    for (let i = 0; i < chunks.length; i += 1) {
      opts.onChunk?.({ index: i, total: chunks.length, chars: chunks[i].length });
      all.push(...(await attributeSpan(chunks[i], 0, preceding)));
      preceding = tailParagraphs(chunks[i], contextParagraphs);
    }
    const sentences = all.map((s, i) => ({ ...s, id: i + 1 }));
    const coverage = validateStage2Coverage(opts.body, sentences, opts.coverageThresholds);
    return { sentences, coverage, chunkCount: chunks.length };
  };

  const chunks = splitBodyIntoChunks(opts.body, opts.charBudget);

  if (chunks.length <= 1) {
    /* Common case: chapter fits the char budget → one guarded call against the
       full body, model ids untouched, the guard's own verdict returned
       (byte-identical to the pre-chunking behaviour for the vast majority of
       chapters). The char budget is only a PROXY for the model's output-token
       cap, though: stage-2 output scales with sentence count, so a dense
       (dialogue-heavy) chapter can fit the char budget yet still overflow the
       cap. When that single call truncates, fall back to the adaptive split
       instead of failing the whole run — the same self-tuning the multi-chunk
       path already has. A body that's a single un-splittable paragraph has
       nowhere to split, so the truncation still surfaces loudly. */
    try {
      const { result, coverage } = await runStage2WithCoverageGuard({
        body: opts.body,
        maxRetries: opts.coverageRetries,
        call: () => opts.callForBody(opts.body, null),
        thresholds: opts.coverageThresholds,
        onRetry: opts.onRetry,
      });
      return { sentences: result.sentences, coverage, chunkCount: 1 };
    } catch (err) {
      if (!(err instanceof AnalyzerTruncatedError)) throw err;
      const forced = splitBodyIntoChunks(opts.body, Math.max(1, Math.floor(opts.body.length / 2)));
      if (forced.length <= 1) throw err; // single paragraph: nothing to split
      return runChunks(forced);
    }
  }

  return runChunks(chunks);
}
