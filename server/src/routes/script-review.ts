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
   across the overlapping chunks. Cloud engines get a FINITE budget from
   `chapterChunkBudget`, sized to the per-request token cap minus the roster
   overhead — so a large chapter chunks across several calls instead of
   overrunning the cloud output-token cap in one. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { loadPostFoldSentencesByChapter } from '../store/post-fold-sentences.js';
import { selectAnalyzerForPhase } from '../analyzer/select-analyzer.js';
import { selectAnalyzer, type StageCall } from '../analyzer/index.js';
import { markReviewBusy, clearReviewBusy, isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
import { unloadResidentOllama } from './ollama-health.js';
import { withPassEval } from '../analyzer/analyzer-eval-stats.js';
import { getResolvedGeminiApiKey, getResolvedAllowCloudFallback } from '../workspace/user-settings.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { warmOllamaModel } from './ollama-health.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { AnalyzerTruncatedError } from '../analyzer/errors.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { upsertChapterEntry, readLedger, discardChapters, resolveOps, patchSelection } from '../workspace/script-review-ledger.js';
import {
  chunkSentencesByBudget,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
  OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
} from '../analyzer/chapter-chunker.js';
import {
  buildCharsByChapter,
  chapterPacingPhaseFields,
  accumulateChapterPacing,
} from '../analyzer/chapter-pacing.js';
import type { SentenceOutput, ScriptReviewOp } from '../handoff/schemas.js';
import { configValue } from '../config/resolver.js';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { buildStructureEvidence } from '../analyzer/dialogue-structure/evidence.js';

export const scriptReviewRouter = Router();

/* Local type for the parts of cast.json we need. srv-59 Task 10 — widened
   with gender/aliases (additive) so `roster` can double as
   EvidenceRosterChar[] for buildStructureEvidence; cast.json already stores
   both fields (LibraryCastCharacter), only this narrow type omitted them. */
interface CastCharacterSlim {
  id: string;
  name: string;
  role?: string;
  gender?: 'male' | 'female' | 'neutral';
  aliases?: string[];
}
interface CastFile {
  characters?: CastCharacterSlim[];
}

/* fs-64 — cross-chapter context for the script-review pass. The prior chapter's
   final two-speaker exchange is fed (read-only) into a chapter's first chunk so
   the model can resolve a tagless chapter-opening line via turn-taking. */
const NARRATOR_ID = 'narrator'; // module-private convention (re-declared, never exported)

/* Part 4 — max depth for the force-split-on-truncation recovery (halving the
   chunk's core each level: 1 chunk → up to 8 sub-chunks at depth 3). Beyond
   this a still-truncating span re-throws → chapter-failed (Part 3). */
const MAX_FORCE_SPLIT_DEPTH = 3;

/* Context sentences carried on each side of a chunk core — shared by the
   top-level chunker AND the force-split recursion so the two windows can't
   silently diverge if one is retuned. */
const CHUNK_OVERLAP = 3;
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
/* srv-59 Task 10 — the optional `evidence` map carries per-sentence
   structural-attribution hints (from buildStructureEvidence), appended to
   `text` when present for that sentence id. Undefined/empty map ⇒ `note` is
   undefined ⇒ `text` is `s.text` unchanged ⇒ byte-identical to today. */
export function buildReviewSentencesInput(
  sentences: Array<{
    id: number;
    characterId: string;
    text: string;
    instruct?: string;
    vocalization?: boolean;
  }>,
  evidence?: Map<number, string>,
): Array<Record<string, unknown>> {
  return sentences.map((s) => {
    const note = evidence?.get(s.id);
    return {
      sentenceId: s.id,
      characterId: s.characterId,
      text: note ? `${s.text} ${note}` : s.text,
      ...(s.instruct ? { instruct: s.instruct } : {}),
      ...(s.vocalization ? { vocalization: true } : {}),
    };
  });
}

export function buildScriptReviewChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
  roster: CastCharacterSlim[],
  priorExchange: PriorExchange | null = null,
  evidence?: Map<number, string>,
): string {
  const sentencePayload = buildReviewSentencesInput(sentences, evidence);
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
   stricter rule analysis.ts doesn't need — see design spec §4.1.

   The subset map is keyed by `bookId:chapterId` (via subsetKey), NOT bare
   bookId — two different chapters of the same book are independently
   trackable single-chapter jobs and must never clobber each other's map
   entry (the review gate is scoped per-chapter, not per-book).
   findSubsetJobForBook is how a whole-book request checks "is any
   single-chapter job running for this book" for the conflict rule above —
   an O(n) scan over currently in-flight subset jobs, expected to be a
   handful at most, so this is fine. */
const mainScriptReviewJobByBook: Map<string, ScriptReviewJob> = new Map();
const subsetScriptReviewJobByChapter: Map<string, ScriptReviewJob> = new Map();

function subsetKey(bookId: string, chapterId: number): string {
  return `${bookId}:${chapterId}`;
}

function findSubsetJobForBook(bookId: string): ScriptReviewJob | undefined {
  for (const job of subsetScriptReviewJobByChapter.values()) {
    if (job.bookId === bookId) return job;
  }
  return undefined;
}

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

    /* Join/conflict rule (design spec §4.1), closed against TOCTOU: the
       conflict/join check and the new job's registration into its map all
       happen synchronously in this block, with no `await` between them — a
       concurrent request's handler can't interleave mid-synchronous-block,
       so two near-simultaneous requests for the same scope can no longer
       both pass the check and then both register (the second always
       observes the first's already-registered job and joins it instead). */
    let job: ScriptReviewJob | undefined;
    let joinedExisting: ScriptReviewJob | undefined;
    let targetMap: Map<string, ScriptReviewJob>;
    let registeredKey: string;

    if (requestedChapterId !== undefined) {
      targetMap = subsetScriptReviewJobByChapter;
      registeredKey = subsetKey(bookId, requestedChapterId);
      const conflict = mainScriptReviewJobByBook.get(bookId);
      if (conflict) {
        res.status(409).json({ error: 'A whole-book review is already running for this book.' });
        return;
      }
      const existing = subsetScriptReviewJobByChapter.get(registeredKey);
      if (existing) {
        joinedExisting = existing;
      } else {
        job = {
          controller: new AbortController(),
          subscribers: new Set(),
          bookId,
          chapterId: requestedChapterId,
          replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null },
        };
        subsetScriptReviewJobByChapter.set(registeredKey, job);
      }
    } else {
      targetMap = mainScriptReviewJobByBook;
      registeredKey = bookId;
      const conflict = findSubsetJobForBook(bookId);
      if (conflict) {
        res.status(409).json({ error: 'A single-chapter review is already running for this book.' });
        return;
      }
      const existing = mainScriptReviewJobByBook.get(bookId);
      if (existing) {
        joinedExisting = existing;
      } else {
        job = {
          controller: new AbortController(),
          subscribers: new Set(),
          bookId,
          chapterId: undefined,
          replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null },
        };
        mainScriptReviewJobByBook.set(bookId, job);
      }
    }

    if (joinedExisting) {
      setUpSse(res);
      const sub = makeSubscriber(res);
      attachSubscriber(joinedExisting, sub);
      res.on('close', () => {
        joinedExisting!.subscribers.delete(sub);
        clearInterval(sub.keepAlive);
      });
      return;
    }

    const registeredJob = job!;

    try {
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
        if (targetMap.get(registeredKey) === registeredJob) targetMap.delete(registeredKey);
        res.write(
          `data: ${JSON.stringify({ kind: 'error', code: 'no_attribution', message: 'Run analysis first — there are no attributed sentences to review.' })}\n\n`,
        );
        res.end();
        return;
      }
      if (chapterIds.length === 0) {
        if (targetMap.get(registeredKey) === registeredJob) targetMap.delete(registeredKey);
        res.write(
          `data: ${JSON.stringify({ kind: 'error', code: 'no_such_chapter', message: `Chapter ${requestedChapterId} has no attributed sentences to review.` })}\n\n`,
        );
        res.end();
        return;
      }

      const sub = makeSubscriber(res);
      registeredJob.subscribers.add(sub);
      res.on('close', () => {
        registeredJob.subscribers.delete(sub);
        clearInterval(sub.keepAlive);
      });

      void runScriptReviewJob(registeredJob, { located, manuscriptId, allChapterIds, excludedChapterIds, chapterIds, byChapter, roster, model: requestedModel })
        .catch((err) => {
          // Finding 5 (PR review round 3): a synchronous throw inside
          // runScriptReviewJob (e.g. selectAnalyzerForPhase throwing on a
          // misconfigured engine) previously became an unhandled rejection
          // — no error/SSE event was ever sent and res.end() was never
          // called, so the client's request hung forever.
          broadcast(registeredJob, {
            kind: 'error',
            code: 'internal_error',
            message: err instanceof Error ? err.message : 'Script review failed to start.',
          });
          for (const sub of registeredJob.subscribers) sub.res.end();
        })
        .finally(() => {
          if (targetMap.get(registeredKey) === registeredJob) targetMap.delete(registeredKey);
        });
    } catch (err) {
      if (targetMap.get(registeredKey) === registeredJob) targetMap.delete(registeredKey);
      throw err;
    }
  },
);

