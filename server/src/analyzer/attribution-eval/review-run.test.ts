/* Task 5 — route-parity drift test for the thin review-core loop
   (`runReviewOverChapter`). A STUB analyzer stands in for the model: its
   `runScriptReviewChapter` keys off the sentenceIds present in the prompt it is
   handed (every chunk sees its core + up to `overlap` context sentences), so a
   deliberately multi-chunk chapter exercises the `ownsOp` de-dup — an op on a
   sentence that is a given chunk's CONTEXT must be dropped there and emitted by
   the chunk that OWNS it (its core), exactly once.

   The reference in assertion (b) is NOT the route's `reviewCore` (a closure
   inside runScriptReviewJob, not importable) — it is an independent single-pass
   ownership computed over the SAME chunks using the SAME shared pure helpers
   (`chunkSentencesByBudget`/`ownsOp`/`primarySentenceId`) production uses. So it
   catches internal drift of THIS loop against its own ownership contract, which
   is the strongest guard available under the no-extract stance. */
import { describe, it, expect } from 'vitest';
import { runReviewOverChapter } from './review-run.js';
import {
  chunkSentencesByBudget,
  chunkWithContext,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
  OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
} from '../chapter-chunker.js';
import { buildReviewSentencesInput } from '../../routes/script-review.js';
import { AnalyzerTruncatedError } from '../errors.js';
import { DailyQuotaExhaustedError } from '../rate-limit.js';
import type { Analyzer, StageCall } from '../index.js';
import type { SentenceOutput, ScriptReviewOp, ScriptReviewOutput } from '../../handoff/schemas.js';

const CHAPTER_ID = 1;
const MANUSCRIPT_ID = 'm-review-run';
const roster = [
  { id: 'c1', name: 'Alice' },
  { id: 'c2', name: 'Bob', role: 'narrator' },
];

/* Big enough sentences that the default local budget (24000 chars) packs them
   into ≥2 cores — verified below, not assumed. `x`.repeat guarantees the bad
   anchor `ZZZ_MISSING` never occurs in any sentence text. */
function makeSentences(count: number, chars: number): SentenceOutput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    chapterId: CHAPTER_ID,
    characterId: 'c1',
    text: 'x'.repeat(chars),
  }));
}

// The exact serialize + budget the loop uses — so `refChunks` below is identical
// to the chunking runReviewOverChapter performs internally.
const serialize = (s: SentenceOutput): string =>
  JSON.stringify(buildReviewSentencesInput([s], undefined)[0]);
function refChunksFor(sentences: SentenceOutput[]) {
  const charBudget = chapterChunkBudget(
    'local',
    JSON.stringify(roster).length + 800,
    sentences.map((s) => s.text).join(' '),
    OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
  );
  return chunkSentencesByBudget(sentences, { charBudget, overlap: 3, serialize });
}

const rationale = 'stub';
const presentIds = (prompt: string): number[] => {
  const ids: number[] = [];
  const re = /"sentenceId":\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) ids.push(Number(m[1]));
  return ids;
};

/* Stub analyzer: for every sentenceId visible in the prompt emit a valid
   `strip_tag`; additionally, for a designated id, emit a `split` with a bad
   anchor so planApply rejects it (assertion (c)). Ownership de-dup is the loop's
   job — the stub returns the same op for a sentence whether it is that chunk's
   core OR context. */
function makeStub(badAnchorId: number): Analyzer {
  const stub = {
    async runScriptReviewChapter(
      _manuscriptId: string,
      _chapterId: number,
      prompt: string,
      _call: StageCall,
    ): Promise<ScriptReviewOutput> {
      const ops: ScriptReviewOp[] = [];
      for (const id of presentIds(prompt)) {
        ops.push({ id, op: 'strip_tag', anchor: 'x', rationale } as ScriptReviewOp);
        if (id === badAnchorId) {
          ops.push({ id, op: 'split', anchor: 'ZZZ_MISSING', rationale } as ScriptReviewOp);
        }
      }
      return { ops };
    },
  } as unknown as Analyzer;
  return stub;
}

