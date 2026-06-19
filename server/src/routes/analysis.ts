/* POST /api/manuscripts/:id/analysis — SSE stream.
   Events are sent as `data: <json>\n\n`. Two payload shapes:
     { kind: 'phase',  phaseId, progress, label? }
     { kind: 'result', response: AnalyseResponse }
   The frontend's `real.analyseManuscript` reads this with fetch + ReadableStream. */

import { rm } from 'node:fs/promises';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { safeBookId } from '../util/safe-id.js';
import { runStage1ChapterChunked, resolveStage1ChunkCharBudget } from '../analyzer/stage1-chunk.js';
import { applyNonEnglishNarratorDefault } from '../analyzer/narrator-default.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { type AnalyzerSelection, type Analyzer, type StageCall } from '../analyzer/index.js';
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
import { detectOllamaDevice } from './ollama-health.js';
import { foldMinorCast } from '../analyzer/fold-minor-cast.js';
import {
  loadCastMerges,
  saveCastMerges,
  clearCastMerges,
  replaceFoldEntries,
  buildFoldJournalEntries,
} from '../store/cast-merges.js';
import { recoverTaggedNarratorLines } from '../analyzer/recover-tagged-lines.js';
import {
  runStage2ChapterChunked,
  resolveStage2ChunkCharBudget,
  type Stage2ChunkRunResult,
} from '../analyzer/stage2-chunk.js';
import {
  countSentencesHeuristic,
  countStreamedSentences,
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
import {
  readUserSettings,
  getCachedUserSettings,
  type UserSettings,
} from '../workspace/user-settings.js';
import {
  clearAnalysisCache,
  loadAnalysisCache,
  saveAnalysisCache,
  type AnalysisCache,
  type ChapterErrorRecord,
} from '../store/analysis-cache.js';
import {
  deleteAnalysisState,
  writeAnalysisState,
  type AnalysisStateFile,
} from '../store/analysis-state.js';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1Output,
  Stage1ChapterOutput,
} from '../handoff/schemas.js';
import {
  castJsonPath,
  castReuseCarryoverJsonPath,
  changeLogJsonPath,
  manuscriptEditsJsonPath,
  slug,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import {
  mergeAnalysisResultWithExistingCast,
  seedReuseGuardsFromPriorCast,
  voicedSurvivorsDropped,
} from '../store/merge-analysis-cast.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import type { BookStateJson } from '../workspace/scan.js';
import { findBookByManuscriptId, bookStateLanguage } from '../workspace/scan.js';
import { markAnalysisBusy, clearAnalysisBusy, isDesignBusy } from '../tts/design-lock.js';
import { scanSeriesCharactersForBookId } from '../workspace/series-cast-scan.js';
import { dedupSeriesPrior } from '../workspace/series-prior-dedup.js';
import { linkSeriesReuseAtAnalysis, pruneStaleReuseLinks } from '../workspace/series-reuse-link.js';
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
import {
  classifyAnalysisFailure,
  tryParseApiError,
  FAILURE_REMEDIATIONS,
} from './failure-taxonomy.js';

/* srv-13 — the existing cast's voice/reuse fields to overlay onto a fresh
   analysis roster. Prefer cast.json; when it's absent (a reparse just deleted
   it) fall back to the reuse-carryover snapshot the reparse handler wrote, so
   continuity survives the reparse → re-analysis window. Once this run writes a
   fresh cast.json it takes precedence and the carryover goes inert until the
   next reparse refreshes it. */
export async function readPriorCastForMerge(
  bookDir: string,
): Promise<Array<{ id: string } & Record<string, unknown>>> {
  const fromCast = (
    await readJson<{ characters?: Array<{ id: string } & Record<string, unknown>> }>(
      castJsonPath(bookDir),
    ).catch(() => null)
  )?.characters;
  if (fromCast?.length) return fromCast;
  const fromCarryover = (
    await readJson<{ characters?: Array<{ id: string } & Record<string, unknown>> }>(
      castReuseCarryoverJsonPath(bookDir),
    ).catch(() => null)
  )?.characters;
  return fromCarryover ?? [];
}

/* srv-13 — when the merge re-adds voiced/reused characters the fresh roster
   dropped (a transient analyzer miss), leave a change-log breadcrumb so the
   rescue is visible. Mirrors the change-log write pattern in book-state.ts.
   Best-effort: a log failure must never disturb the persist. */
async function logCarriedForwardCharacters(
  bookDir: string,
  dropped: Array<{ id: string; name?: string }>,
): Promise<void> {
  if (!dropped.length) return;
  try {
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
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemma-4-31b-it': 'Gemma 4 31B',
  'gemma-4-26b-a4b-it': 'Gemma 4 26B',
};

function humanModel(modelId: string | undefined): string {
  if (!modelId) return 'analyzer';
  return MODEL_LABELS[modelId] ?? modelId;
}

/** Engine-aware label so SSE chunks read "Ollama (qwen3.5:9b)" for the
    local analyzer and "Gemma 4 31B" for Gemini. The MODEL_LABELS lookup
    only covers Gemini ids, so the local branch surfaces the raw tag —
    which is fine, Ollama tags are already human-readable. */
function engineLabel(engine: 'local' | 'gemini', modelId: string): string {
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
export function createWatermarkForJob(userSettings?: UserSettings): PhaseWatermark {
  if (!isPerPhaseModelSelectionActive(userSettings)) {
    return createSequentialWatermark();
  }
  return createPhaseWatermark({ minLagChapters: resolvePhase1MinLagChapters(userSettings) });
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
        evidence: incoming.evidence ? incoming.evidence.map((e) => ({ ...e })) : undefined,
        tone: incoming.tone ? { ...incoming.tone } : undefined,
      });
      continue;
    }
    /* Description: keep whichever is longer. */
    if (
      incoming.description &&
      (!existing.description || incoming.description.length > existing.description.length)
    ) {
      existing.description = incoming.description;
    }
    /* Tone: latest-wins per field, but only when the incoming entry
       provided that field (don't blank out a known value). */
    if (incoming.tone) {
      existing.tone = { ...existing.tone, ...incoming.tone };
    }
    /* Attributes: union dedup. Order: existing first, then any new. */
    if (incoming.attributes?.length) {
      const seen = new Set(existing.attributes ?? []);
      const next = [...(existing.attributes ?? [])];
      for (const a of incoming.attributes) {
        if (!seen.has(a)) {
          next.push(a);
          seen.add(a);
        }
      }
      existing.attributes = next;
    }
    /* Evidence: append non-duplicate quotes. Dedup on normalised quote
       so smart-vs-straight typography drift between chapters doesn't
       inflate the array. */
    if (incoming.evidence?.length) {
      const seen = new Set((existing.evidence ?? []).map((e) => normaliseForMatch(e.quote)));
      const next = [...(existing.evidence ?? [])];
      for (const e of incoming.evidence) {
        const norm = normaliseForMatch(e.quote);
        if (norm.length > 0 && !seen.has(norm)) {
          next.push({ ...e });
          seen.add(norm);
        }
      }
      existing.evidence = next;
    }
    /* Gender / ageRange / color / role / name: only adopt incoming when
       existing doesn't have a value. First detection wins for identity
       fields — switching pronouns mid-book is almost always a model
       error, not a character development. */
    if (!existing.gender && incoming.gender) existing.gender = incoming.gender;
    if (!existing.ageRange && incoming.ageRange) existing.ageRange = incoming.ageRange;
  }
}

/* Build an "interim" cast suitable for writing to cast.json mid-run.
   Walks chapterCast in narrative chapter order, merges via the same
   mergeRosterChapter the live SSE uses, applies the descriptor-name
   fold (Unknown male / Unknown female collapse — see
   `previewFoldForLiveView`), then deterministic palette colours and
   `lines: 0, scenes: 0` placeholders since Phase 1 hasn't run yet.
   The shape matches the post-Phase-1 end-of-run write so frontend
   cast.json readers tolerate it; the post-fold final write replaces
   this with the authoritative version once Phase 1 + fold completes.
   Returns `[]` when the roster is empty so callers can guard the
   cast.json write. */
export function buildInterimCast(
  chapterCast: Record<number, CharacterOutput[]>,
  chapterOrder: number[],
  language?: string,
): CharacterOutput[] {
  const roster = new Map<string, CharacterOutput>();
  for (const chapterId of chapterOrder) {
    const cast = chapterCast[chapterId];
    if (cast?.length) mergeRosterChapter(roster, cast);
  }
  if (roster.size === 0) return [];
  const folded = previewFoldForLiveView(Array.from(roster.values()), language);
  return attachLinesAndScenes(assignPaletteColors(folded), []);
}

/* Name-only descriptor fold used by both the interim cast.json write
   and the live SSE cast-update payload. Collapses "The Jogger" /
   "Drooly Boy" / "Unknown Intruder" into the Unknown male / Unknown
   female buckets the moment they appear in a chapter's roster, so
   the user sees the same buckets they'd see post-Phase-1 instead of
   a churn of descriptor-named one-offs.

   No line-count rule and no zero-line drop — both need stage-2 data
   the verifier hasn't produced yet during Phase 0a, and applying
   them prematurely would drop legitimate characters who simply
   haven't been processed yet. The full fold runs at Phase 1's tail
   with sentence counts in hand. */
/* srv-1 — persist a fold pass's lineage to the merge journal. Replace-all keeps
   kind:'fold' entries in lockstep with the current manuscript-edits.json
   (manual entries are preserved). Co-locate the CALL with the edits write so the
   journal is persisted iff the sentences it describes are. Non-fatal at the call
   site. */
async function writeFoldJournal(
  bookDir: string,
  rewrites: Record<string, string>,
  preFoldSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
): Promise<void> {
  const journal = await loadCastMerges(bookDir);
  await saveCastMerges(
    bookDir,
    replaceFoldEntries(
      journal,
      buildFoldJournalEntries(rewrites, preFoldSentences, characters, new Date().toISOString()),
    ),
  );
}