scriptReviewRouter.get(
  '/:bookId/script-review/state',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    // Finding 2 (PR review round 3): a job running for one chapter used to
    // short-circuit before the ledger read ever ran, hiding every OTHER
    // chapter's already-persisted, unresolved findings from a hydrating
    // client for the running job's entire duration (subsetScriptReviewJobByChapter
    // allows two different chapters' single-chapter jobs to run concurrently
    // for the same book). Read the ledger unconditionally so it's always
    // included alongside a running job's own replay.
    const manuscriptId = located.state.manuscriptId;
    const entries = manuscriptId ? (await readLedger(located.bookDir, manuscriptId)).entries : {};
    // Finding 6 (PR review round 4): two different chapters' single-chapter
    // reviews can run concurrently for the same book (subsetScriptReviewJobByChapter
    // is keyed by bookId:chapterId), so reporting only the first match here
    // silently hid the other job's live progress/error visibility from a
    // hydrating client — the job itself still completes and checkpoints
    // correctly regardless, but a reload only ever reattached to one of the
    // two. Report every currently-running job for this book instead.
    const runningJobs: Array<{ chapterId?: number; replay: ScriptReviewReplayState }> = [];
    const mainJob = mainScriptReviewJobByBook.get(bookId);
    if (mainJob) runningJobs.push({ chapterId: mainJob.chapterId, replay: mainJob.replay });
    for (const job of subsetScriptReviewJobByChapter.values()) {
      if (job.bookId === bookId) runningJobs.push({ chapterId: job.chapterId, replay: job.replay });
    }
    if (runningJobs.length > 0) {
      res.json({ kind: 'running', running: runningJobs, entries });
      return;
    }
    res.json({ kind: 'ledger', entries });
  },
);