describe('runReviewOverChapter — route-parity chunk loop', () => {
  const sentences = makeSentences(10, 6000); // 10 × ~6k → ≥2 cores under a 24k budget
  const call: StageCall = {};

  it('splits into ≥2 chunks (test precondition)', () => {
    expect(refChunksFor(sentences).length).toBeGreaterThanOrEqual(2);
  });

  it('(a) emits a context-region op exactly once, from the owning chunk', async () => {
    const chunks = refChunksFor(sentences);
    // The first sentence of chunk 1's core is ALSO chunk 0's contextAfter — a
    // sentence the model "sees" in two chunks. It must be emitted exactly once.
    const boundaryId = chunks[1].core[0].id;
    expect(chunks[0].contextAfter.some((s) => s.id === boundaryId)).toBe(true);

    const { ops } = await runReviewOverChapter({
      analyzer: makeStub(-1),
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });

    const stripsForBoundary = ops.filter((o) => o.op === 'strip_tag' && o.id === boundaryId);
    expect(stripsForBoundary).toHaveLength(1);
  });

  it('(b) owned op set equals an independent single-pass ownership over the same chunks', async () => {
    const chunks = refChunksFor(sentences);
    // Reference: reproduce the ownership decision independently with the same
    // pure helpers — for each chunk, keep only the ops whose primary sentence
    // the chunk OWNS, over the ids the chunk's prompt would carry.
    const refOwned = new Set<number>();
    for (const chunk of chunks) {
      for (const s of chunkWithContext(chunk)) {
        if (ownsOp(chunk.coreIds, primarySentenceId({ id: s.id, op: 'strip_tag' }))) {
          refOwned.add(s.id);
        }
      }
    }

    const { ops } = await runReviewOverChapter({
      analyzer: makeStub(-1),
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });

    const runOwned = new Set(ops.filter((o) => o.op === 'strip_tag').map((o) => o.id));
    expect([...runOwned].sort((a, b) => a - b)).toEqual([...refOwned].sort((a, b) => a - b));
    // Cores partition the chapter, so every sentence is owned exactly once.
    expect(runOwned.size).toBe(sentences.length);
  });

  it('(c) accepted excludes an op planApply rejects (bad anchor)', async () => {
    const badAnchorId = sentences[0].id; // a chunk-0 core sentence
    const { ops, accepted } = await runReviewOverChapter({
      analyzer: makeStub(badAnchorId),
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });

    // The bad split IS produced (owned, once)…
    const badSplits = ops.filter((o) => o.op === 'split' && o.id === badAnchorId);
    expect(badSplits).toHaveLength(1);
    // …but planApply rejects it (anchor not found), so it is NOT accepted…
    expect(accepted.some((o) => o.op === 'split' && o.id === badAnchorId)).toBe(false);
    // …while the same sentence's strip_tag (no anchor requirement) still is.
    expect(accepted.some((o) => o.op === 'strip_tag' && o.id === badAnchorId)).toBe(true);
  });

  it('(d) skips a chunk whose analyzer throws a non-truncation error and keeps the rest (droppedChunks)', async () => {
    // Mirrors production's per-chunk resilience (routes/script-review.ts:906-924):
    // an LLM schema-validation failure on one chunk must not abort the chapter.
    // Throw on the FIRST analyzer call (chunk 0) — a non-truncation error force-
    // splits nothing, so it's exactly one call per chunk — then succeed. Keyed on
    // call order, not sentence id, since the 3-sentence overlap can leak a core id
    // into an adjacent chunk's context (which would fail two chunks).
    const chunks = refChunksFor(sentences);
    let calls = 0;
    const stub = {
      async runScriptReviewChapter(
        _m: string,
        _c: number,
        prompt: string,
        _call: StageCall,
      ): Promise<ScriptReviewOutput> {
        calls += 1;
        if (calls === 1) {
          throw new Error('schema-validation — reattribute requires exactly one of characterId or proposed');
        }
        return { ops: presentIds(prompt).map((id) => ({ id, op: 'strip_tag', anchor: 'x', rationale } as ScriptReviewOp)) };
      },
    } as unknown as Analyzer;

    const { ops, droppedChunks } = await runReviewOverChapter({
      analyzer: stub,
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });

    expect(droppedChunks).toBe(1);
    const stripIds = new Set(ops.filter((o) => o.op === 'strip_tag').map((o) => o.id));
    // chunk 0's owned ids are gone…
    for (const s of chunks[0].core) expect(stripIds.has(s.id)).toBe(false);
    // …every other chunk's owned ids survive (cores partition the chapter).
    const survivors = chunks.slice(1).flatMap((c) => c.core.map((s) => s.id));
    expect([...stripIds].sort((a, b) => a - b)).toEqual(survivors.sort((a, b) => a - b));
  });

  it('(e) fast-fails on a terminal quota error instead of skip-and-retrying every remaining chunk', async () => {
    // A quota (or content-block) error is fatal for EVERY remaining chunk, so
    // skip-and-continue would burn API calls on a doomed run. Production breaks
    // the chunk loop on these (routes/script-review.ts:915-922); the eval
    // re-throws them rather than counting them as a droppable chunk.
    const stub = {
      async runScriptReviewChapter(): Promise<ScriptReviewOutput> {
        throw new DailyQuotaExhaustedError('gemma-4-31b-it', new Date(0));
      },
    } as unknown as Analyzer;

    await expect(
      runReviewOverChapter({
        analyzer: stub,
        engine: 'gemini',
        manuscriptId: MANUSCRIPT_ID,
        chapterId: CHAPTER_ID,
        sentences,
        roster,
        call,
      }),
    ).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
  });
});

