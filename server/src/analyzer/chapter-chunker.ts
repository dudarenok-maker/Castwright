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

export interface SentenceChunk<S> {
  core: S[];
  context: S[];
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
      context: [...before, ...after],
      coreIds: new Set(core.map((s) => s.id)),
    };
  });
}

/* context-before ++ core ++ context-after, in original sentence order. The
   context split point is the core's first id: everything in `context` ordered
   before the core stays before, the rest after. */
export function chunkWithContext<S extends { id: number }>(chunk: SentenceChunk<S>): S[] {
  if (chunk.core.length === 0) return [...chunk.context];
  const firstCoreId = chunk.core[0].id;
  const lastCoreId = chunk.core[chunk.core.length - 1].id;
  const before = chunk.context.filter((s) => s.id < firstCoreId);
  const after = chunk.context.filter((s) => s.id > lastCoreId);
  return [...before, ...chunk.core, ...after];
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

/* Per-chunk char budget for the script-review pass — delegates straight to the
   stage-1 budget resolver (gemini ⇒ Number.MAX_SAFE_INTEGER, never chunks;
   local ⇒ num_ctx-derived). */
export function chapterChunkBudget(engine: 'gemini' | 'local'): number {
  return resolveStage1ChunkCharBudget(engine);
}