function previewFoldForLiveView(
  characters: CharacterOutput[],
  language?: string,
): CharacterOutput[] {
  return foldMinorCast(characters, [], { nameOnly: true, language }).characters;
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
  engine: 'gemini' | 'local',
  device: 'cuda' | 'cpu' | 'unknown',
): number {
  return engine === 'local' ? localFallbackMsPerChar(device) : GEMINI_FALLBACK_MS_PER_CHAR;
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
/* Stage 2 chapter concurrency. Default 2 keeps us well under Gemini's
   free-tier RPM limits while roughly halving wall-clock time vs sequential.
   Bump via STAGE2_CONCURRENCY env if your tier (or the model) allows; cap
   at 6 because narrative-consistency benefits drop off and the per-call
   overhead dominates beyond that. */
function readStage2Concurrency(): number {
  const raw = Number(process.env.STAGE2_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.min(6, Math.floor(raw));
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

/* Remove `chapterId` from `cache.failedChapterIds` if present, mutating
   the cache in place. Returns whether the id was actually in the list —
   the caller uses that to decide whether to emit a `chapter-resolved`
   event on the SSE. Centralises the "is this a recovered chapter?"
   check so the full-route Phase 0a success path and the subset
   retry's success path stay in lockstep (both must clear AND notify;
   either one alone leaks state to the FE). Idempotent: a second call
   for the same id is a no-op and returns false. Exported for unit
   testing. */
export function clearFailedChapterId(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, ChapterErrorRecord>;
  },
  chapterId: number,
): boolean {
  const wasFailed = cache.failedChapterIds?.includes(chapterId) === true;
  if (wasFailed) {
    cache.failedChapterIds = cache.failedChapterIds!.filter((id) => id !== chapterId);
    if (cache.failedChapterErrors) delete cache.failedChapterErrors[String(chapterId)];
  }
  return wasFailed;
}

/* fs-19 (analysis half) — promote a classified per-chapter failure to durable
   cache state: the id keeps driving the Retry list; the record carries the
   structured code/message/remediation for the post-reload display. */
export function recordFailedChapter(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, ChapterErrorRecord>;
  },
  chapterId: number,
  classified: { code: string; userMessage: string; remediation: string },
): void {
  const failedSet = new Set(cache.failedChapterIds ?? []);
  failedSet.add(chapterId);
  cache.failedChapterIds = Array.from(failedSet);
  if (!cache.failedChapterErrors) cache.failedChapterErrors = {};
  cache.failedChapterErrors[String(chapterId)] = {
    code: classified.code,
    message: classified.userMessage,
    remediation: classified.remediation,
  };
}

/* Phase 0a coverage check — every non-excluded chapter must have a
   non-empty `chapterCast[id]` entry before stage1 can be finalised.

   The subset-retry path used to gate stage1 writes on
   `failedChapterIds.length === 0` alone, which is the WRONG predicate when
   the cache covers only a fraction of the book. Example regression seen on
   "The Floodmark" (mns_VoP0mLGvov): chapterCast had entries for chapters 1–28
   of a 182-chapter book, failedChapterIds was [], and a subset retry
   rebuilt stage1 from those 28 entries — overwriting a previously-good
   6-character roster with a Narrator-only one because every cached
   chapter happened to be a journal/registry-file POV that the model
   labelled as Narrator.

   Empty arrays are the route's failure-marker convention (see catch path
   at analysis.ts:2016) so they count as "absent" here too. Excluded
   chapters are intentionally never run through Phase 0a so they don't
   count toward coverage. Exported for unit testing. */
export function isPhase0aCoverageComplete(
  chapterCast: Record<number, CharacterOutput[]>,
  chapterHints: Array<{ id: number; excluded?: boolean }>,
): { complete: boolean; missingChapterIds: number[]; totalRequired: number } {
  const missingChapterIds: number[] = [];
  let totalRequired = 0;
  for (const ch of chapterHints) {
    if (ch.excluded) continue;
    totalRequired += 1;
    if (!chapterCast[ch.id]?.length) missingChapterIds.push(ch.id);
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
    out.push({ ...s, characterId: fallbackId });
    options.onDemote?.({ sentence: s, originalId: s.characterId });
  }
  return { sentences: out, demotedCount, demotedByOriginalId };
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

## Running roster (from earlier chapters — reuse these ids verbatim)

For any character below who appears in this chapter, use the existing \`id\`
**verbatim**. The server merges by id; a stylistic variation creates a
duplicate roster entry.

${rosterBlock}
${priorBlock}
## Chapter

${chapter.body}
`;
}

function buildStage2ChapterInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
): string {
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
id). Name and role are included for disambiguation when the manuscript
refers to the same person by multiple forms. The richer tone / evidence /
description fields from stage 1 are intentionally elided to keep the call
fast — refer back to them only if you genuinely can't disambiguate.

\`\`\`json
${JSON.stringify(
  stage1.characters.map((c) => ({ id: c.id, name: c.name, role: c.role })),
  null,
  2,
)}
\`\`\`

## Chapter ${chapter.id} — ${chapter.title}

${chapter.body}
`;
}

/* Stage-2 inbox for ONE SECTION of a large chapter (#528 chunking). Same roster
   + rules as buildStage2ChapterInbox, but the body is a sub-section and an
   optional "preceding context" block carries the prior section's tail so an
   untagged quote keeps its speaker across the seam. The model must attribute
   ONLY the section, not the context. The chunk runner renumbers ids across
   sections, so per-section 1-based numbering is fine. */
function buildStage2ChunkInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
  subBody: string,
  precedingContext: string | null,
): string {
  const contextBlock = precedingContext
    ? `## Preceding context (already attributed — do NOT include in your output)

These paragraphs come immediately BEFORE the section to attribute, provided
ONLY so you can carry a speaker across the boundary (e.g. an untagged quote
whose speaker was named just before). Do NOT emit any sentences for this text.

${precedingContext}

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
id). Name and role are included for disambiguation.

\`\`\`json
${JSON.stringify(
  stage1.characters.map((c) => ({ id: c.id, name: c.name, role: c.role })),
  null,
  2,
)}
\`\`\`

${contextBlock}## Section to attribute (Chapter ${chapter.id} — ${chapter.title})

${subBody}
`;
}

/* Shared resilient stage-2 runner used by BOTH the main and subset routes
   (#528). Wraps the chapter in the large-chapter chunker (which itself wraps
   each call in the coverage guard), so an over-budget chapter is split into
   sections instead of truncating, and a chunk that still truncates is
   adaptively re-split. For a chapter within budget this is exactly one guarded
   call against the full body (byte-identical to the prior behaviour). Returns
   the stitched sentences + combined coverage verdict. */
async function attributeChapterStage2(opts: {
  analyzer: Analyzer;
  manuscriptId: string;
  title: string;
  stage1: Stage1Output;
  chapter: { id: number; title: string; body: string };
  stageCall: StageCall;
  /* Phase-1 analyzer engine — sizes the chunk budget against num_ctx for local
     Ollama so a fat input chunk doesn't starve the output window (#528 follow-
     up; 2026-06-14 qwen3.5:4b truncation). Defaults to the configured budget
     when omitted. */
  engine?: 'gemini' | 'local';
  onCoverageRetry?: (attempt: number, verdict: { issues: string[] }) => void;
  onChunk?: (info: { index: number; total: number; chars: number }) => void;
  onSectionDone?: (index: number, sentenceCount: number) => void;
}): Promise<Stage2ChunkRunResult> {
  const callForBody = (subBody: string, preceding: string | null) => {
    const prompt =
      preceding === null && subBody === opts.chapter.body
        ? buildStage2ChapterInbox(opts.manuscriptId, opts.title, opts.stage1, opts.chapter)
        : buildStage2ChunkInbox(
            opts.manuscriptId,
            opts.title,
            opts.stage1,
            opts.chapter,
            subBody,
            preceding,
          );
    return opts.analyzer.runStage2Chapter(
      opts.manuscriptId,
      opts.chapter.id,
      prompt,
      opts.stageCall,
    );
  };
  const result = await runStage2ChapterChunked({
    body: opts.chapter.body,
    charBudget: resolveStage2ChunkCharBudget(opts.engine),
    coverageRetries: resolveStage2CoverageRetries(),
    callForBody,
    onRetry: opts.onCoverageRetry,
    onChunk: opts.onChunk,
    onSectionDone: opts.onSectionDone,
  });
  /* plan 221 Wave A — non-English narrator-default heuristic. The model
     mislabels third-person narration as a character on non-Latin scripts;
     force non-spoken sentences to `narrator`. No-op for English. Runs AFTER
     coverage (coverage keys on text, not characterId), so the verdict is
     unchanged. */
  result.sentences = applyNonEnglishNarratorDefault(result.sentences, opts.stageCall.language);
  return result;
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
    }
  >;
  /** One-shot series-cast prior event emitted at Phase 0 entry. Cached
      here so a subscriber that attaches AFTER Phase 0 entry receives
      the carry-over surface in its catch-up replay (otherwise the
      first subscriber would see the SeriesPriorPill but the second
      one — post-reload, post-navigate-back — would miss it). */
  lastSeriesPrior: { kind: 'series-prior'; count: number; names: string[] } | null;
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
  /** Path to the book directory the analyzer is writing into. Set
      from the manuscript record at job creation, used by the
      cold-boot rehydration writes (`writeAnalysisState` / `deleteAnalysisState`).
      `null` for legacy POST /api/manuscripts uploads that have no
      workspace book — those skip every disk write site, same as
      cast.json / state.json. */
  bookDir: string | null;
  /** Engine the active analyzer is using. Persisted into
      `analysis-state.json` so the cold-boot rehydrated AnalysisPill
      carries the right engine for the reverse-direction local-analyzer
      guard (`src/hooks/use-reverse-local-analyzer-guard.tsx`) — the
      guard checks `engine === 'local'` to decide whether to prompt
      before a TTS-start. */
  engine: 'local' | 'gemini';
  replay: AnalysisJobReplayState;
  /** ms-since-epoch of the last `analysis-state.json` write. Used to
      throttle phase-tick writes to ~once every 5s so we don't hammer
      the filesystem during the per-chapter sub-tick storms in
      Phase 0a / Phase 1. Terminal writes (pause, endJob branches)
      ignore the throttle and always land. */
  lastDiskWriteAt: number;
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