describe('runReviewOverChapter — force-split retry on AnalyzerTruncatedError', () => {
  const call: StageCall = {};

  /* Stub: throws AnalyzerTruncatedError whenever the prompt it is handed
     carries `sizeThreshold`-or-more distinct sentenceIds, and returns a valid
     `strip_tag` per visible id otherwise. Paired with a chapter sized so the
     UNSPLIT whole-chapter core is the only prompt that ever hits the
     threshold — each half's retry prompt (core + up to CHUNK_OVERLAP=3
     sentences of the other half as context) stays strictly under it — so
     this reproduces "throws once on the oversized core, succeeds on both
     halves" without a mutable call-order flag. */
  function makeThrowAboveSize(sizeThreshold: number): Analyzer {
    return {
      async runScriptReviewChapter(
        _manuscriptId: string,
        _chapterId: number,
        prompt: string,
        _call: StageCall,
      ): Promise<ScriptReviewOutput> {
        const ids = presentIds(prompt);
        if (ids.length >= sizeThreshold) {
          throw new AnalyzerTruncatedError('ollama', 'length', 999);
        }
        return { ops: ids.map((id) => ({ id, op: 'strip_tag', anchor: 'x', rationale } as ScriptReviewOp)) };
      },
    } as unknown as Analyzer;
  }

  // Stub: ALWAYS throws AnalyzerTruncatedError, regardless of core size.
  function makeAlwaysThrows(): Analyzer {
    return {
      async runScriptReviewChapter(): Promise<ScriptReviewOutput> {
        throw new AnalyzerTruncatedError('ollama', 'length', 999);
      },
    } as unknown as Analyzer;
  }

  it('recovers via halve-and-retry: resolves, collects owned ops from BOTH halves, no duplicate ownership', async () => {
    // 8 tiny sentences → one top-level chunk (verified below), so the retry
    // logic under test is exercised in isolation from the top-level chunk loop.
    const sentences = makeSentences(8, 50);
    expect(refChunksFor(sentences).length).toBe(1); // precondition: single top-level core

    // The whole (unsplit) core sees all 8 ids. After one halve (mid=4), each
    // half's retry prompt is its own 4-sentence core plus up to 3 sentences of
    // context bled in from the other half (CHUNK_OVERLAP) — 7 distinct ids at
    // most, never all 8 — so the threshold below fires ONLY on the initial,
    // unsplit call.
    const stub = makeThrowAboveSize(sentences.length);

    const { ops } = await runReviewOverChapter({
      analyzer: stub,
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });

    // (a) the retry recovered — the promise resolved at all (would otherwise
    // reject, failing this `await`).
    // (b) ops from BOTH halves were collected: an op owned by a left-half
    // sentence (id 2, core [1,2,3,4]) AND one owned by a right-half sentence
    // (id 6, core [5,6,7,8]) both appear.
    expect(ops.some((o) => o.op === 'strip_tag' && o.id === 2)).toBe(true);
    expect(ops.some((o) => o.op === 'strip_tag' && o.id === 6)).toBe(true);
    // (c) no op is duplicated despite the overlap context bled into each
    // half's retry prompt — ownership de-dup still holds through the split:
    // exactly one strip_tag per sentence, ids 1..8, nothing more/less.
    const stripIds = ops
      .filter((o) => o.op === 'strip_tag')
      .map((o) => o.id)
      .sort((a, b) => a - b);
    expect(stripIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('depth-exhaustion: an always-truncating chunk is dropped-and-skipped, not rejected (no infinite loop)', async () => {
    // 16 tiny sentences → one top-level chunk (verified below); halving
    // 16→8→4→2 across 3 recursive splits still leaves a core of length 2
    // (>1) at depth 3, so reviewCore re-throws AnalyzerTruncatedError at the
    // MAX_FORCE_SPLIT_DEPTH guard. CONTRACT CHANGE (#1777): the chunk loop now
    // catches that per-chunk error and continues — matching production
    // (routes/script-review.ts:906-924) — rather than aborting the chapter.
    // The "no infinite loop" intent is preserved (this resolves); the outcome
    // is now a dropped chunk, not a rejection.
    const sentences = makeSentences(16, 50);
    expect(refChunksFor(sentences).length).toBe(1); // precondition: single top-level core

    const { ops, droppedChunks } = await runReviewOverChapter({
      analyzer: makeAlwaysThrows(),
      engine: 'local',
      manuscriptId: MANUSCRIPT_ID,
      chapterId: CHAPTER_ID,
      sentences,
      roster,
      call,
    });
    expect(ops).toEqual([]);
    expect(droppedChunks).toBe(1);
  });
});