scriptReviewRouter.post(
  '/:bookId/script-review/discard',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const chapterIds: number[] = Array.isArray(req.body?.chapterIds) ? req.body.chapterIds : [];
    await discardChapters(located.bookDir, bookId, chapterIds);
    res.json({ ok: true });
  },
);

scriptReviewRouter.post(
  '/:bookId/script-review/resolve',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const { chapterId, version, appliedOpKeys } = req.body ?? {};
    if (typeof chapterId !== 'number' || typeof version !== 'number' || !Array.isArray(appliedOpKeys)) {
      res.status(400).json({ error: 'chapterId, version, and appliedOpKeys are required.' });
      return;
    }
    const result = await resolveOps(located.bookDir, bookId, { chapterId, version, appliedOpKeys });
    res.json(result);
  },
);

scriptReviewRouter.patch(
  '/:bookId/script-review/selection',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const { chapterId, version, selected } = req.body ?? {};
    if (
      typeof chapterId !== 'number' ||
      typeof version !== 'number' ||
      typeof selected !== 'object' ||
      selected === null ||
      Array.isArray(selected)
    ) {
      res.status(400).json({ error: 'chapterId, version, and selected are required.' });
      return;
    }
    const result = await patchSelection(located.bookDir, bookId, { chapterId, version, selected });
    res.json(result);
  },
);

