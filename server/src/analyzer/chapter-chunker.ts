/* fs-58 follow-on — sentence-level chapter chunker for the script-review pass.

   Script review sends a chapter's attributed sentences to the LLM in one call,
   but a large chapter overflows the local model's context window (a Russian
   book has chapters 3-5x num_ctx). This splits the sentence sequence into
   budgeted CHUNKS, each with an "owned core" plus surrounding CONTEXT, so the
   route can review the whole chapter across several calls while reviewing each
   sentence EXACTLY ONCE.

   Owned-core rule: cores are disjoint, contiguous, and together cover every
   sentence exactly once. Each chunk additionally carries up to `overlap`
   context sentences before/after its core (so the prompt sees the neighbours),
   but those context sentences are NOT owned — an op whose primary sentence
   falls in a chunk's context is dropped there and owned by the chunk whose core
   contains it. This dedupes ops across the overlap.

   Pure over the sentence array — no I/O. Only `chapterChunkBudget` reads config
   (it delegates straight to resolveStage1ChunkCharBudget). */

import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { configValue } from '../config/resolver.js';
import { cloudBodyCharBudget } from './token-budget.js';

export interface SentenceChunk<S> {
  core: S[];
  contextBefore: S[];
  contextAfter: S[];
  coreIds: Set<number>;
}

/* Greedily pack sentences into contiguous cores no larger than `charBudget`
   (a single oversize sentence still forms a core of 1), then attach up to
   `overlap` context sentences on each side. */
export function chunkSentencesByBudget<S extends { id: number; text: string }>(
  sentences: S[],
  opts: { charBudget: number; overlap: number; serialize: (s: S) => string },
): SentenceChunk<S>[] {
  const { charBudget, overlap, serialize } = opts;

  /* Phase 1 — partition into contiguous cores by index range. */
  const ranges: Array<{ start: number; end: number }> = []; // [start, end)
  let i = 0;
  while (i < sentences.length) {
    let used = 0;
    let j = i;
    while (j < sentences.length) {
      const len = serialize(sentences[j]).length;
      // Always take at least one sentence (oversize single still forms its own
      // core of 1 — never drop or infinite-loop).
      if (j > i && used + len > charBudget) break;
      used += len;
      j += 1;
    }
    ranges.push({ start: i, end: j });
    i = j;
  }

  /* Phase 2 — attach context windows around each core. */
  return ranges.map(({ start, end }) => {
    const core = sentences.slice(start, end);
    const before = sentences.slice(Math.max(0, start - overlap), start);
    const after = sentences.slice(end, Math.min(sentences.length, end + overlap));
    return {
      core,
      contextBefore: before,
      contextAfter: after,
      coreIds: new Set(core.map((s) => s.id)),
    };
  });
}

/* context-before ++ core ++ context-after, in original document order. The
   split is carried structurally from `chunkSentencesByBudget` (which slices the
   context windows by index), so this never relies on ids increasing with
   position — post-fold split offspring (high id, mid-array) are ordered
   correctly and never dropped. */
export function chunkWithContext<S>(chunk: SentenceChunk<S>): S[] {
  return [...chunk.contextBefore, ...chunk.core, ...chunk.contextAfter];
}

export function ownsOp(coreIds: Set<number>, primaryId: number): boolean {
  return coreIds.has(primaryId);
}

/* The sentence an op is "anchored" to for ownership. A merge op carries no
   single `id` of its own (its `id` field is unused); its primary sentence is
   the lowest of its mergeIds. Every other op uses its `id`. */
export function primarySentenceId(op: { id: number; op: string; mergeIds?: number[] }): number {
  return op.op === 'merge' ? Math.min(...(op.mergeIds ?? [op.id])) : op.id;
}

/* Cloud output-heavy fixed per-request overhead, reserved in TOKEN space so the
   whole request (system instruction + inbox scaffold + roster + body) clears the
   finite Gemma TPM guard (`RequestExceedsTpmError`, 16000/min) — NOT just the
   body. Mirrors stage-1's STAGE1_CLOUD_RESERVED_TOKENS (7000) but smaller,
   because these skills are smaller than the cast-detection one: script-review
   ≈ 6.8 KB and instruct ≈ 7.0 KB (~1.7k tokens each), emotion ≈ 2.9 KB, plus the
   ~500-char buildSystemInstruction scaffold and the Russian languagePreamble.
   With a 0-token reservation (the prior behaviour) the body filled the full
   12k-token cap, so a dense Cyrillic script-review chunk estimated at ~18.6k
   tokens (measured) and tripped the guard — dropping the chapter, since
   RequestExceedsTpm is not the AnalyzerTruncatedError the force-split recovery
   catches. Reserving 4000 tokens keeps the measured worst-case Cyrillic
   script-review request (largest packed chunk + a 40-char roster + a
   structure-evidence note on every sentence) at ~13.2k tokens, and the
   smaller-skill emotion/instruct passes lower still — all comfortably below the
   16000 guard with margin. Measured in output-heavy-tpm.test.ts against the real
   prompts so a future skill growth re-trips the guard test. Token-space (not
   char-space) so it is script-correct: the reservation is the same token cost
   whatever the body's script; only the REMAINING budget is converted to chars at
   the body's own rate. */
export const OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS = 4000;

/* Per-chunk char budget for the OUTPUT-heavy passes (script review,
   annotate-emotion, instruct-annotation — each emits per-sentence output).
   - local  ⇒ num_ctx-derived (delegates to resolveStage1ChunkCharBudget).
   - gemini ⇒ a FINITE budget (registry knob analyzer.gemini.outputHeavyChunkChars),
     the body sized to the per-request token cap minus `reservedChars` (roster +
     template scaffold, char-space) AND `reservedTokens` (the fixed system-prompt
     overhead, token-space — see OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS). Both are
     needed: reservedChars bounds the roster/scaffold that grows with the cast,
     reservedTokens bounds the script-agnostic system instruction so the WHOLE
     request — not just the body — clears the Gemma TPM guard.
     NOT the Number.MAX_SAFE_INTEGER stage-1 keeps: a Night-Watch-sized chapter's
     per-sentence output would otherwise overrun Gemini's output-token cap and
     stop at MAX_TOKENS with an empty/partial buffer (the 2026-07-14 incident).
   Stage-1 cast detection calls resolveStage1ChunkCharBudget DIRECTLY (passing
   the chapter body so gemini sizes to the per-request token cap) — a clean,
   separate seam untouched by this. */
export function chapterChunkBudget(
  engine: 'gemini' | 'local',
  reservedChars = 0,
  sampleText = '',
  reservedTokens = 0,
): number {
  if (engine === 'local') return resolveStage1ChunkCharBudget('local'); // roster rides on num_ctx; local truncation is the stage-2 fraction knob's domain
  const outputCap = configValue<number>('analyzer.gemini.outputHeavyChunkChars');
  return Math.min(outputCap, cloudBodyCharBudget(sampleText, reservedChars, reservedTokens));
}
