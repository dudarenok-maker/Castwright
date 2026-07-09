/* fs-58 — LLM script-review route. Streams a per-chapter LLM pass that
   reads a book's attributed sentences + post-fold cast roster and emits
   editing ops (strip_tag, split, extract_dialogue, merge, fix_emotion).
   The route never writes a file: it streams `ops` events and the FRONTEND
   applies them through existing Redux manual-edit reducers.

   Sticky (fs-58 Task 2): the per-chapter loop runs against a detached
   `ScriptReviewJob` that outlives any single response — a disconnect only
   drops that connection's subscriber, it never aborts the run. A second
   POST for the same book+scope joins the running job and is replayed its
   events so far; a POST for the other scope (whole-book vs single-chapter)
   while one is in flight for the same book is rejected with 409, since both
   scopes would checkpoint into the same per-chapter ledger (Task 3).

   Large chapters: a chapter whose prompt exceeds the local model's context
   window is split by `chunkSentencesByBudget` (chapter-chunker.ts) into
   budgeted chunks. Each chunk carries an OWNED CORE plus overlap CONTEXT; an op
   is emitted only by the chunk whose core contains its primary sentence
   (`ownsOp` / `primarySentenceId`), so every sentence is reviewed exactly once
   across the overlapping chunks. Cloud engines get a MAX_SAFE_INTEGER budget
   from `chapterChunkBudget`, so they stay one call per chapter. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { loadPostFoldSentencesByChapter } from '../store/post-fold-sentences.js';
import { selectAnalyzerForPhase } from '../analyzer/select-analyzer.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  chunkSentencesByBudget,
  chunkWithContext,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
} from '../analyzer/chapter-chunker.js';
import {
  buildCharsByChapter,
  chapterPacingPhaseFields,
  accumulateChapterPacing,
} from '../analyzer/chapter-pacing.js';
import type { SentenceOutput } from '../handoff/schemas.js';

export const scriptReviewRouter = Router();

/* Local type for the parts of cast.json we need. */
interface CastCharacterSlim {
  id: string;
  name: string;
  role?: string;
}
interface CastFile {
  characters?: CastCharacterSlim[];
}

/* fs-64 — cross-chapter context for the script-review pass. The prior chapter's
   final two-speaker exchange is fed (read-only) into a chapter's first chunk so
   the model can resolve a tagless chapter-opening line via turn-taking. */
const NARRATOR_ID = 'narrator'; // module-private convention (re-declared, never exported)
export const PRIOR_TURN_LOOKBACK = 6; // sentences (positions) scanned back from the chapter end
export const MAX_PRIOR_TURN_CHARS = 240; // hard cap per rendered line

export interface BoundaryTurn {
  speakerId: string;
  speakerName: string;
  text: string;
}
export interface PriorExchange {
  turns: BoundaryTurn[]; // exactly two, [A, B] in reading order
}

function capLine(text: string): string {
  return text.length > MAX_PRIOR_TURN_CHARS
    ? text.slice(0, MAX_PRIOR_TURN_CHARS - 1).trimEnd() + '…'
    : text;
}

/* The immediately-preceding non-excluded story chapter, or null. No cascade:
   selection skips only excluded chapters; whether that predecessor yields an
   exchange is a separate gate (priorChapterBoundaryExchange). */
export function priorChapterIdFor(
  chapterId: number,
  allChapterIds: number[],
  excludedIds: Set<number>,
): number | null {
  const lower = allChapterIds.filter((id) => id < chapterId && !excludedIds.has(id));
  return lower.length ? lower[lower.length - 1] : null;
}

/* The prior chapter's final two-speaker exchange, or null when it does not end
   in a live exchange. Narration and excludeFromSynthesis residue are filtered;
   the remaining eligible sentences in the last PRIOR_TURN_LOOKBACK positions are
   collapsed into contiguous same-speaker turns. Gate: >=2 turns (which, by the
   collapse, guarantees the last two are different speakers). Two distinct people
   folded to one id (e.g. unknown-male) collapse to one turn -> null. */