scriptReviewRouter.post(
  '/:bookId/script-review/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    // Book-level, not chapter-scoped (design spec §4.1): aborts whichever
    // job(s) are running for this book — the whole-book job if present,
    // plus every single-chapter subset job. Deliberately skips
    // findBookByBookId (unlike every other route in this file) — this
    // only touches in-memory job maps, so an unknown bookId is
    // indistinguishable from "nothing running for this book" and both
    // correctly no-op.
    const main = mainScriptReviewJobByBook.get(bookId);
    const subsets = [...subsetScriptReviewJobByChapter.entries()].filter(([, j]) => j.bookId === bookId);
    let cancelled = false;

    // Remove every job from the registry IMMEDIATELY, synchronously — not
    // just via runScriptReviewJob's own eventual `.finally()` cleanup,
    // which only fires once the in-flight analyzer call actually rejects
    // from the abort signal (a genuine LLM call may not do so instantly).
    // Without this, a same-scope retry in that window would find the
    // doomed job still registered and JOIN it (getting an immediate
    // cancelled event instead of starting fresh), a cross-scope retry
    // would 409 against a job that's already cancelled, and GET /state
    // would keep reporting it as running — all directly undermining the
    // "cancel, then start fresh immediately" UX this route exists for.
    // Deleting here is always safe even for a job that turns out to
    // already be aborted: runScriptReviewJob's own `.finally()` delete is
    // keyed on `targetMap.get(registeredKey) === registeredJob`, so it
    // safely no-ops once we've already removed the entry.
    if (main) {
      if (!main.controller.signal.aborted) {
        main.controller.abort();
        cancelled = true;
      }
      mainScriptReviewJobByBook.delete(bookId);
    }
    for (const [key, job] of subsets) {
      if (!job.controller.signal.aborted) {
        job.controller.abort();
        cancelled = true;
      }
      subsetScriptReviewJobByChapter.delete(key);
    }
    res.status(200).json({ ok: true, cancelled });
  },
);

