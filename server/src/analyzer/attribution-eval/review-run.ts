/* Task 5 — a THIN, faithful re-implementation of the script-review chunk loop
   for the attribution eval harness. It mirrors the production route's core loop
   (`reviewCore` inside `runScriptReviewJob`, server/src/routes/script-review.ts
   ~810-875) EXACTLY for the parts that determine which ops a chapter produces:
   the same budgeted chunking, the same per-chunk inbox, the same op-ownership
   filter (`ownsOp`/`primarySentenceId`) that de-dups ops across overlapping
   chunk context, and the same halve-and-retry force-split on truncation.

   It deliberately drops what the route adds around that core and what has no
   place in a batch eval: SSE streaming (`send`/heartbeat), the ledger/checkpoint
   machinery, the fallback-engine switch, per-pass eval timing, and abort
   bookkeeping. Those never change which ops are emitted — the eval only needs
   the ops + their planApply-accepted subset.

   `reviewCore` is a closure inside `runScriptReviewJob` and is NOT importable, so
   this re-implements the loop while REUSING the same pure helpers production uses
   (`chunkSentencesByBudget`, `ownsOp`, `primarySentenceId`, `chapterChunkBudget`,
   `buildScriptReviewChapterInbox`, `buildReviewSentencesInput`, `planApply`) — the
   route-parity test pins this loop against an ownership reference computed over
   the SAME shared helpers, catching internal drift. */
import type { Analyzer, StageCall } from '../index.js';
import type { SentenceOutput, ScriptReviewOp } from '../../handoff/schemas.js';
import {
  chunkSentencesByBudget,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
  OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
} from '../chapter-chunker.js';
import {
  buildScriptReviewChapterInbox,
  buildReviewSentencesInput,
  type PriorExchange,
} from '../../routes/script-review.js';
import { planApply, type LiveSentence } from './review-apply-core.js';
import { AnalyzerTruncatedError } from '../errors.js';

/* The route's `MAX_FORCE_SPLIT_DEPTH` and `CHUNK_OVERLAP` are both 3 but not
   exported — redeclared locally to match (server/src/routes/script-review.ts). */
const MAX_FORCE_SPLIT_DEPTH = 3;
const CHUNK_OVERLAP = 3;

export async function runReviewOverChapter(opts: {
  analyzer: Analyzer;
  engine: 'local' | 'gemini';
  manuscriptId: string;
  chapterId: number;
  sentences: SentenceOutput[];
  roster: Array<{ id: string; name: string; role?: string }>;
  priorExchange?: PriorExchange;
  evidence?: Map<number, string>;
  call: StageCall;
}): Promise<{ ops: ScriptReviewOp[]; accepted: ScriptReviewOp[]; droppedChunks: number }> {
  const { analyzer, engine, manuscriptId, chapterId, sentences, roster, priorExchange, evidence, call } =
    opts;

  const chunks = chunkSentencesByBudget(sentences, {
    charBudget: chapterChunkBudget(
      engine,
      JSON.stringify(roster).length + 800, // roster payload + fixed template scaffold
      sentences.map((s) => s.text).join(' '), // sample → chars/token
      OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS, // reserve system-prompt overhead so the whole request clears the TPM guard
    ),
    overlap: CHUNK_OVERLAP,
    // Size each sentence by the REAL per-sentence payload buildReviewSentencesInput
    // emits (the structureEvidence note folded into `text`, plus instruct/vocalization) —
    // not the bare {id,characterId,text} — matching the route exactly.
    serialize: (s) => JSON.stringify(buildReviewSentencesInput([s], evidence)[0]),
  });

  /* Force-split-on-truncation recovery, mirroring the route's `reviewCore`:
     on AnalyzerTruncatedError, halve the core and retry each half (depth ≤
     MAX_FORCE_SPLIT_DEPTH). The left/right cores partition the parent core, so
     `ownsOp` keeps de-duping across the added overlap; a single sentence that
     still truncates can't split further → re-throws. Returns the owned ops. */
  const OVERLAP = CHUNK_OVERLAP;
  const reviewCore = async (
    core: SentenceOutput[],
    contextBefore: SentenceOutput[],
    contextAfter: SentenceOutput[],
    withPrior: boolean,
    depth: number,
  ): Promise<ScriptReviewOp[]> => {
    const coreIds = new Set(core.map((s) => s.id));
    const prompt = buildScriptReviewChapterInbox(
      manuscriptId,
      chapterId,
      [...contextBefore, ...core, ...contextAfter],
      roster,
      withPrior ? (priorExchange ?? null) : null,
      evidence,
    );
    try {
      const result = await analyzer.runScriptReviewChapter(manuscriptId, chapterId, prompt, call);
      return result.ops.filter((op) => ownsOp(coreIds, primarySentenceId(op)));
    } catch (err) {
      if (err instanceof AnalyzerTruncatedError && depth < MAX_FORCE_SPLIT_DEPTH && core.length > 1) {
        const mid = Math.ceil(core.length / 2);
        const left = core.slice(0, mid);
        const right = core.slice(mid);
        const leftOps = await reviewCore(left, contextBefore, [...right.slice(0, OVERLAP), ...contextAfter], withPrior, depth + 1);
        const rightOps = await reviewCore(right, [...contextBefore, ...left.slice(-OVERLAP)], contextAfter, false, depth + 1);
        return [...leftOps, ...rightOps];
      }
      throw err;
    }
  };

  /* Per-chunk resilience, mirroring the route's chunk loop
     (routes/script-review.ts:906-924): a chunk whose model call fails validation
     after retry — or exhausts force-split depth — is SKIPPED (its ops lost) and
     the loop continues, rather than aborting the whole chapter. The eval has no
     SSE `chapter-failed` channel, so it counts drops and returns the tally for
     the scorecard to surface (a silent drop would understate helped/harmed). */
  const ops: ScriptReviewOp[] = [];
  let droppedChunks = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      const owned = await reviewCore(chunk.core, chunk.contextBefore, chunk.contextAfter, index === 0, 0);
      ops.push(...owned);
    } catch (err) {
      droppedChunks += 1;
      console.warn(
        `[review-run] ch${chapterId} chunk ${index + 1}/${chunks.length} dropped: ${(err as Error).message}`,
      );
    }
  }

  const live: LiveSentence[] = sentences.map((s) => ({
    id: s.id,
    chapterId: s.chapterId,
    text: s.text,
    characterId: s.characterId,
    ...(s.instruct !== undefined ? { instruct: s.instruct } : {}),
    ...(s.vocalization !== undefined ? { vocalization: s.vocalization } : {}),
  }));
  const rosterSet = new Set(roster.map((r) => r.id));
  const accepted = planApply(ops, live, rosterSet).appliable;

  return { ops, accepted, droppedChunks };
}