export function priorChapterBoundaryExchange(
  sentences: Array<{ id: number; characterId: string; text: string; excludeFromSynthesis?: boolean }>,
  roster: Array<{ id: string; name: string }>,
): PriorExchange | null {
  const eligible = sentences
    .slice(-PRIOR_TURN_LOOKBACK)
    .filter((s) => s.characterId !== NARRATOR_ID && s.excludeFromSynthesis !== true);

  const turns: Array<{ speakerId: string; lastText: string }> = [];
  for (const sentence of eligible) {
    const prev = turns[turns.length - 1];
    if (prev && prev.speakerId === sentence.characterId) {
      prev.lastText = sentence.text; // extend the run; keep its boundary-adjacent line
    } else {
      turns.push({ speakerId: sentence.characterId, lastText: sentence.text });
    }
  }
  if (turns.length < 2) return null;

  const nameOf = (id: string): string => roster.find((r) => r.id === id)?.name ?? id;
  const toTurn = (t: { speakerId: string; lastText: string }): BoundaryTurn => ({
    speakerId: t.speakerId,
    speakerName: nameOf(t.speakerId),
    text: capLine(t.lastText),
  });
  const [a, b] = turns.slice(-2);
  return { turns: [toTurn(a), toTurn(b)] };
}

/* Build the per-chapter script-review prompt. We send the full chapter
   sentence sequence plus the post-fold cast roster (id/name/role) so the
   model can identify characters and propose attribution-level edits.
   Only id/characterId/text go out for the sentences; the model returns a
   flat list of ops each with an anchor and optional new-text/pieceCharacterIds
   /mergeIds/emotion. */
/* fs-58 — serialize the per-sentence review input. `instruct` (always English)
   rides along only when present, and `vocalization` only when `true` (never
   `false`), so the prompt sees the fields exactly as the apply layer stores
   them. Lifted out of buildScriptReviewChapterInbox so it can be unit-tested. */
export function buildReviewSentencesInput(
  sentences: Array<{
    id: number;
    characterId: string;
    text: string;
    instruct?: string;
    vocalization?: boolean;
  }>,
): Array<Record<string, unknown>> {
  return sentences.map((s) => ({
    sentenceId: s.id,
    characterId: s.characterId,
    text: s.text,
    ...(s.instruct ? { instruct: s.instruct } : {}),
    ...(s.vocalization ? { vocalization: true } : {}),
  }));
}

export function buildScriptReviewChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
  roster: CastCharacterSlim[],
  priorExchange: PriorExchange | null = null,
): string {
  const sentencePayload = buildReviewSentencesInput(sentences);
  const rosterPayload = roster.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.role ? { role: c.role } : {}),
  }));
  const priorBlock = priorExchange
    ? '## Prior chapter — final exchange (reference only — not reviewable lines; do NOT emit an op on them)\n\n' +
      priorExchange.turns.map((t) => `${t.speakerName} (id: ${t.speakerId}): ${t.text}`).join('\n') +
      '\n\n'
    : '';
  return `---
manuscriptId: ${manuscriptId}
task: script-review
chapterId: ${chapterId}
---

## Cast roster (post-fold)

\`\`\`json
${JSON.stringify(rosterPayload, null, 2)}
\`\`\`

${priorBlock}## Sentences (already attributed)

\`\`\`json
${JSON.stringify(sentencePayload, null, 2)}
\`\`\`
`;
}

export interface ScriptReviewSubscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: NodeJS.Timeout;
}

export interface ScriptReviewReplayState {
  opsEvents: Array<{ kind: 'ops'; chapterId: number; ops: unknown[] }>;
  chapterFailedEvents: Array<{ kind: 'chapter-failed'; chapterId: number; message: string }>;
  lastPhase: Record<string, unknown> | null;
  result: { kind: 'result'; done: true; reviewedChapters: number; totalOps: number } | null;
  errorEvent: Record<string, unknown> | null;
  /** One entry per chapter checkpointed to the ledger this run (Task 3) —
      the ONLY channel that tells a live/reattaching client each chapter's
      ledger `version`, which it must echo back on /resolve and the
      selection PATCH (design spec §5). Without this, a client that ran or
      reattached to a review has no way to learn versions at all, and every
      resolve/PATCH call would silently no-op (Task 9 consumes this). */
  checkpointEvents: Array<{ kind: 'checkpoint'; chapterId: number; version: number }>;
}

export interface ScriptReviewJob {
  controller: AbortController;
  subscribers: Set<ScriptReviewSubscriber>;
  bookId: string;
  /** Set only for a single-chapter run; absent means whole-book. */
  chapterId?: number;
  replay: ScriptReviewReplayState;
}

/* Two separate maps — mirrors analysis.ts's inFlightAnalysisByManuscript /
   inFlightSubsetByManuscript split (server/src/routes/analysis.ts:1678-1684).
   A whole-book job and a single-chapter job for the same book must never be
   mistaken for each other: unlike analysis.ts (which lets main+subset run
   concurrently because they don't share output), both scopes here would
   checkpoint into the SAME per-chapter ledger (Task 3), so this route adds a
   stricter rule analysis.ts doesn't need — see design spec §4.1. */