/** fs-1 — true when ANY analyzer job (main or subset) is in flight. The upgrade
    gate refuses to restart the server out from under an active analysis. Returns
    the busy manuscript ids so the 409 can name them. */
export function activeAnalysisManuscripts(): string[] {
  const out = new Set<string>();
  for (const [id, job] of inFlightAnalysisByManuscript) {
    if (!job.controller.signal.aborted) out.add(id);
  }
  for (const [id, job] of inFlightSubsetByManuscript) {
    if (!job.controller.signal.aborted) out.add(id);
  }
  return [...out];
}

/** Snapshot the in-flight analyzer's state for the cold-boot
    discovery endpoint (GET /api/books/:bookId/analysis/state).
    Returns null when no job is running OR the job's controller has
    been aborted — both cases fall back to disk in the GET handler.
    The synthesised file shape matches what the disk writer produces,
    so the discovery endpoint can return either source unchanged.

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
    lastTickAt: job.lastDiskWriteAt || Date.now(),
    writtenAt: Date.now(),
  };
}

/** Phase-tick disk-write throttle. Phase events fire densely during
    Phase 0a / Phase 1 sub-ticks; we only need one snapshot every few
    seconds for cold-boot rehydration purposes. */
const ANALYSIS_STATE_WRITE_THROTTLE_MS = 5_000;

async function persistRunningSnapshot(job: AnalysisJob, force: boolean): Promise<void> {
  if (!job.bookDir) return;
  const phase = job.replay.lastPhase;
  if (!phase) return;
  const now = Date.now();
  if (!force && now - job.lastDiskWriteAt < ANALYSIS_STATE_WRITE_THROTTLE_MS) return;
  job.lastDiskWriteAt = now;
  try {
    await writeAnalysisState(job.bookDir, {
      manuscriptId: job.manuscriptId,
      phaseId: phase.phaseId,
      phaseLabel: phase.label,
      phaseProgress: phase.progress,
      state: 'running',
      engine: job.engine,
      kind: job.kind,
      subsetChapterIds: job.kind === 'subset' ? job.subsetChapterIds : undefined,
      lastTickAt: now,
    });
  } catch (err) {
    /* Non-fatal — the on-disk file only powers cold-boot pill
       rehydration. The analyzer cache + cast.json are the real
       source of truth. Log and continue. */
    console.warn('[analysis-state] running snapshot write failed', err);
  }
}