scriptReviewRouter.post(
  '/:bookId/script-review/attach',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const requestedChapterId: number | undefined =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : undefined;

    // Join-only — the create route's join branch, minus the create half.
    // No new job is ever registered here (design spec §4.2): a scope with
    // no matching entry in either map 404s instead of falling through to
    // create, which is what closes the reattach TOCTOU race.
    const job =
      requestedChapterId !== undefined
        ? subsetScriptReviewJobByChapter.get(subsetKey(bookId, requestedChapterId))
        : mainScriptReviewJobByBook.get(bookId);

    if (!job) {
      res.status(404).json({ error: 'No running review to attach to.' });
      return;
    }

    setUpSse(res);
    const sub = makeSubscriber(res);
    attachSubscriber(job, sub);
    res.on('close', () => {
      job.subscribers.delete(sub);
      clearInterval(sub.keepAlive);
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
  let activeSelection = selection; // Task 6 may reassign this to a Gemini-only selection

  let fellBack = false;
  // Tracks the progress fraction of the last emitted phase event, so a
  // mid-run fallback (Ollama dying after several chapters are already done)
  // announces itself at the CURRENT progress instead of snapping the bar
  // back to 0% — the "frozen at 0%" symptom this feature exists to kill.
  let lastEmittedProgress = 0;
  const switchToFallback = (reason: string): void => {
    if (fellBack) return;
    fellBack = true;
    // Re-select a Gemini-only analyzer (fallbackModel has no ':' → gemini),
    // so subsequent chapters skip the dead Ollama primary entirely.
    if (selection.fallbackModel) activeSelection = selectAnalyzer({ model: selection.fallbackModel });
    send({
      kind: 'phase',
      phaseId: 0,
      progress: lastEmittedProgress,
      label: 'Reviewing script',
      activityState: 'waiting',
      model: activeSelection.model,
      engine: activeSelection.engine, // 'gemini'
      fallbackReason: reason,
    });
  };

  // Warm the analyzer model the first chapter will actually use, so a cold
  // Ollama doesn't hang silently behind chapter 1's first token.
  if (activeSelection.engine === 'local') {
    // Emit the `loading` heartbeat from warmOllamaModel's 1s ticker so the
    // panel shows "Loading model · Ns" while the (blocking) keep_alive POST is
    // in flight — a merely-slow cold load reads as working, not stuck.
    const emitLoading = (elapsedMs: number): void =>
      send({ kind: 'phase', phaseId: 0, progress: 0, label: 'Loading model', activityState: 'loading', model: activeSelection.model, engine: 'local', elapsedMs });
    const warm = await warmOllamaModel(activeSelection.model, { signal: job.controller.signal, onProgress: emitLoading });
    if (job.controller.signal.aborted) {
      send({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' });
      for (const sub of job.subscribers) sub.res.end();
      return;
    }
    if (!warm.ok) {
      if (selection.fallbackModel === null) {
        // No fallback (no key, or cloud fallback opted out) — surface the
        // distinct cause so Retry copy tells "Ollama down" from "load too slow".
        const base =
          warm.kind === 'load_timeout'
            ? `The analyzer model (${activeSelection.model}) didn't finish loading in time. It may be large or on a slow disk — try again, or pick a smaller model.`
            : `Couldn't reach the analyzer model (${activeSelection.model}). Is Ollama running and the model pulled?`;
        // Part 1.4 — an opt-out user who has a Gemini key but turned Cloud
        // fallback OFF has a one-click path back: nudge them to it.
        const canReenableCloud = getResolvedGeminiApiKey() != null && !getResolvedAllowCloudFallback();
        const message = canReenableCloud
          ? `${base} Or turn on Cloud fallback in Settings → analyzer to use Gemini when the local analyzer is unavailable.`
          : base;
        send({ kind: 'error', code: 'model_load_failed', message, model: activeSelection.model, warmKind: warm.kind });
        for (const sub of job.subscribers) sub.res.end();
        return;
      }
      // A Gemini fallback exists (key present + cloud fallback on) — don't abort
      // a setup that works today.
      switchToFallback(warm.kind === 'load_timeout' ? 'Ollama model load timed out' : 'Ollama unreachable');
    }
  }

  let totalOps = 0;
  let reviewedChapters = 0;
  let actualMsTotal = 0;
  let actualCharsTotal = 0;
  const charsByChapter = buildCharsByChapter(chapterIds, byChapter);
  /* srv-59 Task 10 — recompute structural evidence fresh over the chapter
     body at review time. Gated by the SAME `analyzer.structure.enabled`
     master switch as the analysis-time engine (Task 8): off → no hydrate,
     no evidence, byte-identical inbox. */
  const structureEnabled = configValue<boolean>('analyzer.structure.enabled');
  const record = structureEnabled ? await getOrHydrateManuscript(manuscriptId) : undefined;
  const bodyByChapter = new Map<number, string>((record?.chapterHints ?? []).map((h) => [h.id, h.body]));
  const reviewLanguage = bookStateLanguage(located.state);
  /* Pin the local analyzer resident for the whole review run. Review calls land
     minutes apart per chapter — the same cadence as attribution — so a finite
     keep-alive would let Ollama evict the model between chapters and cold-reload
     on the next (keepAliveFor pins while isAnyReviewBusy, via isAnyAnalyzerRunBusy).
     Only a local run loads a model; balanced by the clearReviewBusy + evict in
     the finally below. Marked INSIDE the try so a warm-step early-return can't
     leak the ref. */
  const pinnedLocal = selection.engine === 'local';
  try {
    if (pinnedLocal) markReviewBusy(located.bookDir);
    for (let i = 0; i < chapterIds.length; i += 1) {
      if (job.controller.signal.aborted) break;
      const chapterId = chapterIds[i];
      lastEmittedProgress = i / chapterIds.length;
      send({
        kind: 'phase',
        phaseId: 0,
        progress: lastEmittedProgress,
        label: 'Reviewing script',
        chapterId,
        activityState: 'waiting',
        model: activeSelection.model,
        engine: activeSelection.engine,
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
      const structureEvidence = structureEnabled
        ? buildStructureEvidence(bodyByChapter.get(chapterId) ?? '', byChapter.get(chapterId) ?? [], roster, reviewLanguage)
        : undefined;
      const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
        charBudget: chapterChunkBudget(
          activeSelection.engine,
          JSON.stringify(roster).length + 800, // roster payload + fixed template scaffold
          (byChapter.get(chapterId) ?? []).map((s) => s.text).join(' '), // sample → chars/token
          OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS, // reserve the system-prompt overhead (skill + preamble) so the whole request clears the Gemma TPM guard
        ),
        overlap: CHUNK_OVERLAP,
        // Size each sentence by the REAL per-sentence payload buildReviewSentencesInput
        // emits — the appended structureEvidence note (folded into `text`) and the
        // `instruct`/`vocalization` fields — not the bare {id,characterId,text}. The
        // real request carries these, so packing to the bare shape underfilled the
        // budget and let a dense chunk overrun the TPM guard (#1682).
        serialize: (s) => JSON.stringify(buildReviewSentencesInput([s], structureEvidence)[0]),
      });

      /* Part 4 — force-split-on-truncation recovery. Bounding INPUT chars only
         APPROXIMATES bounding OUTPUT tokens (verbose rationales mean a small
         input with many flagged sentences can still overrun), so a chunk can
         still hit MAX_TOKENS (AnalyzerTruncatedError). On truncation, halve the
         chunk's core and retry each half, preserving "each sentence owned by
         exactly one core" (the left/right cores partition the parent core, so
         ownsOp keeps de-duping). A single sentence that still truncates can't
         split further → it re-throws and surfaces as chapter-failed (Part 3).
         Returns the owned ops for `core`. */
      const OVERLAP = CHUNK_OVERLAP;
      /* Lifted to a named per-chapter const (Task 3) so every reviewCore
         invocation for this chapter — across chunks AND recursive force-split
         retries — shares the SAME StageCall. withPassEval (below) folds all
         their onEvalTiming sub-calls into one record. */
      const reviewCall: StageCall = {
        signal: job.controller.signal,
        language: bookStateLanguage(located.state),
        onChunk: (info) => heartbeat(0, chapterId, { receivedBytes: info.receivedBytes, elapsedMs: info.elapsedMs, sinceLastChunkMs: info.sinceLastChunkMs }),
        onThrottle: (waitMs, reason) => send({ kind: 'throttle', phaseId: 0, chapterIndex: chapterId, model: activeSelection.model, waitMs, reason }),
        onFallback: ({ reason }) => switchToFallback(reason),
      };
      const reviewCore = async (
        core: SentenceOutput[],
        contextBefore: SentenceOutput[],
        contextAfter: SentenceOutput[],
        withPrior: boolean,
        depth: number,
      ): Promise<ScriptReviewOp[]> => {
        const coreIds = new Set(core.map((s) => s.id));
        const prompt = buildScriptReviewChapterInbox(
          manuscriptId, chapterId, [...contextBefore, ...core, ...contextAfter], roster, withPrior ? priorExchange : null, structureEvidence,
        );
        try {
          const result = await activeSelection.analyzer.runScriptReviewChapter(manuscriptId, chapterId, prompt, reviewCall);
          return result.ops.filter((op) => ownsOp(coreIds, primarySentenceId(op)));
        } catch (err) {
          if (err instanceof AnalyzerTruncatedError && depth < MAX_FORCE_SPLIT_DEPTH && core.length > 1) {
            const mid = Math.ceil(core.length / 2);
            const left = core.slice(0, mid);
            const right = core.slice(mid);
            // left keeps the chunk's leading context + the head of `right` as its
            // trailing context; right gets the tail of `left` + the chunk's
            // trailing context. Document order is preserved in both prompts.
            const leftOps = await reviewCore(left, contextBefore, [...right.slice(0, OVERLAP), ...contextAfter], withPrior, depth + 1);
            const rightOps = await reviewCore(right, [...contextBefore, ...left.slice(-OVERLAP)], contextAfter, false, depth + 1);
            return [...leftOps, ...rightOps];
          }
          throw err;
        }
      };

      // Finding 8 (PR review round 4): accumulate this chapter's own ops
      // locally as they're produced instead of re-filtering the ENTIRE
      // job-lifetime opsEvents array after every chapter (O(n^2) over a
      // long book) — see chapterOps below.
      const chapterOpsAccum: ScriptReviewOp[] = [];
      // A DailyQuotaExhaustedError used to `return` straight out of this
      // function from inside the loop below. Now that the loop runs inside
      // the withPassEval closure, a `return` there would only exit the
      // closure — so it's captured here and re-checked right after, in the
      // exact same spot the original early-return left off (before this
      // chapter's pacing/checkpoint bookkeeping).
      let quotaErr: DailyQuotaExhaustedError | null = null;
      await withPassEval(
        reviewCall,
        {
          manuscriptId,
          bookTitle: located.state.title ?? null,
          stage: 'review',
          chapterId,
        },
        async () => {
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (job.controller.signal.aborted) break;
            try {
              const owned = await reviewCore(chunk.core, chunk.contextBefore, chunk.contextAfter, index === 0, 0);
              if (owned.length) {
                send({ kind: 'ops', chapterId, ops: owned });
                totalOps += owned.length;
                chapterOpsAccum.push(...owned);
              }
            } catch (err) {
              if (err instanceof AnalysisAbortedError) break;
              if (err instanceof DailyQuotaExhaustedError) {
                quotaErr = err;
                break;
              }
              send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
            }
            // Intra-chapter creep: only advances the bar for multi-chunk (local)
            // chapters; single-chunk / cloud chapters rely on the client timer.
            if (!job.controller.signal.aborted) {
              lastEmittedProgress = (i + (index + 1) / chunks.length) / chapterIds.length;
              send({
                kind: 'phase',
                phaseId: 0,
                progress: lastEmittedProgress,
                label: 'Reviewing script',
                chapterId,
              });
            }
          }
        },
        () => null,
      );
      if (quotaErr) {
        send({ kind: 'error', code: 'quota_exhausted', message: 'Daily analyzer quota exhausted. Already-reviewed chapters are streamed — re-run to finish.', resetAt: (quotaErr as DailyQuotaExhaustedError).resetAt instanceof Date ? (quotaErr as DailyQuotaExhaustedError).resetAt.toISOString() : undefined });
        for (const sub of job.subscribers) sub.res.end();
        return;
      }
      if (job.controller.signal.aborted) {
        // Cancelled mid-chapter: skip the checkpoint for this one chapter
        // entirely rather than persisting a partial result under a
        // "reviewed" chapter id. Mirrors the existing crash-recovery
        // invariant (a chapter only checkpoints once every one of its
        // chunks has been reviewed) — a cancel and a crash now leave the
        // ledger in the same shape for whichever chapter was in flight
        // (design spec §4.1).
        break;
      }
      ({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing({ actualMsTotal, actualCharsTotal }, chapterStartedAt, charsByChapter.get(chapterId) ?? 0));
      reviewedChapters += 1;

      const chapterOps = chapterOpsAccum;
      if (chapterOps.length > 0) {
        try {
          const entry = await upsertChapterEntry(located.bookDir, job.bookId, {
            chapterId,
            manuscriptId,
            ops: chapterOps,
          });
          // Broadcast the minted version so a live or reattaching client can
          // learn it — this is the ONLY channel that delivers a chapter's
          // ledger version to the client; without it, /resolve and the
          // selection PATCH have nothing to echo back and silently no-op
          // (design spec §5, and the version-delivery gap this fixes).
          send({ kind: 'checkpoint', chapterId, version: entry.version });
        } catch (err) {
          // A checkpoint write failure (disk error, lock contention) must not
          // kill the rest of the run — mirror the sibling analyzer-error
          // handling above: report this chapter and keep going. The chapter's
          // ops were already broadcast live via the `ops` events above (if
          // any subscribers were attached), so nothing already-streamed is
          // lost — only the ledger persistence for this one chapter failed.
          send({ kind: 'chapter-failed', chapterId, message: `Failed to save findings: ${(err as Error).message}` });
        }
      }
    }
  } finally {
    for (const sub of job.subscribers) clearInterval(sub.keepAlive);
    /* Release the run-scoped analyzer pin: clear this run's busy ref and, once
       no analysis/other review still needs the model (ref-counted), evict it
       (keep_alive:0) so the pinned model doesn't sit resident forever.
       Best-effort — a failed evict just leaves it to idle per its own value. */
    if (pinnedLocal) {
      clearReviewBusy(located.bookDir);
      if (!isAnyAnalyzerRunBusy()) {
        void unloadResidentOllama().catch(() => {
          /* Ollama unreachable / already evicted — nothing to release. */
        });
      }
    }
  }
  if (job.controller.signal.aborted) {
    send({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' });
  } else {
    // Part 3 — surface chapter failures instead of swallowing them. A chapter
    // that errored (analyzer fail, or a checkpoint-save fail) emitted a
    // `chapter-failed`; collect them (deduped by chapter, keeping the last
    // message) so a partial run says "N chapters couldn't be reviewed" and a
    // total wipeout is a terminal error rather than a silent empty result.
    const failedChapterIds = [...new Set(job.replay.chapterFailedEvents.map((e) => e.chapterId))];
    const failedChapters = failedChapterIds.map((chapterId) => {
      const last = [...job.replay.chapterFailedEvents].reverse().find((e) => e.chapterId === chapterId);
      return { chapterId, message: last?.message ?? 'Chapter review failed.' };
    });
    send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
    if (failedChapters.length > 0 && totalOps === 0) {
      // Nothing usable came back AND something errored — a genuine failure, not
      // a clean "no changes needed" pass. Terminal error so the panel shows it
      // + a Retry instead of quietly emptying (the chapter-35 incident).
      send({
        kind: 'error',
        code: 'review_failed',
        message: `Script review failed — ${failedChapters.length} chapter${failedChapters.length === 1 ? '' : 's'} couldn't be reviewed.`,
        failedChapters,
        lastMessage: failedChapters[failedChapters.length - 1]?.message,
      });
    } else {
      // Success — but if SOME chapters failed while others produced ops, carry a
      // non-fatal failedChapters summary so the partial failure is visible.
      send({
        kind: 'result',
        done: true,
        reviewedChapters,
        totalOps,
        ...(failedChapters.length > 0 ? { failedChapters } : {}),
      });
    }
  }
  for (const sub of job.subscribers) sub.res.end();
}