const mainScriptReviewJobByBook: Map<string, ScriptReviewJob> = new Map();
const subsetScriptReviewJobByBook: Map<string, ScriptReviewJob> = new Map();

function broadcast(job: ScriptReviewJob, payload: Record<string, unknown>): void {
  for (const sub of job.subscribers) sub.send(payload);
}

function attachSubscriber(job: ScriptReviewJob, sub: ScriptReviewSubscriber): void {
  job.subscribers.add(sub);
  const { opsEvents, chapterFailedEvents, checkpointEvents, lastPhase, errorEvent, result } = job.replay;
  for (const ev of opsEvents) sub.send(ev);
  for (const ev of chapterFailedEvents) sub.send(ev);
  for (const ev of checkpointEvents) sub.send(ev);
  if (lastPhase) sub.send(lastPhase);
  if (errorEvent) sub.send(errorEvent);
  if (result) sub.send(result);
}

scriptReviewRouter.post(
  '/:bookId/script-review',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const requestedChapterId: number | undefined =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : undefined;
    const requestedModel: string | undefined =
      typeof req.body?.model === 'string' ? req.body.model : undefined;

    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const manuscriptId = located.state.manuscriptId;
    if (!manuscriptId) {
      res.status(409).json({ error: 'Book has not been analysed yet.' });
      return;
    }

    /* Join/conflict rule (design spec §4.1). */
    const targetMap = requestedChapterId !== undefined ? subsetScriptReviewJobByBook : mainScriptReviewJobByBook;
    const conflictMap = requestedChapterId !== undefined ? mainScriptReviewJobByBook : subsetScriptReviewJobByBook;
    const existingConflict = conflictMap.get(bookId);
    if (existingConflict) {
      res.status(409).json({
        error:
          requestedChapterId !== undefined
            ? 'A whole-book review is already running for this book.'
            : 'A single-chapter review is already running for this book.',
      });
      return;
    }
    const existingSameScope = targetMap.get(bookId);
    if (existingSameScope && existingSameScope.chapterId === requestedChapterId) {
      setUpSse(res);
      const sub = makeSubscriber(res);
      attachSubscriber(existingSameScope, sub);
      res.on('close', () => {
        existingSameScope.subscribers.delete(sub);
        clearInterval(sub.keepAlive);
      });
      return;
    }

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, located.bookDir);
    const allChapterIds = [...byChapter.keys()].sort((a, b) => a - b);
    const excludedChapterIds = new Set<number>(
      located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );
    let chapterIds = allChapterIds;
    if (requestedChapterId !== undefined) {
      chapterIds = allChapterIds.filter((id) => id === requestedChapterId);
    } else {
      chapterIds = allChapterIds.filter((id) => !excludedChapterIds.has(id));
    }

    const castFile = await readJson<CastFile>(castJsonPath(located.bookDir));
    const roster: CastCharacterSlim[] = castFile?.characters ?? [];

    setUpSse(res);
    if (byChapter.size === 0) {
      res.write(
        `data: ${JSON.stringify({ kind: 'error', code: 'no_attribution', message: 'Run analysis first — there are no attributed sentences to review.' })}\n\n`,
      );
      res.end();
      return;
    }
    if (chapterIds.length === 0) {
      res.write(
        `data: ${JSON.stringify({ kind: 'error', code: 'no_such_chapter', message: `Chapter ${requestedChapterId} has no attributed sentences to review.` })}\n\n`,
      );
      res.end();
      return;
    }

    const job: ScriptReviewJob = {
      controller: new AbortController(),
      subscribers: new Set(),
      bookId,
      chapterId: requestedChapterId,
      replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null },
    };
    targetMap.set(bookId, job);
    const sub = makeSubscriber(res);
    job.subscribers.add(sub);
    res.on('close', () => {
      job.subscribers.delete(sub);
      clearInterval(sub.keepAlive);
    });

    void runScriptReviewJob(job, { located, manuscriptId, allChapterIds, excludedChapterIds, chapterIds, byChapter, roster, model: requestedModel })
      .finally(() => {
        if (targetMap.get(bookId) === job) targetMap.delete(bookId);
      });
  },
);

function setUpSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');
}

function makeSubscriber(res: Response): ScriptReviewSubscriber {
  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch {
      /* socket gone */
    }
  }, 15_000);
  const send = (payload: unknown): void => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };
  return { send, res, keepAlive };
}

