/* POST /api/manuscripts/:id/analysis — SSE stream.
   Events are sent as `data: <json>\n\n`. Two payload shapes:
     { kind: 'phase',  phaseId, progress, label? }
     { kind: 'result', response: AnalyseResponse }
   The frontend's `real.analyseManuscript` reads this with fetch + ReadableStream. */

import { rm } from 'node:fs/promises';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getManuscript, getOrHydrateManuscript } from '../store/manuscripts.js';
import type { ManuscriptRecord } from '../store/manuscripts.js';
import { safeBookId } from '../util/safe-id.js';
import { runStage1ChapterChunked, resolveStage1ChunkCharBudget } from '../analyzer/stage1-chunk.js';
import { resolveCapacity, type EngineCapacity } from '../analyzer/capacity.js';
import { applyNarratorDefault } from '../analyzer/narrator-default.js';
import {
  resetAnalyzerConcurrencyPeak,
  getAnalyzerConcurrencyStats,
  endpointIdsForModelIds,
  markEndpointRunActive,
} from '../analyzer/analyzer-concurrency.js';
import { applyNarratorIdentity } from '../analyzer/narrator-identity.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { RunFallbackSwitch, type AnalyzerSelection, type Analyzer, type StageCall } from '../analyzer/index.js';
import {
  selectAnalyzerForPhase,
  isPerPhaseModelSelectionActive,
  resolvePhase1MinLagChapters,
} from '../analyzer/select-analyzer.js';
import {
  createPhaseWatermark,
  createSequentialWatermark,
  type PhaseWatermark,
} from '../analyzer/phase-watermark.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { AnalyzerReasoningOverflowError, GeminiContentBlockedError, AnalyzerTargetInputTooLargeError } from '../analyzer/errors.js';
import { detectOllamaDevice, unloadResidentOllama } from './ollama-health.js';
import { setLastKnownAnalyzerDevice } from '../gpu/analyzer-device-state.js';
import { foldMinorCast } from '../analyzer/fold-minor-cast.js';
import { parseEndpointModelId, type AnalysisEngine } from '../analyzer/model-id.js';
import {
  stripThirdPartyFrontMatter,
  type ThirdPartyGuardChapter,
} from '../analyzer/third-party-front-matter-guard.js';
import { mergeCharacterFields } from '../analyzer/roster-merge-fields.js';
import { dedupeRosterByName, pruneSuggestionsToRoster, EMPTY_DEDUP_CONSTRAINTS, type MergedNewGroup } from '../analyzer/roster-dedup.js';
import { fillToneFromAttributes } from '../analyzer/fill-tone.js';
import {
  loadCastMerges,
  saveCastMerges,
  clearAffectedRefs,
  replaceFoldEntries,
  buildFoldJournalEntries,
  replaceDedupEntries,
  buildDedupJournalEntries,
} from '../store/cast-merges.js';
import { recoverTaggedNarratorLines } from '../analyzer/recover-tagged-lines.js';
import {
  runStage2ChapterChunked,
  resolveStage2ChunkCharBudget,
  type Stage2ChunkRunResult,
} from '../analyzer/stage2-chunk.js';
import {
  hasAttributableContent,
  isDialogueCollapseBreach,
  sourceSpeechHalfCount,
  STAGE2_MIN_SPEECH_HALVES,
  type Stage2CoverageVerdict,
} from '../analyzer/stage2-coverage.js';
import { withPassEval } from '../analyzer/analyzer-eval-stats.js';
import {
  countSentencesHeuristic,
  countStreamedSentences,
  monotonicHighWater,
  sentenceProgressForTick,
  projectChapterEstMsFromSentences,
  selectChapterEstMs,
} from '../analyzer/sentence-progress.js';
import {
  runStage1WithRosterGuard,
  validateRosterCoverage,
  chapterDriftExceeded,
  type MissingSpeaker,
} from '../analyzer/roster-coverage.js';
import { stripFrontMatterBoilerplate } from '../analyzer/strip-front-matter.js';
import { readUserSettings, getCachedUserSettings, getResolvedGeminiApiKey } from '../workspace/user-settings.js';
import { preflightTargets, resolvePreflightDigests, runAnalyzerPreflight, type PreflightTarget } from '../analyzer/preflight.js';
import {
  ANALYSIS_CACHE_VERSION,
  classifyAnalysisCache,
  clearAnalysisCache,
  hasCurrentTake,
  loadAnalysisCache,
  mutateAnalysisCache,
  reachedConfirm,
  type AnalysisCache,
  type CachePatch,
  type ChapterErrorRecord,
} from '../store/analysis-cache.js';
import {
  deleteAnalysisState,
  deleteSubsetAnalysisState,
  writeAnalysisState,
  readAnalysisLastOutcome,
  writeAnalysisLastOutcome,
  type AnalysisStateFile,
  type AnalysisLastOutcome,
} from '../store/analysis-state.js';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1Output,
  Stage1ChapterOutput,
} from '../handoff/schemas.js';
import {
  castJsonPath,
  changeLogJsonPath,
  manuscriptEditsJsonPath,
  slug,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic, enqueuePathOp } from '../workspace/state-io.js';
import { isRestructuring, registerAnalysisBusyProbe } from '../workspace/restructure-gate.js';
import { rollManuscriptEdits, type RollSnapshot } from '../workspace/edits-roll.js';
import { carryTitleSynthesized } from '../workspace/chapter-uuid.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { withBookLock } from '../workspace/book-lock.js';
import { isLockAcquisitionTimeout, requestFailureMessage } from '../workspace/file-lock.js';
import {
  BookDirUnresolvedError,
  tryResolveVerifiedBookDir,
  verifyBookDirForWrite,
  withVerifiedBookDir,
} from '../workspace/book-dir-guard.js';
import { voicedSurvivorsDropped, type Retirement } from '../store/merge-analysis-cast.js';
import {
  retireCharacterId,
  dropSupersededIdsReclaimedByLiveCast,
  dropSupersededTargetsNoLongerLive,
  refuseRetirementsOfLiveIds,
  loadCastIdHistoryWithStatus,
  toMatchHistory,
  followableHistory,
  CastIdHistoryUnreadableError,
  type CastIdHistoryStatus,
} from '../store/cast-id-history.js';
import type {
  DedupConstraints,
  LedgerEntry,
  MatchDecision,
  MatchPlan,
  PriorRow,
  RunAddedLedger,
  StoredSuggestion,
  SupersededKind,
} from '../store/reanalysis-types.js';
import { buildReservedIds, extendPlan, matchFreshToPrior } from '../store/match-fresh-to-prior.js';
import {
  applyMatchPlan,
  planConstraintsFor,
  remapSentenceIds,
  rerouteDeletedTargets,
  retargetPlanForMerge,
  userOwnedFingerprint,
} from '../store/plan-overlay.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import { loadStoredSuggestions, pairKey } from '../store/cast-merge-suggestions.js';
import { unionNotLinkedTo } from '../store/cast-name-match.js';
import {
  materialisePriorAtRunStart,
  persistPlannedCast,
  readPriorCastLockFree,
  refreshLedger,
  sameBookDeclinePredicate,
  writePlanSnapshot,
  type PersistOutcome,
  type PersistOutcomeError,
  type PriorCastSnapshot,
} from '../workspace/analysis-cast-io.js';
import { reconcileRejectEdges } from '../store/reject-edge-reconcile.js';
import { clearNotLinkedEdgesForDroppedRejections } from '../store/not-linked-edges.js';
import { updateStateAtDir } from '../workspace/book-state-update.js';
import { readStateJsonWithRecovery } from '../workspace/state-migrate.js';
import { mintEditEpoch } from '../workspace/slice-revision.js';
import type { BookStateJson, AnalysisProvenanceReport } from '../workspace/scan.js';
import { findBookByManuscriptId, requireBookStateLanguage, BookLanguageUnsetError } from '../workspace/scan.js';
import { BOOK_GONE, BookStateUnreadableError, peekBook } from '../workspace/book-op-lock.js';
import { checkParseHintsPairing } from '../workspace/hints-proof.js';
import { readEditsForHintsCheck, sentencesOf } from '../workspace/hints-proof-io.js';
import { assertHintsPairWithState, HintsOutOfSyncError } from '../workspace/restructure.js';
import { runBookJob, type BookJobLease } from '../workspace/book-jobs.js';
import { markAnalysisBusy, clearAnalysisBusy, isDesignBusy, isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
import { scanSeriesCharactersForBookId } from '../workspace/series-cast-scan.js';
import { dedupSeriesPrior } from '../workspace/series-prior-dedup.js';
import {
  linkSeriesReuseAtAnalysis,
  staleReuseLinkKeys,
  type LinkSeriesReuseOptions,
} from '../workspace/series-reuse-link.js';
import {
  normaliseForMatch as normaliseForMatchShared,
  matchQuoteInSource,
} from '../util/text-match.js';
import {
  appendBatch,
  loadDroppedQuotes,
  saveDroppedQuotes,
  truncateQuote,
  type DropReason,
  type DroppedQuoteEntry,
  type DroppedQuotesBatch,
} from '../store/dropped-quotes.js';
import { configValue } from '../config/resolver.js';
import { PriorCastUnreadableError } from '../workspace/prior-cast-error.js';
import {
  AnalysisPersistError,
  classifyAnalysisFailure,
  tryParseApiError,
  FAILURE_REMEDIATIONS,
  reasoningOverflowAdvice,
  analyzerSelectionErrorEvent,
  type FailureCode,
} from './failure-taxonomy.js';
import { dropBylineAuthorFromChapter } from '../analyzer/byline-author-guard.js';
import {
  buildCjkHonorificIndex,
  resolveCjkHonorificId,
  isCjkLanguage,
} from '../analyzer/cjk-honorifics.js';
import { conventionsFor } from '../analyzer/dialogue-structure/lang/index.js';
import { buildNameIndex } from '../analyzer/dialogue-structure/name-matcher.js';
import { parseChapterStructure } from '../analyzer/dialogue-structure/parser.js';
import { resolveWindows, type WindowRoster } from '../analyzer/dialogue-structure/windows.js';
import { alignSentences } from '../analyzer/dialogue-structure/aligner.js';
import { crossExamine } from '../analyzer/dialogue-structure/cross-examine.js';
import { annotateSceneBreaks } from '../analyzer/scene-breaks.js';
import { escalateFlaggedWindows } from '../analyzer/dialogue-structure/escalation.js';
import type { DecisionBucket, EngineReport, LanguageConventions } from '../analyzer/dialogue-structure/types.js';
import { measureChapterLegibility } from '../analyzer/dialogue-structure/legibility.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { GeminiAnalyzer } from '../analyzer/gemini.js';
import { randomBytes } from 'node:crypto';

/* srv-13 — the existing cast's voice/reuse fields to overlay onto a fresh
   analysis roster. Prefer cast.json; when it's absent (a reparse just deleted
   it) fall back to the reuse-carryover snapshot the reparse handler wrote, so
   continuity survives the reparse → re-analysis window. Once this run writes a
   fresh cast.json it takes precedence and the carryover goes inert until the
   next reparse refreshes it.

   #2015 / #2155 — the whole two-file fallback runs INSIDE the cast lock, which
   is what makes "which file did these rows come from" a decidable question
   answered atomically with the read itself.

   Rule 1 (one level only) holds: both production callers sit at the top of
   their run outside any lock, and applyReparse never calls this. */
export type { PriorCastSnapshot };

export async function readPriorCastForMerge(bookDir: string): Promise<PriorCastSnapshot> {
  return withCastLock(bookDir, () => readPriorCastLockFree(bookDir));
}

/* §4.4 — the choke point every id-retiring call site records through.
   `dedupePriorCastByName` is pure/synchronous by design (unit-
   testable, no file I/O); this is where its reported retirements actually
   reach `cast-id-history.json`, at the route level where bookDir is in
   scope. No-op when bookDir is absent (legacy non-workspace path) or the
   list is empty.

   `liveIds` is the roster that is actually persisted at this point — pass
   ids of the roster `persistPlannedCast` wrote at a final cast.json write. Anything naming
   one of them as `from` is refused and logged (Wave 2 final-review finding
   1(b); see `refuseRetirementsOfLiveIds` for why that shape is bogus by
   definition and why the end-of-run drop cannot repair it). Pass `null` ONLY
   where no roster is final yet, and say why at the call site — the parameter
   is deliberately required rather than optional so a new call site cannot
   skip the filter by omission.

   `bookId` (#2133) is threaded through purely so a retirement that drops a
   self-loop `rejectedPairs` entry (`retireCharacterId`'s
   `droppedSelfLoopRejections`) can locate and clear the matching one-sided
   `notLinkedTo` edge on `cast.json` — that edge is keyed by `(bookId,
   characterId)`, not `bookDir`. `null`/undefined is tolerated (mirrors
   `bookDir`): the retirement itself still records, just without the
   notLinkedTo cleanup, since there is no book to look one up on. */
export async function recordRetirements(
  bookDir: string | null | undefined,
  bookId: string | null | undefined,
  retirements: ReadonlyArray<Retirement>,
  liveIds: ReadonlyArray<string> | null,
  log: (phaseId: number, message: string) => void,
  kind: SupersededKind,
): Promise<void> {
  if (!bookDir || !retirements.length) return;
  const { keep, refused } = liveIds
    ? refuseRetirementsOfLiveIds(retirements, liveIds)
    : { keep: retirements, refused: [] as Retirement[] };
  /* Operator-visible, mirroring the "Dropped N history alias(es)…" line at
     the final write: a silently-dropped retirement is exactly how this class
     of bug hid for two waves. */
  if (refused.length) {
    log(
      1,
      `Refused ${refused.length} character-id retirement(s) naming a still-live cast id (${refused
        .map((r) => `${r.from} -> ${r.to}`)
        .join(', ')}) — recording one would repoint unrelated history onto the wrong character.`,
    );
  }
  for (const { from, to } of keep) {
    const result = await retireCharacterId(bookDir, from, to, kind);
    if (result.droppedSelfLoopRejections.length && bookId) {
      await clearNotLinkedEdgesForDroppedRejections(bookDir, bookId, result.droppedSelfLoopRejections);
    }
  }
}

/* #2214/#2201 — shared user-facing wording for "cast-id-history.json could
   not be read, nothing changed" so it reads identically no matter which of
   the three call sites emits it: this function's own degraded-read branch
   below, and the two persist blocks' `catch (historyErr)` handlers, which
   need the same line because a degraded read now makes
   `dropSupersededIdsReclaimedByLiveCast` throw before this function is ever
   reached (see those handlers' own comments). */
export const DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE =
  `Skipped "not the same character" link check — cast-id-history.json for this book could not ` +
  `be read. No links were changed; the file needs attention (see the server log for the cause).`;

/* #2214/#2201 review finding 5 — the two persist-block `catch (historyErr)`
   handlers below had identical bodies (an `instanceof` check plus the same
   `log()` call), pinned only by a source-scan test because the persist
   blocks themselves aren't standable-up in a unit test. Extracting the
   shared body into its own exported function gives that behaviour a
   reachable seam: this can be driven directly, including the negative case
   (a plain `Error` emits nothing) that a source scan can't check at all. */
export function logIfDegradedCastIdHistory(
  err: unknown,
  log: (phaseId: number, message: string) => void,
): void {
  if (err instanceof CastIdHistoryUnreadableError) {
    log(1, DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE);
  }
}

/* Plan 291 rule 10 (#4031): does the book have a prior cast or any merge history
   to match against? Then Phase 1 is held for the plan. A degraded history counts:
   it cannot be read, so it cannot be ruled out. `bookDir` is the dir the run start
   just verified (final review T15), never the job's captured record, which a move
   can leave naming a stale folder. */
async function bookHasPriorOrHistory(bookDir: string | undefined, priorRows: number): Promise<boolean> {
  if (!bookDir) return false;
  if (priorRows > 0) return true;
  const h = toMatchHistory(await loadCastIdHistoryWithStatus(bookDir));
  return (
    h.status === 'degraded' ||
    Object.keys(h.supersededBy).length > 0 ||
    Object.keys(h.displaced).length > 0 ||
    h.notSamePerson.length > 0
  );
}

/* Plan 291 (#4031, A22) — the subset job's terminal on a legacy cache (owner,
   2026-11-06). The main job clears such a cache and starts over; a chapter
   re-analysis cannot, so it asks for the full run. */
export const ANALYSIS_CACHE_LEGACY_MESSAGE =
  "This book's saved analysis is from an older version of Castwright, so its chapters can't be re-analysed one at a time. Run the full analysis again to rebuild it.";

/* ── Run start (plan 291, #4031), shared by the main and the subset job. Under the
   cast lock, materialise the prior: prune the stale reuse links, heal identical
   names, and write a Re-parse carryover into cast.json - so every later re-read
   has a file and no snapshot can undo the heal. The slow half of the prune (which
   links are stale) runs before the lock. The cache's `addedRows` (a stopped main
   run's ledger) is refreshed for every row the write touches (rule 11; for the
   subset job this is the cross-job refresh, invariant 6). Returns the healed
   prior; a book with no folder keeps the prior it was given. `verifiedDir`: the
   identity-verified dir the write went through (T15: the Phase-1 hold reads it). */
async function materialiseRunStartPrior(a: {
  job: AnalysisJob;
  record: { bookId?: string | null; bookDir?: string | null; title: string };
  cache: AnalysisCache;
  prior: Array<{ id: string } & Record<string, unknown>>;
  log: (phaseId: number, message: string) => void;
  verifiedDir?: { value?: string };
}): Promise<Array<{ id: string } & Record<string, unknown>>> {
  const { job, record, cache, log } = a;
  if (!record.bookDir) return a.prior;
  const ledgerIn = cache.addedRows ?? {};
  const runOwnedIds = new Set(
    Object.entries(ledgerIn)
      .filter(([, e]) => e.state === 'run-owned')
      .map(([id]) => id),
  );
  const staleLinkKeys = record.bookId
    ? await staleReuseLinkKeys(record.bookId, a.prior as unknown as Parameters<typeof staleReuseLinkKeys>[1])
    : new Set<string>();
  const out: { m?: Awaited<ReturnType<typeof materialisePriorAtRunStart>> } = {};
  /* #2196 - through the identity-verified LIVE book dir, mode 'throw': a stale
     path (moved book, or one now holding another book) is never written, and
     the run ends here in the curated STALE_BOOK_DIR terminal. Skipping instead
     would run on the unhealed first read with the carryover never in cast.json,
     and every later cast.json-only reader would see a Re-parse's rows as deleted. */
  await withVerifiedBookDir(
    { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job) },
    async (bookDir) => {
      if (a.verifiedDir) a.verifiedDir.value = bookDir;
      out.m = await materialisePriorAtRunStart({
        bookDir,
        bookId: record.bookId ?? undefined,
        staleLinkKeys,
        runOwnedIds,
        ledger: ledgerIn,
      });
    },
  );
  if (!out.m) return a.prior;
  const m = out.m;
  /* R1 - the refreshed rule-11 ledger: in memory (so the job's copy matches the
     file) and in the cache file. */
  const ledgerPatch = ledgerDelta(ledgerIn, m.ledger);
  if (Object.keys(ledgerPatch).length > 0) {
    cache.addedRows = m.ledger;
    await mutateAnalysisCache(job.manuscriptId, { ledger: ledgerPatch });
  }
  if (m.healDropped.length) {
    log(
      1,
      `Collapsed ${m.healDropped.length} duplicate prior-cast row(s) by name (${m.healDropped
        .map((d) => d.name ?? d.id)
        .join(', ')}).`,
    );
  }
  /* R26 - recorded after the cast lock is released. §4.4 / Task 8 fix round 1
     (item 1) - a throwing history write (EPERM/ENOSPC on cast-id-history.json)
     must never fail the analysis persist. `liveIds: null` - no roster is final
     yet, and every `from` is a prior row the heal just removed (the one case
     where a `from` could come back live, this run's fresh roster re-minting
     it, is handled at the end of the run by
     `dropSupersededIdsReclaimedByLiveCast`). */
  try {
    await withVerifiedBookDir(
      { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
      async (bookDir) => {
        await recordRetirements(bookDir, bookIdForRetirementCleanup(record), m.healRetirements, null, log, 'heal');
      },
    );
  } catch (historyErr) {
    /* #2260 - the canonical "why" for the rethrow sites in this file: a lock
       ACQUISITION timeout is not the disk fault this handler is scoped for.
       Let exactly that class through; swallow EPERM/ENOSPC/AV-lock and
       CastIdHistoryUnreadableError as before. */
    if (isLockAcquisitionTimeout(historyErr)) throw historyErr;
    console.warn('[analysis] failed to record character-id retirement(s) (dedup)', historyErr);
  }
  return m.prior as Array<{ id: string } & Record<string, unknown>>;
}

// Moved to workspace/analysis-cast-io.ts (the snapshot/persist reconcile needs it too).
export { sameBookDeclinePredicate };

/* #2166 — the per-persist half of the reject-edge invariant. Its sibling
   (`clearNotLinkedEdgesForDroppedRejections`, #2133 — moved to
   `store/not-linked-edges.ts` by #2239) is PER-RETIREMENT and driven by
   `droppedSelfLoopRejections`; this one is PER-PERSIST and
   derived purely from state, which is what lets it heal a reject that failed
   between its two writes — a state no retirement ever reports. The two are
   compatible in either order: after the #2133 helper runs, pair and edge are
   both gone, so this sees nothing to do.

   Its OWN withCastLock, and the write is TEXTUALLY inside it, in this file.
   That is not stylistic: `cast-lock.guard.test.ts` is syntactic and
   call-graph-blind, and this file's allowlist entry is keyed on file AND
   count, so a write that lived in reject-edge-reconcile.ts (however well
   locked by its caller) would read as a sixth unlocked write here and redden
   the build. reject-edge-reconcile.ts is therefore PURE and this function
   owns the read, the lock and the write.

   Best-effort, mirroring every other id-history write in this file: a failure
   must not fail the analysis. A surviving stale edge merely re-suppresses one
   future §4.4 name-match until the next persist tries again.

   Fails SAFE on either read (final-review Critical, #2166). An unreadable
   cast.json already did — the roster is empty, so nothing is reconciled. An
   unreadable cast-id-history.json used to fail DESTRUCTIVE, because the empty
   history it degrades to is indistinguishable from "nothing was ever
   rejected", which is exactly the evidence the removal pass acts on. It now
   reads the history through `loadCastIdHistoryWithStatus` and refuses to act
   at all on `degraded`. See the comment at that call below.

   `statusBeforePersist` exists because that local read is NOT sufficient on
   its own at the two persist call sites (PR #2202 gate review, Critical). The
   steps that run earlier in the same try block — `recordRetirements`,
   `dropSupersededIdsReclaimedByLiveCast`, `dropSupersededTargetsNoLongerLive`
   — all read through the COLLAPSING `loadCastIdHistory` and write back
   unconditionally, so a cast-id-history.json that was degraded when the
   persist began has already been REPLACED with a valid, empty file by the time
   this function reads it. The local read then says `ok`, the guard never
   fires, and every same-book reject edge is deleted — both records of a real
   user decision gone, deterministically, on the next analysis. So the callers
   inside the persist decide the verdict BEFORE the first rewriting step and
   hand it in here; a `degraded` verdict wins over whatever the file says by
   now. Direct callers that pass nothing keep the local read as their only
   check, which is correct for them — nothing has laundered the file underneath
   them.

   Exported only so analysis-reject-edge-reconcile.test.ts can drive it
   without standing up a full analysis run. */
export async function reconcileRejectEdgesOnDisk(
  bookDir: string,
  bookId: string | undefined,
  log: (phaseId: number, message: string) => void,
  statusBeforePersist?: CastIdHistoryStatus,
): Promise<{ before: CharacterOutput[]; after: CharacterOutput[] } | null> {
  /* No bookId means no way to tell this book's edges from a cross-book one —
     see bookIdForRetirementCleanup, which already warns for this run. */
  if (!bookId) return null;
  try {
    /* Plan 291 (#4031, Task 27 F2) — the rows before and after a write, so the caller can
       refresh a run's addedRows fingerprints for the edges this heal wrote (rule 11). */
    return await withCastLock(bookDir, async (): Promise<{ before: CharacterOutput[]; after: CharacterOutput[] } | null> => {
      const cast = await readJson<{ characters?: CharacterOutput[] }>(castJsonPath(bookDir));
      if (!cast?.characters?.length) return null;
      /* #2166 final review (Critical) — the removal pass treats an empty
         history as PROOF that every same-book edge is stranded. A `degraded`
         read (the file exists but is unreadable or the wrong shape) produces
         the same empty history as `absent` does, but proves nothing: a
         transient EPERM/EBUSY from an AV scanner or a cloud-sync client would
         otherwise delete every reject the user ever made on this book — and
         only a `rejectedPairs`-backed one could ever come back. So skip the
         whole reconciliation, not just the removals: the add pass has nothing
         to add from an empty history anyway (it is driven entirely by
         `rejectedPairs`), so skipping it costs nothing and skipping outright
         is one branch instead of two. `absent` keeps its current meaning —
         that IS the genuine pre-#2166 stranded-edge shape. */
      const { status: statusNow, history } = await loadCastIdHistoryWithStatus(bookDir);
      /* Belt AND braces (PR #2202 gate review, Critical). `statusNow` alone is
         blind at the persist call sites, where an earlier always-writing step
         has already laundered a degraded file into a valid empty one — see the
         `statusBeforePersist` paragraph in this function's doc comment. A
         degraded verdict from EITHER read refuses. */
      const status = statusBeforePersist === 'degraded' ? 'degraded' : statusNow;
      if (status === 'degraded') {
        console.warn(
          `[analysis] reject-edge reconciliation skipped for book ${bookId} — its cast-id-history.json ` +
            `could not be read (see the [cast-id-history] warning just above for the cause), so a ` +
            `stranded "not the same character" link cannot be told from one whose recorded rejection ` +
            `is merely unreadable right now. No links were changed; the next persist will try again.`,
        );
        /* #2201 — the console.warn above is operator-visible only; a user
           watching the in-app run log saw nothing and read a clean run as
           proof the book was healthy. Distinguishable from the `Cleared N
           stranded …` / `Restored N …` lines below (those fire only when a
           write actually happened): this one fires only when nothing changed
           because the file could not be trusted. */
        log(1, DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE);
        return null;
      }
      const { adds, removes, next } = reconcileRejectEdges(bookId, cast.characters, history);
      if (!adds.length && !removes.length) return null;
      const payload = { characters: next };
      await writeJsonAtomic(castJsonPath(bookDir), payload);
      if (removes.length) {
        log(
          1,
          `Cleared ${removes.length} stranded "not the same character" link(s) with no recorded ` +
            `rejection (${removes.map((e) => `${e.characterId} -/- ${e.orphanedId}`).join(', ')}).`,
        );
      }
      if (adds.length) {
        log(
          1,
          `Restored ${adds.length} "not the same character" link(s) from a recorded rejection ` +
            `(${adds.map((e) => `${e.characterId} -/- ${e.orphanedId}`).join(', ')}).`,
        );
      }
      return { before: cast.characters, after: next };
    });
  } catch (err) {
    /* #2260 round 4 (owner decision) — the FIRST deliberate exception. Every
       IDENTITY handler #2260 touched lets a withKeyLock ACQUISITION timeout
       through (`isLockAcquisitionTimeout`, workspace/file-lock.ts); this one
       swallows it along with everything else, and does so on purpose. (#2292
       later added deliberate swallows on the same kind of reasoning at the
       interim cast.json snapshots, which a final write in the same run
       clobbers — since plan 291 that is the one shared `snapshotPlannedRoster`
       swallow — so this is no longer the ONLY one, as this comment used to
       say. It is still the only one in the identity path.)

       Round 2 added a rethrow here on the same reasoning it used at the
       identity sites (six then; four identity catches since plan 291) —
       "cast.json is already written and the identity record never updated". That reasoning does not describe THIS site. It was
       copy-pasted from handlers where the caught error can come out of
       `retireCharacterId` itself; here no identity record is at risk, because
       this call runs LAST in the persist — after every `recordRetirements`
       and both `dropSuperseded*` calls have already landed — and the only
       thing it writes is a set of cosmetic `notLinkedTo` edges. A failure
       here is exactly what this function's own doc comment above says it is:
       a surviving stale edge re-suppresses ONE future §4.4 name-match until
       the next persist tries again, and this pass is itself the self-healing
       mechanism. Failing an entire completed analysis run over that is
       disproportionate, so the whole handler stays best-effort — a lock
       timeout included. */
    console.warn('[analysis] failed to reconcile reject edges (non-fatal)', err);
    return null;
  }
}

/* #3784 — the analysis writes of manuscript-edits.json (the terminal persists
   and Start fresh's delete) take the `book` lock the slice PUT holds across its
   manuscript revision check + write. Callers hold no `cast` lock at those
   points, and `book` is re-entrant. A record with no bookId (legacy) has no
   lock key and runs unlocked as before. */
function withOptionalBookLock<T>(
  bookId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return bookId ? withBookLock(bookId, fn) : fn();
}

/* srv-13 — when the merge re-adds voiced/reused characters the fresh roster
   dropped (a transient analyzer miss), leave a change-log breadcrumb so the
   rescue is visible. Mirrors the change-log write pattern in book-state.ts.
   Best-effort: a log failure must never disturb the persist. */
export async function logCarriedForwardCharacters(
  bookId: string | undefined,
  bookDir: string,
  dropped: Array<{ id: string; name?: string }>,
): Promise<void> {
  if (!dropped.length) return;
  try {
    /* #3784 — the read -> write of change-log.json is one `book`-locked span,
       shared with the slice PUT and the reparse append. No cast lock is held
       here (order `cast` -> `book`), and `book` is re-entrant. */
    const append = async (): Promise<void> => {
      const logPath = changeLogJsonPath(bookDir);
      const existingLog = await readJson<{ events?: Array<{ id?: number }> }>(logPath);
      const prior = Array.isArray(existingLog?.events) ? existingLog!.events! : [];
      const nextId = prior.reduce((m, e) => Math.max(m, e?.id ?? 0), 0) + 1;
      const names = dropped.map((d) => d.name || d.id).join(', ');
      const noun = dropped.length === 1 ? 'character' : 'characters';
      await writeJsonAtomic(logPath, {
        events: [
          {
            id: nextId,
            at: new Date().toISOString(),
            ts: 'Just now',
            date: 'today',
            type: 'reparse',
            title: 'Preserved designed voices across re-analysis',
            note: `Re-analysis omitted ${dropped.length} voiced ${noun} (${names}); carried their designed/reused voices forward.`,
            actor: 'system',
          },
          ...prior,
        ],
      });
    };
    /* A record with no bookId (legacy) has no lock key; append unlocked as before. */
    if (bookId) await withBookLock(bookId, append);
    else await append();
  } catch (logErr) {
    console.warn('[analysis] carried-forward change-log write failed', logErr);
  }
}

/* Human-readable label for a Gemini model id. Kept in lockstep with
   src/lib/models.ts MODEL_OPTIONS — the frontend sends the id, we render
   the friendly name in logs and the SSE event stream. */
const MODEL_LABELS: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemma-4-31b-it': 'Gemma 4 31B',
  'gemma-4-26b-a4b-it': 'Gemma 4 26B',
};

function humanModel(modelId: string | undefined): string {
  if (!modelId) return 'analyzer';
  return MODEL_LABELS[modelId] ?? modelId;
}

/** Engine-aware label so SSE chunks read "Ollama (qwen3.5:9b)" for the local analyzer,
    "Gemma 4 31B" for Gemini, and "<endpoint name> (qwen3:30b)" for an OpenAI-compatible
    endpoint (#3084). The MODEL_LABELS lookup only covers Gemini ids, so the local
    branch surfaces the raw tag — Ollama tags are already readable. */
export function engineLabel(engine: AnalysisEngine, modelId: string): string {
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    if (!parsed) return `Endpoint (${modelId})`;
    const name = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed.endpointId)?.name;
    return name ? `${name} (${parsed.model})` : `Endpoint ${parsed.endpointId} (${parsed.model})`;
  }
  return engine === 'local' ? `Ollama (${modelId})` : humanModel(modelId);
}

/* Plan 88 — pipelined two-model analyzer.
   Min-lag resolution moved into server/src/analyzer/select-analyzer.ts
   (`resolvePhase1MinLagChapters`) so it shares precedence shape with
   the model picker: env > user-settings > hardcoded default (10). The
   lag is the user's "keep 10 chapters between Gemma and Gemini"
   requirement: Phase 1 chapter K dispatches when Phase 0's watermark
   reaches `K + ANALYZER_PHASE1_MIN_LAG_CHAPTERS`. Set to `0` to release
   the lag (pipelining still happens; Gemini just dispatches as soon
   as the per-chapter roster snapshot exists for its chapter). */

/* Per-job watermark factory. Real watermark when the per-phase
   knobs are active. Otherwise the sequential stub (Phase 1 waits for
   `markPhase0AllDone()` exactly like today's hard phase gate). Exported
   for unit testing. */
/* Plan 291 rule 10 (#4031): `holdForPlan` is true for a book with a prior cast or
   any merge history. Phase 1 then waits for Phase 0b, which applies the match
   plan, so no take is ever attributed in raw id space - the sequential stub is
   exactly that wall. A first analysis keeps today's pipelining. */
export function createWatermarkForJob(opts: { holdForPlan?: boolean } = {}): PhaseWatermark {
  if (opts.holdForPlan || !isPerPhaseModelSelectionActive()) {
    return createSequentialWatermark();
  }
  return createPhaseWatermark({ minLagChapters: resolvePhase1MinLagChapters() });
}

/* Front-end palette has 30 character slots (see src/lib/colors.ts
   CHAR_COLORS + CHARACTER_SLOTS). Gemini and humans both like to invent
   character-specific kebab names like `marlow` that don't exist in the
   palette and fall back to grey. We normalise here: narrator keeps its
   slot; everyone else gets a slot in roster order, cycling after 30.
   Order must match src/lib/colors.ts CHARACTER_SLOTS. */
const PALETTE_SLOTS = [
  'halloran',
  'eliza',
  'marcus',
  ...Array.from({ length: 27 }, (_, i) => `slot-${i + 4}`),
];
function assignPaletteColors(characters: CharacterOutput[]): CharacterOutput[] {
  let i = 0;
  return characters.map((c) => {
    if (c.id === 'narrator' || c.color === 'narrator') return { ...c, color: 'narrator' };
    const slot = PALETTE_SLOTS[i % PALETTE_SLOTS.length];
    i += 1;
    return { ...c, color: slot };
  });
}

/* Normalises evidence ordering longest-first across every consumer:
   the profile drawer renders index 0 at the top, and voice-sample
   generation uses index 0 as the cloning sample. Mutates in place so
   the same object reference flows into the on-disk cache and the SSE
   payload. Logs a dev warning when a character ships with fewer than
   3 quotes — the analyzer prompt asks for ≥3, so anything less is a
   weak pass worth surfacing in the server log. */
export function sortEvidence(characters: CharacterOutput[]): void {
  for (const c of characters) {
    if (c.evidence && c.evidence.length > 1) {
      c.evidence.sort((a, b) => b.quote.length - a.quote.length);
    }
    if (!c.evidence || c.evidence.length < 3) {
      console.warn(
        `[analysis] ${c.id} has ${c.evidence?.length ?? 0} evidence quote(s); analyzer prompt asks for ≥3.`,
      );
    }
  }
}

/* Re-export the shared text normaliser (lives under server/src/util/) so
   the existing `import { normaliseForMatch } from './analysis.js'` callers
   (cast-merge, analysis.test) keep working. The voice-match route imports
   it directly from the util. */
export const normaliseForMatch = normaliseForMatchShared;

/* Drops evidence quotes that don't match the source under any of three
   tiers (see util/text-match.ts → matchQuoteInSource):
     1. verbatim       — pure substring after typography normalisation
     2. terminal_punct — same, after trimming trailing `.,;:!?` (handles
                         the dominant false positive: model closes the
                         utterance with `.` because it's a complete
                         sentence, source closes with `,` because a
                         dialogue tag follows)
     3. segments       — split on sentence-final punctuation; every
                         surviving segment (≥ 8 chars, ≥ 2 segments)
                         must appear in source (handles "stitched"
                         same-speaker dialogue with the narration tag
                         removed between halves)

   Mutates characters in place so the cleaned arrays flow into the
   cache + SSE payload. `log` is invoked once per character that had
   drops, plus once globally with per-tier kept-counts when the looser
   tiers actually fired — useful for tuning the thresholds later.

   The `entries` field on the return value lets callers persist a
   batch to .audiobook/dropped-quotes.json — quotes are truncated at
   MAX_QUOTE_CHARS so an outlier multi-paragraph fabrication doesn't
   bloat the ledger. The `c.name` is captured at drop-time so the
   ledger stays human-readable even after a later merge renames the
   character. */
export function verifyEvidenceAgainstSource(
  characters: CharacterOutput[],
  sourceText: string,
  log: (message: string) => void,
): { totalDropped: number; affectedCharacters: number; entries: DroppedQuoteEntry[] } {
  const normalisedSource = normaliseForMatch(sourceText);
  let totalDropped = 0;
  let affectedCharacters = 0;
  const entries: DroppedQuoteEntry[] = [];
  let keptVerbatim = 0;
  let keptTerminalPunct = 0;
  let keptSegments = 0;
  for (const c of characters) {
    if (!c.evidence?.length) continue;
    const kept: typeof c.evidence = [];
    const dropped: typeof c.evidence = [];
    const droppedReasons: DropReason[] = [];
    for (const e of c.evidence) {
      const norm = normaliseForMatch(e.quote);
      const tier = matchQuoteInSource(norm, normalisedSource);
      if (tier) {
        kept.push(e);
        if (tier === 'verbatim') keptVerbatim++;
        else if (tier === 'terminal_punct') keptTerminalPunct++;
        else keptSegments++;
      } else {
        dropped.push(e);
        droppedReasons.push(norm.length === 0 ? 'empty_after_normalisation' : 'not_in_source');
      }
    }
    if (dropped.length > 0) {
      totalDropped += dropped.length;
      affectedCharacters += 1;
      const head = dropped[0].quote.slice(0, 60).replace(/\s+/g, ' ');
      log(
        `Dropped ${dropped.length} fabricated quote${dropped.length === 1 ? '' : 's'} on ${c.id} (e.g. "${head}${dropped[0].quote.length > 60 ? '…' : ''}").`,
      );
      console.warn(`[analysis] dropped ${dropped.length} unverified quote(s) on ${c.id}`);
      for (let i = 0; i < dropped.length; i++) {
        const d = dropped[i];
        const { text, truncated } = truncateQuote(d.quote);
        entries.push({
          characterId: c.id,
          characterName: c.name,
          quote: text,
          truncated,
          reason: droppedReasons[i],
          note: d.note,
        });
      }
    }
    c.evidence = kept;
  }
  if (keptTerminalPunct > 0 || keptSegments > 0) {
    log(
      `Quote-match tiers: verbatim=${keptVerbatim}, terminal-punct=${keptTerminalPunct}, segments=${keptSegments}.`,
    );
  }
  return { totalDropped, affectedCharacters, entries };
}

/* After verifyEvidenceAgainstSource has stripped fabricated quotes,
   any non-narrator character left with zero surviving evidence failed
   the Stage-1 skill's own inclusion test ("Test for inclusion: can you
   copy a verbatim sentence … that is dialogue the entity speaks?").
   That's the catch-net for the dominant failure mode the user sees in
   the wild: the model lists a non-speaker (a pet hissing, an unnamed
   bystander whose attribution the model invented, a one-line
   placeholder it later admitted it couldn't quote) on the roster, the
   verifier kills the invented quotes, and a hollow character slot
   survives all the way into the cast view.

   Drop them here so the post-Phase-0b cast.json + the SSE cast-update
   only ever surface speakers with at least one verifiable line. The
   narrator is exempt — the narrator's "lines" are prose, not dialogue,
   and the Stage-1 prompt doesn't ask for verbatim quotes from prose. */
/** Tokenise a display name the same way the roster-coverage guard does
    (lowercase, split on whitespace / dots / hyphens, tokens ≥ 2 chars) so a
    tagged-speaker name ("Oduvan") overlaps a fuller cast name ("Master
    Oduvan") on a shared token. */
function nameTokensForDrop(name: string): Set<string> {
  return new Set(
    (name || '')
      .toLowerCase()
      .split(/[\s.-]+/)
      .filter((t) => t.length >= 2),
  );
}

export function dropEvidencelessCast(
  characters: CharacterOutput[],
  log: (message: string) => void,
  sourceText = '',
): CharacterOutput[] {
  /* Defense-in-depth — the evidence verifier can kill every quote of a REAL
     speaker when the source-vs-quote match is fragile (an encoding quirk such
     as an undecoded `&#x27;`, an LLM paraphrase). The roster-coverage guard
     that exists to never lose a tagged speaker runs during DETECTION, before
     this prune, so it can't protect against the prune. Re-derive the prose
     dialogue-tag signal here (empty roster ⇒ every bounded `<Name> <verb>`
     speaker) and keep an evidenceless character the source still tags as a
     speaker. The narrator-less prune purpose — killing INVENTED non-speakers
     the model hallucinated onto the roster — is preserved: those have no
     dialogue tags, so they still drop. Only scanned when there's actually an
     evidenceless non-narrator character to rescue. */
  const hasEvidenceless = characters.some(
    (c) => c.id !== 'narrator' && (c.evidence?.length ?? 0) === 0,
  );
  const taggedTokens = new Set<string>();
  if (sourceText && hasEvidenceless) {
    for (const sp of validateRosterCoverage(sourceText, []).missingSpeakers) {
      for (const tok of nameTokensForDrop(sp.name)) taggedTokens.add(tok);
    }
  }

  const kept: CharacterOutput[] = [];
  const droppedNames: string[] = [];
  const rescuedNames: string[] = [];
  for (const c of characters) {
    if (c.id === 'narrator') {
      kept.push(c);
      continue;
    }
    if ((c.evidence?.length ?? 0) === 0) {
      const tagged =
        taggedTokens.size > 0 && [...nameTokensForDrop(c.name)].some((t) => taggedTokens.has(t));
      if (tagged) {
        rescuedNames.push(c.name);
        kept.push(c);
        continue;
      }
      droppedNames.push(c.name);
      continue;
    }
    kept.push(c);
  }
  if (rescuedNames.length > 0) {
    const sample = rescuedNames.slice(0, 4).join(', ');
    const more = rescuedNames.length > 4 ? `, +${rescuedNames.length - 4} more` : '';
    log(
      `Kept ${rescuedNames.length} evidenceless character${rescuedNames.length === 1 ? '' : 's'} the prose still tags as a speaker (${sample}${more}) — verifier killed every quote but the dialogue tags prove they speak.`,
    );
  }
  if (droppedNames.length > 0) {
    const sample = droppedNames.slice(0, 4).join(', ');
    const more = droppedNames.length > 4 ? `, +${droppedNames.length - 4} more` : '';
    log(
      `Dropped ${droppedNames.length} character${droppedNames.length === 1 ? '' : 's'} with no surviving evidence (${sample}${more}) — verifier killed every attributed quote.`,
    );
  }
  return kept;
}

/* Persist a verify-pass's dropped entries to .audiobook/dropped-quotes.json.
   No-op when the pass had zero drops or when the book has no bookDir yet
   (e.g. uploaded but not confirmed) — the ledger lives next to cast.json
   so it needs the same disk anchor. Read-modify-write so concurrent
   subset-vs-main runs don't lose each other's batches; the file is
   append-only so the conflict window is narrow but real. */
export async function persistDroppedQuotesBatch(
  bookDir: string | undefined,
  manuscriptId: string,
  route: DroppedQuotesBatch['route'],
  verified: { entries: DroppedQuoteEntry[]; totalDropped: number; affectedCharacters: number },
): Promise<void> {
  if (!bookDir) return;
  if (verified.entries.length === 0) return;
  const file = await loadDroppedQuotes(bookDir, manuscriptId);
  const batch: DroppedQuotesBatch = {
    recordedAt: new Date().toISOString(),
    route,
    totalDropped: verified.totalDropped,
    affectedCharacters: verified.affectedCharacters,
    entries: verified.entries,
  };
  await saveDroppedQuotes(bookDir, appendBatch(file, batch));
}

/* Merge a per-chapter character list into a running roster keyed by id.
   Designed for Phase 0a, where each chapter call returns the characters
   that appear in that chapter (new + recurring) and the route accumulates
   them across the book.
   - Existing id → field-level merge:
     - description: longest-wins (more text usually = richer profile)
     - tone fields: latest-wins (the model has more context as it sees
       more chapters; later refinements supersede earlier guesses)
     - attributes: union, deduplicated
     - evidence: append non-duplicate quotes (dedup on normalised quote
       text so smart-vs-straight quote variants don't double up)
     - gender / ageRange / color: keep existing if already set; only adopt
       a new value when the existing entry doesn't have one (these are
       supposed to be stable from first detection).
   - New id → append the entry as-is.
   Mutates `roster` in place; returns nothing. Order of insertion of new
   characters reflects the order chapters were processed in. */
/* Build a schema-conformant cast entry for a speaker the roster-coverage guard
   recovered (stage-1 dropped them despite the prose tagging them). A dialogue
   tag IS a verbatim utterance, so detectionSource is the normal `'dialogue'` —
   characterSchema's enum is closed and strict, so the recovery is recorded in
   `description` (and a WARN log at the call site) rather than a bespoke source. */
function makeRecoveredCharacter(miss: MissingSpeaker): CharacterOutput {
  return {
    id: miss.id,
    name: miss.name,
    role: 'Speaker',
    color: miss.id,
    attributes: [],
    evidence: [],
    lines: 0,
    scenes: 0,
    detectionSource: 'dialogue',
    description: `Auto-recovered by the roster-coverage guard — stage-1 detection missed this tagged speaker (${miss.tagCount} dialogue tag${miss.tagCount === 1 ? '' : 's'}, e.g. ${miss.sampleTag}).`,
  };
}

/* Wrap a stage-1 detection call with the roster-coverage guard: validate the
   chapter's detected roster against its prose dialogue tags, retry detection on
   a miss (STAGE1_ROSTER_RETRIES, default 1), then auto-add any still-missing
   tagged speaker. `runningRoster` supplies the names/aliases of characters
   already on the book's roster so a returning speaker isn't re-flagged. Shared
   by the main Phase-0a loop and the subset-retry route. */
async function runStage1Guarded(opts: {
  body: string;
  runningRoster: CharacterOutput[];
  call: () => Promise<Stage1ChapterOutput>;
  log: (phaseId: number, message: string) => void;
  chapterId: number;
  language?: string;
}): Promise<Stage1ChapterOutput> {
  const retriesRaw = Number(process.env.STAGE1_ROSTER_RETRIES);
  const maxRetries = Number.isFinite(retriesRaw) ? Math.max(0, Math.trunc(retriesRaw)) : 1;
  const namesOf = (chars: Array<{ name: string; aliases?: string[] }>): string[] =>
    chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const runningNames = namesOf(opts.runningRoster);
  const { result } = await runStage1WithRosterGuard<CharacterOutput, Stage1ChapterOutput>({
    body: opts.body,
    rosterNamesFor: (r) => [...runningNames, ...namesOf(r.characters)],
    call: opts.call,
    makeCharacter: makeRecoveredCharacter,
    maxRetries,
    language: opts.language,
    onRetry: (attempt, verdict) =>
      opts.log(
        0,
        `Chapter ${opts.chapterId}: stage-1 missed tagged speaker(s) ${verdict.missingSpeakers
          .map((s) => s.name)
          .join(', ')} — retrying detection (attempt ${attempt}).`,
      ),
    onAutoAdd: (added) =>
      opts.log(
        0,
        `⚠ Chapter ${opts.chapterId}: roster-coverage guard auto-added ${added.length} missing speaker${
          added.length === 1 ? '' : 's'
        } (${added.map((s) => `${s.name}×${s.tagCount}`).join(', ')}) — stage-1 dropped them despite dialogue tags.`,
      ),
  });
  return result;
}

export function mergeRosterChapter(
  roster: Map<string, CharacterOutput>,
  fromChapter: CharacterOutput[],
): void {
  for (const incoming of fromChapter) {
    const existing = roster.get(incoming.id);
    if (!existing) {
      /* Defensive clone: callers shouldn't keep references into the cached
         per-chapter array, since the route mutates the merged copy via
         later passes (sortEvidence, verifyEvidenceAgainstSource). */
      roster.set(incoming.id, {
        ...incoming,
        attributes: incoming.attributes ? [...incoming.attributes] : undefined,
        aliases: incoming.aliases ? [...incoming.aliases] : undefined,
        evidence: incoming.evidence ? incoming.evidence.map((e) => ({ ...e })) : undefined,
        tone: incoming.tone ? { ...incoming.tone } : undefined,
      });
      continue;
    }
    mergeCharacterFields(existing, incoming);
  }
}

/* srv-1 — persist a fold pass's lineage to the merge journal. Replace-all keeps
   kind:'fold' entries in lockstep with the current manuscript-edits.json
   (manual entries are preserved). Co-locate the CALL with the edits write so the
   journal is persisted iff the sentences it describes are. Non-fatal at the call
   site. Exported for analysis.journal-lock.test.ts only. */
export async function writeFoldJournal(
  bookDir: string,
  rewrites: Record<string, string>,
  preFoldSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
): Promise<void> {
  /* Cast-locked: a manual merge appends to this journal under that lock, and the
     read -> replace -> write must not straddle it (#4031). */
  await withCastLock(bookDir, async () => {
    const journal = await loadCastMerges(bookDir);
    await saveCastMerges(
      bookDir,
      replaceFoldEntries(
        journal,
        buildFoldJournalEntries(rewrites, preFoldSentences, characters, new Date().toISOString()),
      ),
    );
  });
}

/* srv-1 — sibling of writeFoldJournal for the dedup pass. Replace-all keeps
   kind:'dedup' entries in lockstep with the current roster, preserving fold +
   manual entries. Same non-fatal-at-call-site contract. The pre-dedup roster +
   sentences are captured by dedupAndPrepare before the rewrite, so sourceName +
   affected sentences reflect the state the dedup collapsed. Exported for
   analysis.journal-lock.test.ts only. */
export async function writeDedupJournal(
  bookDir: string,
  rewrites: Record<string, string>,
  preDedupSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  preDedupRoster: ReadonlyArray<{ id: string; name: string }>,
): Promise<void> {
  /* Cast-locked, as writeFoldJournal (#4031). */
  await withCastLock(bookDir, async () => {
    const journal = await loadCastMerges(bookDir);
    await saveCastMerges(
      bookDir,
      replaceDedupEntries(
        journal,
        buildDedupJournalEntries(rewrites, preDedupSentences, preDedupRoster, new Date().toISOString()),
      ),
    );
  });
}

/* Run the dedup pass + apply its rewrites to the sentence stream, capturing the
   PRE-dedup roster + sentences for the journal — all in the order the spec
   mandates (dedup BEFORE fold). The caller feeds the returned `characters` +
   `sentences` into the existing foldMinorCast call, persists the journal from
   `preDedupSentences`/`preDedupRoster`, and composes `rewrites` with the fold's
   rewrites for the voice carry-forward remap. Tone fill is applied by the caller
   AFTER the fold (on the folded survivors), not here. Pure aside from no IO. */
export function dedupAndPrepare(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  language: string | undefined,
  constraints: DedupConstraints,
): {
  characters: CharacterOutput[];
  sentences: SentenceOutput[];
  rewrites: Record<string, string>;
  suggestions: StoredSuggestion[];
  preDedupSentences: { id: number; chapterId: number; characterId: string }[];
  preDedupRoster: { id: string; name: string }[];
  /** Plan 291 (#4031) - the dedup's `new`+`new` merges, for `rekeyPlanForMergedNew`. */
  mergedNew: MergedNewGroup[];
} {
  // Capture pre-dedup lineage BEFORE any rewrite (journal needs the original ids/names).
  const preDedupSentences = sentences.map((s) => ({
    id: s.id,
    chapterId: s.chapterId,
    characterId: s.characterId,
  }));
  const preDedupRoster = characters.map((c) => ({ id: c.id, name: c.name }));

  const dd = dedupeRosterByName(characters, sentences, { language, constraints });
  const rewrittenSentences = sentences.map((s) =>
    dd.rewrites[s.characterId] ? { ...s, characterId: dd.rewrites[s.characterId] } : s,
  );

  return {
    characters: dd.characters,
    sentences: rewrittenSentences,
    rewrites: dd.rewrites,
    suggestions: dd.suggestions,
    preDedupSentences,
    preDedupRoster,
    mergedNew: dd.mergedNew,
  };
}

/* Name-only descriptor fold for the live SSE cast-update payload ("Cast so
   far"). Collapses "The Jogger" / "Drooly Boy" / "Unknown Intruder" into the
   Unknown male / Unknown female buckets the moment they appear in a chapter's
   roster, so the user sees the same buckets they'd see post-Phase-1 instead of
   a churn of descriptor-named one-offs.

   No line-count rule and no zero-line drop — both need stage-2 data the
   verifier hasn't produced yet during Phase 0a, and applying them prematurely
   would drop legitimate characters who simply haven't been processed yet. The
   full fold runs at Phase 1's tail with sentence counts in hand. */
export function previewFoldForLiveView(
  characters: CharacterOutput[],
  language: string | undefined,
  constraints: DedupConstraints,
  protectIds?: ReadonlySet<string>,
): CharacterOutput[] {
  // Fix 1 — dedup by name BEFORE the fold (mirroring finalization order at
  // dedupAndPrepare) so the live "Cast so far" SSE and the interim cast.json
  // dedup consistently with the final cast. Empty sentences: the survivor id
  // never depends on line counts, so this agrees with the post-stage-2 call.
  const deduped = dedupeRosterByName(characters, [], { language, constraints }).characters;
  return foldMinorCast(deduped, [], { nameOnly: true, language, protectIds }).characters;
}

/* Plan 291 (#4031) - the Phase-0b series linker. It stamps only the `new` rows of
   the plan-applied roster: a joined row keeps the prior row's own link and is never
   re-linked. */
export async function linkSeriesReuseOnNewRows(
  bookId: string,
  characters: CharacterOutput[],
  plan: MatchPlan,
  options: LinkSeriesReuseOptions | undefined,
  prior: ReadonlyArray<PriorRow>,
): Promise<number> {
  /* A `new` row may be one of several candidates: it must not take a link any of them
     declined. The decline reaches the linker on a throwaway view of the row (its
     `notLinkedTo` guard), and only what the linker stamped is copied back, so the
     linker never writes the decline onto the row itself (the persist overlay records the
     cross-book declines on the added row).
     R46: the candidates' #3992 "Don't reuse" markers (`declinedVoiceFrom` /
     `declinedVoiceUuids`) reach the linker the same way, on the view only. */
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const declines = new Map<string, unknown[]>();
  const voiceDeclines = new Map<string, { from: Set<string>; uuids: Set<string> }>();
  for (const d of Object.values(plan.decisions)) {
    if (d.kind !== 'new') continue;
    declines.set(d.id, unionNotLinkedTo(declines.get(d.id), d.inheritedDeclines));
    const acc = voiceDeclines.get(d.id) ?? { from: new Set<string>(), uuids: new Set<string>() };
    for (const id of d.suggest) {
      const p = priorById.get(id) as Record<string, unknown> | undefined;
      for (const b of Array.isArray(p?.declinedVoiceFrom) ? p.declinedVoiceFrom : []) if (typeof b === 'string') acc.from.add(b);
      for (const u of Array.isArray(p?.declinedVoiceUuids) ? p.declinedVoiceUuids : []) if (typeof u === 'string') acc.uuids.add(u);
    }
    voiceDeclines.set(d.id, acc);
  }
  const targets = characters.filter((c) => declines.has(c.id));
  const views = targets.map((c) => {
    const own = c as { notLinkedTo?: unknown[]; declinedVoiceFrom?: unknown; declinedVoiceUuids?: unknown };
    const vd = voiceDeclines.get(c.id);
    const from = [...new Set([...(Array.isArray(own.declinedVoiceFrom) ? own.declinedVoiceFrom : []), ...(vd?.from ?? [])])];
    const uuids = [...new Set([...(Array.isArray(own.declinedVoiceUuids) ? own.declinedVoiceUuids : []), ...(vd?.uuids ?? [])])];
    return {
      ...c,
      notLinkedTo: unionNotLinkedTo(own.notLinkedTo, declines.get(c.id) ?? []),
      ...(from.length > 0 ? { declinedVoiceFrom: from } : {}),
      ...(uuids.length > 0 ? { declinedVoiceUuids: uuids } : {}),
    };
  });
  const linked = await linkSeriesReuseAtAnalysis(bookId, views as never, options);
  const viewOnly = new Set(['notLinkedTo', 'declinedVoiceFrom', 'declinedVoiceUuids']);
  targets.forEach((c, i) => {
    const row = c as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(views[i])) if (!viewOnly.has(k) && row[k] !== v) row[k] = v;
  });
  return linked;
}

/* Plan 291 (#4031) - a dedup merge of `new` rows re-keys the plan: each merged row's
   decision now lands on the survivor, and the survivor's decision takes the group's
   candidates and cross-book declines, so the plan's suggestion pairs follow the survivor
   and the persist overlays both onto one row. */
function rekeyPlanForMergedNew(plan: MatchPlan, groups: ReadonlyArray<MergedNewGroup>): MatchPlan {
  if (groups.length === 0) return plan;
  const decisions = { ...plan.decisions };
  for (const g of groups) {
    const merged = new Set(g.merged);
    for (const [raw, d] of Object.entries(decisions)) {
      if (d.kind !== 'new' || (d.id !== g.survivor && !merged.has(d.id))) continue;
      decisions[raw] = {
        ...d,
        id: g.survivor,
        suggest: [...new Set([...d.suggest, ...g.candidates])].filter((c) => c !== g.survivor),
        inheritedDeclines: unionNotLinkedTo(d.inheritedDeclines, g.inheritedDeclines) as typeof d.inheritedDeclines,
      };
    }
  }
  return { ...plan, decisions };
}

/* The questions the plan asks the user: one suggestion from each `new` row to each
   prior candidate it could be. The new row is the source, so accepting never folds an
   established character into a fresh one. */
function planSuggestionsFor(
  plan: MatchPlan,
  roster: ReadonlyArray<{ id: string; name?: string }>,
  prior: ReadonlyArray<PriorRow>,
): StoredSuggestion[] {
  const names = new Map<string, string>();
  for (const r of [...prior, ...roster]) names.set(r.id, typeof r.name === 'string' ? r.name : r.id);
  const out: StoredSuggestion[] = [];
  for (const d of Object.values(plan.decisions)) {
    if (d.kind !== 'new') continue;
    for (const candidate of d.suggest) {
      out.push({
        sourceId: d.id,
        targetId: candidate,
        ...pairKey(d.id, candidate),
        reason: `"${names.get(d.id) ?? d.id}" may be the same character as "${names.get(candidate) ?? candidate}"`,
        origin: 'plan',
        newRow: d.id,
        candidate,
      });
    }
  }
  return out;
}

/** What a job's cast-identity step hands back (`planRunCastIdentity`). */
interface PlannedCastIdentity {
  /** The plan-applied roster (R29: everything after speaks these ids). */
  characters: CharacterOutput[];
  /** For the plan-constrained dedup and the live-view fold. */
  constraints: DedupConstraints;
  protectIds: ReadonlySet<string>;
  /** Ids the snapshot re-minted (R8; item 12). */
  idMap: Record<string, string>;
  /** The subset job's own ledger and suggestion pairs after the snapshot (R2). */
  ownLedger: RunAddedLedger;
  ownAddedPairs: Array<[string, string]>;
}

/** The job's view of whose ledger is whose (R2). The main job's ledger is the
    cache's `addedRows`. The subset job keeps its OWN in-memory ledger (`own`) for
    the rows it adds, and the cache's `addedRows` (a stopped main run's ledger) is
    only refreshed for the rows it writes, never deleted by (invariant 6). */
type RunLedgers = { kind: 'main' } | { kind: 'subset'; own: RunAddedLedger; ownPairs: Array<[string, string]> };

/** A ledger patch of only what changed: the entries of `next` that differ from the job's
    copy `before`, and every `null`. Re-sending an unchanged entry would restore one a mid-run
    merge deleted from the cache file (`ledger: {[source]: null}`, cast-merge.ts) from the job's
    older copy (#4031 M5). The delta is for entries the run only carried: an entry for a row
    the persist itself wrote (`written`) is always sent (PR #4103 pass 4 P4-1), because the
    job's copy is no base for it - the persist's own patch, or a route, has moved the file
    since, and an entry that equals the copy would otherwise be dropped (by `clearLedger`
    in the same op, or by the merge's delete). The same principle as R54's decisions base.
    R55 (PR #4103 pass 5): a merge is refused while a registered job runs, so the mid-run
    merge both halves guard against is defence in depth. */
function ledgerDelta(
  before: RunAddedLedger,
  next: Readonly<Record<string, LedgerEntry | null>>,
  written: ReadonlySet<string> = new Set(),
): Record<string, LedgerEntry | null> {
  const out: Record<string, LedgerEntry | null> = {};
  for (const [id, entry] of Object.entries(next)) {
    if (entry === null || written.has(id) || JSON.stringify(before[id]) !== JSON.stringify(entry)) out[id] = entry;
  }
  return out;
}

/** The rows a persist wrote: on the roster it persisted, not merely carried forward. */
function persistWrittenIds(out: { characters: ReadonlyArray<{ id: string }>; carriedForward: ReadonlyArray<{ id: string }> }): Set<string> {
  const carried = new Set(out.carriedForward.map((c) => c.id));
  return new Set(out.characters.map((c) => c.id).filter((id) => !carried.has(id)));
}

/** R4 at a COMPLETED subset persist (R35a, R35b): `added-once` for the rows the run's own
    result keeps - written by this persist, not carried forward (a row carried only because
    invariant 6 bars the subset from deleting it stays `run-owned`):
    - its own rows, and any own row the overlay already made `added-once` (a user edit or a
      mid-run delete, a degraded history's included - main's R4 predicate);
    - another run's `run-owned` row a SUBSET wrote (`by: 'subset'`, a stopped attempt's), so a
      resumed subset equals an uninterrupted one (acceptance 14).
    A stopped MAIN run's rows (no tag) are left as the persist refreshed them (R38). The own
    and other-runs keys are disjoint by construction (`otherRunsLedger`). */
export function subsetCompletedAddedOnce(out: {
  characters: ReadonlyArray<{ id: string }>;
  carriedForward: ReadonlyArray<{ id: string }>;
  ledger: RunAddedLedger;
  mainLedger?: RunAddedLedger;
}): RunAddedLedger {
  const written = persistWrittenIds(out);
  const res: RunAddedLedger = {};
  for (const [id, e] of Object.entries(out.ledger)) {
    if (e.state === 'added-once' || written.has(id)) res[id] = { state: 'added-once' };
  }
  for (const [id, e] of Object.entries(out.mainLedger ?? {})) {
    if (e.state === 'run-owned' && e.by === 'subset' && written.has(id)) res[id] = { state: 'added-once' };
  }
  return res;
}

/** R35a/R35b: at a subset snapshot, the rows the subset added go into the cache ledger as its
    own ledger holds them (`run-owned` with the fingerprint of its write, tagged `by: 'subset'`),
    so a later run reusing the cached plan knows each as a run row (no `-n1` re-mint) and, if
    the subset stops, the next main persist may still fold-drop one the user left untouched
    (rule 11) while a resumed subset converts one it keeps. Own keys never collide with
    another run's entry: `otherRunsLedger` strips them from the other side. */
function subsetOwnEntries(own: RunAddedLedger): RunAddedLedger {
  return Object.fromEntries(
    Object.entries(own).map(([id, e]): [string, LedgerEntry] => [id, e.state === 'run-owned' ? { ...e, by: 'subset' } : e]),
  );
}

/** The cache's ledger as the OTHER runs' entries (`mainLedger`): the subset's own rows are
    tracked by its own ledger, never refreshed as another run's (R35a). Its keys and `own`'s
    are disjoint. */
export function otherRunsLedger(cacheLedger: RunAddedLedger, own: RunAddedLedger): RunAddedLedger {
  return Object.fromEntries(Object.entries(cacheLedger).filter(([id]) => !Object.hasOwn(own, id)));
}

/** An interim cast.json snapshot of a PLAN-APPLIED roster, and the cache patch that
    follows it (shared by the main job's Phase 0b and both of the subset job's
    snapshots). The roster is written unfolded, with palette colours and the
    narrator identity (as the persist's roster carries it: the snapshot is the row's
    first write, and the persist keeps a run row's user-owned fields from disk); a
    row in `placeholderIds` - a `new` row not yet on disk - gets the lines/scenes
    placeholders. Any other row keeps its counts on disk: lines/scenes are
    analysis-owned, so an explicit 0 here would zero a joined row's, or the counts a
    completed main run persisted for its own rows (#4031 I1). A failed snapshot is a
    deliberate swallow (#2292, owner decision, a lock timeout included): the ids are
    already in the cache, and the persist re-plans whatever it did not land - except a
    damaged cast.json (`PriorCastUnreadableError`), which ends the run (R2-M3). With
    `bestEffortPatch` (the subset's Phase-0a snapshots, which run inside a chapter's
    failure handling), a failed cache patch after the snapshot landed is logged, not
    thrown - the chapter's own cast must not be recorded as failed over it (#4031
    M8a) - and handed back as `unsentPatch`. The caller re-sends it once before its
    next cache write or exit (N2): it can carry a re-mint (decisions and the takes'
    remap) that no later patch repeats.
    Mutates `cache` (plan, ledgers, takes) to match what it patched; returns the
    roster with any re-mint applied. */
async function snapshotPlannedRoster(a: {
  job: AnalysisJob;
  bookId: string | undefined;
  bookLanguage: string;
  cache: AnalysisCache;
  prior: ReadonlyArray<PriorRow>;
  plan: MatchPlan;
  characters: CharacterOutput[];
  ledgers: RunLedgers;
  runSuggestions: (roster: ReadonlyArray<{ id: string; name?: string }>) => StoredSuggestion[];
  placeholderIds: ReadonlySet<string>;
  bestEffortPatch?: boolean;
  site: string;
}): Promise<{
  characters: CharacterOutput[];
  plan: MatchPlan;
  idMap: Record<string, string>;
  ledgers: RunLedgers;
  /** With `bestEffortPatch`: the cache patch that faulted, for the caller to re-send. */
  unsentPatch?: CachePatch;
}> {
  const { job, cache } = a;
  let { plan, characters, ledgers } = a;
  const snapshot = applyNarratorIdentity(assignPaletteColors(characters), a.bookLanguage).map((c) =>
    a.placeholderIds.has(c.id) ? { ...c, lines: c.lines ?? 0, scenes: c.scenes ?? 0 } : c,
  );
  const out: { s?: Awaited<ReturnType<typeof writePlanSnapshot>> } = {};
  try {
    await withVerifiedBookDir(
      { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
      async (dir) => {
        out.s = await writePlanSnapshot({
          bookDir: dir,
          bookId: a.bookId,
          roster: snapshot,
          plan,
          runSuggestions: a.runSuggestions(snapshot),
          ...(ledgers.kind === 'main'
            ? { ledger: cache.addedRows ?? {} }
            : { ledger: ledgers.own, mainLedger: otherRunsLedger(cache.addedRows ?? {}, ledgers.own) }),
        });
      },
    );
  } catch (persistErr) {
    /* #4031 R2-M3 — a damaged cast.json is not a snapshot fault the persist can fix: it
       will refuse it too. End the run here (curated `cast-unreadable`) rather than
       running all of Phase 1 first. Nothing was written to the damaged file. */
    if (persistErr instanceof PriorCastUnreadableError) throw persistErr;
    console.warn(`[analysis] ${a.site} cast.json snapshot failed`, persistErr);
  }
  if (!out.s) return { characters, plan, idMap: {}, ledgers };
  const s = out.s;
  plan = s.plan;
  const remint = Object.keys(s.idMap).length > 0;
  if (remint) {
    characters = characters.map((c) => (Object.hasOwn(s.idMap, c.id) ? { ...c, id: s.idMap[c.id] } : c));
    for (const [k, takes] of Object.entries(cache.chapters)) {
      cache.chapters[Number(k)] = remapSentenceIds(takes, s.idMap);
    }
  }
  cache.matchPlan = plan;
  let ledgerPatch: CachePatch = {};
  const ledgerBefore = cache.addedRows ?? {};
  if (ledgers.kind === 'main') {
    cache.addedRows = s.ledger;
    const seen = new Set((cache.runAddedPairs ?? []).map(([x, y]) => `${x}\u0000${y}`));
    cache.runAddedPairs = [
      ...(cache.runAddedPairs ?? []),
      ...s.addedPairs.filter(([x, y]) => !seen.has(`${x}\u0000${y}`)),
    ];
    ledgerPatch = { ledger: ledgerDelta(ledgerBefore, s.ledger), runAddedPairs: s.addedPairs };
  } else {
    /* The subset's own rule-11 ledger stays in memory; the main run's entries it
       touched are refreshed in the cache (compare-then-refresh, invariant 6). R35a: each
       row the subset added is also recorded in the cache as its own ledger holds it
       (`run-owned`, fingerprinted), so a later run reusing the cached plan (a main
       resume, a second subset) knows its `new` decision's live row as a run row and
       re-mints no `-n1` duplicate; if this run stops, the next main persist may still
       fold-drop it when untouched. */
    const seen = new Set(ledgers.ownPairs.map(([x, y]) => `${x}\u0000${y}`));
    ledgers = {
      kind: 'subset',
      own: s.ledger,
      ownPairs: [...ledgers.ownPairs, ...s.addedPairs.filter(([x, y]) => !seen.has(`${x}\u0000${y}`))],
    };
    const cacheLedger = ledgerDelta(ledgerBefore, {
      ...(s.mainLedger ?? {}),
      ...subsetOwnEntries(s.ledger),
    }) as RunAddedLedger;
    if (Object.keys(cacheLedger).length > 0) {
      cache.addedRows = { ...ledgerBefore, ...cacheLedger };
      ledgerPatch = { ledger: cacheLedger };
    }
  }
  /* Only the decisions the snapshot re-minted: the rest are already on disk from the
     plan's own patch, and re-sending them would revert a merge's re-target
     (cast-merge.ts) that landed in between. R8 - the re-mint's id map goes to the
     cached takes in the same op. */
  const remintedIds = new Set(Object.values(s.idMap));
  const reminted = Object.fromEntries(
    Object.entries(plan.decisions).filter(([, d]) => d.kind === 'new' && remintedIds.has(d.id)),
  );
  const patch: CachePatch = { ...ledgerPatch, ...(remint ? { decisions: reminted, remapCharacterIds: s.idMap } : {}) };
  let unsentPatch: CachePatch | undefined;
  if (Object.keys(patch).length > 0) {
    let written: AnalysisCache | null = null;
    try {
      written = await mutateAnalysisCache(job.manuscriptId, patch);
    } catch (patchErr) {
      if (!a.bestEffortPatch) throw patchErr;
      console.warn(`[analysis] ${a.site} cache patch failed (the job re-sends it before its next write or exit)`, patchErr);
      unsentPatch = patch;
    }
    /* ...and the job's cached copy takes the plan as written, so it matches the
       file, re-target included (a copy: the returned payload is the live one). The
       caller's constraints keep the plan this roster was built from. */
    if (written?.matchPlan) cache.matchPlan = structuredClone(written.matchPlan);
  }
  return { characters, plan, idMap: s.idMap, ledgers, ...(unsentPatch ? { unsentPatch } : {}) };
}

/* ── Plan 291 (#4031): a job's one cast-identity decision, shared by the main job
   (Phase 0b, or a cache-hit resume) and the subset job's flow (a) finalise. Called
   with the raw stage-1 roster BEFORE Phase 1 sees a roster, so no take is ever made
   in raw id space. In order:
     1. plan (`matchFreshToPrior`; a cached plan is REUSED and only the rows it does
        not cover are `extendPlan`ned, so one analyzer row never gets two cast rows);
     2. apply it (R29: everything after speaks plan-applied ids);
     3. link new rows only (honouring the plan's inherited declines);
     4. patch the cache - the RAW roster stays in `stage1`, the plan header and its
        decisions are stored beside it (R20: separate fields, full decisions);
     5. snapshot the unfolded plan-applied roster with the plan's suggestions, and
        patch the ledger(s) and any re-mint (`snapshotPlannedRoster`).
   Mutates `cache` to match what it patched. */
async function planRunCastIdentity(a: {
  job: AnalysisJob;
  record: { bookId?: string | null; bookDir?: string | null };
  bookLanguage: string;
  cache: AnalysisCache;
  prior: PriorRow[];
  raw: CharacterOutput[];
  log: (phaseId: number, message: string) => void;
  /** The subset job's own ledger (R2); absent for the main job. */
  ownLedger?: { own: RunAddedLedger; ownPairs: Array<[string, string]> };
}): Promise<PlannedCastIdentity> {
  const { job, record, cache, prior, raw, log } = a;
  const bookDir = record.bookDir ?? undefined;
  const currentBookId = record.bookId ?? undefined;
  const history = toMatchHistory(
    bookDir
      ? await loadCastIdHistoryWithStatus(bookDir)
      : { status: 'absent', history: { schema: 1, supersededBy: {} } },
  );
  let openSuggestions: StoredSuggestion[] = [];
  if (bookDir) {
    try {
      openSuggestions = await loadStoredSuggestions(bookDir);
    } catch (err) {
      // Unreadable: no open questions to land on (a row is then only a new one). Server-side only.
      console.warn(`[analysis] planned without the open suggestions - they could not be read: ${(err as Error)?.message ?? err}`);
    }
  }
  const input = {
    fresh: raw.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    prior,
    history,
    openSuggestions,
    reservedIds: buildReservedIds({ prior, history, plan: cache.matchPlan }),
    runToken: randomBytes(4).toString('hex'),
    currentBookId,
  };
  /* The decisions the run held before it planned: for the subset job, rows of the
     run that produced its other chapters, already on disk with their counts. */
  const decidedBefore = new Set(Object.keys(cache.matchPlan?.decisions ?? {}));
  let plan: MatchPlan;
  if (cache.matchPlan) {
    const uncovered = input.fresh.filter((r) => !Object.hasOwn(cache.matchPlan!.decisions, r.id));
    plan = uncovered.length > 0 ? extendPlan(cache.matchPlan, { ...input, fresh: uncovered }) : cache.matchPlan;
  } else {
    plan = matchFreshToPrior(input);
  }
  let characters = applyMatchPlan(raw, plan, prior).characters;

  if (record.bookId) {
    try {
      const linked = await linkSeriesReuseOnNewRows(record.bookId, characters, plan, undefined, prior);
      if (linked > 0) {
        log(
          0,
          `Linked ${linked} recurring character${linked === 1 ? '' : 's'} to prior books in this series (Reused).`,
        );
      }
    } catch (linkErr) {
      console.warn('[analysis] series reuse-link pass failed', linkErr);
    }
  }

  cache.matchPlan = plan;
  /* Only the decisions this call added (PR #4103 pass 1 O2): a reused decision is already
     in the cache, where a merge made since the job loaded it may have re-targeted it
     (`retargetPlanForMerge`); re-sending the in-memory copy would undo that. */
  await mutateAnalysisCache(job.manuscriptId, {
    stage1: cache.stage1,
    matchPlan: { version: plan.version, runToken: plan.runToken },
    decisions: Object.fromEntries(Object.entries(plan.decisions).filter(([raw]) => !decidedBefore.has(raw))),
  });

  let idMap: Record<string, string> = {};
  let ledgers: RunLedgers = a.ownLedger ? { kind: 'subset', ...a.ownLedger } : { kind: 'main' };
  if (bookDir) {
    const snap = await snapshotPlannedRoster({
      job,
      bookId: currentBookId,
      bookLanguage: a.bookLanguage,
      cache,
      prior,
      plan,
      characters,
      ledgers,
      runSuggestions: (roster) => planSuggestionsFor(plan, roster, prior),
      /* Main job: every `new` row (as before). Subset job: only the `new` rows this
         call added - a reused decision's row is already on disk with its counts
         (I1: a completed main run's row must not be zeroed if no persist follows). */
      placeholderIds: new Set(
        Object.entries(plan.decisions).flatMap(([raw, d]) =>
          d.kind === 'new' && (!a.ownLedger || !decidedBefore.has(raw)) ? [d.id] : [],
        ),
      ),
      site: a.ownLedger ? 'subset finalise' : 'Phase-0b',
    });
    ({ characters, idMap, ledgers } = snap);
    plan = snap.plan;
  }

  return {
    characters,
    constraints: planConstraintsFor({ roster: characters, plan, prior, history, currentBookId }),
    protectIds: planProtectIdsOf(plan),
    idMap,
    ownLedger: ledgers.kind === 'subset' ? ledgers.own : {},
    ownAddedPairs: ledgers.kind === 'subset' ? ledgers.ownPairs : [],
  };
}

/* Plan 291 (#4031) — `persistPlannedCast`'s arguments, shared by both jobs. The plan is
   the run's cached plan with each dedup-merged `new` row's decision moved onto its
   survivor. The suggestions are the plan's questions and the dedup's refused pairs (in
   roster ids: the dedup ran on plan-applied ids), each pruned against the persisted cast
   inside; a drift-refused persist keeps none. The ledgers follow R2: the main job's is the
   cache's `addedRows`; the subset job passes its own in-memory ledger and pairs, and the
   cache's `addedRows` as the other job's (`mainLedger`), refreshed for the rows it writes
   and never deleted by (invariant 6). */
function plannedPersistArgs(a: {
  writeDir: string;
  bookId: string | undefined;
  cache: AnalysisCache;
  dd: ReturnType<typeof dedupAndPrepare>;
  roster: CharacterOutput[];
  sentences: SentenceOutput[];
  prior: PriorRow[];
  ledgers: RunLedgers;
}): (driftRefused: boolean) => Parameters<typeof persistPlannedCast>[0] {
  const plan = rekeyPlanForMergedNew(
    a.cache.matchPlan ?? { version: 1, runToken: randomBytes(4).toString('hex'), decisions: {} },
    a.dd.mergedNew,
  );
  return (driftRefused) => ({
    bookDir: a.writeDir,
    bookId: a.bookId,
    plan,
    roster: a.roster,
    sentences: a.sentences,
    runSuggestions: driftRefused
      ? []
      : [...planSuggestionsFor(plan, a.roster, a.prior), ...pruneSuggestionsToRoster(a.dd.suggestions, a.roster)],
    driftRefused,
    ...(a.ledgers.kind === 'main'
      ? { ledger: a.cache.addedRows ?? {}, runAddedPairs: a.cache.runAddedPairs ?? [] }
      : {
          ledger: a.ledgers.own,
          runAddedPairs: a.ledgers.ownPairs,
          mainLedger: otherRunsLedger(a.cache.addedRows ?? {}, a.ledgers.own),
        }),
  });
}

/* Plan 291 (#4031) — one planned persist, classified the same way for both jobs:
   - a `LockAcquisitionTimeoutError` from its cast lock wrote nothing: returned as
     `lockTimeout`, for the caller to park (its remaining writes, state.json, still run
     before the deferred rethrow; #2260 C1, #2295);
   - an edits-write failure AFTER cast.json landed carries the computed outcome
     (`PersistOutcomeError`): returned as `outcome` + `editsWriteErr`, so the caller still
     records the retirements and the cache patch, then hands the error to
     `catch (persistErr)` (server-side only: an fs error names an absolute path). A
     drift-refused persist wrote no cast.json, so its edits failure is just rethrown;
   - any other throw wrote nothing and is rethrown.
   #4031 R48 — the caller parks every one of these (`parkPersistFailure`) rather than
   letting `catch (persistErr)` report success over an unwritten book. */
async function runPlannedPersist(
  args: Parameters<typeof persistPlannedCast>[0],
): Promise<{ outcome?: PersistOutcome; editsWriteErr?: unknown; lockTimeout?: unknown }> {
  try {
    return { outcome: await persistPlannedCast(args) };
  } catch (castErr) {
    if (isLockAcquisitionTimeout(castErr)) return { lockTimeout: castErr };
    const carried = (castErr as PersistOutcomeError | null)?.persistOutcome;
    if (carried && !args.driftRefused) return { outcome: carried, editsWriteErr: castErr };
    throw castErr;
  }
}

/* #4031 R48 — an AUTHORITATIVE persist write failed (the planned cast.json persist, its
   edits write, the terminal state.json record). The raw error is logged here, server-side
   only; what is returned is what the job parks and rethrows after its remaining writes
   (the deferred rethrow): a refused damaged cast.json as it is (its message is curated
   already), anything else wrapped in `AnalysisPersistError`, whose message is fixed and
   path-free. A lock timeout never comes here: it has its own slot (`persistLockTimeout`). */
function parkPersistFailure(tag: string, writeDir: string, err: unknown): unknown {
  console.error(`${tag} failed to persist .audiobook/* for`, writeDir, err);
  return err instanceof PriorCastUnreadableError ? err : new AnalysisPersistError(err);
}

/* Plan 291 (#4031) — what a landed planned persist owes, shared by both jobs, in order:
   1. one cache op: the persist's own decisions (the rows it planned, its re-mints; Q2:
      every post-0b decision is saved), `remapCharacterIds` for a re-mint, and the job's
      `ledgerPatch`;
   2. AFTER the cast lock is released, the plan's join retirements (`raw -> target`,
      tagged `analyzer`, each target re-resolved through the history the persist re-read;
      never one whose raw id is live or already a `supersededBy` key, never the narrator's
      join; a degraded history records none), then the two `dropSuperseded*` prunes and
      the reject-edge heal, all against the roster just persisted;
   3. the operator log of the voiced rows carried forward.
   A throwing history write never skips the caller's state.json: a lock-acquisition
   timeout is RETURNED (`parked`) for the caller to park and rethrow after its remaining
   writes (#2260 round 2/3 - thrown from here it would skip state.json and land in
   `catch (persistErr)`, which reports success); anything else is logged. A faulted cache
   op is returned as `unsentPatch` (see step 1's comment). */
/** The persist's decisions as a cache-op transform, so they are merged against the FILE's
    plan inside the op (PR #4103 pass 1 O2): a merge that landed after the job loaded its
    plan re-targeted the file's decision to `tier: 'merge'`, and the persist's copy never
    overwrites that. A decision the file already holds is not re-written. The `new`
    decisions of the run rows the persist dropped (`droppedIds`, fold-dropped and untouched)
    go with their rows (PR #4103 pass 1 F3): left in the plan, a later subset's Phase-0a
    snapshot would read the row as decided and write it back with 0 lines.
    R54 (PR #4103 pass 4): `base` is the job's own copy of the plan, the one it started
    from and last saved. A decision the persist left as `base` holds it, and which the file
    no longer holds, was deleted by a route during the run (a fold-bucket merge, P2-1 (a))
    and stays deleted: re-adding it would make every later run on the cache re-apply it.
    A decision this persist added or changed is still sent. R55 (PR #4103 pass 5): that
    route is refused while a registered job runs, so this is defence in depth. */
export function persistDecisionsTransform(
  decisions: Readonly<Record<string, MatchDecision>>,
  droppedIds: ReadonlyArray<string> = [],
  base?: Readonly<Record<string, MatchDecision>>,
): (c: AnalysisCache) => AnalysisCache {
  const dropped = new Set(droppedIds);
  const isDropped = (d: MatchDecision | undefined): boolean => d?.kind === 'new' && dropped.has(d.id);
  return (c) => {
    if (!c.matchPlan) return c;
    const onFile = c.matchPlan.decisions;
    const changed = Object.entries(decisions).filter(([k, d]) => {
      const f = onFile[k];
      if (f?.kind === 'join' && f.tier === 'merge') return false;
      if (isDropped(d)) return false;
      if (f === undefined && base && Object.hasOwn(base, k) && JSON.stringify(base[k]) === JSON.stringify(d)) return false;
      return JSON.stringify(f) !== JSON.stringify(d);
    });
    const gone = Object.keys(onFile).filter((k) => isDropped(onFile[k]));
    if (changed.length === 0 && gone.length === 0) return c;
    const next = { ...onFile, ...Object.fromEntries(changed) };
    for (const k of gone) delete next[k];
    return { ...c, matchPlan: { ...c.matchPlan, decisions: next } };
  };
}

async function applyPlannedPersistOutcome(a: {
  out: PersistOutcome;
  cache: AnalysisCache;
  manuscriptId: string;
  ledgerPatch: Record<string, LedgerEntry | null>;
  writeDir: string;
  retirementBookId: ReturnType<typeof bookIdForRetirementCleanup>;
  bookId: string | undefined;
  historyStatusBeforePersist: Awaited<ReturnType<typeof loadCastIdHistoryWithStatus>>['status'];
  log: (phaseId: number, message: string) => void;
}): Promise<{ parked: unknown; unsentPatch?: CachePatch }> {
  const { out, cache, writeDir, retirementBookId, log } = a;
  const withDecisions = persistDecisionsTransform(out.plan.decisions, out.droppedRunAdded, cache.matchPlan?.decisions);
  const idMap = Object.fromEntries(Object.entries(out.idMap).filter(([k, v]) => k !== v));
  if (cache.matchPlan) Object.assign(cache, withDecisions(cache));
  /* #4031 (I2) — cast.json and the edits have landed: a cache fault here (ENOSPC, EPERM, a
     rename whose retries ran out) is logged and the persist carries on, as
     `patchCacheInFailureCatch` does, so the retirements and the caller's state.json still
     land. The patch is handed back as `unsentPatch` and the caller re-sends it once, at
     the end of its persist (N2): it is the only write of the persist's decisions and, in
     the subset job, of its ledger (R35). If the re-send fails too, the cache lacks them:
     the next run re-plans a row it does not cover against the live cast (it joins that
     row), and the row is no longer known as the run's own (rule 11). */
  const patch: CachePatch = {
    ledger: a.ledgerPatch,
    ...(cache.matchPlan ? { transform: withDecisions } : {}),
    ...(Object.keys(idMap).length > 0 ? { remapCharacterIds: idMap } : {}),
  };
  let unsentPatch: CachePatch | undefined;
  try {
    await mutateAnalysisCache(a.manuscriptId, patch);
  } catch (cacheErr) {
    console.warn('[analysis] could not patch the analysis cache after the persist (re-sent at the end of the persist)', cacheErr);
    unsentPatch = patch;
  }
  let parked: unknown;
  try {
    /* Wave 2 final-review finding 1(b) — every retirement is filtered against the
       roster that was just persisted. */
    const liveIds = out.characters.map((c) => c.id);
    await recordRetirements(writeDir, retirementBookId, out.retirements, liveIds, log, 'analyzer');
    /* #2040 Task 14, spec §4.4 closing paragraph — resolution is exact-id-first, so a
       history entry keyed to an id this write just reintroduced as live would silently
       lose to it (no tie, no warning). Drop it here, last, so it can't survive past the
       same write cycle that reintroduced the live row. The dropped entries are reported
       so a future banner can flag their segments as needs-your-decision (§4.6, Wave 3). */
    /* R53 (PR #4103 pass 4): a live fold bucket reclaims its id like any row, so a legacy
       `unknown-* -> X` entry (a bucket merge recorded by `main` or by this release's
       earlier commits; a merge of a bucket records nothing now) moves to `displaced`, as
       on `main`. Nothing followed it in the meantime (`followableHistory`). */
    const displacedByReclaim = await dropSupersededIdsReclaimedByLiveCast(writeDir, liveIds);
    /* #2040 Task 14 review item 2a — operator-visible. The dropped pairs are also
       persisted (item 2b, cast-id-history.ts's `displaced`), so this line is a
       heads-up, not the only record. */
    if (displacedByReclaim.length) {
      log(
        1,
        `Dropped ${displacedByReclaim.length} history alias(es) superseded by a re-minted live id (${displacedByReclaim
          .map((d) => `${d.id} -> ${d.supersededBy}`)
          .join(', ')}) — affected segments need review.`,
      );
    }
    /* #2110 — the mirror-image drop: an entry whose TARGET (not key) has quietly
       stopped being live. Pruned against this exact just-persisted roster, same as the
       reclaim drop above. */
    const displacedByDeadTarget = await dropSupersededTargetsNoLongerLive(writeDir, liveIds);
    if (displacedByDeadTarget.length) {
      log(
        1,
        `Dropped ${displacedByDeadTarget.length} history alias(es) whose target no longer exists (${displacedByDeadTarget
          .map((d) => `${d.id} -> ${d.supersededBy}`)
          .join(', ')}) — affected segments need review.`,
      );
    }
    /* #2166 — heal any reject whose two writes came apart, against this exact
       just-persisted roster. Best-effort; see the helper's own doc comment.
       `historyStatusBeforePersist` is the caller's pre-rewrite verdict, captured before
       the persist (the steps above launder a degraded file into a valid empty one). */
    const healed = await reconcileRejectEdgesOnDisk(writeDir, retirementBookId, log, a.historyStatusBeforePersist);
    /* Plan 291 (#4031, Task 27 F2) — the heal is this run's own write of the rows it
       touched, so a `run-owned` entry it changed takes the fingerprint of what it wrote
       (rule 11, compare-then-refresh); otherwise the next run reads the edge as a user
       edit and keeps a row it should fold-drop. The cache patch runs after the cast lock
       is released; a fault joins `unsentPatch`. */
    if (healed) {
      /* Against the cache's ledger as it stands inside the op, not the persist's patch (which
         names only the entries it changed). */
      const heal: CachePatch = {
        transform: (c) => ({
          ...c,
          addedRows: refreshLedger(c.addedRows ?? {}, healed.before as PriorRow[], healed.after as PriorRow[]),
        }),
      };
      /* An already-unsent persist patch carries the older fingerprints: fold into it (the
         transform runs last), so its re-send cannot roll this refresh back. */
      if (unsentPatch) {
        /* Composed, not overwritten: a transform already on the unsent patch still runs first. */
        const prev = unsentPatch.transform;
        const healT = heal.transform!;
        unsentPatch = { ...unsentPatch, transform: async (c) => healT(prev ? await prev(c) : c) };
      } else {
        try {
          await mutateAnalysisCache(a.manuscriptId, heal);
        } catch (cacheErr) {
          console.warn('[analysis] could not refresh the ledger after the reject-edge heal (re-sent at the end of the persist)', cacheErr);
          unsentPatch = heal;
        }
      }
    }
  } catch (historyErr) {
    if (isLockAcquisitionTimeout(historyErr)) {
      parked = historyErr;
    } else {
      console.warn('[analysis] failed to record character-id retirement(s)', historyErr);
      /* #2214/#2201 — a degraded cast-id-history.json makes the unconditional
         `dropSupersededIdsReclaimedByLiveCast` call above throw before
         `reconcileRejectEdgesOnDisk` is ever reached, so emit the same user-facing
         wording here. */
      logIfDegradedCastIdHistory(historyErr, log);
    }
  }
  const carriedIds = new Set(out.carriedForward.map((c) => c.id));
  await logCarriedForwardCharacters(
    a.bookId,
    writeDir,
    voicedSurvivorsDropped(out.characters.filter((c) => carriedIds.has(c.id)) as never, []),
  );
  return { parked, ...(unsentPatch ? { unsentPatch } : {}) };
}

/* Rule 13 for the cache: the takes follow a completed persist's reroute of lines a
   deleted plan target held to the narrator, applied to the cache on disk inside the op so
   a merge's rewrite of the takes is not reverted. The cache's own id space: its other
   narrator takes say 'narrator' too (the persisted narrator id, e.g. `char-narrator`, is
   applied only at the persist). */
function rerouteDeletedTakesPatch(persisted: PersistOutcome | undefined): Pick<CachePatch, 'transform'> {
  const deleted = new Set(persisted?.deletedTargets ?? []);
  if (deleted.size === 0) return {};
  return {
    transform: (c) => ({
      ...c,
      chapters: Object.fromEntries(
        Object.entries(c.chapters).map(([k, ss]) => [k, rerouteDeletedTargets(ss, deleted, 'narrator')]),
      ),
    }),
  };
}

/* Stage 1 doesn't know per-sentence counts. Compute lines (sentences spoken)
   and scenes (distinct chapters appeared in) from stage 2 output once we
   have it, and attach to each character. */
function attachLinesAndScenes(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
): CharacterOutput[] {
  const lines = new Map<string, number>();
  const scenes = new Map<string, Set<number>>();
  for (const s of sentences) {
    lines.set(s.characterId, (lines.get(s.characterId) ?? 0) + 1);
    let set = scenes.get(s.characterId);
    if (!set) {
      set = new Set();
      scenes.set(s.characterId, set);
    }
    set.add(s.chapterId);
  }
  return characters.map((c) => ({
    ...c,
    lines: lines.get(c.id) ?? 0,
    scenes: scenes.get(c.id)?.size ?? 0,
  }));
}

export const analysisRouter = Router();

/* Keep aligned with src/data/analysis-phases.ts ANALYSIS_PHASES. */
const PHASES = [
  { id: 0, label: 'Detecting characters', durationMs: 0 }, // handoff stage 1
  { id: 1, label: 'Parsing and attribution', durationMs: 0 }, // handoff stage 2
  { id: 2, label: 'Matching library', durationMs: 250 },
];

/* Book id from a title — delegates to the shared `safeBookId` (plan 219):
   byte-identical for ASCII titles, but a non-Latin title is preserved instead
   of collapsing to the literal `book`. Only a fallback for `record.bookId`. */
function bookIdFromTitle(title: string): string {
  return safeBookId(title);
}

/* M6 (fix round, #2163) — `recordRetirements`'s `bookId` parameter exists
   for exactly one purpose: keying `clearNotLinkedEdgesForDroppedRejections`'s
   lookup against `notLinkedTo` edges on `cast.json`, which are written with
   the workspace `makeBookId` shape (`author__series__title`,
   `workspace/paths.js`). `bookIdFromTitle` above — a 32-char kebab slug of
   the title alone — produces a completely different shape, so using it as
   a fallback here can never match a real edge; it only manufactures a value
   that LOOKS like a book id without being the one anything else uses. Every
   `recordRetirements` call site in this file used to fall back to it via
   `record.bookId ?? bookIdFromTitle(record.title)`, which fails OPEN: the
   call proceeds with a bookId that silently can never match, so any
   self-loop-rejection cleanup that run needed simply never happens, with
   nothing logged. Not reachable today — `loadManuscriptForBook` always sets
   `record.bookId` — but a param that exists for one narrow purpose should
   not accept a value that defeats that purpose without saying so.
   `recordRetirements` already has the right fail-closed behaviour built in
   (`if (result.droppedSelfLoopRejections.length && bookId)` skips the
   cleanup when `bookId` is falsy) — this helper's job is only to stop
   handing it a value that looks truthy but is wrong, and to say so when it
   would have. Deliberately does NOT derive a new id shape of its own. */
export function bookIdForRetirementCleanup(record: {
  bookId?: string | null;
  title: string;
}): string | undefined {
  if (record.bookId) return record.bookId;
  console.warn(
    `[analysis] record.bookId is absent for "${record.title}" — skipping notLinkedTo cleanup for any ` +
      `character-id retirement this run records (a title-derived id would never match a real notLinkedTo ` +
      `edge's book id, so silently using one would fail without saying so).`,
  );
  return undefined;
}

function durationPlaceholder(): string {
  return '00:00';
}

/* Heuristic ETA model. Stage 1 is bounded by input size; stage 2 is bounded
   by *output* size (one JSON entry per sentence) and runs longer per input
   char. STAGE1_BASELINE_RATE is the only static baseline — stage 2 is
   computed from stage 1's *observed* rate × STAGE2_STRETCH, so big books
   on slow models still get a sensible bar after the first phase. */
const STAGE1_BASELINE_RATE = 1.0; // input chars / ms; tuned for gemini-2.5-flash
/* Stage 2 emits one JSON entry per sentence — output is much heavier than
   stage 1's small roster. Earlier 3× was optimistic; observed runs on
   gemini-3-flash land closer to 5–7× the stage 1 time per char. Erring on
   the side of "we promised more time than it took" beats pegging at 95%. */
const STAGE2_STRETCH = 5.0;
const MIN_EST_MS = 3000;
/* Streaming-chunk feedback. Throttle SSE heartbeat emission so a fast model
   pumping 200 chunks/s doesn't drown the client. 2 s is high-signal:
   noticeable to the user, low overhead on the wire. */
const HEARTBEAT_EVENT_THROTTLE_MS = 2_000;
/* If no chunk lands for this long during an in-flight call, surface a
   warning log line so the user knows something is wrong rather than
   mistaking the bar's slow creep (or a frozen ticker) for activity.
   Re-armed once a chunk lands; per-chapter scope. */
const SILENCE_THRESHOLD_MS = 45_000;
/* Per-chapter Phase 0a budget — TTFT-dominated, not input-size-dominated.
   The per-chapter call's wall-clock cost on a small model (Gemma 4 31B,
   Gemini 2.5 Flash) is largely time-to-first-token plus a small fixed
   generation cost; chapter input length contributes very little until you
   get into the multi-tens-of-KB range. Using an input-proportional
   estimate (e.g. stage1EstMs × chBytes/sourceChars) produced wildly
   wrong values like "~0:02" for a 121-char Dedication chapter, making
   every cast call read "over budget" within seconds. 30s is a sensible
   floor that matches typical observed times. */
const PHASE0_PER_CHAPTER_BASELINE_MS = 30_000;
/* Per-engine fallback rate (ms/char on top of the TTFT baseline) used for
   the very first chapter of a fresh run — before any observed samples
   exist for this manuscript+model combination. Gemini Flash is ~10×
   faster than local Ollama qwen3.5:4b on input chars, so a single
   constant under-estimates one or over-estimates the other. Once any
   chapter completes (or a prior run's cached durations seed the
   trackers), this is ignored. */
const GEMINI_FALLBACK_MS_PER_CHAR = 0.5;
/* Local Ollama first-chapter rate (ms per INPUT char), split by device because
   CUDA runs ~10× faster than CPU (user-measured ≈150 vs ≈15 chars/s on
   qwen3.5:4b). These feed the Phase-0 per-chapter fallback and the Phase-1
   projection (× STAGE2_STRETCH); both are replaced by the observed wall-clock
   rate the moment any chapter completes, and refined mid-chapter from live
   output throughput (projectChapterEstMsFromOutput). */
const LOCAL_FALLBACK_MS_PER_CHAR_CUDA = 1.2;
const LOCAL_FALLBACK_MS_PER_CHAR_CPU = 12;
export function localFallbackMsPerChar(device: 'cuda' | 'cpu' | 'unknown'): number {
  return device === 'cpu' ? LOCAL_FALLBACK_MS_PER_CHAR_CPU : LOCAL_FALLBACK_MS_PER_CHAR_CUDA;
}
export function engineFallbackMsPerChar(
  engine: AnalysisEngine,
  device: 'cuda' | 'cpu' | 'unknown',
  endpointGpu?: string,
): number {
  if (engine === 'local') return localFallbackMsPerChar(device);
  if (engine === 'openai' && endpointGpu !== undefined && endpointGpu !== 'none') return localFallbackMsPerChar(device);
  return GEMINI_FALLBACK_MS_PER_CHAR;
}

/** The saved endpoint's gpu for an endpoint model id (#3084); undefined otherwise. */
function endpointGpuFor(modelId: string): string | undefined {
  const parsed = parseEndpointModelId(modelId);
  return parsed ? getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed.endpointId)?.gpu : undefined;
}

/* Mid-chapter ETA refinement (issue 3, 2026-06-14). Project a chapter's total
   wall-clock from how much OUTPUT has streamed so far, WITHOUT waiting for the
   chapter to finish. Stage-2 output ≈ input chars × an output:input ratio that
   self-calibrates from completed chapters (DEFAULT_STAGE2_OUTPUT_RATIO until
   then). Returns null when the signal is too weak to trust (too little time
   elapsed, too few bytes, or sub-2% apparent completion) so the caller keeps
   the prior estimate rather than jittering. */
export const DEFAULT_STAGE2_OUTPUT_RATIO = 1.2;
/* Sentence-mode display threshold: show the sentence headline once at least
   one section has completed OR this many in-flight markers have streamed.
   One-way per chapter (hysteresis) — never revert, so the row can't flip-flop
   between byte mode and sentence mode. */
const SENTENCE_MODE_MIN_MARKERS = 5;
const MIN_REFINE_ELAPSED_MS = 8_000;
const MIN_REFINE_BYTES = 2_048;
export function projectChapterEstMsFromOutput(
  elapsedMs: number,
  receivedBytes: number,
  inputChars: number,
  outputRatio: number,
): number | null {
  if (elapsedMs < MIN_REFINE_ELAPSED_MS) return null;
  if (receivedBytes < MIN_REFINE_BYTES) return null;
  if (inputChars <= 0 || outputRatio <= 0) return null;
  const expectedOutputBytes = inputChars * outputRatio;
  const frac = Math.min(0.95, receivedBytes / expectedOutputBytes);
  if (frac < 0.02) return null;
  return Math.max(MIN_EST_MS, Math.round(elapsedMs / frac));
}

/* Mid-chapter ETA refinement for Phase-0a CAST DETECTION (2026-06-16, srv-40
   follow-on). Unlike stage-2 attribution, cast output is a small roster — NOT
   proportional to input — so projectChapterEstMsFromOutput's output-fraction
   model doesn't apply. Instead the honest live signal is the Stage-1 chunker's
   SECTION progress: once `sectionsDone` of `sectionsTotal` equal-ish sections
   have completed, the chapter's total wall-clock projects to
   `elapsed / sectionsDone × sectionsTotal`. A floor that always sits just above
   `elapsed` guarantees the ticker can never read "over budget" / negative (the
   first-chapter lie: a static Gemini-tuned baseline that the slower local model
   blows through before any chapter completes to seed the observed rate). Pure. */
export function refineCastChapterEstMs(
  elapsedMs: number,
  baseEstMs: number,
  sectionsDone: number,
  sectionsTotal: number,
): number {
  let est = baseEstMs;
  if (sectionsTotal > 1 && sectionsDone >= 1) {
    est = Math.round((elapsedMs / sectionsDone) * sectionsTotal);
  }
  // Never show an estimate at/below elapsed — always leave a remainder that
  // grows with elapsed so a too-low base (or a still-running last section)
  // reads as "a little more", not "over budget".
  const floor = Math.round(elapsedMs * 1.1) + 3000;
  return Math.max(est, floor);
}
/* Analyzer chapter-pool width (stage-1 cast + stage-2 attribution), = K, read
   LIVE from the analyzer.ollama.concurrency knob so tests can set it per-case.
   Replaces the removed STAGE2_CONCURRENCY env. Capped at 6 (per-call overhead
   dominates beyond that). The width-K limiter (analyzer-concurrency.ts) is the
   hard cap on in-flight calls; this only governs how many chapters are dispatched. */
export function analyzerPoolWidth(): number {
  const k = configValue<number>('analyzer.ollama.concurrency');
  return Math.min(6, Math.max(1, Math.floor(k)));
}

/* Honest end-of-phase concurrency readout. `peak` is the most analyzer calls
   that were simultaneously in-flight (past the limiter+lease, awaiting Ollama)
   during the phase; K is the limiter budget. Peak measures APP-side dispatch
   only — if the app fires K requests they all count as in-flight while awaiting
   Ollama, so peak reaches K even when Ollama's n_slots serialises the decodes.
   Hence: peak==K proves the app dispatched K-wide (if wall-clock didn't improve,
   the cap is OLLAMA's slot count — raise OLLAMA_NUM_PARALLEL / lower num_ctx so
   K slots fit VRAM); peak<K means the app pool never filled. Only meaningful
   with >1 task; a single-chapter phase can never exceed peak 1. */
export function analyzerConcurrencyPeakLine(label: string, taskCount: number): string {
  const { peak, limiter } = getAnalyzerConcurrencyStats();
  let note = '';
  if (taskCount > 1 && limiter > 1) {
    note =
      peak >= limiter
        ? ` — app dispatched K=${limiter}-wide; if wall-clock didn't improve, Ollama is serving <K slots (raise OLLAMA_NUM_PARALLEL and/or lower num_ctx so K slots fit VRAM).`
        : ` — only ${peak} of K=${limiter} ran at once; the app pool never filled (few chapters left, or calls finished before overlapping).`;
  }
  return `${label}: peaked at ${peak} concurrent analyzer call${peak === 1 ? '' : 's'} (K=${limiter}).${note}`;
}

/* Stage-2 coverage guard retry budget. The attribution model occasionally
   loop-and-truncates (re-emits a span and stops early); a fresh attempt usually
   clears it, so a bad response is re-run up to this many times before the
   least-bad take is kept and the chapter is flagged for retry. `0` disables the
   guard (byte-identical to pre-guard). Default 2. */
function resolveStage2CoverageRetries(): number {
  return configValue<number>('analyzer.stage2.coverageRetries');
}

/* Whole-stage (whole-book) estimate clamp: a floor only, no ceiling.
   This used to cap at MAX_EST_MS (10 min), but that ceiling is a PER-CHAPTER
   bar concern, not an aggregate one — on a slow local model (qwen3.5:4b on
   CUDA ≈ 150 chars/s, ≈ 15 chars/s on CPU) a multi-chapter book legitimately
   takes far longer than 10 min, and capping the aggregate at 10 min made both
   the "Estimated stage time" log and the per-chapter ticker (which divides
   this aggregate by chars) read absurdly low — e.g. "~1:43" for a 110k-char
   chapter that really takes ~10 min. The estimate self-corrects to the
   observed rate once any chapter completes (chapterEstFromObserved /
   chapterEstMsFor); the floor keeps a micro-book from teleporting. */
export function clampStageEstMs(ms: number): number {
  return Math.max(MIN_EST_MS, Math.round(ms));
}

/** Shape of a single entry in the Phase-0a cast live-tick `chapters[]` array.
    Exported so callers (frontend type consumers, tests) can reference it. */
export interface CastLiveChapter {
  chapterIndex: number;
  chapterTitle: string;
  elapsedMs: number;
  estMs: number;
  /** Section progress for chunked chapters (1/1 for single-section chapters). */
  sectionsDone: number;
  sectionsTotal: number;
}

/** Pure mapping helper: converts one `CastInFlight`-shaped slot and a `now`
    timestamp into the live-tick chapter entry.  Exported for unit tests. */
export function castInFlightEntryToLiveChapter(
  r: {
    chapterIndex: number;
    chapterTitle: string;
    baseEstMs: number;
    startedAt: number;
    sectionsDone: number;
    sectionsTotal: number;
  },
  now: number,
): CastLiveChapter {
  const elapsedMs = now - r.startedAt;
  return {
    chapterIndex: r.chapterIndex + 1,
    chapterTitle: r.chapterTitle,
    elapsedMs,
    estMs: refineCastChapterEstMs(elapsedMs, r.baseEstMs, r.sectionsDone, r.sectionsTotal),
    sectionsDone: r.sectionsDone,
    sectionsTotal: r.sectionsTotal,
  };
}

/* Decide whether cached per-chapter durations may seed this run's observed-
   rate tracker. The samples are only valid when the resumed run uses the SAME
   analyzer engine that produced them — a Gemini-paced duration would mis-seed
   a local-Qwen run's ETA by ~10× (2026-06-14 model-switch report). On a
   mismatch (or an untagged legacy cache) we discard the stale samples and
   start clean; the caller re-stamps the engine so future resumes match.
   Returns a fresh, possibly-empty duration map to accumulate into. */
export function durationsForEngine(
  durations: Record<number, number> | undefined,
  storedEngine: string | undefined,
  currentEngine: string,
): Record<number, number> {
  if (durations && storedEngine === currentEngine) return durations;
  return {};
}

/* #3435 S5 — the subset gate's soft-stop copy. Shown on the Analysing view
   (Retry panel beside it) AND the Generate view (none), so it carries no
   "retry below"; the title list is capped so a many-chapter book can't
   produce a paragraph. Exported for unit testing. */
export function castIncompleteMessage(titles: string[]): string {
  return `Phase 0 paused — ${titles.length} chapter${titles.length === 1 ? ' still needs' : 's still need'} cast detection (${titleList(titles)}). Retry to continue.`;
}

/* Up to three titles, then "and N more", so a many-chapter book can't produce
   a paragraph. */
function titleList(titles: string[]): string {
  const MAX_TITLES = 3;
  const shown = titles.slice(0, MAX_TITLES).join(', ');
  const more = titles.length > MAX_TITLES ? ` and ${titles.length - MAX_TITLES} more` : '';
  return `${shown}${more}`;
}

/* #3435 S8 — a subset run on a book with no stage1 finished cast detection,
   but the main run still has to attribute the book (plan 287 §3.2). */
export function resumeRequiredAfterCastMessage(titles: string[]): string {
  return `Cast detection for ${titleList(titles)} is done. The rest of the book still needs attribution — resume the analysis to finish.`;
}

/* #3435 S14 — a subset run attributed its targets, but other chapters of an
   unfinished book still lack a current take. */
export function resumeRequiredAfterRetryMessage(doneTitles: string[], missingTitles: string[]): string {
  return `${titleList(doneTitles)} re-analysed. ${titleList(missingTitles)} still ${missingTitles.length === 1 ? 'needs' : 'need'} attribution — resume the analysis to finish the book.`;
}

/* Remove `chapterId` from `cache.failedChapterIds` if present, mutating
   the cache in place. Returns whether the id was actually in the list —
   the caller uses that to decide whether to emit a `chapter-resolved`
   event on the SSE. Centralises the "is this a recovered chapter?"
   check so the full-route Phase 0a success path and the subset
   retry's success path stay in lockstep (both must clear AND notify;
   either one alone leaks state to the FE). Idempotent: a second call
   for the same id is a no-op and returns false. With `phase` the clear is
   conditional (#3435 M8): only a record of that phase is cleared, so a
   Phase-1 completion never clears a chapter that still has no cast.
   Exported for unit testing. */
export function clearFailedChapterId(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, ChapterErrorRecord>;
  },
  chapterId: number,
  phase?: 'cast' | 'attribution',
): boolean {
  const wasFailed =
    cache.failedChapterIds?.includes(chapterId) === true &&
    (phase === undefined || cache.failedChapterErrors?.[String(chapterId)]?.phase === phase);
  if (wasFailed) {
    cache.failedChapterIds = cache.failedChapterIds!.filter((id) => id !== chapterId);
    if (cache.failedChapterErrors) delete cache.failedChapterErrors[String(chapterId)];
  }
  return wasFailed;
}

/* fs-19 (analysis half) — promote a classified per-chapter failure to durable
   cache state: the id keeps driving the Retry list; the record carries the
   structured code/message/remediation for the post-reload display. Returns the
   EFFECTIVE record — callers send `chapter-failed` with it. Cast dominates
   (plan 287 spec 2.1): an attribution write onto a chapter whose record is
   already `'cast'` is a no-op, so a chapter that never got its cast cannot be
   relabelled as an attribution failure. */
export function recordFailedChapter(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, ChapterErrorRecord>;
  },
  chapterId: number,
  classified: { code: string; userMessage: string; remediation: string },
  phase: 'cast' | 'attribution',
): ChapterErrorRecord & { phase: 'cast' | 'attribution' } {
  const failedSet = new Set(cache.failedChapterIds ?? []);
  failedSet.add(chapterId);
  cache.failedChapterIds = Array.from(failedSet);
  if (!cache.failedChapterErrors) cache.failedChapterErrors = {};
  const existing = cache.failedChapterErrors[String(chapterId)];
  if (phase === 'attribution' && existing?.phase === 'cast') return { ...existing, phase: 'cast' };
  const record: ChapterErrorRecord & { phase: 'cast' | 'attribution' } = {
    code: classified.code,
    message: classified.userMessage,
    remediation: classified.remediation,
    phase,
  };
  cache.failedChapterErrors[String(chapterId)] = record;
  return record;
}

/* #3435 (plan 287 spec 2.1) — the non-excluded chapters whose failure record is
   a CAST failure. This, not `failedChapterIds`, is what the subset route's
   Phase-1 gate counts: an attribution record does not stop another chapter's
   Re-analyse, and an excluded chapter's record never does. Exported for unit
   testing. */
export function castFailedChapterIds(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, ChapterErrorRecord>;
  },
  chapterHints: Array<{ id: number; excluded?: boolean }>,
): number[] {
  const excluded = new Set(chapterHints.filter((h) => h.excluded).map((h) => h.id));
  return (cache.failedChapterIds ?? []).filter(
    (id) => !excluded.has(id) && cache.failedChapterErrors?.[String(id)]?.phase === 'cast',
  );
}

/* #3435 (S3) — a chapter whose cast has just been fixed still has no good
   take: its record becomes an attribution record until its Phase 1 completes.
   Returns whether a cast record was promoted. Exported for unit testing. */
export function promoteCastRecordToAttribution(
  cache: { failedChapterErrors?: Record<string, ChapterErrorRecord> },
  chapterId: number,
): boolean {
  const record = cache.failedChapterErrors?.[String(chapterId)];
  if (record?.phase !== 'cast') return false;
  record.phase = 'attribution';
  return true;
}

/* #3435 (plan 287 spec 2.2) — put `chapterId` into, or take it out of, the
   pending set P (`cache.pendingAttributionChapterIds`), mutating the cache in
   place. A pending take is never deleted here: it stays in `cache.chapters`
   until a later Phase-1 completion replaces it. */
export function setPendingAttribution(
  cache: { pendingAttributionChapterIds?: number[] },
  chapterId: number,
  pending: boolean,
): void {
  const current = cache.pendingAttributionChapterIds ?? [];
  if (pending === current.includes(chapterId)) return;
  cache.pendingAttributionChapterIds = pending
    ? [...current, chapterId]
    : current.filter((id) => id !== chapterId);
}

/* #3435 (plan 287 M0/M1, S0) — the rules both routes apply to the cache they
   have just loaded, mutating it in place. Returns whether it changed (the
   caller saves).
   - M0: a failed word-free chapter (no attributable words) whose take is `[]`
     and whose record is `attribution-incomplete` — the `noSentences` flag the
     analyzer raised for a chapter with nothing to attribute — has that record
     cleared.
   - M1: while stage1 is absent, every non-excluded failed chapter that has an
     own key, including `[]`, goes into P: the record is evidence its take is
     bad, and the take was made without a final roster. Exported for unit
     testing. */
export function applyAnalysisLoadRules(
  cache: AnalysisCache,
  chapterHints: Array<{ id: number; body: string; excluded?: boolean }>,
): boolean {
  let changed = false;
  for (const h of chapterHints) {
    if (
      cache.failedChapterIds?.includes(h.id) &&
      cache.failedChapterErrors?.[String(h.id)]?.code === 'attribution-incomplete' &&
      Object.hasOwn(cache.chapters, h.id) &&
      cache.chapters[h.id].length === 0 &&
      !hasAttributableContent(h.body)
    ) {
      clearFailedChapterId(cache, h.id);
      changed = true;
    }
  }
  if (!cache.stage1) {
    for (const h of chapterHints) {
      if (h.excluded || !cache.failedChapterIds?.includes(h.id)) continue;
      if (!Object.hasOwn(cache.chapters, h.id)) continue;
      if (cache.pendingAttributionChapterIds?.includes(h.id)) continue;
      setPendingAttribution(cache, h.id, true);
      changed = true;
    }
  }
  return changed;
}

/* #3435 (plan 287) — a word-free chapter (`!hasAttributableContent`) has
   nothing to attribute: both routes replace the analyzer call with this
   synthetic successful result, so every normal success step still runs and
   the chapter is not flagged `noSentences`. Exported for unit testing. */
export function wordFreeStage2Result(): Stage2ChunkRunResult {
  return {
    sentences: [],
    coverage: {
      ok: true,
      coverageRatio: 1,
      endingPresent: true,
      duplicatedBlock: null,
      narratedSpeech: null,
      noSentences: false,
      truncated: false,
      excess: false,
      markersLost: false,
      issues: [],
    },
    chunkCount: 0,
  };
}

/* #4031 Task 19 — the main job's cache saves are field-scoped patches
   (`mutateAnalysisCache`), so a merge or decision the user makes mid-run, which
   re-targets the cached plan and takes through the cache op, is never reverted by
   a stale whole-cache save. A patch carries only what the save owns; an unset
   field is left as the file has it. Copies, because the op runs after later
   in-memory edits to the same objects. */
function cacheFields(
  cache: AnalysisCache,
  keys: ReadonlyArray<keyof NonNullable<CachePatch['fields']>>,
): NonNullable<CachePatch['fields']> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (cache[k] !== undefined) out[k] = structuredClone(cache[k]);
  return out as NonNullable<CachePatch['fields']>;
}

/** The per-chapter failure record and the pending set a Phase-1 save carries (item 8). */
const PHASE1_RECORD_FIELDS = [
  'failedChapterIds',
  'failedChapterErrors',
  'pendingAttributionChapterIds',
  'takesPersisted',
] as const;

/** What a subset Phase-0a (and finalise) save carries: the chapter casts and the
    per-chapter records the Retry moves (#4031). */
const SUBSET_PHASE0_FIELDS = ['chapterCast', ...PHASE1_RECORD_FIELDS] as const;

/** #4031 (N2) — re-send a cache patch that faulted once, best-effort: a second fault is
    logged, never thrown (the writes it follows have already landed). */
async function resendCachePatch(manuscriptId: string, patch: CachePatch): Promise<void> {
  try {
    await mutateAnalysisCache(manuscriptId, patch);
  } catch (resendErr) {
    console.warn('[analysis] re-sending a faulted analysis-cache patch failed', resendErr);
  }
}

/* #3435 — patch the cache from INSIDE a per-chapter failure catch. That patch can
   itself throw (ENOSPC, renameWithRetry exhausted); unguarded, its error replaces
   the one being handled (an overflow loses its code and fixes) and the
   chapter-failed that follows is never sent. Log it and carry on: the live
   chapter-failed and the original error still reach the user. */
async function patchCacheInFailureCatch(
  manuscriptId: string,
  patch: CachePatch,
  chapterId: number,
): Promise<void> {
  try {
    await mutateAnalysisCache(manuscriptId, patch);
  } catch (saveErr) {
    console.warn(
      `[analysis] could not persist chapter ${chapterId}'s failure record (reporting the original failure)`,
      saveErr,
    );
  }
}

/* A sentence's id as it is now: the run's Phase-0b re-mints first, then a prior row
   merged away mid-run follows to its live survivor (R33). A take carries RAW analyzer
   ids the plan has already decided, so an id is rewritten only when it is a prior-row id
   from the run-start prior AND `buildCastResolver` resolves it through its `'history'`
   tier to a live target; the resolver's normalised tiers and analyzer-tagged chains
   would otherwise override the plan. An id the plan made `new` (a T1 conflict: it is minted
   `X-n1`) is left alone too; only an id with no decision yet, a join of itself or of its
   history survivor, or the survivor's own `new` (the plan the merge re-targeted), follows
   the merge. Lock-free reads of cast.json and the history, so it is safe under the `book`
   lock and inside the cache op. R55 (PR #4103 pass 5): a merge is refused while a registered
   job runs, so this is defence in depth, as `collapseMidRunMerges` below is. */
export async function resolveCurrentIds<S extends { characterId: string }>(
  bookDir: string | undefined,
  remint: Readonly<Record<string, string>>,
  sentences: S[],
  priorIds: ReadonlySet<string>,
  decisions?: Readonly<Record<string, { kind: string; priorId?: string; id?: string }>>,
  /* R34: the ids this run added (its plan's `new` rows). Mid-run, a history key on one of them
     can only be a user merge (the run's own retirements are recorded after the persist). */
  addedIds: ReadonlySet<string> = new Set(),
): Promise<S[]> {
  const reminted = remapSentenceIds(sentences, remint);
  if (!bookDir) return reminted;
  const { idMap } = await mergedAwayIds(bookDir, reminted.map((s) => s.characterId), priorIds, decisions, addedIds);
  return remapSentenceIds(reminted, idMap);
}

/* `resolveCurrentIds`' gate, for any set of ids: which of them a user merged away mid-run,
   and onto which live survivor (with the survivor's on-disk row). A catch-all bucket never
   follows its history (R49): its key is not in the history this reads (`followableHistory`,
   R53). Throws on a degraded history. */
async function mergedAwayIds(
  bookDir: string,
  ids: Iterable<string>,
  priorIds: ReadonlySet<string>,
  decisions: Readonly<Record<string, { kind: string; priorId?: string; id?: string }>> | undefined,
  addedIds: ReadonlySet<string>,
): Promise<{ idMap: Record<string, string>; survivors: Map<string, { id: string; name?: unknown }> }> {
  const read = await loadCastIdHistoryWithStatus(bookDir);
  /* An unreadable history is "could not be determined", never "nothing merged": fail
     rather than write ids a merge has retired. */
  if (read.status === 'degraded') throw new Error('cast-id-history.json could not be read');
  const cast = (await readJson<{ characters?: Array<{ id: string }> }>(castJsonPath(bookDir)))?.characters ?? [];
  const resolver = buildCastResolver(cast, followableHistory(read.history));
  const idMap: Record<string, string> = {};
  const survivors = new Map<string, { id: string; name?: unknown }>();
  for (const characterId of new Set(ids)) {
    /* A resume reads the stopped leg's snapshot rows as prior, so a run-added id can be a prior id too. */
    const runAdded = addedIds.has(characterId);
    if (!priorIds.has(characterId) && !runAdded) continue;
    const hit = resolver.resolve(characterId);
    if (hit?.via !== 'history' || hit.character.id === characterId) continue;
    /* A join of X, or the decision the merge moved onto X's survivor: the merge re-targets the
       on-disk plan (`join -> survivor`, or the survivor's own `new` when the run added it) while
       the in-memory one still says `join -> X`, and both sites must agree. */
    const decision = decisions?.[characterId];
    const joined = decision?.kind === 'join' && [characterId, hit.character.id].includes(decision.priorId ?? '');
    const intoNew = decision?.kind === 'new' && decision.id === hit.character.id;
    /* A run-added id's own `new` decision (the in-memory plan; the merge re-targets the on-disk one). */
    const ownNew = runAdded && decision?.kind === 'new' && decision.id === characterId;
    if (decision && !joined && !intoNew && !ownNew) continue;
    idMap[characterId] = hit.character.id;
    survivors.set(hit.character.id, hit.character as { id: string; name?: unknown });
  }
  return { idMap, survivors };
}

/* PR #4103 pass 1 O2 — the in-memory roster and takes, collapsed through the merges a user
   made mid-run, BEFORE the dedup and the fold: otherwise a merged-away row the run added
   (below the fold's line count, or sharing a name with another row) is folded into a
   bucket or deduped into a sibling, and the survivor gets none of its lines. Same gate as
   `resolveCurrentIds`. A merged-away row becomes its survivor: dropped when the survivor
   has its own roster row, otherwise re-keyed to it under the survivor's on-disk name and
   with no aliases of its own (the merge route already aliased the survivor on disk, which
   the persist keeps, and the dedup must not read the merged name as the survivor's own,
   which would pair it with a same-named sibling). The in-memory plan follows the merge
   (`retargetPlanForMerge`, as the merge route did to the cache's), so the persist, the
   dedup constraints and the fold's protected ids all see it. `null` when nothing was
   merged away (or there is no plan or book dir).
   R55 (PR #4103 pass 5) — no route reaches this for a registered job any more: every
   cast-identity write (a merge, an accepted suggestion, an orphan link, ...) answers 409
   `book_busy` while the run's `runBookJob` token is held. It stays as defence in depth, for
   a merge that slips past that gate (a run with no `bookId` runs unregistered). */
async function collapseMidRunMerges(a: {
  bookDir: string | undefined;
  roster: CharacterOutput[];
  sentences: SentenceOutput[];
  prior: PriorRow[];
  plan: MatchPlan | undefined;
  currentBookId: string | undefined;
}): Promise<{
  roster: CharacterOutput[];
  sentences: SentenceOutput[];
  plan: MatchPlan;
  constraints: DedupConstraints;
  protectIds: ReadonlySet<string>;
} | null> {
  if (!a.bookDir || !a.plan) return null;
  const ids = [...a.roster.map((c) => c.id), ...a.sentences.map((s) => s.characterId)];
  let found: Awaited<ReturnType<typeof mergedAwayIds>>;
  try {
    found = await mergedAwayIds(a.bookDir, ids, new Set(a.prior.map((r) => r.id)), a.plan.decisions, planAddedIds(a.plan));
  } catch (err) {
    /* A degraded history: the persist fails closed on it (rule 9); nothing is collapsed here. */
    console.warn('[analysis] mid-run merges not applied before the fold - the merge history could not be read', err);
    return null;
  }
  const { idMap, survivors } = found;
  if (Object.keys(idMap).length === 0) return null;
  let plan = a.plan;
  for (const [from, to] of Object.entries(idMap)) plan = retargetPlanForMerge(plan, from, to);
  const roster: CharacterOutput[] = [];
  for (const c of a.roster) {
    const to = idMap[c.id];
    if (!to) {
      roster.push(c);
      continue;
    }
    if (a.roster.some((r) => r.id === to) || roster.some((r) => r.id === to)) continue;
    const name = survivors.get(to)?.name;
    roster.push({ ...c, id: to, name: typeof name === 'string' ? name : c.name, aliases: [] });
  }
  const history = toMatchHistory(await loadCastIdHistoryWithStatus(a.bookDir));
  return {
    roster,
    sentences: remapSentenceIds(a.sentences, idMap),
    plan,
    constraints: planConstraintsFor({ roster, plan, prior: a.prior, history, currentBookId: a.currentBookId }),
    protectIds: planProtectIdsOf(plan),
  };
}

/** The plan's joined prior ids: never folded (R29). */
function planProtectIdsOf(plan: MatchPlan): Set<string> {
  return new Set(Object.values(plan.decisions).flatMap((d) => (d.kind === 'join' ? [d.priorId] : [])));
}

/** PR #4103 pass 2 P2-3 — the main job's fold protect set without the rows a run added that
    the user never touched: a `run-owned` ledger entry whose fingerprint still matches the row
    on disk. A Start fresh joins such a row by id (it is live), but it is not the user's: it
    folds as a fresh `new` row would, and the persist drops it by rule 11. Rows the user
    edited (fingerprint changed), `added-once` rows and every prior row stay protected. Main
    job only: the subset job never deletes by the cache's ledger (invariant 6), so a run row
    folded away there would stay on disk with no lines. An unreadable cast protects all.
    PR #4103 pass 4 M-c: the cast read (`untouchedRunRowIds`) is taken before the second
    mid-run merge collapse, so no await sits between that collapse and the fold; the filter
    itself (`withoutUntouchedRunRows`) is pure. */
async function untouchedRunRowIds(ledger: RunAddedLedger | undefined, bookDir: string | undefined): Promise<ReadonlySet<string>> {
  const owned = Object.entries(ledger ?? {}).flatMap(([id, e]) => (e.state === 'run-owned' ? [[id, e.fp] as const] : []));
  if (!bookDir || owned.length === 0) return new Set();
  let rows: Array<{ id: string } & Record<string, unknown>>;
  try {
    rows = (await readPriorCastLockFree(bookDir)).rows as typeof rows;
  } catch {
    return new Set();
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Set(
    owned.flatMap(([id, fp]) => {
      const r = byId.get(id);
      return r && userOwnedFingerprint(r) === fp ? [id] : [];
    }),
  );
}

function withoutUntouchedRunRows(
  protectIds: ReadonlySet<string> | undefined,
  untouched: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!protectIds || ![...untouched].some((id) => protectIds.has(id))) return protectIds;
  return new Set([...protectIds].filter((id) => !untouched.has(id)));
}

/** R34: the ids a plan added (its `new` rows); the in-memory plan still names them after a
    merge re-targets the on-disk one. */
function planAddedIds(plan: MatchPlan | undefined): Set<string> {
  return new Set(Object.values(plan?.decisions ?? {}).flatMap((d) => (d.kind === 'new' ? [d.id] : [])));
}

/* #4031 — a Phase-1 chapter take's cache patch, shared by both jobs. It carries only what
   the chapter owns (its take, `fields`, and the main job's durations), so it never writes
   back the plan or another chapter's take a merge has re-targeted since the job last wrote
   them. The take speaks the ids that are current when the op RUNS: resolved here, inside
   the op, so a merge whose history write and cache op landed before it is already seen
   (resolved outside, a read taken before that merge would write the retired id back, and
   each chapter is written once). */
function chapterTakeCachePatch(a: {
  chapterId: number;
  takes: SentenceOutput[];
  remint: Readonly<Record<string, string>>;
  fields: NonNullable<CachePatch['fields']>;
  bookDir: string | undefined;
  priorIds: ReadonlySet<string>;
  addedIds: ReadonlySet<string>;
  stage2Durations?: Record<number, number>;
}): CachePatch {
  return {
    chapters: { [a.chapterId]: remapSentenceIds(a.takes, a.remint) },
    fields: a.fields,
    transform: async (c) => {
      const out = a.stage2Durations ? { ...c, stage2Durations: { ...a.stage2Durations } } : { ...c };
      try {
        out.chapters = {
          ...c.chapters,
          [a.chapterId]: await resolveCurrentIds(a.bookDir, a.remint, c.chapters[a.chapterId], a.priorIds, c.matchPlan?.decisions, a.addedIds),
        };
      } catch (e) {
        /* The persist resolves every id again; the take keeps the run's own ids until then. */
        console.warn('[analysis] could not resolve ids against the merge history for the cache take', e);
      }
      return out;
    },
  };
}

/* #4031 (R39) — a per-chapter roll's chapter set, shared by both jobs. `snapshot`: only the
   chapters this run produced or replayed (`produced`), in book order. The roll re-reads the
   file under the `book` lock and replaces just these (an empty take clears its chapter), so
   a chapter it did not produce (a cached take, a merge's remap of one, a manuscript PUT made
   mid-run) stays as the file has it. Excluded chapters leave the file, as the wholesale roll
   left them out. `fallback` (#3435): a chapter not attributed this run falls back to its
   cached take where the file has none, so a pending take stays in the edits until it is
   replaced. Both are built when the roll runs (getters), inside its queue step. */
function rollChapterSet(
  hints: () => ReadonlyArray<{ id: number; excluded?: boolean }>,
  produced: ReadonlyMap<number, SentenceOutput[]>,
  cached: () => Readonly<Record<number, SentenceOutput[]>>,
): { snapshot: () => RollSnapshot; fallback: () => SentenceOutput[] } {
  return {
    snapshot: () => {
      const sentences: SentenceOutput[] = [];
      const chapterIds: number[] = [];
      const dropChapterIds: number[] = [];
      for (const order of hints()) {
        if (order.excluded) {
          dropChapterIds.push(order.id);
          continue;
        }
        const arr = produced.get(order.id);
        if (!arr) continue;
        chapterIds.push(order.id);
        sentences.push(...arr);
      }
      return { sentences, chapterIds, dropChapterIds };
    },
    fallback: () => {
      const out: SentenceOutput[] = [];
      const c = cached();
      for (const order of hints()) {
        if (order.excluded || produced.has(order.id)) continue;
        const arr = c[order.id];
        if (arr) out.push(...arr);
      }
      return out;
    },
  };
}

/* Plan 291 (item 17) — the drift gate's valid ids, shared by both jobs: the roster plus
   every id live in cast.json, read lock-free just before the gate. A take replayed from a
   cache rebuilt from the book's edits names prior rows the fresh roster may not hold (twins
   the plan kept apart), and those lines are not orphans. */
async function driftGateValidIds(
  job: AnalysisJob,
  recordBookDir: string | null | undefined,
  roster: ReadonlyArray<{ id: string }>,
): Promise<Set<string>> {
  const valid = new Set(roster.map((c) => c.id));
  const dir = liveBookDir(job) ?? recordBookDir;
  if (dir) {
    try {
      for (const r of (await readPriorCastLockFree(dir)).rows) valid.add(r.id);
    } catch (err) {
      console.warn(`[analysis] drift gate counted against the roster only - cast.json could not be read: ${(err as Error)?.message ?? err}`);
    }
  }
  return valid;
}

/* Phase 0a coverage check — every non-excluded chapter must have a
   `chapterCast[id]` entry (and no cast-failure record) before stage1 can be
   finalised.

   The subset-retry path used to gate stage1 writes on
   `failedChapterIds.length === 0` alone, which is the WRONG predicate when
   the cache covers only a fraction of the book. Example regression seen on
   "The Floodmark" (mns_VoP0mLGvov): chapterCast had entries for chapters 1–28
   of a 182-chapter book, failedChapterIds was [], and a subset retry
   rebuilt stage1 from those 28 entries — overwriting a previously-good
   6-character roster with a Narrator-only one because every cached
   chapter happened to be a journal/registry-file POV that the model
   labelled as Narrator.

   A chapter counts as missing when it has no `chapterCast` entry or is in
   `castFailedIds`. An empty array is NOT a failure marker on its own (#3435):
   `[]` is also a legal success for a narration-only chapter, so only a chapter
   whose record is a cast failure (`castFailedChapterIds`) is uncovered.
   Excluded chapters are intentionally never run through Phase 0a so they
   don't count toward coverage. Exported for unit testing. */
export function isPhase0aCoverageComplete(
  chapterCast: Record<number, CharacterOutput[]>,
  chapterHints: Array<{ id: number; excluded?: boolean }>,
  castFailedIds: readonly number[],
): { complete: boolean; missingChapterIds: number[]; totalRequired: number } {
  const missingChapterIds: number[] = [];
  let totalRequired = 0;
  for (const ch of chapterHints) {
    if (ch.excluded) continue;
    totalRequired += 1;
    if (!(ch.id in chapterCast) || castFailedIds.includes(ch.id)) missingChapterIds.push(ch.id);
  }
  return { complete: missingChapterIds.length === 0, missingChapterIds, totalRequired };
}

/* Phase 1 character-id validator. Every sentence's `characterId` must be a
   member of `validIds` (the set of ids on `stage1.characters`); otherwise
   the sentence is orphaned and frontend renderers either swallow the entry
   silently or show "unknown character" rows the user can't fix.

   The skill (`audiobook-sentence-attribution.md:84`) already specifies
   that the model must only emit ids from the roster, but flaky models
   occasionally fabricate ids, and a later stage1-shrink (now blocked by
   `isPhase0aCoverageComplete` for the subset path) can orphan ids that
   were valid at attribution time. This validator is the disk-write
   safety net.

   Unknown ids are demoted to `narrator` (the always-present fallback —
   `analysis.ts` adds it explicitly during Phase 0b finalisation). The
   caller drives logging + a drift check via `onDemote` and the returned
   counts. Returns a new array; never mutates the input. Exported for
   unit testing. */
export function reconcileSentenceCharacterIds(
  sentences: SentenceOutput[],
  validIds: Set<string>,
  options: {
    fallbackId?: string;
    onDemote?: (info: { sentence: SentenceOutput; originalId: string }) => void;
  } = {},
): { sentences: SentenceOutput[]; demotedCount: number; demotedByOriginalId: Map<string, number> } {
  const fallbackId = options.fallbackId ?? 'narrator';
  let demotedCount = 0;
  const demotedByOriginalId = new Map<string, number>();
  const out: SentenceOutput[] = [];
  for (const s of sentences) {
    if (validIds.has(s.characterId)) {
      out.push(s);
      continue;
    }
    demotedCount += 1;
    demotedByOriginalId.set(s.characterId, (demotedByOriginalId.get(s.characterId) ?? 0) + 1);
    // #1984 D18 — record the id this demotion overwrote. This is the site that
    // matters: it runs by default and knob-independently, and is the #1984
    // incident's own mechanism (roster-shrink demotion).
    out.push({ ...s, characterId: fallbackId, priorCharacterId: s.characterId });
    options.onDemote?.({ sentence: s, originalId: s.characterId });
  }
  return { sentences: out, demotedCount, demotedByOriginalId };
}

/* CJK honorific/title-variant remap pre-pass — runs BEFORE
   `reconcileSentenceCharacterIds` for zh/ja books only. In CJK text an
   honorific fuses to a name with no separator (奥杜万师傅 = Master Oduvan,
   卡斯珀寡妇 = Widow Casper, 地保玛俐恩 = Constable Maerin), and Phase-0
   rostering vs Phase-1 attribution don't always agree on including the title.
   The strict-equality reconciler then demotes the title-variant as an orphan,
   and enough false demotions trip the 5% drift gate (observed: a weaker model
   at ~8% on the zh Coalfall book).

   This remaps an orphan id to its roster id ONLY on an unambiguous
   honorific-stripped match (see resolveCjkHonorificId). A genuinely-missed
   speaker (0 matches) or an ambiguous one (>1) is left untouched so reconcile
   still demotes it — we never invent identity. `bookLanguage` gates the whole
   pass off for anything but zh/ja (byte-identical for en/de/ru/es/fr) AND
   selects the per-language affix list (never the zh+ja union — see
   cjk-honorifics.ts). Returns a new array; never mutates the input. Exported
   for unit testing. */
export function remapCjkHonorificIds(
  sentences: SentenceOutput[],
  characters: ReadonlyArray<{ id: string; name?: string; aliases?: string[] }>,
  validIds: Set<string>,
  options: {
    bookLanguage: string;
    onRemap?: (info: { sentence: SentenceOutput; originalId: string; toId: string }) => void;
  },
): { sentences: SentenceOutput[]; remappedCount: number; remappedByOriginalId: Map<string, number> } {
  const remappedByOriginalId = new Map<string, number>();
  if (!isCjkLanguage(options.bookLanguage)) {
    return { sentences, remappedCount: 0, remappedByOriginalId };
  }
  const lang = options.bookLanguage;
  const index = buildCjkHonorificIndex(characters, lang);
  let remappedCount = 0;
  const out: SentenceOutput[] = [];
  for (const s of sentences) {
    if (validIds.has(s.characterId)) {
      out.push(s);
      continue;
    }
    const toId = resolveCjkHonorificId(s.characterId, index, lang);
    if (toId !== null && validIds.has(toId)) {
      remappedCount += 1;
      remappedByOriginalId.set(
        s.characterId,
        (remappedByOriginalId.get(s.characterId) ?? 0) + 1,
      );
      options.onRemap?.({ sentence: s, originalId: s.characterId, toId });
      out.push({ ...s, characterId: toId });
      continue;
    }
    out.push(s);
  }
  return { sentences: out, remappedCount, remappedByOriginalId };
}

/* Attribution-drift threshold check. When demotion rate exceeds the
   threshold on a non-trivially-sized sentence set, the model's output is
   too unreliable to promote silently — the caller should emit an
   `attribution_drift` error SSE and refuse to write cast.json/state.json
   so the run can be retried instead of advancing to a corrupted confirm
   screen. Defaults: 5% demotion ratio, 100-sentence minimum sample.
   Exported for unit testing. */
export function attributionDriftExceeded(
  demotedCount: number,
  totalSentences: number,
  thresholdRatio = 0.05,
  minSentencesForCheck = 100,
): boolean {
  if (totalSentences < minSentencesForCheck) return false;
  return demotedCount / totalSentences > thresholdRatio;
}

/* Secondary net for the roster-coverage bug: WARN for any single chapter whose
   demotion rate is high on its own. The book-wide `attributionDriftExceeded`
   dilutes one damaged chapter below its 5% threshold (the ~30 The Drowning Bell ch19
   demotions vanished against a whole-book denominator), so it never surfaced.
   WARN-only — informs the user / log, never aborts (a narration-heavy chapter
   can legitimately demote a lot). `demotedByChapter` is accumulated in the
   reconcile `onDemote` callback. */
function warnPerChapterDrift(
  allSentences: SentenceOutput[],
  demotedByChapter: Map<number, number>,
  log: (phaseId: number, message: string) => void,
): void {
  if (demotedByChapter.size === 0) return;
  const totalByChapter = new Map<number, number>();
  for (const s of allSentences) {
    totalByChapter.set(s.chapterId, (totalByChapter.get(s.chapterId) ?? 0) + 1);
  }
  for (const [chapterId, demoted] of demotedByChapter) {
    const total = totalByChapter.get(chapterId) ?? 0;
    if (chapterDriftExceeded(demoted, total)) {
      log(
        1,
        `⚠ Chapter ${chapterId}: ${demoted}/${total} sentences demoted to narrator (${Math.round(
          (demoted / total) * 100,
        )}%) — a tagged speaker may be uncast here. Run scripts/audit-missing-speakers.mts to check.`,
      );
    }
  }
}

/* Stage 1 shrink guard. When a stage1 write would replace a non-trivial
   existing roster (default `minPrevForGate=3` characters) with a much
   smaller one (default `thresholdRatio=0.5` — i.e. >50% drop), refuse
   the write unless the caller explicitly opted in. Prevents silent data
   loss when a follow-up run with a worse model collapses the cast.

   Concrete regression motivator (The Floodmark, mns_VoP0mLGvov): an earlier
   Phase 0a run produced 6 characters (narrator + marlow + oduvan + maerin
   + linnet + wren — visible in manuscript-edits.json's surviving
   attribution); a later subset-retry with Gemini 3.1 Flash Lite hit
   chapters that the model collapsed to Narrator-only, rebuildRoster()
   produced a 1-character stage1, and the write went through silently —
   user opens the analysing view to "Cast so far · 1 character" with no
   warning that 5 known characters just vanished.

   Returns true when the write should be REFUSED. The caller emits a
   `stage1_shrink_refused` SSE event with prev/next counts, leaves the
   existing stage1 untouched, and ends the stream so the user can opt
   in via `allowStage1Shrink: true` in the next request body. Exported
   for unit testing. */
export function stage1ShrinkRefused(
  prevCharCount: number,
  nextCharCount: number,
  options: { thresholdRatio?: number; minPrevForGate?: number } = {},
): boolean {
  const thresholdRatio = options.thresholdRatio ?? 0.5;
  const minPrevForGate = options.minPrevForGate ?? 3;
  if (prevCharCount < minPrevForGate) return false;
  return nextCharCount < prevCharCount * thresholdRatio;
}

/* Per-chapter ETA from observed pace. Once at least one chapter has
   completed we trust observed wall-clock-per-char over any static formula:
   local models (Ollama qwen3.5:4b, etc.) can be 5–10× slower than Gemini,
   and the old `30s baseline + 0.5ms/char` formula gave ~0:40 for a 20k-char
   chapter that actually takes 2-4 minutes. fallbackMs is used until we have
   a sample (first chapter of the phase). 2s floor keeps micro-chapters from
   teleporting through the live ticker. Exported for unit testing. */
export function chapterEstFromObserved(
  chars: number,
  observedMsTotal: number,
  observedCharsTotal: number,
  fallbackMs: number,
): number {
  if (observedCharsTotal > 0) {
    const observedRate = observedMsTotal / observedCharsTotal;
    return Math.max(2000, Math.round(observedRate * chars));
  }
  return Math.max(2000, Math.round(fallbackMs));
}

/* Remaining-time projection across the whole analysis, accounting for
   concurrency. Uses wall-clock-since-phase-start divided by chars-completed
   so the result reflects what the user actually observes (concurrency-2
   doubles per-chapter ms but halves wall-clock rate — this captures the
   wall-clock rate). Stage 2 work is projected at STAGE2_STRETCH× the cast
   rate when only Phase 0a samples are available. Exported for testing. */
export function projectRemainingMs(args: {
  phase0WallClockMs: number;
  phase0CharsDone: number;
  phase0CharsRemaining: number;
  phase1WallClockMs: number;
  phase1CharsDone: number;
  phase1CharsRemaining: number;
  fallbackPhase0Ms: number;
  fallbackPhase1Ms: number;
}): number {
  let remaining = 0;
  /* Phase 0 remaining work. */
  if (args.phase0CharsRemaining > 0) {
    if (args.phase0CharsDone > 0 && args.phase0WallClockMs > 0) {
      const wallRate = args.phase0WallClockMs / args.phase0CharsDone;
      remaining += wallRate * args.phase0CharsRemaining;
    } else {
      remaining += args.fallbackPhase0Ms;
    }
  }
  /* Phase 1 remaining work. Prefer phase 1's own wall-clock once we have
     any phase 1 samples; otherwise extrapolate from phase 0's rate
     stretched by STAGE2_STRETCH (output-heavy attribution is materially
     slower per char than cast detection). */
  if (args.phase1CharsRemaining > 0) {
    if (args.phase1CharsDone > 0 && args.phase1WallClockMs > 0) {
      const wallRate = args.phase1WallClockMs / args.phase1CharsDone;
      remaining += wallRate * args.phase1CharsRemaining;
    } else if (args.phase0CharsDone > 0 && args.phase0WallClockMs > 0) {
      const wallRate = args.phase0WallClockMs / args.phase0CharsDone;
      remaining += wallRate * STAGE2_STRETCH * args.phase1CharsRemaining;
    } else {
      remaining += args.fallbackPhase1Ms;
    }
  }
  return Math.max(0, Math.round(remaining));
}

function humanSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/* Compact identity prior carried in from prior books in the same series.
   The route assembles this via scanSeriesCharactersForBookId (C1) and
   passes it through to buildStage1ChapterInbox; the per-chapter prompt
   renders a "Known characters from prior books in this series" section
   so the model reuses existing ids by name/alias rather than
   re-inventing them. Distinct from voice-match (plan 09): the prior
   is detection-time, not confirm-time. */
export interface SeriesPriorCharacter {
  id: string;
  name?: string;
  aliases?: string[];
  description?: string;
  /** Display titles of every prior book in the series whose confirmed
      cast included this character. Multiple entries when a character
      recurs across volumes (e.g. Wren Sparrow across all of the Hollow Tide);
      single entry when the character only appears once. The Phase 0a
      prompt renders this as provenance so the model can disambiguate
      cross-book name collisions. */
  fromBookTitles?: string[];
}

/* Build the per-chapter Phase 0a inbox markdown that drives the
   Gemini / Ollama analyzer. Exported for unit testing — the test asserts
   that the template includes the broadened first-person guidance so
   journal / registry-file / bio chapters (The Floodmark format) get
   detected as their authoring character rather than as Narrator. */
export function buildStage1ChapterInbox(
  manuscriptId: string,
  title: string,
  chapter: { id: number; title: string; body: string },
  runningRoster: CharacterOutput[],
  seriesPrior: SeriesPriorCharacter[] = [],
  author = '',
): string {
  /* Compact roster format — only the identity fields the model needs to
     reuse ids verbatim. Skipping evidence/tone/description keeps each
     per-chapter call's prompt small even on book #15 of a series. */
  const rosterJson = JSON.stringify(
    runningRoster.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    null,
    2,
  );
  const rosterBlock =
    runningRoster.length === 0
      ? '_No characters detected yet — this is the first chapter being processed. Use kebab-case ids that will be stable across the rest of the book._'
      : `\`\`\`json\n${rosterJson}\n\`\`\``;

  /* Series-cast prior (C2). Rendered only when sibling books exist so
     standalones / first-in-series books don't carry a useless empty
     section. The prompt instructs the model to REUSE existing ids when
     a chapter speaker matches a known series character by name or
     alias — without this guidance The Floodmark's per-chapter detector
     would invent fresh ids like `marlow-2` instead of recognising the
     `marlow` already confirmed in the Coalfall Commission / the Hollow Tide. */
  const priorJson =
    seriesPrior.length > 0
      ? JSON.stringify(
          seriesPrior.map((p) => ({
            id: p.id,
            name: p.name,
            aliases: p.aliases?.length ? p.aliases : undefined,
            description: p.description,
            fromBookTitles: p.fromBookTitles?.length ? p.fromBookTitles : undefined,
          })),
          null,
          2,
        )
      : null;
  const priorBlock =
    priorJson === null
      ? ''
      : `
## Known characters from prior books in this series

The user has already confirmed these characters in earlier books in this series. If a speaker in this chapter matches one of them by **name** or **alias** (case-insensitive, ignoring punctuation), reuse their \`id\` **verbatim** — do not invent a new id. Mis-attributing a series-regular as a fresh character creates duplicate voice profiles and breaks downstream voice-match scoring. New characters introduced in this book that are NOT in the list should still get fresh kebab-case ids.

\`\`\`json
${priorJson}
\`\`\`
`;

  /* #2313 — `name` and `aliases` were the one part of a non-English roster
     nothing bound to the manuscript's script, so they were free to drift.
     Ночной дозор (ru) came back with a 59%-Latin roster
     (`anton-gorodovsky "Anton Gorodovsky"`) where an earlier run of the same
     book, same weights and the same prompt returned `"Антон Городецкий"`; a
     controlled 5x replay of the recorded prompt reproduced Latin 5/5.

     The gap is narrower than "no language guidance". `languagePreamble`
     (analyzer/gemini.ts) IS appended to the system instruction for a
     non-English book: "the manuscript text is in Russian (Cyrillic script).
     Quote evidence VERBATIM from the manuscript (do not translate or
     transliterate it)" — note the prohibition is scoped to EVIDENCE QUOTES,
     not to the response at large — and its `castFields` clause binds `tone`,
     `role`, `description` and each `attributes` tag to the book's language.
     It never mentions `name` or `aliases`. This block closes exactly that, and
     is NOT redundant with the preamble: nothing there governs the cast's names.

     Anchored on THE PROSE, not on a language name passed in from the route.
     Two reasons, both load-bearing: the chapter text is in front of the model
     and is self-evidencing; and `resolveBookLanguageForManuscript` cannot
     distinguish "English" from "never declared" — it returns 'en' on a miss and
     `normaliseBookLanguage` is `primary || 'en'` — so a stated language would
     assert `en` over Cyrillic prose for any book imported before fs-2 or left
     undecided at the confirm screen, which is precisely the drift case. Those
     books get an empty `languagePreamble` too, so this block is their only
     protection and must not depend on the same unreliable signal.

     The `id` carve-back is not optional. "Transliterate for the id" renders
     ABOVE the running-roster and series-prior blocks, which require reusing an
     existing id verbatim. Without the exception, a model correctly repairing a
     drifted `"Anton Gorodovsky"` back to `"Антон Городецкий"` would then derive
     `anton-gorodetsky` beside the roster's existing `anton-gorodovsky` — and
     `mergeRosterChapter` merges by id, so the character SPLITS into two rows,
     two voice profiles and two sets of lines. That arrives past
     `retireCharacterId`/`buildCastResolver`, which watch for an id that
     CHANGED, not for a second one being minted. */
  const scriptBlock = `
## Names — use the manuscript's own script

Write every \`name\` and every entry in \`aliases\` **exactly as this chapter's
prose spells them** — same script, same letters, same diacritics. Never
transliterate, romanise, or translate a name: for a Russian chapter that means
\`Антон Городецкий\`, NOT \`Anton Gorodetsky\`.

A transliterated name cannot be matched against this book's text by the later
attribution pass, and it is what the reader sees in the cast list.

\`id\` is the ONE exception: it stays ASCII kebab-case, so transliterate for the
id and only for the id — \`Антон Городецкий\` → \`anton-gorodetsky\`. **Unless
the character already appears in the running roster below, or — when this prompt
carries one — in the known-series list: then reuse that \`id\` exactly as written
there, whatever its spelling, even when you are correcting their \`name\`.**
Minting a second id for someone already listed splits them into two characters.
`;

  /* #938 — the book's byline author is NOT a character. Rendered only when known. */
  const authorBlock = author.trim()
    ? `
## Book author — NOT a character

The byline author of this book is **${author.trim()}**. This is the real-world author printed on the cover — they are NOT a character in the story. Do NOT add them to the roster, and never assign the narrator's prose or the protagonist's first-person lines to them — UNLESS this chapter is an explicitly-framed author's note/letter in which the author speaks in the first person about the book.
`
    : '';

  return `---
manuscriptId: ${manuscriptId}
stage: 1-ch${chapter.id}
---

# Phase 0a — Per-chapter cast detection

Identify every speaking character that appears in the chapter below — new and
recurring — and return them as a single JSON object. Reuse running-roster ids
verbatim.

**Only return characters with a real verbatim utterance in this chapter.**
A character belongs in the output when at least one of the following is
true:

1. They have a line of **direct dialogue** the narrator attributes to
   them (\`"Hello," she said.\`).
2. The chapter is a **first-person document** (journal entry, medical
   log, registry file, diary, letter, transcript, bio page) AND the
   author of that document is named or strongly implied — by chapter
   title (\`Wren's Memory Log\`), header (\`FILED BY: ODUVAN\`),
   signature (\`—Marlow\`), or the surrounding bio block. In that case
   the *author* is the character, with their \`id\` set to their name,
   and the document's prose becomes their evidence. \`narrator\` is
   reserved for omniscient third-person prose with no in-fiction author.
   A whole **first-person novel is NOT** such a document — its first-person
   voice is the protagonist/narrator, NOT the book's author; never roster the
   byline author as that voice.
   The first-person «я» voice is exactly ONE character. NEVER create a
   character whose name is a bare pronoun (я, I, ich, …) — that is not a
   character. Attribute first-person NARRATION to \`narrator\`; attribute
   first-person SPOKEN dialogue to the single protagonist and record «я» in
   that protagonist's aliases. Do NOT spread first-person lines across
   several characters, and never attach a first-person line as evidence to a
   secondary character.

**An explicit \`<Name> <speech-verb>\` dialogue tag is binding** — \`"…,"
Lessom repeated.\`, \`"Fine," Sela agreed.\`, \`"Where?" Wren asked.\`
The tagged Name MUST appear in the output, every time, no matter how few
lines they have or whether they are mostly *addressed* by others. A single
tagged line is decisive; omitting a minor-but-tagged speaker dumps their
quoted lines on the narrator — the exact failure to avoid.

Pets, animals, magical creatures, and any entity whose only "lines" are
non-verbal sounds (purring, growling, hissing, roaring) do NOT belong on
the roster — the narrator covers them. If a running-roster character
appears only by being mentioned or described in this chapter (no spoken
line and not the author of the chapter's prose), omit them from this
chapter's output.

**Name fidelity — do not invent or copy names.** Set each character's
\`name\` to exactly how THIS text refers to them. Never add a surname,
patronymic, honorific, or title that the text does not use for that
specific character, and never copy another character's surname onto them
— even if other characters or the running roster have one. If the text
only ever calls someone "Игорь" / "Olga", their name is "Игорь" / "Olga",
not "Игорь Smith" / "Olga Petrova". \`aliases\` are ONLY for alternate
forms the text itself uses for the SAME person (a nickname the narration
explicitly attaches, a first-name/full-name pair the text equates).

**Do not merge distinct characters.** Two characters with different names
are SEPARATE people unless this text explicitly equates them (e.g.
"Игорь, whom everyone called Гарик"). Do NOT fold one into the other via
\`aliases\` just because the names are similar, or because one is a common
nickname of the other in general — only the text of THIS book decides.
When unsure, keep them separate.

Return ONLY a JSON object matching the schema. No prose, no code fences.

## Manuscript metadata

- Title: ${title}
- Manuscript ID: ${manuscriptId}
- Chapter: ${chapter.id} — ${chapter.title}
${scriptBlock}
## Running roster (from earlier chapters — reuse these ids verbatim)

For any character below who appears in this chapter, use the existing \`id\`
**verbatim**. The server merges by id; a stylistic variation creates a
duplicate roster entry.

${rosterBlock}
${priorBlock}${authorBlock}
## Chapter

${chapter.body}
`;
}

/* Target C — the shared stage-2 attribution rules, injected into the
   whole-chapter stage-2 inbox builder only. The chunk builder deliberately
   omits it: the untagged-continuation / two-hander rules misfire across chunk
   boundaries on multi-speaker chapters (on-box eval showed a ch44 raw
   regression). Language-/quote-agnostic by construction (see the lead line) so
   it does not misfire on «…» / „…" or non-English text. Kept deliberately
   short — every rule earns its tokens. */
export const STAGE2_ATTRIBUTION_RULES = `## Attribution rules

Apply these when assigning each sentence's speaker. They hold whatever
quotation marks the text uses — \`"…"\`, \`«…»\`, \`„…"\`, \`“…”\` — and in any
language:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   \`"…," said X\` / \`"…," X asked\` / \`"…," whispered X\` — the speaker is X,
   whatever the surrounding lines suggest.
2. An action beat names the speaker. A quote sharing a paragraph with a
   character's action belongs to that character: \`X folded her arms. "Get
   out."\` and \`"Get out." X turned away.\` are both spoken by X.
3. Untagged quotes continue, and two-handers alternate. An untagged quote keeps
   the last established speaker. In a sustained back-and-forth between exactly
   two characters, untagged quotes alternate between them.
4. Narration is the narrator. Non-dialogue prose — description, action,
   scene-setting — is \`narrator\`, even between two characters' lines. Only words
   inside quote marks belong to a character (unless the whole chapter is a
   first-person document).
5. The addressee is not the speaker. A name spoken to someone ("Careful,
   Anton.") marks who is addressed, not who speaks — never attribute the line to
   the person being addressed.`;

/* #1758 — the chunk-path variant of the attribution rules. Rules 1, 2, 4, 5 are
   byte-identical to STAGE2_ATTRIBUTION_RULES (all boundary-safe: explicit tag,
   same-paragraph action beat, narration, addressee). Only rule 3 is rewritten to
   scope continuation/alternation WITHIN the section — a chunk that opens
   mid-conversation has no in-band anchor for two-hander alternation parity, so
   telling the model to alternate across the seam flipped the whole run (the ch44
   both-builders regression). The "Speaker at section start" seed (buildStage2ChunkInbox)
   powers only rule 3's continuation clause; alternation is disclaimed across the seam.
   A drift-guard unit test pins rules 1/2/4/5 identical between the two constants. */
export const STAGE2_ATTRIBUTION_RULES_CHUNK = `## Attribution rules

Apply these when assigning each sentence's speaker. They hold whatever
quotation marks the text uses — \`"…"\`, \`«…»\`, \`„…"\`, \`“…”\` — and in any
language:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   \`"…," said X\` / \`"…," X asked\` / \`"…," whispered X\` — the speaker is X,
   whatever the surrounding lines suggest.
2. An action beat names the speaker. A quote sharing a paragraph with a
   character's action belongs to that character: \`X folded her arms. "Get
   out."\` and \`"Get out." X turned away.\` are both spoken by X.
3. Untagged quotes continue, and two-handers alternate — within this section. An
   untagged quote keeps the last speaker established here (or the "Speaker at
   section start" named below, for the first quote). Do NOT assume a two-hander's
   alternation carries in from before this section's start; near the start, rely
   on dialogue tags and action beats rather than alternation parity.
4. Narration is the narrator. Non-dialogue prose — description, action,
   scene-setting — is \`narrator\`, even between two characters' lines. Only words
   inside quote marks belong to a character (unless the whole chapter is a
   first-person document).
5. The addressee is not the speaker. A name spoken to someone ("Careful,
   Anton.") marks who is addressed, not who speaks — never attribute the line to
   the person being addressed.`;

/* One stage-2 roster entry. Plan 291 (#4031): a joined row carries the prior id and
   display name, so the analyzer's own name for it survives only as an alias - list
   the aliases, or the model sees a name it never used for that speaker. */
function stage2RosterEntry(c: Stage1Output['characters'][number]): {
  id: string;
  name: string;
  role: string;
  aliases?: string[];
} {
  return { id: c.id, name: c.name, role: c.role, ...(c.aliases?.length ? { aliases: c.aliases } : {}) };
}

export function buildStage2ChapterInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
  firstPersonId: string | null,
): string {
  const firstPersonBlock = firstPersonId
    ? `## First-person narrator

This manuscript is narrated in the FIRST PERSON. Every first-person pronoun («я», «меня», «мне», «мной», «мы») refers to character id \`${firstPersonId}\`. Attribute first-person narration and any first-person spoken line to \`${firstPersonId}\` UNLESS a dialogue tag explicitly names a different speaker. Never route a first-person line to another character merely because that character is prominent nearby.

`
    : '';
  return `---
manuscriptId: ${manuscriptId}
stage: 2
chapterId: ${chapter.id}
---

# Stage 2 — Sentence attribution (Chapter ${chapter.id})

For every sentence in the single chapter below, return the speaking character
(or 'narrator' for non-dialogue prose) as a single JSON object.

All \`chapterId\` values in the output MUST be \`${chapter.id}\`. Return ONLY a
JSON object matching the schema. No prose, no code fences.

## Manuscript

- Title: ${title}
- Manuscript ID: ${manuscriptId}
- Chapter: ${chapter.id} — ${chapter.title}

## Characters (from stage 1)

Only the \`id\` is load-bearing for stage 2 (you assign sentences by character
id). Name, aliases and role are included for disambiguation when the manuscript
refers to the same person by multiple forms. The richer tone / evidence /
description fields from stage 1 are intentionally elided to keep the call
fast — refer back to them only if you genuinely can't disambiguate.

\`\`\`json
${JSON.stringify(
  stage1.characters.map(stage2RosterEntry),
  null,
  2,
)}
\`\`\`

${STAGE2_ATTRIBUTION_RULES}

${firstPersonBlock}## Chapter ${chapter.id} — ${chapter.title}

${chapter.body}
`;
}

/* Stage-2 inbox for ONE SECTION of a large chapter (#528 chunking). Same roster
   as buildStage2ChapterInbox, plus the chunk-variant attribution rules block
   (STAGE2_ATTRIBUTION_RULES_CHUNK, #1758) and an optional last-speaker seed —
   the body is a sub-section and an optional "preceding context" block carries
   the prior section's tail so an untagged quote keeps its speaker across the
   seam. The model must attribute ONLY the section, not the context. The chunk
   runner renumbers ids across sections, so per-section 1-based numbering is
   fine. */
export function buildStage2ChunkInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
  subBody: string,
  precedingContext: string | null,
  firstPersonId: string | null,
  lastSpeakerId: string | null,
): string {
  const contextBlock = precedingContext
    ? `## Preceding context (already attributed — do NOT include in your output)

These paragraphs come immediately BEFORE the section to attribute, provided
ONLY so you can carry a speaker across the boundary (e.g. an untagged quote
whose speaker was named just before). Do NOT emit any sentences for this text.

${precedingContext}

`
    : '';
  const seedBlock = lastSpeakerId
    ? `## Speaker at section start

The last character to speak before this section was \`${lastSpeakerId}\`. Treat the
first untagged quote in this section as continuing \`${lastSpeakerId}\`, unless a
dialogue tag or action beat names a different speaker.

`
    : '';
  const firstPersonBlock = firstPersonId
    ? `## First-person narrator

This manuscript is narrated in the FIRST PERSON. Every first-person pronoun («я», «меня», «мне», «мной», «мы») refers to character id \`${firstPersonId}\`. Attribute first-person narration and any first-person spoken line to \`${firstPersonId}\` UNLESS a dialogue tag explicitly names a different speaker. Never route a first-person line to another character merely because that character is prominent nearby.

`
    : '';
  return `---
manuscriptId: ${manuscriptId}
stage: 2
chapterId: ${chapter.id}
---

# Stage 2 — Sentence attribution (Chapter ${chapter.id}, section)

This is ONE SECTION of a large chapter. For every sentence in the **section to
attribute** below, return the speaking character (or 'narrator' for non-dialogue
prose) as a single JSON object.

All \`chapterId\` values in the output MUST be \`${chapter.id}\`. Return ONLY a
JSON object matching the schema. No prose, no code fences.

## Manuscript

- Title: ${title}
- Manuscript ID: ${manuscriptId}
- Chapter: ${chapter.id} — ${chapter.title}

## Characters (from stage 1)

Only the \`id\` is load-bearing for stage 2 (you assign sentences by character
id). Name, aliases and role are included for disambiguation.

\`\`\`json
${JSON.stringify(
  stage1.characters.map(stage2RosterEntry),
  null,
  2,
)}
\`\`\`

${STAGE2_ATTRIBUTION_RULES_CHUNK}

${contextBlock}${seedBlock}${firstPersonBlock}## Section to attribute (Chapter ${chapter.id} — ${chapter.title})

${subBody}
`;
}

/* srv-59 — roster character whose aliases include the language's
   first-person pronoun (the "я" -> Антон first-person-narrator case). Null
   when the language has no first-person pronoun convention or no roster
   character claims it. */
function findFirstPersonCharacter(
  characters: Array<{ id: string; aliases?: string[] }>,
  conv: LanguageConventions,
): string | null {
  if (!conv.pronouns.firstPerson) return null;
  const hit = characters.find((c) =>
    (c.aliases ?? []).some((a) => conv.pronouns.firstPerson!.test(` ${a} `)),
  );
  return hit?.id ?? null;
}

/* srv-59 — roster gender lookup for windows.ts's pronoun resolution.
   Defaults an ungendered character to 'neutral' (never guessed). */
function rosterGenderMap(
  characters: Array<{ id: string; gender?: string }>,
): WindowRoster {
  return Object.fromEntries(
    characters.map((c) => [c.id, (c.gender as 'male' | 'female' | 'neutral') ?? 'neutral']),
  );
}

/* srv-59 Task 9b — `analyzer.structure.escalation === 'cloud'` routing.
   Mirrors selectAnalyzer's gemini branch (analyzer/index.ts ~180-194): a
   dedicated GeminiAnalyzer, independent of whichever engine is running the
   chapter's main stage-2 attribution. Escalation is best-effort, so a
   missing API key skips escalation for the chapter (warn + null) rather
   than throwing and failing the whole analysis over a second-pass extra. */
function buildCloudEscalationAnalyzer(): Analyzer | null {
  const apiKey = getResolvedGeminiApiKey();
  if (!apiKey) {
    console.warn(
      '[analysis:structure] escalation mode is "cloud" but no Gemini API key is configured — skipping escalation.',
    );
    return null;
  }
  const model = configValue<string>('analyzer.gemini.model');
  return new GeminiAnalyzer({ apiKey, model });
}

/* Shared resilient stage-2 runner used by BOTH the main and subset routes
   (#528). Wraps the chapter in the large-chapter chunker (which itself wraps
   each call in the coverage guard), so an over-budget chapter is split into
   sections instead of truncating, and a chunk that still truncates is
   adaptively re-split. For a chapter within budget this is exactly one guarded
   call against the full body (byte-identical to the prior behaviour). Returns
   the stitched sentences + combined coverage verdict. */
export async function attributeChapterStage2(opts: {
  analyzer: Analyzer;
  manuscriptId: string;
  title: string;
  stage1: Stage1Output;
  chapter: { id: number; title: string; body: string };
  stageCall: StageCall;
  /* Plan 291 (#4031): what the plan says about each roster row. The main job passes
     it so this prompt dedup and the post-stage-2 `dedupAndPrepare` agree; omitted
     (the subset job, until it plans), every row is an unplanned new row. */
  dedupConstraints?: DedupConstraints;
  /* Phase-1 analyzer capacity (#3084 wave 2) — sizes the chunk budget: a
     context-family capacity (local Ollama) derives it from num_ctx so a fat
     input chunk doesn't starve the output window (#528 follow-up; 2026-06-14
     qwen3.5:4b truncation). Omitted → the request-cap budget at the registry
     cap, as an omitted engine behaved before. */
  capacity?: EngineCapacity;
  onCoverageRetry?: (attempt: number, verdict: { issues: string[] }) => void;
  /** Fired when the coverage retry stopped early because the failure was
      reproduced exactly — deterministic, so more attempts cannot help. */
  onCoverageExhausted?: (attempts: number, verdict: { issues: string[] }) => void;
  /** #2304 — fired when a deterministic coverage failure actually PROCEEDS to a
      re-split. `onCoverageExhausted` only says the retry stopped; the split
      still declines for an indivisible span or at the depth limit, and it
      happens inside a recursion that touches neither `chunkCount` nor
      `onSectionDone`. Without this the escalation is unobservable. */
  onDeterministicSplit?: (info: { parts: number; chars: number; depth: number }) => void;
  onChunk?: (info: { index: number; total: number; chars: number }) => void;
  onSectionDone?: (index: number, sentenceCount: number) => void;
  /* srv-59 Task 9b — per-BOOK escalation-window budget, shared/mutable
     across every chapter's call (the caller creates ONE object and threads
     it through). Falls back to a fresh per-call budget when omitted, so
     existing callers keep working (just without the cross-chapter cap). */
  structureBudget?: { remainingWindows: number };
  /* srv-59 Task 9b (review follow-up) — the 'cloud' escalation analyzer,
     built ONCE per book by the caller (mirrors structureBudget) and threaded
     through every chapter's call so a book doesn't construct a throwaway
     GeminiAnalyzer (and re-warn on a missing API key) per chapter. `null`
     means "already resolved this book, no key configured" — distinct from
     `undefined` ("caller didn't thread it"), which falls back to the old
     per-call construction for any caller that hasn't been migrated. Only
     consulted when `analyzer.structure.escalation === 'cloud'`. */
  escalationAnalyzer?: Analyzer | null;
  /* Attribution-eval hook (Task 5) — when provided, called exactly once per
     chapter with structured-clone snapshots of the raw model output and the
     deterministic (post-crossExamine) pass, plus the per-sentence `reasons`
     from CrossExamineResult. Purely additive: with no callback, no clones
     are taken and runtime behaviour is byte-identical. */
  onStages?: (stages: {
    raw: SentenceOutput[];
    deterministic: SentenceOutput[];
    reasons: Array<{ index: number; reason: string; bucket: DecisionBucket }>;
  }) => void;
}): Promise<Stage2ChunkRunResult> {
  /* Task 9 — consolidate the roster BEFORE stage-2 so the model sees CLEAN ids.
     The raw stage-1 roster routinely hands the model a bare first-person-pronoun
     phantom («Я») and the same character split across several ids (Антон /
     Антон Городецкий / …). The model then attributes to the pronoun row and
     spreads one person's lines across the fragments. Merge them up front —
     exactly as the final cast build merges them — via `dedupeRosterByName` with
     no sentences (deterministic: name/token structure only, no line counts). The
     post-stage-2 `dedupAndPrepare` re-runs dedup on the raw roster and remaps any
     survivor-id difference onto the same final id, so sentence ids stay
     consistent. This also lets the «я» prompt-anchor below fire whenever a merged
     row carries «я» as an alias. */
  const stage1: Stage1Output = {
    ...opts.stage1,
    characters: dedupeRosterByName(opts.stage1.characters, [], {
      language: opts.stageCall.language,
      constraints: opts.dedupConstraints ?? EMPTY_DEDUP_CONSTRAINTS,
    }).characters,
  };
  /* RC3 — thread the known first-person narrator id into the stage-2 prompt
     itself (not just the deterministic structure engine below) so the model
     doesn't need to infer «я» from role/prominence alone. Computed once per
     chapter, independent of the `analyzer.structure.enabled` gate that guards
     the deterministic engine's own (separate) computation further down. */
  const fpConventions = conventionsFor(opts.stageCall.language);
  const firstPersonId = fpConventions
    ? findFirstPersonCharacter(stage1.characters, fpConventions)
    : null;
  const callForBody = (
    subBody: string,
    preceding: string | null,
    lastSpeakerId: string | null,
    callSeq: number | undefined,
  ) => {
    const prompt =
      preceding === null && subBody === opts.chapter.body
        ? buildStage2ChapterInbox(opts.manuscriptId, opts.title, stage1, opts.chapter, firstPersonId)
        : buildStage2ChunkInbox(
            opts.manuscriptId,
            opts.title,
            stage1,
            opts.chapter,
            subBody,
            preceding,
            firstPersonId,
            lastSpeakerId,
          );
    return opts.analyzer.runStage2Chapter(
      opts.manuscriptId,
      opts.chapter.id,
      prompt,
      /* #2324 — carry this call's sequence so the analyzer keys its handoff
         forensics per call. Spread rather than mutate: `stageCall` is created
         once per chapter and shared across every section, so assigning to it
         would race the concurrent chapter running in the other analyzer slot.
         An undefined callSeq still adds no stage2CallSeq key. */
      { ...opts.stageCall, inputBody: subBody, ...(callSeq === undefined ? {} : { stage2CallSeq: callSeq }) },
    );
  };
  const result = await runStage2ChapterChunked({
    body: opts.chapter.body,
    charBudget: resolveStage2ChunkCharBudget(opts.capacity, opts.chapter.body),
    coverageRetries: resolveStage2CoverageRetries(),
    /* #2325 — the language's own dialogue marker, so a section that hands every
       spoken line to the narrator fails the coverage guard and is retried
       rather than persisted. Reuses `fpConventions`, already resolved above and
       independent of the structure-engine knob — the collapse this catches is a
       stage-2 failure, so the check must not disappear when the deterministic
       engine is turned off. undefined for a language with no marker (English),
       leaving the guard byte-identical to before. */
    dialogueOpen: fpConventions?.dialogueOpen ?? undefined,
    callForBody,
    onRetry: opts.onCoverageRetry,
    onExhausted: opts.onCoverageExhausted,
    onDeterministicSplit: opts.onDeterministicSplit,
    onChunk: opts.onChunk,
    onSectionDone: opts.onSectionDone,
  });
  const rawSnapshot = opts.onStages ? structuredClone(result.sentences) : null;
  let detSnapshot: SentenceOutput[] | null = null;
  let detReasons: Array<{ index: number; reason: string; bucket: DecisionBucket }> = [];
  /* srv-59 — deterministic dialogue-structure engine: replays the model's
     per-sentence attribution against the chapter's structural evidence (dash/
     quote dialogue tags, conversation-window alternation, pronoun resolution)
     and derives an honest confidence for every sentence, auto-correcting
     tag-proven misattributions. The engine itself is gated by the
     `analyzer.structure.enabled` knob AND language support; #2245 split
     conventions resolution off the knob (it was `knob ? conventionsFor(lang)
     : null`, so turning the engine off also threw the language away) so the
     ELSE branch's `applyNarratorDefault` fallback still gets the right
     per-language quote rules even with the knob off — mirrors `fpConventions`
     above, which already resolves conventions independently of this knob. */
  const conventions = conventionsFor(opts.stageCall.language);
  if (configValue<boolean>('analyzer.structure.enabled') && conventions) {
    const index = buildNameIndex(stage1.characters, conventions);
    const paras = parseChapterStructure(opts.chapter.body, index);
    const firstPersonId = findFirstPersonCharacter(stage1.characters, conventions);
    resolveWindows(paras, rosterGenderMap(stage1.characters), firstPersonId);
    const alignment = alignSentences(result.sentences, paras, opts.chapter.body, conventions.dialogueOpen !== null);
    const rosterIds = new Set(stage1.characters.map((c) => c.id));
    const examined = crossExamine(alignment, {
      rosterIds,
      unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
      alignmentFloorPct: 80,
      /* #2253 — the language's own turn marker, so a merged paragraph (#2254)
         costs the engine its structural evidence but not the speaker. */
      dialogueOpen: conventions.dialogueOpen,
    });
    result.sentences = examined.sentences;
    if (opts.onStages) { detSnapshot = structuredClone(examined.sentences); detReasons = examined.reasons; }

    /* Task 9b — second-pass re-query of the windows crossExamine couldn't
       resolve. 'off' disables the model re-query entirely (the deterministic
       engine still runs unchanged above); 'cloud' routes through a dedicated
       GeminiAnalyzer instead of whichever engine ran the main attribution. */
    const escalationMode = configValue<string>('analyzer.structure.escalation');
    if (escalationMode !== 'off' && !examined.report.flagOnly) {
      const escalationAnalyzer =
        escalationMode === 'cloud'
          ? opts.escalationAnalyzer !== undefined
            ? opts.escalationAnalyzer
            : buildCloudEscalationAnalyzer()
          : opts.analyzer;
      if (escalationAnalyzer) {
        const budget = opts.structureBudget ?? {
          remainingWindows: configValue<number>('analyzer.structure.maxWindowsPerBook'),
        };
        const escalationOutcome = await escalateFlaggedWindows({
          sentences: examined.sentences,
          flags: examined.flags,
          paras,
          body: opts.chapter.body,
          analyzer: escalationAnalyzer,
          manuscriptId: opts.manuscriptId,
          chapterId: opts.chapter.id,
          stageCall: opts.stageCall,
          rosterIds,
          budget,
          maxWindowsPerChapter: configValue<number>('analyzer.structure.maxWindowsPerChapter'),
        });
        examined.report.escalated = escalationOutcome.attempted;
        examined.report.escalationAccepted = escalationOutcome.applied;
      }
    } else if (escalationMode !== 'off' && examined.report.flagOnly) {
      console.log(
        `[analysis:structure] ch=${opts.chapter.id} below alignment floor (${examined.report.alignedPct.toFixed(0)}%) — escalation skipped`,
      );
    }

    result.structureReport = { ...examined.report, language: conventions.language };
    /* #2275 C4 — the `merged=` reading used to be logged only from HERE,
       inside this engine-gated branch, which a fully-cached run (every
       chapter served from the stage-2 cache) never reaches at all — exactly
       the case design of record §4 exists to protect. It is now logged
       up front at the `runMainAnalyzerJob`/`runSubsetAnalyzerJob` call sites
       instead (skipped there when the reading is undefined), so this line
       no longer repeats it. */
    console.log(
      `[analysis:structure] ch=${opts.chapter.id} aligned=${examined.report.alignedPct.toFixed(0)}% ` +
        `confirmed=${examined.report.confirmed} corrected=${examined.report.corrected} ` +
        `flagged=${examined.report.flagged} unresolved=${examined.report.unresolved} ` +
        `escalated=${examined.report.escalated} escalationAccepted=${examined.report.escalationAccepted}`,
    );
  } else {
    /* Deterministic narrator-default: force non-spoken sentences to `narrator`
       and flag the first of each demoted block low-confidence. Runs for every
       language that has a conventions table, AFTER coverage (coverage keys on
       text, not characterId, so the verdict is unchanged) and UPSTREAM of
       fold/reconcile. `conventions === null` (no table) is a no-op inside
       applyNarratorDefault — no basis to judge, so nothing is demoted. */
    result.sentences = applyNarratorDefault(result.sentences, conventions);
    if (opts.onStages) { detSnapshot = structuredClone(result.sentences); detReasons = []; }
  }

  /* #1679 — read-only scene-break display flags, computed once on the FINAL
     post-attribution sentences. Placed here (after BOTH the conventions and
     applyNarratorDefault branches converge) so dividers populate on every
     chapter regardless of language or structure-engine state. Mutates only the
     sceneBreakBefore flag. */
  annotateSceneBreaks(result.sentences, opts.chapter.body, conventions?.dialogueOpen != null);
  if (opts.onStages && rawSnapshot) {
    opts.onStages({
      raw: rawSnapshot,
      deterministic: detSnapshot ?? structuredClone(result.sentences),
      reasons: detReasons,
    });
  }
  return result;
}

/** #3084 P20/F7 — "stop new spend". Marks the job and empties the book's
    escalation budget: the object every chapter's attributeChapterStage2 call
    shares (:3695, :6855), which escalateFlaggedWindows checks before each
    window (escalation.ts:235), so no chapter still in flight starts another
    window. Marking aborts nothing by itself; when the run then ends, endJob
    aborts the chapters still in flight (#3435 decision E, superseding N4's
    "they finish and cache"). `chapter` records WHICH chapter
    was calling the model when the overflow happened, for the terminal
    failure's copy (F7 — "naming the chapter"); only the FIRST overflow's
    chapter is kept, mirroring `reasoningOverflowError`'s own ??=. `phase` is
    the phase whose model made the overflowing call (#3435), kept the same
    way, so the terminal failure names that phase's model. Returns
    whether `err` was a reasoning overflow. */
export function noteReasoningOverflow(
  job: AnalysisJob,
  structureBudget: { remainingWindows: number },
  err: unknown,
  chapter: { id: number; title?: string } | undefined,
  phase: 0 | 1,
): boolean {
  if (!(err instanceof AnalyzerReasoningOverflowError)) return false;
  job.reasoningOverflowed = true;
  job.reasoningOverflowError ??= err;
  job.reasoningOverflowChapter ??= chapter;
  job.reasoningOverflowPhase ??= phase;
  structureBudget.remainingWindows = 0;
  return true;
}

/** #3084 P20 — the chapter pools' dispatch check. A job marked by a reasoning
    overflow starts no further chapter: this rethrows the recorded overflow, so
    the pool ends through the same terminal handler (classifyAnalysisFailure →
    endJob → a `halted` snapshot) as an overflow a stage call rethrew. Without
    it, an overflow that only escalation saw (swallowed by the runner, reported
    through StageCall.onReasoningOverflow) would stop escalation windows but not
    the next chapter's stage-2 call. */
function throwIfReasoningOverflowed(job: AnalysisJob): void {
  if (job.reasoningOverflowed) throw job.reasoningOverflowError;
}

/** #3084 P30 — Signal-2 fails open: any error treats the chapter as a story. A prompt refused before
    a fallback target could take it keeps that outcome but is logged, so the skip is never silent. */
export function nonStoryClassificationFailed(err: unknown, manuscriptId: string, chapterId: number): false {
  if (err instanceof AnalysisAbortedError) throw err;
  if (err instanceof AnalyzerTargetInputTooLargeError) {
    console.warn(`[analysis] ${manuscriptId}: chapter ${chapterId} non-story check skipped: ${err.message}`);
  }
  return false;
}

/** #3084 P20 — Signal-2 non-story classification for the third-party
    front-matter guard, shared by the main and subset jobs. It replaces their
    two inline copies (:5814-5836, :7540-7566) and keeps their behaviour. Once
    the job has seen a reasoning overflow it makes no further call. A call that
    overflows marks the job and reads as story, like any other Signal-2 stumble. */
export function buildNonStoryClassifier(opts: {
  job: AnalysisJob;
  structureBudget: { remainingWindows: number };
  analyzer: Analyzer;
  manuscriptId: string;
  bookTitle: string | null;
  bookLanguage: string;
  /** #3084 wave 3d — the caller's switch handler (log, relabel, mark the target): this call can be the one that switches. */
  onFallback?: StageCall['onFallback'];
}): ((ch: ThirdPartyGuardChapter) => Promise<boolean>) | undefined {
  const { job, structureBudget, analyzer, manuscriptId, bookTitle, bookLanguage, onFallback } = opts;
  if (!analyzer.runNonStoryClassification) return undefined;
  return async (ch: ThirdPartyGuardChapter): Promise<boolean> => {
    if (job.reasoningOverflowed) return false;
    const promptMd = `Title: ${ch.title ?? '(untitled)'}\n\n${ch.body}`;
    /* srv-61 — the SAME StageCall goes to the runner and withPassEval, so its
       fresh-per-call accumulator attaches to this call. */
    /* #3435 decision E — the job's signal, so ending the run aborts this call too. */
    const nonStoryCall: StageCall = { language: bookLanguage, signal: job.controller.signal, onFallback };
    try {
      const out = await withPassEval(
        nonStoryCall,
        { manuscriptId, bookTitle, stage: 'nonstory', chapterId: ch.id },
        () => analyzer.runNonStoryClassification!(manuscriptId, ch.id, promptMd, nonStoryCall),
        () => null,
      );
      return out.nonStory;
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      /* #3084 F7 — this classifier already has the chapter (`ch`). */
      noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }, 0);
      return nonStoryClassificationFailed(err, manuscriptId, ch.id);
    }
  };
}

/** Wrap attributeChapterStage2 so its many chat() sub-calls fold into ONE
    per-(chapter, pass) eval-rate record. Exported so the wiring test can drive
    it directly. `runChapter` calls this instead of attributeChapterStage2. */
export function attributeChapterStage2WithEval(
  opts: Parameters<typeof attributeChapterStage2>[0],
): Promise<Stage2ChunkRunResult> {
  return withPassEval(
    opts.stageCall,
    {
      manuscriptId: opts.manuscriptId,
      bookTitle: opts.title ?? null,
      stage: 'stage2-ch',
      chapterId: opts.chapter.id,
    },
    () => attributeChapterStage2(opts),
    (r) => r.chunkCount ?? null,
  );
}

/** #2342 item 2 — a failed `Stage2CoverageVerdict` used to always report
    `attribution-incomplete`, whose copy claims the model's answer "did not
    cover every sentence" and that a retry "usually fills the gaps". That is
    true for a truncation/repeat-loop/no-sentences/duplicated-block failure,
    but false on every count for a dialogue COLLAPSE: every sentence WAS
    covered — they were all handed to the narrator (`narratedSpeech` breach)
    or the dialogue markers were lost outright (`markersLost`).

    `isIncomplete` and `isCollapse` are NOT disjoint bits (review round 3
    corrected an earlier version of this comment that claimed they were,
    contradicting its own very next paragraph): `markersLost` is gated
    `!truncated && !excess` (see validateStage2Coverage), which rules out
    overlap with those two specifically, but NOT with `duplicatedBlock` — a
    repeat-loop can independently lose its dialogue markers across the
    (possibly duplicated) span, so `markersLost && duplicatedBlock` is a real,
    reachable state. `isDialogueCollapseBreach` is gated on nothing from
    `isIncomplete` at all — it is computed purely from the attributed
    sentences' own `characterId`s, so a truncated, excess, or duplicated take
    can ALSO breach the collapse threshold on whatever fraction of dialogue it
    does contain. So a verdict can genuinely fail both ways, and the function
    below is a deliberate PRECEDENCE between two possibly-overlapping
    readings, not a dispatch between two mutually exclusive ones.

    The precedence: a verdict that fails BOTH ways (e.g. a re-split section
    that is both truncated AND lost its markers, or a repeat-loop that also
    collapses) keeps `attribution-incomplete` — deliberately, per the #2342
    spec: missing prose is the more serious problem, and
    `attribution-incomplete`'s remediation (retry to fill the gap) is the one
    that actually helps; `attribution-collapse`'s remediation would tell the
    user their cast was ignored while the bigger problem is that the chapter
    is missing text. */
export function selectStage2FailureCode(verdict: Stage2CoverageVerdict): FailureCode {
  const isIncomplete = verdict.noSentences || verdict.truncated || verdict.excess || !!verdict.duplicatedBlock;
  if (isIncomplete) return 'attribution-incomplete';
  const isCollapse = verdict.markersLost || isDialogueCollapseBreach(verdict.narratedSpeech);
  return isCollapse ? 'attribution-collapse' : 'attribution-incomplete';
}

/** srv-59 Task 11 — roll up every chapter's `structureReport` (set only when
    the dialogue-structure engine actually ran for that chapter — see
    `attributeChapterStage2` above) into the single `report` slice persisted
    on `BookStateJson.analysisProvenance`. Returns undefined when `reports` is
    empty — the engine was off (or every chapter in this pass came back from
    the stage-2 cache, which doesn't carry a stored EngineReport) — so the
    caller omits `report` entirely rather than persisting a zeroed-out one.

    `confirmed`/`corrected`/`flagged`/`unresolved`/`escalated`/`escalationAccepted`
    are plain sums. `alignedPct` is a per-chapter-sentence-count-weighted mean
    (weight = confirmed+corrected+flagged+unresolved+lumped, i.e. every
    sentence crossExamine classified for that chapter) rather than a flat
    average of percentages, so one huge chapter doesn't get diluted to the
    same weight as a two-sentence one. */
export function aggregateStructureReports(
  reports: EngineReport[],
): AnalysisProvenanceReport | undefined {
  if (reports.length === 0) return undefined;
  let confirmed = 0;
  let corrected = 0;
  let flagged = 0;
  let unresolved = 0;
  let escalated = 0;
  let escalationAccepted = 0;
  let weightedAlignedSum = 0;
  let totalWeight = 0;
  for (const r of reports) {
    confirmed += r.confirmed;
    corrected += r.corrected;
    flagged += r.flagged;
    unresolved += r.unresolved;
    escalated += r.escalated;
    escalationAccepted += r.escalationAccepted;
    /* #2253 — `unresolved` was carved out of `flagged`; omitting it here would
       silently shrink each chapter's weight and skew the book alignedPct. */
    const weight = r.confirmed + r.corrected + r.flagged + r.unresolved + r.lumped;
    weightedAlignedSum += r.alignedPct * weight;
    totalWeight += weight;
  }
  return {
    // totalWeight === 0 means no sentence was classified across every
    // aggregated chapter — omit alignedPct rather than reporting a
    // misleading 0% (see AnalysisProvenanceReport's doc comment).
    ...(totalWeight > 0 ? { alignedPct: weightedAlignedSum / totalWeight } : {}),
    confirmed,
    corrected,
    flagged,
    unresolved,
    escalated,
    escalationAccepted,
  };
}

/** #2267 — collapse this pass's per-chapter `measureChapterLegibility`
    readings (Task 1) into the book-level worst-paragraph reading. `Math.max`
    across chapters, never a sum — Global Constraint, see the design of
    record §2.1 for why a rate/sum was tried and refuted. A chapter that
    contributed `undefined` (no supported language for that chapter, or the
    engine didn't run for it this pass) is skipped rather than counted as 0.
    `undefined` when no chapter in this pass contributed a reading at all. */
export function aggregateMaxMergedTurns(perChapter: Array<number | undefined>): number | undefined {
  let worst: number | undefined;
  for (const n of perChapter) {
    if (n === undefined) continue;
    if (worst === undefined || n > worst) worst = n;
  }
  return worst;
}

/* ── Sticky analysis: in-flight job map + multi-subscriber broadcast ────
   Mirrors the audio-generation sticky pattern (server/src/routes/generation.ts
   :42-82, RunningJob). Each entry tracks an analyzer loop that runs
   detached from any single SSE request — closing the browser tab only
   unsubscribes the observer; the analyzer keeps running until the queue
   drains, /analysis/pause is called, or a fresh: true POST displaces the
   job. A subsequent POST while the job is alive joins as a subscriber
   and replays a snapshot of the job's current state (last phase tick,
   accumulated log lines, latest cast-update + ETA, any active failed-
   chapter rows) so the UI hydrates without a separate fetch.

   The frontend's "Analysis is running, click to view" pill (B3) reads
   from the same map via a future GET-or-cheap-POST handshake — for
   now the only consumers are the POST handler's dispatch + /pause. */

export interface AnalysisSubscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: NodeJS.Timeout;
}

export interface AnalysisJobReplayState {
  /** Every log event emitted, in order. Replayed verbatim to a new
      subscriber so the phase log surfaces what's already happened. */
  logs: Array<{ kind: 'log'; phaseId: number; message: string }>;
  /** Latest phase event (kind:'phase'). Only the most recent is replayed
      since phase events are cumulative. */
  lastPhase: {
    kind: 'phase';
    phaseId: number;
    progress: number;
    label: string;
    live?: unknown;
  } | null;
  /** Latest ETA event (kind:'eta'). */
  lastEta: { kind: 'eta'; remainingMs: number } | null;
  /** Latest full cast-update snapshot. cast-update events are cumulative
      so only the most recent matters. */
  lastCastUpdate: { kind: 'cast-update'; characters: CharacterOutput[] } | null;
  /** Active failed-chapter records, keyed by chapterId. chapter-failed
      adds entries; chapter-resolved removes them. Replayed so a
      reconnecting client sees the right set of Retry rows. */
  failedByChapterId: Map<
    number,
    {
      kind: 'chapter-failed';
      chapterId: number;
      message: string;
      code?: string;
      remediation?: string;
      phase?: 'cast' | 'attribution';
    }
  >;
  /** One-shot series-cast prior event emitted at Phase 0 entry. Cached
      here so a subscriber that attaches AFTER Phase 0 entry receives
      the carry-over surface in its catch-up replay (otherwise the
      first subscriber would see the SeriesPriorPill but the second
      one — post-reload, post-navigate-back — would miss it). */
  lastSeriesPrior: { kind: 'series-prior'; count: number; names: string[] } | null;
  /** #2015 — advisories emitted during the run, keyed by `code` so a burst of
      one warning replays as ONE. Not cleared: an advisory stays true for the
      rest of the run. */
  warnings: Map<string, { kind: 'warning'; code: string; message: string }>;
}

export interface AnalysisJob {
  controller: AbortController;
  subscribers: Set<AnalysisSubscriber>;
  manuscriptId: string;
  /** Discriminator for the job's shape (plan 32 D1). `'main'` is the
      full-book sticky analysis run; `'subset'` is a per-chapter retry
      (POST /:id/analysis/chapters). Each kind lives in its own map
      slot so a subset retry doesn't displace an active main run and
      vice versa — both can coexist per manuscript. */
  kind: 'main' | 'subset';
  /** Set only on `kind === 'subset'` jobs. The chapter ids being
      retried, captured at job creation, persisted into
      `analysis-state.json` (`subsetChapterIds`) so the cold-boot
      rehydrated AnalysisPill can show "Retrying N chapters" copy. */
  subsetChapterIds?: number[];
  /** Set only on `kind === 'subset'` jobs: what started the run (#3774). Reported
      by `snapshotInFlightAnalysis`; a request that joins the job never changes it. */
  subsetOrigin?: 'include' | 'reanalyse';
  /** Path to the book directory the analyzer is writing into. Set
      from the manuscript record at job creation, used by the
      cold-boot rehydration writes (`writeAnalysisState` / `deleteAnalysisState`).
      `null` for legacy POST /api/manuscripts uploads that have no
      workspace book — those skip every disk write site, same as
      cast.json / state.json. */
  bookDir: string | null;
  /** Engine holding a card across BOTH phases, not any one analyzer's: Ollama over an endpoint over
      Gemini, derived from each phase's current engine (`phaseEngines`, by setPhaseEngine). Persisted into
      `analysis-state.json` so the cold-boot rehydrated AnalysisPill
      carries the right engine for the reverse-direction local-analyzer
      guard (`src/hooks/use-reverse-local-analyzer-guard.tsx`), which
      prompts before a TTS-start when the engine is `local` or when an
      endpoint run shares the TTS card (`analyzerSharesTtsDevice`). Once a
      fallback switch has happened it also rides the phase events
      (`withRunEngine`) into the live frontend snapshot. */
  engine: AnalysisEngine;
  replay: AnalysisJobReplayState;
  /** ms-since-epoch of the last `analysis-state.json` write. Used to
      throttle phase-tick writes to ~once every 5s so we don't hammer
      the filesystem during the per-chapter sub-tick storms in
      Phase 0a / Phase 1. Terminal writes (pause, endJob branches)
      ignore the throttle and always land. */
  lastDiskWriteAt: number;
  /** #3084 P20 — set the first time this job sees a reasoning overflow, by
      noteReasoningOverflow. From then on the job starts no new escalation
      window or non-story classification call; chapters already calling the
      model are aborted when the run ends (#3435 decision E). Optional, so
      every existing job literal compiles. */
  reasoningOverflowed?: boolean;
  /** #3084 P20 — the first overflow noteReasoningOverflow saw, set together with
      reasoningOverflowed. The chapter pools' dispatch check rethrows it, so a job
      marked by an overflow the runner swallowed ends exactly as a rethrown one does. */
  reasoningOverflowError?: AnalyzerReasoningOverflowError;
  /** #3084 P20/F7 — the chapter noteReasoningOverflow was told about when it
      first marked the job (set together with the two fields above). `title`
      is best-effort: some call sites (an escalation call, the non-story
      classifier) know only an id at the point they catch the error and would
      need an extra lookup for a title neither has any other reason to hold;
      those pass `{ id }` alone. Every call site below now passes a chapter
      (the main and subset routes' Phase 0/Phase 1 catches, both escalation
      hooks, and the non-story classifier), so the terminal handler's "a
      chapter" fallback is defence-in-depth for a call site a later change
      forgets to update, not an expected path. */
  reasoningOverflowChapter?: { id: number; title?: string };
  /** #3435 — the phase (0 = cast, 1 = attribution) of the call that made the
      first overflow, set with the fields above. The terminal failure names that
      phase's model. */
  reasoningOverflowPhase?: 0 | 1;
  /** #3435 — set to 1 when a Phase-1 chapter's own call threw, so the terminal
      failure names the Phase-1 model. */
  failingPhase?: 1;
  /** #3435 decision E — set first thing in endJob. From then on no chapter
      starts, and every in-flight call has been aborted. */
  ended: boolean;
  /** #3435 — set by a pool catch, synchronously and before any await, when the
      run is about to end on a failure. No chapter starts once it is set. */
  halting: boolean;
  /** #3435 decision A — set once the job has left the writer registry; makes
      the leave (and its busy release) happen exactly once. */
  left: boolean;
  /** #3435 decision A — tracked units of work still running (cast chapters,
      the Phase-0 arm, Phase-1 chapter bodies). A main job stays a writer until
      it has ended and this is 0, or the drain deadline passes. */
  liveWork: number;
  /** #3435 — the main run's watermark, stored so endJob can release every
      parked Phase-1 worker. Absent until the run creates it (endJob can run
      before that: the `language_unset` terminal). */
  watermark?: PhaseWatermark;
  /** #3084 P1 — releases the run-level busy mark on the OpenAI-compatible endpoints this
      job uses (analyzer-concurrency.ts markEndpointRunActive). Set at job creation, called by
      releaseBusyAndPin beside clearAnalysisBusy. Idempotent. */
  releaseEndpointRun?: () => void;
  /** #3084 P30 — fallback targets already marked busy (each once, at its first switch). */
  fallbackMarked?: Set<string>;
  /** #3084 P30 — set by releaseBusyAndPin once releaseEndpointRun has run; a later switch takes no mark. */
  endpointRunReleased?: boolean;
  /** #3084 wave 3d — an Ollama-served selection (a primary) belongs to this run. The switch is sticky and
      job.engine is derived from both phases' current engines, so once every phase has moved off Ollama it
      can read the target by the end while Ollama still holds the run pin (keep_alive: -1);
      releaseBusyAndPin evicts on either. */
  ollamaServed?: boolean;
  /** #3084 wave 3d review pass 2 — this run's fallback switch, shared by every analyzer selection the run
      makes (phase 0, phase 1): a switch one makes sends the others' calls straight to the target too
      (sticky for the run). Per job, so one job's switch never reaches another. Absent: the selection
      has a switch of its own. */
  fallbackSwitch?: RunFallbackSwitch;
  /** #3084 wave 3d review pass 3 — the engine each phase is CURRENTLY on (a fallback switch moves its own
      phase's entry). `engine` is derived from both by setPhaseEngine, so the cold-boot snapshot names
      whoever holds a card across the whole run. */
  phaseEngines?: { 0?: AnalysisEngine; 1?: AnalysisEngine };
  /** #3084 wave 3d review pass 4 (J) — every fallback target this run has switched to (set by
      markFallbackActive on each switch). Non-empty = a switch has happened: from then on the phase
      events carry `analysisEngine`/`analysisGpu` (withRunEngine), the live frontend snapshot's only
      way to learn the card the run now holds. */
  fallbackModels?: Set<string>;
  /** #3711 — settles when the job's tracked units have ACTUALLY finished: a main job
      once it has ended and `liveWork` is 0 (NOT at the drain deadline); a subset job at
      its end. The route's `runBookJob` lease is released only then, so a folder move
      stays refused for as long as anything can still write the book. Absent on a
      hand-built test job. */
  settled?: Promise<void>;
  resolveSettled?: () => void;
  /** #3711 (PR #3714 review pass 1) — settles when endJob's DETACHED terminal writes
      (the last-outcome file, the paused/halted snapshot, the snapshot cleanup) have
      landed. `settled` waits for it too: those writes resolve the book's folder and
      then write it, so the lease must outlive them or a rename can slip in between
      and the write recreates the vacated folder. */
  terminalWrites?: Promise<void>;
}

/* #3084 wave 3d review pass 3 — Ollama beats an endpoint beats Gemini, so a mixed run is never
   under-reported (the rule src/views/analysing.tsx applies to the same snapshot). */
export function combineAnalysisEngines(engines: Array<AnalysisEngine | undefined>): AnalysisEngine {
  if (engines.includes('local')) return 'local';
  if (engines.includes('openai')) return 'openai';
  return 'gemini';
}

/* Record one phase's current engine and re-derive job.engine from both. */
function setPhaseEngine(job: AnalysisJob, phase: 0 | 1, engine: AnalysisEngine): void {
  const engines = { ...job.phaseEngines, [phase]: engine };
  job.phaseEngines = engines;
  job.engine = combineAnalysisEngines([engines[0], engines[1]]);
}

/* #3435 — which model the terminal failure names: the overflowing call's phase,
   else the phase of the chapter whose call threw, else Phase 0. */
function terminalFailureLabel(job: AnalysisJob, phase0Label: string, phase1Label: string | undefined): string {
  if (job.reasoningOverflowPhase !== undefined) return job.reasoningOverflowPhase === 1 ? (phase1Label ?? phase0Label) : phase0Label;
  return job.failingPhase === 1 ? (phase1Label ?? phase0Label) : phase0Label;
}

const inFlightAnalysisByManuscript: Map<string, AnalysisJob> = new Map();
/* Plan 32 D1: subset-retry sticky map. Keyed by manuscriptId; only one
   subset retry per manuscript may be live at a time (a re-POST with the
   same manuscriptId while a subset is running attaches as a subscriber
   via catch-up replay, same shape as the main route). Lives in its own
   map so a main run can keep ticking alongside a subset retry. */
const inFlightSubsetByManuscript: Map<string, AnalysisJob> = new Map();

function jobMapFor(kind: 'main' | 'subset'): Map<string, AnalysisJob> {
  return kind === 'subset' ? inFlightSubsetByManuscript : inFlightAnalysisByManuscript;
}

/* #3435 decision A — every main job that can still write to its book: from
   registration until it has ended AND its tracked units have finished (or the
   drain deadline passed). A displaced or ended main job leaves the in-flight
   map at once but stays here while it drains, so a subset run (and a non-fresh
   main start) is refused until no main writer is left. In memory only: a
   restart empties it together with every job. */
const mainWritersByManuscript: Map<string, Set<AnalysisJob>> = new Map();

/* #3435 — how long an ended main job may hold the book (and the busy flag,
   the Ollama pin, resident VRAM) for a unit that has not yet observed the
   abort. A constant, not a setting. */
export const MAIN_DRAIN_DEADLINE_MS = 60_000;

function joinWriters(job: AnalysisJob): void {
  let set = mainWritersByManuscript.get(job.manuscriptId);
  if (!set) {
    set = new Set();
    mainWritersByManuscript.set(job.manuscriptId, set);
  }
  set.add(job);
}

/* #3435 — leave the writer registry, exactly once (`job.left`). For a main job
   this is where the busy flag and the local-Ollama pin are released: a job
   still draining after endJob must keep both. */
function leaveWriters(job: AnalysisJob): void {
  if (job.left) return;
  job.left = true;
  const set = mainWritersByManuscript.get(job.manuscriptId);
  if (set) {
    set.delete(job);
    if (set.size === 0) mainWritersByManuscript.delete(job.manuscriptId);
  }
  console.log(`[analysis] main run drained manuscript=${job.manuscriptId}`);
  releaseBusyAndPin(job);
}

/** #3435 — take a tracked unit of work for this job. Exported for unit testing. */
export function takeWork(job: AnalysisJob): void {
  job.liveWork = (job.liveWork ?? 0) + 1;
}

/** #3435 — release a tracked unit; an ended main job with no work left leaves
    the writer registry. Exported for unit testing. */
export function releaseWork(job: AnalysisJob): void {
  job.liveWork = (job.liveWork ?? 0) - 1;
  if (job.kind === 'main' && job.ended && job.liveWork <= 0) {
    leaveWriters(job);
    settleJob(job);
  }
}

/** #3711 — resolve `settled` (and so release the route's `runBookJob` lease) once
    endJob's detached terminal writes have landed, never before. */
function settleJob(job: AnalysisJob): void {
  void (async () => {
    /* re-check after each wait: a later endJob call may have extended the collection */
    let seen: Promise<void> | undefined;
    do {
      seen = job.terminalWrites;
      await seen;
    } while (job.terminalWrites !== seen);
    job.resolveSettled?.();
  })();
}

/* #3435 decision A — the main writer state for a manuscript: 'live' when a
   main writer is still running, 'draining' when every main writer has ended or
   been aborted, null when there is none. */
function mainWriterState(manuscriptId: string): 'live' | 'draining' | null {
  const set = mainWritersByManuscript.get(manuscriptId);
  if (!set || set.size === 0) return null;
  for (const w of set) if (!w.ended && !w.controller.signal.aborted) return 'live';
  return 'draining';
}

const MAIN_RUNNING_MESSAGE = 'The analysis is still running on this book. Pause it first, then try again.';
const MAIN_DRAINING_MESSAGE =
  'The analysis on this book is still stopping. Try again in a moment.';
const SUBSET_RUNNING_MESSAGE =
  'A chapter retry is running on this book. Wait for it to finish, then resume the analysis.';
/* A start is refused, not queued: the restructure holds the book for a moment
   and the user retries. Checked synchronously with the registration, so a job
   can never start under a restructure (restructure-gate.ts). */
const RESTRUCTURING_MESSAGE =
  'The chapters of this book are being changed. Try again in a moment.';

/* The restructure routes refuse while any job is registered for the book: a
   live main or subset run, or a main run still draining. */
registerAnalysisBusyProbe((manuscriptId) => isAnalysisJobRunning(manuscriptId) || mainWriterState(manuscriptId) !== null);

/** Test seams for the restructure gate's job-start side. */
export const mainStartRefusalForTest = (manuscriptId: string) => mainStartRefusal(manuscriptId, false);
export const subsetRefusalForTest = (manuscriptId: string) => subsetRefusal(manuscriptId);

/* #3435 decision A — why a subset POST is refused, or null. Any main writer,
   live or draining. */
function subsetRefusal(
  manuscriptId: string,
):
  | { error: 'main_analysis_running'; draining: boolean; message: string }
  | { error: 'chapters_restructuring'; message: string }
  | null {
  if (isRestructuring(manuscriptId)) return { error: 'chapters_restructuring', message: RESTRUCTURING_MESSAGE };
  const state = mainWriterState(manuscriptId);
  if (!state) return null;
  const draining = state === 'draining';
  return { error: 'main_analysis_running', draining, message: draining ? MAIN_DRAINING_MESSAGE : MAIN_RUNNING_MESSAGE };
}

/* #3435 decision A — why a main POST that would START a job is refused, or
   null. A registered subset refuses any start; a draining previous main run
   refuses a non-fresh start (Start fresh still displaces). Never called for a
   join. */
function mainStartRefusal(
  manuscriptId: string,
  requestedFresh: boolean,
):
  | { error: 'subset_analysis_running'; message: string }
  | { error: 'main_analysis_running'; draining: true; message: string }
  | { error: 'chapters_restructuring'; message: string }
  | null {
  if (isRestructuring(manuscriptId)) return { error: 'chapters_restructuring', message: RESTRUCTURING_MESSAGE };
  if (inFlightSubsetByManuscript.has(manuscriptId)) {
    return { error: 'subset_analysis_running', message: SUBSET_RUNNING_MESSAGE };
  }
  if (!requestedFresh && mainWriterState(manuscriptId) === 'draining') {
    return { error: 'main_analysis_running', draining: true, message: MAIN_DRAINING_MESSAGE };
  }
  return null;
}

/* #3435 — the same refusal as an SSE terminal `error` frame, for the late check
   (headers are already flushed by then). */
function refusalFrame(r: { error: string; message: string; draining?: boolean }): Record<string, unknown> {
  return { kind: 'error', code: r.error, message: r.message, ...(r.draining !== undefined ? { draining: r.draining } : {}) };
}

/* PR #3714 review pass 6 -- the record a registered start runs on. The start
   read its record before it queued on book-op for `runBookJob`, and an op
   queued ahead of it (a bundle overwrite) may have replaced the book since.
   Re-read the record for the manuscript the LEASE names (resolved under
   book-op; the job token now refuses a further overwrite). A lease naming a
   different manuscriptId means the book was replaced by another manuscript:
   the request's id no longer belongs to it, so the start is refused as
   `unknown_manuscript`, the same answer a start sent after the overwrite gets.
   No lease (an upload not yet on disk): the captured record stands. */
const MANUSCRIPT_REPLACED_MESSAGE =
  "This book's manuscript was replaced while the analysis was starting. Reopen the book and start the analysis again.";
type StartRecord = NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>;
async function recordForLease(
  manuscriptId: string,
  captured: StartRecord,
  lease: BookJobLease | null,
): Promise<StartRecord | { refusal: Record<string, unknown> }> {
  if (!lease) return captured;
  const refusal = { refusal: { kind: 'error', code: 'unknown_manuscript', message: MANUSCRIPT_REPLACED_MESSAGE } };
  if (lease.state.manuscriptId !== manuscriptId) return refusal;
  return (await getOrHydrateManuscript(manuscriptId)) ?? refusal;
}

/* Exported for tests + the B2 frontend's cheap "is a job running?" probe
   before opening an SSE. Returns false when the map entry is present but
   its controller has been aborted — that entry will be cleared at the
   end of the current loop iteration. Plan 32 D1: a subset-retry counts
   as "running" too (callers that need to differentiate look at the
   cold-boot snapshot's `kind` field). */
export function isAnalysisJobRunning(manuscriptId: string): boolean {
  const main = inFlightAnalysisByManuscript.get(manuscriptId);
  if (main && !main.controller.signal.aborted) return true;
  const subset = inFlightSubsetByManuscript.get(manuscriptId);
  return !!subset && !subset.controller.signal.aborted;
}

/** Test helper: the in-flight job for a manuscript (#3711 route-level lease tests). */
export function __inFlightJobForTest(manuscriptId: string, kind: 'main' | 'subset'): AnalysisJob | undefined {
  return jobMapFor(kind).get(manuscriptId);
}

/** Test helper: register a job into the in-flight map. Used by
    analysis.rejoin-miss.test.ts's buildJob to ensure the staleness guard
    in endJob has a valid map entry to check. #3435 — fills the lifecycle
    fields a hand-built job omits, and enters a main job in the writer
    registry, as the main route does. */
export function __testRegisterJobForTest(job: AnalysisJob): void {
  job.ended ??= false;
  job.halting ??= false;
  job.left ??= false;
  job.liveWork ??= 0;
  const targetMap = jobMapFor(job.kind);
  targetMap.set(job.manuscriptId, job);
  if (job.kind === 'main') joinWriters(job);
}

/** fs-1 — true when ANY analyzer job (main or subset) is in flight. The upgrade
    gate refuses to restart the server out from under an active analysis. Returns
    the busy manuscript ids so the 409 can name them. #3435 (A9) — a main run
    still draining after its end counts too, so a restart cannot land mid-drain. */
export function activeAnalysisManuscripts(): string[] {
  const out = new Set<string>();
  for (const [id, job] of inFlightAnalysisByManuscript) {
    if (!job.controller.signal.aborted) out.add(id);
  }
  for (const [id, job] of inFlightSubsetByManuscript) {
    if (!job.controller.signal.aborted) out.add(id);
  }
  for (const id of mainWritersByManuscript.keys()) out.add(id);
  return [...out];
}

/** Snapshot the in-flight analyzer's state for the cold-boot
    discovery endpoint (GET /api/books/:bookId/analysis/state — the
    handler lives in routes/book-state.ts; only this snapshot is built here).
    Returns null when no job is running OR the job's controller has
    been aborted — both cases fall back to disk in the GET handler.
    The synthesised snapshot mirrors the disk shape, plus the live-only
    `subsetOrigin` the disk writer never writes; the discovery endpoint
    returns either source.

    Plan 32 D1: subset retries win over main when both are live for the
    same manuscript, because the subset's progress reflects the more
    recent user action and matches what the user expects to see on the
    pill (they kicked off the retry). If only main is live, return it. */
export function snapshotInFlightAnalysis(manuscriptId: string): AnalysisStateFile | null {
  const subset = inFlightSubsetByManuscript.get(manuscriptId);
  const main = inFlightAnalysisByManuscript.get(manuscriptId);
  const job =
    subset && !subset.controller.signal.aborted
      ? subset
      : main && !main.controller.signal.aborted
        ? main
        : null;
  if (!job) return null;
  const phase = job.replay.lastPhase;
  return {
    manuscriptId,
    phaseId: phase?.phaseId ?? 0,
    phaseLabel: phase?.label ?? PHASES[0].label,
    phaseProgress: phase?.progress ?? 0,
    state: 'running',
    engine: job.engine,
    kind: job.kind,
    subsetChapterIds: job.kind === 'subset' ? job.subsetChapterIds : undefined,
    subsetOrigin: job.kind === 'subset' ? (job.subsetOrigin ?? 'reanalyse') : undefined,
    lastTickAt: job.lastDiskWriteAt || Date.now(),
    writtenAt: Date.now(),
  };
}

/** Phase-tick disk-write throttle. Phase events fire densely during
    Phase 0a / Phase 1 sub-ticks; we only need one snapshot every few
    seconds for cold-boot rehydration purposes. */
const ANALYSIS_STATE_WRITE_THROTTLE_MS = 5_000;

/* #2165 — the job's CURRENT book directory. `job.bookDir` is a string copy
   taken at job creation; renaming the book mid-run mutates the
   ManuscriptRecord in place (book-state.ts's `rec.bookDir = newDir`) but
   cannot reach that copy, so a disk write keyed on it recreates the
   pre-rename directory and lands the file where nothing reads it. Re-read
   the record instead.

   Falls back to the pinned copy if the record is absent for any reason:
   belt-and-braces when the store has no record. The case that genuinely
   motivates re-reading is a record being replaced (reparse via
   `putManuscript` — a captured reference would miss the fresh path).

   NOT for markAnalysisBusy/clearAnalysisBusy. Those are a matched pair over
   a ref-counted Map; clearing under a different key than the one marked
   would leak the old entry forever AND underflow the new one, releasing a
   guard a sibling job may still hold. The busy key stays pinned — see the
   accepted-gap note at the clearAnalysisBusy site for the race that the
   rename guard narrows but does not close. */
function liveBookDir(job: AnalysisJob): string | null {
  return getManuscript(job.manuscriptId)?.bookDir ?? job.bookDir;
}

/* #2196 — resolve a VERIFIED bookDir for this run's cast writes. Runs the
   guard's full identity check against the LIVE bookDir(job) (resolved fresh,
   never a captured record — C2), invalidating + re-hydrating on a miss, and
   throws BookDirUnresolvedError when the book can no longer be located
   (out-of-process move out of the workspace / gone). This is the single
   identity-gated 'throw' (C3) for the run's cast.json writes: a cast write through a dead stale path must NEVER mkdir the old
   directory back into existence. */
async function resolveVerifiedBookDirForRun(job: AnalysisJob): Promise<string> {
  const record = getManuscript(job.manuscriptId);
  const result = await verifyBookDirForWrite({
    manuscriptId: job.manuscriptId,
    candidateBookDir: liveBookDir(job),
    /* #2196 review (🟡 dead guard surface) — bind the manuscript's OWN bookId
       into the identity check (expectedBookId was previously a test-only
       surface): a candidate whose .audiobook/state.json claims a DIFFERENT
       book's id is refused on the FULL path (cross-book contamination) rather
       than accepted on manuscriptId alone, and is diverted to the re-hydration
       slow path, which re-locates the book by manuscriptId
       (findBookByManuscriptId). `undefined` for legacy / upload records (no
       bookId) keeps the check a no-op for them, exactly as before. */
    expectedBookId: record?.bookId,
  });
  /* `verifyBookDirForWrite` already threw on `unresolved`, so the only
     surviving variant is `{ status: 'ok' }`; the discriminant check keeps the
     narrowing explicit (TS cannot see through the throw). */
  if (result.status !== 'ok') {
    throw new Error('unreachable: verifyBookDirForWrite threw on unresolved');
  }
  return result.bookDir;
}

/* #2196 review (🟡 TOCTOU) — re-verify the write target immediately before
   writing the terminal authoritative state.json record. A book-folder move
   landing mid-persist (after the block-top resolve) leaves `writeDir` stale:
   this function re-resolves it identity-gated and refuses (throws
   BookDirUnresolvedError, parked in the persist's `catch (persistErr)` so the
   run halts loudly) when it can no longer be found OR has re-located to a
   DIFFERENT dir than this block already persisted to — so a completed-looking
   state record never lands in a half-migrated pair. Exported so the divergence
   arm is deterministically regression-tested (review pass 2, minor). */
export async function assertWriteTargetStable(job: AnalysisJob, writeDir: string): Promise<void> {
  const stateWriteDir = await resolveVerifiedBookDirForRun(job);
  if (stateWriteDir !== writeDir) {
    throw new BookDirUnresolvedError(
      `book folder moved mid-persist (resolved ${stateWriteDir} after writing ${writeDir}); refusing to write the terminal state record`,
    );
  }
}

async function persistRunningSnapshot(job: AnalysisJob, force: boolean): Promise<void> {
  const candidate = liveBookDir(job); // #2165
  if (!candidate) return;
  const phase = job.replay.lastPhase;
  if (!phase) return;
  const now = Date.now();
  if (!force && now - job.lastDiskWriteAt < ANALYSIS_STATE_WRITE_THROTTLE_MS) return;
  job.lastDiskWriteAt = now;
  /* #2196 (C4) — the running snapshot is guarded in mode:'drop': a stale
     (out-of-process-moved / gone) dir is NEVER mkdir'd back by
     writeAnalysisState. Non-fatal by design — the analyzer cache +
     cast.json are the real source of truth, so on an unresolvable dir the
     snapshot is simply dropped and the run proceeds to the terminal
     persist, which halts loudly (Task 6). */
  try {
    await withVerifiedBookDir(
      { manuscriptId: job.manuscriptId, candidateBookDir: candidate, mode: 'drop' },
      async (bookDir) => {
        try {
          await writeAnalysisState(bookDir, {
            manuscriptId: job.manuscriptId,
            phaseId: phase.phaseId,
            phaseLabel: phase.label,
            phaseProgress: phase.progress,
            state: 'running',
            engine: job.engine,
            kind: job.kind,
            subsetChapterIds: job.kind === 'subset' ? job.subsetChapterIds : undefined,
            lastTickAt: now,
          }, {
            /* #3435 (A6) — checked inside the queued op, after the dir resolved:
               a running snapshot that waited past endJob must not land after
               the terminal write or delete. */
            shouldWrite: () => !job.ended,
          });
        } catch (err) {
          /* Non-fatal — the on-disk file only powers cold-boot pill
             rehydration. The analyzer cache + cast.json are the real
             source of truth. Log and continue. */
          console.warn('[analysis-state] running snapshot write failed', err);
        }
      },
    );
  } catch (err) {
    /* #3174 — resolveVerifiedBookDir's own slow-path re-hydrate (inside
       withVerifiedBookDir) can throw BEFORE the callback above ever runs
       (e.g. an fs failure inside ensureWorkspace's mkdirSync). This
       function is called detached (`void persistRunningSnapshot(...)`), so
       an uncaught rejection here would otherwise reach the process only as
       an unhandledRejection. Non-fatal for the same reason as the
       write-failure catch above — log and continue. */
    console.warn('[analysis-state] running snapshot resolve failed', err);
  }
}

async function persistTerminalSnapshot(
  job: AnalysisJob,
  state: 'paused' | 'halted',
  finalEv: { code?: string; message?: string } | null,
): Promise<void> {
  const candidate = liveBookDir(job); // #2165
  if (!candidate) return;
  const phase = job.replay.lastPhase;
  /* #2196 (C1/C4) — the terminal snapshot is guarded in mode:'drop'. On an
     unresolvable (out-of-process-moved / gone) book dir NO snapshot is
     written — writing through the stale liveBookDir fallback would mkdir the
     dead folder (the bug). A `halted` snapshot therefore lands ONLY when a
     valid book dir exists; the pathless case is surfaced by the persist-block
     STALE_BOOK_DIR log + the terminal halt event (V7·1). */
  try {
    await withVerifiedBookDir(
      { manuscriptId: job.manuscriptId, candidateBookDir: candidate, mode: 'drop' },
      async (bookDir) => {
        try {
          await writeAnalysisState(bookDir, {
            manuscriptId: job.manuscriptId,
            phaseId: phase?.phaseId ?? 0,
            phaseLabel: phase?.label ?? PHASES[0].label,
            phaseProgress: phase?.progress ?? 0,
            state,
            engine: job.engine,
            kind: job.kind,
            subsetChapterIds: job.kind === 'subset' ? job.subsetChapterIds : undefined,
            haltCode: state === 'halted' ? finalEv?.code : undefined,
            haltReason: state === 'halted' ? finalEv?.message : undefined,
            lastTickAt: Date.now(),
          });
          job.lastDiskWriteAt = Date.now();
        } catch (err) {
          console.warn('[analysis-state] terminal snapshot write failed', err);
        }
      },
    );
  } catch (err) {
    /* #3174 — same slow-path-resolve gap as persistRunningSnapshot above:
       withVerifiedBookDir's re-hydrate can throw before the callback runs.
       endJob does not await this function (it collects it into
       `job.terminalWrites`, which only gates the job's `settled`), and the
       awaited /pause route doesn't rely on a rejection either — it just
       proceeds either way. Non-fatal — log and continue. */
    console.warn('[analysis-state] terminal snapshot resolve failed', err);
  }
}

function broadcastToJob(job: AnalysisJob, payload: unknown): void {
  for (const sub of job.subscribers) {
    try {
      sub.send(payload);
    } catch {
      /* dead socket — req.on('close') will clean up */
    }
  }
}

/* #3084 wave 3d review pass 4 (J) — once the run has switched to a fallback target, its phase events
   name the run's combined engine (the value job.engine holds, which the cold-boot snapshot reads) and the
   card the endpoint target(s) hold, so the frontend's live snapshot — read by the reverse guard and the
   generation hold — follows the switch instead of keeping the engine it captured at start. Ollama and
   Gemini targets hold no endpoint card. Before any switch the events are untouched. */
function withRunEngine(job: AnalysisJob, payload: unknown): unknown {
  if (!job.fallbackModels?.size || !payload || typeof payload !== 'object') return payload;
  if ((payload as { kind?: unknown }).kind !== 'phase') return payload;
  const endpoints = getCachedUserSettings().analyzerEndpoints;
  const cards = [...job.fallbackModels].flatMap((modelId) => {
    const parsed = parseEndpointModelId(modelId);
    return parsed ? [endpoints.find((e) => e.id === parsed.endpointId)?.gpu ?? 'any'] : [];
  });
  /* The rule the frontend's start snapshot uses (snapshotGpuFor): off-card endpoints hold none. */
  const sharing = [...new Set(cards.filter((g) => g !== 'none'))];
  const gpu = cards.length === 0 ? undefined : sharing.length === 0 ? 'none' : sharing.length === 1 ? sharing[0] : 'any';
  return { ...payload, analysisEngine: job.engine, ...(gpu !== undefined ? { analysisGpu: gpu } : {}) };
}

/* Exported for unit testing (the chapter-failed replay contract). */
export function trackForReplay(job: AnalysisJob, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const ev = payload as { kind?: string };
  switch (ev.kind) {
    case 'log':
      job.replay.logs.push(ev as { kind: 'log'; phaseId: number; message: string });
      break;
    case 'phase':
      job.replay.lastPhase = ev as AnalysisJobReplayState['lastPhase'];
      /* Fire-and-forget cold-boot snapshot write. Throttled in
         persistRunningSnapshot so dense Phase 0a sub-ticks don't
         hammer the filesystem. Non-fatal on error. */
      void persistRunningSnapshot(job, false);
      break;
    case 'eta':
      job.replay.lastEta = ev as AnalysisJobReplayState['lastEta'];
      break;
    case 'cast-update':
      job.replay.lastCastUpdate = ev as AnalysisJobReplayState['lastCastUpdate'];
      break;
    case 'chapter-failed': {
      const e = ev as {
        chapterId?: number;
        message?: string;
        code?: string;
        remediation?: string;
        phase?: 'cast' | 'attribution';
      };
      if (typeof e.chapterId === 'number' && typeof e.message === 'string') {
        job.replay.failedByChapterId.set(e.chapterId, {
          kind: 'chapter-failed',
          chapterId: e.chapterId,
          message: e.message,
          code: e.code,
          remediation: e.remediation,
          phase: e.phase,
        });
      }
      break;
    }
    case 'chapter-resolved': {
      const e = ev as { chapterId?: number };
      if (typeof e.chapterId === 'number') job.replay.failedByChapterId.delete(e.chapterId);
      break;
    }
    case 'series-prior': {
      const e = ev as { count?: number; names?: unknown };
      if (typeof e.count === 'number' && Array.isArray(e.names)) {
        job.replay.lastSeriesPrior = {
          kind: 'series-prior',
          count: e.count,
          names: e.names.filter((n): n is string => typeof n === 'string'),
        };
      }
      break;
    }
    case 'warning': {
      const e = ev as { code?: string; message?: string };
      if (typeof e.code === 'string' && typeof e.message === 'string') {
        job.replay.warnings.set(e.code, {
          kind: 'warning',
          code: e.code,
          message: e.message,
        });
      }
      break;
    }
    /* heartbeat / throttle / result / error: not replayed (heartbeat +
       throttle are ephemeral; result + error are terminal and the route
       closes the connection right after emitting them anyway). */
  }
}

export function replayCatchUp(job: AnalysisJob, send: (ev: unknown) => void): void {
  if (job.replay.lastPhase) send(job.replay.lastPhase);
  for (const log of job.replay.logs) send(log);
  if (job.replay.lastEta) send(job.replay.lastEta);
  if (job.replay.lastCastUpdate) send(job.replay.lastCastUpdate);
  if (job.replay.lastSeriesPrior) send(job.replay.lastSeriesPrior);
  for (const failed of job.replay.failedByChapterId.values()) send(failed);
  for (const warning of job.replay.warnings.values()) send(warning);
}

/** #3004 — true when the dispatch has NOT found a live job to join and the
    caller did not explicitly request a fresh restart, i.e. exactly the case
    the rejoin-miss check applies to. Split out as its own pure predicate so
    the "no live entry found" condition (spec points 1/2) and the "explicit
    restart" exclusion (point 4) can be asserted directly, without needing to
    drive a whole job through the dispatch route to prove the boundary. */
export function shouldCheckForRejoinMiss(
  existing: Pick<AnalysisJob, 'controller'> | undefined,
  requestedFresh: boolean,
): boolean {
  if (requestedFresh) return false;
  return !existing || existing.controller.signal.aborted;
}

/** #3004 — the SSE event a rejoin emits when NO live job was found for the
    manuscript (see the dispatch block below), so the caller can tell "I
    joined the still-running job" apart from "no job was found, so a
    brand-new one silently started." Carries the job's LAST recorded terminal
    outcome when one is on disk (from `readAnalysisLastOutcome`); a truly
    novel manuscript that was never analysed has no outcome to attach, so
    `priorOutcome` is omitted rather than fabricated. Exported for unit
    testing — the dispatch route only builds and sends this, it doesn't
    branch on its shape. */
export function buildRejoinMissEvent(priorOutcome: AnalysisLastOutcome | null): {
  kind: 'rejoin-miss';
  reason: string;
  priorOutcome?: { kind: 'result' | 'error'; code?: string; message?: string; endedAt: number };
} {
  const reason = priorOutcome
    ? priorOutcome.kind === 'error'
      ? `previous job ended with error (${priorOutcome.code ?? 'unknown'})`
      : 'previous job completed — starting fresh'
    : 'no tracked job found for this manuscript — starting fresh';
  return {
    kind: 'rejoin-miss',
    reason,
    ...(priorOutcome
      ? {
          priorOutcome: {
            kind: priorOutcome.kind,
            code: priorOutcome.code,
            message: priorOutcome.message,
            endedAt: priorOutcome.endedAt,
          },
        }
      : {}),
  };
}

/* #3084 P30 — a fallback target is marked busy at its first switch, never at job start, and the
   mark is released with the job's own (releaseBusyAndPin calls releaseEndpointRun). A switch that
   lands after that release (a P20 in-flight chapter finishing) takes no mark: nothing would ever
   release it. Every switch is recorded in `fallbackModels`, mark or not: that is what makes the phase
   events carry the run engine (withRunEngine). */
function markFallbackActive(job: AnalysisJob, modelId: string | null): void {
  if (!modelId) return;
  (job.fallbackModels ??= new Set()).add(modelId);
  if (job.endpointRunReleased || job.fallbackMarked?.has(modelId)) return;
  (job.fallbackMarked ??= new Set()).add(modelId);
  const release = markEndpointRunActive(endpointIdsForModelIds([modelId]));
  const previous = job.releaseEndpointRun;
  job.releaseEndpointRun = () => {
    previous?.();
    release();
  };
}

/* Exported for unit testing (the #3004 last-outcome persistence contract) —
   production call sites still reach this only via the analyzer loop's own
   terminal transitions. */
export function endJob(job: AnalysisJob, finalEv?: unknown): void {
  /* #3435 decision E — every ending, for every kind, first ends the job and
     aborts its in-flight calls (harmless on a `result`: nothing is in flight
     then), and releases every Phase-1 worker parked on the watermark so none
     is left waiting for ever. Setting `ended` first also orders this job's
     snapshot writes: a running snapshot queued from here on is dropped. */
  job.ended = true;
  if (!job.controller.signal.aborted) job.controller.abort();
  job.watermark?.releaseAll();
  if (finalEv) broadcastToJob(job, finalEv);
  /* Cold-boot snapshot transition. Not awaited here: the writes are
     collected into `job.terminalWrites` (#3711), which `settleJob` awaits
     before the book-op lease is released. We still tear down subscribers +
     deregister synchronously below so the route response isn't held up by
     the disk write.

     Plan 32 D1: a subset job's terminal success never deletes a MAIN
     run's snapshot (a paused main's Resume affordance must survive a
     sibling Retry). #3435 S14: it does delete its OWN `subset`-kind
     snapshot, which would otherwise outlive the finished Retry; the
     kind check and the unlink run in one op on the per-path chain.
     Subset's paused/halted snapshots still land for mid-flight aborts
     so the pill can render the Resume affordance. */
  const kind = (finalEv as { kind?: string } | undefined)?.kind;
  const code = (finalEv as { code?: string } | undefined)?.code;
  /* #3004 — record the LAST terminal outcome so a later rejoin that finds no
     live job can report why. Only for `kind: 'main'`: the rejoin-miss check
     this feeds lives on the main dispatch path only, and a per-book file
     shared with subset jobs would let a subset's own ending overwrite the
     main run's outcome. Only `result`/`error` are recorded — a `finalEv`-less
     teardown (subscriber-driven cleanup with nothing to report) leaves the
     prior outcome, if any, exactly as it was.
     #2165/#2196 — resolve via `liveBookDir(job)` (the CURRENT directory, not
     the pinned `job.bookDir` copy) and route through the identity-gated
     delete-only guard, same as the main-success cleanup right below: a
     book renamed away mid-run must never have this write mkdir the dead
     pre-rename folder back into existence. */
  let outcomeWritePromise: Promise<void> | null = null;
  /* #3711 — every detached write below is collected here and folded into
     `job.terminalWrites`, which `settled` waits for (see settleJob). */
  const terminalWrites: Promise<unknown>[] = [];
  if (job.kind === 'main' && (kind === 'result' || kind === 'error')) {
    const dirForOutcome = liveBookDir(job);
    if (dirForOutcome) {
      const message = (finalEv as { message?: string } | undefined)?.message;
      /* Staleness guard: a displaced job's late-arriving endJob must not
         overwrite a NEWER job's outcome with its own stale one. Same idiom
         as the map deregistration 75 lines below. */
      const targetMap = jobMapFor(job.kind);
      if (targetMap.get(job.manuscriptId) === job) {
        outcomeWritePromise = (async () => {
          const verified = await tryResolveVerifiedBookDir({
            manuscriptId: job.manuscriptId,
            candidateBookDir: dirForOutcome,
            /* Full identity-bearing path (default true): the write creates
               a file, so we must verify the path still belongs to the correct
               manuscript. The delete-only fast path below is for cleanup only
               and permits resurrection of a stale path; creating a new file
               must not. See #2196 for the rename-induced contamination case. */
            identityBearing: true,
          });
          if (!verified) return;
          await writeAnalysisLastOutcome(verified, {
            manuscriptId: job.manuscriptId,
            kind,
            code,
            message,
          });
        })().catch((err) => {
          console.warn('[analysis-last-outcome] write failed', err);
        });
      }
    }
  }
  if (job.bookDir) {
    if (!finalEv || kind === 'result') {
      /* Terminal success OR a clean teardown with no final event.
         Main: the analysis is complete (no pill should appear) —
         delete the snapshot file. Subset: on a `result`, delete the
         snapshot only if it is subset-kind, so any main run's
         snapshot survives a sibling subset completing successfully. */
      if (job.kind === 'main') {
        /* #2165 — the CURRENT directory, not the pinned copy: deleting the
           pre-rename path leaves the real analysis-state.json behind, and
           scanActiveAnalyses later offers it as a resumable analysis for a
           book that finished.
           #2196 review (🟡 dead guard surface) — route the snapshot cleanup
           through the guard's delete-only fast path (identityBearing:false,
           `tryResolveVerifiedBookDir`): only delete within a book folder that
           can still be resolved, so a stale/out-of-process-moved path is never
           mkdir'd back into existence by a delete and is simply skipped. This
           is the guard surface the unit tests already cover but that previously
           had no production call site. */
        const dir = liveBookDir(job);
        if (dir) {
          terminalWrites.push((async () => {
            try {
              const verified = await tryResolveVerifiedBookDir({
                manuscriptId: job.manuscriptId,
                candidateBookDir: dir,
                identityBearing: false,
              });
              if (verified) await deleteAnalysisState(verified);
            } catch (err) {
              /* #3174 — resolveVerifiedBookDir's slow-path re-hydrate can
                 throw (e.g. an fs failure inside ensureWorkspace's
                 mkdirSync) before this IIFE's own delete ever runs, and
                 this call is detached. Non-fatal: worst case a finished
                 book's stale analysis-state.json lingers and is offered
                 as resumable (see the comment above) — log and continue. */
              console.warn('[analysis-state] stale snapshot delete failed', err);
            }
          })());
        }
      } else if (kind === 'result') {
        const dir = liveBookDir(job);
        if (dir) {
          terminalWrites.push((async () => {
            try {
              const verified = await tryResolveVerifiedBookDir({
                manuscriptId: job.manuscriptId,
                candidateBookDir: dir,
                identityBearing: false,
              });
              if (verified) await deleteSubsetAnalysisState(verified);
            } catch (err) {
              /* Non-fatal, as the main delete above. */
              console.warn('[analysis-state] subset snapshot delete failed', err);
            }
          })());
        }
      }
    } else if (kind === 'error' && code === 'aborted') {
      /* Paused or displaced. Write paused state so the cold-boot
         endpoint returns paused, and the pill renders the Resume
         affordance. */
      terminalWrites.push(persistTerminalSnapshot(job, 'paused', finalEv as { code: string; message?: string }));
    } else if (kind === 'error') {
      /* Halted on a real failure: attribution_drift, cast_incomplete,
         stage1_shrink_refused, unknown_manuscript, or an upstream
         analyzer error. Persist with haltCode + haltReason so the
         cold-boot pill routes the user to the right banner. */
      terminalWrites.push(persistTerminalSnapshot(job, 'halted', finalEv as { code: string; message?: string }));
    }
  }
  /* #3004 — if an outcome write is in flight, don't end the response
     until it's complete. This ensures a rejoining client sees the
     persisted outcome file when it reconnects and re-reads.

     CRITICAL: capture the subscriber list BEFORE clearing it, since the
     async .then() callback cannot run until the current synchronous block
     finishes. If we clear() first, the callback finds an empty set and
     res.end() is never called, hanging the response forever. */
  if (outcomeWritePromise) terminalWrites.push(outcomeWritePromise);
  /* A second endJob for the same job APPENDS (it must not replace the first call's
     collection): settlement waits for every terminal write of every call made
     BEFORE `settled` resolved. A call AFTER that is not covered -- the lease is
     already released and cannot be re-taken here, so its writes run unleased. No
     production path ends a job a second time after it has settled. */
  job.terminalWrites = Promise.allSettled([job.terminalWrites, ...terminalWrites]).then(() => undefined);
  const subs = Array.from(job.subscribers);
  job.subscribers.clear();
  const endResponsesCallback = () => {
    for (const sub of subs) {
      clearInterval(sub.keepAlive);
      try {
        sub.res.end();
      } catch {
        /* socket already gone */
      }
    }
  };
  if (outcomeWritePromise) {
    void outcomeWritePromise.then(endResponsesCallback);
  } else {
    endResponsesCallback();
  }
  const targetMap = jobMapFor(job.kind);
  if (targetMap.get(job.manuscriptId) === job) {
    targetMap.delete(job.manuscriptId);
  }
  /* #3435 decision A — a subset job releases busy and the pin here, as before:
     it is sequential, so nothing of it is still running. A main job releases
     them when it leaves the writer registry: now if no tracked unit is still
     running, else when the last one finishes, or at the drain deadline. */
  if (job.kind !== 'main') {
    releaseBusyAndPin(job);
    settleJob(job);
    return;
  }
  if ((job.liveWork ?? 0) <= 0) {
    leaveWriters(job);
    settleJob(job);
    return;
  }
  /* #3711 — the deadline below releases the busy flag and the pin ONLY. It does not
     settle the job: the route's `runBookJob` lease is held until `releaseWork` drains
     the last tracked unit, because a unit still running can still write the book. */
  const deadline = setTimeout(() => {
    if (job.left) return;
    console.warn(
      `[analysis] main run drain deadline exceeded manuscript=${job.manuscriptId} liveWork=${job.liveWork}`,
    );
    leaveWriters(job);
  }, MAIN_DRAIN_DEADLINE_MS);
  deadline.unref?.();
}

/* The release half of a job's lifetime: the busy flag and the local-Ollama pin.
   Called once per job — from endJob for a subset job, from leaveWriters (whose
   `job.left` guard makes it exactly once) for a main job. */
function releaseBusyAndPin(job: AnalysisJob): void {
  /* Release the cross-operation busy flag so a "Design full cast" run can
     start once analysis is done (mutual exclusion — re-analysis rewrites the
     whole cast). Ref-counted, so a sibling main/subset job keeps it held. */
  /* Pinned deliberately (#2165) — mark/clear must use the same key, or the
     ref count leaks on one side and underflows on the other, releasing a
     guard a sibling job may still hold. #3711 closed the race that used to make
     this key wrong: the job is registered through `runBookJob` (under book-op) and
     `job.bookDir` comes from its lease, while a rename is refused for as long as the
     registration is held, so the path cannot change between mark and clear. */
  if (job.bookDir) clearAnalysisBusy(job.bookDir);
  job.releaseEndpointRun?.(); // #3084 P1 — this run no longer holds its endpoints
  job.endpointRunReleased = true; // #3084 P30 — a switch landing after this point takes no mark
  /* Release the run-scoped analyzer PIN. keepAliveFor() returned -1 for every
     Ollama call while a run was in flight (see analyzer/ollama.ts) so the model
     couldn't idle out between the minutes-apart attribution calls. Now that this
     run is over, issue the matching keep_alive:0 evict so the pinned model
     doesn't sit resident forever. Guarded: only a local Ollama run loaded a
     model, and only when NO sibling analysis (main+subset, ref-counted via
     isAnyAnalysisBusy) is still running — otherwise we'd evict a model that
     run still needs. Best-effort and fire-and-forget: a failed evict just means
     the model idles per its own keep_alive, and the next run re-warms it. */
  if ((job.engine === 'local' || job.ollamaServed) && !isAnyAnalyzerRunBusy()) {
    void unloadResidentOllama().catch(() => {
      /* Ollama unreachable / already evicted — nothing to release. */
    });
  }
}

type StartHintsVerdict =
  | {
      kind: 'proceed';
      why: 'not-parse' | 'not-on-disk' | 'book-gone' | 'state-unreadable' | 'foreign-state' | 'fresh' | 'main-rule' | 'checked';
    }
  | { kind: 'refuse'; why: 'count-id' | 'score' | 'displaced-block' };

/** #3829 / #3837 -- a START on a book whose hints came from a fresh parse that does not pair with
    state.json would rebuild `state.chapters` from the wrong bodies: chapters reappear, a uuid lands on
    another chapter and rendered audio is orphaned. Answered before the SSE headers open, with the 409
    the restructure routes use; the `why` goes only to the log. Persisted hints are not checked here:
    they carry their own staleness check.
    1. Count/id (`assertHintsPairWithState`, no `parseTitles`). A mismatch has two causes: (a) a merge
       made before #3703 persisted its hints, and (b) a chapter-splitting parser change after import
       (a4ba11aa, non-English plaintext; 532654fe, CJK plaintext). Both are refused. Accepted cost: an
       affected book with no rendered audio needs a re-parse, which discards its cast.
    2. Start fresh stops there (plan 290 round 6): a book the sentence check wrongly refuses can still
       be re-analysed without a destructive re-parse.
    3. Otherwise the saved sentences judge the pairing (`checkParseHintsPairing`, evidence-less
       positions on count/id alone), which catches a same-count reorder made before #3703, the PR #3835
       swaps and a displaced block. It runs only when its pairing by index is the one analysis uses:
       a pure record (an impure one, hints a restructure transformed without persisting, is never
       re-hydrated -- A1), ids 1..n in order on both sides, readable edits, and no stale-evidence
       marker. Else main's count/id rule stands.
    One lock-free, write-free span: the book is read through `peekBook`, like the `loadState` read in
    the runners, and an unreadable, foreign or vanished state.json fails open. */
async function parseHintsStartCheck(
  manuscriptId: string,
  record: ManuscriptRecord,
  opts: { fresh: boolean },
): Promise<StartHintsVerdict> {
  if (record.hintsSource !== 'parse') return { kind: 'proceed', why: 'not-parse' };
  if (!record.bookDir) return { kind: 'proceed', why: 'not-on-disk' };
  let bookDir = record.bookDir;
  let state: BookStateJson | null;
  if (record.bookId) {
    let peeked: Awaited<ReturnType<typeof peekBook>>;
    try {
      peeked = await peekBook(record.bookId, record.bookDir);
    } catch (e) {
      if (e instanceof BookStateUnreadableError) return { kind: 'proceed', why: 'state-unreadable' };
      throw e;
    }
    /* The route's later `runBookJob` answers BOOK_GONE, as today. */
    if (!peeked) return { kind: 'proceed', why: 'book-gone' };
    ({ bookDir, state } = peeked);
  } else {
    // A legacy state.json with no bookId: read it in place, as before.
    state = await readStateJsonWithRecovery(stateJsonPath(record.bookDir)).catch(() => null);
    if (!state) return { kind: 'proceed', why: 'state-unreadable' };
  }
  if (state.manuscriptId !== manuscriptId) return { kind: 'proceed', why: 'foreign-state' };
  try {
    assertHintsPairWithState(state, record.chapterHints);
  } catch (e) {
    if (e instanceof HintsOutOfSyncError) return { kind: 'refuse', why: 'count-id' };
    throw e;
  }
  if (opts.fresh) return { kind: 'proceed', why: 'fresh' };
  const { chapterHints, parseTitles } = record;
  const pure =
    parseTitles !== undefined &&
    chapterHints.length === parseTitles.length &&
    chapterHints.every((h, i) => h.parseIndex === i);
  const positional =
    state.chapters.every((c, i) => c.id === i + 1) && chapterHints.every((h, i) => h.id === i + 1);
  const edits = pure && positional && state.sentencesPredateChapters !== true ? await readEditsForHintsCheck(bookDir) : null;
  if (!edits || (edits.kind !== 'ok' && edits.kind !== 'absent')) {
    if (edits?.kind === 'unreadable') {
      console.warn(`[analysis] ${JSON.stringify(manuscriptId)}: manuscript-edits.json unreadable for the hints check`, edits.error);
    }
    console.log(
      `[analysis] hints check not run manuscript=${JSON.stringify(manuscriptId)} ` +
        `pure=${pure} positional=${positional} marker=${state.sentencesPredateChapters === true} edits=${edits?.kind ?? 'unread'}`,
    );
    return { kind: 'proceed', why: 'main-rule' };
  }
  const result = checkParseHintsPairing({
    stateChapters: state.chapters,
    sentences: edits.kind === 'ok' ? sentencesOf(edits.value) : [],
    parse: chapterHints.map((h, i) => ({ title: parseTitles![i] ?? null, body: h.body })),
    evidenceLess: 'count-id',
  });
  if (result.paired) return { kind: 'proceed', why: 'checked' };
  console.warn(`[analysis] ${JSON.stringify(manuscriptId)}: parse-fallback hints do not pair with state`, result);
  return { kind: 'refuse', why: result.reason === 'displaced-block' ? 'displaced-block' : 'score' };
}

analysisRouter.post('/:id/analysis', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;
  /* D2 (#3169) — `requestedModel` / `requestedFresh` used to be parsed much
     further down (right before the Phase 0 analyzer selection), so nothing
     logged between a Start click reaching this handler and that point: the
     language pre-flight below, getOrHydrateManuscript (a cold re-parse of
     the book on a cache miss), and the design-busy / rejoin checks all ran
     silent. Parsing here instead — before anything that can be slow —
     changes no behaviour (req.body is already fully parsed by the time this
     handler runs) but lets this one unconditional log line cover the whole
     span: a stall anywhere before the job's first milestone is now
     distinguishable from "the click never reached the server", which is
     exactly the ambiguity that made #3084 undiagnosable.
     F2 (#3169 fix wave) — this is now a per-POST line, not a per-click one:
     the stream middleware's own subscribe POST (fired on the first tick of
     every run, and on every reload/rejoin) reaches this same handler with no
     body, so one Start click can log this line more than once. `model` and
     `manuscriptId` are both request-supplied text (the latter is `req.params.id`,
     which Express decodes from the URL before any validation runs) and both
     are stringified (F2/F6, hardened post-review) so a LAN client can't
     inject a forged `[analysis]` line via a newline in either. */
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
  const requestedFresh = req.body?.fresh === true;
  console.log(
    `[analysis] request received manuscript=${JSON.stringify(manuscriptId)} ` +
      `model=${JSON.stringify(requestedModel ?? '(saved/default)')} fresh=${requestedFresh}`,
  );

  /* Task 6c (#2246) pre-flight gate — resolve the book's language BEFORE the
     SSE headers open, so a *located* book that never declared a language
     answers a real HTTP `409 { error: 'language_unset' }` instead of a
     streamed 200 that silently analyses in English. This is the one reader
     site whose naive swap is a no-op: `resolveBookLanguageForManuscript` now
     throws `BookLanguageUnsetError` for that case (previously it was caught
     and collapsed to 'en' by the whole-body catch). The two genuinely
     pre-confirm carve-outs still resolve 'en' and sail through here:
     - `located === null` — no book on disk yet, nothing to have been set.
     - a scan lookup failure — never block analysis on a disk read. */
  try {
    await resolveBookLanguageForManuscript(manuscriptId);
  } catch (e) {
    if (e instanceof BookLanguageUnsetError) {
      return res.status(409).json({ error: 'language_unset' });
    }
    throw e;
  }

  /* #3435 decision A, early check — a POST that would START a job is refused
     while a subset run is registered, and (unless fresh) while the previous
     main run still drains. A join to a live main run is never refused. The
     same check runs again at registration (the late check below), because
     this handler awaits before it registers. */
  {
    const live = inFlightAnalysisByManuscript.get(manuscriptId);
    const joins = !!live && !live.controller.signal.aborted && !requestedFresh;
    const refusal = joins ? null : mainStartRefusal(manuscriptId, requestedFresh);
    if (refusal) {
      console.log(`[analysis] refused ${refusal.error} manuscript=${JSON.stringify(manuscriptId)}`);
      return res.status(409).json(refusal);
    }
  }

  /* #3829 -- a START (not a join of a live run) on a book with out-of-sync chapter hints is
     refused before the stream opens. Hydrating here is not new work: the later lookup is a hit. */
  {
    const live = inFlightAnalysisByManuscript.get(manuscriptId);
    if (!(live && !live.controller.signal.aborted && !requestedFresh)) {
      const rec = await getOrHydrateManuscript(manuscriptId);
      const verdict = rec ? await parseHintsStartCheck(manuscriptId, rec, { fresh: requestedFresh }) : null;
      if (verdict?.kind === 'refuse') {
        console.log(`[analysis] refused hints_out_of_sync manuscript=${JSON.stringify(manuscriptId)} why=${verdict.why}`);
        const e = new HintsOutOfSyncError();
        return res.status(409).json({ error: e.message, code: e.code });
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  /* Vite's dev proxy (http-proxy under the hood) closes the upstream
     connection if it sees no body data for a while after the headers
     land — which is what happens on a cold server while the analyzer
     prepares its first chapter (a start's hydrate itself now runs BEFORE
     the headers, for the #3829 refusal; a join still hydrates after them). The proxy fires RST, the route's
     req.on('close') runs, the analysis aborts before the first
     chapter is even prepared. Writing a single SSE comment (`:ok\n\n`)
     right after flushHeaders keeps the stream visibly "active" so the
     proxy doesn't bail. Comments are ignored by EventSource and by
     our SSE reader (we filter for `data:` lines), so this is invisible
     downstream. Plus a periodic keep-alive comment below covers
     subsequent silent stretches (e.g. a slow first-chapter Ollama call). */
  res.write(':ok\n\n');
  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch {
      /* socket gone */
    }
  }, 15_000);

  /* Per-request send used for early validation errors (before the job
     has been created) and as the subscriber's send function once we
     join / create a job. broadcastToJob() iterates the job's
     subscribers and invokes each subscriber's send. */
  const send = (payload: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };

  /* In-memory lookup with a workspace-disk fallback. Lets the analysis
     resume after a server restart for any book that lives in the workspace
     tree (state.json carries the manuscriptId). */
  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) {
    send({
      kind: 'error',
      code: 'unknown_manuscript',
      message: `No manuscript found for id "${manuscriptId}". Upload a manuscript or open a workspace book to start analysis.`,
    });
    clearInterval(keepAlive);
    return res.end();
  }

  /* Mutual exclusion: a "Design full cast" run is writing per-character voices
     to this book's cast.json. Re-analysis rewrites the whole cast and would
     race those writes, so refuse to start while a design job is live. (No live
     analysis can exist to subscribe to here — the design guard blocks starts —
     so blocking unconditionally is safe.) */
  if (record.bookDir && isDesignBusy(record.bookDir)) {
    send({
      kind: 'error',
      code: 'design_in_progress',
      message:
        'A "Design full cast" run is in progress for this book. Wait for it to finish (or cancel it) before re-analysing.',
    });
    clearInterval(keepAlive);
    return res.end();
  }

  /* #3141 step 4 — optional per-run phase model picks, carried on the
     analysis request itself and never written to settings. Empty/absent
     values are ignored, not rejected. */
  const requestedPhase0Model =
    typeof req.body?.phase0Model === 'string' && req.body.phase0Model.trim().length > 0
      ? req.body.phase0Model
      : undefined;
  const requestedPhase1Model =
    typeof req.body?.phase1Model === 'string' && req.body.phase1Model.trim().length > 0
      ? req.body.phase1Model
      : undefined;
  /* `allowStage1Shrink` is the user's opt-in when the route refused a
     stage1 write because the new roster would replace a much larger
     existing one (see stage1ShrinkRefused comment). The analysing
     view's "Accept smaller roster" button re-fires the same request
     with this flag so the next attempt skips the gate. */
  const allowStage1Shrink = req.body?.allowStage1Shrink === true;
  /* Read the prior outcome FILE OUTSIDE the critical section (before the
     existing-job check). The .await below would otherwise insert a gap into
     what must be an atomic "check existing, then set new job" window (#3004
     race case: two rejoin POSTs in the same tick both see existing===undefined,
     both suspend on the read, both create and register a job; the second wins
     and the first orphans, leaking markAnalysisBusy). Reading here (outside
     the map operations) keeps them atomic. */
  const priorOutcome =
    (shouldCheckForRejoinMiss(inFlightAnalysisByManuscript.get(manuscriptId), requestedFresh) &&
    record.bookDir)
      ? await readAnalysisLastOutcome(record.bookDir)
      : null;

  /* ── Dispatch: subscribe-vs-start.
     If a non-aborted job is already running for this manuscript AND we
     are not explicitly displacing it (fresh: true), join the existing
     job's subscriber set and replay its current state. Browser reload
     / navigate-away survival lives here — the second POST lands in
     this branch and the original analyzer keeps running untouched.
     Otherwise (no existing job, or fresh: true displacement), abort
     any prior job and start a new one detached in the background. */
  /* #3084 P14 + #3004 — double-checked dispatch. `joinLive` is today's rejoin body, unchanged. */
  const joinLive = (live: AnalysisJob): void => {
    /* F2 (#3169 fix wave) — the one outcome line for the attach path. The
       job object doesn't store the model it's running (only `engine`), so
       this deliberately omits `model` rather than printing the requesting
       POST's own `requestedModel` (or the saved default), which would be
       the WRONG model whenever the running job was started with an
       explicitly picked one. */
    console.log(`[analysis] subscribe manuscript=${JSON.stringify(manuscriptId)}`);
    const subscriber: AnalysisSubscriber = { send, res, keepAlive };
    live.subscribers.add(subscriber);
    replayCatchUp(live, send);
    res.on('close', () => {
      if (res.writableEnded) return;
      live.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — sticky semantics. The analyzer keeps running
         until /pause or the queue drains. */
    });
    res.on('finish', () => clearInterval(keepAlive));
  };
  let existing = inFlightAnalysisByManuscript.get(manuscriptId);
  /* 1. P14 — a reload joins the live job before any pre-run work: no digest read, no checks.
     An endpoint (or its key) deleted mid-run must not refuse the reload, and the running job
     keeps its own analyzer. */
  if (existing && !existing.controller.signal.aborted && !requestedFresh) {
    joinLive(existing);
    return;
  }
  /* 2. #3084 N7 + A3 — only a new job reads saved settings and the installed digests of its
     Ollama targets (bounded 2 s, fail-open). #3192 removed this POST's settings read; the checks
     need the saved endpoints and keys, and the read warms the cache resolveKnob reads for a
     saved phase-model override. */
  const userSettings = await readUserSettings();
  const requestedPhaseModels = { phase0: requestedPhase0Model, phase1: requestedPhase1Model };
  const preflightDigests = await resolvePreflightDigests(
    preflightTargets(['phase0', 'phase1'], requestedModel, userSettings, requestedPhaseModels),
  );
  /* #3711 — the run is a registered `analysis` job: a folder move/delete is refused (409
     book_busy) from registration until the job's tracked units have drained; it holds no
     book-op. The registration `await` sits AFTER the awaits above and BEFORE the
     synchronous re-check-and-register window inside `startMain`, so #3004's window stays
     `await`-free. `startMain` runs against the lease (the book as resolved under
     book-op); every join / refusal / selection-error return inside it releases the
     token. A record with no `bookId` (an upload not yet on disk) has no folder to
     protect and runs unregistered. */
  const startMain = async (lease: BookJobLease | null): Promise<unknown> => {
  /* PR #3714 review pass 6 — run on the record the lease names, read BEFORE the
     re-check below so #3004's window stays `await`-free. */
  const leased = await recordForLease(manuscriptId, record, lease);
  if ('refusal' in leased) {
    console.log(`[analysis] refused manuscript_replaced manuscript=${JSON.stringify(manuscriptId)}`);
    send(leased.refusal);
    clearInterval(keepAlive);
    return res.end();
  }
  /* 3. #3004 — those awaits reopened the check-then-register window: a concurrent POST may have
     registered a job while this one waited. Re-check with the same condition and join that
     job rather than start a second one. Reassigning `existing` also makes the displacement
     below abort a job registered during the wait (fresh: true) instead of orphaning it. */
  existing = inFlightAnalysisByManuscript.get(manuscriptId);
  if (existing && !existing.controller.signal.aborted && !requestedFresh) {
    joinLive(existing);
    return;
  }
  /* #3435 decision A, late check — after the last `await` above and in the same synchronous
     block as the registration below; never reached by a join (both join paths returned). Headers
     are flushed, so the refusal is an SSE terminal `error` frame with the same code; no job is
     registered and a live job is not displaced. */
  {
    const refusal = mainStartRefusal(manuscriptId, requestedFresh);
    if (refusal) {
      console.log(`[analysis] refused ${refusal.error} manuscript=${JSON.stringify(manuscriptId)}`);
      send(refusalFrame(refusal));
      clearInterval(keepAlive);
      return res.end();
    }
  }
  /* 4. #3084 P14 — pre-run checks and analyzer selection, for a NEW job only. All three calls
     are synchronous: no `await` from the re-check above to `inFlightAnalysisByManuscript.set`
     below, so the check-then-register window stays atomic (#3004). `preflight` stays in
     function scope: Task 3d.1 reads it. */
  let preflight: PreflightTarget[];
  let selection: AnalyzerSelection;
  const fallbackSwitch = new RunFallbackSwitch(); // #3084 wave 3d — this run's, handed to the job below
  try {
    preflight = preflightTargets(['phase0', 'phase1'], requestedModel, userSettings, requestedPhaseModels);
    runAnalyzerPreflight(preflight, userSettings, preflightDigests);
    selection = selectAnalyzerForPhase({ phase: 'phase0', model: requestedModel, phaseModel: requestedPhase0Model, fallbackSwitch });
  } catch (e) {
    /* #3084 P23/P14 — one coded event for every check or selection failure: 3b Task 3b.1a's
       helper classifies each class, never returns null, and carries its detail. This `catch`
       is 3b.1a's, unchanged; only the block above it moved and grew the two check calls. */
    send(analyzerSelectionErrorEvent(e));
    clearInterval(keepAlive);
    return res.end();
  }
  /* No log line here. On 80be2f1d the resolved selection is already logged once the
     dispatch decision has been made — `[analysis] start manuscript=… engine=… model=…`
     (`analysis.ts:3502-3504`, both values `JSON.stringify`d against log injection, #3169 F2).
     The conditional `[analysis] manuscript=…` line this block used to re-add no longer
     exists, so adding one here would duplicate the start line. */
  if (existing) {
    existing.controller.abort();
    /* Don't delete from the map here — the displaced job's own loop
       will hit the AnalysisAbortedError catch and call endJob, which
       deregisters only when it's still the current entry. We
       overwrite the map below. */
  }

  /* #3004 — reaching here means NO live job was found for this manuscript:
     either `existing` was never set, or it was set but already aborted
     (stale entry not yet cleaned up). That is exactly the ambiguous case a
     rejoining caller can't tell apart from "no job was found, so a
     brand-new one silently started" — signal it with one SSE event before
     the fresh job below starts. Skipped when `requestedFresh` is true: that
     is a caller-requested restart, not a rejoin, and it already knows it's
     starting fresh (point 4 of the fix).

     The event is emitted REGARDLESS of whether a persisted outcome file
     exists. A truly novel manuscript (never analysed here) has no file and
     no outcome to attach; a job that crashed or was interrupted before
     endJob's async write completed also has no file, but the job still died
     and the caller needs to know it. Both cases require the event. The
     priorOutcome is attached when available, omitted when the file is absent
     or unparseable (via buildRejoinMissEvent(null)). */
  /* Validate the persisted outcome's manuscript id against the current
     request, in case a book rename mid-job left a stale outcome from a
     different book in the path. */
  if (shouldCheckForRejoinMiss(existing, requestedFresh)) {
    if (priorOutcome && priorOutcome.manuscriptId === manuscriptId) {
      send(buildRejoinMissEvent(priorOutcome));
    } else {
      send(buildRejoinMissEvent(null));
    }
  }

  const job: AnalysisJob = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir: lease?.bookDir ?? leased.bookDir ?? null,
    engine: selection.engine,
    fallbackSwitch,
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
    ended: false,
    halting: false,
    left: false,
    liveWork: 0,
  };
  job.settled = new Promise<void>((resolve) => {
    job.resolveSettled = resolve;
  });
  inFlightAnalysisByManuscript.set(manuscriptId, job);
  /* #3435 decision A — a writer from here until it leaves (endJob + drain). */
  joinWriters(job);
  if (job.bookDir) markAnalysisBusy(job.bookDir);
  /* #3084 P1 — the endpoints both phases will use (Task 3c.10's `preflight` targets, resolved
     exactly as selection resolves them, per-run phase picks included) stay busy for the whole
     run, gaps between chunk calls included, so TTS eviction does not unload them mid-run. */
  job.releaseEndpointRun = markEndpointRunActive(endpointIdsForModelIds(preflight.map((t) => t.modelId)));
  const subscriber: AnalysisSubscriber = { send, res, keepAlive };
  job.subscribers.add(subscriber);
  res.on('close', () => {
    if (res.writableEnded) return;
    job.subscribers.delete(subscriber);
    clearInterval(keepAlive);
    /* Sticky: do NOT abort the controller on subscriber disconnect.
       The analyzer keeps running for any other observers (or for
       none — its writes still land on disk). Only /pause or a
       fresh: true displacement aborts. */
  });
  res.on('finish', () => clearInterval(keepAlive));

  /* F2 (#3169 fix wave) — the one outcome line for the new-job path, naming
     the RESOLVED engine/model (not the raw `requestedModel`, which may be
     undefined when the saved per-phase default applies). Replaces the old
     unconditional-but-mid-handler `[analysis] manuscript=… engine=…
     model=…` line above — this is the same information, logged once the
     dispatch decision (new job vs. subscribe) has actually been made.
     `selection.model` is stringified (F6): `selectAnalyzerForPhase`'s
     priority 2 (per-request override) passes the request body's `model`
     straight through to `selectAnalyzer`, which returns it verbatim as
     `selection.model` — so this can carry request text just like
     `requestedModel` above, and needs the same log-injection guard.
     `manuscriptId` is stringified too (post-review hardening) — see the
     `request received` comment above for why it needs it just as much. */
  console.log(
    `[analysis] start manuscript=${JSON.stringify(manuscriptId)} engine=${selection.engine} model=${JSON.stringify(selection.model)}`,
  );

  /* Run the analyzer in the background. Express won't end this
     response until res.end() is called explicitly (by endJob() inside
     runMainAnalyzerJob), so the response stays open and continues to
     receive broadcast events for the lifetime of the job. */
  await runMainAnalyzerJob(job, leased, selection, {
    requestedFresh,
    allowStage1Shrink,
    requestedModel,
    requestedPhase0Model,
    requestedPhase1Model,
  }).catch((e) => console.error('[analysis] main job rejected', e));
  /* #3711 — hold the lease until the tracked units have actually drained (NOT the
     drain deadline). A job the runner never ended has nothing left to wait for. */
  if (job.ended) await job.settled;
  };
  if (!record.bookId) {
    void startMain(null).catch((e) => console.error('[analysis] main job failed', e));
    return;
  }
  let registered;
  try {
    registered = await runBookJob(record.bookId, 'analysis', startMain);
  } catch (e) {
    console.error('[analysis] job registration failed', e);
    send({ kind: 'error', code: 'lock-contention', message: requestFailureMessage(e, 'Could not start the analysis.') });
    clearInterval(keepAlive);
    return res.end();
  }
  if (registered === BOOK_GONE) {
    send({ kind: 'error', code: 'book_not_found', message: 'Book not found.' });
    clearInterval(keepAlive);
    return res.end();
  }
  registered.done.catch((e) => console.error('[analysis] main job failed', e));
});

export interface MainAnalyzerJobOpts {
  requestedFresh: boolean;
  allowStage1Shrink: boolean;
  /* Plan 88 — when the route layer received an explicit `model` in the
     request body, that per-request id wins (precedence priority 3). Both
     phases resolve through `selectAnalyzerForPhase`, so a present
     `requestedModel` collapses the split to a single model for this run;
     when absent, the saved per-phase override (priority 4) applies. */
  requestedModel: string | undefined;
  /* #3141 step 4 — this request's own `phase0Model` / `phase1Model` picks
     (priority 2, only losing to an explicit env pin). Phase 0's selection
     already consumed `requestedPhase0Model` in the route handler before
     `selection` was built; it still travels into the job body so
     `pipelinedPerPhase` below can tell a per-run split from the legacy
     single-model path. */
  requestedPhase0Model?: string | undefined;
  requestedPhase1Model?: string | undefined;
}

/* Detached analyzer loop body. Runs as a background promise spawned
   from the main POST handler; broadcasts every event to job.subscribers
   and tracks replay state via trackForReplay. Ends all subscribers + de-
   registers the job from the in-flight map via endJob on any exit path
   (normal completion, error, abort).
   Exported for plan-88-follow-up testing — the route's pipelining
   contract (Phase 0 + Phase 1 pools running concurrently via
   Promise.all, back-pressure semaphore engaging in production code
   paths, not just unit tests of the watermark) needs end-to-end
   coverage that drives this body with spy analyzers + a stub record. */
/* fs-2 — resolve a manuscript's book language for the analyzer preamble.
   Returns the book's BCP-47 language, or 'en' when no book is found on disk
   yet (analysis can run pre-confirm in some paths). Task 6c call-site parity —
   this is the ONE reader site the earlier children carved out because the
   naive `bookStateLanguage`→`requireBookStateLanguage` swap is a no-op behind
   a whole-body `catch { return 'en' }`. That swallow is now gone for the
   located-with-no-language case: a *located* book that never declared a
   language is a fact, not English, so it throws `BookLanguageUnsetError` and
   the caller decides how to surface it (the POST handler answers a real HTTP
   409; the detached loop emits an SSE `language_unset` error). The two
   fail-open carve-outs that are genuinely pre-confirm still resolve 'en':
   - `located === null` — no book on disk yet, so there is no language to have
     been set (deliberate carve-out, must survive).
   - a scan *lookup* failure — a disk read must never block analysis.
   Everything else uses the honest strict reader. */
export async function resolveBookLanguageForManuscript(manuscriptId: string): Promise<string> {
  let located: Awaited<ReturnType<typeof findBookByManuscriptId>>;
  try {
    located = await findBookByManuscriptId(manuscriptId);
  } catch {
    return 'en';
  }
  if (!located) return 'en';
  return requireBookStateLanguage(located.state);
}

/* #938 — the book's byline author (cover/byline name), for the Layer A front-matter
   strip + the Layer B roster guard. Mirrors resolveBookLanguageForManuscript's
   fail-open shape: "" on any miss so the guard/strip degrade to no-ops. */
export async function resolveBookAuthorForManuscript(manuscriptId: string): Promise<string> {
  try {
    const located = await findBookByManuscriptId(manuscriptId);
    return located?.state?.author ?? '';
  } catch {
    return '';
  }
}

/* #3084 P20 — the non-story classifier (Signal 2 of the front-matter guard)
   runs after both tail overflow checks, so an overflow only it saw cannot halt
   the run: the result is already complete. It is reported as a non-fatal
   warning instead of a silent fallback to title-only detection. Shared by the
   main and subset routes; the caller sends it at most once, and only when no
   earlier overflow halted the run (that rethrew before the guard ran). */
const NONSTORY_OVERFLOW_WARNING_CODE = 'analyzer-reasoning-overflow-nonstory';
/* The advice half comes from `reasoningOverflowAdvice` — the same source as the
   failure's structured fixes list — so the two cannot drift (#3084 pass-3). */
export function nonStoryOverflowWarningMessage(ctx: Parameters<typeof reasoningOverflowAdvice>[0]): string {
  const advice = reasoningOverflowAdvice(ctx);
  return (
    'The analyzer model ran out of output while reasoning during the front-matter (non-story) check, so ' +
    'front-matter detection used chapter titles only for this run. The analysis itself completed.' +
    (advice ? ` To fix it: ${advice}.` : '')
  );
}

export async function runMainAnalyzerJob(
  job: AnalysisJob,
  record: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>,
  selection: AnalyzerSelection,
  opts: MainAnalyzerJobOpts,
): Promise<void> {
  const manuscriptId = job.manuscriptId;
  /* D1 (#3169) — hoisted ahead of the try below so a throw anywhere in the
     ~150-line setup span (fs-2 language resolution through the GPU/CPU
     probe) has the same values available to the catch's terminal-failure
     handling as a throw inside the stage-1/stage-2 pipeline that follows.
     activeModelId is mutable — a local→Gemini fallback (StageCall.onFallback,
     below) reassigns it to the effective Gemini model so subsequent phase
     events + a failure's log line name the model that's actually running,
     not the dead local primary. lastStep mirrors the most recent phase
     milestone (set by `log` below) so a failure's log line names where it
     wedged, not just a stack. Neither's initial value changes by moving the
     declaration up — both are still first set from the same expressions
     they always were. */
  let activeModelId = selection.model;
  /* #3084 P30 — the engine the active model resolves to; reassigned together with
     activeModelId on a fallback switch, so every later chunk budget reflects the target, not the
     primary. job.engine does not follow it alone: setPhaseEngine records this phase's engine and
     re-derives job.engine from both phases (whoever holds a card wins). */
  let activeEngine: AnalysisEngine = selection.engine;
  setPhaseEngine(job, 0, selection.engine);
  const analyzerLabel = engineLabel(selection.engine, activeModelId);
  /* #3435 — the Phase-1 label, hoisted so the terminal catch can name the
     Phase-1 model for a failure that happened there. Set where Phase 1's
     selection resolves, below. */
  let phase1TerminalLabel: string | undefined;
  /* `lastStep` mirrors the most recent phase milestone to the server log (so a
     stall's last log line names where it wedged) and feeds the fatal-error log
     below (so a failure names its phase, not just a stack). */
  let lastStep = 'init';

  try {
    /* fs-2 — book language for the analyzer preamble + Cyrillic token estimate.
       Resolved once per job; threaded into every runStage* call below.
       Task 6c: `resolveBookLanguageForManuscript` now throws BookLanguageUnsetError
       for a *located* book that never declared a language (instead of silently
       reading 'en'), so the detached loop must surface it rather than analyse in
       English. This job body runs with no `res` to answer with, so it emits an
       SSE `error` with code `language_unset` through the same
       `endJob`/broadcast mechanism `classifyAnalysisFailure` uses for
       lock-contention. The subscribed `BookLanguageUnsetError` message is the
       curated, client-facing sentence — it carries no filesystem path, so the
       SSE `error` body leaks nothing over LAN HTTPS. */
    let bookLanguage: string;
    try {
      bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);
    } catch (e) {
      if (e instanceof BookLanguageUnsetError) {
        endJob(job, { kind: 'error', code: 'language_unset', message: (e as Error).message });
        return;
      }
      throw e;
    }
    /* #938 Layer A — resolve the byline author + strip title-page/e-library
       boilerplate from each chapter body BEFORE the model sees it. Mutates the
       cached record's hints in place; the analysis run itself never writes them
       to disk, but a later restructure persists whatever bodies the record holds
       to manuscript-hints.json (#3703), stripped ones included. Harmless: the
       strip is idempotent, so a hydrate that returns stripped bodies and a re-run
       over them change nothing. */
    const bookAuthor = await resolveBookAuthorForManuscript(manuscriptId);
    for (const ch of record.chapterHints) {
      ch.body = stripFrontMatterBoilerplate(ch.body, { author: bookAuthor, title: record.title });
    }
    const requestedFresh = opts.requestedFresh;
    const allowStage1Shrink = opts.allowStage1Shrink;
    const abortController = job.controller;
    const analyzer = selection.analyzer;
    const recordRef = record;

    /* Plan 88 / 118 / #3141 step 1 — pipelined two-model analyzer.
       Both phases resolve through `selectAnalyzerForPhase`, which applies
       the documented precedence (env ANALYZER_PHASE{0,1}_MODEL > per-run
       `phase0Model`/`phase1Model` > per-request `model` > saved Advanced
       Settings override > default). So:
         - No per-phase override + no per-request model → both phases run the
           same default model (single-model path, unchanged).
         - Per-phase overrides set + no per-request model → Phase 0 and Phase 1
           run DIFFERENT models, splitting the load across two free-tier
           rate-limit buckets.
         - A per-request `model` (priority 2) collapses both phases to that
           model for this run (env still trumps it).

       The watermark decides the dispatch contract. When the per-phase split
       is active, Phase 1 chapter K dispatches once Phase 0's
       watermark reaches `K + LAG` — `runPhase0Pool` and `runPhase1Pool` run
       concurrently, joined by the outer `Promise.all` below. Otherwise the
       sequential stub makes Phase 1 wait for `markPhase0AllDone()` (today's
       hard phase gate). */
    const phase1Selection: AnalyzerSelection = selectAnalyzerForPhase({
      phase: 'phase1',
      model: opts.requestedModel,
      phaseModel: opts.requestedPhase1Model,
      fallbackSwitch: job.fallbackSwitch,
    });
    const phase1Analyzer = phase1Selection.analyzer;
    /* Mutable for the same reason as activeModelId — Phase 1's stage2Call.onFallback
       reassigns it to the effective Gemini model on a local→Gemini switch. */
    let phase1ModelId = phase1Selection.model;
    /* #3084 P30 — reassigned together with phase1ModelId on a fallback switch. */
    let phase1Engine: AnalysisEngine = phase1Selection.engine;
    setPhaseEngine(job, 1, phase1Selection.engine);
    const phase1AnalyzerLabel = engineLabel(phase1Selection.engine, phase1ModelId);
    phase1TerminalLabel = phase1AnalyzerLabel;
    /* srv-59 Task 9b — ONE escalation-window budget shared across every
       chapter's attributeChapterStage2 call below, so the cap is per-BOOK
       (`analyzer.structure.maxWindowsPerBook`), not silently reset per chapter. */
    const structureBudget = { remainingWindows: configValue<number>('analyzer.structure.maxWindowsPerBook') };
    /* srv-59 Task 9b (review follow-up) — build the 'cloud' escalation
       analyzer ONCE per book (mirrors structureBudget above), not per chapter:
       a per-chapter build constructed a throwaway GeminiAnalyzer (and re-warned
       on a missing key) on every chapter in cloud mode. `undefined` when the
       mode isn't 'cloud' — attributeChapterStage2 only consults this field
       when it is. */
    const escalationAnalyzer =
      configValue<string>('analyzer.structure.escalation') === 'cloud' ? buildCloudEscalationAnalyzer() : undefined;
    const hasPerRunPhasePick = Boolean(opts.requestedPhase0Model) || Boolean(opts.requestedPhase1Model);
    const pipelinedPerPhase = !opts.requestedModel && isPerPhaseModelSelectionActive(hasPerRunPhasePick);
    /* The watermark is built after the prior cast is read (below): whether Phase 1
       is held for the match plan depends on it (plan 291 rule 10). */

    /* Best-effort GPU/CPU detection for the first-chapter ETA rate (issue 3).
       Only meaningful for local Ollama; cloud engines pass 'unknown' → the
       Gemini rate. Failures degrade to 'unknown' → the CUDA rate (the app's
       target box), and the estimate self-corrects from observed pace anyway. */
    const usesLocalAnalyzer = selection.engine === 'local' || phase1Selection.engine === 'local';
    if (usesLocalAnalyzer) job.ollamaServed = true;
    const analyzerDevice: 'cuda' | 'cpu' | 'unknown' = usesLocalAnalyzer
      ? await detectOllamaDevice()
      : 'unknown';
    /* Only a job that actually probed the local Ollama analyzer may update the
       GLOBAL cross-charge cache (W2.6, analyzer-device-state.ts) — it's a
       single process-wide value shared across every concurrent book. A
       cloud-only job's 'unknown' here says nothing new about the local
       analyzer's real placement and must not clobber a still-accurate 'cpu'/
       'cuda' reading another concurrent/prior local job established. */
    if (usesLocalAnalyzer) {
      setLastKnownAnalyzerDevice(analyzerDevice);
    }

    const send = (payload: unknown) => {
      const stamped = withRunEngine(job, payload);
      broadcastToJob(job, stamped);
      trackForReplay(job, stamped);
    };
    const log = (phaseId: number, message: string) => {
      send({ kind: 'log', phaseId, message });
      lastStep = `phase=${phaseId} ${message}`;
      console.log(`[analysis] mns=${manuscriptId} ${lastStep}`);
    };

    const startedAt = Date.now();
    const phaseStarts: Record<number, number> = {};

    const markPhase = (id: number) => {
      phaseStarts[id] = Date.now();
    };
    const endPhase = (id: number) => Date.now() - (phaseStarts[id] ?? Date.now());

    const sourceChars = record.sourceText.length;
    const wordCount = record.sourceText.split(/\s+/).filter(Boolean).length;
    /* Pre-flight estimate uses the static baseline for both stages. After
       stage 1 completes we replace stage2EstMs with one derived from the
       *observed* rate, so the second bar reflects actual model speed. */
    const stage1EstMs = clampStageEstMs(sourceChars / STAGE1_BASELINE_RATE);
    let stage2EstMs = clampStageEstMs((sourceChars / STAGE1_BASELINE_RATE) * STAGE2_STRETCH);

    /* Load any partial progress from a previous attempt. Cached stage 1 is
       reused as-is; cached chapters are skipped in the stage 2 loop. The
       `fresh: true` flag (parsed in the route handler and forwarded as
       opts.requestedFresh) discards the cache before any analyzer work
       begins. */
    /* Snapshot the existing cast's designed-voice links BEFORE any interim
       write clobbers cast.json, so the final roster preserves them across a
       re-analysis (#518 — re-attribution must not strip designed voices).
       Plan 291 rule 8 (#4031): Start fresh keeps the user's decisions, so a fresh
       run reads its prior exactly like any other run — series links and declines
       included. The 2026-07-14 Coalfall voice-strip incident (fresh captured
       nothing here, so the interim/final merge overwrote cast.json voiceless) and
       #3920's pinned-voice carve-out both came from fresh being a special case
       of this read. */
    const priorSnapshot = recordRef.bookDir
      ? await readPriorCastForMerge(recordRef.bookDir)
      : { rows: [], source: 'none' as const };
    let priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = priorSnapshot.rows;

    /* The stale-link prune and the identical-name heal of the prior cast run at the
       start of the run proper (below, after the cache is classified): they are written
       to cast.json under the cast lock by materialisePriorAtRunStart. */

    /* R50 (PR #4103 pass 1 F2) — Start fresh carries the rule-11 ledger (`addedRows`, with
       its `runAddedPairs`): the rows a stopped run added stay known as that run's own, so the
       next persist still drops the untouched ones and keeps the ones the user changed. Read
       from a current cache only (a legacy one holds no ledger); an unreadable cache carries
       nothing, as before. Everything else in the cache is discarded. */
    let freshCarry: Pick<AnalysisCache, 'addedRows' | 'runAddedPairs'> = {};
    if (requestedFresh) {
      try {
        const before = await loadAnalysisCache(manuscriptId);
        if (before.version === ANALYSIS_CACHE_VERSION) {
          freshCarry = { addedRows: before.addedRows, runAddedPairs: before.runAddedPairs };
        }
      } catch (err) {
        console.warn('[analysis] Start fresh could not read the analysis cache; its run ledger is not carried', err);
      }
      await clearAnalysisCache(manuscriptId);
      /* PR #4103 pass 2 P2-3 (b) — written straight after the clear, before the steps below
         that can throw (the edits rm, the journal refs, the state.json un-confirm): a fault
         there must not lose the ledger, which nothing else could rebuild. The new cache holds
         only the ledger, so it still classifies `empty`. */
      const carriedLedger = freshCarry.addedRows && Object.keys(freshCarry.addedRows).length > 0 ? freshCarry.addedRows : undefined;
      const carriedPairs = freshCarry.runAddedPairs?.length ? freshCarry.runAddedPairs : undefined;
      if (carriedLedger || carriedPairs) {
        await mutateAnalysisCache(manuscriptId, {
          createIfAbsent: true,
          version: ANALYSIS_CACHE_VERSION,
          ...(carriedLedger ? { ledger: carriedLedger } : {}),
          ...(carriedPairs ? { runAddedPairs: carriedPairs } : {}),
        });
      }
      /* Match the filesystem to the cleared cache state: the per-sentence edits
         go with the cache, or the library card would briefly show stale lines
         against an empty cache. `rm({ force: true })` is a no-op when the file
         doesn't exist (manuscripts uploaded via the legacy non-workspace path
         have no bookDir; the guard keeps it cheap).

         Plan 291 rule 8 (#4031) — Start fresh KEEPS cast.json, the reparse
         carryover, the merge journal's merges, the suggestions and the history:
         merges, declines, dismissals and series links are the user's decisions,
         not analysis output. It used to delete all of them here (under the cast
         lock). */
      if (recordRef.bookDir) {
        /* #3435 — every file below is touched only through the identity-verified
           LIVE book dir (mode:'drop', #2196), never `recordRef.bookDir` directly:
           a renamed book whose old path now holds another book (or nothing)
           must lose none of its files to this fresh run. */
        await withVerifiedBookDir(
          { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
          async (freshBookDir) => {
            /* #3784 — `book`-locked, so a slice PUT that passed its manuscript
               check cannot recreate the pre-wipe file after this delete. */
            await withOptionalBookLock(recordRef.bookId, async () => {
              const editsPath = manuscriptEditsJsonPath(freshBookDir);
              await enqueuePathOp(editsPath, () => rm(editsPath, { force: true }));
            });
            /* The kept journal's manual entries point at sentences this run
               regenerates, and unlink-alias intersects by them - so the merges stay
               and their refs go; an unlink then offers lines by alias match alone.
               Cast-locked: a manual merge appends to the journal under that lock. */
            await withCastLock(freshBookDir, () => clearAffectedRefs(freshBookDir));
            /* #3435 O1 — Start fresh un-confirms the book, as Re-parse does
               (`applyReparse`, book-state.ts): this run re-derives the cast, so a book
               still marked confirmed would read "done" while it is rebuilt. It reads
               "Analysing" until this run persists and the user confirms again.
               #2196 — through the identity-verified LIVE book dir in mode:'drop':
               a stale path (moved book, or one now holding another book) is
               never written. */
            /* #3400 pass 8 — a book-locked read -> write (`updateStateAtDir`),
               taken AFTER the cast lock above has been released (order: `cast`
               -> `book`, never held together). The decision (is it confirmed?)
               is made from the read under the lock, so a restructure or a
               concurrent state write is not reverted by a pre-lock snapshot.
               #3700 — inside it the read -> write is also a fresh re-read under
               the per-book `state-json` leaf lock. That lock HAS an acquisition
               bound (the book lock does not), so a timeout can surface here as
               the curated lock-contention error; this site is outside the
               persist blocks, so it reaches the job's top-level catch, which
               classifies it (`classifyAnalysisFailure`). */
            /* Plan 289 — also rotates `editEpoch` (a wipe moves every revision
               token), so this write is no longer skipped for an unconfirmed
               book. */
            await updateStateAtDir(freshBookDir, (freshState) => ({
              ...freshState,
              castConfirmed: false,
              editEpoch: mintEditEpoch(),
              updatedAt: new Date().toISOString(),
            }));
          },
        );
      }
      log(0, 'Discarded cached progress — starting from scratch.');
    }
    const loadedCache = await loadAnalysisCache(manuscriptId);
    /* Plan 291 cache lifecycle (#4031, A22): a non-empty cache without the current
       version holds seeded rows and unplanned takes - nothing in it is reused. It
       is classified BEFORE the load-rules save and the run start below. */
    const legacyCache = classifyAnalysisCache(loadedCache) === 'legacy';
    if (legacyCache) {
      await clearAnalysisCache(manuscriptId);
      log(0, 'Discarded a cached analysis from an older version — starting from scratch.');
    }
    const cache: AnalysisCache = legacyCache ? { chapters: {} } : loadedCache;
    /* Every non-legacy cache this job holds is version 2 (a save writes the
       version it is given, so the in-memory copy must carry it). The first write
       creates the file when this is a new book's first run. */
    cache.version = ANALYSIS_CACHE_VERSION;
    /* A Start fresh's carried ledger (R50) is already in the cache it just loaded. */
    await mutateAnalysisCache(manuscriptId, { createIfAbsent: true, version: ANALYSIS_CACHE_VERSION });
    /* #3435 M0/M1 — heal word-free records; while stage1 is absent, a failed
       chapter's take is pending. */
    if (applyAnalysisLoadRules(cache, recordRef.chapterHints)) {
      await mutateAnalysisCache(manuscriptId, { fields: cacheFields(cache, PHASE1_RECORD_FIELDS) });
    }

    /* ── Run start (plan 291, #4031): materialise the prior (shared with the subset
       job). */
    const verifiedDir: { value?: string } = {};
    priorCastForMerge = await materialiseRunStartPrior({
      job,
      record: recordRef,
      cache,
      prior: priorCastForMerge,
      log,
      verifiedDir,
    });
    /* Plan 291 rule 10: a book with a prior cast or any merge history holds Phase 1
       until Phase 0b has applied the plan. */
    const holdForPlan = await bookHasPriorOrHistory(verifiedDir.value, priorCastForMerge.length);
    const watermark: PhaseWatermark = createWatermarkForJob({ holdForPlan });
    if (pipelinedPerPhase) {
      console.log(
        `[analysis] manuscript=${manuscriptId} pipelined ` +
          `phase0=${selection.engine}:${selection.model} ` +
          `phase1=${phase1Selection.engine}:${phase1Selection.model} ` +
          `lag=${resolvePhase1MinLagChapters()}` +
          (holdForPlan ? ' held-for-plan' : ''),
      );
    }
    /* #3435 — endJob releases every Phase-1 worker parked on it. */
    job.watermark = watermark;
    const cachedChapters = cache.chapters ?? {};
    /* #3435 — chapters the replay will skip: a current take, not excluded. */
    const cachedChapterCount = recordRef.chapterHints.filter(
      (c) => !c.excluded && hasCurrentTake(cache, c.id),
    ).length;

    /* ── Phase 0: detecting characters.
       The route runs Phase 0a (per-chapter cast detection) over the
       parser's chapter list, merging each chapter's character output
       into a running roster and emitting cast-update events live. Once
       all chapters land, Phase 0b finalises the roster (sortEvidence,
       verifyEvidenceAgainstSource, assignPaletteColors) and stores it
       as cache.stage1. The expensive whole-book stage 1 call is gone —
       a 60-chapter book that used to hang for 10+ minutes now scrolls
       characters into view as each chapter completes. */
    markPhase(0);
    log(
      0,
      `Manuscript: ${wordCount.toLocaleString()} words, ${sourceChars.toLocaleString()} characters, ${record.chapterHints.length} chapter${record.chapterHints.length === 1 ? '' : 's'}`,
    );
    log(
      0,
      `Estimated total time: ~${humanSeconds(stage1EstMs + stage2EstMs)} (refined after stage 1)`,
    );

    /* Series-cast prior (C2). Resolves the source book's series-mates'
       confirmed characters via scanSeriesCharactersForBookId so the
       per-chapter detector recognises them by name/alias rather than
       re-detecting as fresh entities. Standalones / first-in-series
       books resolve to an empty list -- the prompt simply omits the
       section in that case. Resolved ONCE per analysis (not per
       chapter); the prior doesn't change mid-run. */
    let seriesPrior: SeriesPriorCharacter[] = [];
    if (recordRef.bookId) {
      try {
        const siblingRecords = await scanSeriesCharactersForBookId(recordRef.bookId);
        /* Dedup raw per-book rows into one entry per unique character
           before they reach the prompt and the pill. The producer scan
           emits one row per character per book, so a recurring regular
           contributes N rows across N prior books -- without dedup the
           pill claims an inflated count and the model gets duplicate
           rows in its "Known characters" section. The Profile Drawer's
           manual continuity-link picker still hits the un-deduped scan
           directly (server/src/routes/series-roster.ts) since it
           legitimately needs per-book provenance. */
        const merged = dedupSeriesPrior(siblingRecords);
        seriesPrior = merged.map((m) => ({
          id: m.id,
          name: m.name,
          aliases: m.aliases,
          /* library-cast-scan strips description from its projection
             so the merged entry's description is always undefined too;
             the prompt renders without it when absent. */
          description: m.description,
          fromBookTitles: m.fromBookTitles,
        }));
        if (seriesPrior.length > 0) {
          /* Distinct book sources, first three names, surfaced for the
             analysing view's "Carried from <series>" pill (C3) and for
             a one-line log entry the user can see on phase 0 entry. */
          const firstNames = seriesPrior
            .slice(0, 3)
            .map((p) => p.name)
            .filter(Boolean)
            .join(', ');
          const more = seriesPrior.length > 3 ? ` +${seriesPrior.length - 3}` : '';
          log(
            0,
            `Carrying in ${seriesPrior.length} character${seriesPrior.length === 1 ? '' : 's'} from prior books in this series (${firstNames}${more}).`,
          );
          send({
            kind: 'series-prior',
            count: seriesPrior.length,
            names: seriesPrior
              .slice(0, 3)
              .map((p) => p.name)
              .filter((n): n is string => typeof n === 'string'),
          });
        }
      } catch (priorErr) {
        /* Non-fatal -- a broken series scan must not block analysis.
           Log + carry on with an empty prior. */
        console.warn('[analysis] series prior scan failed:', priorErr);
      }
    }
    /* Plan 88 follow-up — definite-assignment assertion. `stage1` is
       set in both branches of the cache check (immediately for cache
       hit; via `runPhase0Pool` await for cache miss). TypeScript can't
       follow the assignment through the async closure, so we assert.
       Any code path reading `stage1` runs AFTER `await Promise.all`
       returns (or inside the cache-hit branch after assignment), so
       the invariant holds. */
    let stage1!: Stage1Output;
    const totalCastChapters = record.chapterHints.length;
    /* Plan 88 follow-up — pipelined Phase 0/Phase 1 execution.
       In pipelined mode (per-phase env vars set), Phase 1
       workers dispatch against a rolling-roster snapshot taken when
       the watermark releases their chapter (`awaitPhase1Dispatch`).
       `phase1Stage1Ready` flips true once Phase 0b consolidation (or
       a cache hit) has produced the finalised `stage1`. Before that,
       `getPhase1Stage1Snapshot` falls back to `rosterSnapshotFn()`
       which folds the rolling Phase-0 chapterCast into a fresh
       structured-clone snapshot. */
    let phase1Stage1Ready = false;
    let rosterSnapshotFn: (() => CharacterOutput[]) | null = null;
    const getPhase1Stage1Snapshot = (): Stage1Output => {
      /* Final-roster path: cache hit OR Phase 0b consolidation completed.
         Always preferred when available so chapters dispatching after
         `markPhase0AllDone()` use the verified + sorted + colour-assigned
         roster instead of the raw merged shape. */
      if (phase1Stage1Ready) return stage1;
      /* Pipelined mode: snapshot the rolling roster at dispatch time.
         The mergeRosterChapter function keeps insertion order stable, so
         two snapshots taken at the same watermark are deterministic. The
         snapshot is structured-cloned so a later Phase 0 merge can't
         retroactively mutate a Phase 1 worker's view. */
      if (rosterSnapshotFn) {
        /* Plan 291 rule 10: a book held for the plan never attributes against the
           raw rolling roster - the watermark keeps Phase 1 parked until Phase 0b
           has applied the plan, so reaching this is a bug, not a state. */
        if (holdForPlan) {
          throw new Error('Phase 1 asked for the rolling roster of a book held for the cast plan.');
        }
        return {
          characters: structuredClone(rosterSnapshotFn()),
          chapters: recordRef.chapterHints.map((c) => ({ id: c.id, title: c.title })),
        };
      }
      /* Should never reach here — watermark + cache shape pin the order.
         Fall through to an empty roster so the inbox is still well-formed
         (Phase 1 will produce all-narrator attributions for the chapter,
         which the reconcile pass downstream demotes cleanly). */
      return {
        characters: [],
        chapters: recordRef.chapterHints.map((c) => ({ id: c.id, title: c.title })),
      };
    };
    /* ── Plan 291 (#4031): the run's one cast-identity decision. Called with the raw
       stage-1 roster (Phase 0b, or a cache-hit resume) BEFORE `phase1Stage1Ready`
       flips and `markPhase0AllDone()` releases Phase 1, so no take is ever made in
       raw id space. In order:
         1. plan (`matchFreshToPrior`; a resume reuses the cached plan and
            `extendPlan`s the rows it does not cover);
         2. apply it (R29: everything after speaks plan-applied ids);
         3. link new rows only;
         4. patch the cache - the RAW roster stays in `stage1`, the plan and its
            decisions are stored beside it;
         5. snapshot the unfolded plan-applied roster with the plan's suggestions;
         6. patch the cache again - the ledger, the run's suggestion pairs and the
            decisions (a snapshot re-mint's id map is applied to the roster and to
            the cached takes).
       Returns the plan-applied roster; `planConstraints` / `planProtectIds` are set
       for the dedup and the live-view fold that follow. */
    let planConstraints: DedupConstraints = EMPTY_DEDUP_CONSTRAINTS;
    let planProtectIds: ReadonlySet<string> | undefined;
    /* R8: every id a Phase-0b snapshot re-minted. A pipelined first analysis makes
       Phase-1 takes before the plan exists; those already handed to the Phase-1 pool
       (`sentencesByChapter`, an in-flight take) are remapped through this when they
       are recorded and when the run stitches them. */
    let remintIdMap: Record<string, string> = {};
    const planCastIdentity = async (raw: CharacterOutput[]): Promise<CharacterOutput[]> => {
      const planned = await planRunCastIdentity({
        job,
        record: recordRef,
        bookLanguage,
        cache,
        prior: priorCastForMerge as PriorRow[],
        raw,
        log,
      });
      remintIdMap = { ...remintIdMap, ...planned.idMap };
      planConstraints = planned.constraints;
      planProtectIds = planned.protectIds;
      return planned.characters;
    };

    /* Failure signalling from Phase 0 to Phase 1 and to the post-Promise.all
       handler. When Phase 0 finishes with any chapters still in the failed
       set, we set this so Phase 1 workers can bail without dispatching and
       the outer code can emit the `cast_incomplete` SSE error. */
    let phase0FailedCount = 0;
    /* #3435 — the titles of those chapters, for the `cast_incomplete` copy. */
    let phase0FailedTitles: string[] = [];
    let stage1ActualMs = 0;
    /* Plan 88 follow-up — Promise.all arm for Phase 0. Set in the
       cache-miss branch (real work); stays `null` in the cache-hit
       branch (nothing to do). The outer Promise.all below filters
       null arms. */
    let phase0PoolPromise: Promise<void> | null = null;
    /* Observed-pace trackers for Phase 0a — declared at the route scope so
       Phase 1's ETA projection can read them too. SUM-of-per-chapter ms,
       not wall-clock; for wall-clock-rate use phase0WallClockMs below.
       Both stay 0 when Phase 0 is cached (cache hit path) since we never
       run any cast chapters in that case — the eta projection then falls
       back to Phase 1 samples / static baselines. */
    let castActualMsTotal = 0;
    let castActualCharsTotal = 0;
    let phase0WallClockMs = 0;
    /* Seed pace trackers from prior-run durations so a resumed analysis
       doesn't fall back to the static "30s + 0.5ms/char" formula on its
       first chapter just because the in-session counters are empty. The
       durations were saved by past runs of this exact route on this
       manuscript, so they're the best available signal for what this
       model+book combo will take. */
    const castDurations: Record<number, number> = durationsForEngine(
      cache.castDurations,
      cache.castDurationsEngine,
      selection.engine,
    );
    cache.castDurations = castDurations;
    cache.castDurationsEngine = selection.engine;
    for (const idStr of Object.keys(castDurations)) {
      const id = Number(idStr);
      const ch = record.chapterHints.find((c) => c.id === id);
      if (!ch) continue;
      castActualMsTotal += castDurations[id];
      castActualCharsTotal += ch.body.length;
    }
    /* Char totals for ETA projection. totalCastCharsAll: chars across all
       non-excluded chapters (Phase 0a iterates these). totalStage2CharsAll:
       same set since stage 2 runs the same non-excluded chapters. */
    const totalCastCharsAll = record.chapterHints
      .filter((c) => !c.excluded)
      .reduce((sum, c) => sum + c.body.length, 0);
    /* Emit an initial ETA up front so the heading swaps from the static
       Gemini-calibrated describeSize string (22ms/word) to an
       engine-aware projection immediately, even on a fresh run before
       any chapter completes. Uses cached durations when present (typical
       resume case); otherwise falls back to the per-engine ms/char rate. */
    {
      const fallbackMsPerChar = engineFallbackMsPerChar(selection.engine, analyzerDevice, endpointGpuFor(selection.model));
      const phase0CharsRemainingInitial = Math.max(0, totalCastCharsAll - castActualCharsTotal);
      const initialRemainingMs = projectRemainingMs({
        phase0WallClockMs: 0,
        phase0CharsDone: castActualCharsTotal,
        phase0CharsRemaining: phase0CharsRemainingInitial,
        phase1WallClockMs: 0,
        phase1CharsDone: 0,
        phase1CharsRemaining: totalCastCharsAll,
        fallbackPhase0Ms:
          fallbackMsPerChar * phase0CharsRemainingInitial + PHASE0_PER_CHAPTER_BASELINE_MS,
        fallbackPhase1Ms: fallbackMsPerChar * STAGE2_STRETCH * totalCastCharsAll,
      });
      send({ kind: 'eta', remainingMs: initialRemainingMs });
    }
    if (cache.stage1) {
      /* Phase 0 already completed on a prior run — short-circuit straight
         to the finalised roster. Still re-sort + re-verify in case the
         cache predates the current verifier pass. */
      const charCount = cache.stage1.characters.length;
      log(
        0,
        `Resuming — Phase 0 already complete (${charCount} character${charCount === 1 ? '' : 's'} cached).`,
      );
      send({
        kind: 'phase',
        phaseId: 0,
        progress: 1,
        label: PHASES[0].label,
        model: activeModelId,
      });
      stage1 = cache.stage1;
      sortEvidence(stage1.characters);
      const verified = verifyEvidenceAgainstSource(stage1.characters, record.sourceText, (msg) =>
        log(0, msg),
      );
      const before = stage1.characters.length;
      stage1.characters = dropEvidencelessCast(
        stage1.characters,
        (msg) => log(0, msg),
        record.sourceText,
      );
      if (verified.totalDropped > 0 || stage1.characters.length !== before) {
        /* Shrink guard — when the re-verify on the resume short-circuit
           would drop more than half of a non-trivial cached roster,
           refuse the rewrite unless the user explicitly opted in. The
           drop usually indicates source text drifted (e.g. user re-
           parsed the manuscript) and the previously-verified evidence
           no longer matches — better to surface the loss than write
           over a known-good roster. */
        if (stage1ShrinkRefused(before, stage1.characters.length) && !allowStage1Shrink) {
          log(
            0,
            `Stage 1 shrink refused — verifier would drop from ${before} to ${stage1.characters.length} characters. Re-run with allowStage1Shrink:true to confirm.`,
          );
          endJob(job, {
            kind: 'error',
            code: 'stage1_shrink_refused',
            message: `Verifier would drop the cast from ${before} to ${stage1.characters.length} characters. Confirm via allowStage1Shrink to accept the smaller roster.`,
            prevCharCount: before,
            nextCharCount: stage1.characters.length,
          });
          return;
        }
        cache.stage1 = stage1;
        await mutateAnalysisCache(manuscriptId, { stage1 });
      }
      // #2196 — dropped-quotes persistence is guarded in mode:'drop' so a
        // stale (moved/gone) dir is not recreated here; the terminal persist
        // block is the single halt gate (C4).
        await withVerifiedBookDir(
          { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
          async (bookDir) => {
            await persistDroppedQuotesBatch(bookDir, manuscriptId, 'analysis-stream', verified);
          },
        );
      /* Plan 291 (#4031): the cached stage 1 is the RAW roster. Settle its identity
         (reusing a cached plan, or planning now) BEFORE Phase 1 is released, so no
         take is made in raw id space. The cached `stage1` stays raw. */
      stage1 = { ...cache.stage1, characters: await planCastIdentity(cache.stage1.characters) };
      send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage, planConstraints, planProtectIds) });
      /* Plan 88 follow-up — cache hit: Phase 0 is already complete, so
         the plan-applied stage1 is the canonical roster for any Phase 1
         worker that asks for a snapshot. Flip the flag so
         `getPhase1Stage1Snapshot` returns `stage1` directly without
         consulting the (empty) rolling-roster fallback. Release any
         Phase 1 waiters immediately — there's no Phase 0 work to
         pipeline against. */
      phase1Stage1Ready = true;
      watermark.markPhase0AllDone();
    } else {
      /* Phase 0a — per-chapter cast detection. The chapterCast cache
         lets us resume mid-Phase-0a after a crash / rate-limit / model
         swap by replaying the per-chapter outputs we already have. */
      const chapterCast: Record<number, CharacterOutput[]> = cache.chapterCast ?? {};
      /* #3435 — over the non-excluded chapters, like the Phase-1 line: a
         failed cast's `[]` marker is not a cached cast. */
      const castFailed = new Set(castFailedChapterIds(cache, recordRef.chapterHints));
      const activeCastHints = recordRef.chapterHints.filter((h) => !h.excluded);
      const resumeCastCount = activeCastHints.filter(
        (h) => Object.hasOwn(chapterCast, h.id) && !castFailed.has(h.id),
      ).length;
      const cachedCastCount = Object.keys(chapterCast).length;
      const stage0Start = Date.now();
      log(
        0,
        `Detecting cast chapter-by-chapter across ${totalCastChapters} chapter${totalCastChapters === 1 ? '' : 's'} via ${analyzerLabel}…`,
      );
      if (resumeCastCount > 0) {
        log(
          0,
          `Resuming — ${resumeCastCount} of ${activeCastHints.length} chapter${activeCastHints.length === 1 ? '' : 's'} already cached.`,
        );
      }

      /* Replay the merge in chapter-id order whenever a new chapter lands,
         so the running roster is deterministic regardless of completion
         order under concurrency. The Map's insertion order also drives
         the cast-update payload's ordering — stable across renders. */
      const rebuildRoster = (): Map<string, CharacterOutput> => {
        const r = new Map<string, CharacterOutput>();
        for (const ch of recordRef.chapterHints) {
          const cast = chapterCast[ch.id];
          if (cast?.length) {
            /* #938 Layer B — keep the byline author out of every roster build
               (covers cached chapterCast too, unlike guarding only fresh writes).
               Framed author's-note chapters keep the author. */
            const guarded = dropBylineAuthorFromChapter(cast, {
              author: bookAuthor,
              chapterTitle: ch.title,
            });
            mergeRosterChapter(r, guarded.characters);
          }
        }
        return r;
      };
      /* Plan 88 follow-up — expose the rolling roster to the Phase 1
         worker's `getPhase1Stage1Snapshot()` helper. Closes over
         `chapterCast` so each Phase-1 dispatch sees whatever Phase 0
         workers have folded in at that moment. The snapshot fn returns
         a plain array (values()) — caller is responsible for the
         structuredClone if it wants isolation. */
      rosterSnapshotFn = (): CharacterOutput[] => Array.from(rebuildRoster().values());
      const emitCastUpdate = (): void => {
        const roster = rebuildRoster();
        /* Name-only fold so descriptor speakers ("The Jogger", "Drooly
           Boy", "Unknown Intruder") collapse into the Unknown male /
           Unknown female buckets in the live view. Plan 291 (#4031): this
           SSE frame is the only Phase-0a progress surface - the main job
           writes no cast.json until the Phase-0b snapshot, which writes the
           unfolded plan-applied roster. */
        const folded = previewFoldForLiveView(Array.from(roster.values()), bookLanguage, EMPTY_DEDUP_CONSTRAINTS);
        send({ kind: 'cast-update', characters: folded });
      };

      const completedCast = new Set<number>(Object.keys(chapterCast).map((k) => Number(k)));
      /* Chapters that hit a non-recoverable per-chapter failure (e.g.
         qwen3.5:4b truncated JSON output that survived the validation
         retry). Tracked separately from completedCast so the route can
         surface a final summary ("Phase 0 finished: 29/30 chapters,
         1 failed") instead of silently producing a smaller roster. */
      const failedCastChapters = new Set<number>();
      /* Excluded chapters never run Phase 0a, so the progress denominator
         counts only the chapters we'll actually process. Otherwise a book
         with 5 excluded chapters would stall the bar permanently below
         100%. The full `totalCastChapters` is still used for log/log-message
         framing ("Chapter 3/12 — Title") so the user sees their book's
         original chapter numbering. */
      const activeCastChapters = recordRef.chapterHints.filter((c) => !c.excluded).length;
      const excludedCastChapters = totalCastChapters - activeCastChapters;
      if (excludedCastChapters > 0) {
        log(
          0,
          `Skipping ${excludedCastChapters} excluded chapter${excludedCastChapters === 1 ? '' : 's'} (front/back-matter you opted out of narrating).`,
        );
      }
      const phase0Progress = (): number => {
        const done = completedCast.size;
        return activeCastChapters > 0
          ? Math.min(0.02 + 0.93 * (done / activeCastChapters), 0.95)
          : 1;
      };

      /* Initial cast-update + progress reflecting any cached cast. */
      send({
        kind: 'phase',
        phaseId: 0,
        progress: phase0Progress(),
        label: PHASES[0].label,
        model: activeModelId,
      });
      if (cachedCastCount > 0) emitCastUpdate();

      /* Tasks that need to run. Excluded chapters (front/back-matter the
         user opted out of narrating) never run Phase 0a — saves Gemini
         tokens and stops the roster from picking up characters only
         named in a Dedication or Copyright page.
         Chapters whose record is a CAST failure are re-queued on resume even
         though chapterCast[id] is populated (with []) — without this
         carve-out the failure marker would silently skip them forever,
         leaving the user to either Start fresh or hit the per-chapter Retry
         button one by one for every failed chapter. #3435 M3 — an
         attribution record is not re-queued: the chapter has its cast, and
         its take is pending (M1), so Phase 1 re-attributes it. */
      const failedSet = new Set(castFailedChapterIds(cache, recordRef.chapterHints));
      const castTaskIndices: number[] = [];
      for (let i = 0; i < totalCastChapters; i++) {
        const ch = recordRef.chapterHints[i];
        if (ch.excluded) continue;
        if (!chapterCast[ch.id] || failedSet.has(ch.id)) castTaskIndices.push(i);
      }
      const castConcurrency = analyzerPoolWidth();
      if (castTaskIndices.length > 0) {
        const requeuedFailedCount = castTaskIndices.filter((i) =>
          failedSet.has(recordRef.chapterHints[i].id),
        ).length;
        const requeueSuffix =
          requeuedFailedCount > 0 ? ` (including ${requeuedFailedCount} previously-failed)` : '';
        log(
          0,
          `Running ${castTaskIndices.length} chapter cast-detection${castTaskIndices.length === 1 ? '' : 's'}${requeueSuffix} with up to ${castConcurrency} in parallel.`,
        );
      }

      /* Per-chapter live ticker, mirroring Phase 1's structure so the
         frontend's existing LiveChapterTicker can render Phase 0 the
         same way. */
      interface CastInFlight {
        chapterIndex: number;
        chapterTitle: string;
        /** The start-of-chapter estimate (observed-rate or first-chapter
            fallback). Refined live via refineCastChapterEstMs at tick time. */
        baseEstMs: number;
        startedAt: number;
        /** Stage-1 chunker progress for the in-flight chapter (1 section when
            the chapter fits in one call). Drives the live ETA projection. */
        sectionsDone: number;
        sectionsTotal: number;
      }
      const castInFlight = new Map<number, CastInFlight>();
      const sendCastLiveTick = (): void => {
        const now = Date.now();
        const running = Array.from(castInFlight.values()).sort(
          (a, b) => a.chapterIndex - b.chapterIndex,
        );
        send({
          kind: 'phase',
          phaseId: 0,
          progress: phase0Progress(),
          label: PHASES[0].label,
          model: activeModelId,
          live:
            running.length > 0
              ? {
                  totalChapters: totalCastChapters,
                  /* Chapter-total elapsed (NOT the per-section call elapsed —
                     the chunker calls the model once per section).
                     sectionsDone/sectionsTotal are forwarded so the frontend
                     can render section-level progress within a chapter. */
                  chapters: running.map((r) => castInFlightEntryToLiveChapter(r, now)),
                }
              : undefined,
        });
      };

      async function runCastChapter(i: number): Promise<void> {
        const ch = recordRef.chapterHints[i];
        /* Per-chapter estimate. Prefer the observed pace from already-
           completed cast chapters — on local Ollama / qwen3.5:4b the
           real rate is 5–10× slower than Gemini, and the old static
           "30s baseline + 0.5ms/char" pegged a 20k-char chapter at
           ~0:40 even when prior chapters averaged 4-5ms/char. Falls
           back to the TTFT-dominated baseline only on the first
           chapter of the phase, when no samples exist yet. */
        const msPerCharFallback = engineFallbackMsPerChar(selection.engine, analyzerDevice, endpointGpuFor(selection.model));
        const fallback = PHASE0_PER_CHAPTER_BASELINE_MS + msPerCharFallback * ch.body.length;
        const chapterEstMs = chapterEstFromObserved(
          ch.body.length,
          castActualMsTotal,
          castActualCharsTotal,
          fallback,
        );
        const startedChAt = Date.now();
        castInFlight.set(i, {
          chapterIndex: i,
          chapterTitle: ch.title,
          baseEstMs: chapterEstMs,
          startedAt: startedChAt,
          sectionsDone: 0,
          sectionsTotal: 1,
        });

        let lastChunkAt = Date.now();
        let lastHeartbeatAt = 0;
        let warnedSilenceAt: number | null = null;
        log(
          0,
          `Chapter ${i + 1}/${totalCastChapters} cast — ${ch.title} (${ch.body.length.toLocaleString()} chars) via ${analyzerLabel}…`,
        );
        let result;
        /* Lifted to a named const (Task 3) so the SAME StageCall object is
           handed to both the runner (analyzer.runStage1Chapter, below) and
           withPassEval — required for withPassEval's fresh-per-call
           accumulator to attach to the call this chapter actually uses. */
        const castCall: StageCall = {
          signal: abortController.signal,
          language: bookLanguage,
          onWaiting: () => {
            /* elapsed is now derived chapter-wide in sendCastLiveTick (the
       chunker calls the model per section, so the per-call elapsed
       would reset mid-chapter). */
            sendCastLiveTick();
            /* Silence watchdog. Without this the user has no idea
       whether a slow Phase 0a call is rate-limited, hung, or
       just slow on free-tier Gemma. Warn once per silence
       stretch, re-arm on the next chunk. */
            const sinceLastChunk = Date.now() - lastChunkAt;
            if (sinceLastChunk > SILENCE_THRESHOLD_MS) {
              if (
                warnedSilenceAt === null ||
                Date.now() - warnedSilenceAt > SILENCE_THRESHOLD_MS
              ) {
                warnedSilenceAt = Date.now();
                log(
                  0,
                  `Chapter ${i + 1}/${totalCastChapters} — no response from ${analyzerLabel} in ${humanSeconds(sinceLastChunk)}, still waiting.`,
                );
              }
            } else {
              warnedSilenceAt = null;
            }
          },
          onChunk: (info) => {
            lastChunkAt = Date.now();
            const now = lastChunkAt;
            if (now - lastHeartbeatAt < HEARTBEAT_EVENT_THROTTLE_MS) return;
            lastHeartbeatAt = now;
            const charsPerSec =
              info.elapsedMs > 0
                ? Math.round((info.receivedBytes * 1000) / info.elapsedMs)
                : 0;
            send({
              kind: 'heartbeat',
              phaseId: 0,
              receivedBytes: info.receivedBytes,
              charsPerSec,
              elapsedMs: info.elapsedMs,
              sinceLastChunkMs: info.sinceLastChunkMs,
              chapterIndex: i + 1,
            });
          },
          onThrottle: (waitMs, reason) => {
            send({
              kind: 'throttle',
              phaseId: 0,
              chapterIndex: i + 1,
              model: activeModelId,
              waitMs,
              reason,
            });
          },
          /* The primary analyzer went unreachable → the FallbackAnalyzer switched to the
             configured target. Re-label so the pill names the model/engine actually running
             (all later phase-0 events read the reassigned `activeModelId`/`activeEngine`),
             persist `job.engine` for the reverse local-analyzer guard, mark the target busy
             only now (#3084 P30 — never at job start), and announce the switch. */
          onFallback: ({ reason }) => {
            if (selection.fallbackModel && selection.fallbackEngine) {
              activeModelId = selection.fallbackModel;
              activeEngine = selection.fallbackEngine;
              setPhaseEngine(job, 0, activeEngine);
              markFallbackActive(job, selection.fallbackModel);
            }
            console.log(`[analysis] ${manuscriptId}: ${reason}`); // #3084 P30 — never silent
            send({
              kind: 'phase',
              phaseId: 0,
              progress: phase0Progress(),
              label: PHASES[0].label,
              model: activeModelId,
              engine: activeEngine,
            });
          },
        };
        try {
          result = await withPassEval(
            castCall,
            {
              manuscriptId,
              bookTitle: recordRef.title ?? null,
              stage: 'stage1-ch',
              chapterId: ch.id,
            },
            () =>
              runStage1Guarded({
                body: ch.body,
                runningRoster: Array.from(rebuildRoster().values()),
                chapterId: ch.id,
                log,
                language: bookLanguage,
                call: () =>
                  runStage1ChapterChunked({
                    body: ch.body,
                    charBudget: resolveStage1ChunkCharBudget(
                      // #3084 P30 — read inside the per-chapter closure, from the active
                      // selection: a chapter dispatched after a switch is sized for the target.
                      resolveCapacity({ engine: activeEngine, model: activeModelId }),
                      ch.body,
                      // #1691 — roster-aware reservation: the running roster
                      // grows with the whole book's cast, so the body budget must
                      // shrink by its injected size or the worst-case request
                      // crosses the Gemma TPM guard (~130 speaking cast).
                      Array.from(rebuildRoster().values()),
                    ),
                    mergeRosters: mergeRosterChapter,
                    onChunk: (sec) => {
                      /* Feed section progress into the live ETA so the first
                         chapter (no observed rate yet) projects from real pace
                         instead of the static fallback. */
                      const slot = castInFlight.get(i);
                      if (slot) {
                        slot.sectionsDone = sec.index;
                        slot.sectionsTotal = sec.total;
                      }
                      log(
                        0,
                        `Chapter ${i + 1}/${totalCastChapters} cast — large chapter, section ${
                          sec.index + 1
                        }/${sec.total} (${sec.chars.toLocaleString()} chars) to fit the model context…`,
                      );
                      sendCastLiveTick();
                    },
                    callForBody: (subBody) =>
                      analyzer.runStage1Chapter(
                        manuscriptId,
                        ch.id,
                        buildStage1ChapterInbox(
                          manuscriptId,
                          recordRef.title,
                          { ...ch, body: subBody },
                          Array.from(rebuildRoster().values()),
                          seriesPrior,
                          bookAuthor,
                        ),
                        { ...castCall, inputBody: subBody },
                      ),
                  }).then((r) => ({ characters: r.characters })),
              }),
            () => null,
          );
        } catch (chErr) {
          /* Client disconnect propagates up — let the route's outer catch
             land us back at res.end() without a "failed" SSE event. */
          if (chErr instanceof AnalysisAbortedError) throw chErr;
          /* A gemini-* content-filter block (RECITATION/SAFETY) is deterministic
             and whole-book-fatal — the same filter blocks every chapter. Rethrow
             to the route's terminal handler (classifies as analyzer-content-blocked
             with remediation) instead of swallowing it into a per-chapter
             chapter-failed that grinds on and ends in an empty roster. */
          if (chErr instanceof GeminiContentBlockedError) throw chErr;
          /* #3084 P20 — a reasoning overflow is whole-book-fatal too: the same
             engine settings overflow again on every chapter, each time spending
             a full output budget on thinking. Mark the job (no new escalation
             window or non-story call from here on) and rethrow to the terminal
             handler, whose analyzer-reasoning-overflow copy names the setting to
             change, instead of grinding chapter by chapter. `ch` (`ch.id`,
             `ch.title`) is already in scope here, from `const ch =
             recordRef.chapterHints[i];` at the top of `runCastChapter`. */
          if (noteReasoningOverflow(job, structureBudget, chErr, { id: ch.id, title: ch.title }, 0)) throw chErr;
          /* Per-chapter failure (malformed JSON after retry, validation
             miss, model truncation, …) is NON-FATAL for the run. The
             chapter is dropped from cast detection; the rest of the
             book still gets analysed. Surface the full error message in
             the SSE log so the user can see WHICH chapter failed and WHY
             — historically one bad chapter aborted the entire pool with
             a generic toast and no way to diagnose. */
          castInFlight.delete(i);
          completedCast.add(i); // count toward progress denominator
          failedCastChapters.add(ch.id);
          const chDurationFail = Date.now() - startedChAt;
          /* The duration cache feeds the observed-pace ETA. Recording a
             failure's duration would skew the pace estimate (probably
             upward — the model burned all its budget then errored), so
             skip the duration save on failure. */
          log(
            0,
            `❌ Chapter ${i + 1}/${totalCastChapters} cast FAILED — ${ch.title}: ${(chErr as Error).message}`,
          );
          log(
            0,
            `Continuing without chapter ${i + 1} in the cast roster (${humanSeconds(chDurationFail)} spent). Re-run analysis to retry.`,
          );
          /* Persist the failure marker into the cache so a resumed run
             knows we tried this chapter and gave up — without this, a
             follow-up open would queue it again and probably fail the
             same way. Stored as an empty-cast entry so rebuildRoster
             skips it and the cache key is taken. */
          chapterCast[ch.id] = [];
          cache.chapterCast = chapterCast;
          const classified = classifyAnalysisFailure(chErr, analyzerLabel);
          const castRecord = recordFailedChapter(cache, ch.id, classified, 'cast');
          await patchCacheInFailureCatch(
            manuscriptId,
            { fields: cacheFields(cache, ['chapterCast', 'failedChapterIds', 'failedChapterErrors']) },
            ch.id,
          );
          send({
            kind: 'chapter-failed',
            chapterId: ch.id,
            message: castRecord.message,
            code: castRecord.code,
            remediation: castRecord.remediation,
            phase: castRecord.phase,
          });
          sendCastLiveTick();
          send({
            kind: 'phase',
            phaseId: 0,
            progress: phase0Progress(),
            label: PHASES[0].label,
            model: activeModelId,
          });
          return;
        }

        chapterCast[ch.id] = result.characters;
        completedCast.add(i);
        cache.chapterCast = chapterCast;
        /* Plan 88 — advance the Phase 0 watermark on each successful
           per-chapter completion. The watermark is monotonic and
           tolerates out-of-order completions (worker for chapter N+2
           may finish before worker for chapter N). With the sequential
           stub watermark (legacy single-model / non-pipelined mode), this is a no-op. With
           the real watermark (pipelined mode), it releases any parked
           Phase 1 waiter whose chapter is within `LAG` of the new
           value. */
        watermark.markPhase0ChapterComplete(i);
        /* A previously-failed chapter just succeeded on resume — clear it
           from the durable failed-id list AND notify the live view so the
           Retry row disappears immediately, not just on the next book-state
           fetch. Without the SSE event the panel keeps showing a row the
           server has already resolved; the user then clicks "Retry" on a
           ghost row, which kicks off a duplicate subset run and (pre-fix)
           raced with this very loop's writes. */
        if (clearFailedChapterId(cache, ch.id, 'cast')) {
          send({ kind: 'chapter-resolved', chapterId: ch.id });
        }
        const chDuration = Date.now() - startedChAt;
        /* Persist this chapter's wall-clock duration so a future resumed
           run can seed its observed-rate trackers without waiting for the
           first new chapter to complete. */
        castDurations[ch.id] = chDuration;
        cache.castDurations = castDurations;
        /* Durations are this run's own map (`durationsForEngine` already dropped a
           prior engine's), so they replace the file's rather than merge into a stale
           engine's. */
        await mutateAnalysisCache(manuscriptId, {
          fields: cacheFields(cache, [
            'chapterCast',
            'failedChapterIds',
            'failedChapterErrors',
            'castDurationsEngine',
          ]),
          transform: (c) => ({ ...c, castDurations: { ...castDurations } }),
        });
        /* Plan 291 (#4031): Phase 0a writes no cast.json. The per-chapter roster is
           still raw analyzer ids, so a row written now would put an id on disk that
           the plan has not settled; the live view (`emitCastUpdate`, below) is the
           only progress surface until Phase 0b has planned the roster. */
        castInFlight.delete(i);
        log(
          0,
          `Chapter ${i + 1}/${totalCastChapters} cast done — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'} in ${humanSeconds(chDuration)}`,
        );
        /* Accumulate observed pace so subsequent Phase 0a chapter estimates
           (and the cross-phase ETA projection below) reflect the real model
           speed instead of the static TTFT baseline. */
        castActualMsTotal += chDuration;
        castActualCharsTotal += ch.body.length;
        phase0WallClockMs = Date.now() - stage0Start;
        /* Emit a refined total-remaining ETA. The frontend swaps this in
           for the static "~38 minutes" describeSize string the moment the
           first chapter completes, so the user sees a number that tracks
           the model they actually picked. */
        const phase0CharsRemaining = Math.max(0, totalCastCharsAll - castActualCharsTotal);
        const remainingMs = projectRemainingMs({
          phase0WallClockMs,
          phase0CharsDone: castActualCharsTotal,
          phase0CharsRemaining,
          phase1WallClockMs: 0,
          phase1CharsDone: 0,
          phase1CharsRemaining: totalCastCharsAll, // phase 1 will run over the same set
          fallbackPhase0Ms: stage1EstMs,
          fallbackPhase1Ms: stage2EstMs,
        });
        send({ kind: 'eta', remainingMs });
        emitCastUpdate();
        sendCastLiveTick();
      }

      /* Plan 88 follow-up — wrap the Phase 0 worker pool + Phase 0b
         consolidation in a single async function so we can launch
         Phase 1 concurrently below. In pipelined mode this is the
         outer Promise.all arm; in sequential / cache modes the function
         awaits the same way as before but Phase 1's `awaitPhase1Dispatch`
         parks until `markPhase0AllDone()` fires inside this body. */
      const runPhase0Pool = async (): Promise<void> => {
        /* Concurrency pool — same shape as the Phase 1 chapter pool.
           Per-chapter failures are caught INSIDE runCastChapter (they
           become non-fatal log events + a failedCastChapters entry), so
           the only thing that should escape here is AnalysisAbortedError —
           the SSE client disconnected, we should tear the whole pool down
           and let the outer try/catch end the response cleanly. */
        let nextCastTask = 0;
        let castAborted = false;
        const castWorkers: Promise<void>[] = [];
        const launchNextCast = async (): Promise<void> => {
          /* #3435 — no cast chapter starts once the run is halting or has ended
             (in pipelined mode a Phase-1 failure halts it mid-pool). */
          while (nextCastTask < castTaskIndices.length && !castAborted && !job.halting && !job.ended) {
            const i = castTaskIndices[nextCastTask++];
            try {
              /* #3084 P20 — a job marked by a reasoning overflow starts no further cast
                 chapter. In pipelined mode, Phase 1 escalation can mark it mid-pool. */
              throwIfReasoningOverflowed(job);
              /* #3435 decision A — a tracked unit: the job stays a writer until it ends. */
              takeWork(job);
              try {
                await runCastChapter(i);
              } finally {
                releaseWork(job);
              }
            } catch (e) {
              /* #3435 — the halt decision, synchronously and before any await. */
              job.halting = true;
              castInFlight.delete(i);
              castAborted = true;
              throw e;
            }
          }
        };
        resetAnalyzerConcurrencyPeak();
        for (let w = 0; w < Math.min(castConcurrency, castTaskIndices.length); w++) {
          castWorkers.push(launchNextCast());
        }
        await Promise.all(castWorkers);
        /* #3435 (plan check 3, item A) — a stop rejects; it never resolves into
           Phase 0b. A Pause ends the run aborted; a loop that exited early on a
           halt (the Phase-1 arm has already rejected) writes no partial stage1
           or cast.json. */
        if (abortController.signal.aborted) throw new AnalysisAbortedError('Analysis aborted during cast detection.');
        if (job.halting || job.ended) return;
        log(0, analyzerConcurrencyPeakLine('Cast detection', castTaskIndices.length));

        /* #3084 P20 — stop new spend: skip Phase 0b. In pipelined mode Phase 1
           escalation can record an overflow while a Phase-0 cast chapter is already
           in flight, after the per-chapter dispatch check above has passed for every
           chapter. The run still ends with the overflow code via Phase 1's own checks
           either way; this check is what keeps Phase 0b (roster finalisation, the
           stage-1 cache write, series reuse linking) from running after it. */
        throwIfReasoningOverflowed(job);

        /* Phase 1+ MUST NOT advance while any chapter is missing its cast —
           otherwise attribution / voice matching run against a partial
           roster and the user gets a degraded book without ever being
           asked to retry. Stop here, leave cache.stage1 unset so the
           next /analysis/stream re-enters Phase 0a's resume path
           (failedChapterIds is re-queued automatically), and surface a
           `cast_incomplete` error code the analysing view treats as
           "paused, awaiting retry" rather than a fatal error.
           Per-chapter failure markers (cache.chapterCast[id]=[] and
           cache.failedChapterIds) are already on disk via the per-failure
           write at the catch site above.
           In the pipelined refactor the early return moved out — we
           record the failed count via `phase0FailedCount` and let the
           outer Promise.all settle (Phase 1 workers exit cleanly via
           the same flag check after `awaitPhase1Dispatch`). The
           outer post-Promise.all code emits the SSE `cast_incomplete`
           error and returns. We still mark Phase 0 all-done so any
           Phase 1 workers parked on the watermark release cleanly
           instead of deadlocking. */
        if (failedCastChapters.size > 0) {
          const failedCount = failedCastChapters.size;
          phase0FailedCount = failedCount;
          phase0FailedTitles = [...failedCastChapters].map(
            (id) => recordRef.chapterHints.find((h) => h.id === id)?.title ?? `chapter ${id}`,
          );
          log(
            0,
            `Phase 0 paused — ${failedCount} chapter${failedCount === 1 ? ' still needs' : 's still need'} cast detection (see ❌ lines above). Phase 1 won't start until every chapter has a roster — retry below or re-run analysis.`,
          );
          send({
            kind: 'phase',
            phaseId: 0,
            progress: phase0Progress(),
            label: PHASES[0].label,
            model: activeModelId,
          });
          /* Release any parked Phase 1 waiters so they can observe
             `phase0FailedCount > 0` and short-circuit out of dispatch.
             Without this they'd hang forever waiting on the watermark. */
          watermark.markPhase0AllDone();
          return;
        }

        /* ── Phase 0b — finalise the roster.
           Replay merge once more in chapter-id order (canonical), then
           sort+verify+colour. Always include 'narrator' so downstream
           (stage-2 attribution, voice picker) can rely on its presence. */
        const finalRoster = rebuildRoster();
        const rawCharacters = Array.from(finalRoster.values());
        sortEvidence(rawCharacters);
        const verified = verifyEvidenceAgainstSource(rawCharacters, record.sourceText, (msg) =>
          log(0, msg),
        );
        const characters = dropEvidencelessCast(
          rawCharacters,
          (msg) => log(0, msg),
          record.sourceText,
        );
        /* Plan 291 (#4031) — the RAW roster is what the cache keeps; the plan
           (`planCastIdentity`) settles every row's identity, applies it, links the
           new rows to prior series books (plan 126 Facet A: `matchedFrom` + a unified
           `voiceId` + `voiceState:'reused'`, non-fatal) and snapshots the plan-applied
           roster. Only then does Phase 1 see a roster: `phase1Stage1Ready` flips
           BEFORE `markPhase0AllDone()` so a released waiter reads the plan-applied
           stage1 instead of the rolling snapshot. */
        const rawStage1: Stage1Output = {
          characters,
          /* Carry the parser's chapter list verbatim — Phase 0a deliberately
             doesn't return a chapters[] field, and stage 2's prompt /
             merging downstream both work off the same list. */
          chapters: recordRef.chapterHints.map((c) => ({ id: c.id, title: c.title })),
        };
        cache.stage1 = rawStage1;
        stage1 = { ...rawStage1, characters: await planCastIdentity(characters) };
        phase1Stage1Ready = true;
        // #2196 — dropped-quotes persistence guarded in mode:'drop' (subset
        // phase-0b; stale dir not recreated; terminal persist halt-gates).
        await withVerifiedBookDir(
          { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
          async (bookDir) => {
            await persistDroppedQuotesBatch(
              bookDir,
              manuscriptId,
              'analysis-stream',
              verified,
            );
          },
        );
        stage1ActualMs = Date.now() - stage0Start;
        send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage, planConstraints, planProtectIds) });
        /* Cast.json already reflects the plan-applied Phase 0b roster
           (`planCastIdentity`'s snapshot, unfolded - the fold is a live-view and
           final-pass concern, and a folded snapshot would write buckets in place of
           real rows). */
        /* Use the observed rate to refine stage 2's estimate. Stage 2
           prompt is a similar size to stage 1 plus the small character
           roster, but its output is much larger (one JSON entry per
           sentence), hence the stretch factor. Moved inside Phase 0
           as part of the pipelining refactor so the "Detected N
           characters" log fires when Phase 0b actually finishes — in
           pipelined mode this can land WHILE Phase 1 chapters are
           already running concurrently, which is the user-visible
           signal that pipelining is engaged. */
        if (stage1ActualMs > 0) {
          stage2EstMs = clampStageEstMs(stage1ActualMs * STAGE2_STRETCH);
          log(
            0,
            `Detected ${stage1.characters.length} character${stage1.characters.length === 1 ? '' : 's'}: ${stage1.characters.map((c) => c.name).join(', ')}`,
          );
          /* Report the *parser*'s chapter count — that's what stage 2
             actually iterates. The analyzer's own count can occasionally
             collapse on flaky models even though the chapter list was
             provided verbatim in the inbox; the parser is the
             operational source of truth. */
          const parserChapterCount = record.chapterHints.length;
          log(
            0,
            `${parserChapterCount} chapter${parserChapterCount === 1 ? '' : 's'} identified in ${humanSeconds(stage1ActualMs)}`,
          );
        }
        send({
          kind: 'phase',
          phaseId: 0,
          progress: 1,
          label: PHASES[0].label,
          model: activeModelId,
        });
        /* Plan 88 — Phase 0b consolidation has produced the final roster
           (`stage1.characters` above). Release any remaining Phase 1
           waiters parked on the back-pressure semaphore — they'll dispatch
           against the final roster regardless of where Gemma's watermark
           was when they queued. With the sequential stub watermark this is
           the trigger that lets Phase 1 begin at all. */
        watermark.markPhase0AllDone();
      };
      /* Defer the await — Phase 1 is launched concurrently below and
         the outer Promise.all joins both pools. In sequential mode
         (no per-phase env vars) Phase 1 workers all park on
         `awaitPhase1Dispatch` until `markPhase0AllDone()` fires inside
         this function, so observable behaviour matches today's strict
         phase gate. In pipelined mode, Phase 1 dispatches as Phase 0
         chapters complete (subject to the LAG semaphore). */
      /* #3435 decision A — the arm itself is a tracked unit: it covers Phase
         0b's stage1 and cast.json writes. */
      takeWork(job);
      phase0PoolPromise = runPhase0Pool().finally(() => releaseWork(job));
    }

    /* ── Phase 1: parsing and attribution (handoff stage 2, per chapter).
       We split stage 2 by chapter so each call fits well inside the model's
       context window and free-tier rate limits can recover between calls.
       Overall progress is (chapters_done + current_chapter_local_progress) /
       total_chapters.
       Plan 88 follow-up — Phase 1 setup happens UNCONDITIONALLY here,
       and the worker pool runs concurrently with Phase 0 (in
       cache-miss / pipelined mode). Each worker calls
       `watermark.awaitPhase1Dispatch(i)` before dispatching, which in
       sequential mode parks until Phase 0b consolidation fires
       `markPhase0AllDone()` (today's hard phase gate, preserved) and in
       pipelined mode parks until Phase 0 chapter `i + LAG` completes
       (the new back-pressure semaphore). */
    markPhase(1);
    send({
      kind: 'phase',
      phaseId: 1,
      progress: 0.02,
      label: PHASES[1].label,
      model: phase1ModelId,
    });
    const totalChapters = record.chapterHints.length;
    log(
      1,
      `Attributing ${totalChapters} chapter${totalChapters === 1 ? '' : 's'} with ${phase1AnalyzerLabel}…`,
    );
    /* Issue #2354 / #2365 C2 — this log always fires before Phase 0's
       refinement can have run: Phase 0 is launched un-awaited just above
       (`phase0PoolPromise = runPhase0Pool()`) and nothing awaits it before
       this line, in EVERY mode (sequential mode parks Phase 1's *workers* on
       the watermark, not this setup code). So the number here is always the
       pre-flight constant computed from the static baseline — never the
       stage-1-observed rate — and the label says so unconditionally. */
    log(
      1,
      `Estimated stage time: ~${humanSeconds(stage2EstMs)} (pre-flight estimate, refined after stage 1)`,
    );
    if (cachedChapterCount > 0) {
      /* #3435 — over the non-excluded chapters (the count above excludes
         them), and the noun follows the denominator ("1 of 2 chapters"). */
      const resumeDenominator = recordRef.chapterHints.filter((c) => !c.excluded).length;
      log(
        1,
        `Resuming — ${cachedChapterCount} of ${resumeDenominator} chapter${resumeDenominator === 1 ? '' : 's'} already cached.`,
      );
    }
    /* Per-chapter budget weighted by char count so a fat chapter doesn't get
       the same budget as a thin one. After each chapter completes we
       accumulate actual ms + chars so subsequent chapters' estimates use
       the *observed* pace instead of the stage-1-derived baseline — Gemma
       on a slow afternoon is materially slower than the same model on
       stage 1's input, and the user shouldn't be staring at a wrong ETA
       for the whole stage. Min 2s floor keeps the bar from teleporting on
       micro-chapters. */
    const totalStage2Chars = record.chapterHints.reduce((sum, c) => sum + c.body.length, 0);
    let actualMsTotal = 0;
    let actualCharsTotal = 0;
    /* Self-calibrating stage-2 output:input ratio for the mid-chapter ETA
       refinement (issue 3). Seeded from DEFAULT_STAGE2_OUTPUT_RATIO and
       refined from each completed chapter's final output bytes vs its input
       chars, so the in-flight projection tightens as the run proceeds. */
    let stage2OutBytesTotal = 0;
    let stage2InCharsTotal = 0;
    const currentOutputRatio = (): number =>
      stage2InCharsTotal > 0
        ? stage2OutBytesTotal / stage2InCharsTotal
        : DEFAULT_STAGE2_OUTPUT_RATIO;
    /* Seed from prior-run stage 2 durations so a resumed run already has
       per-chapter ETA samples — same rationale as the cast pass above. */
    const stage2Durations: Record<number, number> = durationsForEngine(
      cache.stage2Durations,
      cache.stage2DurationsEngine,
      phase1Selection.engine,
    );
    cache.stage2Durations = stage2Durations;
    cache.stage2DurationsEngine = phase1Selection.engine;
    for (const idStr of Object.keys(stage2Durations)) {
      const id = Number(idStr);
      const ch = record.chapterHints.find((c) => c.id === id);
      if (!ch) continue;
      actualMsTotal += stage2Durations[id];
      actualCharsTotal += ch.body.length;
    }
    const chapterEstMsFor = (chars: number): number => {
      /* Once any chapter has run, prefer the observed rate. One completed
         chapter is already a better signal than the stage-1 extrapolation
         because stage-2 output (one JSON entry per sentence) is heavier
         than stage-1 output (small character roster). */
      if (actualCharsTotal > 0) {
        const observedRate = actualMsTotal / actualCharsTotal;
        return Math.max(2000, Math.round(observedRate * chars));
      }
      if (totalStage2Chars > 0) {
        return Math.max(2000, Math.round(stage2EstMs * (chars / totalStage2Chars)));
      }
      return Math.max(2000, Math.round(stage2EstMs / Math.max(1, totalChapters)));
    };
    const remainingNonCachedChars = (afterIndex: number): { chars: number; count: number } => {
      let chars = 0;
      let count = 0;
      for (let j = afterIndex + 1; j < record.chapterHints.length; j++) {
        const next = record.chapterHints[j];
        /* #3435 — a pending take still has to run. */
        if (hasCurrentTake(cache, next.id)) continue;
        chars += next.body.length;
        count += 1;
      }
      return { chars, count };
    };
    const allSentences: SentenceOutput[] = [];
    /* Per-chapter results keyed by chapter id so we can concatenate in
       narrative order at the end regardless of which chapter finishes first
       under concurrency. */
    const sentencesByChapter = new Map<number, SentenceOutput[]>();
    /* srv-59 Task 11 — every freshly-attributed chapter's structureReport
       (attributeChapterStage2 only sets one when the engine ran — see its
       comment). A chapter replayed from the stage-2 cache above contributes
       nothing (the cache doesn't store EngineReport), so a resumed run's
       aggregate only reflects the chapters that actually ran this pass.
       Rolled up into `analysisProvenance.report` at the persist site below
       via aggregateStructureReports. */
    const structureReports: EngineReport[] = [];
    /* #2267 — Task 1's worst-paragraph merged-turn reading, one per
       non-excluded chapter. Deliberately computed HERE, over every chapter's
       text up front, rather than accumulated from `attributeChapterStage2`
       as `structureReports` above is: that path only runs for chapters
       freshly attributed THIS pass, so on a fully-cached re-run (every
       chapter served from the stage-2 cache below) it would never fire at
       all — exactly the case design of record §4 exists to protect, since
       this metric needs only chapter text + the book's resolved language,
       never an EngineReport or the engine having run. Folded via
       `aggregateMaxMergedTurns` (Math.max, never a sum) and merged into the
       persisted report separately from `aggregateStructureReports` at the
       persist site below. */
    const legibilityConventions = conventionsFor(bookLanguage);
    /* #2275 C4 — one `merged=` line per chapter with a defined reading,
       emitted HERE (up front, regardless of engine state or caching) rather
       than only inside the engine-gated branch of attributeChapterStage2 —
       target 1c grades per chapter, and a fully-cached run (the case this
       metric exists to score) never reaches that branch at all.
       `scope=book` marks the line as a book-wide reading, not per-chapter
       pass progress — the subset route (below) measures the whole book here
       while `chaptersCovered` reports only the re-run subset, so without this
       marker a "re-analyse one chapter" run would print one `merged=` line
       per book chapter against a one-chapter progress line and read as false
       progress. Skipped entirely for a language with no dash convention
       (`n === undefined`) — an operator grepping this prefix for "did the
       structure pass run?" should never see a false-yes line for e.g. an
       English book. */
    const perChapterMaxMergedTurns: Array<number | undefined> = recordRef.chapterHints
      .filter((c) => !c.excluded)
      .map((c) => {
        const n = legibilityConventions
          ? measureChapterLegibility(c.body, legibilityConventions)
          : undefined;
        if (n !== undefined) {
          console.log(`[analysis:structure] ch=${c.id} scope=book merged=${n}`);
        }
        return n;
      });
    const completedSet = new Set<number>();

    /* Replay cached chapters synchronously up front. Cheap, deterministic
       progress, and avoids racing the concurrent pool against the cache.
       Excluded chapters are skipped — they never had attribution run and
       must not be counted as cached. #3435 (plan 287) — a chapter replays iff
       it has a current take: a `[]` take is done once attributed (decision
       B), and a pending take (P) is re-attributed. */
    for (let i = 0; i < totalChapters; i++) {
      const ch = recordRef.chapterHints[i];
      if (ch.excluded) continue;
      if (hasCurrentTake(cache, ch.id)) {
        const cached = cachedChapters[ch.id];
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — ${ch.title}: cached (${cached.length.toLocaleString()} sentences), skipping.`,
        );
        sentencesByChapter.set(ch.id, cached);
        completedSet.add(i);
      }
    }
    /* Active = chapters that will actually run Phase 1. Excluded chapters
       are subtracted from the denominator so a book with 5 excluded
       chapters doesn't stall the bar below 100%. */
    const activeChapterCount = recordRef.chapterHints.filter((c) => !c.excluded).length;
    const excludedChapterCount = totalChapters - activeChapterCount;
    if (excludedChapterCount > 0) {
      log(
        1,
        `Skipping ${excludedChapterCount} excluded chapter${excludedChapterCount === 1 ? '' : 's'} (no audio will be generated).`,
      );
    }
    /* Reflect cached progress in the bar before any work starts. */
    {
      const cachedFrac = activeChapterCount > 0 ? completedSet.size / activeChapterCount : 1;
      send({
        kind: 'phase',
        phaseId: 1,
        progress: Math.min(0.02 + 0.93 * cachedFrac, 0.95),
        label: PHASES[1].label,
        model: phase1ModelId,
      });
    }

    /* Tasks that need to actually run. Excluded chapters are filtered
       out — they're tracked in state.json but never get Phase 1
       attribution and therefore never get TTS either. */
    const taskIndices: number[] = [];
    for (let i = 0; i < totalChapters; i++) {
      if (recordRef.chapterHints[i].excluded) continue;
      if (!completedSet.has(i)) taskIndices.push(i);
    }

    const concurrency = analyzerPoolWidth();
    log(
      1,
      `Running ${taskIndices.length} chapter${taskIndices.length === 1 ? '' : 's'} with up to ${concurrency} in parallel.`,
    );

    /* Track which chapters are currently in-flight + their elapsed times so
       the `live` payload can surface every running chapter — concurrency
       means a slow chapter can be paired with newer ones racing ahead, and
       showing only the oldest hides that progress. Sorted by chapter order
       in the manuscript so the UI shows them in book order. */
    interface InFlight {
      chapterIndex: number;
      chapterTitle: string;
      chapterEstMs: number;
      /** The last non-null estimate written to chapterEstMs, used as a fallback
          by selectChapterEstMs when both sentence and byte projections are null. */
      lastGoodEstMs: number;
      startedAt: number;
      elapsedMs: number;
      /** Latest streamed output bytes for this chapter (from the heartbeat) —
          drives the mid-chapter ETA projection in tickOverall. */
      receivedBytes: number;
      /* Sentence progress (section-accumulated). committedChars/Sentences cover
         ONLY completed sections (kept in lockstep so the rate is never diluted);
         currentSectionChars is the in-flight section's size, stashed at section
         start and folded into committedChars when that section completes. */
      heuristicTotal: number;
      committedSentences: number;
      committedChars: number;
      currentSectionChars: number;
      inflightSentences: number;
      sectionsDone: number;
      sectionsTotal: number;
      inSentenceMode: boolean;
    }
    const inFlight = new Map<number, InFlight>();

    const sendLiveTick = () => {
      const running = Array.from(inFlight.values()).sort((a, b) => a.chapterIndex - b.chapterIndex);
      const p =
        activeChapterCount > 0
          ? Math.min(0.02 + 0.93 * (completedSet.size / activeChapterCount), 0.95)
          : 1;
      send({
        kind: 'phase',
        phaseId: 1,
        progress: p,
        label: PHASES[1].label,
        model: phase1ModelId,
        engine: phase1Engine, // #3084 P30 — the target engine after a switch, not always gemini
        live:
          running.length > 0
            ? {
                totalChapters,
                chapters: running.map((r) => {
                  const prog = sentenceProgressForTick({
                    committedSentences: r.committedSentences,
                    committedChars: r.committedChars,
                    inflightSentences: r.inflightSentences,
                    totalChars: recordRef.chapterHints[r.chapterIndex].body.length,
                    heuristicTotal: r.heuristicTotal,
                  });
                  return {
                    chapterIndex: r.chapterIndex + 1,
                    chapterTitle: r.chapterTitle,
                    elapsedMs: r.elapsedMs,
                    estMs: r.chapterEstMs,
                    sectionsDone: r.sectionsDone,
                    sectionsTotal: r.sectionsTotal,
                    ...(r.inSentenceMode
                      ? { sentencesDone: prog.sentencesDone, sentencesTotal: prog.sentencesTotal, inSentenceMode: true }
                      : {}),
                  };
                }),
              }
            : undefined,
      });
    };

    /* #3435 — the Phase-1 dispatch: everything `runChapter` did before the
       chapter's own model call. It runs OUTSIDE the pool's recording catch, so a
       throw here (the recorded overflow rethrown, say) is the job's error and
       never a failure of chapter `i`. `isPoolAborted` is the pool-local flag.
       On 'run' it has taken the chapter body's liveWork token, in the same
       synchronous block as its last checks (A5 gap 1); the caller releases it. */
    const dispatchedOnFinalRoster = new Map<number, boolean>();
    async function phase1Dispatch(i: number, isPoolAborted: () => boolean): Promise<'run' | 'skip'> {
      /* Plan 88 — back-pressure semaphore.
         In sequential mode this resolves once `markPhase0AllDone()`
         fires inside `runPhase0Pool` (today's hard phase gate). In
         pipelined mode (per-phase env vars set) it blocks until Phase
         0's watermark has advanced to `i + ANALYZER_PHASE1_MIN_LAG_CHAPTERS`,
         OR Phase 0b consolidation has signalled all-done — whichever
         comes first. If Gemini ever catches up to within `LAG` of
         Gemma's watermark, this is where the user's "keep 10 chapters
         between them" rule enforces a wait. */
      const dispatchWaitStart = Date.now();
      await watermark.awaitPhase1Dispatch(i);
      /* A Pause while this worker was parked or between chapters: end the run as
         aborted rather than let the pool resolve with chapters missing (plan
         check 3, item A). A worker woken by endJob's releaseAll lands here too. */
      if (abortController.signal.aborted) throw new AnalysisAbortedError('Analysis aborted before dispatching the chapter.');
      /* Plan 88 follow-up — if Phase 0 finished with failed cast
         chapters, `runPhase0Pool` set `phase0FailedCount` and called
         `markPhase0AllDone` to release us. Exit cleanly without
         dispatching the Phase 1 call — the outer post-Promise.all
         handler emits the `cast_incomplete` SSE error. Skipping
         here also keeps the worker pool's normal early-termination
         path intact (no thrown error, no `aborted = true`). */
      if (phase0FailedCount > 0) return 'skip';
      /* #3435 — the run is halting (a pool catch decided it) or has ended: a
         worker woken by a watermark advance after the halt starts nothing. */
      if (job.halting || job.ended) return 'skip';
      /* Another worker's failure while this one was parked. */
      if (isPoolAborted()) return 'skip';
      /* #3084 P20 — checked here, after the watermark, rather than at the top of
         launchNext's loop: in pipelined mode a worker can be parked on
         awaitPhase1Dispatch when the job is marked. The pool catch below sets
         `aborted` and rethrows. */
      throwIfReasoningOverflowed(job);
      const dispatchWaitMs = Date.now() - dispatchWaitStart;
      if (dispatchWaitMs > 250) {
        /* Surface the back-pressure wait so the user can tell Gemini
           is being deliberately throttled to preserve roster context
           (rather than mistaking the pause for a stalled model). The
           >250ms guard avoids spamming logs with sub-second microtask
           hops in the sequential path. */
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — held back ${humanSeconds(dispatchWaitMs)} to preserve ${resolvePhase1MinLagChapters()}-chapter roster lag.`,
        );
      }
      /* #3435 M8c (decision H) — whether this chapter attributes against the
         final roster. Only a rolling-roster take can be pending. */
      dispatchedOnFinalRoster.set(i, phase1Stage1Ready);
      /* #3435 decision A — the chapter body's token, taken before this returns. */
      takeWork(job);
      return 'run';
    }

    /* The chapter's own work, after `phase1Dispatch` said 'run'. The pool's
       recording catch wraps exactly this. */
    async function runChapterBody(i: number): Promise<void> {
      const ch = recordRef.chapterHints[i];
      const chapterEstMs = chapterEstMsFor(ch.body.length);
      const startedAt = Date.now();
      inFlight.set(i, {
        chapterIndex: i,
        chapterTitle: ch.title,
        chapterEstMs,
        lastGoodEstMs: chapterEstMs,
        startedAt,
        elapsedMs: 0,
        receivedBytes: 0,
        heuristicTotal: countSentencesHeuristic(ch.body),
        committedSentences: 0,
        committedChars: 0,
        currentSectionChars: 0,
        inflightSentences: 0,
        sectionsDone: 0,
        sectionsTotal: 1,
        inSentenceMode: false,
      });

      const refineEstMs = (slot: InFlight, elapsed: number) => {
        const prog = sentenceProgressForTick({
          committedSentences: slot.committedSentences,
          committedChars: slot.committedChars,
          inflightSentences: slot.inflightSentences,
          totalChars: ch.body.length,
          heuristicTotal: slot.heuristicTotal,
        });
        const next = selectChapterEstMs({
          elapsedMs: elapsed,
          bySentenceMs: projectChapterEstMsFromSentences(elapsed, prog.sentencesDone, prog.sentencesTotal),
          byBytesMs: projectChapterEstMsFromOutput(elapsed, slot.receivedBytes, ch.body.length, currentOutputRatio()),
          lastGoodMs: slot.lastGoodEstMs,
          // Single-chapter book → chapter estimate == stage estimate; pass 0 to
          // disable the "never the stage value" ceiling (else it reads ~10% low).
          stageEstMs: totalChapters > 1 ? stage2EstMs : 0,
        });
        slot.chapterEstMs = next;
        slot.lastGoodEstMs = next;
      };

      const tickOverall = () => {
        const slot = inFlight.get(i);
        if (slot) {
          /* Chapter-relative elapsed (wall-clock since this chapter started),
             NOT the per-attempt elapsed onWaiting reports. A coverage/transient
             retry restarts the per-attempt clock at 0, which would make the
             displayed "M:SS of ~M:SS" snap backward mid-chapter; startedAt is
             fixed at chapter dispatch, so this never regresses. Matches the
             clock the onChunk heartbeat already feeds into refineEstMs below. */
          const chapterElapsed = Date.now() - slot.startedAt;
          slot.elapsedMs = chapterElapsed;
          /* Mid-chapter ETA refinement (issue 3): sentence-aware estimate band
             (selectChapterEstMs) prefers the sentence projection over bytes,
             never returns the stage value, never blanks to ~. */
          refineEstMs(slot, chapterElapsed);
        }
        sendLiveTick();
        /* The per-chapter "Nm elapsed, still waiting on the model" wall-clock
           heartbeats and the "still running, Nx exceeded" over-budget lines
           used to live here. They've been removed: the live ticker ("M:SS of
           ~M:SS · section X/Y · Attributed ~N of ~M sentences") is the proper,
           always-fresh progress readout, and the elapsed log lines both
           duplicated it AND disagreed with it (they tracked chapter-total
           elapsed while the ticker re-anchors per server tick). The silence
           watchdog (onWaiting below) still warns on genuine model stalls. */
      };

      log(
        1,
        `Chapter ${i + 1}/${totalChapters} — ${ch.title} (${ch.body.length.toLocaleString()} chars, ~${humanSeconds(chapterEstMs)}) via ${phase1AnalyzerLabel}…`,
      );
      let chapterLastHeartbeatAt = 0;
      /* Plan 88 — Phase 1 attribution runs on `phase1Analyzer`.
         In pipelined mode this is a separate model (e.g. Gemini Flash
         while Phase 0 used Gemma); in legacy single-model / non-pipelined mode it's the
         same instance as `analyzer` so behaviour is unchanged. The
         throttle event carries the Phase-1 model id so the UI can
         label the rate-limit pause correctly. */
      /* Plan 88 follow-up — Phase 1 reads its stage1 snapshot via
         `getPhase1Stage1Snapshot()` at dispatch time. In pipelined mode
         this returns a structured-clone of the rolling roster (whatever
         Phase 0 chapters have folded so far); in sequential / cache
         modes it returns the finalised `stage1`. The watermark guarantees
         we never call this with a roster that lags Phase 0 by less than
         `MIN_LAG_CHAPTERS`. */
      const phase1Stage1 = getPhase1Stage1Snapshot();
      const stage2Call: StageCall = {
        signal: abortController.signal,
        language: bookLanguage,
        /* #3084 P20/F7 — attributeChapterStage2 hands this StageCall to
           escalateFlaggedWindows (:2377). An escalation call that overflows
           returns null inside the runner and reports here: the job is marked and
           the book's escalation budget emptied, so neither this chapter nor any
           other sends a further window (escalation.ts:235). `ch` is in scope
           (this literal is built inside `runChapter`, same as `stage2Call`'s
           other fields). */
        onReasoningOverflow: (err) => noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }, 1),
        onWaiting: () => tickOverall(),
        /* The primary analyzer went unreachable → switched to the configured target.
           Re-label so the pill names the effective model/engine (later phase-1 events
           read the reassigned `phase1ModelId`/`phase1Engine`; tickOverall re-emits now
           for immediate feedback), persist `job.engine`, and mark the target busy only
           now (#3084 P30 — never at job start). */
        onFallback: ({ reason }) => {
          if (phase1Selection.fallbackModel && phase1Selection.fallbackEngine) {
            phase1ModelId = phase1Selection.fallbackModel;
            phase1Engine = phase1Selection.fallbackEngine;
            setPhaseEngine(job, 1, phase1Engine);
            markFallbackActive(job, phase1Selection.fallbackModel);
          }
          console.log(`[analysis] ${manuscriptId}: ${reason}`);
          tickOverall();
        },
        /* Per-chunk heartbeat so the user sees evidence of model output
           on each chapter. Stage 2's existing wall-clock heartbeat log
           lines already cover the silence-watchdog purpose. */
        onChunk: (info) => {
          /* Track the running output bytes every chunk (cheap) so the
             mid-chapter ETA projection has fresh data even when onWaiting is
             quiet during active streaming. */
          const liveSlot = inFlight.get(i);
          if (liveSlot) {
            /* High-water marks so the live readouts never regress when a
               transient retry restarts the stream from empty (a gemini
               idle/5xx/429, or a higher-level coverage retry that re-runs the
               whole runStage2Chapter call). Without these, "N KB received" and
               "Attributed ~N" snap backward mid-chapter, and the byte projection
               below mistakes the reset for "barely started" and inflates the ETA.
               receivedBytes is a CHAPTER-level mark (never reset within the
               chapter, so a multi-section chapter's KB readout plateaus rather
               than dropping to 0 at each section). inflightSentences is reset to
               0 at section boundaries (section-start onChunk + onSectionDone
               below) because completed sections are counted exactly in
               committedSentences — so its mark survives a retry but never leaks
               across a real section change. */
            liveSlot.receivedBytes = monotonicHighWater(liveSlot.receivedBytes, info.receivedBytes);
            liveSlot.inflightSentences = monotonicHighWater(
              liveSlot.inflightSentences,
              countStreamedSentences(info.receivedText),
            );
            if (!liveSlot.inSentenceMode && liveSlot.inflightSentences >= SENTENCE_MODE_MIN_MARKERS) {
              liveSlot.inSentenceMode = true;
            }
          }
          const now = Date.now();
          if (now - chapterLastHeartbeatAt < HEARTBEAT_EVENT_THROTTLE_MS) return;
          chapterLastHeartbeatAt = now;
          /* Refine the displayed per-chapter estimate from live throughput on
             the throttled cadence, then push a live tick so "X of ~Y" updates. */
          if (liveSlot) {
            refineEstMs(liveSlot, now - liveSlot.startedAt);
            sendLiveTick();
          }
          /* Display the high-water byte count (monotonic across a retry) but
             derive chars/s from the LIVE attempt — chars/s is an instantaneous
             throughput, not an accumulator, so it stays sensible on a retry
             without needing to regress. */
          const charsPerSec =
            info.elapsedMs > 0 ? Math.round((info.receivedBytes * 1000) / info.elapsedMs) : 0;
          send({
            kind: 'heartbeat',
            phaseId: 1,
            receivedBytes: liveSlot?.receivedBytes ?? info.receivedBytes,
            charsPerSec,
            elapsedMs: info.elapsedMs,
            sinceLastChunkMs: info.sinceLastChunkMs,
            chapterIndex: i + 1,
          });
        },
        onThrottle: (waitMs, reason) => {
          send({
            kind: 'throttle',
            phaseId: 1,
            chapterIndex: i + 1,
            model: phase1ModelId,
            waitMs,
            reason,
          });
        },
      };
      /* Coverage guard (plan 181 / 2026-06-05 The Drowning Bell ch12/ch18 forensics):
         the attribution model can loop-and-truncate — re-emit a span of
         sentences and terminate early — so the chapter is BOTH duplicated and
         missing its tail, yet schema-valid (ids 1..N, no gaps). Validate the
         output against the source prose (`ch.body`) and re-run on failure.
         #528 — large chapters whose per-sentence JSON exceeds the model output
         cap truncate mid-stream; `attributeChapterStage2` splits an over-budget
         chapter into sections (each guarded + adaptively re-split on
         truncation) so the call never exceeds the cap. A within-budget chapter
         is exactly one guarded call (unchanged).
         #3435 — a word-free chapter makes no call: a synthetic successful
         result stands in, and every success step below still runs. */
      const wordFree = !hasAttributableContent(ch.body);
      if (wordFree) log(1, `Chapter ${i + 1}/${totalChapters} — no words to attribute.`);
      const {
        sentences: stage2Sentences,
        coverage: coverageVerdict,
        chunkCount: stage2ChunkCount,
        structureReport: stage2StructureReport,
      } = wordFree ? wordFreeStage2Result() : await attributeChapterStage2WithEval({
        analyzer: phase1Analyzer,
        manuscriptId,
        title: recordRef.title,
        stage1: phase1Stage1,
        chapter: ch,
        stageCall: stage2Call,
        /* A chapter dispatched on the rolling roster (a first analysis, pipelined)
           predates the plan; every other chapter reads the plan-applied roster. */
        dedupConstraints: phase1Stage1 === stage1 ? planConstraints : undefined,
        // #3084 P30 — the active selection, so a chapter dispatched after a switch is sized for the target.
        capacity: resolveCapacity({ engine: phase1Engine, model: phase1ModelId }),
        structureBudget,
        escalationAnalyzer,
        // Section START: record this section's char count and total. Do NOT add
        // it to committedChars yet — committedChars must stay in lockstep with
        // committedSentences (completed sections only), or the rate dilutes and
        // the denominator collapses mid-section (adversarial-review fix #1).
        onChunk: (sec) => {
          const slot = inFlight.get(i);
          if (slot) {
            slot.sectionsTotal = sec.total;
            slot.currentSectionChars = sec.chars;
            slot.inflightSentences = 0; // fresh section → buffer reset on the engine side
          }
        },
        // Section DONE: commit BOTH chars and sentences together, so the
        // observed sentences-per-char rate is always measured over the same
        // completed sections.
        onSectionDone: (_index, sentenceCount) => {
          const slot = inFlight.get(i);
          if (!slot) return;
          slot.committedSentences += sentenceCount;
          slot.committedChars = Math.min(ch.body.length, slot.committedChars + slot.currentSectionChars);
          slot.sectionsDone += 1;
          slot.inflightSentences = 0;
          slot.inSentenceMode = true; // ≥1 section done always qualifies
          sendLiveTick();
        },
        onCoverageRetry: (attempt, verdict) =>
          log(
            1,
            `Chapter ${i + 1}/${totalChapters} — attribution coverage check failed (${
              verdict.issues[0] ?? 'coverage'
            }); re-analysing (attempt ${attempt}).`,
          ),
        onCoverageExhausted: (attempts, verdict) =>
          log(
            1,
            `Chapter ${i + 1}/${totalChapters} — the same attribution failure reproduced exactly on ` +
              `attempt ${attempts} (${verdict.issues[0] ?? 'coverage'}); this section fails ` +
              `deterministically, so re-running the same prompt cannot help. Halting the retries; ` +
              `a re-split follows unless the section is indivisible or already at the split-depth limit.`,
          ),
        onDeterministicSplit: ({ parts, chars, depth }) =>
          log(
            1,
            `Chapter ${i + 1}/${totalChapters} — re-attributing a ${chars.toLocaleString()}-char ` +
              `section as ${parts} smaller ones (split depth ${depth}).`,
          ),
      });
      if (stage2ChunkCount > 1) {
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — attributed in ${stage2ChunkCount} sections.`,
        );
      }
      /* C4 on-box acceptance (#2325/#2342) — the row asks an operator to
         "record the actual percentages" and to log "the source's dash-
         opening count and the attributed speech-half count... for at least
         one chapter", but nothing emitted them: they lived only inside
         `dialogueCollapse`'s issue string, which the job only logs when
         `!coverage.ok` (below) — so the row's own "healthy book" case, the
         one it's chiefly about, would discharge on a NULL observation.
         Logged here unconditionally (pass or fail) whenever the language has
         a dialogue marker (`narratedSpeech !== null`), which also completes
         #2342 item 4's observability half — that item exposed the field on
         the verdict struct but nothing routed it into the operator log. */
      /* `legibilityConventions?.dialogueOpen` is checked here too rather
         than assumed: `coverageVerdict.narratedSpeech` is non-null exactly
         when `fpConventions?.dialogueOpen` was truthy inside
         `attributeChapterStage2WithEval`, and `fpConventions` there is
         `conventionsFor(bookLanguage)` — the SAME pure call as
         `legibilityConventions` here — so the two conditions are provably
         equivalent. Spelling it out lets the type checker prove
         `sourceHalves` below is always a number, rather than leaving a
         `?? '?'` fallback for a null that can't actually occur. */
      if (coverageVerdict.narratedSpeech && legibilityConventions?.dialogueOpen) {
        const ns = coverageVerdict.narratedSpeech;
        const sourceHalves = sourceSpeechHalfCount(ch.body, legibilityConventions.dialogueOpen);
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — narrated-speech check: ${ns.narrated}/${ns.speechHalves} ` +
            `spoken lines attributed to the narrator (${ns.pct.toFixed(1)}%)${
              ns.evaluable
                ? ''
                : ` — attributed population below the ${STAGE2_MIN_SPEECH_HALVES}-line floor, too small to judge`
            }; source has ${sourceHalves} dash-opening speech lines.`,
        );
      }
      if (!coverageVerdict.ok) {
        console.warn(
          `[analysis] chapter ${ch.id} stage2 coverage SUSPECT after retries: ${coverageVerdict.issues.join(' ')}`,
        );
        const failureCode = selectStage2FailureCode(coverageVerdict);
        log(
          1,
          failureCode === 'attribution-collapse'
            ? `Chapter ${i + 1}/${totalChapters} — ⚠ the cast was not used (${
                coverageVerdict.issues[0] ?? 'dialogue collapse'
              }); kept the best take and flagged the chapter for retry.`
            : `Chapter ${i + 1}/${totalChapters} — ⚠ attribution may be incomplete (${
                coverageVerdict.issues[0] ?? 'low coverage'
              }); kept the best take and flagged the chapter for retry.`,
        );
        const copy = FAILURE_REMEDIATIONS[failureCode];
        const attributionRecord = recordFailedChapter(
          cache,
          ch.id,
          { code: failureCode, userMessage: copy.userMessage, remediation: copy.remediation },
          'attribution',
        );
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: attributionRecord.message,
          code: attributionRecord.code,
          remediation: attributionRecord.remediation,
          phase: attributionRecord.phase,
        });
      } else if (clearFailedChapterId(cache, ch.id, 'attribution')) {
        /* #3435 M8 — a clean Phase-1 completion resolves a chapter whose record
           is an attribution failure (a collapse flag, or a Phase-1 throw an
           earlier run recorded). A cast record is left for Phase 0a to clear. */
        send({ kind: 'chapter-resolved', chapterId: ch.id });
      }
      /* #3435 M8/M8c/M9 — the take just made is current, unless it was made
         against the rolling roster while the chapter's cast record stood
         (decision H): then it is pending until it is re-attributed on the
         final roster (M8d, or the next run). Either way it is a take written
         after the last authoritative persist. */
      setPendingAttribution(
        cache,
        ch.id,
        dispatchedOnFinalRoster.get(i) === false &&
          cache.failedChapterIds?.includes(ch.id) === true &&
          cache.failedChapterErrors?.[String(ch.id)]?.phase === 'cast',
      );
      cache.takesPersisted = false;
      for (const s of stage2Sentences) s.chapterId = ch.id;
      /* R8: a take dispatched before a Phase-0b re-mint still speaks the old id. */
      for (const s of stage2Sentences) if (Object.hasOwn(remintIdMap, s.characterId)) s.characterId = remintIdMap[s.characterId];
      sentencesByChapter.set(ch.id, stage2Sentences);
      if (stage2StructureReport) structureReports.push(stage2StructureReport);
      cachedChapters[ch.id] = stage2Sentences;
      cache.chapters = cachedChapters;
      /* Persist this chapter's wall-clock duration so a future resumed run
         can seed its observed-rate trackers without waiting for the first
         new chapter to complete. */
      const chDurationForCache = Date.now() - startedAt;
      stage2Durations[ch.id] = chDurationForCache;
      cache.stage2Durations = stage2Durations;
      /* Atomic-rename alone does NOT order overlapping writes to one path, and
         the pool runs chapters concurrently. The cache patch and the
         manuscript-edits roll below both go through the per-path op chain
         (#3427), so each file's writes land in call order and the last call
         wins. #4031 — the patch carries only what this chapter owns (its take,
         its duration, the failure record and pending set), so it never writes
         back the plan or another chapter's take a merge has re-targeted since
         this job last wrote them. The take speaks the ids that are current now. */
      const takeBookDir = liveBookDir(job) ?? undefined;
      const priorIds = new Set(priorCastForMerge.map((r) => r.id));
      const addedIds = planAddedIds(cache.matchPlan);
      await mutateAnalysisCache(
        manuscriptId,
        chapterTakeCachePatch({
          chapterId: ch.id,
          takes: stage2Sentences,
          remint: remintIdMap,
          fields: cacheFields(cache, [...PHASE1_RECORD_FIELDS, 'stage2DurationsEngine']),
          bookDir: takeBookDir,
          priorIds,
          addedIds,
          stage2Durations,
        }),
      );
      if (recordRef.bookDir) {
        try {
          /* #2196 — rolling manuscript-edits is guarded in mode:'drop': a
             stale (moved/gone) dir is NOT recreated by writeJsonAtomic here.
             Interim rolls simply skip on an unresolvable path; the terminal
             persist block is the single halt gate (C4).
             The snapshot is built inside `rollManuscriptEdits`, in the same
             synchronous step that joins the write queue (#3427). */
          /* #4031 (R39) — the chapters this run produced, and the cached-take fallback. */
          const rollSet = rollChapterSet(() => recordRef.chapterHints, sentencesByChapter, () => cachedChapters);
          await rollManuscriptEdits(
            { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
            rollSet.snapshot,
            recordRef.bookId ?? undefined,
            /* R8: a take captured before a Phase-0b re-mint still carries the old id,
               which may now be a user's row; a mid-run merge's survivor replaces the
               id it merged away. */
            (sentences) =>
              resolveCurrentIds(
                liveBookDir(job) ?? undefined,
                remintIdMap,
                sentences,
                new Set(priorCastForMerge.map((r) => r.id)),
                cache.matchPlan?.decisions,
                addedIds,
              ),
            rollSet.fallback,
          );
        } catch (persistErr) {
          console.warn('[analysis] failed to roll manuscript-edits.json', persistErr);
        }
      }
      const chDuration = Date.now() - startedAt;
      /* Calibrate the stage-2 output:input ratio from this chapter's final
         streamed bytes so subsequent chapters' mid-chapter projections use a
         book/model-specific ratio rather than the default. */
      const finalBytes = inFlight.get(i)?.receivedBytes ?? 0;
      if (finalBytes > 0 && ch.body.length > 0) {
        stage2OutBytesTotal += finalBytes;
        stage2InCharsTotal += ch.body.length;
      }
      completedSet.add(i);
      inFlight.delete(i);
      log(
        1,
        `Chapter ${i + 1}/${totalChapters} done — ${stage2Sentences.length.toLocaleString()} sentences in ${humanSeconds(chDuration)}`,
      );

      /* Update observed-pace tracker. Race-safe because JS is single-threaded
         — increments interleave but sums are associative. */
      actualMsTotal += chDuration;
      actualCharsTotal += ch.body.length;
      const observedRate = actualMsTotal / actualCharsTotal;
      const remaining = remainingNonCachedChars(-1); // re-scan whole list against current cache
      if (remaining.count > 0) {
        const remainingEstMs = Math.round(observedRate * remaining.chars);
        const secsPer1k = observedRate;
        log(
          1,
          `Refined pace — ${secsPer1k.toFixed(1)}s per 1,000 chars · ~${humanSeconds(remainingEstMs)} remaining over ${remaining.count} chapter${remaining.count === 1 ? '' : 's'}.`,
        );
      }
      /* Refined total ETA so the heading updates to reflect Phase 1's
         actual observed pace, not just Phase 0a extrapolation. */
      {
        const phase1WallClockMs = Date.now() - (phaseStarts[1] ?? Date.now());
        const phase1CharsRemaining = remaining.chars;
        const remainingMs = projectRemainingMs({
          phase0WallClockMs,
          phase0CharsDone: castActualCharsTotal,
          phase0CharsRemaining: 0,
          phase1WallClockMs,
          phase1CharsDone: actualCharsTotal,
          phase1CharsRemaining,
          fallbackPhase0Ms: 0,
          fallbackPhase1Ms: stage2EstMs,
        });
        send({ kind: 'eta', remainingMs });
      }
      sendLiveTick();
    }

    /* #3435 M10 — a chapter body threw (the caller has already set
       `job.halting`, synchronously). Shared by the pool and the M8d pass. */
    async function recordChapterBodyFailure(i: number, e: unknown): Promise<void> {
      const failedId = recordRef.chapterHints[i].id;
      /* #3084 P20/F7 — the chapters still running in the other workers
         start no further escalation window, and are aborted when the run
         ends (#3435 decision E). The caller has no `ch` of its own (unlike
         `runChapterBody`, which this `i` belongs to) — re-derive it the same
         way. */
      noteReasoningOverflow(
        job,
        structureBudget,
        e,
        { id: failedId, title: recordRef.chapterHints[i].title },
        1,
      );
      /* #3435 — record the chapter's failure (save, chapter-failed) BEFORE
         the rethrow, so a failed re-attribution leaves no stale record (an
         `attribution-collapse` flag on a chapter whose sentences were just
         dropped) and the view hears about it. An abort is the user pausing,
         not a failure of the chapter. */
      if (!(e instanceof AnalysisAbortedError)) {
        job.failingPhase ??= 1;
        const classified = classifyAnalysisFailure(e, phase1AnalyzerLabel, {
          chapter: { id: failedId, title: recordRef.chapterHints[i].title },
        });
        const attributionRecord = recordFailedChapter(cache, failedId, classified, 'attribution');
        await patchCacheInFailureCatch(
          manuscriptId,
          { fields: cacheFields(cache, PHASE1_RECORD_FIELDS) },
          failedId,
        );
        send({
          kind: 'chapter-failed',
          chapterId: failedId,
          message: attributionRecord.message,
          code: attributionRecord.code,
          remediation: attributionRecord.remediation,
          phase: attributionRecord.phase,
        });
      }
    }

    /* Plan 88 follow-up — wrap the Phase 1 worker pool in an async
       function so it can run concurrently with `runPhase0Pool` via
       Promise.all below. The pool's internal shape is unchanged; only
       the outer await moved. */
    const runPhase1Pool = async (): Promise<void> => {
      /* Concurrency pool — keep up to `concurrency` chapters in flight at
         a time. The first failure stops new task dispatch (`aborted`, and
         `job.halting` for the other pool), and the run's end aborts the
         chapters still calling the model (#3435 decision E, superseding #3084
         N4): they cache nothing and are attributed by the next Resume or
         Retry. A body whose call had already returned finishes its save. */
      let nextTask = 0;
      let aborted = false;
      const workers: Promise<void>[] = [];
      const launchNext = async (): Promise<void> => {
        while (nextTask < taskIndices.length && !aborted && !job.halting && !job.ended) {
          const i = taskIndices[nextTask++];
          /* #3435 — dispatch is outside the recording catch below: a throw here
             (the recorded overflow rethrown at this chapter's dispatch) never ran
             the chapter, so it is not the chapter's failure and records nothing. */
          let verdict: 'run' | 'skip';
          try {
            verdict = await phase1Dispatch(i, () => aborted);
          } catch (e) {
            inFlight.delete(i);
            aborted = true;
            job.halting = true;
            throw e;
          }
          if (verdict === 'skip') continue;
          try {
            await runChapterBody(i);
          } catch (e) {
            /* #3435 — the halt decision, synchronously and before any await (the
               guarded save below is one), so no chapter in either pool starts
               between here and endJob. The controller is NOT aborted here: a
               sibling's AnalysisAbortedError could then reach Promise.all first
               and be read as a pause. endJob aborts, after this terminal. */
            job.halting = true;
            inFlight.delete(i);
            aborted = true;
            await recordChapterBodyFailure(i, e);
            throw e;
          } finally {
            /* #3435 — the body's liveWork token, taken in phase1Dispatch. */
            releaseWork(job);
          }
        }
      };
      resetAnalyzerConcurrencyPeak();
      for (let w = 0; w < Math.min(concurrency, taskIndices.length); w++) {
        workers.push(launchNext());
      }
      await Promise.all(workers);
      log(1, analyzerConcurrencyPeakLine('Attribution', taskIndices.length));
    };

    /* Plan 88 follow-up — Phase 0 and Phase 1 pools run concurrently in
       pipelined mode. In sequential / cache modes the Phase 1 pool's
       per-worker `awaitPhase1Dispatch` parks until Phase 0b fires
       `markPhase0AllDone()`, so the observable behaviour matches today's
       hard phase gate. `phase0PoolPromise` is null in the cache-hit
       branch (no Phase 0 work). */
    const armsToJoin: Promise<void>[] = [runPhase1Pool()];
    if (phase0PoolPromise) armsToJoin.push(phase0PoolPromise);
    await Promise.all(armsToJoin);

    /* #3084 P20 — the dispatch checks only fire when a chapter is about to start,
       so an overflow recorded by the last chapter's own escalation (which runs
       after that chapter's dispatch check) is never seen by them. Without this
       check the job would end in success with reasoningOverflowed=true; rethrow
       it now that both pools have joined. */
    throwIfReasoningOverflowed(job);

    /* Plan 88 follow-up — Phase 0 ended with failed cast chapters; emit
       the `cast_incomplete` SSE error and bail. Phase 1 workers exited
       cleanly via the in-flight `phase0FailedCount` check above (they
       were released by `markPhase0AllDone` inside the Phase 0 failure
       branch). */
    if (phase0FailedCount > 0) {
      endJob(job, {
        kind: 'error',
        code: 'cast_incomplete',
        /* #3435 — the subset route's S5 copy: this becomes the top-bar pill's
           haltReason on every view, so no "Retry below". */
        message: castIncompleteMessage(phase0FailedTitles),
      });
      return;
    }

    /* #3435 M8d — a pending take is never stitched. A chapter dispatched
       before Phase 0b while its re-cast was still queued was attributed against
       the rolling roster and put in P (M8c); its re-cast has since succeeded
       and cleared the cast record, so nothing else in this run would
       re-attribute it. Re-attribute every non-excluded chapter still in P, one
       at a time, on the final roster (M8 then takes it out of P); a throw is
       M10. */
    for (let i = 0; i < totalChapters; i++) {
      const ch = recordRef.chapterHints[i];
      if (ch.excluded || !(cache.pendingAttributionChapterIds ?? []).includes(ch.id)) continue;
      if (abortController.signal.aborted) {
        throw new AnalysisAbortedError('Analysis aborted before re-attributing a pending chapter.');
      }
      /* The pool's per-chapter dispatch check: an overflow the previous M8d
         chapter recorded (a swallowed escalation window) starts no next one. */
      throwIfReasoningOverflowed(job);
      dispatchedOnFinalRoster.set(i, true);
      takeWork(job);
      try {
        await runChapterBody(i);
      } catch (e) {
        job.halting = true;
        inFlight.delete(i);
        await recordChapterBodyFailure(i, e);
        throw e;
      } finally {
        releaseWork(job);
      }
    }
    /* An escalation overflow inside the M8d pass, as after the join. */
    throwIfReasoningOverflowed(job);

    /* Stitch the per-chapter results into narrative order. */
    for (const ch of record.chapterHints) {
      const arr = sentencesByChapter.get(ch.id);
      /* R8: a take recorded (or replayed from the cache) before a Phase-0b re-mint. */
      if (arr) allSentences.push(...remapSentenceIds(arr, remintIdMap));
    }

    /* Final manuscript-edits.json write is deferred until after the fold
       pass below so on-disk sentences match the folded cast (bucket ids
       instead of unknown-jogger / one-line bystanders). The per-iteration
       writes inside runChapter still stream unfolded sentences during
       analysis for live UI visibility. */
    log(
      1,
      `Attributed ${allSentences.length.toLocaleString()} sentences across ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}`,
    );
    /* Per-character line counts, sorted by lines descending — most prominent first. */
    {
      const lineCounts = new Map<string, number>();
      for (const s of allSentences) {
        lineCounts.set(s.characterId, (lineCounts.get(s.characterId) ?? 0) + 1);
      }
      const top = stage1.characters
        .map((c) => ({ name: c.name, lines: lineCounts.get(c.id) ?? 0 }))
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 4);
      for (const t of top) log(1, `${t.name}: ${t.lines.toLocaleString()} lines`);
    }
    send({ kind: 'phase', phaseId: 1, progress: 1, label: PHASES[1].label, model: phase1ModelId, engine: phase1Engine });

    /* ── Phase 2: matching library — empty for first slice. */
    markPhase(2);
    log(2, 'No library matches yet (voice library matching is not wired up for this slice).');
    for (let i = 1; i <= 3; i++) {
      send({ kind: 'phase', phaseId: 2, progress: i / 3, label: PHASES[2].label });
      await new Promise((r) => setTimeout(r, PHASES[2].durationMs / 3));
    }

    /* ── Compose the AnalyseResponse. */
    /* The hint title is authoritative (kept in step with state.json by the
       restructure route, and by hydration only when the chapter counts match
       and the ids line up); the cached stage1 chapter list is only a snapshot
       keyed by pre-restructure ids (#3681). */
    const chapters = record.chapterHints.map((h) => ({
      id: h.id,
      title: h.title,
      duration: durationPlaceholder(),
      state: 'queued' as const,
      progress: 0,
      characters: {} as Record<string, 'queued' | 'in_progress' | 'done' | 'skipped' | 'failed'>,
      /* Carry the user's exclusion choice into the frontend so the Generate
         view can render the chapter greyed-out with an "Excluded" pill
         instead of stalling it as forever-queued. */
      excluded: h.excluded || undefined,
    }));

    /* Minor-cast fold pass. Rolls "Unknown <descriptor>" characters and
       anyone with too few attributed sentences into generic Unknown
       male / Unknown female buckets so the cast roster doesn't accumulate
       a voice profile per one-off bystander. Runs on stage1 + sentence
       outputs in-memory only — the cache stays ground truth so the rules
       can be tuned without invalidating in-flight progress. The
       per-character sentence threshold is user-configurable in the
       account view (`minorCastMinLines`); see
       server/src/analyzer/fold-minor-cast.ts for the trigger contract. */
    const userSettings = await readUserSettings();
    /* PR #4103 pass 1 O2 — a user's mid-run merges, before the dedup and the fold see the
       roster. After the Phase-2 sleep and the settings read (pass 3 P3-2), so no await of
       the job's own lies between this collapse and the dedup. */
    const collapsed = await collapseMidRunMerges({
      bookDir: liveBookDir(job) ?? undefined,
      roster: stage1.characters,
      sentences: allSentences,
      prior: priorCastForMerge as PriorRow[],
      plan: cache.matchPlan,
      currentBookId: recordRef.bookId ?? undefined,
    });
    if (collapsed) {
      stage1.characters = collapsed.roster;
      allSentences.splice(0, allSentences.length, ...collapsed.sentences);
      cache.matchPlan = collapsed.plan;
      planConstraints = collapsed.constraints;
      planProtectIds = collapsed.protectIds;
    }
    /* Recover dialogue lines stage-2 left on the narrator (a prose-tagged
       speaker who is in the roster but got 0 attributed lines) BEFORE the fold
       counts lines, so the fold doesn't drop them as 0-line. */
    const recovered = recoverTaggedNarratorLines(allSentences, stage1.characters, bookLanguage);
    if (recovered.flipped > 0) {
      const summary = [...recovered.byId.entries()].map(([id, n]) => `${id}=${n}`).join(', ');
      log(
        1,
        `Recovered ${recovered.flipped} narrator-attributed line(s) to tagged speakers (${summary}).`,
      );
    }
    /* srv-1 — dedup BEFORE the fold: collapse same-name / token-subset roster
       duplicates and rewrite their sentences onto the canonical id, so the fold
       counts lines against deduped ids. Captures pre-dedup lineage for the
       journal + diminutive suggestions for the sibling file. */
    const dd = dedupAndPrepare(stage1.characters, recovered.sentences, bookLanguage, planConstraints);
    stage1.characters = dd.characters;
    recovered.sentences = dd.sentences;
    /* #1447 — strip a real third-party person named/quoted only in a non-story
       front-matter chapter, BEFORE the fold so the proseTagged carve-out never
       protects the bogus entry. Bodies from record.chapterHints (all chapters,
       narrative order incl. excluded, so the front-region index is honest).
       Signal 2 via the analyzer only when the method is implemented. */
    const guardChapters: ThirdPartyGuardChapter[] = record.chapterHints.map((h) => ({
      id: h.id,
      title: h.title,
      body: h.body,
    }));
    const classifyNonStory = buildNonStoryClassifier({
      job,
      structureBudget,
      analyzer,
      manuscriptId,
      bookTitle: recordRef.title ?? null,
      bookLanguage,
      /* #3084 wave 3d — same relabel as the stage-1 call's switch handler (the shared phase-0 analyzer
         is sticky, so whichever call switches first relabels the job). */
      onFallback: ({ reason }) => {
        if (selection.fallbackModel && selection.fallbackEngine) {
          activeModelId = selection.fallbackModel;
          activeEngine = selection.fallbackEngine;
          setPhaseEngine(job, 0, activeEngine);
          markFallbackActive(job, selection.fallbackModel);
        }
        console.log(`[analysis] ${manuscriptId}: ${reason}`);
      },
    });
    const guarded = await stripThirdPartyFrontMatter(
      stage1.characters,
      recovered.sentences,
      guardChapters,
      { minLines: userSettings.minorCastMinLines, classifyNonStory },
    );
    if (job.reasoningOverflowed) {
      send({
        kind: 'warning',
        code: NONSTORY_OVERFLOW_WARNING_CODE,
        message: nonStoryOverflowWarningMessage(job.reasoningOverflowError ?? { transport: 'openai', model: '' }),
      });
    }
    if (guarded.stripped.length > 0) {
      log(
        1,
        `Stripped ${guarded.stripped.length} third-party front-matter cast reference(s) (${guarded.stripped.join(', ')}) — re-routed to narrator.`,
      );
    }
    stage1.characters = guarded.characters;
    recovered.sentences = guarded.sentences;
    /* The fold's protect-set cast read (P2-3), taken before the collapse below so no await
       sits between that collapse and the fold (PR #4103 pass 4 M-c). */
    const untouchedRunRows = await untouchedRunRowIds(cache.addedRows, liveBookDir(job) ?? undefined);
    /* PR #4103 pass 2 P2-2 — again, right before the fold: a merge that landed after the
       collapse above (the Phase-2 sleep, the settings read, the classifier) is honoured too. */
    const collapsedAgain = await collapseMidRunMerges({
      bookDir: liveBookDir(job) ?? undefined,
      roster: stage1.characters,
      sentences: recovered.sentences,
      prior: priorCastForMerge as PriorRow[],
      plan: cache.matchPlan,
      currentBookId: recordRef.bookId ?? undefined,
    });
    if (collapsedAgain) {
      stage1.characters = collapsedAgain.roster;
      recovered.sentences = collapsedAgain.sentences;
      cache.matchPlan = collapsedAgain.plan;
      planProtectIds = collapsedAgain.protectIds;
    }
    /* Plan 291 (R29) - the fold runs on plan-applied ids and never folds a row the plan
       joined to a prior row (`planProtectIds`, as the live-view fold does), except a run's
       own untouched row (PR #4103 pass 2 P2-3). */
    const folded = foldMinorCast(stage1.characters, recovered.sentences, {
      minLines: userSettings.minorCastMinLines,
      language: bookLanguage,
      protectIds: withoutUntouchedRunRows(planProtectIds, untouchedRunRows),
    });
    /* Fill each folded survivor's tone from its attributes where the analyzer
       left it blank (axes default to a neutral 50). */
    folded.characters = folded.characters.map(fillToneFromAttributes);
    if (folded.summary.foldedCount > 0) {
      const parts: string[] = [];
      if (folded.summary.intoMale) parts.push(`${folded.summary.intoMale} → Unknown male`);
      if (folded.summary.intoFemale) parts.push(`${folded.summary.intoFemale} → Unknown female`);
      log(
        1,
        `Folded ${folded.summary.foldedCount} background character${folded.summary.foldedCount === 1 ? '' : 's'} (${parts.join(', ')}) — names rolled into aliases.`,
      );
    }
    if (folded.summary.droppedSilent > 0) {
      const sample = folded.dropped.slice(0, 4).join(', ');
      const more = folded.dropped.length > 4 ? `, +${folded.dropped.length - 4} more` : '';
      log(
        1,
        `Dropped ${folded.summary.droppedSilent} non-speaking character${folded.summary.droppedSilent === 1 ? '' : 's'} from the cast (${sample}${more}) — no attributed dialogue, narrator covers them.`,
      );
    }

    const characters0 = applyNarratorIdentity(
      attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences),
      bookLanguage,
    );

    /* Plan 291 (#4031) - the roster is already in plan-applied ids (Phase 0b applied the
       match plan before the dedup and the fold), and the persist re-reads the cast and
       joins nothing by name. No second fresh->prior match runs here: it
       would re-match a planned row a second time (rule 1, invariant 1). */
    const characters = characters0;

    /* Phase 1 character-id reconciliation (see reconcileSentenceCharacterIds
       comment for motivation). Demote orphan ids to narrator before the
       manuscript-edits write; abort with `attribution_drift` if the
       demotion rate exceeds the threshold on a non-trivial sample so the
       confirm screen never advances against a corrupted run.

       Plan 291 (item 17) - valid = the roster plus every id live in cast.json, read
       lock-free just before the gate: a take replayed from a cache rebuilt from the
       book's edits names prior rows the fresh roster may not hold (twins the plan kept
       apart), and those lines are not orphans. */
    const phase1ValidIds = await driftGateValidIds(job, record.bookDir, characters);
    /* CJK books: rescue honorific/title-variant orphans (奥杜万师傅 ↔ 奥杜万)
       back to their roster id before demotion, so a Phase-0/Phase-1 title
       disagreement can't false-trip the drift gate. No-op for non-CJK. */
    const remappedForCjk = remapCjkHonorificIds(folded.sentences, characters, phase1ValidIds, {
      bookLanguage,
      onRemap: ({ sentence, originalId, toId }) => {
        log(
          1,
          `Sentence in ch${sentence.chapterId} attributed to CJK title-variant "${originalId}" — remapped to roster id "${toId}".`,
        );
      },
    });
    if (remappedForCjk.remappedCount > 0) {
      const summary = Array.from(remappedForCjk.remappedByOriginalId.entries())
        .map(([id, count]) => `${id}=${count}`)
        .join(', ');
      log(
        1,
        `Remapped ${remappedForCjk.remappedCount} CJK title-variant attribution${remappedForCjk.remappedCount === 1 ? '' : 's'} to their roster ids (${summary}).`,
      );
    }
    const demotedByChapter = new Map<number, number>();
    const reconciled = reconcileSentenceCharacterIds(remappedForCjk.sentences, phase1ValidIds, {
      onDemote: ({ sentence, originalId }) => {
        demotedByChapter.set(
          sentence.chapterId,
          (demotedByChapter.get(sentence.chapterId) ?? 0) + 1,
        );
        log(
          1,
          `Sentence in ch${sentence.chapterId} attributed to unknown character "${originalId}" — demoted to narrator.`,
        );
      },
    });
    warnPerChapterDrift(folded.sentences, demotedByChapter, log);
    if (reconciled.demotedCount > 0) {
      const summary = Array.from(reconciled.demotedByOriginalId.entries())
        .map(([id, count]) => `${id}=${count}`)
        .join(', ');
      log(
        1,
        `Demoted ${reconciled.demotedCount} of ${folded.sentences.length} sentences to narrator (orphan ids: ${summary}).`,
      );
    }
    const phase1DriftExceeded = attributionDriftExceeded(
      reconciled.demotedCount,
      folded.sentences.length,
    );

    const totalElapsed = Date.now() - startedAt;
    const bookId = record.bookId ?? bookIdFromTitle(record.title);
    const response = {
      bookId,
      manuscriptId,
      title: record.title,
      phaseTimings: PHASES.map((p) => ({
        id: p.id,
        label: p.label,
        duration: endPhase(p.id) || Math.round(totalElapsed / PHASES.length),
      })),
      characters,
      chapters,
      sentences: reconciled.sentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    // Persist cast.json + refreshed manuscript-edits.json + state.json back
    // into the on-disk book. Only runs for books that came through POST
    // /api/books (workspace flow); legacy POST /api/manuscripts uploads
    // have no bookDir and are skipped.
    //
    // With sticky analysis (B1) the run survives client navigation, so
    // there's no clientGone gate — writing cast.json on completion
    // accurately reflects the work that finished, and the user's next
    // visit lands on the confirm screen (which is what they want when
    // the analysis ran to completion in the background).
    //
    // Still skipped when attribution drift exceeded the threshold —
    // we write manuscript-edits.json with the demoted sentences (so
    // the disk state is internally consistent) but leave cast.json /
    // state.json untouched so the book doesn't flip to `cast_pending`
    // against a corrupted run. The user sees the `attribution_drift`
    // error in the analysing view and can retry.
    /* #3435 (M13a) — a Pause that landed after the pools joined (the fold, the
       non-story classifier, the Phase-2 stub — whose timeouts ignore the signal)
       ends the run aborted with nothing persisted. */
    if (job.controller.signal.aborted) throw new AnalysisAbortedError('Analysis aborted before persisting.');
    if (record.bookDir) {
      /* #2260 review round 3 (C1) — a lock-acquisition timeout out of the
         identity block below must fail the JOB, but it must NOT be thrown
         from inside this persist: doing that skipped
         `logCarriedForwardCharacters` and the whole state.json rewrite, and
         then landed in `catch (persistErr)` — which logs "non-fatal" and
         falls through to `send({kind:'result'})`. Net effect of throwing
         early was strictly worse than swallowing: the job still reported
         SUCCESS, and state.json now kept the PREVIOUS run's chapter list,
         durations, analysisProvenance and updatedAt. So the timeout is
         parked here and rethrown after this try/catch has closed — the
         writes all complete, and the throw then escapes `catch (persistErr)`
         into the job's top-level catch, which ends the job via
         `endJob(…, {kind:'error'})`.

         #2295 — this slot has several producers, hence the name: the identity
         block below, the AUTHORITATIVE cast.json write (plan 291: the planned
         persist's cast lock) and the state.json write. Which WRITE timed out is
         what decides; which HANDLER caught it is not (see the wrap on
         `persistPlannedCast` below). */
      let persistLockTimeout: unknown;
      /* #4031 R48 — an authoritative write's non-lock failure (`parkPersistFailure`),
         rethrown after the remaining writes, like `persistLockTimeout`. */
      let persistWriteError: unknown;
      let staleBookDirError: unknown;
      /* #3435 (plan 287 M17/S14) — set only once THIS block's state.json write
         has landed. The `try` completing is not enough: on attribution_drift
         it completes with the cast.json/state.json writes skipped, and
         `catch (persistErr)` swallows a failed write. */
      let wroteStateJson = false;
      /* Plan 291 — what the planned persist wrote (set only once cast.json landed). */
      let persisted: PersistOutcome | undefined;
      /* The job's copy of the cache's ledger as the persist read it (PR #4103 pass 3 P3-1). */
      let ledgerBeforePersist: RunAddedLedger = {};
      /* #4031 (N2) — the persist's cache op, when it faulted; re-sent once below. */
      let persistUnsentPatch: CachePatch | undefined;
      /* #2196 — resolve the SINGLE verified write target before ANY write.
         Identity-gated (full `.audiobook/state.json` check on liveBookDir(job),
         invalidate + re-hydrate on a miss — C2). Throwing BookDirUnresolvedError
         here (an out-of-process-moved / gone book) skips EVERY write in this
         block: no `writeJsonAtomic` mkdir can recreate the stale folder (C1).
         It propagates straight past `catch (persistErr)` to this job's
         top-level catch, which ends the run halted (C3). Every write below is
         re-keyed onto `writeDir` (R3 — no ordering bet). */
      const writeDir = await resolveVerifiedBookDirForRun(job);
      try {
        /* srv-1 — record this fold pass's lineage (see writeFoldJournal). Non-fatal:
           a journal failure must never fail the analysis persist. */
        try {
          await writeFoldJournal(
            writeDir,
            folded.rewrites,
            recovered.sentences,
            stage1.characters,
          );
        } catch (journalErr) {
          /* #2295 — a lock-acquisition timeout is swallowed HERE, on purpose,
             and this handler is why the discrimination is by WRITE SITE rather
             than by handler: `catch (persistErr)` below covers this call too,
             so parking from there would fail a whole completed analysis over a
             lineage file. The journal is lineage, not identity — losing it
             degrades the merge-undo affordance, it cannot diverge cast.json
             from the identity record. The AUTHORITATIVE cast.json write below
             is the one that parks and fails the run. */
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
        /* srv-1 — record this run's dedup lineage. Non-fatal, mirroring the fold
           journal. Plan 291 (A24): its suggestions are no longer written here - they
           ride the planned persist's suggestions step, after the drift gate. */
        try {
          await writeDedupJournal(
            writeDir,
            dd.rewrites,
            dd.preDedupSentences,
            dd.preDedupRoster,
          );
        } catch (dedupErr) {
          /* #2295 — same deliberate swallow as the fold journal above, same
             reason: dedup lineage is advisory, and a lock timeout on it must not
             fail a completed analysis. */
          console.warn('[analysis] failed to write dedup journal', dedupErr);
        }
        /* Plan 291 (#4031) — the run's terminal cast write is `persistPlannedCast`
           (workspace/analysis-cast-io.ts): under the cast lock it re-reads cast.json
           and the history, plans the rows created since Phase 0b (the fold's
           buckets), overlays the plan-applied roster (persist mode: prior rows are
           carried forward, rule 1; a run-added row the roster no longer holds is
           removed unless the user edited it, rule 11), writes cast.json, writes
           manuscript-edits.json under the nested `book` lock and reconciles the
           suggestions. It replaces the old by-name merge and its compare-and-set merge
           base (#2015).

           A `LockAcquisitionTimeoutError` from its cast lock means NOTHING was
           written: it is parked in `persistLockTimeout` and the remaining writes
           (state.json) still run before the deferred rethrow below (#2260 C1, #2295).
           An edits-write failure AFTER cast.json landed carries the computed outcome
           (`PersistOutcomeError`): the retirements and the cache patch still run
           from it. #4031 R48 — that failure and any other throw (which wrote nothing)
           are parked in `persistWriteError` the same way: state.json still lands,
           without the provenance stamp, then the job ends in a curated error. */
        const persistArgs = plannedPersistArgs({
          writeDir,
          bookId: record.bookId ?? undefined,
          cache,
          dd,
          roster: characters,
          sentences: reconciled.sentences,
          prior: priorCastForMerge as PriorRow[],
          ledgers: { kind: 'main' },
        });
        if (phase1DriftExceeded) {
          log(
            1,
            `Attribution drift exceeded threshold (${reconciled.demotedCount}/${folded.sentences.length} ≈ ${Math.round((100 * reconciled.demotedCount) / folded.sentences.length)}%) — refusing to flip cast.json / state.json. Retry analysis to re-attribute.`,
          );
          /* Plan 291 (A24, item 20): the refused run writes only manuscript-edits.json
             (the demoted sentences, so the disk stays consistent) and keeps none of its
             suggestions — the persist removes the pairs its snapshots added, a stopped
             run's included (the cache holds them across a resume). cast.json is left
             byte-for-byte alone. */
          const refused = await runPlannedPersist(persistArgs(true));
          if (refused.lockTimeout !== undefined) persistLockTimeout = refused.lockTimeout;
        } else {
          const retirementBookId = bookIdForRetirementCleanup(record);
          /* #2166 / PR #2202 gate review (Critical) — decide whether
             cast-id-history.json is READABLE before anything below rewrites
             it. Every history step after the persist (`recordRetirements`, both
             `dropSuperseded*` helpers) reads through the collapsing
             `loadCastIdHistory` and writes back unconditionally, so a degraded
             file is REPLACED by a valid, empty one within a few lines of here.
             Taking the verdict after that laundering would read `ok` on a file
             whose real content was lost, and the reconciliation below would then
             delete every same-book reject edge. The verdict must be captured
             here, first, and carried down. */
          const { status: historyStatusBeforePersist } = await loadCastIdHistoryWithStatus(writeDir);
          let planned: Awaited<ReturnType<typeof runPlannedPersist>> = {};
          try {
            planned = await runPlannedPersist(persistArgs(false));
          } catch (castErr) {
            persistWriteError = parkPersistFailure('[analysis]', writeDir, castErr);
          }
          const { outcome, editsWriteErr, lockTimeout } = planned;
          if (lockTimeout !== undefined) persistLockTimeout = lockTimeout;
          if (outcome) {
            const out = outcome;
            persisted = out;
            /* The result event carries what was persisted, not the fresh roster. */
            response.characters = out.characters as unknown as CharacterOutput[];
            response.sentences = out.sentences;
            /* The rule-11 ledger: a ledger entry the overlay dropped is deleted; only what
               changed is sent (M5). */
            const nextLedger: Record<string, LedgerEntry | null> = { ...out.ledger };
            for (const k of Object.keys(cache.addedRows ?? {})) if (!Object.hasOwn(out.ledger, k)) nextLedger[k] = null;
            ledgerBeforePersist = cache.addedRows ?? {};
            const ledgerPatch = ledgerDelta(ledgerBeforePersist, nextLedger);
            cache.addedRows = out.ledger;
            const { parked, unsentPatch } = await applyPlannedPersistOutcome({
              out,
              cache,
              manuscriptId,
              ledgerPatch,
              writeDir,
              retirementBookId,
              bookId: record.bookId ?? undefined,
              historyStatusBeforePersist,
              log,
            });
            if (parked !== undefined) persistLockTimeout = parked;
            persistUnsentPatch = unsentPatch;
          }
          /* The edits write failed after cast.json landed (see above): everything the
             outcome owed is recorded; the error is parked (R48) and state.json still runs. */
          if (editsWriteErr !== undefined) {
            persistWriteError = parkPersistFailure('[analysis]', writeDir, editsWriteErr);
          }
          /* `editsLanded`: cast.json and manuscript-edits.json both landed. False after a
             parked cast-lock timeout or a parked write failure. */
          const editsLanded = outcome !== undefined && editsWriteErr === undefined;
          /* #2196 review (🟡 TOCTOU) — re-verify the write target immediately
             before the terminal authoritative state.json record. A book-folder
             move landing mid-persist (after the block-top resolve) leaves
             `writeDir` stale: abort the terminal write loudly instead of
             resolving it to a stale/half-migrated path. (The earlier
             advisory/retirement writes sit inside this same tight block and are
             best-effort by design; this is the loud guard at the authoritative
             terminal record.) */
          /* #3400 pass 8 — the terminal state.json record is a book-locked read
             -> write (`updateStateAtDir`), taken after every cast-lock section
             above has been released (order `cast` -> `book`; the persist holds
             no cast lock here). Everything it decides — the user-owned flags
             carried below AND the chapter list itself — comes from the read
             under the lock, so a held / exclude write or a chapter restructure
             that landed since the job composed its response is not reverted.
             The chapter list is rebuilt from the LIVE record's hints (a
             restructure swaps them under the same lock), falling back to this
             job's own record when it has been evicted.

             The `state-json` leaf lock (taken inside `updateStateAtDir`, nested
             in the book lock) has a 10s acquisition bound, so this wrap is live:
             a timeout is parked, like the authoritative cast.json write's
             above, and rethrown after this persist's try/catch: the write did
             not land, so the job must end as an error rather than report
             success over an unwritten state.json. */
          try {
            wroteStateJson = await updateStateAtDir(writeDir, async (prev) => {
              /* Preserve the user-owned flags — analysis owns chapter titles/
                 durations, the user owns `excluded` and `held`. Match on id so a
                 re-run after a re-parse picks up whichever ids the parser
                 produced. `held` (the "Not queued" intent) can't be re-derived
                 from disk like the audio metadata can, so dropping it here would
                 silently lose the user's choice — see the chapter `held` doc in
                 workspace/scan.ts. */
              const prevExcludedById = new Map<number, boolean>();
              const prevHeldById = new Map<number, boolean>();
              /* srv-35 -- `uuid` is the chapter's stable identity (invariant 1:
                 no path regenerates one), so it rides through by id too; the
                 rebuild below would otherwise drop it and the next scan would
                 mint a fresh random uuid for every chapter (#3625). */
              const prevUuidById = new Map<number, string>();
              const prevOverriddenById = new Map<number, string>();
              for (const c of prev.chapters) {
                if (c.excluded) prevExcludedById.set(c.id, true);
                if (c.held) prevHeldById.set(c.id, true);
                if (c.uuid) prevUuidById.set(c.id, c.uuid);
                if (c.titleOverridden) prevOverriddenById.set(c.id, c.title);
              }
              const next: BookStateJson = {
                ...prev,
                /* #3628 — the title-source flags are not re-derivable here, so
                   carry them from prev (both only while the title is unchanged,
                   so a mis-aligned parse cannot move a flag onto another heading) or a re-analysis would
                   strip them and a later restructure would misjudge the title. */
                chapters: carryTitleSynthesized(
                  (getManuscript(job.manuscriptId) ?? record).chapterHints.map((h) => ({
                    id: h.id,
                    title: h.title,
                    slug: `${String(h.id).padStart(2, '0')}-${slug(h.title)}`,
                    duration: durationPlaceholder(),
                    excluded: prevExcludedById.get(h.id) || undefined,
                    held: prevHeldById.get(h.id) || undefined,
                    uuid: prevUuidById.get(h.id),
                    titleOverridden: prevOverriddenById.get(h.id) === h.title || undefined,
                  })),
                  prev.chapters,
                ),
                /* srv-59 Task 11 — record which analyzer produced this cast/
                   sentence set and, when the dialogue-structure engine ran,
                   the aggregated run report. Additive + schema-tolerant: no
                   reader may require this block (see BookStateJson). Plan 291 —
                   only when the planned persist's writes landed (`editsLanded`):
                   after a parked cast-lock timeout they did not, and the
                   previous run's provenance (in `prev`) still describes disk. */
                ...(editsLanded ? { analysisProvenance: {
                  engine: phase1Selection.engine,
                  model: phase1Selection.model,
                  at: new Date().toISOString(),
                  structureEngineVersion: 1,
                  report: aggregateStructureReports(structureReports),
                  scope: 'book',
                  chaptersCovered: chapters.length,
                  /* #2267/#2275 C3 — a SIBLING of `report`, computed
                     independently: `aggregateStructureReports` returns
                     `undefined` for an empty `structureReports` (engine off, or
                     every chapter this pass served from cache), but this
                     reading needs neither an EngineReport nor the engine having
                     run — see design of record §4 and the field's own doc
                     comment on BookStateJson.analysisProvenance. */
                  maxMergedTurnsInParagraph: aggregateMaxMergedTurns(perChapterMaxMergedTurns),
                } } : {}),
                updatedAt: new Date().toISOString(),
              };
              /* Plan 290 — when this run re-keyed every saved sentence to the
                 current chapters (the planned persist's edits write landed:
                 `editsLanded`; a parked cast-lock timeout wrote nothing), the
                 stale-evidence marker goes. Only the main persist clears it. That holds because
                 every producer of the marker leaves no stale cache behind, and
                 none runs while this job is registered: re-parse and
                 replace-manuscript wipe the analysis cache, a bundle overwrite
                 and a backup restore clear it when they stamp the marker (owner
                 round 11), a restructure on a marked book clears it, and each
                 refuses with `book_busy` while a long job holds the book (PR
                 #3966 review pass 2), so no chapter's take here was replayed
                 from a cache keyed to an older chapter list. */
              if (editsLanded) delete next.sentencesPredateChapters;
              return next;
            }, {
              /* Re-verified inside the book lock (a rename holds it) but BEFORE
                 the state-json leaf lock: the slow path of this check can
                 re-hydrate the manuscript and scan the library, whose heals
                 take that same leaf lock. */
              underBookLock: () => assertWriteTargetStable(job, writeDir),
            });
          } catch (stateWriteErr) {
            if (isLockAcquisitionTimeout(stateWriteErr) || stateWriteErr instanceof BookDirUnresolvedError) {
              if (isLockAcquisitionTimeout(stateWriteErr)) persistLockTimeout = stateWriteErr;
              throw stateWriteErr;
            }
            /* #4031 R48 — the terminal record did not land: parked, not swallowed. */
            persistWriteError ??= parkPersistFailure('[analysis]', writeDir, stateWriteErr);
          }
        }
      } catch (persistErr) {
        /* #2196 — a MID-BLOCK guard failure (TOCTOU move landing after the
           block-top resolve — e.g. from `assertWriteTargetStable` at the
           state.json write) must not be swallowed into a false success. Park and
           rethrow after this try/catch, mirroring the lock-timeout below.
           The block-top resolve already threw PAST this catch for the
           primary stale-dir case. The durable STALE_BOOK_DIR fail-loud log
           is emitted ONCE by the run's top-level catch (V7·1), which both
           paths reach, so nothing is logged here — just park. */
        if (persistErr instanceof BookDirUnresolvedError) {
          staleBookDirError = persistErr;
        } else {
          console.error('[analysis] failed to persist .audiobook/* for', writeDir, persistErr);
          /* Non-fatal — only a best-effort step lands here, or the drift-refused
             edits write (that run ends in `attribution_drift` regardless): every other
             AUTHORITATIVE write's failure is parked (`persistLockTimeout` /
             `persistWriteError`, #4031 R48). */
        }
      }
      /* #2260 round 3 (C1) — the deferred rethrow. OUTSIDE the try/catch
         above on purpose: from in there it would be caught by
         `catch (persistErr)` and the job would still end via
         `send({kind:'result'})`. From here it reaches this job's top-level
         catch, which classifies it and calls `endJob(job, {kind:'error', …})`
         — the loud outcome the timeout exists to produce — while every write
         in the persist has already completed. (Plan 291 — a cast-lock timeout
         at the planned persist parks too: its own writes did not land, the
         remaining state.json write still does, without the provenance stamp or
         the stale-evidence marker clear, and the job then ends with the error.) */
      /* #4031 (N2) — before anything can end the run, the persist's faulted cache op is
         re-sent once (its decisions, re-mints and ledger have no other writer). */
      if (persistUnsentPatch) await resendCachePatch(manuscriptId, persistUnsentPatch);
      if (persistLockTimeout !== undefined) throw persistLockTimeout;
      /* #2196 — surface a mid-block BookDirUnresolvedError to the run's
         top-level catch (Task 6), which ends the job halted. Ahead of a parked write
         error (R2-M4): a moved book must halt the run, not end it as a save failure. */
      if (staleBookDirError !== undefined) throw staleBookDirError;
      if (persistWriteError !== undefined) throw persistWriteError;
      /* #3435 M17/S14 — the takes are persisted and the book has reached
         Confirm (decision F); `confirmReached` is never cleared except with the
         cache. */
      if (wroteStateJson) {
        cache.takesPersisted = true;
        cache.confirmReached = true;
        /* Plan 291 (F2, R4) — a completed persist ends the run's ledger: the
           `run-owned` entry of every row it wrote becomes `added-once` (sticky), and
           `clearLedger` then drops the remaining `run-owned` entries and the run's
           suggestion pairs. A later re-run that reuses the cached plan therefore
           still knows those rows as the run's own (no re-mint), and a user delete of
           one sticks. The cache takes follow the persist's reroute of lines a
           deleted plan target held to the narrator (rule 13), applied to the cache
           on disk inside the op so a merge's rewrite of the takes is not reverted.
           An entry for a row this persist wrote is always sent (PR #4103 pass 4 P4-1):
           the persist's own patch may have made it `run-owned` on disk, which the
           `clearLedger` below would delete. For an entry the run only carried, just
           what changed against the job's copy as the persist read it is sent (M5,
           pass 3 P3-1): unchanged, it is already on disk, or a route (a merge)
           deleted it mid-run and it stays deleted. */
        const writtenIds = new Set((persisted?.characters ?? []).map((c) => c.id));
        const addedOnce: Record<string, LedgerEntry> = {};
        for (const [k, e] of Object.entries(persisted?.ledger ?? {})) {
          if (e.state === 'run-owned' ? writtenIds.has(k) : true) addedOnce[k] = { state: 'added-once' };
        }
        cache.addedRows = Object.keys(addedOnce).length > 0 ? addedOnce : undefined;
        delete cache.runAddedPairs;
        await mutateAnalysisCache(manuscriptId, {
          fields: { takesPersisted: true, confirmReached: true },
          clearLedger: true,
          ledger: ledgerDelta(ledgerBeforePersist, addedOnce, persisted ? persistWrittenIds(persisted) : undefined),
          ...rerouteDeletedTakesPatch(persisted),
        });
      }
    }

    if (phase1DriftExceeded) {
      /* Phase 1 produced too many orphan attributions to trust. Emit an
         `attribution_drift` error and skip the `result` event so the
         analysing view stays put instead of advancing to confirm against
         a corrupted run. manuscript-edits.json was written with the
         demoted sentences so disk state is consistent; cast.json /
         state.json were skipped above so the book doesn't flip to
         `cast_pending`. The user retries; the cache is preserved. */
      endJob(job, {
        kind: 'error',
        code: 'attribution_drift',
        message: `Phase 1 demoted ${reconciled.demotedCount} of ${folded.sentences.length} sentences (${Math.round((100 * reconciled.demotedCount) / folded.sentences.length)}%) to narrator — model attribution unreliable. Retry analysis to re-attribute — or Start fresh to re-attribute every chapter.`,
      });
      return;
    }

    send({ kind: 'result', response });
    endJob(job);
    return;
  } catch (e) {
    /* AnalysisAbortedError: an in-flight LLM call was aborted because
       /pause was hit or a fresh: true POST displaced this job. Emit a
       structured `aborted` error so the UI distinguishes "you paused
       this" from "the analyzer broke" — the frontend uses code:
       'aborted' to short-circuit its error-banner path. */
    if (e instanceof AnalysisAbortedError) {
      console.log(`[analysis] aborted ${manuscriptId} (paused or displaced)`);
      endJob(job, {
        kind: 'error',
        code: 'aborted',
        message: 'Analysis aborted (paused or displaced by a new run).',
      });
      return;
    }
    if (e instanceof BookDirUnresolvedError) {
      /* #2196 — an out-of-process-moved / gone book makes this run's writes
         unresolvable and defuses the stale-folder resurrection (C1). End the
         job terminal `halted`; persistTerminalSnapshot (Task 7) runs in
         mode:'drop', so no dead-dir halted snapshot is written. V7·1 — this
         always-on server error naming manuscriptId + STALE_BOOK_DIR is the
         durable detached-run fail-loud (the in-memory marker is
         non-observable once endJob deregisters the job); the endJob broadcast
         below then surfaces the halt to any attached subscriber. */
      console.error(
        `[analysis] ${manuscriptId} STALE_BOOK_DIR: ${(e as Error).message}`,
      );
      endJob(job, {
        kind: 'error',
        code: 'STALE_BOOK_DIR',
        message: e.message,
      });
      return;
    }
    /* Structured dump — SDK errors don't stringify cleanly with bare
       console.error, which means the upstream status + details get lost in
       the log. Match the shape the route surfaces to the UI so debugging
       reads the same on both sides. */
    const parsedLog = tryParseApiError((e as Error)?.message ?? String(e));
    console.error('[analysis] failed', {
      manuscriptId,
      lastStep,
      model: activeModelId,
      name: (e as Error)?.name,
      status: (e as { status?: number })?.status,
      upstreamStatus: parsedLog?.status,
      upstreamCode: parsedLog?.code,
      message: (e as Error)?.message,
      details: parsedLog?.details,
    });
    const {
      code,
      userMessage: message,
      remediation,
      detail,
      fixes,
    } = classifyAnalysisFailure(e, terminalFailureLabel(job, analyzerLabel, phase1TerminalLabel), {
      chapter: job.reasoningOverflowChapter,
    });
    /* #3084 F7 — `fixes` travels on the SSE `error` event ONLY. `endJob`'s
       #3004 last-outcome record deliberately stays code+message (nothing on the
       frontend reads `priorOutcome`'s extras — see endJob's own comment). */
    endJob(job, { kind: 'error', code, message, remediation, detail, fixes });
  }
}

/* POST /api/manuscripts/:id/analysis/pause — explicit pause for the
   sticky analyzer loop. Mirrors /generation/pause: aborts the job's
   controller, which the analyzer's per-call signal plumbing turns into
   an AnalysisAbortedError; the runMainAnalyzerJob catch above emits a
   structured `error: aborted` event to every attached subscriber and
   ends each response. Idempotent: returns 200 with paused:false when
   no job is running so a double-click on Pause doesn't 404. */
analysisRouter.post('/:id/analysis/pause', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;
  /* Plan 32 D1: a pause request abort BOTH a live main run AND a live
     subset retry for this manuscript. The user's mental model is
     "stop the analysis on this book"; whether the work is the full
     run or a per-chapter retry is an implementation detail. Each is
     aborted independently; either could be absent. */
  const main = inFlightAnalysisByManuscript.get(manuscriptId);
  const subset = inFlightSubsetByManuscript.get(manuscriptId);
  let paused = false;
  for (const job of [main, subset]) {
    if (!job || job.controller.signal.aborted) continue;
    /* Write the paused snapshot BEFORE aborting so a cold-boot
       fetch right after pause is guaranteed to see paused state.
       The analyzer's catch-block fires endJob({code:'aborted'})
       asynchronously, which also writes paused state — that write
       is idempotent with this one (same phase + state).
       #3711 — folded into `job.terminalWrites` synchronously, so the job's
       `settled` (and the route's lease) waits for it even if the job ends on
       its own while this write is still landing. */
    const pausedWrite = persistTerminalSnapshot(job, 'paused', { code: 'aborted', message: 'Analysis paused.' });
    job.terminalWrites = Promise.allSettled([job.terminalWrites, pausedWrite]).then(() => undefined);
    await pausedWrite;
    job.controller.abort();
    paused = true;
  }
  /* #3435 — also reach any main writer still draining (displaced, or ended).
     endJob has always aborted an ended job already, so this only makes Pause
     idempotent over a drain: it writes no snapshot (endJob wrote the terminal
     one) and leaves the drain deadline as it is. */
  for (const writer of mainWritersByManuscript.get(manuscriptId) ?? []) {
    if (!writer.controller.signal.aborted) writer.controller.abort();
  }
  res.status(200).json({ ok: true, paused });
});

/* POST /api/manuscripts/:id/analysis/chapters — subset re-analysis.

   Used when the user un-excludes a chapter in the Generate view: that
   chapter never went through the full pipeline (because it was excluded
   at confirm time) and now needs Phase 0a + Phase 1 to catch up. Runs
   sequentially (typical subset is 1–3 chapters), reuses the existing
   cache, and merges incrementally so the rest of the book's analysis
   stays untouched.

   Streaming shape is identical to the full-book route — same SSE event
   kinds (phase / log / cast-update / heartbeat / result / error) so the
   frontend's existing analysing-view listener handles it without
   special-casing. The differences are operational: no `fresh` reset,
   no concurrency pool (overkill for a handful of chapters), no Phase 2
   stub (we don't redo voice matching for a subset). */
analysisRouter.post('/:id/analysis/chapters', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;
  /* D2 (#3169) — this route had no per-click `[analysis]`-prefixed line at
     all (worse than the parent route's old `if (requestedModel)`-guarded
     one): getOrHydrateManuscript, the design-busy check, and chapter-id
     validation all ran silent. `body`/`requestedModel` are parsed here
     (moved up from their old spot further down, where `body` was also
     redeclared) so this one unconditional log covers a Start-click that
     reaches the server before any of that — same rationale as the parent
     route's `request received` line. No behaviour change: req.body is
     already fully parsed by the time this handler runs.
     F2 (#3169 fix wave) — this is a per-POST line, same reasoning as the
     parent route: the stream middleware's own subscribe POST reaches this
     handler too — it sends `chapterIds` because this route's own validation
     below requires a non-empty, valid array. The join branch further down
     DOES compare it against the running job's subsetChapterIds (#3202): a
     chapter-set match joins as before, a mismatch gets a terminal
     `subset_in_progress` error instead — but no `model` — so a single
     Start click can log it more than once. `model` and `manuscriptId` are both request-supplied text,
     both stringified (F2/F6, hardened post-review) as a log-injection
     guard, same as the parent route. */
  const body = req.body as {
    chapterIds?: unknown;
    model?: unknown;
    phase0Model?: unknown;
    phase1Model?: unknown;
    allowStage1Shrink?: unknown;
    origin?: unknown;
  };
  const requestedModel = typeof body?.model === 'string' ? body.model : undefined;
  /* #3774 — what is starting this run; anything but 'include' is a re-analyse. */
  const requestedOrigin: 'include' | 'reanalyse' = body?.origin === 'include' ? 'include' : 'reanalyse';
  const requestedChapterCount = Array.isArray(body?.chapterIds) ? body.chapterIds.length : 0;
  console.log(
    `[analysis-subset] request received manuscript=${JSON.stringify(manuscriptId)} ` +
      `model=${JSON.stringify(requestedModel ?? '(saved/default)')} chapters=${requestedChapterCount}`,
  );

  /* #3435 decision A, early check — refused while the book has a main writer,
     live or still draining. Checked again at registration (the late check
     below), because this handler awaits before it registers. */
  {
    const refusal = subsetRefusal(manuscriptId);
    if (refusal) {
      console.log(`[analysis-subset] refused main_analysis_running manuscript=${JSON.stringify(manuscriptId)}`);
      return res.status(409).json(refusal);
    }
  }

  /* #3829 -- same refusal as the main POST, for a subset START (a join of a live subset run is
     not one). */
  {
    const live = inFlightSubsetByManuscript.get(manuscriptId);
    if (!(live && !live.controller.signal.aborted)) {
      const rec = await getOrHydrateManuscript(manuscriptId);
      const verdict = rec ? await parseHintsStartCheck(manuscriptId, rec, { fresh: false }) : null;
      if (verdict?.kind === 'refuse') {
        console.log(`[analysis-subset] refused hints_out_of_sync manuscript=${JSON.stringify(manuscriptId)} why=${verdict.why}`);
        const e = new HintsOutOfSyncError();
        return res.status(409).json({ error: e.message, code: e.code });
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  /* Vite dev-proxy keep-alive shim — see the comment on the parent
     analysis route. Same hazard (silence while the first chapter is
     prepared) applies on a cold subset retry; a start hydrates before the
     headers (#3829), a join after them. */
  res.write(':ok\n\n');
  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch {
      /* socket gone */
    }
  }, 15_000);

  const send = (payload: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };

  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) {
    send({
      kind: 'error',
      code: 'unknown_manuscript',
      message: `No manuscript found for id "${manuscriptId}".`,
    });
    clearInterval(keepAlive);
    return res.end();
  }

  /* Mutual exclusion with a live "Design full cast" run (see the parent route). */
  if (record.bookDir && isDesignBusy(record.bookDir)) {
    send({
      kind: 'error',
      code: 'design_in_progress',
      message:
        'A "Design full cast" run is in progress for this book. Wait for it to finish (or cancel it) before re-analysing.',
    });
    clearInterval(keepAlive);
    return res.end();
  }

  const rawIds = Array.isArray(body?.chapterIds) ? body.chapterIds : [];
  /* See main route comment on allowStage1Shrink — same opt-in flag for
     the subset-retry path's stage1 finalisation. */
  const allowStage1ShrinkSubset = body?.allowStage1Shrink === true;
  const requestedIds = Array.from(
    new Set(rawIds.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))),
  );
  if (requestedIds.length === 0) {
    send({
      kind: 'error',
      code: 'bad_request',
      message: 'chapterIds is required and must be a non-empty array of integers.',
    });
    clearInterval(keepAlive);
    return res.end();
  }

  /* Validate against the manuscript record so a stale frontend id doesn't
     produce a confusing "chapter not found mid-stream" log line. Returns null
     when it refused (the response is ended). Runs again on the leased record
     when the start re-read it (review pass 6). */
  const hintsById = new Map(record.chapterHints.map((h) => [h.id, h]));
  const chaptersToRun = (rec: StartRecord): StartRecord['chapterHints'] | null => {
    const byId = new Map(rec.chapterHints.map((h) => [h.id, h]));
    const targets = requestedIds
      .map((id) => byId.get(id))
      .filter((h): h is NonNullable<typeof h> => !!h);
    if (targets.length === 0) {
      send({
        kind: 'error',
        code: 'bad_request',
        message: 'None of the requested chapter ids match this manuscript.',
      });
      clearInterval(keepAlive);
      res.end();
      return null;
    }
    const skippedExcluded = targets.filter((h) => h.excluded);
    if (skippedExcluded.length > 0) {
      /* Hard-stop rather than silently re-analyzing — the typical reason a
         caller hits this with excluded=true is a frontend bug where the
         toggle endpoint wasn't awaited before subset analysis kicked off.
         Better to fail fast than to leave half-state on disk. */
      send({
        kind: 'error',
        code: 'chapter_excluded',
        message: `Cannot run analysis on excluded chapter${skippedExcluded.length === 1 ? '' : 's'}: ${skippedExcluded.map((c) => c.title).join(', ')}. Flip the exclude flag first via POST /api/books/.../chapters/:chapterId/exclude.`,
      });
      clearInterval(keepAlive);
      res.end();
      return null;
    }
    return targets.filter((h) => !h.excluded);
  };
  const toRun = chaptersToRun(record);
  if (!toRun) return;

  /* ── Plan 32 D1 subscribe-vs-start dispatch.
     Mirrors the main /:id/analysis route's pattern. If a non-aborted
     subset job is already running for this manuscript, the new request
     joins the existing job's subscriber set and catches up on the
     replay state — same shape as a browser-reload or navigate-back
     reattach for the main run. Otherwise we register a new sticky job
     and spawn the analyzer work detached so the user can navigate
     away without aborting the retry. */
  /* #3435 decision A, late check — an SSE terminal `error` frame, no job registered. Unlike the
     main POST it refuses a join too, so it runs ahead of both live-job checks below: once before
     the reload fast path, and again after the awaits, in the same synchronous block as the
     registration. Returns true when it refused (the response is ended). */
  const refusedByMainWriter = (): boolean => {
    const refusal = subsetRefusal(manuscriptId);
    if (!refusal) return false;
    console.log(`[analysis-subset] refused main_analysis_running manuscript=${JSON.stringify(manuscriptId)}`);
    send(refusalFrame(refusal));
    clearInterval(keepAlive);
    res.end();
    return true;
  };
  /* #3084 P14 + #3004 — the same double-checked dispatch as the main POST. `joinLive` is
     today's subset rejoin body. It keeps #3202's rule, so neither live-job check below can
     silently attach this request to a run of other chapters. */
  const joinLive = (live: AnalysisJob): void => {
    /* #3202 — join only when this request's chapter set matches the
       running job's. Compared as sets (order-independent): a request for
       different chapters must not silently attach to someone else's run
       and then report on the wrong chapters. */
    const requestedIdSet = new Set(toRun.map((t) => t.id));
    const runningIdSet = new Set(live.subsetChapterIds ?? []);
    const sameChapterSet =
      requestedIdSet.size === runningIdSet.size &&
      [...requestedIdSet].every((id) => runningIdSet.has(id));
    if (!sameChapterSet) {
      const runningChapters = (live.subsetChapterIds ?? [])
        .map((id) => hintsById.get(id))
        .filter((h): h is NonNullable<typeof h> => !!h);
      const runningTitles = runningChapters.map((c) => c.title).join(', ');
      const titlePart = runningTitles ? `: ${runningTitles}` : '';
      const message = `A different subset re-analysis is already in progress for this manuscript${titlePart}. Wait for it to finish (or cancel it) before starting a different subset.`;
      send({
        kind: 'error',
        code: 'subset_in_progress',
        message,
      });
      /* N3 (#3202) — log the rejection outcome to distinguish a colliding
         re-POST from a wedged request that never got a response. */
      console.log(`[analysis-subset] subset_in_progress manuscript=${JSON.stringify(manuscriptId)}`);
      clearInterval(keepAlive);
      res.end();
      return;
    }
    /* F2 (#3169 fix wave) — same rationale as the parent route: the job
       doesn't store the model it's running, so this omits `model` rather
       than printing this POST's own (possibly wrong) requested/default
       one. */
    console.log(`[analysis-subset] subscribe manuscript=${JSON.stringify(manuscriptId)}`);
    const subscriber: AnalysisSubscriber = { send, res, keepAlive };
    live.subscribers.add(subscriber);
    replayCatchUp(live, send);
    res.on('close', () => {
      if (res.writableEnded) return;
      live.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — sticky semantics. The retry keeps running until
         /pause or terminal completion. */
    });
    res.on('finish', () => clearInterval(keepAlive));
  };
  if (refusedByMainWriter()) return;
  let existing = inFlightSubsetByManuscript.get(manuscriptId);
  /* 1. P14 — a reload goes through the live subset job (joined for the same chapters, refused
     with subset_in_progress for others): no settings read, no digest read, no checks. */
  if (existing && !existing.controller.signal.aborted) {
    joinLive(existing);
    return;
  }

  /* #3141 step 4 — optional per-run phase model picks for the subset retry
     too, never persisted. Empty/absent values are ignored, not rejected. */
  const requestedPhase0Model =
    typeof body?.phase0Model === 'string' && body.phase0Model.trim().length > 0
      ? body.phase0Model
      : undefined;
  const requestedPhase1Model =
    typeof body?.phase1Model === 'string' && body.phase1Model.trim().length > 0
      ? body.phase1Model
      : undefined;
  const requestedPhaseModels = { phase0: requestedPhase0Model, phase1: requestedPhase1Model };
  /* 2. #3084 N7 + A3 — new subset job only: saved settings (#3192 removed this POST's read; the
     checks need the saved endpoints and keys) and the installed digests of the Ollama targets
     (bounded 2 s, fail-open). */
  const userSettings = await readUserSettings();
  const preflightDigests = await resolvePreflightDigests(
    preflightTargets(['phase0', 'phase1'], requestedModel, userSettings, requestedPhaseModels),
  );
  /* #3711 — same as the main POST: a registered `analysis` job whose registration
     `await` sits after the awaits above and before the synchronous re-check window in
     `startSubset`; the lease is released when the (sequential) subset run ends. */
  const startSubset = async (lease: BookJobLease | null): Promise<unknown> => {
  /* PR #3714 review pass 6 — same as `startMain`: run on the record the lease
     names, and re-derive the chapters from it, before the `await`-free re-check. */
  const leased = await recordForLease(manuscriptId, record, lease);
  if ('refusal' in leased) {
    console.log(`[analysis-subset] refused manuscript_replaced manuscript=${JSON.stringify(manuscriptId)}`);
    send(leased.refusal);
    clearInterval(keepAlive);
    return res.end();
  }
  const leasedToRun = leased === record ? toRun : chaptersToRun(leased);
  if (!leasedToRun) return;
  /* 3. #3004 — both awaits above reopen the check-then-register window. Re-check with the same
     condition: a job a concurrent POST registered meanwhile goes through joinLive, so the same
     chapters join it and a different subset is refused (#3202), never duplicated. The #3435
     late check runs again first: a main writer registered during the awaits refuses this POST. */
  if (refusedByMainWriter()) return;
  existing = inFlightSubsetByManuscript.get(manuscriptId);
  if (existing && !existing.controller.signal.aborted) {
    joinLive(existing);
    return;
  }
  /* Plan 118 / #3141 step 1 — resolve cast (Phase 0) and attribution
     (Phase 1) analyzers via the per-phase selector so a saved Advanced
     Settings override applies to the subset retry too. This path is
     sequential (no watermark); the split only changes which model each
     pass uses. */
  /* 4. #3084 P14 — the checks and both selections share one failure path, and P23's shared
     coded event (3b Task 3b.1a) reports every failure on it, checks included. No `await`
     from the re-check above to `inFlightSubsetByManuscript.set` below (#3004). */
  let preflight: PreflightTarget[];
  let selection: AnalyzerSelection;
  let phase1Selection: AnalyzerSelection;
  const fallbackSwitch = new RunFallbackSwitch(); // #3084 wave 3d — one switch for both of this run's selections
  try {
    preflight = preflightTargets(['phase0', 'phase1'], requestedModel, userSettings, requestedPhaseModels);
    runAnalyzerPreflight(preflight, userSettings, preflightDigests);
    selection = selectAnalyzerForPhase({
      phase: 'phase0',
      model: requestedModel,
      phaseModel: requestedPhase0Model,
      fallbackSwitch,
    });
    phase1Selection = selectAnalyzerForPhase({
      phase: 'phase1',
      model: requestedModel,
      phaseModel: requestedPhase1Model,
      fallbackSwitch,
    });
  } catch (e) {
    send(analyzerSelectionErrorEvent(e)); // P23/P14 — the shared coded event, checks included
    clearInterval(keepAlive);
    return res.end();
  }

  /* Plan 32 D1: the analyzer/label/modelId derivations moved into the
     detached `runSubsetAnalyzerJob` body — keeping them here would
     re-derive the same values twice and produce TS unused-locals
     errors. The selection object travels into the function as-is. */

  /* Create the sticky subset job and register before spawning the
     analyzer work so a concurrent re-POST attaches as a subscriber
     instead of racing into a second registration. */
  const job: AnalysisJob = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'subset',
    subsetChapterIds: leasedToRun.map((t) => t.id),
    subsetOrigin: requestedOrigin,
    bookDir: lease?.bookDir ?? leased.bookDir ?? null,
    engine: selection.engine,
    fallbackSwitch,
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
    ended: false,
    halting: false,
    left: false,
    liveWork: 0,
  };
  job.settled = new Promise<void>((resolve) => {
    job.resolveSettled = resolve;
  });
  inFlightSubsetByManuscript.set(manuscriptId, job);
  if (job.bookDir) markAnalysisBusy(job.bookDir);
  /* #3084 P1 — the endpoints both phases will use (Task 3c.10's `preflight` targets, resolved
     exactly as selection resolves them, per-run phase picks included) stay busy for the whole
     run, gaps between chunk calls included, so TTS eviction does not unload them mid-run. */
  job.releaseEndpointRun = markEndpointRunActive(endpointIdsForModelIds(preflight.map((t) => t.modelId)));
  const subscriber: AnalysisSubscriber = { send, res, keepAlive };
  job.subscribers.add(subscriber);
  res.on('close', () => {
    if (res.writableEnded) return;
    job.subscribers.delete(subscriber);
    clearInterval(keepAlive);
    /* Sticky: do NOT abort. The retry keeps running for any other
       subscribers (or none — its writes still land on disk). Only
       /pause aborts. */
  });
  res.on('finish', () => clearInterval(keepAlive));

  /* F2 (#3169 fix wave) — the one outcome line for the new-job path,
     naming the RESOLVED phase-0 engine/model (mirrors `job.engine` above,
     which is also `selection.engine`). `selection.model` is stringified
     (F6) for the same reason as the parent route — it can carry the
     request body's `model` verbatim via `selectAnalyzerForPhase`'s
     per-request-override priority. `manuscriptId` is stringified too
     (post-review hardening) — same reason as the `request received`
     comment above. */
  console.log(
    `[analysis-subset] start manuscript=${JSON.stringify(manuscriptId)} engine=${selection.engine} model=${JSON.stringify(selection.model)}`,
  );

  /* Run the subset analyzer in the background. The route response is
     held open by the detached promise's broadcast loop until endJob
     fires res.end() on every subscriber. */
  await runSubsetAnalyzerJob(
    job,
    leased,
    selection,
    phase1Selection,
    leasedToRun,
    allowStage1ShrinkSubset,
  ).catch((e) => console.error('[analysis-subset] subset job rejected', e));
  if (job.ended) await job.settled;
  };
  if (!record.bookId) {
    void startSubset(null).catch((e) => console.error('[analysis-subset] subset job failed', e));
    return;
  }
  let registered;
  try {
    registered = await runBookJob(record.bookId, 'analysis', startSubset);
  } catch (e) {
    console.error('[analysis-subset] job registration failed', e);
    send({ kind: 'error', code: 'lock-contention', message: requestFailureMessage(e, 'Could not start the analysis.') });
    clearInterval(keepAlive);
    return res.end();
  }
  if (registered === BOOK_GONE) {
    send({ kind: 'error', code: 'book_not_found', message: 'Book not found.' });
    clearInterval(keepAlive);
    return res.end();
  }
  registered.done.catch((e) => console.error('[analysis-subset] subset job failed', e));
});

/* Detached subset-retry analyzer body. Extracted from the request
   handler in plan 32 D1 so the work survives a client disconnect
   (sticky semantics). Broadcasts every event to job.subscribers and
   tracks replay state via trackForReplay; endJob handles teardown +
   map deregistration on every exit path. */
export async function runSubsetAnalyzerJob(
  job: AnalysisJob,
  record: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>,
  selection: AnalyzerSelection,
  phase1Selection: AnalyzerSelection,
  toRun: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>['chapterHints'],
  allowStage1ShrinkSubset: boolean,
): Promise<void> {
  const manuscriptId = job.manuscriptId;
  /* D1 (#3169) — analyzerLabel / lastStep hoisted ahead of the try below,
     same rationale as the main job's runMainAnalyzerJob: the catch at the
     end of this function reads them, and the try now wraps this job's own
     ~135-line setup span (fs-2 language resolution through isAborted),
     not just the body that follows it. Neither's initial value changes by
     moving the declaration up.
     F7 (#3169 fix wave) — restoring context the hoist dropped: `lastStep`
     is a breadcrumb of the most recent phase milestone — mirrored to the
     server log (so a stall's last server-log line names where it wedged)
     and folded into the fatal-error log below (so a failure names the
     phase it died in, not a bare stack). The 2026-06-06 ch12 incident
     surfaced only as "sentences.map is not a function" with no
     phase/chapter context. */
  const analyzerLabel = engineLabel(selection.engine, selection.model);
  /* #3435 — hoisted for the terminal catch, as in the main route. */
  let phase1TerminalLabel: string | undefined;
  let lastStep = 'init';
  /* #4031 (Task 24, N2) — a Phase-0a snapshot's cache patch that faulted (it can carry
     a re-mint: decisions plus the takes' remap, which no later patch repeats). It is
     re-sent once, on its own, before the job's next Phase-0a snapshot, after the
     Phase-0a loop (before any finalise write or gate exit), and in the terminal catch
     (a pause or failure during Phase 0a). A re-send that fails too is logged. Hoisted
     for the catch. */
  let pendingCachePatch: CachePatch | undefined;
  const flushPendingCachePatch = async (): Promise<void> => {
    if (!pendingCachePatch) return;
    const p = pendingCachePatch;
    pendingCachePatch = undefined;
    await resendCachePatch(manuscriptId, p);
  };

  try {
    /* fs-2 — book language for the analyzer preamble + Cyrillic token estimate.
       Task 6c: same contract as the main job — a *located* book that never
       declared a language throws BookLanguageUnsetError here (not a silent 'en'),
       which this detached subset body surfaces as an SSE `error` with code
       `language_unset` (no filesystem path in the body). */
    let bookLanguage: string;
    try {
      bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);
    } catch (e) {
      if (e instanceof BookLanguageUnsetError) {
        endJob(job, { kind: 'error', code: 'language_unset', message: (e as Error).message });
        return;
      }
      throw e;
    }
    /* #938 Layer A — resolve the byline author + strip title-page/e-library
       boilerplate from each chapter body BEFORE the model sees it. Mutates the
       cached record's hints in place; the analysis run itself never writes them
       to disk, but a later restructure persists whatever bodies the record holds
       to manuscript-hints.json (#3703), stripped ones included. Harmless: the
       strip is idempotent, so a hydrate that returns stripped bodies and a re-run
       over them change nothing. */
    const bookAuthor = await resolveBookAuthorForManuscript(manuscriptId);
    for (const ch of record.chapterHints) {
      ch.body = stripFrontMatterBoilerplate(ch.body, { author: bookAuthor, title: record.title });
    }
    const abortController = job.controller;
    const analyzer = selection.analyzer;
    /* #3084 P30 — mutable, reassigned together on a fallback switch (stage1Call.onFallback
       below), so every later chunk budget reflects the target. job.engine does not follow it alone:
       setPhaseEngine records this phase's engine and re-derives job.engine from both phases
       (whoever holds a card wins). */
    let subsetModelId = selection.model;
    let subsetEngine: AnalysisEngine = selection.engine;
    setPhaseEngine(job, 0, selection.engine);
    /* Plan 118 — Phase 1 (attribution) analyzer for the subset retry; equals
       `selection` when no split is configured. */
    const phase1Analyzer = phase1Selection.analyzer;
    const phase1AnalyzerLabel = engineLabel(phase1Selection.engine, phase1Selection.model);
    phase1TerminalLabel = phase1AnalyzerLabel;
    let phase1ModelId = phase1Selection.model;
    /* #3084 P30 — reassigned together with phase1ModelId on a fallback switch. */
    let phase1Engine: AnalysisEngine = phase1Selection.engine;
    setPhaseEngine(job, 1, phase1Selection.engine);
    if (selection.engine === 'local' || phase1Selection.engine === 'local') job.ollamaServed = true;
    /* srv-59 Task 9b — ONE escalation-window budget shared across every
       chapter's attributeChapterStage2 call in this subset/retry job, mirroring
       the main route's per-book budget above. */
    const structureBudget = { remainingWindows: configValue<number>('analyzer.structure.maxWindowsPerBook') };
    /* srv-59 Task 9b (review follow-up) — build the 'cloud' escalation
       analyzer ONCE for this subset/retry job, mirroring the main route. */
    const escalationAnalyzer =
      configValue<string>('analyzer.structure.escalation') === 'cloud' ? buildCloudEscalationAnalyzer() : undefined;

    const send = (payload: unknown) => {
      const stamped = withRunEngine(job, payload);
      broadcastToJob(job, stamped);
      trackForReplay(job, stamped);
    };
    const log = (phaseId: number, message: string) => {
      send({ kind: 'log', phaseId, message });
      lastStep = `phase=${phaseId} ${message}`;
      console.log(`[analysis-subset] mns=${manuscriptId} ${lastStep}`);
    };

    /* Throttled LLM heartbeat. The subset (per-chapter Re-analyse) path
       previously wired only onThrottle on its analyzer calls — NO onWaiting /
       onChunk — so during a 60-90s Gemini phase it emitted nothing, the global
       pill's `activeStream.lastTickAt` aged past the 8s cloud stall threshold,
       and a working re-analyse falsely read as "Stalled" (the main job emits
       these; the subset job didn't). onWaiting (500ms wall-clock from gemini.ts)
       keeps the pill fresh even between Gemini chunks; onChunk carries real
       model-output progress. Both funnel through the shared throttled emitter
       (analysis-heartbeat.ts), and the analysis-stream middleware bumps
       lastTickAt off each. */
    const emitHeartbeat = makeThrottledHeartbeat(send, HEARTBEAT_EVENT_THROTTLE_MS);

    /* Preserve designed-voice links across a subset re-analysis (#518) — snapshot
       the existing cast before any interim write clobbers cast.json. */
    const priorSnapshot = record.bookDir
      ? await readPriorCastForMerge(record.bookDir)
      : { rows: [], source: 'none' as const };
    let priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = priorSnapshot.rows;

    /* Used inside the persist guards below in place of the old `clientGone`
       flag. The detached job survives the original requester disconnecting,
       but it still respects an explicit /pause via abortController.signal —
       a paused retry shouldn't keep writing cast.json out from under the
       user's hands. */
    const isAborted = (): boolean => abortController.signal.aborted;

    /* Plan 291 cache lifecycle (#4031, A22) — classified FIRST, before the
       load-rules save and the run start. A non-empty cache without the current
       version holds seeded rows and unplanned takes; a subset run cannot rebuild
       the rest of the book from it, so (owner, 2026-11-06) it stops here with
       `analysis_cache_legacy` before writing anything. */
    const cache: AnalysisCache = await loadAnalysisCache(manuscriptId);
    if (classifyAnalysisCache(cache) === 'legacy') {
      log(0, 'Saved analysis progress is from an older version — refusing the chapter re-analysis.');
      endJob(job, { kind: 'error', code: 'analysis_cache_legacy', message: ANALYSIS_CACHE_LEGACY_MESSAGE });
      return;
    }
    /* Every non-legacy cache this job holds is version 2; the first write creates
       the file on an empty book. */
    cache.version = ANALYSIS_CACHE_VERSION;
    await mutateAnalysisCache(manuscriptId, { createIfAbsent: true, version: ANALYSIS_CACHE_VERSION });
    /* #3435 S0 — the main route's M0/M1, book-wide. */
    if (applyAnalysisLoadRules(cache, record.chapterHints)) {
      await mutateAnalysisCache(manuscriptId, { fields: cacheFields(cache, PHASE1_RECORD_FIELDS) });
    }
    /* ── Run start (plan 291, #4031), as in the main job: the stale-link prune, the
       identical-name heal and a Re-parse carryover are written to cast.json under
       the cast lock, the heal's retirements recorded (`heal`) after it. A stopped
       main run's `addedRows` entries are refreshed for the rows it writes. */
    priorCastForMerge = await materialiseRunStartPrior({
      job,
      record,
      cache,
      prior: priorCastForMerge,
      log,
    });
    /* R2 (invariant 6) — the subset job's OWN rule-11 ledger for the rows it adds,
       in memory only, and the suggestion pairs its snapshots added. It starts at
       the Phase-0a snapshot; `cache.addedRows` stays the main run's. */
    let subsetLedgers: { own: RunAddedLedger; ownPairs: Array<[string, string]> } = { own: {}, ownPairs: [] };
    /* #3435 hint snapshot — the chapter hints as they stood at load. The
       exclude toggle replaces the whole cached record via `putManuscript`
       (book-state.ts) and leaves the object `record` points at alone, but a
       store re-read mid-run would see the new record, so the cast gate,
       coverage, the roll, the stitch and the result gate (S14) read this copy:
       one run judges one chapter set. */
    const hints = record.chapterHints.map((h) => ({ ...h }));
    /* #3435 O2 — read at load: a book past Confirm (cast confirmed, or an
       authoritative persist since the cache was last cleared) always passes
       the result gate, since decision F never demotes it. A state.json that
       belongs to another manuscript (a stale path) counts as not confirmed. */
    const loadDir = liveBookDir(job);
    const loadState = loadDir ? await readStateJsonWithRecovery(stateJsonPath(loadDir)).catch(() => null) : null;
    const bookReachedConfirm = reachedConfirm(loadState?.manuscriptId === manuscriptId ? loadState : null, cache);
    const chapterCast: Record<number, CharacterOutput[]> = cache.chapterCast ?? {};
    const cachedChapters = cache.chapters ?? {};
    /* The subset route serves two flows: (a) un-exclude an
       excluded chapter from a finished book (Phase 0a + Phase 1
       attribution land here), (b) retry a chapter that failed Phase
       0a in a still-paused run (cast_incomplete gate). They have
       different needs:
       - (a) main pipeline is finished; subset attributes the new
         chapter and emits a fresh result (only if every other chapter
         has a current take, or the book is past Confirm — S14 below).
       - (b) main pipeline never ran Phase 1; subset must NOT
         attribute piecemeal because the global cast may still grow
         (the user could retry more chapters next) and Phase 1's
         folding/lines/scenes pass needs the whole sentence set.
       The clean signal: did cache.stage1 exist BEFORE this batch?
       Yes → flow (a). No → flow (b); skip Phase 1, end `resume_required`
       after cast-update so the analysing view's auto-resume kicks the
       full /analysis/stream which runs Phase 1 globally (S8). */
    const stage1Existed = !!cache.stage1;

    /* ── Phase 0a (subset). Re-run cast detection only for the targeted
       chapters. The running roster passed into each prompt is rebuilt
       from cache.chapterCast each iteration so the model sees every
       character we've already found — same merge contract as the full
       route. */
    log(
      0,
      `Re-analyzing ${toRun.length} chapter${toRun.length === 1 ? '' : 's'} via ${analyzerLabel}.`,
    );
    send({
      kind: 'phase',
      phaseId: 0,
      progress: 0.02,
      label: PHASES[0].label,
      model: subsetModelId,
    });

    /* Same series-cast prior the main route uses (C2). Resolved once
       per subset retry so the prompt still recognises series-regulars
       even on a one-chapter un-exclude re-analysis. */
    let subsetSeriesPrior: SeriesPriorCharacter[] = [];
    if (record.bookId) {
      try {
        const siblings = await scanSeriesCharactersForBookId(record.bookId);
        const merged = dedupSeriesPrior(siblings);
        subsetSeriesPrior = merged.map((m) => ({
          id: m.id,
          name: m.name,
          aliases: m.aliases,
          description: m.description,
          fromBookTitles: m.fromBookTitles,
        }));
      } catch (priorErr) {
        console.warn('[analysis-subset] series prior scan failed:', priorErr);
      }
    }

    const rebuildRoster = (): Map<string, CharacterOutput> => {
      const r = new Map<string, CharacterOutput>();
      for (const ch of record.chapterHints) {
        const cast = chapterCast[ch.id];
        if (cast?.length) {
          /* #938 Layer B — keep the byline author out of every roster build
             (covers cached chapterCast too, unlike guarding only fresh writes).
             Framed author's-note chapters keep the author. */
          const guarded = dropBylineAuthorFromChapter(cast, {
            author: bookAuthor,
            chapterTitle: ch.title,
          });
          mergeRosterChapter(r, guarded.characters);
        }
      }
      return r;
    };
    const emitCastUpdate = (): void => {
      const roster = rebuildRoster();
      const folded = previewFoldForLiveView(Array.from(roster.values()), bookLanguage, EMPTY_DEDUP_CONSTRAINTS);
      send({ kind: 'cast-update', characters: folded });
    };

    for (let idx = 0; idx < toRun.length; idx++) {
      const ch = toRun[idx];
      log(0, `Chapter ${ch.id} — ${ch.title}: detecting cast…`);
      /* Per-chapter try/catch mirrors the full route at analysis.ts:887 —
         one failed chapter in a batch retry shouldn't abort the rest of
         the batch. On success we also clear the id from
         cache.failedChapterIds so the analysing view's Retry row
         disappears on reload. */
      /* srv-61 — lift the per-chapter opts into a named StageCall so the SAME
         object is handed to both the runner (analyzer.runStage1Chapter) and
         withPassEval, whose fresh-per-call accumulator attaches to it. Without
         this a retried chapter's stage-1 chat() sub-calls emit no eval-rate
         record. Mirrors the main route's castCall wiring. */
      const stage1Call: StageCall = {
        signal: abortController.signal,
        language: bookLanguage,
        onWaiting: () => emitHeartbeat(0, ch.id),
        onChunk: (info) => emitHeartbeat(0, ch.id, info),
        onThrottle: (waitMs, reason) => {
          send({
            kind: 'throttle',
            phaseId: 0,
            chapterIndex: ch.id,
            model: subsetModelId,
            waitMs,
            reason,
          });
        },
        /* #3084 P30 — the primary went unreachable → switched to the configured target.
           Re-label so later events read the reassigned subsetModelId/subsetEngine, persist
           job.engine, and mark the target busy only now (never at job start). */
        onFallback: ({ reason }) => {
          if (selection.fallbackModel && selection.fallbackEngine) {
            subsetModelId = selection.fallbackModel;
            subsetEngine = selection.fallbackEngine;
            setPhaseEngine(job, 0, subsetEngine);
            markFallbackActive(job, selection.fallbackModel);
          }
          console.log(`[analysis-subset] ${manuscriptId}: ${reason}`);
        },
      };
      try {
        const result = await withPassEval(
          stage1Call,
          {
            manuscriptId,
            bookTitle: record.title ?? null,
            stage: 'stage1-ch',
            chapterId: ch.id,
          },
          () =>
            runStage1Guarded({
              body: ch.body,
              runningRoster: Array.from(rebuildRoster().values()),
              chapterId: ch.id,
              log,
              language: bookLanguage,
              call: () =>
                runStage1ChapterChunked({
                  body: ch.body,
                  charBudget: resolveStage1ChunkCharBudget(
                    // #3084 P30 — the active selection: a chapter dispatched after a switch is sized for the target.
                    resolveCapacity({ engine: subsetEngine, model: subsetModelId }),
                    ch.body,
                    // #1691 — roster-aware reservation, mirroring the full route.
                    Array.from(rebuildRoster().values()),
                  ),
                  mergeRosters: mergeRosterChapter,
                  onChunk: (sec) =>
                    log(
                      0,
                      `Chapter ${ch.id} cast — large chapter, section ${sec.index + 1}/${
                        sec.total
                      } (${sec.chars.toLocaleString()} chars) to fit the model context…`,
                    ),
                  callForBody: (subBody) =>
                    analyzer.runStage1Chapter(
                      manuscriptId,
                      ch.id,
                      buildStage1ChapterInbox(
                        manuscriptId,
                        record.title,
                        { ...ch, body: subBody },
                        Array.from(rebuildRoster().values()),
                        subsetSeriesPrior,
                        bookAuthor,
                      ),
                      { ...stage1Call, inputBody: subBody },
                    ),
                }).then((r) => ({ characters: r.characters })),
            }),
          () => null,
        );
        chapterCast[ch.id] = result.characters;
        cache.chapterCast = chapterCast;
        /* #3435 S3/S4 — Phase 0 fixes only the CAST. With stage1 on disk this
           Retry goes on to attribute the chapter, so a cast record becomes an
           attribution record and stays until its Phase 1 completes (a Phase 1
           that then fails must not leave the chapter looking resolved). With no
           stage1 there is no Phase 1 in this run: clear the cast record now and
           announce it. An attribution record is never cleared here. */
        let wasFailed = false;
        if (stage1Existed) promoteCastRecordToAttribution(cache, ch.id);
        else wasFailed = clearFailedChapterId(cache, ch.id, 'cast');
        /* #4031 — a field-scoped patch, as in the main job's Phase 0a. */
        await mutateAnalysisCache(manuscriptId, { fields: cacheFields(cache, SUBSET_PHASE0_FIELDS) });
        /* Emit chapter-resolved so the analysing view's Retry row clears
           in real time. The view used to rely on the next book-state
           fetch (or on the .then() handler in the FE retry promise) to
           hide the row, which left visible stale state during the
           seconds between Phase 0a success and the route returning. */
        if (wasFailed) send({ kind: 'chapter-resolved', chapterId: ch.id });
        /* Plan 291 (#4031) — the Phase-0a snapshot writes only rows the CACHED
           plan already decides: a row the plan has not settled keeps its raw
           analyzer id, which must never reach disk. A decided row that is not on
           disk is added with 0 lines unless its ledger entry says the user deleted
           it (R4); a run row a completed persist fold-dropped is not decided any
           more, because the persist drops its decision with it (PR #4103 pass 1
           F3). The first such write starts the subset's own ledger. No cached
           plan (flow (b), or an unplanned cache) - the live view only. Skipped on
           abort: a paused retry shouldn't keep writing cast.json out from under
           the user. */
        const cachedPlan = cache.matchPlan;
        if (record.bookDir && cachedPlan && !isAborted()) {
          const covered = Array.from(rebuildRoster().values()).filter((c) => Object.hasOwn(cachedPlan.decisions, c.id));
          if (covered.length > 0) {
            const prior = priorCastForMerge as PriorRow[];
            await flushPendingCachePatch();
            const snap = await snapshotPlannedRoster({
              job,
              bookId: record.bookId ?? undefined,
              bookLanguage,
              cache,
              prior,
              plan: cachedPlan,
              characters: applyMatchPlan(covered, cachedPlan, prior).characters,
              ledgers: { kind: 'subset', ...subsetLedgers },
              runSuggestions: () => [],
              placeholderIds: new Set<string>(), // covered rows only: each is on disk with its counts
              bestEffortPatch: true,
              site: 'subset Phase-0a',
            });
            if (snap.ledgers.kind === 'subset') subsetLedgers = { own: snap.ledgers.own, ownPairs: snap.ledgers.ownPairs };
            if (snap.unsentPatch) pendingCachePatch = snap.unsentPatch;
          }
        }
        log(
          0,
          `Chapter ${ch.id} cast — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'} detected.`,
        );
        emitCastUpdate();
      } catch (chErr) {
        if (chErr instanceof AnalysisAbortedError) throw chErr;
        /* #4031 R2-M3 — the Phase-0a snapshot found a damaged cast.json: whole-book-fatal. */
        if (chErr instanceof PriorCastUnreadableError) throw chErr;
        /* Whole-book-fatal content-filter block — rethrow to the terminal
           handler rather than grinding chapter-by-chapter (see the main-loop
           sibling above). */
        if (chErr instanceof GeminiContentBlockedError) throw chErr;
        /* #3084 P20/F7 — whole-book-fatal reasoning overflow; see the main
           route. `ch` is in scope here the same way. */
        if (noteReasoningOverflow(job, structureBudget, chErr, { id: ch.id, title: ch.title }, 0)) throw chErr;
        chapterCast[ch.id] = [];
        cache.chapterCast = chapterCast;
        const classified = classifyAnalysisFailure(chErr, analyzerLabel);
        const castRecord = recordFailedChapter(cache, ch.id, classified, 'cast');
        await patchCacheInFailureCatch(manuscriptId, { fields: cacheFields(cache, SUBSET_PHASE0_FIELDS) }, ch.id);
        log(0, `❌ Chapter ${ch.id} cast FAILED — ${ch.title}: ${(chErr as Error).message}`);
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: castRecord.message,
          code: castRecord.code,
          remediation: castRecord.remediation,
          phase: castRecord.phase,
        });
        emitCastUpdate();
      }
      send({
        kind: 'phase',
        phaseId: 0,
        progress: 0.02 + 0.93 * ((idx + 1) / toRun.length),
        label: PHASES[0].label,
        model: subsetModelId,
      });
    }

    /* Finalise stage1: rebuild the roster, sort + verify, and refresh the
       cache.stage1 entry so subsequent runs (or a full-book resume) see
       the merged roster.

       BUT only when every chapter cast is in. If `cache.failedChapterIds`
       still has entries after this batch (e.g. user retried 1 of 3
       failed chapters), stage1 is a PARTIAL roster — writing it would
       short-circuit the main /analysis/stream's Phase 0a resume path
       and let Phase 1 run against the partial roster. Leave stage1
       unset in that case; the main route's [[cast_incomplete]] gate
       will re-run Phase 0a once the user kicks it. */
    /* #4031 N2 — before any finalise write or gate exit. */
    await flushPendingCachePatch();
    const finalRoster = rebuildRoster();
    const rawCharacters = Array.from(finalRoster.values());
    sortEvidence(rawCharacters);
    const verified = verifyEvidenceAgainstSource(rawCharacters, record.sourceText, (msg) =>
      log(0, msg),
    );
    const characters = dropEvidencelessCast(rawCharacters, (msg) => log(0, msg), record.sourceText);
    /* The RAW roster: what `cache.stage1` holds (plan 291 - the plan is stored
       beside it). Phase 1 runs on the plan-applied `stage1` below. */
    const rawStage1: Stage1Output = {
      characters,
      chapters: record.chapterHints.map((c) => ({ id: c.id, title: c.title })),
    };
    /* #3435 — only CAST failures gate Phase 1 and the stage1 rewrite: an
       attribution record (a chapter whose own Phase 1 failed or was flagged)
       says nothing about the roster, and an excluded chapter's record is
       never a reason to stop. */
    const remainingFailedCastIds = castFailedChapterIds(cache, hints);
    /* Coverage gate (in addition to the no-failed-chapters check) — stage1
       is finalised only when EVERY non-excluded chapter has a chapterCast
       entry. Without this guard a sparse cache (chapters 1–N
       run, chapters N+1.. untouched) would let rebuildRoster() produce a
       partial roster that overwrites a richer existing stage1. See the
       comment on isPhase0aCoverageComplete for the regression that
       motivated this gate. */
    const coverage = isPhase0aCoverageComplete(chapterCast, hints, remainingFailedCastIds);
    let coverageIncompleteMessage: string | undefined;
    /* Stage 1 shrink guard — see comment on stage1ShrinkRefused. The
       prior count is captured BEFORE the assignment so a no-op rewrite
       (same count) doesn't trip the gate; only meaningful shrinks do. */
    const subsetPrevStage1Count = cache.stage1?.characters.length ?? 0;
    const subsetNextStage1Count = rawStage1.characters.length;
    if (
      remainingFailedCastIds.length === 0 &&
      coverage.complete &&
      stage1ShrinkRefused(subsetPrevStage1Count, subsetNextStage1Count) &&
      !allowStage1ShrinkSubset
    ) {
      log(
        0,
        `Stage 1 shrink refused — rebuild would drop from ${subsetPrevStage1Count} to ${subsetNextStage1Count} characters. Re-run with allowStage1Shrink:true to confirm.`,
      );
      await mutateAnalysisCache(manuscriptId, { fields: cacheFields(cache, SUBSET_PHASE0_FIELDS) });
      endJob(job, {
        kind: 'error',
        code: 'stage1_shrink_refused',
        message: `Cast finalisation would drop from ${subsetPrevStage1Count} to ${subsetNextStage1Count} characters. Confirm via allowStage1Shrink to accept the smaller roster.`,
        prevCharCount: subsetPrevStage1Count,
        nextCharCount: subsetNextStage1Count,
      });
      return;
    }
    const finalRosterReady = remainingFailedCastIds.length === 0 && coverage.complete;
    if (finalRosterReady) {
      cache.stage1 = rawStage1;
    } else if (remainingFailedCastIds.length === 0 && !coverage.complete) {
      const covered = coverage.totalRequired - coverage.missingChapterIds.length;
      log(
        0,
        `Cast finalisation deferred — ${coverage.missingChapterIds.length} non-excluded chapter${coverage.missingChapterIds.length === 1 ? ' still needs' : 's still need'} Phase 0a detection (${covered}/${coverage.totalRequired} covered). Existing stage1 left intact; run the main analysis to fill the gaps.`,
      );
      coverageIncompleteMessage = `Phase 0a covers ${covered} of ${coverage.totalRequired} chapters — run main analysis to detect the rest before stage1 can finalise.`;
    }
    /* Flow (a) with a final roster settles its identity now (it goes on to Phase 1),
       and its plan patch carries the new stage1. Every other exit saves the raw
       stage1 (flow (b): never planned - the main resume plans it) or none. */
    const planNow = stage1Existed && finalRosterReady;
    await mutateAnalysisCache(manuscriptId, {
      ...(finalRosterReady && !planNow ? { stage1: rawStage1 } : {}),
      fields: cacheFields(cache, SUBSET_PHASE0_FIELDS),
    });
    // #2196 — subset dropped-quotes guarded in mode:'drop' (no stale recreation).
    await withVerifiedBookDir(
      { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
      async (bookDir) => {
        await persistDroppedQuotesBatch(bookDir, manuscriptId, 'analysis-chapters', verified);
      },
    );
    /* Plan 291 (#4031) — flow (a): REUSE the run's cached plan; only rows it does not
       cover are planned (`extendPlan`), saved (Q2) and applied, so one analyzer row
       never gets two cast rows. A cache the main run left unplanned is planned here.
       Phase 1 and everything after speak the plan-applied ids (R29). */
    let stage1: Stage1Output = rawStage1;
    let planConstraints: DedupConstraints = EMPTY_DEDUP_CONSTRAINTS;
    let planProtectIds: ReadonlySet<string> | undefined;
    if (planNow) {
      const planned = await planRunCastIdentity({
        job,
        record,
        bookLanguage,
        cache,
        prior: priorCastForMerge as PriorRow[],
        raw: rawStage1.characters,
        log,
        ownLedger: subsetLedgers,
      });
      subsetLedgers = { own: planned.ownLedger, ownPairs: planned.ownAddedPairs };
      stage1 = { ...rawStage1, characters: planned.characters };
      planConstraints = planned.constraints;
      planProtectIds = planned.protectIds;
    }
    send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage, planConstraints, planProtectIds) });
    send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label, model: subsetModelId });

    /* ── Phase 1 (subset). Sentence attribution for the new chapters only.
       Cached chapters are left alone — their sentences stay in
       cache.chapters as-is.
       Skip Phase 1 entirely when cast is still incomplete — the
       subset route can't safely attribute sentences without a final
       roster, and writing partial sentences to cache.chapters would
       have to be re-done after the next retry batch finalises stage1.
       The main /analysis/stream gate will run Phase 1 for these
       chapters once the user resolves the remaining failures (or fills
       the coverage gap via a full /analysis/stream). */
    if (remainingFailedCastIds.length > 0) {
      log(
        0,
        `Cast retry done. ${remainingFailedCastIds.length} chapter${remainingFailedCastIds.length === 1 ? ' still needs' : 's still need'} a retry before Phase 1 can run.`,
      );
      /* #3435 S5 — a gate exit is an outcome the user must hear about, so it
         ends through endJob with a final event (and the halted snapshot that
         comes with it) instead of a silent end.
         - A target's cast failed again with stage1 on disk: that is a real
           failure of the Retry — report the record Phase 0 just wrote.
         - Otherwise (stage1 absent, or a chapter outside this batch still
           has no cast): a soft stop, `cast_incomplete`, naming the chapters. */
      const failedTarget = stage1Existed
        ? toRun.find((c) => remainingFailedCastIds.includes(c.id))
        : undefined;
      const failedTargetRecord = failedTarget && cache.failedChapterErrors?.[String(failedTarget.id)];
      if (failedTargetRecord) {
        endJob(job, {
          kind: 'error',
          code: failedTargetRecord.code,
          message: failedTargetRecord.message,
          remediation: failedTargetRecord.remediation,
        });
        return;
      }
      const stillNeedCast = remainingFailedCastIds.map(
        (id) => record.chapterHints.find((h) => h.id === id)?.title ?? `chapter ${id}`,
      );
      endJob(job, {
        kind: 'error',
        code: 'cast_incomplete',
        message: castIncompleteMessage(stillNeedCast),
      });
      return;
    }
    if (!coverage.complete) {
      /* #3435 S6 — same: a soft stop through endJob, today's message. */
      endJob(job, { kind: 'error', code: 'cast_incomplete', message: coverageIncompleteMessage });
      return;
    }
    /* Retry-after-cast-incomplete flow: the main pipeline hasn't run
       Phase 1 globally, so attributing JUST `toRun` here would emit a
       result with only those chapters' sentences and the view's
       onComplete would advance to the confirm screen with a near-empty
       book. #3435 S8 — end through endJob with `resume_required` (a soft
       stop, with the halted snapshot that comes with it) instead of a
       silent end: an armed client auto-resumes /analysis/stream, which
       discovers cache.stage1 is set and runs Phase 1 across every chapter;
       any other client shows the needs-action line. */
    if (!stage1Existed) {
      log(
        0,
        'All cast detection retries succeeded — resuming full analysis to run Phase 1 globally.',
      );
      endJob(job, {
        kind: 'error',
        code: 'resume_required',
        message: resumeRequiredAfterCastMessage(toRun.map((c) => c.title)),
      });
      return;
    }
    send({
      kind: 'phase',
      phaseId: 1,
      progress: 0.02,
      label: PHASES[1].label,
      model: phase1ModelId,
    });
    /* srv-59 Task 11 — every freshly-attributed chapter's structureReport
       this subset pass produces, rolled up into `analysisProvenance.report`
       at the persist site below (mirrors the main route's accumulator).
       Only chapters actually re-run here (`toRun`) can contribute — a
       subset retry never touches other chapters' cached sentences. */
    const subsetStructureReports: EngineReport[] = [];
    /* #4031 (R39) — the takes this subset pass produced, by chapter: the only chapters its
       per-chapter roll replaces. */
    const subsetProduced = new Map<number, SentenceOutput[]>();
    /* #2267 — mirrors the main route's `perChapterMaxMergedTurns`: computed
       up front from EVERY non-excluded chapter's text + the book's resolved
       language, independent of whether the structure engine ran for a given
       chapter (see the main route's matching comment / design of record §4).
       Deliberately over `record.chapterHints`, NOT `toRun`: this is a
       book-level reading, and a subset retry only reprocesses the chapters it
       targets — computing over `toRun` alone would let a re-analysis of one
       clean chapter silently overwrite a high reading left by every OTHER
       chapter with that chapter's own low one (#2275 C2). Computing it this
       way also keeps it decoupled from the `analyzer.structure.enabled` knob,
       the same as the main route. #2275 C4 — one `merged=` line per chapter
       with a defined reading, emitted HERE (mirrors the main route) so a
       subset re-run — including a clean chapter never re-attributed by the
       engine this pass — still names a breaching chapter in the operator
       log. `scope=book` marks the line as a book-wide reading, not
       per-chapter pass progress — this loop runs over every chapter in the
       book while `chaptersCovered` (below) reports only `toRun.length`, so
       without the marker a "re-analyse one chapter" run prints one
       `merged=` line per book chapter against a one-chapter progress line
       and reads as false progress. Skipped entirely for a language with no
       dash convention (`n === undefined`), same as the main route. */
    const subsetLegibilityConventions = conventionsFor(bookLanguage);
    const subsetPerChapterMaxMergedTurns: Array<number | undefined> = record.chapterHints
      .filter((c) => !c.excluded)
      .map((c) => {
        const n = subsetLegibilityConventions
          ? measureChapterLegibility(c.body, subsetLegibilityConventions)
          : undefined;
        if (n !== undefined) {
          console.log(`[analysis:structure] ch=${c.id} scope=book merged=${n}`);
        }
        return n;
      });
    for (let idx = 0; idx < toRun.length; idx++) {
      /* #3084 P20 — no further chapter after an escalation overflow; the throw
         reaches this job's terminal catch, as a rethrown overflow does. */
      throwIfReasoningOverflowed(job);
      const ch = toRun[idx];
      log(1, `Chapter ${ch.id} — ${ch.title}: attributing sentences via ${phase1AnalyzerLabel}…`);
      /* #528 — use the same resilient runner as the main route: coverage guard
         + large-chapter chunking. The subset (Re-analyse) path previously made
         a bare runStage2Chapter call with no guard and no chunking, so a large
         chapter (The Drowning Bell ch19, 507 sentences) truncated mid-JSON, threw,
         and discarded the whole job — the reported failure. */
      let chapterSentences: SentenceOutput[];
      let subsetCoverageVerdict: Stage2CoverageVerdict;
      let subsetChunkCount: number;
      let subsetStructureReport: EngineReport | undefined;
      /* #3435 — a word-free chapter makes no call (see the main route). */
      const wordFree = !hasAttributableContent(ch.body);
      if (wordFree) log(1, `Chapter ${ch.id} — no words to attribute.`);
      try {
        ({
          sentences: chapterSentences,
          coverage: subsetCoverageVerdict,
          chunkCount: subsetChunkCount,
          structureReport: subsetStructureReport,
        } = wordFree ? wordFreeStage2Result() : await attributeChapterStage2WithEval({
          analyzer: phase1Analyzer,
          manuscriptId,
          title: record.title,
          stage1,
          /* R29 — the prompt dedup speaks the plan's ids, as the main job's does. */
          dedupConstraints: planConstraints,
          chapter: ch,
          // #3084 P30 — the active selection, so a chapter dispatched after a switch is sized for the target.
          capacity: resolveCapacity({ engine: phase1Engine, model: phase1ModelId }),
          structureBudget,
          escalationAnalyzer,
          stageCall: {
            signal: abortController.signal,
            language: bookLanguage,
            /* #3084 P20/F7 — escalation overflow hook; see the main route's
               stage2Call. `ch` is in scope (`const ch = toRun[idx];`, the
               same loop the "Subset route, Phase 1" dispatch-check bullet
               above adds throwIfReasoningOverflowed(job) to). */
            onReasoningOverflow: (err) => noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }, 1),
            onWaiting: () => emitHeartbeat(1, ch.id),
            onChunk: (info) => emitHeartbeat(1, ch.id, info),
            /* #3084 P30 — the primary went unreachable → switched to the configured target. */
            onFallback: ({ reason }) => {
              if (phase1Selection.fallbackModel && phase1Selection.fallbackEngine) {
                phase1ModelId = phase1Selection.fallbackModel;
                phase1Engine = phase1Selection.fallbackEngine;
                setPhaseEngine(job, 1, phase1Engine);
                markFallbackActive(job, phase1Selection.fallbackModel);
              }
              console.log(`[analysis-subset] ${manuscriptId}: ${reason}`);
            },
            onThrottle: (waitMs, reason) => {
              send({
                kind: 'throttle',
                phaseId: 1,
                chapterIndex: ch.id,
                model: phase1ModelId,
                waitMs,
                reason,
              });
            },
          },
          onCoverageRetry: (attempt, verdict) =>
            log(
              1,
              `Chapter ${ch.id} — attribution coverage check failed (${
                verdict.issues[0] ?? 'coverage'
              }); re-analysing (attempt ${attempt}).`,
            ),
          onCoverageExhausted: (attempts, verdict) =>
            log(
              1,
              `Chapter ${ch.id} — the same attribution failure reproduced exactly on attempt ` +
                `${attempts} (${verdict.issues[0] ?? 'coverage'}); this section fails ` +
                `deterministically, so re-running the same prompt cannot help. Halting the retries; ` +
                `a re-split follows unless the section is indivisible or already at the split-depth limit.`,
            ),
          onDeterministicSplit: ({ parts, chars, depth }) =>
            log(
              1,
              `Chapter ${ch.id} — re-attributing a ${chars.toLocaleString()}-char section as ` +
                `${parts} smaller ones (split depth ${depth}).`,
            ),
        }));
      } catch (err) {
        /* #3084 P20/F7 — mark the job with the chapter that was calling the
           model, then rethrow: the subset route has no other catch, so this
           reaches the terminal classifyAnalysisFailure call the same way an
           un-marked throw always has. noteReasoningOverflow is a no-op (and
           the chapter is not recorded) for any other error. */
        noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }, 1);
        /* #3435 S11 — record the chapter's failure (guarded save, chapter-failed)
           BEFORE the rethrow, so the Retry's row survives a reload and the view
           hears about it; mirrors the main route's M10 recording. An abort is the
           user pausing, not a failure of the chapter. The terminal failure names
           the model that made this call. */
        if (!(err instanceof AnalysisAbortedError)) {
          job.failingPhase ??= 1;
          const classified = classifyAnalysisFailure(err, phase1AnalyzerLabel, {
            chapter: { id: ch.id, title: ch.title },
          });
          const attributionRecord = recordFailedChapter(cache, ch.id, classified, 'attribution');
          /* #4031 item 8 — a field-scoped patch, as in the main job's Phase 1. */
          await patchCacheInFailureCatch(manuscriptId, { fields: cacheFields(cache, PHASE1_RECORD_FIELDS) }, ch.id);
          send({
            kind: 'chapter-failed',
            chapterId: ch.id,
            message: attributionRecord.message,
            code: attributionRecord.code,
            remediation: attributionRecord.remediation,
            phase: attributionRecord.phase,
          });
        }
        throw err;
      }
      if (subsetChunkCount > 1) {
        log(
          1,
          `Chapter ${ch.id} — attributed in ${subsetChunkCount} sections.`,
        );
      }
      /* C4 on-box acceptance (#2325/#2342) parity with the main route's
         equivalent log line above — see that block's own comment. */
      /* `subsetLegibilityConventions?.dialogueOpen` checked here too, same
         reasoning as the main route's equivalent block: it's provably
         equivalent to the `dialogueOpen` that made `narratedSpeech`
         non-null, so this lets the type checker prove `sourceHalves` below
         is always a number rather than leaving a `?? '?'` fallback for a
         null that can't occur. */
      if (subsetCoverageVerdict.narratedSpeech && subsetLegibilityConventions?.dialogueOpen) {
        const ns = subsetCoverageVerdict.narratedSpeech;
        const sourceHalves = sourceSpeechHalfCount(ch.body, subsetLegibilityConventions.dialogueOpen);
        log(
          1,
          `Chapter ${ch.id} — narrated-speech check: ${ns.narrated}/${ns.speechHalves} spoken lines ` +
            `attributed to the narrator (${ns.pct.toFixed(1)}%)${
              ns.evaluable
                ? ''
                : ` — attributed population below the ${STAGE2_MIN_SPEECH_HALVES}-line floor, too small to judge`
            }; source has ${sourceHalves} dash-opening speech lines.`,
        );
      }
      /* #2342 review round 3 — item 4. The subset (Retry) job's stage-2 loop
         used to discard `coverage` entirely: a chapter whose Phase 0 (cast)
         step succeeded already had `clearFailedChapterId` called on it above
         (before Phase 1 attribution even ran), so a chapter that collapses
         again on retry came back "clean" with nothing re-flagging it — even
         though the `attribution-collapse` remediation copy the user acted on
         is what told them to press Retry in the first place. Evaluate and
         re-report the SAME way the main route does, so a still-broken
         chapter is still reported broken, not silently marked resolved. */
      if (!subsetCoverageVerdict.ok) {
        console.warn(
          `[analysis-subset] chapter ${ch.id} stage2 coverage SUSPECT after retries: ${subsetCoverageVerdict.issues.join(' ')}`,
        );
        const subsetFailureCode = selectStage2FailureCode(subsetCoverageVerdict);
        log(
          1,
          subsetFailureCode === 'attribution-collapse'
            ? `Chapter ${ch.id} — ⚠ the cast was not used (${
                subsetCoverageVerdict.issues[0] ?? 'dialogue collapse'
              }); kept the best take and flagged the chapter for retry.`
            : `Chapter ${ch.id} — ⚠ attribution may be incomplete (${
                subsetCoverageVerdict.issues[0] ?? 'low coverage'
              }); kept the best take and flagged the chapter for retry.`,
        );
        const subsetCopy = FAILURE_REMEDIATIONS[subsetFailureCode];
        const subsetRecord = recordFailedChapter(
          cache,
          ch.id,
          {
            code: subsetFailureCode,
            userMessage: subsetCopy.userMessage,
            remediation: subsetCopy.remediation,
          },
          'attribution',
        );
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: subsetRecord.message,
          code: subsetRecord.code,
          remediation: subsetRecord.remediation,
          phase: subsetRecord.phase,
        });
      } else if (clearFailedChapterId(cache, ch.id, 'attribution')) {
        /* #3435 S9 — a clean Phase-1 completion resolves an attribution record
           (a collapse flag, a Phase-1 throw an earlier run recorded, or a cast
           record Phase 0 promoted above). A cast record is left for Phase 0 to
           clear. */
        send({ kind: 'chapter-resolved', chapterId: ch.id });
      }
      /* #3435 S9/S10 — the subset attributes only on a final roster (stage1
         existed), so the take is current; it is written after the last
         authoritative persist. */
      setPendingAttribution(cache, ch.id, false);
      cache.takesPersisted = false;
      for (const s of chapterSentences) s.chapterId = ch.id;
      cachedChapters[ch.id] = chapterSentences;
      subsetProduced.set(ch.id, chapterSentences);
      if (subsetStructureReport) subsetStructureReports.push(subsetStructureReport);
      cache.chapters = cachedChapters;
      /* #4031 (item 8, R33/R34) — a field-scoped patch of this chapter's take, resolved
         inside the cache op, as in the main job: a merge or decision the user made
         mid-run, which re-targets the cached plan and takes, is never reverted. The
         take is already in plan-applied ids (the finalise applied the plan), so there
         is no re-mint map. */
      const priorIds = new Set(priorCastForMerge.map((r) => r.id));
      const addedIds = planAddedIds(cache.matchPlan);
      await mutateAnalysisCache(
        manuscriptId,
        chapterTakeCachePatch({
          chapterId: ch.id,
          takes: chapterSentences,
          remint: {},
          fields: cacheFields(cache, PHASE1_RECORD_FIELDS),
          bookDir: liveBookDir(job) ?? undefined,
          priorIds,
          addedIds,
        }),
      );
      /* Roll a partial manuscript-edits.json after each chapter completes, so a
         LATER chapter's failure no longer discards the chapters that already
         succeeded (#528 — pre-fix the subset route only wrote edits once at the
         very end). Mirrors the main route's per-chapter persist. */
      if (record.bookDir) {
        try {
          /* #2196 — subset rolling manuscript-edits: guard in mode:'drop'
             (no stale-dir recreation); the terminal persist halt-gates.
             #4031 (R33/R34, R39) — as the main job's roll: only the chapters this run
             produced, their ids resolved through the current history with the main
             job's decision gate, plus the cached-take fallback; so neither a mid-run
             merge's edits remap nor a manuscript PUT to an untouched chapter is
             reverted. */
          const rollSet = rollChapterSet(() => hints, subsetProduced, () => cachedChapters);
          await rollManuscriptEdits(
            { manuscriptId: job.manuscriptId, candidateBookDir: liveBookDir(job), mode: 'drop' },
            rollSet.snapshot,
            record.bookId ?? undefined,
            (sentences) =>
              resolveCurrentIds(liveBookDir(job) ?? undefined, {}, sentences, priorIds, cache.matchPlan?.decisions, addedIds),
            rollSet.fallback,
          );
        } catch (persistErr) {
          console.warn('[analysis] failed to roll subset manuscript-edits.json', persistErr);
        }
      }
      log(1, `Chapter ${ch.id} done — ${chapterSentences.length.toLocaleString()} sentences.`);
      send({
        kind: 'phase',
        phaseId: 1,
        progress: 0.02 + 0.93 * ((idx + 1) / toRun.length),
        label: PHASES[1].label,
        model: phase1ModelId,
      });
    }

    /* #3084 P20 — the per-chapter dispatch check only fires when a chapter is
       about to start, so an overflow recorded by the LAST chapter's own
       escalation (which runs after that chapter's dispatch check) is never seen
       by it. This loop is sequential, so nothing is still in flight here; without
       this check the job would end in success with reasoningOverflowed=true.
       Rethrow it now that the loop has finished. */
    throwIfReasoningOverflowed(job);

    /* #3435 S14a — a Pause that landed after the loop's last abort-aware step
       ends the run `aborted` (no persist, no result), as one landing mid-loop
       does. Re-checked before the persist below, for a Pause during the fold. */
    if (isAborted()) throw new AnalysisAbortedError('Analysis aborted after the last chapter.');

    /* #3435 S14 — the result gate. On a book that has not reached Confirm, a
       `result` (and the authoritative persist behind it) needs every OTHER
       non-excluded chapter to have a current take: otherwise the book would
       reach Confirm with chapters never attributed, or attributed against a
       stale roster. The targets' takes, the per-chapter roll and the interim
       cast.json overlay stay; the next authoritative persist supersedes them.
       A book past Confirm always passes (O2): decision F never demotes it, so
       its unfinished chapters stay Generate-view rows with Re-analyse. */
    if (!bookReachedConfirm) {
      const targetIds = new Set(toRun.map((c) => c.id));
      const missing = hints.filter((h) => !h.excluded && !targetIds.has(h.id) && !hasCurrentTake(cache, h.id));
      if (missing.length > 0) {
        log(
          1,
          `${missing.length} other chapter${missing.length === 1 ? ' still needs' : 's still need'} attribution — resume the analysis to finish the book.`,
        );
        endJob(job, {
          kind: 'error',
          code: 'resume_required',
          message: resumeRequiredAfterRetryMessage(
            toRun.map((c) => c.title),
            missing.map((h) => h.title),
          ),
        });
        return;
      }
    }

    /* Stitch the full sentence list across all cached chapters (old + new),
       in narrative order. Excluded chapters contribute nothing, and neither
       does a pending take (#3435 M8d: never stitched — O2 lets the gate pass
       on a book past Confirm while another chapter is still in P). Whether
       that chapter then reads as unattributed in book-state depends on
       manuscript-edits.json: past Confirm it is omitted when the edits carry
       its sentences, otherwise it stays listed. The targets left P in the
       loop above. */
    const allSentences: SentenceOutput[] = [];
    const pendingIds = new Set(cache.pendingAttributionChapterIds ?? []);
    for (const h of hints) {
      if (h.excluded || pendingIds.has(h.id)) continue;
      const arr = cachedChapters[h.id];
      if (arr) allSentences.push(...arr);
    }
    /* PR #4103 pass 1 O2 — a user's mid-run merges, before the dedup and the fold (as the main job). */
    const collapsed = await collapseMidRunMerges({
      bookDir: liveBookDir(job) ?? undefined,
      roster: stage1.characters,
      sentences: allSentences,
      prior: priorCastForMerge as PriorRow[],
      plan: cache.matchPlan,
      currentBookId: record.bookId ?? undefined,
    });
    if (collapsed) {
      stage1.characters = collapsed.roster;
      allSentences.splice(0, allSentences.length, ...collapsed.sentences);
      cache.matchPlan = collapsed.plan;
      planConstraints = collapsed.constraints;
      planProtectIds = collapsed.protectIds;
    }

    /* Recover narrator-stranded tagged-speaker lines before the fold (see the
       main route's same block) so a re-analysed chapter's tagged speakers get
       their lines + aren't dropped as 0-line. */
    const recovered = recoverTaggedNarratorLines(allSentences, stage1.characters, bookLanguage);
    if (recovered.flipped > 0) {
      const summary = [...recovered.byId.entries()].map(([id, n]) => `${id}=${n}`).join(', ');
      log(
        1,
        `Recovered ${recovered.flipped} narrator-attributed line(s) to tagged speakers (${summary}).`,
      );
    }
    /* srv-1 — dedup BEFORE the re-fold (see the main route's same block):
       collapse same-name / token-subset duplicates and rewrite their sentences
       onto the canonical id so the fold counts deduped lines. */
    const dd = dedupAndPrepare(stage1.characters, recovered.sentences, bookLanguage, planConstraints);
    stage1.characters = dd.characters;
    recovered.sentences = dd.sentences;
    /* #1447 — strip a real third-party person named/quoted only in a non-story
       front-matter chapter (see the main route's same block). `userSettings`
       is NOT in scope here, so the guard runs with its own default minLines
       (3), matching this block's foldMinorCast call (also no minLines override). */
    const guardChapters: ThirdPartyGuardChapter[] = record.chapterHints.map((h) => ({
      id: h.id,
      title: h.title,
      body: h.body,
    }));
    const classifyNonStory = buildNonStoryClassifier({
      job,
      structureBudget,
      analyzer,
      manuscriptId,
      bookTitle: record.title ?? null,
      bookLanguage,
      /* #3084 wave 3d — same relabel as the stage-1 call's switch handler. */
      onFallback: ({ reason }) => {
        if (selection.fallbackModel && selection.fallbackEngine) {
          subsetModelId = selection.fallbackModel;
          subsetEngine = selection.fallbackEngine;
          setPhaseEngine(job, 0, subsetEngine);
          markFallbackActive(job, selection.fallbackModel);
        }
        console.log(`[analysis-subset] ${manuscriptId}: ${reason}`);
      },
    });
    const guarded = await stripThirdPartyFrontMatter(
      stage1.characters,
      recovered.sentences,
      guardChapters,
      { classifyNonStory },
    );
    if (job.reasoningOverflowed) {
      send({
        kind: 'warning',
        code: NONSTORY_OVERFLOW_WARNING_CODE,
        message: nonStoryOverflowWarningMessage(job.reasoningOverflowError ?? { transport: 'openai', model: '' }),
      });
    }
    if (guarded.stripped.length > 0) {
      log(
        1,
        `Stripped ${guarded.stripped.length} third-party front-matter cast reference(s) (${guarded.stripped.join(', ')}) — re-routed to narrator.`,
      );
    }
    stage1.characters = guarded.characters;
    recovered.sentences = guarded.sentences;
    /* PR #4103 pass 2 P2-2 — again, right before the fold (as the main job). */
    const collapsedAgain = await collapseMidRunMerges({
      bookDir: liveBookDir(job) ?? undefined,
      roster: stage1.characters,
      sentences: recovered.sentences,
      prior: priorCastForMerge as PriorRow[],
      plan: cache.matchPlan,
      currentBookId: record.bookId ?? undefined,
    });
    if (collapsedAgain) {
      stage1.characters = collapsedAgain.roster;
      recovered.sentences = collapsedAgain.sentences;
      cache.matchPlan = collapsedAgain.plan;
      planProtectIds = collapsedAgain.protectIds;
    }
    /* Re-fold the cast against the merged sentence set so the bucket
       attributions stay coherent with the new chapters' attributions.
       Plan 291 (R29) - on plan-applied ids, never folding a row the plan joined to a
       prior row (`planProtectIds`), as in the main job. */
    const folded = foldMinorCast(stage1.characters, recovered.sentences, {
      language: bookLanguage,
      protectIds: planProtectIds,
    });
    /* Fill each folded survivor's tone from its attributes where blank. */
    folded.characters = folded.characters.map(fillToneFromAttributes);
    if (folded.summary.droppedSilent > 0) {
      const sample = folded.dropped.slice(0, 4).join(', ');
      const more = folded.dropped.length > 4 ? `, +${folded.dropped.length - 4} more` : '';
      log(
        1,
        `Dropped ${folded.summary.droppedSilent} non-speaking character${folded.summary.droppedSilent === 1 ? '' : 's'} from the cast (${sample}${more}) — no attributed dialogue, narrator covers them.`,
      );
    }
    const enriched0 = applyNarratorIdentity(
      attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences),
      bookLanguage,
    );

    /* Plan 126 Facet A on the chapter-retry path (srv-13) — the series link pass
       runs on the plan's `new` rows only, honouring its inherited declines, inside
       `planRunCastIdentity` above (plan 291, #4031), as in the main job; the stale
       links were pruned at the run start. */

    /* Plan 291 (#4031) - the roster is already in plan-applied ids (the finalise applied
       the match plan before Phase 1), and the persist re-reads the cast and joins nothing
       by name. No fresh->prior remap runs here, as in the main job: it would re-match a
       planned row a second time (rule 1, invariant 1). */
    const enriched = enriched0;

    /* Phase 1 character-id reconciliation — see the main route's same
       block plus the comment on reconcileSentenceCharacterIds. The
       subset path is just as exposed to orphan ids (one subset chapter
       attributing to a fabricated id, or a previously-good roster that
       shrunk between attribution and persist), so the same guard
       applies here. Plan 291 (item 17) - the roster plus the ids live in cast.json. */
    const subsetValidIds = await driftGateValidIds(job, record.bookDir, enriched);
    /* CJK title-variant rescue, mirroring the main route (see remapCjkHonorificIds). */
    const subsetRemappedForCjk = remapCjkHonorificIds(folded.sentences, enriched, subsetValidIds, {
      bookLanguage,
      onRemap: ({ sentence, originalId, toId }) => {
        log(
          1,
          `Sentence in ch${sentence.chapterId} attributed to CJK title-variant "${originalId}" — remapped to roster id "${toId}".`,
        );
      },
    });
    if (subsetRemappedForCjk.remappedCount > 0) {
      const summary = Array.from(subsetRemappedForCjk.remappedByOriginalId.entries())
        .map(([id, count]) => `${id}=${count}`)
        .join(', ');
      log(
        1,
        `Remapped ${subsetRemappedForCjk.remappedCount} CJK title-variant attribution${subsetRemappedForCjk.remappedCount === 1 ? '' : 's'} to their roster ids (${summary}).`,
      );
    }
    const subsetDemotedByChapter = new Map<number, number>();
    const subsetReconciled = reconcileSentenceCharacterIds(subsetRemappedForCjk.sentences, subsetValidIds, {
      onDemote: ({ sentence, originalId }) => {
        subsetDemotedByChapter.set(
          sentence.chapterId,
          (subsetDemotedByChapter.get(sentence.chapterId) ?? 0) + 1,
        );
        log(
          1,
          `Sentence in ch${sentence.chapterId} attributed to unknown character "${originalId}" — demoted to narrator.`,
        );
      },
    });
    warnPerChapterDrift(folded.sentences, subsetDemotedByChapter, log);
    if (subsetReconciled.demotedCount > 0) {
      const summary = Array.from(subsetReconciled.demotedByOriginalId.entries())
        .map(([id, count]) => `${id}=${count}`)
        .join(', ');
      log(
        1,
        `Demoted ${subsetReconciled.demotedCount} of ${folded.sentences.length} sentences to narrator (orphan ids: ${summary}).`,
      );
    }
    const subsetDriftExceeded = attributionDriftExceeded(
      subsetReconciled.demotedCount,
      folded.sentences.length,
    );

    const chaptersOut = record.chapterHints.map((h) => ({
      id: h.id,
      title: h.title,
      duration: durationPlaceholder(),
      state: 'queued' as const,
      progress: 0,
      characters: {} as Record<string, 'queued' | 'in_progress' | 'done' | 'skipped' | 'failed'>,
      excluded: h.excluded || undefined,
    }));

    const response = {
      bookId: record.bookId ?? bookIdFromTitle(record.title),
      manuscriptId,
      title: record.title,
      phaseTimings: PHASES.map((p) => ({ id: p.id, label: p.label, duration: 0 })),
      characters: enriched,
      chapters: chaptersOut,
      sentences: subsetReconciled.sentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    /* Persist cast.json + manuscript-edits.json + state.json so a refresh
       (or a follow-up generation pass) sees the merged state.
       #3435 S14a — a /pause that landed during the fold ends the run
       `aborted` here, with nothing persisted and no result: a paused retry
       shouldn't flip the library status out from under the user.
       Skipped (for cast.json / state.json) when attribution drift
       exceeded the threshold — same reasoning as the main route's
       persist block. */
    if (isAborted()) throw new AnalysisAbortedError('Analysis aborted before persisting.');
    if (record.bookDir) {
      /* #2260 round 3 (C1) — see the main job's persist block for why a lock-
         acquisition timeout is parked rather than thrown from inside this
         try: thrown here it skips state.json and is then swallowed by
         `catch (persistErr)`, leaving the job reporting success.
         #2295 — and for why the slot has two producers (the identity block,
         and the authoritative cast.json write above it). */
      let persistLockTimeout: unknown;
      /* #4031 R48 — mirrors the main job's `persistWriteError`. */
      let persistWriteError: unknown;
      let staleBookDirError: unknown;
      /* #3435 (plan 287 M17/S14) — set only once THIS block's state.json write
         has landed. The `try` completing is not enough: on attribution_drift
         it completes with the cast.json/state.json writes skipped, and
         `catch (persistErr)` swallows a failed write. */
      let wroteStateJson = false;
      /* Plan 291 — what the planned persist wrote (set only once cast.json landed). */
      let persisted: PersistOutcome | undefined;
      /* #4031 (N2) — the persist's cache op, when it faulted; re-sent once below. */
      let persistUnsentPatch: CachePatch | undefined;
      /* #2196 — resolve the SINGLE verified write target before ANY write,
         mirroring the main job. Throwing BookDirUnresolvedError here skips
         every write in this block (no stale mkdir), which then propagates to
         this run's top-level catch -> endJob halted (C1/C3). */
      const writeDir = await resolveVerifiedBookDirForRun(job);
      try {
        /* srv-1 — record this fold pass's lineage (see writeFoldJournal). Non-fatal:
           a journal failure must never fail the analysis persist. */
        try {
          await writeFoldJournal(
            writeDir,
            folded.rewrites,
            recovered.sentences,
            stage1.characters,
          );
        } catch (journalErr) {
          // #2295 — deliberate swallow; see the main job's matching handler
          // for why the discrimination is by write site, not by handler.
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
        /* srv-1 — record this run's dedup lineage. Non-fatal, mirroring the fold
           journal. Plan 291 (A24): its suggestions ride the planned persist's
           suggestions step, after the drift gate, as in the main job. */
        try {
          await writeDedupJournal(
            writeDir,
            dd.rewrites,
            dd.preDedupSentences,
            dd.preDedupRoster,
          );
        } catch (dedupErr) {
          // #2295 — deliberate swallow, mirroring the main job's handler.
          console.warn('[analysis] failed to write dedup journal', dedupErr);
        }
        /* Plan 291 (#4031) — the subset's terminal cast write is `persistPlannedCast`,
           as the main job's: under the cast lock it re-reads cast.json and the history,
           plans the rows created since the finalise (the fold's buckets), overlays the
           plan-applied roster (rule 1: prior rows are carried forward; rule 11 on the
           subset's OWN ledger: a row it added that the roster no longer holds is removed
           unless the user edited it), writes cast.json and manuscript-edits.json (the
           full stitched sentence set, every chapter) and reconciles the suggestions. A
           stopped main run's rows are never deleted by their `addedRows` entries; the
           persist refreshes each one it writes (compare-then-refresh, invariant 6). It
           replaces the old by-name merge and its compare-and-set merge base.

           Failure handling is the main job's: a cast-lock timeout wrote nothing and is
           parked (state.json still runs, then the deferred rethrow); an edits-write
           failure after cast.json landed carries its outcome, which is recorded before
           the error is parked in `persistWriteError` with any other throw (R48). */
        const persistArgs = plannedPersistArgs({
          writeDir,
          bookId: record.bookId ?? undefined,
          cache,
          dd,
          roster: enriched,
          sentences: subsetReconciled.sentences,
          prior: priorCastForMerge as PriorRow[],
          ledgers: { kind: 'subset', ...subsetLedgers },
        });
        if (subsetDriftExceeded) {
          log(
            1,
            `Attribution drift exceeded threshold (${subsetReconciled.demotedCount}/${folded.sentences.length} ≈ ${Math.round((100 * subsetReconciled.demotedCount) / folded.sentences.length)}%) — refusing to flip cast.json / state.json. Retry analysis to re-attribute.`,
          );
          /* The refused run writes only manuscript-edits.json and removes the pairs its
             own snapshots added; cast.json is left byte-for-byte alone. */
          const refused = await runPlannedPersist(persistArgs(true));
          if (refused.lockTimeout !== undefined) persistLockTimeout = refused.lockTimeout;
        } else {
          const subsetBookId = bookIdForRetirementCleanup(record);
          /* #2166 / PR #2202 gate review (Critical) — mirrors the main path's
             same-named capture: the id-history verdict is decided BEFORE any step
             below rewrites cast-id-history.json. */
          const { status: historyStatusBeforePersist } = await loadCastIdHistoryWithStatus(writeDir);
          let planned: Awaited<ReturnType<typeof runPlannedPersist>> = {};
          try {
            planned = await runPlannedPersist(persistArgs(false));
          } catch (castErr) {
            persistWriteError = parkPersistFailure('[analysis-subset]', writeDir, castErr);
          }
          const { outcome, editsWriteErr, lockTimeout } = planned;
          if (lockTimeout !== undefined) persistLockTimeout = lockTimeout;
          if (outcome) {
            const out = outcome;
            /* The result event carries what was persisted, not the fresh roster. */
            response.characters = out.characters as unknown as CharacterOutput[];
            response.sentences = out.sentences;
            /* R4 (subset) / R35a — the cache's `addedRows`: other runs' entries as the
               persist refreshed them (never converted or deleted: a row kept only because
               invariant 6 bars the subset from deleting it stays `run-owned`), and every
               row the subset added that its own result keeps recorded `added-once`. A row the
               subset added that this persist removed (rule 11, its own ledger) loses
               the entry its snapshot recorded, so a later run may add it again.
               Timing differs from the main job on purpose (final review M5): the main job
               converts only once its state.json has landed, together with `clearLedger`,
               because until then its run is resumable and the entries are its run state.
               The subset never clears a ledger (invariant 6), and this patch is the only
               write of its rows' entries (R35), so it converts here, before state.json. A
               state.json failure therefore leaves main rows `run-owned` and subset rows
               `added-once`; both stay protected (a user edit sticks either way). */
            const persistLedger: Record<string, LedgerEntry | null> = {
              ...(out.mainLedger ?? {}),
              ...subsetCompletedAddedOnce(out),
            };
            for (const id of out.droppedRunAdded) persistLedger[id] = null;
            /* Only what changed is sent (M5): a mid-run merge's deletion of a carried entry
               stays deleted. An entry for a row this persist wrote is always sent (PR #4103
               pass 4 P4-1): the job's copy is no base for it. */
            const ledgerPatch = ledgerDelta(cache.addedRows ?? {}, persistLedger, persistWrittenIds(out));
            const nextLedger: RunAddedLedger = { ...(cache.addedRows ?? {}) };
            for (const [k, e] of Object.entries(ledgerPatch)) {
              if (e === null) delete nextLedger[k];
              else nextLedger[k] = e;
            }
            cache.addedRows = nextLedger;
            subsetLedgers = { own: out.ledger, ownPairs: subsetLedgers.ownPairs };
            const { parked, unsentPatch } = await applyPlannedPersistOutcome({
              out,
              cache,
              manuscriptId,
              ledgerPatch,
              writeDir,
              retirementBookId: subsetBookId,
              bookId: record.bookId ?? undefined,
              historyStatusBeforePersist,
              log,
            });
            if (parked !== undefined) persistLockTimeout = parked;
            persistUnsentPatch = unsentPatch;
          }
          /* The edits write failed after cast.json landed: everything the outcome owed
             is recorded; the error is parked (R48) and state.json still runs. */
          if (editsWriteErr !== undefined) {
            persistWriteError = parkPersistFailure('[analysis-subset]', writeDir, editsWriteErr);
          }
          /* `editsLanded`: cast.json and manuscript-edits.json both landed. False after a
             parked cast-lock timeout or a parked write failure. */
          const editsLanded = outcome !== undefined && editsWriteErr === undefined;
          persisted = outcome;
          /* #2196 review (🟡 TOCTOU) — mirror the main persist's re-verify of the
             write target immediately before the terminal state.json record. */
          /* #3400 pass 8 — the terminal state.json record is a book-locked read
             -> write (`updateStateAtDir`), taken after every cast-lock section
             above has been released (order `cast` -> `book`; the persist holds
             no cast lock here). Everything it decides — the user-owned flags
             carried below AND the chapter list itself — comes from the read
             under the lock, so a held / exclude write or a chapter restructure
             that landed since the job composed its response is not reverted.
             The chapter list is rebuilt from the LIVE record's hints (a
             restructure swaps them under the same lock), falling back to this
             job's own record when it has been evicted.

             The `state-json` leaf lock (taken inside `updateStateAtDir`, nested
             in the book lock) has a 10s acquisition bound, so this wrap is live:
             a timeout is parked, like the authoritative cast.json write's
             above, and rethrown after this persist's try/catch: the write did
             not land, so the job must end as an error rather than report
             success over an unwritten state.json. */
          try {
            wroteStateJson = await updateStateAtDir(writeDir, async (prev) => {
              /* Preserve the user-owned `excluded` + `held` flags across the
                 subset re-attribution — `held` (the "Not queued" intent) isn't
                 re-derivable from disk, so it must ride through here. */
              const prevExcludedById = new Map<number, boolean>();
              const prevHeldById = new Map<number, boolean>();
              /* srv-35 -- `uuid` is the chapter's stable identity (invariant 1:
                 no path regenerates one), so it rides through by id too; the
                 rebuild below would otherwise drop it and the next scan would
                 mint a fresh random uuid for every chapter (#3625). */
              const prevUuidById = new Map<number, string>();
              const prevOverriddenById = new Map<number, string>();
              for (const c of prev.chapters) {
                if (c.excluded) prevExcludedById.set(c.id, true);
                if (c.held) prevHeldById.set(c.id, true);
                if (c.uuid) prevUuidById.set(c.id, c.uuid);
                if (c.titleOverridden) prevOverriddenById.set(c.id, c.title);
              }
              const next: BookStateJson = {
                ...prev,
                /* #3628 — the title-source flags are not re-derivable here, so
                   carry them from prev (both only while the title is unchanged,
                   so a mis-aligned parse cannot move a flag onto another heading) or a re-analysis would
                   strip them and a later restructure would misjudge the title. */
                chapters: carryTitleSynthesized(
                  (getManuscript(job.manuscriptId) ?? record).chapterHints.map((h) => ({
                    id: h.id,
                    title: h.title,
                    slug: `${String(h.id).padStart(2, '0')}-${slug(h.title)}`,
                    duration: durationPlaceholder(),
                    excluded: prevExcludedById.get(h.id) || undefined,
                    held: prevHeldById.get(h.id) || undefined,
                    uuid: prevUuidById.get(h.id),
                    titleOverridden: prevOverriddenById.get(h.id) === h.title || undefined,
                  })),
                  prev.chapters,
                ),
                /* srv-59 Task 11 — a subset retry supersedes whatever
                   provenance the last full run left, so this REWRITES the
                   block wholesale (fresh `at` + a report recomputed from just
                   this pass's chapters) rather than merging with `prev`'s.
                   Plan 291 — only when the planned persist's writes landed
                   (`editsLanded`), as in the main job: after a parked cast-lock
                   timeout they did not, and `prev`'s provenance still describes disk. */
                ...(editsLanded ? { analysisProvenance: {
                  engine: phase1Selection.engine,
                  model: phase1Selection.model,
                  at: new Date().toISOString(),
                  structureEngineVersion: 1,
                  report: aggregateStructureReports(subsetStructureReports),
                  scope: 'subset' as const,
                  chaptersCovered: toRun.length,
                  /* #2267/#2275 C3 — see the matching comment at the main
                     route's persist site above. */
                  maxMergedTurnsInParagraph: aggregateMaxMergedTurns(subsetPerChapterMaxMergedTurns),
                } } : {}),
                updatedAt: new Date().toISOString(),
              };
              return next;
            }, {
              /* Re-verified inside the book lock (a rename holds it) but BEFORE
                 the state-json leaf lock: the slow path of this check can
                 re-hydrate the manuscript and scan the library, whose heals
                 take that same leaf lock. */
              underBookLock: () => assertWriteTargetStable(job, writeDir),
            });
          } catch (stateWriteErr) {
            if (isLockAcquisitionTimeout(stateWriteErr) || stateWriteErr instanceof BookDirUnresolvedError) {
              if (isLockAcquisitionTimeout(stateWriteErr)) persistLockTimeout = stateWriteErr;
              throw stateWriteErr;
            }
            /* #4031 R48 — the terminal record did not land: parked, not swallowed. */
            persistWriteError ??= parkPersistFailure('[analysis-subset]', writeDir, stateWriteErr);
          }
        }
      } catch (persistErr) {
        /* #2196 — mirror the main job's mid-block stale-dir detection: park
           only — the durable STALE_BOOK_DIR log lives in the run catch (V7·1). */
        if (persistErr instanceof BookDirUnresolvedError) {
          staleBookDirError = persistErr;
        } else {
          console.error(
            '[analysis-subset] failed to persist .audiobook/* for',
            writeDir,
            persistErr,
          );
        }
      }
      /* #2260 round 3 (C1) — the deferred rethrow, outside the try/catch so
         it escapes `catch (persistErr)` and reaches this job's top-level
         catch, which ends the job via `endJob(job, {kind:'error', …})`.
         Mirrors the main job. */
      /* #4031 (N2) — before anything can end the run, the persist's faulted cache op is
         re-sent once (its decisions, re-mints and ledger have no other writer). */
      if (persistUnsentPatch) await resendCachePatch(manuscriptId, persistUnsentPatch);
      if (persistLockTimeout !== undefined) throw persistLockTimeout;
      /* #2196 — surface a mid-block BookDirUnresolvedError to the run's
         top-level catch (Task 6), which ends the job halted. Mirrors main, including
         its order ahead of a parked write error (R2-M4). */
      if (staleBookDirError !== undefined) throw staleBookDirError;
      if (persistWriteError !== undefined) throw persistWriteError;
      /* #3435 M17/S14 — the takes are persisted and the book has reached
         Confirm (decision F); `confirmReached` is never cleared except with the
         cache. */
      if (wroteStateJson) {
        cache.takesPersisted = true;
        cache.confirmReached = true;
        /* #4031 — a field-scoped patch (no whole-cache save reverts a mid-run merge's
           re-target). The ledger was patched with the persist's outcome above; no
           `clearLedger` here: a stopped main run's entries are its own (invariant 6).
           The cache takes follow the persist's rule-13 reroute, as in the main job. */
        await mutateAnalysisCache(manuscriptId, {
          fields: { takesPersisted: true, confirmReached: true },
          ...rerouteDeletedTakesPatch(persisted),
        });
      }
    }

    if (subsetDriftExceeded) {
      endJob(job, {
        kind: 'error',
        code: 'attribution_drift',
        message: `Phase 1 demoted ${subsetReconciled.demotedCount} of ${folded.sentences.length} sentences (${Math.round((100 * subsetReconciled.demotedCount) / folded.sentences.length)}%) to narrator — model attribution unreliable. Retry analysis to re-attribute — or Start fresh to re-attribute every chapter.`,
      });
      return;
    }

    endJob(job, { kind: 'result', response });
  } catch (e) {
    /* #4031 N2 — a pause or failure during Phase 0a still lands a faulted re-mint. */
    await flushPendingCachePatch();
    if (e instanceof AnalysisAbortedError) {
      /* Plan 32 D1: subset retries now survive a client disconnect,
         so AnalysisAbortedError here means an EXPLICIT /pause
         aborted the run. Broadcast paused state to every still-
         attached subscriber via endJob — the cold-boot snapshot
         the pause endpoint already wrote will agree. */
      console.log(`[analysis-subset] aborted ${manuscriptId} (pause)`);
      endJob(job, {
        kind: 'error',
        code: 'aborted',
        message: 'Analysis aborted (paused or displaced).',
      });
      return;
    }
    if (e instanceof BookDirUnresolvedError) {
      /* #2196 — mirror the main job: an unresolvable book dir ends this
         subset run terminal `halted`; persistTerminalSnapshot (Task 7) in
         mode:'drop' writes no dead-dir snapshot. V7·1 — always-on server
         error naming manuscriptId + STALE_BOOK_DIR (the durable detached-run
         fail-loud). */
      console.error(
        `[analysis-subset] ${manuscriptId} STALE_BOOK_DIR: ${(e as Error).message}`,
      );
      endJob(job, {
        kind: 'error',
        code: 'STALE_BOOK_DIR',
        message: e.message,
      });
      return;
    }
    const {
      code,
      userMessage: message,
      remediation,
      detail,
      fixes,
    } = classifyAnalysisFailure(e, terminalFailureLabel(job, analyzerLabel, phase1TerminalLabel), {
      chapter: job.reasoningOverflowChapter,
    });
    console.error('[analysis-subset] failed', {
      manuscriptId,
      code,
      message,
      lastStep,
      stack: (e as Error)?.stack,
    });
    /* #3084 F7 — same contract as the main route above: fixes ride the SSE
       `error` event only; the #3004 last-outcome record is untouched. */
    endJob(job, { kind: 'error', code, message, remediation, detail, fixes });
  }
}

/* describeError, formatErrorDetail, trimQuotaMessage, tryParseApiError, and
   classifyStatus have been moved to failure-taxonomy.ts (classifyAnalysisFailure
   / tryParseApiError exported). Call sites above now use classifyAnalysisFailure.
   Note: classifyStatus was renamed statusToFailureCode (private) in its new home. */
