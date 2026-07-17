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
import type { EngineReport } from './dialogue-structure/types.js';
import { AnalyzerTruncatedError } from './errors.js';
import { configValue } from '../config/resolver.js';
import {
  runStage2WithCoverageGuard,
  validateStage2Coverage,
  hasAttributableContent,
  attributableWordCount,
  STAGE2_MIN_EVALUABLE_WORDS,
  type Stage2CoverageThresholds,
  type Stage2CoverageVerdict,
} from './stage2-coverage.js';

/* Per-chunk character budget. Stage-2 output is roughly the chapter prose
   re-emitted as JSON (text copied verbatim) plus structural overhead, so the
   output tokens land in the same order of magnitude as the input chars. 9000
   chars keeps a chunk's expected output comfortably under the 8192-token
   default cap with headroom for the splitting overhead. Tunable via env. */
export const DEFAULT_STAGE2_CHUNK_CHAR_BUDGET = 9000;

/* Size the per-chunk input budget so the output has room inside the model's
   context window. Stage-2 output ≈ the chapter prose re-emitted as JSON, so
   input + output land in the same order of magnitude and SHARE the num_ctx
   window — a fat input chunk starves the output and truncates (the 2026-06-14
   qwen3.5:4b report: a 9000-char chunk overflowed because its real window is
   smaller than the requested num_ctx). For local engines, derive a budget from
   num_ctx (~2 chars/token, ~30% of the window reserved for input so most is
   left for output + prompt) and take the MIN with the configured value — this
   only ever LOWERS the budget, never raises it past the safe default. Cloud
   engines keep the configured budget unchanged. A residual truncation is still
   caught by the sentence-split fallback in runStage2ChapterChunked. */
export function stage2ChunkBudgetForEngine(
  configured: number,
  numCtxTokens: number,
  engine: 'gemini' | 'local',
): number {
  if (engine !== 'local') return configured;
  const numCtxDerived = Math.floor(numCtxTokens * 2 * 0.3);
  return Math.max(1000, Math.min(configured, numCtxDerived));
}

export function resolveStage2ChunkCharBudget(engine?: 'gemini' | 'local'): number {
  const configured = configValue<number>('analyzer.stage2.chunkCharBudget');
  if (engine !== 'local') return configured;
  return stage2ChunkBudgetForEngine(
    configured,
    configValue<number>('analyzer.ollama.numCtx'),
    'local',
  );
}

/* A fragment must be short in CHARS too, not only in words: a chunk can be
   char-LARGE yet normalise to few words (a long run with no word breaks — e.g. a
   synthetic single-token blob, or an unusual glyph run). Merging such a chunk
   would bloat a neighbour and defeat chunking, so only a genuinely SHORT low-word
   span (a lone heading like "Глава 4" — 9 chars) qualifies. Real headings are far
   under this; real prose reaches STAGE2_MIN_EVALUABLE_WORDS words long before it. */
const STAGE2_TINY_FRAGMENT_MAX_CHARS = 200;

/** Fold a fragment-sized chunk — SHORT in both chars and attributable words
    (nonzero but sub-`STAGE2_MIN_EVALUABLE_WORDS`), e.g. a lone heading "Глава 4"
    — into an adjacent chunk so it is never attributed as its own model call.
    Such a fragment gets isolated when it sits between two over-budget paragraphs
    the packing loop can't co-locate it with; alone, its tiny word count makes
    the coverage guard un-evaluable and the model tends to loop on the near-empty
    span, sticking the chapter on every retry (the 2026-07-16 Ночной дозор ch6
    defect: 1405 output words vs ~2 source → ratio 702.50). Unlike a WORD-FREE
    separator ("***"), which has nothing to narrate and is skipped downstream, a
    fragment carries real words (a heading) and is PRESERVED — merged forward into
    the next chunk when there is one (a heading reads best leading its section),
    else back into the previous. Merging only concatenates adjacent chunks, so
    `chunks.join('')` still reproduces the body exactly; word-free chunks and
    large word-sparse chunks are left in place. */
function mergeTinyChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  const isTinyFragment = (c: string): boolean => {
    if (c.length >= STAGE2_TINY_FRAGMENT_MAX_CHARS) return false;
    const wc = attributableWordCount(c);
    return wc >= 1 && wc < STAGE2_MIN_EVALUABLE_WORDS;
  };
  const work = [...chunks];
  const out: string[] = [];
  for (let i = 0; i < work.length; i += 1) {
    if (isTinyFragment(work[i]) && i + 1 < work.length) {
      work[i + 1] = work[i] + work[i + 1]; // forward-merge into the next chunk
    } else {
      out.push(work[i]);
    }
  }
  // A fragment that was LAST had no following chunk to join — fold it (and any
  // fragment that merging left trailing) back into the previous chunk instead.
  while (out.length >= 2 && isTinyFragment(out[out.length - 1])) {
    out[out.length - 2] += out.pop()!;
  }
  return out;
}

/** Split `body` into chunks at blank-line (paragraph) boundaries, each ≤
    `charBudget` where possible. NEVER splits inside a paragraph (so a quote and
    its dialogue tag stay in the same call). A single paragraph longer than the
    budget becomes its own chunk — it can't be split without cutting a sentence.
    A fragment-sized chunk (a lone heading) is merged into a neighbour rather
    than left to stand alone (see {@link mergeTinyChunks}). Concatenating the
    returned chunks reproduces `body` exactly (the blank-line separators ride
    along with the paragraph before them), so no prose is dropped or duplicated
    across the seam. Returns `[body]` unchanged when it fits. */
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
  const isSceneSeparatorUnit = (u: string): boolean =>
    u.trim().length > 0 && attributableWordCount(u) === 0;
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    // A scene-separator paragraph forces a boundary BEFORE it, so the separator
    // (and the scene that follows) starts a fresh chunk — no chunk straddles a
    // scene break. Size overflow breaks too, as before.
    if (cur && (isSceneSeparatorUnit(u) || cur.length + u.length > charBudget)) {
      chunks.push(cur);
      cur = u;
    } else {
      cur += u;
    }
  }
  if (cur) chunks.push(cur);
  return mergeTinyChunks(chunks.length > 0 ? chunks : [body]);
}