async function runScriptReviewJob(
  job: ScriptReviewJob,
  ctx: {
    located: Awaited<ReturnType<typeof findBookByBookId>> & object;
    manuscriptId: string;
    allChapterIds: number[];
    excludedChapterIds: Set<number>;
    chapterIds: number[];
    byChapter: Map<number, SentenceOutput[]>;
    roster: CastCharacterSlim[];
    /** The client's requested analyzer model (req.body?.model), captured at
        job creation and threaded through here — today's route passes this
        straight to selectAnalyzerForPhase (script-review.ts:289); the
        detached job runner must keep doing so, or every review silently
        falls back to the default model regardless of what was requested. */
    model: string | undefined;
  },
): Promise<void> {
  const { located, manuscriptId, allChapterIds, excludedChapterIds, chapterIds, byChapter, roster, model } = ctx;
  const send = (payload: unknown): void => {
    const record = payload as Record<string, unknown>;
    if (record.kind === 'ops') job.replay.opsEvents.push(record as ScriptReviewReplayState['opsEvents'][number]);
    else if (record.kind === 'chapter-failed') job.replay.chapterFailedEvents.push(record as ScriptReviewReplayState['chapterFailedEvents'][number]);
    else if (record.kind === 'phase') job.replay.lastPhase = record;
    else if (record.kind === 'error') job.replay.errorEvent = record;
    else if (record.kind === 'result') job.replay.result = record as ScriptReviewReplayState['result'];
    else if (record.kind === 'checkpoint') job.replay.checkpointEvents.push(record as ScriptReviewReplayState['checkpointEvents'][number]);
    broadcast(job, record);
  };
  const heartbeat = makeThrottledHeartbeat(send, 2000);
  const selection = selectAnalyzerForPhase({ phase: 'phase1', model });

  let totalOps = 0;
  let reviewedChapters = 0;
  let actualMsTotal = 0;
  let actualCharsTotal = 0;
  const charsByChapter = buildCharsByChapter(chapterIds, byChapter);
  try {
    for (let i = 0; i < chapterIds.length; i += 1) {
      if (job.controller.signal.aborted) break;
      const chapterId = chapterIds[i];
      send({
        kind: 'phase',
        phaseId: 0,
        progress: i / chapterIds.length,
        label: 'Reviewing script',
        chapterId,
        ...chapterPacingPhaseFields({
          index: i,
          totalChapters: chapterIds.length,
          actualMsTotal,
          actualCharsTotal,
          charsByChapter,
          remainingChapterIds: chapterIds.slice(i),
        }),
      });
      const chapterStartedAt = Date.now();
      const priorId = priorChapterIdFor(chapterId, allChapterIds, excludedChapterIds);
      const priorExchange = priorId !== null ? priorChapterBoundaryExchange(byChapter.get(priorId) ?? [], roster) : null;
      const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
        charBudget: chapterChunkBudget(selection.engine),
        overlap: 3,
        serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
      });
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (job.controller.signal.aborted) break;
        const prompt = buildScriptReviewChapterInbox(
          manuscriptId, chapterId, chunkWithContext(chunk), roster, index === 0 ? priorExchange : null,
        );
        try {
          const result = await selection.analyzer.runScriptReviewChapter(manuscriptId, chapterId, prompt, {
            signal: job.controller.signal,
            language: bookStateLanguage(located.state),
            onChunk: (info) => heartbeat(0, chapterId, { receivedBytes: info.receivedBytes, elapsedMs: info.elapsedMs, sinceLastChunkMs: info.sinceLastChunkMs }),
            onThrottle: (waitMs, reason) => send({ kind: 'throttle', phaseId: 0, chapterIndex: chapterId, model: selection.model, waitMs, reason }),
          });
          const owned = result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)));
          if (owned.length) {
            send({ kind: 'ops', chapterId, ops: owned });
            totalOps += owned.length;
          }
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({ kind: 'error', code: 'quota_exhausted', message: 'Daily analyzer quota exhausted. Already-reviewed chapters are streamed — re-run to finish.', resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined });
            for (const sub of job.subscribers) sub.res.end();
            return;
          }
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        }
      }
      ({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing({ actualMsTotal, actualCharsTotal }, chapterStartedAt, charsByChapter.get(chapterId) ?? 0));
      reviewedChapters += 1;
    }
  } finally {
    for (const sub of job.subscribers) clearInterval(sub.keepAlive);
  }
  if (!job.controller.signal.aborted) {
    send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
    send({ kind: 'result', done: true, reviewedChapters, totalOps });
  }
  for (const sub of job.subscribers) sub.res.end();
}