async function persistTerminalSnapshot(
  job: AnalysisJob,
  state: 'paused' | 'halted',
  finalEv: { code?: string; message?: string } | null,
): Promise<void> {
  if (!job.bookDir) return;
  const phase = job.replay.lastPhase;
  try {
    await writeAnalysisState(job.bookDir, {
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
      const e = ev as { chapterId?: number; message?: string; code?: string; remediation?: string };
      if (typeof e.chapterId === 'number' && typeof e.message === 'string') {
        job.replay.failedByChapterId.set(e.chapterId, {
          kind: 'chapter-failed',
          chapterId: e.chapterId,
          message: e.message,
          code: e.code,
          remediation: e.remediation,
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
}

function endJob(job: AnalysisJob, finalEv?: unknown): void {
  if (finalEv) broadcastToJob(job, finalEv);
  /* Cold-boot snapshot transition. Fire-and-forget; we still tear
     down subscribers + deregister synchronously below so the route
     response isn't held up by the disk write.

     Plan 32 D1: subset jobs DON'T delete the on-disk snapshot on
     terminal success because the main run may still be alive and
     using it. The subset's own state isn't load-bearing for cold-
     boot once it's done (the pill drops back to the main run's
     state), so leaving the file in whatever state main left it in
     is correct. Subset's paused/halted snapshots still land for
     mid-flight aborts so the pill can render the Resume affordance. */
  const kind = (finalEv as { kind?: string } | undefined)?.kind;
  const code = (finalEv as { code?: string } | undefined)?.code;
  if (job.bookDir) {
    if (!finalEv || kind === 'result') {
      /* Terminal success OR a clean teardown with no final event.
         Main: the analysis is complete (no pill should appear) —
         delete the snapshot file. Subset: leave the file alone so
         any main run's snapshot survives a sibling subset
         completing successfully. */
      if (job.kind === 'main') {
        void deleteAnalysisState(job.bookDir);
      }
    } else if (kind === 'error' && code === 'aborted') {
      /* Paused or displaced. Write paused state so the cold-boot
         endpoint returns paused, and the pill renders the Resume
         affordance. */
      void persistTerminalSnapshot(job, 'paused', finalEv as { code: string; message?: string });
    } else if (kind === 'error') {
      /* Halted on a real failure: attribution_drift, cast_incomplete,
         stage1_shrink_refused, unknown_manuscript, or an upstream
         analyzer error. Persist with haltCode + haltReason so the
         cold-boot pill routes the user to the right banner. */
      void persistTerminalSnapshot(job, 'halted', finalEv as { code: string; message?: string });
    }
  }
  for (const sub of job.subscribers) {
    clearInterval(sub.keepAlive);
    try {
      sub.res.end();
    } catch {
      /* socket already gone */
    }
  }
  job.subscribers.clear();
  const targetMap = jobMapFor(job.kind);
  if (targetMap.get(job.manuscriptId) === job) {
    targetMap.delete(job.manuscriptId);
  }
  /* Release the cross-operation busy flag so a "Design full cast" run can
     start once analysis is done (mutual exclusion — re-analysis rewrites the
     whole cast). Ref-counted, so a sibling main/subset job keeps it held. */
  if (job.bookDir) clearAnalysisBusy(job.bookDir);
}

analysisRouter.post('/:id/analysis', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  /* Vite's dev proxy (http-proxy under the hood) closes the upstream
     connection if it sees no body data for a while after the headers
     land — which is exactly what happens on a cold server where
     getOrHydrateManuscript re-parses a 100k+ word EPUB before the
     first SSE event lands. The proxy fires RST, the route's
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

  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
  const requestedFresh = req.body?.fresh === true;
  /* `allowStage1Shrink` is the user's opt-in when the route refused a
     stage1 write because the new roster would replace a much larger
     existing one (see stage1ShrinkRefused comment). The analysing
     view's "Accept smaller roster" button re-fires the same request
     with this flag so the next attempt skips the gate. */
  const allowStage1Shrink = req.body?.allowStage1Shrink === true;
  /* Plan 118 — read the user-settings snapshot once at request start and
     resolve the Phase 0 (cast detection) analyzer via the per-phase
     selector, so the saved `analyzerPhase0Model` is honoured rather than
     ignored (the old `selectAnalyzer({ model })` only ever saw the
     per-request model + the GEMINI_MODEL default). The same snapshot is
     threaded into the job so every per-phase / watermark / lag decision
     reflects one read-once view of the file. */
  const userSettings = await readUserSettings();
  let selection: AnalyzerSelection;
  try {
    selection = selectAnalyzerForPhase({ phase: 'phase0', model: requestedModel, userSettings });
  } catch (e) {
    send({ kind: 'error', message: (e as Error).message });
    clearInterval(keepAlive);
    return res.end();
  }
  if (requestedModel) {
    console.log(
      `[analysis] manuscript=${manuscriptId} engine=${selection.engine} model=${selection.model}`,
    );
  }

  /* ── Dispatch: subscribe-vs-start.
     If a non-aborted job is already running for this manuscript AND we
     are not explicitly displacing it (fresh: true), join the existing
     job's subscriber set and replay its current state. Browser reload
     / navigate-away survival lives here — the second POST lands in
     this branch and the original analyzer keeps running untouched.
     Otherwise (no existing job, or fresh: true displacement), abort
     any prior job and start a new one detached in the background. */
  const existing = inFlightAnalysisByManuscript.get(manuscriptId);
  if (existing && !existing.controller.signal.aborted && !requestedFresh) {
    const subscriber: AnalysisSubscriber = { send, res, keepAlive };
    existing.subscribers.add(subscriber);
    replayCatchUp(existing, send);
    res.on('close', () => {
      if (res.writableEnded) return;
      existing.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — sticky semantics. The analyzer keeps running
         until /pause or the queue drains. */
    });
    res.on('finish', () => clearInterval(keepAlive));
    return;
  }
  if (existing) {
    existing.controller.abort();
    /* Don't delete from the map here — the displaced job's own loop
       will hit the AnalysisAbortedError catch and call endJob, which
       deregisters only when it's still the current entry. We
       overwrite the map below. */
  }

  const job: AnalysisJob = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir: record.bookDir ?? null,
    engine: selection.engine,
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
    },
    lastDiskWriteAt: 0,
  };
  inFlightAnalysisByManuscript.set(manuscriptId, job);
  if (job.bookDir) markAnalysisBusy(job.bookDir);
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

  /* Run the analyzer in the background. Express won't end this
     response until res.end() is called explicitly (by endJob() inside
     runMainAnalyzerJob), so the response stays open and continues to
     receive broadcast events for the lifetime of the job. */
  void runMainAnalyzerJob(job, record, selection, {
    requestedFresh,
    allowStage1Shrink,
    requestedModel,
    userSettings,
  });
});

export interface MainAnalyzerJobOpts {
  requestedFresh: boolean;
  allowStage1Shrink: boolean;
  /* Plan 88 — when the route layer received an explicit `model` in the
     request body, that per-request id wins (precedence priority 2). Both
     phases resolve through `selectAnalyzerForPhase`, so a present
     `requestedModel` collapses the split to a single model for this run;
     when absent, the saved per-phase models (priority 3) apply. */
  requestedModel: string | undefined;
  /* Plan 118 — read-once user-settings snapshot from request start, so
     per-phase model resolution and the watermark / lag decisions all see
     the same view of the file. Optional: tests and any legacy caller may
     omit it and the job falls back to the in-process cache. */
  userSettings?: UserSettings;
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
   Returns the book's BCP-47 language ('en' default), or 'en' when no book is
   found on disk yet (analysis can run pre-confirm in some paths). Best-effort:
   a lookup failure must never block analysis, so it swallows errors to 'en'. */
export async function resolveBookLanguageForManuscript(manuscriptId: string): Promise<string> {
  try {
    const located = await findBookByManuscriptId(manuscriptId);
    return located ? bookStateLanguage(located.state) : 'en';
  } catch {
    return 'en';
  }
}

export async function runMainAnalyzerJob(
  job: AnalysisJob,
  record: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>,
  selection: AnalyzerSelection,
  opts: MainAnalyzerJobOpts,
): Promise<void> {
  const manuscriptId = job.manuscriptId;
  /* fs-2 — book language for the analyzer preamble + Cyrillic token estimate.
     Resolved once per job; threaded into every runStage* call below. */
  const bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);
  const requestedFresh = opts.requestedFresh;
  const allowStage1Shrink = opts.allowStage1Shrink;
  const abortController = job.controller;
  const analyzer = selection.analyzer;
  const recordRef = record;
  const activeModelId = selection.model;
  const analyzerLabel = engineLabel(selection.engine, activeModelId);
  /* Read-once user-settings snapshot — the handler passes one in; legacy
     callers / tests fall back to the in-process cache. Drives both the
     Phase 1 model resolution and the watermark / lag below so they agree
     with the Phase 0 resolution done in the route handler. */
  const userSettings = opts.userSettings ?? getCachedUserSettings();

  /* Plan 88 / 118 — pipelined two-model analyzer.
     Both phases resolve through `selectAnalyzerForPhase`, which applies
     the documented precedence (env ANALYZER_PHASE{0,1}_MODEL > per-request
     `model` > saved `analyzerPhase{0,1}Model` > default). So:
       - No per-phase models + no per-request model → both phases run the
         same default model (single-model path, unchanged).
       - Per-phase models set + no per-request model → Phase 0 and Phase 1
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
    userSettings,
  });
  const phase1Analyzer = phase1Selection.analyzer;
  const phase1ModelId = phase1Selection.model;
  const phase1AnalyzerLabel = engineLabel(phase1Selection.engine, phase1ModelId);
  const pipelinedPerPhase = !opts.requestedModel && isPerPhaseModelSelectionActive(userSettings);
  if (pipelinedPerPhase) {
    console.log(
      `[analysis] manuscript=${manuscriptId} pipelined ` +
        `phase0=${selection.engine}:${selection.model} ` +
        `phase1=${phase1Selection.engine}:${phase1Selection.model} ` +
        `lag=${resolvePhase1MinLagChapters(userSettings)}`,
    );
  }
  const watermark: PhaseWatermark = createWatermarkForJob(userSettings);

  /* Best-effort GPU/CPU detection for the first-chapter ETA rate (issue 3).
     Only meaningful for local Ollama; cloud engines pass 'unknown' → the
     Gemini rate. Failures degrade to 'unknown' → the CUDA rate (the app's
     target box), and the estimate self-corrects from observed pace anyway. */
  const analyzerDevice: 'cuda' | 'cpu' | 'unknown' =
    selection.engine === 'local' || phase1Selection.engine === 'local'
      ? await detectOllamaDevice()
      : 'unknown';

  const send = (payload: unknown) => {
    broadcastToJob(job, payload);
    trackForReplay(job, payload);
  };
  /* `lastStep` mirrors the most recent phase milestone to the server log (so a
     stall's last log line names where it wedged) and feeds the fatal-error log
     below (so a failure names its phase, not just a stack). */
  let lastStep = 'init';
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

  try {
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
       `fresh` (Start fresh) intentionally discards them, so capture nothing. */
    const priorCastForMerge: Array<{ id: string } & Record<string, unknown>> =
      !requestedFresh && recordRef.bookDir ? await readPriorCastForMerge(recordRef.bookDir) : [];

    /* Heal cross-series/author reuse links carried in the prior cast BEFORE it
       feeds the seed + every cast.json merge below. pruneStaleReuseLinks on the
       freshly-detected roster (further down) drops such a link, but
       mergeAnalysisResultWithExistingCast re-overlays `matchedFrom` straight
       from this prior — so without cleaning the prior the stale link
       resurrects on every re-analysis (a standalone's character holding a
       different series' designed voice). No-op for a clean / empty prior. */
    if (recordRef.bookId && priorCastForMerge.length) {
      await pruneStaleReuseLinks(
        recordRef.bookId,
        priorCastForMerge as unknown as Parameters<typeof pruneStaleReuseLinks>[1],
      );
    }

    if (requestedFresh) {
      await clearAnalysisCache(manuscriptId);
      /* Match the filesystem to the cleared cache state. Without this,
         "Start fresh" leaves the previous run's partial cast.json and
         manuscript-edits.json behind until the new run completes — the
         library card hydration would then briefly show stale cast
         entries against an empty cache. `rm({ force: true })` is a
         no-op when the file doesn't exist (manuscripts uploaded via
         the legacy non-workspace path have no bookDir; the guard
         keeps it cheap). */
      if (recordRef.bookDir) {
        await rm(castJsonPath(recordRef.bookDir), { force: true });
        await rm(manuscriptEditsJsonPath(recordRef.bookDir), { force: true });
        /* Start fresh intentionally discards reuse continuity — drop the
           reparse carryover too so it can't resurrect links (srv-13). */
        await rm(castReuseCarryoverJsonPath(recordRef.bookDir), { force: true });
        /* srv-1 — fresh run regenerates ids from scratch, so old lineage is
           meaningless; drop the merge journal too. */
        await clearCastMerges(recordRef.bookDir);
      }
      log(0, 'Discarded cached progress — starting from scratch.');
    }
    const cache: AnalysisCache = await loadAnalysisCache(manuscriptId);
    const cachedChapters = cache.chapters ?? {};
    const cachedChapterCount = Object.keys(cachedChapters).length;

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
    /* Failure signalling from Phase 0 to Phase 1 and to the post-Promise.all
       handler. When Phase 0 finishes with any chapters still in the failed
       set, we set this so Phase 1 workers can bail without dispatching and
       the outer code can emit the `cast_incomplete` SSE error. */
    let phase0FailedCount = 0;
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
      const fallbackMsPerChar = engineFallbackMsPerChar(selection.engine, analyzerDevice);
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
        await saveAnalysisCache(manuscriptId, cache);
      }
      await persistDroppedQuotesBatch(recordRef.bookDir, manuscriptId, 'analysis-stream', verified);
      send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage) });
      /* Plan 88 follow-up — cache hit: Phase 0 is already complete, so
         the finalised stage1 is the canonical roster for any Phase 1
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
      const cachedCastCount = Object.keys(chapterCast).length;
      const stage0Start = Date.now();
      log(
        0,
        `Detecting cast chapter-by-chapter across ${totalCastChapters} chapter${totalCastChapters === 1 ? '' : 's'} via ${analyzerLabel}…`,
      );
      if (cachedCastCount > 0) {
        log(
          0,
          `Resuming — ${cachedCastCount} of ${totalCastChapters} chapter${cachedCastCount === 1 ? '' : 's'} already cached.`,
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
          if (cast?.length) mergeRosterChapter(r, cast);
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
           Unknown female buckets in the live view — same contract the
           on-disk interim cast.json uses, kept in lockstep so the user
           sees one consistent roster across SSE + .audiobook/. */
        const folded = previewFoldForLiveView(Array.from(roster.values()), bookLanguage);
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
         Chapters in failedChapterIds are re-queued on resume even though
         chapterCast[id] is populated (with []) — without this carve-out
         the failure marker would silently skip them forever, leaving the
         user to either Start fresh or hit the per-chapter Retry button
         one by one for every failed chapter. */
      const failedSet = new Set(cache.failedChapterIds ?? []);
      const castTaskIndices: number[] = [];
      for (let i = 0; i < totalCastChapters; i++) {
        const ch = recordRef.chapterHints[i];
        if (ch.excluded) continue;
        if (!chapterCast[ch.id] || failedSet.has(ch.id)) castTaskIndices.push(i);
      }
      const castConcurrency = readStage2Concurrency();
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
        const msPerCharFallback = engineFallbackMsPerChar(selection.engine, analyzerDevice);
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
        try {
          result = await runStage1Guarded({
            body: ch.body,
            runningRoster: Array.from(rebuildRoster().values()),
            chapterId: ch.id,
            log,
            call: () =>
              runStage1ChapterChunked({
                body: ch.body,
                charBudget: resolveStage1ChunkCharBudget(selection.engine),
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
                    ),
                    {
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
                    },
                  ),
              }).then((r) => ({ characters: r.characters })),
          });
        } catch (chErr) {
          /* Client disconnect propagates up — let the route's outer catch
             land us back at res.end() without a "failed" SSE event. */
          if (chErr instanceof AnalysisAbortedError) throw chErr;
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
          recordFailedChapter(cache, ch.id, classified);
          await saveAnalysisCache(manuscriptId, cache);
          send({
            kind: 'chapter-failed',
            chapterId: ch.id,
            message: classified.userMessage,
            code: classified.code,
            remediation: classified.remediation,
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
        if (clearFailedChapterId(cache, ch.id)) {
          send({ kind: 'chapter-resolved', chapterId: ch.id });
        }
        const chDuration = Date.now() - startedChAt;
        /* Persist this chapter's wall-clock duration so a future resumed
           run can seed its observed-rate trackers without waiting for the
           first new chapter to complete. */
        castDurations[ch.id] = chDuration;
        cache.castDurations = castDurations;
        await saveAnalysisCache(manuscriptId, cache);
        /* Mirror the cache write into cast.json so the book folder reflects
           progress mid-run — without this, a user inspecting `.audiobook/`
           or re-opening the book mid-run sees an empty folder even when
           30+ chapters of cast are already detected. Carries the same
           shape as the post-Phase-1 end-of-run write (palette colours +
           lines:0/scenes:0 placeholders); the final fold-and-attribute
           pass overwrites with the authoritative version. With sticky
           analysis the run survives navigation, so this no longer needs
           a clientGone gate — the cache + cast.json writes are the
           authoritative side effects of progress regardless of
           subscriber count. */
        if (recordRef.bookDir) {
          const interim = buildInterimCast(
            chapterCast,
            recordRef.chapterHints.map((h) => h.id),
            bookLanguage,
          );
          if (interim.length > 0) {
            try {
              await writeJsonAtomic(castJsonPath(recordRef.bookDir), {
                characters: mergeAnalysisResultWithExistingCast(priorCastForMerge, interim),
              });
            } catch (persistErr) {
              console.warn('[analysis] interim cast.json write failed', persistErr);
            }
          }
        }
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
          while (nextCastTask < castTaskIndices.length && !castAborted) {
            const i = castTaskIndices[nextCastTask++];
            try {
              await runCastChapter(i);
            } catch (e) {
              castInFlight.delete(i);
              castAborted = true;
              throw e;
            }
          }
        };
        for (let w = 0; w < Math.min(castConcurrency, castTaskIndices.length); w++) {
          castWorkers.push(launchNextCast());
        }
        await Promise.all(castWorkers);

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
          log(
            0,
            `Phase 0 paused — ${failedCount} chapter${failedCount === 1 ? '' : 's'} still needs cast detection (see ❌ lines above). Phase 1 won't start until every chapter has a roster — retry below or re-run analysis.`,
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
        /* Plan 126 Facet A — establish cross-book reuse links server-side.
           Match each new character against prior same-series confirmed cast
           and stamp `matchedFrom` + a unified `voiceId` + `voiceState:'reused'`
           (+ aliases + denormalised bespoke voice) so continuity is
           authoritative at analysis time, not dependent on the client reaching
           a confirm page. No-op for standalone / earliest-in-series books.
           Mutates `characters` in place so both stage1 and the on-disk cast
           below carry the links. Failure is non-fatal — a reuse-link error
           must never abort an otherwise-good analysis. */
        if (recordRef.bookId) {
          try {
            /* Seed the guard fields (notLinkedTo, matchedFrom) from the prior
               cast BEFORE the link pass — it scores against `characters`, so
               without this it would re-link a pair the user separated and
               re-stamp links already established (srv-13). */
            seedReuseGuardsFromPriorCast(priorCastForMerge, characters);
            const staleDropped = await pruneStaleReuseLinks(recordRef.bookId, characters);
            if (staleDropped > 0) {
              log(
                0,
                `Cleared ${staleDropped} stale reuse link${staleDropped === 1 ? '' : 's'} pointing at a book no longer in this series.`,
              );
            }
            const linked = await linkSeriesReuseAtAnalysis(recordRef.bookId, characters);
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
        stage1 = {
          characters,
          /* Carry the parser's chapter list verbatim — Phase 0a deliberately
             doesn't return a chapters[] field, and stage 2's prompt /
             merging downstream both work off the same list. */
          chapters: recordRef.chapterHints.map((c) => ({ id: c.id, title: c.title })),
        };
        /* Plan 88 follow-up — Phase 0b consolidation produced the final
           roster. Flip `phase1Stage1Ready` BEFORE `markPhase0AllDone()`
           so any Phase 1 waiter released by the watermark sees the
           finalised roster instead of falling back to the rolling
           snapshot. */
        phase1Stage1Ready = true;
        cache.stage1 = stage1;
        await saveAnalysisCache(manuscriptId, cache);
        await persistDroppedQuotesBatch(
          recordRef.bookDir,
          manuscriptId,
          'analysis-stream',
          verified,
        );
        stage1ActualMs = Date.now() - stage0Start;
        send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage) });
        /* Cast.json reflects the verified Phase 0b state before Phase 1's
           attribution pass starts (which can be the longest phase by far
           on a long book). We apply the name-only fold here too — the
           live SSE just emitted the same shape, and the user's mental
           model of "this is what we detected" needs to line up between
           the streaming view and `.audiobook/cast.json` on disk.
           stage1.characters itself stays un-folded for stage-2 attribution
           — the descriptor names need to survive into the stage-2 prompt
           so the model can map dialogue to them. The post-Phase-1 fold
           later overwrites this file with the authoritative counts.
           No clientGone gate: with sticky analysis the run survives
           navigation, so the on-disk state stays in lockstep with the
           broadcast events regardless of subscriber count. */
        if (recordRef.bookDir) {
          try {
            const stage1Cast = attachLinesAndScenes(
              assignPaletteColors(previewFoldForLiveView(stage1.characters, bookLanguage)),
              [],
            );
            await writeJsonAtomic(castJsonPath(recordRef.bookDir), {
              characters: mergeAnalysisResultWithExistingCast(priorCastForMerge, stage1Cast),
            });
          } catch (persistErr) {
            console.warn('[analysis] stage1 cast.json write failed', persistErr);
          }
        }
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
      phase0PoolPromise = runPhase0Pool();
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
      `Attributing ${totalChapters} chapter${totalChapters === 1 ? '' : 's'} with ${phase1AnalyzerLabel}, one at a time…`,
    );
    log(1, `Estimated stage time: ~${humanSeconds(stage2EstMs)} (based on stage 1 rate)`);
    if (cachedChapterCount > 0) {
      log(
        1,
        `Resuming — ${cachedChapterCount} of ${totalChapters} chapter${cachedChapterCount === 1 ? '' : 's'} already cached.`,
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
        if (cachedChapters[next.id]) continue;
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
    const completedSet = new Set<number>();

    /* Replay cached chapters synchronously up front. Cheap, deterministic
       progress, and avoids racing the concurrent pool against the cache.
       Excluded chapters are skipped — they never had attribution run and
       must not be counted as cached. */
    for (let i = 0; i < totalChapters; i++) {
      const ch = recordRef.chapterHints[i];
      if (ch.excluded) continue;
      const cached = cachedChapters[ch.id];
      if (cached && cached.length > 0) {
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

    const concurrency = readStage2Concurrency();
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

    async function runChapter(i: number): Promise<void> {
      const ch = recordRef.chapterHints[i];
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
      /* Plan 88 follow-up — if Phase 0 finished with failed cast
         chapters, `runPhase0Pool` set `phase0FailedCount` and called
         `markPhase0AllDone` to release us. Exit cleanly without
         dispatching the Phase 1 call — the outer post-Promise.all
         handler emits the `cast_incomplete` SSE error. Returning
         here also keeps the worker pool's normal early-termination
         path intact (no thrown error, no `aborted = true`). */
      if (phase0FailedCount > 0) return;
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

      const tickOverall = (elapsed: number) => {
        const slot = inFlight.get(i);
        if (slot) {
          slot.elapsedMs = elapsed;
          /* Mid-chapter ETA refinement (issue 3): sentence-aware estimate band
             (selectChapterEstMs) prefers the sentence projection over bytes,
             never returns the stage value, never blanks to ~. */
          refineEstMs(slot, elapsed);
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
        onWaiting: (elapsed) => tickOverall(elapsed),
        /* Per-chunk heartbeat so the user sees evidence of model output
           on each chapter. Stage 2's existing wall-clock heartbeat log
           lines already cover the silence-watchdog purpose. */
        onChunk: (info) => {
          /* Track the running output bytes every chunk (cheap) so the
             mid-chapter ETA projection has fresh data even when onWaiting is
             quiet during active streaming. */
          const liveSlot = inFlight.get(i);
          if (liveSlot) {
            liveSlot.receivedBytes = info.receivedBytes;
            liveSlot.inflightSentences = countStreamedSentences(info.receivedText);
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
          const charsPerSec =
            info.elapsedMs > 0 ? Math.round((info.receivedBytes * 1000) / info.elapsedMs) : 0;
          send({
            kind: 'heartbeat',
            phaseId: 1,
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
         is exactly one guarded call (unchanged). */
      const {
        sentences: stage2Sentences,
        coverage: coverageVerdict,
        chunkCount: stage2ChunkCount,
      } = await attributeChapterStage2({
        analyzer: phase1Analyzer,
        manuscriptId,
        title: recordRef.title,
        stage1: phase1Stage1,
        chapter: ch,
        stageCall: stage2Call,
        engine: phase1Selection.engine,
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
      });
      if (stage2ChunkCount > 1) {
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — large chapter attributed in ${stage2ChunkCount} sections to stay under the model output cap.`,
        );
      }
      if (!coverageVerdict.ok) {
        console.warn(
          `[analysis] chapter ${ch.id} stage2 coverage SUSPECT after retries: ${coverageVerdict.issues.join(' ')}`,
        );
        log(
          1,
          `Chapter ${i + 1}/${totalChapters} — ⚠ attribution may be incomplete (${
            coverageVerdict.issues[0] ?? 'low coverage'
          }); kept the best take and flagged the chapter for retry.`,
        );
        const copy = FAILURE_REMEDIATIONS['attribution-incomplete'];
        recordFailedChapter(cache, ch.id, {
          code: 'attribution-incomplete',
          userMessage: copy.userMessage,
          remediation: copy.remediation,
        });
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: copy.userMessage,
          code: 'attribution-incomplete',
          remediation: copy.remediation,
        });
      }
      for (const s of stage2Sentences) s.chapterId = ch.id;
      sentencesByChapter.set(ch.id, stage2Sentences);
      cachedChapters[ch.id] = stage2Sentences;
      cache.chapters = cachedChapters;
      /* Persist this chapter's wall-clock duration so a future resumed run
         can seed its observed-rate trackers without waiting for the first
         new chapter to complete. */
      const chDurationForCache = Date.now() - startedAt;
      stage2Durations[ch.id] = chDurationForCache;
      cache.stage2Durations = stage2Durations;
      /* Cache + edits writes are atomic-rename and JS is single-threaded, so
         concurrent saves serialise naturally. Worst case is two near-
         simultaneous writes overlap and the second wins — both contain the
         same set + the freshly-completed chapter, so the merge is safe. */
      await saveAnalysisCache(manuscriptId, cache);
      if (recordRef.bookDir) {
        try {
          /* Rebuild the running narrative from the chapter map so order is
             always correct regardless of which chapter completes first. */
          const running: SentenceOutput[] = [];
          for (const order of recordRef.chapterHints) {
            const arr = sentencesByChapter.get(order.id);
            if (arr) running.push(...arr);
          }
          await writeJsonAtomic(manuscriptEditsJsonPath(recordRef.bookDir), { sentences: running });
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

    /* Plan 88 follow-up — wrap the Phase 1 worker pool in an async
       function so it can run concurrently with `runPhase0Pool` via
       Promise.all below. The pool's internal shape is unchanged; only
       the outer await moved. */
    const runPhase1Pool = async (): Promise<void> => {
      /* Concurrency pool — keep up to `concurrency` chapters in flight at
         a time. The first failure aborts new task dispatch, but already-
         running tasks finish their work and write to the cache, so a
         resume picks up cleanly from where the run left off. */
      let nextTask = 0;
      let aborted = false;
      const workers: Promise<void>[] = [];
      const launchNext = async (): Promise<void> => {
        while (nextTask < taskIndices.length && !aborted) {
          const i = taskIndices[nextTask++];
          try {
            await runChapter(i);
          } catch (e) {
            inFlight.delete(i);
            aborted = true;
            throw e;
          }
        }
      };
      for (let w = 0; w < Math.min(concurrency, taskIndices.length); w++) {
        workers.push(launchNext());
      }
      await Promise.all(workers);
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

    /* Plan 88 follow-up — Phase 0 ended with failed cast chapters; emit
       the `cast_incomplete` SSE error and bail. Phase 1 workers exited
       cleanly via the in-flight `phase0FailedCount` check above (they
       were released by `markPhase0AllDone` inside the Phase 0 failure
       branch). */
    if (phase0FailedCount > 0) {
      endJob(job, {
        kind: 'error',
        code: 'cast_incomplete',
        message: `Phase 0 paused — ${phase0FailedCount} chapter${phase0FailedCount === 1 ? '' : 's'} failed cast detection. Retry below to continue.`,
      });
      return;
    }

    /* Stitch the per-chapter results into narrative order. */
    for (const ch of record.chapterHints) {
      const arr = sentencesByChapter.get(ch.id);
      if (arr) allSentences.push(...arr);
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
    send({ kind: 'phase', phaseId: 1, progress: 1, label: PHASES[1].label, model: phase1ModelId });

    /* ── Phase 2: matching library — empty for first slice. */
    markPhase(2);
    log(2, 'No library matches yet (voice library matching is not wired up for this slice).');
    for (let i = 1; i <= 3; i++) {
      send({ kind: 'phase', phaseId: 2, progress: i / 3, label: PHASES[2].label });
      await new Promise((r) => setTimeout(r, PHASES[2].durationMs / 3));
    }

    /* ── Compose the AnalyseResponse. */
    const chapterTitleById = new Map(stage1.chapters.map((c) => [c.id, c.title]));
    const chapters = record.chapterHints.map((h) => ({
      id: h.id,
      title: chapterTitleById.get(h.id) ?? h.title,
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
    /* Recover dialogue lines stage-2 left on the narrator (a prose-tagged
       speaker who is in the roster but got 0 attributed lines) BEFORE the fold
       counts lines, so the fold doesn't drop them as 0-line. */
    const recovered = recoverTaggedNarratorLines(allSentences, stage1.characters);
    if (recovered.flipped > 0) {
      const summary = [...recovered.byId.entries()].map(([id, n]) => `${id}=${n}`).join(', ');
      log(
        1,
        `Recovered ${recovered.flipped} narrator-attributed line(s) to tagged speakers (${summary}).`,
      );
    }
    const folded = foldMinorCast(stage1.characters, recovered.sentences, {
      minLines: userSettings.minorCastMinLines,
      language: bookLanguage,
    });
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

    const characters = attachLinesAndScenes(
      assignPaletteColors(folded.characters),
      folded.sentences,
    );

    /* Phase 1 character-id reconciliation (see reconcileSentenceCharacterIds
       comment for motivation). Demote orphan ids to narrator before the
       manuscript-edits write; abort with `attribution_drift` if the
       demotion rate exceeds the threshold on a non-trivial sample so the
       confirm screen never advances against a corrupted run. */
    const phase1ValidIds = new Set(characters.map((c) => c.id));
    const demotedByChapter = new Map<number, number>();
    const reconciled = reconcileSentenceCharacterIds(folded.sentences, phase1ValidIds, {
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
    if (record.bookDir) {
      try {
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), {
          sentences: reconciled.sentences,
        });
        /* srv-1 — record this fold pass's lineage (see writeFoldJournal). Non-fatal:
           a journal failure must never fail the analysis persist. */
        try {
          await writeFoldJournal(
            record.bookDir,
            folded.rewrites,
            recovered.sentences,
            stage1.characters,
          );
        } catch (journalErr) {
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
        if (phase1DriftExceeded) {
          log(
            1,
            `Attribution drift exceeded threshold (${reconciled.demotedCount}/${folded.sentences.length} ≈ ${Math.round((100 * reconciled.demotedCount) / folded.sentences.length)}%) — refusing to flip cast.json / state.json. Retry analysis to re-attribute.`,
          );
        } else {
          await writeJsonAtomic(castJsonPath(record.bookDir), {
            characters: mergeAnalysisResultWithExistingCast(priorCastForMerge, characters),
          });
          await logCarriedForwardCharacters(
            record.bookDir,
            voicedSurvivorsDropped(priorCastForMerge, characters),
          );
          const statePath = stateJsonPath(record.bookDir);
          const prev = await readJson<BookStateJson>(statePath);
          if (prev) {
            /* Preserve the user-owned flags — analysis owns chapter titles/
               durations, the user owns `excluded` and `held`. Match on id so a
               re-run after a re-parse picks up whichever ids the parser
               produced. `held` (the "Not queued" intent) can't be re-derived
               from disk like the audio metadata can, so dropping it here would
               silently lose the user's choice — see the chapter `held` doc in
               workspace/scan.ts. */
            const prevExcludedById = new Map<number, boolean>();
            const prevHeldById = new Map<number, boolean>();
            for (const c of prev.chapters) {
              if (c.excluded) prevExcludedById.set(c.id, true);
              if (c.held) prevHeldById.set(c.id, true);
            }
            const next: BookStateJson = {
              ...prev,
              chapters: chapters.map((c) => ({
                id: c.id,
                title: c.title,
                slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
                duration: c.duration,
                excluded: prevExcludedById.get(c.id) || undefined,
                held: prevHeldById.get(c.id) || undefined,
              })),
              updatedAt: new Date().toISOString(),
            };
            await writeJsonAtomic(statePath, stampStateSchema(next));
          }
        }
      } catch (persistErr) {
        console.error('[analysis] failed to persist .audiobook/* for', record.bookDir, persistErr);
        // Non-fatal — the analysis result still streams back to the client.
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
        message: `Phase 1 demoted ${reconciled.demotedCount} of ${folded.sentences.length} sentences (${Math.round((100 * reconciled.demotedCount) / folded.sentences.length)}%) to narrator — model attribution unreliable. Retry analysis to re-attribute.`,
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
    } = classifyAnalysisFailure(e, analyzerLabel);
    endJob(job, { kind: 'error', code, message, remediation, detail });
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
       is idempotent with this one (same phase + state). */
    await persistTerminalSnapshot(job, 'paused', { code: 'aborted', message: 'Analysis paused.' });
    job.controller.abort();
    paused = true;
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  /* Vite dev-proxy keep-alive shim — see the comment on the parent
     analysis route. Same hazard (silence during getOrHydrateManuscript)
     applies on a cold subset retry. */
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

  const body = req.body as { chapterIds?: unknown; model?: unknown; allowStage1Shrink?: unknown };
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
     produce a confusing "chapter not found mid-stream" log line. */
  const hintsById = new Map(record.chapterHints.map((h) => [h.id, h]));
  const targets = requestedIds
    .map((id) => hintsById.get(id))
    .filter((h): h is NonNullable<typeof h> => !!h);
  if (targets.length === 0) {
    send({
      kind: 'error',
      code: 'bad_request',
      message: 'None of the requested chapter ids match this manuscript.',
    });
    clearInterval(keepAlive);
    return res.end();
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
    return res.end();
  }
  const toRun = targets.filter((h) => !h.excluded);

  /* ── Plan 32 D1 subscribe-vs-start dispatch.
     Mirrors the main /:id/analysis route's pattern. If a non-aborted
     subset job is already running for this manuscript, the new request
     joins the existing job's subscriber set and catches up on the
     replay state — same shape as a browser-reload or navigate-back
     reattach for the main run. Otherwise we register a new sticky job
     and spawn the analyzer work detached so the user can navigate
     away without aborting the retry. */
  const existing = inFlightSubsetByManuscript.get(manuscriptId);
  if (existing && !existing.controller.signal.aborted) {
    const subscriber: AnalysisSubscriber = { send, res, keepAlive };
    existing.subscribers.add(subscriber);
    replayCatchUp(existing, send);
    res.on('close', () => {
      if (res.writableEnded) return;
      existing.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — sticky semantics. The retry keeps running until
         /pause or terminal completion. */
    });
    res.on('finish', () => clearInterval(keepAlive));
    return;
  }

  const requestedModel = typeof body?.model === 'string' ? body.model : undefined;
  /* Plan 118 — resolve cast (Phase 0) and attribution (Phase 1) analyzers
     via the per-phase selector so a saved split applies to the subset
     retry too. This path is sequential (no watermark); the split only
     changes which model each pass uses. */
  const userSettings = await readUserSettings();
  let selection: AnalyzerSelection;
  let phase1Selection: AnalyzerSelection;
  try {
    selection = selectAnalyzerForPhase({ phase: 'phase0', model: requestedModel, userSettings });
    phase1Selection = selectAnalyzerForPhase({
      phase: 'phase1',
      model: requestedModel,
      userSettings,
    });
  } catch (e) {
    send({ kind: 'error', message: (e as Error).message });
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
    subsetChapterIds: toRun.map((t) => t.id),
    bookDir: record.bookDir ?? null,
    engine: selection.engine,
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
    },
    lastDiskWriteAt: 0,
  };
  inFlightSubsetByManuscript.set(manuscriptId, job);
  if (job.bookDir) markAnalysisBusy(job.bookDir);
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

  /* Run the subset analyzer in the background. The route response is
     held open by the detached promise's broadcast loop until endJob
     fires res.end() on every subscriber. */
  void runSubsetAnalyzerJob(
    job,
    record,
    selection,
    phase1Selection,
    toRun,
    allowStage1ShrinkSubset,
  );
});

/* Detached subset-retry analyzer body. Extracted from the request
   handler in plan 32 D1 so the work survives a client disconnect
   (sticky semantics). Broadcasts every event to job.subscribers and
   tracks replay state via trackForReplay; endJob handles teardown +
   map deregistration on every exit path. */
async function runSubsetAnalyzerJob(
  job: AnalysisJob,
  record: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>,
  selection: AnalyzerSelection,
  phase1Selection: AnalyzerSelection,
  toRun: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>['chapterHints'],
  allowStage1ShrinkSubset: boolean,
): Promise<void> {
  const manuscriptId = job.manuscriptId;
  /* fs-2 — book language for the analyzer preamble + Cyrillic token estimate. */
  const bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);
  const abortController = job.controller;
  const analyzer = selection.analyzer;
  const analyzerLabel = engineLabel(selection.engine, selection.model);
  const subsetModelId = selection.model;
  /* Plan 118 — Phase 1 (attribution) analyzer for the subset retry; equals
     `selection` when no split is configured. */
  const phase1Analyzer = phase1Selection.analyzer;
  const phase1AnalyzerLabel = engineLabel(phase1Selection.engine, phase1Selection.model);
  const phase1ModelId = phase1Selection.model;

  const send = (payload: unknown) => {
    broadcastToJob(job, payload);
    trackForReplay(job, payload);
  };
  /* `lastStep` is a breadcrumb of the most recent phase milestone — mirrored to
     the server log (so a stall's last server-log line names where it wedged)
     and folded into the fatal-error log below (so a failure names the phase it
     died in, not a bare stack). The 2026-06-06 ch12 incident surfaced only as
     "sentences.map is not a function" with no phase/chapter context. */
  let lastStep = 'init';
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
  const priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = record.bookDir
    ? await readPriorCastForMerge(record.bookDir)
    : [];

  /* Heal cross-series/author reuse links in the prior cast before it feeds the
     seed + cast.json merges (see the streaming path for the full rationale —
     the merge re-overlays a stale `matchedFrom` the roster-side prune already
     dropped). No-op for a clean / empty prior. */
  if (record.bookId && priorCastForMerge.length) {
    await pruneStaleReuseLinks(
      record.bookId,
      priorCastForMerge as unknown as Parameters<typeof pruneStaleReuseLinks>[1],
    );
  }

  /* Used inside the persist guards below in place of the old `clientGone`
     flag. The detached job survives the original requester disconnecting,
     but it still respects an explicit /pause via abortController.signal —
     a paused retry shouldn't keep writing cast.json out from under the
     user's hands. */
  const isAborted = (): boolean => abortController.signal.aborted;

  try {
    const cache: AnalysisCache = await loadAnalysisCache(manuscriptId);
    const chapterCast: Record<number, CharacterOutput[]> = cache.chapterCast ?? {};
    const cachedChapters = cache.chapters ?? {};
    /* The subset route serves two flows: (a) un-exclude an
       excluded chapter from a finished book (Phase 0a + Phase 1
       attribution land here), (b) retry a chapter that failed Phase
       0a in a still-paused run (cast_incomplete gate). They have
       different needs:
       - (a) main pipeline is finished; subset attributes the new
         chapter and emits a fresh result.
       - (b) main pipeline never ran Phase 1; subset must NOT
         attribute piecemeal because the global cast may still grow
         (the user could retry more chapters next) and Phase 1's
         folding/lines/scenes pass needs the whole sentence set.
       The clean signal: did cache.stage1 exist BEFORE this batch?
       Yes → flow (a). No → flow (b); skip Phase 1, end after
       cast-update so the analysing view's auto-resume kicks the
       full /analysis/stream which runs Phase 1 globally. */
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
        if (cast?.length) mergeRosterChapter(r, cast);
      }
      return r;
    };
    const emitCastUpdate = (): void => {
      const roster = rebuildRoster();
      const folded = previewFoldForLiveView(Array.from(roster.values()), bookLanguage);
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
      try {
        const result = await runStage1Guarded({
          body: ch.body,
          runningRoster: Array.from(rebuildRoster().values()),
          chapterId: ch.id,
          log,
          call: () =>
            runStage1ChapterChunked({
              body: ch.body,
              charBudget: resolveStage1ChunkCharBudget(selection.engine),
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
                  ),
                  {
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
                  },
                ),
            }).then((r) => ({ characters: r.characters })),
        });
        chapterCast[ch.id] = result.characters;
        cache.chapterCast = chapterCast;
        const wasFailed = clearFailedChapterId(cache, ch.id);
        await saveAnalysisCache(manuscriptId, cache);
        /* Emit chapter-resolved so the analysing view's Retry row clears
           in real time. The view used to rely on the next book-state
           fetch (or on the .then() handler in the FE retry promise) to
           hide the row, which left visible stale state during the
           seconds between Phase 0a success and the route returning. */
        if (wasFailed) send({ kind: 'chapter-resolved', chapterId: ch.id });
        /* Mirror the cache write into cast.json so a subset retry's
           progress is reflected on disk too — matches the full route's
           interim write contract. Skipped on abort: a paused retry
           shouldn't keep writing cast.json out from under the user. */
        if (record.bookDir && !isAborted()) {
          const interim = buildInterimCast(
            chapterCast,
            record.chapterHints.map((h) => h.id),
            bookLanguage,
          );
          if (interim.length > 0) {
            try {
              await writeJsonAtomic(castJsonPath(record.bookDir), {
                characters: mergeAnalysisResultWithExistingCast(priorCastForMerge, interim),
              });
            } catch (persistErr) {
              console.warn('[analysis-subset] interim cast.json write failed', persistErr);
            }
          }
        }
        log(
          0,
          `Chapter ${ch.id} cast — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'} detected.`,
        );
        emitCastUpdate();
      } catch (chErr) {
        if (chErr instanceof AnalysisAbortedError) throw chErr;
        chapterCast[ch.id] = [];
        cache.chapterCast = chapterCast;
        const classified = classifyAnalysisFailure(chErr, analyzerLabel);
        recordFailedChapter(cache, ch.id, classified);
        await saveAnalysisCache(manuscriptId, cache);
        log(0, `❌ Chapter ${ch.id} cast FAILED — ${ch.title}: ${(chErr as Error).message}`);
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: classified.userMessage,
          code: classified.code,
          remediation: classified.remediation,
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
    const finalRoster = rebuildRoster();
    const rawCharacters = Array.from(finalRoster.values());
    sortEvidence(rawCharacters);
    const verified = verifyEvidenceAgainstSource(rawCharacters, record.sourceText, (msg) =>
      log(0, msg),
    );
    const characters = dropEvidencelessCast(rawCharacters, (msg) => log(0, msg), record.sourceText);
    const stage1: Stage1Output = {
      characters,
      chapters: record.chapterHints.map((c) => ({ id: c.id, title: c.title })),
    };
    const remainingFailedCastIds = cache.failedChapterIds ?? [];
    /* Coverage gate (in addition to the no-failed-chapters check) — stage1
       is finalised only when EVERY non-excluded chapter has a non-empty
       chapterCast entry. Without this guard a sparse cache (chapters 1–N
       run, chapters N+1.. untouched) would let rebuildRoster() produce a
       partial roster that overwrites a richer existing stage1. See the
       comment on isPhase0aCoverageComplete for the regression that
       motivated this gate. */
    const coverage = isPhase0aCoverageComplete(chapterCast, record.chapterHints);
    /* Stage 1 shrink guard — see comment on stage1ShrinkRefused. The
       prior count is captured BEFORE the assignment so a no-op rewrite
       (same count) doesn't trip the gate; only meaningful shrinks do. */
    const subsetPrevStage1Count = cache.stage1?.characters.length ?? 0;
    const subsetNextStage1Count = stage1.characters.length;
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
      await saveAnalysisCache(manuscriptId, cache);
      endJob(job, {
        kind: 'error',
        code: 'stage1_shrink_refused',
        message: `Cast finalisation would drop from ${subsetPrevStage1Count} to ${subsetNextStage1Count} characters. Confirm via allowStage1Shrink to accept the smaller roster.`,
        prevCharCount: subsetPrevStage1Count,
        nextCharCount: subsetNextStage1Count,
      });
      return;
    }
    if (remainingFailedCastIds.length === 0 && coverage.complete) {
      cache.stage1 = stage1;
    } else if (remainingFailedCastIds.length === 0 && !coverage.complete) {
      const covered = coverage.totalRequired - coverage.missingChapterIds.length;
      log(
        0,
        `Cast finalisation deferred — ${coverage.missingChapterIds.length} non-excluded chapter${coverage.missingChapterIds.length === 1 ? '' : 's'} still need Phase 0a detection (${covered}/${coverage.totalRequired} covered). Existing stage1 left intact; run the main analysis to fill the gaps.`,
      );
      send({
        kind: 'error',
        code: 'cast_incomplete',
        message: `Phase 0a covers ${covered} of ${coverage.totalRequired} chapters — run main analysis to detect the rest before stage1 can finalise.`,
      });
    }
    await saveAnalysisCache(manuscriptId, cache);
    await persistDroppedQuotesBatch(record.bookDir, manuscriptId, 'analysis-chapters', verified);
    send({ kind: 'cast-update', characters: previewFoldForLiveView(stage1.characters, bookLanguage) });
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
        `Cast retry done. ${remainingFailedCastIds.length} chapter${remainingFailedCastIds.length === 1 ? '' : 's'} still need retry before Phase 1 can run.`,
      );
      /* No final event — clean end without a kind:'error' branch.
         endJob skips the on-disk paused/halted write in this path,
         which matches the "soft" semantics this exit had pre-D1. */
      endJob(job);
      return;
    }
    if (!coverage.complete) {
      endJob(job);
      return;
    }
    /* Retry-after-cast-incomplete flow: the main pipeline hasn't run
       Phase 1 globally, so attributing JUST `toRun` here would emit a
       result with only those chapters' sentences and the view's
       onComplete would advance to the confirm screen with a near-empty
       book. End cleanly instead — the client's auto-resume effect
       will fire /analysis/stream which discovers cache.stage1 is set
       and runs Phase 1 across every chapter. */
    if (!stage1Existed) {
      log(
        0,
        'All cast detection retries succeeded — resuming full analysis to run Phase 1 globally.',
      );
      endJob(job);
      return;
    }
    send({
      kind: 'phase',
      phaseId: 1,
      progress: 0.02,
      label: PHASES[1].label,
      model: phase1ModelId,
    });
    for (let idx = 0; idx < toRun.length; idx++) {
      const ch = toRun[idx];
      log(1, `Chapter ${ch.id} — ${ch.title}: attributing sentences via ${phase1AnalyzerLabel}…`);
      /* #528 — use the same resilient runner as the main route: coverage guard
         + large-chapter chunking. The subset (Re-analyse) path previously made
         a bare runStage2Chapter call with no guard and no chunking, so a large
         chapter (The Drowning Bell ch19, 507 sentences) truncated mid-JSON, threw,
         and discarded the whole job — the reported failure. */
      const { sentences: chapterSentences, chunkCount: subsetChunkCount } =
        await attributeChapterStage2({
          analyzer: phase1Analyzer,
          manuscriptId,
          title: record.title,
          stage1,
          chapter: ch,
          engine: phase1Selection.engine,
          stageCall: {
            signal: abortController.signal,
            language: bookLanguage,
            onWaiting: () => emitHeartbeat(1, ch.id),
            onChunk: (info) => emitHeartbeat(1, ch.id, info),
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
        });
      if (subsetChunkCount > 1) {
        log(
          1,
          `Chapter ${ch.id} — large chapter attributed in ${subsetChunkCount} sections to stay under the model output cap.`,
        );
      }
      for (const s of chapterSentences) s.chapterId = ch.id;
      cachedChapters[ch.id] = chapterSentences;
      cache.chapters = cachedChapters;
      await saveAnalysisCache(manuscriptId, cache);
      /* Roll a partial manuscript-edits.json after each chapter completes, so a
         LATER chapter's failure no longer discards the chapters that already
         succeeded (#528 — pre-fix the subset route only wrote edits once at the
         very end). Mirrors the main route's per-chapter persist. */
      if (record.bookDir) {
        try {
          const running: SentenceOutput[] = [];
          for (const order of record.chapterHints) {
            if (order.excluded) continue;
            const arr = cachedChapters[order.id];
            if (arr) running.push(...arr);
          }
          await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), { sentences: running });
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

    /* Stitch the full sentence list across all cached chapters (old + new),
       in narrative order. Excluded chapters contribute nothing. */
    const allSentences: SentenceOutput[] = [];
    for (const h of record.chapterHints) {
      if (h.excluded) continue;
      const arr = cachedChapters[h.id];
      if (arr) allSentences.push(...arr);
    }

    /* Recover narrator-stranded tagged-speaker lines before the fold (see the
       main route's same block) so a re-analysed chapter's tagged speakers get
       their lines + aren't dropped as 0-line. */
    const recovered = recoverTaggedNarratorLines(allSentences, stage1.characters);
    if (recovered.flipped > 0) {
      const summary = [...recovered.byId.entries()].map(([id, n]) => `${id}=${n}`).join(', ');
      log(
        1,
        `Recovered ${recovered.flipped} narrator-attributed line(s) to tagged speakers (${summary}).`,
      );
    }
    /* Re-fold the cast against the merged sentence set so the bucket
       attributions stay coherent with the new chapters' attributions. */
    const folded = foldMinorCast(stage1.characters, recovered.sentences, {
      language: bookLanguage,
    });
    if (folded.summary.droppedSilent > 0) {
      const sample = folded.dropped.slice(0, 4).join(', ');
      const more = folded.dropped.length > 4 ? `, +${folded.dropped.length - 4} more` : '';
      log(
        1,
        `Dropped ${folded.summary.droppedSilent} non-speaking character${folded.summary.droppedSilent === 1 ? '' : 's'} from the cast (${sample}${more}) — no attributed dialogue, narrator covers them.`,
      );
    }
    const enriched = attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences);

    /* Plan 126 Facet A on the chapter-retry path (srv-13) — a book completed
       solely via this path never ran the link pass and persisted an unlinked
       cast.json. Seed the guard fields from the prior cast first, then link.
       Mirrors the main route's pass; failure is non-fatal. */
    if (record.bookId) {
      try {
        seedReuseGuardsFromPriorCast(priorCastForMerge, enriched);
        const staleDropped = await pruneStaleReuseLinks(record.bookId, enriched);
        if (staleDropped > 0) {
          log(
            0,
            `Cleared ${staleDropped} stale reuse link${staleDropped === 1 ? '' : 's'} pointing at a book no longer in this series.`,
          );
        }
        const linked = await linkSeriesReuseAtAnalysis(record.bookId, enriched);
        if (linked > 0) {
          log(
            0,
            `Linked ${linked} recurring character${linked === 1 ? '' : 's'} to prior books in this series (Reused).`,
          );
        }
      } catch (linkErr) {
        console.warn('[analysis] subset series reuse-link pass failed', linkErr);
      }
    }

    /* Phase 1 character-id reconciliation — see the main route's same
       block plus the comment on reconcileSentenceCharacterIds. The
       subset path is just as exposed to orphan ids (one subset chapter
       attributing to a fabricated id, or a previously-good roster that
       shrunk between attribution and persist), so the same guard
       applies here. */
    const subsetValidIds = new Set(enriched.map((c) => c.id));
    const subsetDemotedByChapter = new Map<number, number>();
    const subsetReconciled = reconcileSentenceCharacterIds(folded.sentences, subsetValidIds, {
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

    const chapterTitleById = new Map(stage1.chapters.map((c) => [c.id, c.title]));
    const chaptersOut = record.chapterHints.map((h) => ({
      id: h.id,
      title: chapterTitleById.get(h.id) ?? h.title,
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
       Skipped when the job was aborted via /pause — a paused retry
       shouldn't flip the library status out from under the user.
       Also skipped (for cast.json / state.json) when attribution drift
       exceeded the threshold — same reasoning as the main route's
       persist block. */
    if (record.bookDir && !isAborted()) {
      try {
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), {
          sentences: subsetReconciled.sentences,
        });
        /* srv-1 — record this fold pass's lineage (see writeFoldJournal). Non-fatal:
           a journal failure must never fail the analysis persist. */
        try {
          await writeFoldJournal(
            record.bookDir,
            folded.rewrites,
            recovered.sentences,
            stage1.characters,
          );
        } catch (journalErr) {
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
        if (subsetDriftExceeded) {
          log(
            1,
            `Attribution drift exceeded threshold (${subsetReconciled.demotedCount}/${folded.sentences.length} ≈ ${Math.round((100 * subsetReconciled.demotedCount) / folded.sentences.length)}%) — refusing to flip cast.json / state.json. Retry analysis to re-attribute.`,
          );
        } else {
          await writeJsonAtomic(castJsonPath(record.bookDir), {
            characters: mergeAnalysisResultWithExistingCast(priorCastForMerge, enriched),
          });
          await logCarriedForwardCharacters(
            record.bookDir,
            voicedSurvivorsDropped(priorCastForMerge, enriched),
          );
          const statePath = stateJsonPath(record.bookDir);
          const prev = await readJson<BookStateJson>(statePath);
          if (prev) {
            /* Preserve the user-owned `excluded` + `held` flags across the
               subset re-attribution — `held` (the "Not queued" intent) isn't
               re-derivable from disk, so it must ride through here. */
            const prevExcludedById = new Map<number, boolean>();
            const prevHeldById = new Map<number, boolean>();
            for (const c of prev.chapters) {
              if (c.excluded) prevExcludedById.set(c.id, true);
              if (c.held) prevHeldById.set(c.id, true);
            }
            const next: BookStateJson = {
              ...prev,
              chapters: chaptersOut.map((c) => ({
                id: c.id,
                title: c.title,
                slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
                duration: c.duration,
                excluded: prevExcludedById.get(c.id) || undefined,
                held: prevHeldById.get(c.id) || undefined,
              })),
              updatedAt: new Date().toISOString(),
            };
            await writeJsonAtomic(statePath, stampStateSchema(next));
          }
        }
      } catch (persistErr) {
        console.error(
          '[analysis-subset] failed to persist .audiobook/* for',
          record.bookDir,
          persistErr,
        );
      }
    }

    if (subsetDriftExceeded) {
      endJob(job, {
        kind: 'error',
        code: 'attribution_drift',
        message: `Phase 1 demoted ${subsetReconciled.demotedCount} of ${folded.sentences.length} sentences (${Math.round((100 * subsetReconciled.demotedCount) / folded.sentences.length)}%) to narrator — model attribution unreliable. Retry analysis to re-attribute.`,
      });
      return;
    }

    endJob(job, { kind: 'result', response });
  } catch (e) {
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
    const {
      code,
      userMessage: message,
      remediation,
      detail,
    } = classifyAnalysisFailure(e, analyzerLabel);
    console.error('[analysis-subset] failed', {
      manuscriptId,
      code,
      message,
      lastStep,
      stack: (e as Error)?.stack,
    });
    endJob(job, { kind: 'error', code, message, remediation, detail });
  }
}

/* describeError, formatErrorDetail, trimQuotaMessage, tryParseApiError, and
   classifyStatus have been moved to failure-taxonomy.ts (classifyAnalysisFailure
   / tryParseApiError exported). Call sites above now use classifyAnalysisFailure.
   Note: classifyStatus was renamed statusToFailureCode (private) in its new home. */