/** Split a SINGLE paragraph (no blank-line boundaries) at sentence boundaries,
    greedily packing whole sentences up to `charBudget`. This is the last-resort
    fallback for an over-cap paragraph that `splitBodyIntoChunks` can't divide
    (it never cuts inside a paragraph): without it, a model whose output cap is
    smaller than one paragraph's attribution output truncates and fails the
    whole chapter (2026-06-14 qwen3.5:4b report).

    Boundary = sentence-ending punctuation (.!?) plus an optional closing quote
    or bracket, followed by whitespace. NOT byte-lossless (run-of-whitespace
    between sentences collapses to a single space on rejoin) — acceptable here
    because the stage-2 coverage guard is word-overlap based (whitespace-
    insensitive) and this path only fires as a recovery from a hard failure.
    Returns `[para]` unchanged when it fits, or when there is no sentence
    boundary to split on (a single huge sentence still surfaces the truncation
    loudly rather than being cut mid-sentence).

    CJK fallback (fs-59 W2): CJK prose has no inter-word whitespace, so the
    Latin regex above finds no boundary and returns `[para]` unsplit even
    though the paragraph is packed with sentence-ending 。！？ punctuation. If
    the paragraph contains Han/Kana AND the Latin split above yielded ≤1 unit,
    re-split using `Intl.Segmenter`'s sentence granularity (ICU-backed, no new
    dependency) — `'ja'` when Kana is present (mixed kanji+kana is Japanese),
    else `'zh'`. Repacked chunks are joined with an EMPTY string, not a space:
    injecting ASCII spaces into CJK prose is lossy prose corruption, unlike the
    Latin path where a space is the correct inter-sentence separator. */
export function splitParagraphIntoSentences(para: string, charBudget: number): string[] {
  if (para.length <= charBudget) return [para];
  const sentences = para.split(/(?<=[.!?]["')\]]?)\s+/).filter(Boolean);
  if (sentences.length <= 1) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(para)) {
      const lang = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(para) ? 'ja' : 'zh';
      const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
      const cjkSentences = Array.from(segmenter.segment(para), (s) => s.segment).filter(Boolean);
      if (cjkSentences.length > 1) {
        const cjkChunks: string[] = [];
        let cjkCur = '';
        for (const s of cjkSentences) {
          if (cjkCur && cjkCur.length + s.length > charBudget) {
            cjkChunks.push(cjkCur);
            cjkCur = s;
          } else {
            cjkCur += s;
          }
        }
        if (cjkCur) cjkChunks.push(cjkCur);
        return cjkChunks.length > 0 ? cjkChunks : [para];
      }
    }
    return [para]; // no boundary — nothing to split
  }
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > charBudget) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length > 0 ? chunks : [para];
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
  /** Dialogue-structure engine counters (srv-59) — set only when the engine
      ran (knob on + language supported); absent on the pre-engine path. */
  structureReport?: EngineReport;
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
  /** Fired AFTER a section's sentences are parsed, with the section index and
      its exact sentence count. The route accumulates these into the committed
      (exact) numerator; the streamed marker count only ever covers the
      in-flight section. */
  onSectionDone?: (index: number, sentenceCount: number) => void;
}

/** Attribute a chapter's sentences, transparently chunking when the body is
    larger than `charBudget`. See the module header. */
export async function runStage2ChapterChunked(
  opts: Stage2ChunkRunOptions,
): Promise<Stage2ChunkRunResult> {
  const contextParagraphs = opts.contextParagraphs ?? 2;
  const maxSplitDepth = opts.maxSplitDepth ?? 3;

  /* Split an over-cap span for a retry: paragraph boundaries first (lossless),
     then — when the span is a single paragraph that won't divide — sentence
     boundaries. Returns [span] only when neither can split it (a single huge
     sentence), which propagates the truncation loudly. */
  const splitSpanForRetry = (span: string): string[] => {
    const half = Math.max(1, Math.floor(span.length / 2));
    const byParagraph = splitBodyIntoChunks(span, half);
    if (byParagraph.length > 1) return byParagraph;
    return splitParagraphIntoSentences(span, half);
  };

  /* Attribute one span, splitting it further if the model truncates on it. */
  const attributeSpan = async (
    span: string,
    depth: number,
    preceding: string | null,
  ): Promise<SentenceOutput[]> => {
    /* A span with no attributable words (a lone "***" scene break isolated
       between two over-budget paragraphs) has nothing to attribute. Skip it:
       no model call, no sentences. Otherwise the model attributes the preceding
       context instead and the guard's zero-word source loops forever (2026-06-19
       Ночной дозор ch7). */
    if (!hasAttributableContent(span)) return [];
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
        const sub = splitSpanForRetry(span);
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
      const sectionSentences = await attributeSpan(chunks[i], 0, preceding);
      opts.onSectionDone?.(i, sectionSentences.length);
      all.push(...sectionSentences);
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
      opts.onSectionDone?.(0, result.sentences.length);
      return { sentences: result.sentences, coverage, chunkCount: 1 };
    } catch (err) {
      if (!(err instanceof AnalyzerTruncatedError)) throw err;
      const forced = splitSpanForRetry(opts.body);
      if (forced.length <= 1) throw err; // single un-splittable sentence: surface it
      return runChunks(forced);
    }
  }

  return runChunks(chunks);
}
