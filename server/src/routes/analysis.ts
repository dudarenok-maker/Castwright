/* POST /api/manuscripts/:id/analysis — SSE stream.
   Events are sent as `data: <json>\n\n`. Two payload shapes:
     { kind: 'phase',  phaseId, progress, label? }
     { kind: 'result', response: AnalyseResponse }
   The frontend's `real.analyseManuscript` reads this with fetch + ReadableStream. */

import { rm } from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { selectAnalyzer, type AnalyzerSelection } from '../analyzer/index.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { foldMinorCast } from '../analyzer/fold-minor-cast.js';
import { readUserSettings } from '../workspace/user-settings.js';
import { clearAnalysisCache, loadAnalysisCache, saveAnalysisCache, type AnalysisCache } from '../store/analysis-cache.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { castJsonPath, manuscriptEditsJsonPath, slug, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { BookStateJson } from '../workspace/scan.js';
import { normaliseForMatch as normaliseForMatchShared } from '../util/text-match.js';
import {
  appendBatch,
  loadDroppedQuotes,
  saveDroppedQuotes,
  truncateQuote,
  type DropReason,
  type DroppedQuoteEntry,
  type DroppedQuotesBatch,
} from '../store/dropped-quotes.js';

/* Human-readable label for a Gemini model id. Kept in lockstep with
   src/lib/models.ts MODEL_OPTIONS — the frontend sends the id, we render
   the friendly name in logs and the SSE event stream. */
const MODEL_LABELS: Record<string, string> = {
  'gemini-2.5-flash':         'Gemini 2.5 Flash',
  'gemini-3-flash-preview':   'Gemini 3 Flash',
  'gemini-3.1-flash-lite':    'Gemini 3.1 Flash Lite',
  'gemma-4-31b-it':           'Gemma 4 31B',
  'gemma-4-26b-a4b-it':       'Gemma 4 26B',
};

function humanModel(modelId: string | undefined): string {
  if (!modelId) return 'cowork reviewer';
  return MODEL_LABELS[modelId] ?? modelId;
}

/** Engine-aware label so SSE chunks read "Ollama (qwen3.5:9b)" for the
    local analyzer and "Gemma 4 31B" for Gemini. The MODEL_LABELS lookup
    only covers Gemini ids, so the local branch surfaces the raw tag —
    which is fine, Ollama tags are already human-readable. */
function engineLabel(engine: 'local' | 'gemini', modelId: string): string {
  return engine === 'local' ? `Ollama (${modelId})` : humanModel(modelId);
}

/* Front-end palette has 30 character slots (see src/lib/colors.ts
   CHAR_COLORS + CHARACTER_SLOTS). Gemini and humans both like to invent
   character-specific kebab names like `keefe` that don't exist in the
   palette and fall back to grey. We normalise here: narrator keeps its
   slot; everyone else gets a slot in roster order, cycling after 30.
   Order must match src/lib/colors.ts CHARACTER_SLOTS. */
const PALETTE_SLOTS = [
  'halloran', 'eliza', 'marcus',
  ...Array.from({ length: 27 }, (_, i) => `slot-${i + 4}`),
];
function assignPaletteColors(characters: CharacterOutput[]): CharacterOutput[] {
  let i = 0;
  return characters.map(c => {
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
      console.warn(`[analysis] ${c.id} has ${c.evidence?.length ?? 0} evidence quote(s); analyzer prompt asks for ≥3.`);
    }
  }
}

/* Re-export the shared text normaliser (lives under server/src/util/) so
   the existing `import { normaliseForMatch } from './analysis.js'` callers
   (cast-merge, analysis.test) keep working. The voice-match route imports
   it directly from the util. */
export const normaliseForMatch = normaliseForMatchShared;

/* Drops evidence quotes that aren't a substring of the source text. The
   skill prompt asks the model to copy quotes verbatim, but some models
   stitch separate utterances together to hit a length target — the
   stitched "quote" won't appear as a contiguous run anywhere in the
   source, so it's dropped here. Mutates characters in place so the
   cleaned arrays flow into the cache + SSE payload. `log` is invoked
   once per character that had drops, surfacing the catch in the
   analysing-view log.

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
  for (const c of characters) {
    if (!c.evidence?.length) continue;
    const kept: typeof c.evidence = [];
    const dropped: typeof c.evidence = [];
    const droppedReasons: DropReason[] = [];
    for (const e of c.evidence) {
      const norm = normaliseForMatch(e.quote);
      if (norm.length > 0 && normalisedSource.includes(norm)) {
        kept.push(e);
      } else {
        dropped.push(e);
        droppedReasons.push(norm.length === 0 ? 'empty_after_normalisation' : 'not_in_source');
      }
    }
    if (dropped.length > 0) {
      totalDropped += dropped.length;
      affectedCharacters += 1;
      const head = dropped[0].quote.slice(0, 60).replace(/\s+/g, ' ');
      log(`Dropped ${dropped.length} fabricated quote${dropped.length === 1 ? '' : 's'} on ${c.id} (e.g. "${head}${dropped[0].quote.length > 60 ? '…' : ''}").`);
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
  return { totalDropped, affectedCharacters, entries };
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
        evidence: incoming.evidence ? incoming.evidence.map(e => ({ ...e })) : undefined,
        tone: incoming.tone ? { ...incoming.tone } : undefined,
      });
      continue;
    }
    /* Description: keep whichever is longer. */
    if (incoming.description && (!existing.description || incoming.description.length > existing.description.length)) {
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
      const seen = new Set((existing.evidence ?? []).map(e => normaliseForMatch(e.quote)));
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
    if (!existing.gender   && incoming.gender)   existing.gender   = incoming.gender;
    if (!existing.ageRange && incoming.ageRange) existing.ageRange = incoming.ageRange;
  }
}

/* Build an "interim" cast suitable for writing to cast.json mid-run.
   Walks chapterCast in narrative chapter order, merges via the same
   mergeRosterChapter the live SSE uses, applies deterministic palette
   colours, and attaches `lines: 0, scenes: 0` placeholders — Phase 1
   hasn't run yet so per-character line counts aren't known. The shape
   matches the post-Phase-1 end-of-run write so frontend cast.json
   readers tolerate it; the post-fold final write replaces this with the
   authoritative version once Phase 1 + fold completes.
   Returns `[]` when the roster is empty so callers can guard the
   cast.json write. */
export function buildInterimCast(
  chapterCast: Record<number, CharacterOutput[]>,
  chapterOrder: number[],
): CharacterOutput[] {
  const roster = new Map<string, CharacterOutput>();
  for (const chapterId of chapterOrder) {
    const cast = chapterCast[chapterId];
    if (cast?.length) mergeRosterChapter(roster, cast);
  }
  if (roster.size === 0) return [];
  return attachLinesAndScenes(
    assignPaletteColors(Array.from(roster.values())),
    [],
  );
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
    if (!set) { set = new Set(); scenes.set(s.characterId, set); }
    set.add(s.chapterId);
  }
  return characters.map(c => ({
    ...c,
    lines: lines.get(c.id) ?? 0,
    scenes: scenes.get(c.id)?.size ?? 0,
  }));
}

export const analysisRouter = Router();

/* Keep aligned with src/data/analysis-phases.ts ANALYSIS_PHASES. */
const PHASES = [
  { id: 0, label: 'Detecting characters',    durationMs: 0    }, // handoff stage 1
  { id: 1, label: 'Parsing and attribution', durationMs: 0    }, // handoff stage 2
  { id: 2, label: 'Matching library',        durationMs: 250  },
];

function bookIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'book';
}

function durationPlaceholder(): string {
  return '00:00';
}

/* Heuristic ETA model. Stage 1 is bounded by input size; stage 2 is bounded
   by *output* size (one JSON entry per sentence) and runs longer per input
   char. STAGE1_BASELINE_RATE is the only static baseline — stage 2 is
   computed from stage 1's *observed* rate × STAGE2_STRETCH, so big books
   on slow models still get a sensible bar after the first phase. */
const STAGE1_BASELINE_RATE = 1.0;  // input chars / ms; tuned for gemini-2.5-flash
/* Stage 2 emits one JSON entry per sentence — output is much heavier than
   stage 1's small roster. Earlier 3× was optimistic; observed runs on
   gemini-3-flash land closer to 5–7× the stage 1 time per char. Erring on
   the side of "we promised more time than it took" beats pegging at 95%. */
const STAGE2_STRETCH = 5.0;
const MIN_EST_MS = 3000;
const MAX_EST_MS = 10 * 60 * 1000;  // 10 minutes — past this the bar caps
/* When elapsed exceeds the per-chapter estimate, the bar asymptotes toward
   the cap instead of pegging — overage frac is mapped through 1 - 1/(1+x)
   so a 2× overage adds half the remaining headroom, a 4× overage adds 80%.
   Log lines fire at each threshold so the user gets a textual signal too. */
const OVERAGE_LOG_THRESHOLDS = [1.5, 2.0, 3.0] as const;

/* Wall-clock heartbeat thresholds (ms). Independent of the per-chapter
   estimate — guarantees the log gets a fresh line at predictable intervals
   even when the estimate is small (a 22s estimate's 1.5×/2×/3× thresholds
   are only 33s/44s/66s, so without these the log would stall on a 5-minute
   chapter). Each threshold fires once per chapter. */
const HEARTBEAT_MS_THRESHOLDS = [30_000, 60_000, 120_000, 180_000, 300_000, 420_000, 600_000, 900_000] as const;

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
const ENGINE_FALLBACK_MS_PER_CHAR: Record<'gemini' | 'local', number> = {
  gemini: 0.5,
  local:  5.0,
};
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

function clampEst(ms: number): number {
  return Math.max(MIN_EST_MS, Math.min(MAX_EST_MS, Math.round(ms)));
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

function buildStage1ChapterInbox(
  manuscriptId: string,
  title: string,
  chapter: { id: number; title: string; body: string },
  runningRoster: CharacterOutput[],
): string {
  /* Compact roster format — only the identity fields the model needs to
     reuse ids verbatim. Skipping evidence/tone/description keeps each
     per-chapter call's prompt small even on book #15 of a series. */
  const rosterJson = JSON.stringify(
    runningRoster.map(c => ({ id: c.id, name: c.name, role: c.role })),
    null,
    2,
  );
  const rosterBlock = runningRoster.length === 0
    ? '_No characters detected yet — this is the first chapter being processed. Use kebab-case ids that will be stable across the rest of the book._'
    : `\`\`\`json\n${rosterJson}\n\`\`\``;
  return `---
manuscriptId: ${manuscriptId}
stage: 1-ch${chapter.id}
expectedOutput: ./outbox/${manuscriptId}-stage1-ch${chapter.id}.json
schema: see skills/audiobook-character-detection-per-chapter.md
---

# Phase 0a — Per-chapter cast detection

Run the **\`audiobook-character-detection-per-chapter\`** skill on the chapter
below. Save the JSON output to:

\`\`\`
server/handoff/outbox/${manuscriptId}-stage1-ch${chapter.id}.json
\`\`\`

Schema and rules live in
\`skills/audiobook-character-detection-per-chapter.md\`.

**Only return characters who SPEAK in this chapter.** A character belongs
in the output only if you can copy a verbatim line of dialogue they utter
in the chapter below. Pets, animals, magical creatures, and any entity
whose only "lines" are non-verbal sounds (purring, growling, hissing,
roaring) do NOT belong on the roster — the narrator covers them. If a
running-roster character appears only by being mentioned or described in
this chapter (no spoken line), omit them from this chapter's output.

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
expectedOutput: ./outbox/${manuscriptId}-stage2-ch${chapter.id}.json
schema: see skills/audiobook-sentence-attribution.md
---

# Stage 2 — Sentence attribution (Chapter ${chapter.id})

Run the **\`audiobook-sentence-attribution\`** skill on the single chapter
below. For every sentence, return the speaking character (or 'narrator' for
non-dialogue prose). Save to:

\`\`\`
server/handoff/outbox/${manuscriptId}-stage2-ch${chapter.id}.json
\`\`\`

Schema and rules live in \`skills/audiobook-sentence-attribution.md\`.

All \`chapterId\` values in the output MUST be \`${chapter.id}\`. Return ONLY a
JSON object matching the schema above. No prose, no code fences.

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
  stage1.characters.map(c => ({ id: c.id, name: c.name, role: c.role })),
  null,
  2,
)}
\`\`\`

## Chapter ${chapter.id} — ${chapter.title}

${chapter.body}
`;
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
    try { res.write(':ka\n\n'); } catch { /* socket gone */ }
  }, 15_000);

  /* Track whether the SSE client is still listening. When the user
     navigates away from the analysing view (back to library, page reload,
     tab close) the socket closes. The original design kept the analysis
     loop running so per-chapter cache writes weren't wasted — but at
     concurrency=1 a zombie loop keeps Ollama busy, and the next time the
     user opens the book another stream starts that ends up queued behind
     the zombie. With AbortController plumbed all the way through to the
     analyzer's fetch (server/src/analyzer/ollama.ts), we now tear the
     in-flight model call down on disconnect; cache writes that have
     already happened still survive on disk, so the next session resumes
     from the chapter the abort caught. */
  let clientGone = false;
  const abortController = new AbortController();
  /* CRITICAL: use res.on('close'), NOT req.on('close'). Node.js's
     IncomingMessage emits 'close' as soon as the request body stream
     is fully consumed (which, for a body-bearing POST, happens
     SYNCHRONOUSLY after Express's body-parser middleware reads it —
     i.e. within milliseconds of route entry). The TCP connection is
     still wide open at that point; the response stream is fine; the
     client is still listening. Treating that signal as "client
     disconnected" caused the route to abort itself on every single
     POST before any analysis work could begin (verified with elapsed
     timings: req.close fired at 1ms, while res.finish/res.close fired
     only after the route itself called res.end()).
     res.on('close') is the correct event: it fires when the response
     socket actually closes, either from our own res.end() (normal
     completion) or because the client disconnected mid-stream. We
     differentiate via res.writableEnded — if true, the close is from
     our own end() call and there's nothing to abort. */
  res.on('close', () => {
    if (res.writableEnded) return;  // normal completion, not a client abort
    clientGone = true;
    clearInterval(keepAlive);
    abortController.abort();
  });
  res.on('finish', () => clearInterval(keepAlive));

  const send = (payload: unknown) => {
    if (clientGone) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const log = (phaseId: number, message: string) => {
    send({ kind: 'log', phaseId, message });
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
    return res.end();
  }

  const startedAt = Date.now();
  const phaseStarts: Record<number, number> = {};

  const markPhase = (id: number) => { phaseStarts[id] = Date.now(); };
  const endPhase = (id: number) => Date.now() - (phaseStarts[id] ?? Date.now());

  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
  let selection: AnalyzerSelection;
  try {
    selection = selectAnalyzer({ model: requestedModel });
  } catch (e) {
    send({ kind: 'error', message: (e as Error).message });
    return res.end();
  }
  /* Const re-bind so TS keeps the narrowed type inside nested closures
     (the `let analyzer` was inferred as `Analyzer | undefined` and got
     widened to `any` when captured by runChapter). */
  const analyzer = selection.analyzer;
  const recordRef = record;
  const activeModelId = selection.model;
  const analyzerLabel = engineLabel(selection.engine, activeModelId);
  if (requestedModel) {
    console.log(`[analysis] manuscript=${manuscriptId} engine=${selection.engine} model=${selection.model}`);
  }

  try {
    const sourceChars = record.sourceText.length;
    const wordCount = record.sourceText.split(/\s+/).filter(Boolean).length;
    /* Pre-flight estimate uses the static baseline for both stages. After
       stage 1 completes we replace stage2EstMs with one derived from the
       *observed* rate, so the second bar reflects actual model speed. */
    let stage1EstMs = clampEst(sourceChars / STAGE1_BASELINE_RATE);
    let stage2EstMs = clampEst((sourceChars / STAGE1_BASELINE_RATE) * STAGE2_STRETCH);

    /* Load any partial progress from a previous attempt. Cached stage 1 is
       reused as-is; cached chapters are skipped in the stage 2 loop. Pass
       `fresh: true` in the request body to discard the cache and start
       over — the route's "Start fresh" button uses this. */
    const requestedFresh = req.body?.fresh === true;
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
    log(0, `Manuscript: ${wordCount.toLocaleString()} words, ${sourceChars.toLocaleString()} characters, ${record.chapterHints.length} chapter${record.chapterHints.length === 1 ? '' : 's'}`);
    log(0, `Estimated total time: ~${humanSeconds(stage1EstMs + stage2EstMs)} (refined after stage 1)`);
    let stage1: Stage1Output;
    let stage1ActualMs = 0;
    const totalCastChapters = record.chapterHints.length;
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
    const castDurations: Record<number, number> = cache.castDurations ?? {};
    for (const idStr of Object.keys(castDurations)) {
      const id = Number(idStr);
      const ch = record.chapterHints.find(c => c.id === id);
      if (!ch) continue;
      castActualMsTotal += castDurations[id];
      castActualCharsTotal += ch.body.length;
    }
    /* Char totals for ETA projection. totalCastCharsAll: chars across all
       non-excluded chapters (Phase 0a iterates these). totalStage2CharsAll:
       same set since stage 2 runs the same non-excluded chapters. */
    const totalCastCharsAll = record.chapterHints
      .filter(c => !c.excluded)
      .reduce((sum, c) => sum + c.body.length, 0);
    /* Emit an initial ETA up front so the heading swaps from the static
       Gemini-calibrated describeSize string (22ms/word) to an
       engine-aware projection immediately, even on a fresh run before
       any chapter completes. Uses cached durations when present (typical
       resume case); otherwise falls back to the per-engine ms/char rate. */
    {
      const fallbackMsPerChar = ENGINE_FALLBACK_MS_PER_CHAR[selection.engine] ?? 0.5;
      const phase0CharsRemainingInitial = Math.max(0, totalCastCharsAll - castActualCharsTotal);
      const initialRemainingMs = projectRemainingMs({
        phase0WallClockMs: 0,
        phase0CharsDone: castActualCharsTotal,
        phase0CharsRemaining: phase0CharsRemainingInitial,
        phase1WallClockMs: 0,
        phase1CharsDone: 0,
        phase1CharsRemaining: totalCastCharsAll,
        fallbackPhase0Ms: fallbackMsPerChar * phase0CharsRemainingInitial
          + PHASE0_PER_CHAPTER_BASELINE_MS,
        fallbackPhase1Ms: fallbackMsPerChar * STAGE2_STRETCH * totalCastCharsAll,
      });
      send({ kind: 'eta', remainingMs: initialRemainingMs });
    }
    if (cache.stage1) {
      /* Phase 0 already completed on a prior run — short-circuit straight
         to the finalised roster. Still re-sort + re-verify in case the
         cache predates the current verifier pass. */
      const charCount = cache.stage1.characters.length;
      log(0, `Resuming — Phase 0 already complete (${charCount} character${charCount === 1 ? '' : 's'} cached).`);
      send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });
      stage1 = cache.stage1;
      sortEvidence(stage1.characters);
      const verified = verifyEvidenceAgainstSource(stage1.characters, record.sourceText, msg => log(0, msg));
      if (verified.totalDropped > 0) {
        cache.stage1 = stage1;
        await saveAnalysisCache(manuscriptId, cache);
      }
      await persistDroppedQuotesBatch(recordRef.bookDir, manuscriptId, 'analysis-stream', verified);
      send({ kind: 'cast-update', characters: stage1.characters });
    } else {
      /* Phase 0a — per-chapter cast detection. The chapterCast cache
         lets us resume mid-Phase-0a after a crash / rate-limit / model
         swap by replaying the per-chapter outputs we already have. */
      const chapterCast: Record<number, CharacterOutput[]> = cache.chapterCast ?? {};
      const cachedCastCount = Object.keys(chapterCast).length;
      const stage0Start = Date.now();
      log(0, `Detecting cast chapter-by-chapter across ${totalCastChapters} chapter${totalCastChapters === 1 ? '' : 's'} via ${analyzerLabel}…`);
      if (cachedCastCount > 0) {
        log(0, `Resuming — ${cachedCastCount} of ${totalCastChapters} chapter${cachedCastCount === 1 ? '' : 's'} already cached.`);
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
      const emitCastUpdate = (): void => {
        const roster = rebuildRoster();
        send({ kind: 'cast-update', characters: Array.from(roster.values()) });
      };

      const completedCast = new Set<number>(Object.keys(chapterCast).map(k => Number(k)));
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
      const activeCastChapters = recordRef.chapterHints.filter(c => !c.excluded).length;
      const excludedCastChapters = totalCastChapters - activeCastChapters;
      if (excludedCastChapters > 0) {
        log(0, `Skipping ${excludedCastChapters} excluded chapter${excludedCastChapters === 1 ? '' : 's'} (front/back-matter you opted out of narrating).`);
      }
      const phase0Progress = (): number => {
        const done = completedCast.size;
        return activeCastChapters > 0 ? Math.min(0.02 + 0.93 * (done / activeCastChapters), 0.95) : 1;
      };

      /* Initial cast-update + progress reflecting any cached cast. */
      send({ kind: 'phase', phaseId: 0, progress: phase0Progress(), label: PHASES[0].label });
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
        const requeuedFailedCount = castTaskIndices.filter(i => failedSet.has(recordRef.chapterHints[i].id)).length;
        const requeueSuffix = requeuedFailedCount > 0
          ? ` (including ${requeuedFailedCount} previously-failed)`
          : '';
        log(0, `Running ${castTaskIndices.length} chapter cast-detection${castTaskIndices.length === 1 ? '' : 's'}${requeueSuffix} with up to ${castConcurrency} in parallel.`);
      }

      /* Per-chapter live ticker, mirroring Phase 1's structure so the
         frontend's existing LiveChapterTicker can render Phase 0 the
         same way. */
      interface CastInFlight {
        chapterIndex: number;
        chapterTitle: string;
        chapterEstMs: number;
        startedAt: number;
        elapsedMs: number;
      }
      const castInFlight = new Map<number, CastInFlight>();
      const sendCastLiveTick = (): void => {
        const running = Array.from(castInFlight.values()).sort((a, b) => a.chapterIndex - b.chapterIndex);
        send({
          kind: 'phase',
          phaseId: 0,
          progress: phase0Progress(),
          label: PHASES[0].label,
          live: running.length > 0 ? {
            totalChapters: totalCastChapters,
            chapters: running.map(r => ({
              chapterIndex: r.chapterIndex + 1,
              chapterTitle: r.chapterTitle,
              elapsedMs: r.elapsedMs,
              estMs: r.chapterEstMs,
            })),
          } : undefined,
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
        const msPerCharFallback = ENGINE_FALLBACK_MS_PER_CHAR[selection.engine] ?? 0.5;
        const fallback = PHASE0_PER_CHAPTER_BASELINE_MS + msPerCharFallback * ch.body.length;
        const chapterEstMs = chapterEstFromObserved(
          ch.body.length, castActualMsTotal, castActualCharsTotal, fallback,
        );
        const startedChAt = Date.now();
        castInFlight.set(i, { chapterIndex: i, chapterTitle: ch.title, chapterEstMs, startedAt: startedChAt, elapsedMs: 0 });

        let lastChunkAt = Date.now();
        let lastHeartbeatAt = 0;
        let warnedSilenceAt: number | null = null;
        log(0, `Chapter ${i + 1}/${totalCastChapters} cast — ${ch.title} (${ch.body.length.toLocaleString()} chars) via ${analyzerLabel}…`);
        let result;
        try {
          result = await analyzer.runStage1Chapter(
            manuscriptId,
            ch.id,
            buildStage1ChapterInbox(manuscriptId, recordRef.title, ch, Array.from(rebuildRoster().values())),
            {
              signal: abortController.signal,
              onWaiting: (elapsed) => {
                const slot = castInFlight.get(i);
                if (slot) slot.elapsedMs = elapsed;
                sendCastLiveTick();
                /* Silence watchdog. Without this the user has no idea
                   whether a slow Phase 0a call is rate-limited, hung, or
                   just slow on free-tier Gemma. Warn once per silence
                   stretch, re-arm on the next chunk. */
                const sinceLastChunk = Date.now() - lastChunkAt;
                if (sinceLastChunk > SILENCE_THRESHOLD_MS) {
                  if (warnedSilenceAt === null || Date.now() - warnedSilenceAt > SILENCE_THRESHOLD_MS) {
                    warnedSilenceAt = Date.now();
                    log(0, `Chapter ${i + 1}/${totalCastChapters} — no response from ${analyzerLabel} in ${humanSeconds(sinceLastChunk)}, still waiting.`);
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
                const charsPerSec = info.elapsedMs > 0 ? Math.round((info.receivedBytes * 1000) / info.elapsedMs) : 0;
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
            },
          );
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
          completedCast.add(i);                       // count toward progress denominator
          failedCastChapters.add(ch.id);
          const chDurationFail = Date.now() - startedChAt;
          /* The duration cache feeds the observed-pace ETA. Recording a
             failure's duration would skew the pace estimate (probably
             upward — the model burned all its budget then errored), so
             skip the duration save on failure. */
          log(0, `❌ Chapter ${i + 1}/${totalCastChapters} cast FAILED — ${ch.title}: ${(chErr as Error).message}`);
          log(0, `Continuing without chapter ${i + 1} in the cast roster (${humanSeconds(chDurationFail)} spent). Re-run analysis to retry.`);
          /* Persist the failure marker into the cache so a resumed run
             knows we tried this chapter and gave up — without this, a
             follow-up open would queue it again and probably fail the
             same way. Stored as an empty-cast entry so rebuildRoster
             skips it and the cache key is taken. */
          chapterCast[ch.id] = [];
          cache.chapterCast = chapterCast;
          /* Promote the failure to durable cache state so the analysing
             view can surface a per-chapter Retry button after reload.
             The set is in-memory only; without this, the failed-id list
             disappears the moment the SSE ends. Dedup via Set so a
             second-chance retry inside the same run doesn't double up. */
          const failedSet = new Set(cache.failedChapterIds ?? []);
          failedSet.add(ch.id);
          cache.failedChapterIds = Array.from(failedSet);
          await saveAnalysisCache(manuscriptId, cache);
          send({ kind: 'chapter-failed', chapterId: ch.id, message: (chErr as Error).message });
          sendCastLiveTick();
          send({ kind: 'phase', phaseId: 0, progress: phase0Progress(), label: PHASES[0].label });
          return;
        }

        chapterCast[ch.id] = result.characters;
        completedCast.add(i);
        cache.chapterCast = chapterCast;
        /* A previously-failed chapter just succeeded on resume — clear it
           from the durable failed-id list so the analysing view's Retry
           row disappears on the next book-state fetch. */
        if (cache.failedChapterIds?.length) {
          cache.failedChapterIds = cache.failedChapterIds.filter(id => id !== ch.id);
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
           pass overwrites with the authoritative version. Skipped on
           client disconnect to match the end-of-run write — we don't
           want a navigate-away to flip the library status to
           cast_pending. */
        if (recordRef.bookDir && !clientGone) {
          const interim = buildInterimCast(chapterCast, recordRef.chapterHints.map(h => h.id));
          if (interim.length > 0) {
            try {
              await writeJsonAtomic(castJsonPath(recordRef.bookDir), { characters: interim });
            } catch (persistErr) {
              console.warn('[analysis] interim cast.json write failed', persistErr);
            }
          }
        }
        castInFlight.delete(i);
        log(0, `Chapter ${i + 1}/${totalCastChapters} cast done — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'} in ${humanSeconds(chDuration)}`);
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
         write at the catch site above. */
      if (failedCastChapters.size > 0) {
        const failedCount = failedCastChapters.size;
        log(0, `Phase 0 paused — ${failedCount} chapter${failedCount === 1 ? '' : 's'} still needs cast detection (see ❌ lines above). Phase 1 won't start until every chapter has a roster — retry below or re-run analysis.`);
        send({ kind: 'phase', phaseId: 0, progress: phase0Progress(), label: PHASES[0].label });
        send({
          kind: 'error',
          code: 'cast_incomplete',
          message: `Phase 0 paused — ${failedCount} chapter${failedCount === 1 ? '' : 's'} failed cast detection. Retry below to continue.`,
        });
        return res.end();
      }

      /* ── Phase 0b — finalise the roster.
         Replay merge once more in chapter-id order (canonical), then
         sort+verify+colour. Always include 'narrator' so downstream
         (stage-2 attribution, voice picker) can rely on its presence. */
      const finalRoster = rebuildRoster();
      const characters = Array.from(finalRoster.values());
      sortEvidence(characters);
      const verified = verifyEvidenceAgainstSource(characters, record.sourceText, msg => log(0, msg));
      stage1 = {
        characters,
        /* Carry the parser's chapter list verbatim — Phase 0a deliberately
           doesn't return a chapters[] field, and stage 2's prompt /
           merging downstream both work off the same list. */
        chapters: recordRef.chapterHints.map(c => ({ id: c.id, title: c.title })),
      };
      cache.stage1 = stage1;
      await saveAnalysisCache(manuscriptId, cache);
      await persistDroppedQuotesBatch(recordRef.bookDir, manuscriptId, 'analysis-stream', verified);
      stage1ActualMs = Date.now() - stage0Start;
      send({ kind: 'cast-update', characters: stage1.characters });
      /* Finalised-but-not-folded roster lands in cast.json so the file
         reflects the verified Phase 0b state before Phase 1's attribution
         pass starts (which can be the longest phase by far on a long
         book). attachLinesAndScenes with no sentences gives lines:0 /
         scenes:0 placeholders — the post-fold end-of-run write later
         overwrites with the authoritative counts. */
      if (recordRef.bookDir && !clientGone) {
        try {
          const stage1Cast = attachLinesAndScenes(assignPaletteColors(stage1.characters), []);
          await writeJsonAtomic(castJsonPath(recordRef.bookDir), { characters: stage1Cast });
        } catch (persistErr) {
          console.warn('[analysis] stage1 cast.json write failed', persistErr);
        }
      }
    }
    /* Use the observed rate to refine stage 2's estimate. Stage 2 prompt is
       a similar size to stage 1 plus the small character roster, but its
       output is much larger (one JSON entry per sentence), hence the
       stretch factor. */
    if (stage1ActualMs > 0) {
      stage2EstMs = clampEst(stage1ActualMs * STAGE2_STRETCH);
      log(0, `Detected ${stage1.characters.length} character${stage1.characters.length === 1 ? '' : 's'}: ${stage1.characters.map(c => c.name).join(', ')}`);
      /* Report the *parser*'s chapter count — that's what stage 2 actually
         iterates. The analyzer's own count can occasionally collapse on
         flaky models even though the chapter list was provided verbatim in
         the inbox; the parser is the operational source of truth. */
      const parserChapterCount = record.chapterHints.length;
      log(0, `${parserChapterCount} chapter${parserChapterCount === 1 ? '' : 's'} identified in ${humanSeconds(stage1ActualMs)}`);
    }
    send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });

    /* ── Phase 1: parsing and attribution (handoff stage 2, per chapter).
       We split stage 2 by chapter so each call fits well inside the model's
       context window and free-tier rate limits can recover between calls.
       Overall progress is (chapters_done + current_chapter_local_progress) /
       total_chapters. */
    markPhase(1);
    send({ kind: 'phase', phaseId: 1, progress: 0.02, label: PHASES[1].label });
    const totalChapters = record.chapterHints.length;
    log(1, `Attributing ${totalChapters} chapter${totalChapters === 1 ? '' : 's'} with ${analyzerLabel}, one at a time…`);
    log(1, `Estimated stage time: ~${humanSeconds(stage2EstMs)} (based on stage 1 rate)`);
    if (cachedChapterCount > 0) {
      log(1, `Resuming — ${cachedChapterCount} of ${totalChapters} chapter${cachedChapterCount === 1 ? '' : 's'} already cached.`);
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
    /* Seed from prior-run stage 2 durations so a resumed run already has
       per-chapter ETA samples — same rationale as the cast pass above. */
    const stage2Durations: Record<number, number> = cache.stage2Durations ?? {};
    for (const idStr of Object.keys(stage2Durations)) {
      const id = Number(idStr);
      const ch = record.chapterHints.find(c => c.id === id);
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
        log(1, `Chapter ${i + 1}/${totalChapters} — ${ch.title}: cached (${cached.length.toLocaleString()} sentences), skipping.`);
        sentencesByChapter.set(ch.id, cached);
        completedSet.add(i);
      }
    }
    /* Active = chapters that will actually run Phase 1. Excluded chapters
       are subtracted from the denominator so a book with 5 excluded
       chapters doesn't stall the bar below 100%. */
    const activeChapterCount = recordRef.chapterHints.filter(c => !c.excluded).length;
    const excludedChapterCount = totalChapters - activeChapterCount;
    if (excludedChapterCount > 0) {
      log(1, `Skipping ${excludedChapterCount} excluded chapter${excludedChapterCount === 1 ? '' : 's'} (no audio will be generated).`);
    }
    /* Reflect cached progress in the bar before any work starts. */
    {
      const cachedFrac = activeChapterCount > 0 ? completedSet.size / activeChapterCount : 1;
      send({
        kind: 'phase',
        phaseId: 1,
        progress: Math.min(0.02 + 0.93 * cachedFrac, 0.95),
        label: PHASES[1].label,
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
    log(1, `Running ${taskIndices.length} chapter${taskIndices.length === 1 ? '' : 's'} with up to ${concurrency} in parallel.`);

    /* Track which chapters are currently in-flight + their elapsed times so
       the `live` payload can surface every running chapter — concurrency
       means a slow chapter can be paired with newer ones racing ahead, and
       showing only the oldest hides that progress. Sorted by chapter order
       in the manuscript so the UI shows them in book order. */
    interface InFlight {
      chapterIndex: number;
      chapterTitle: string;
      chapterEstMs: number;
      startedAt: number;
      elapsedMs: number;
    }
    const inFlight = new Map<number, InFlight>();

    const sendLiveTick = () => {
      const running = Array.from(inFlight.values())
        .sort((a, b) => a.chapterIndex - b.chapterIndex);
      const p = activeChapterCount > 0
        ? Math.min(0.02 + 0.93 * (completedSet.size / activeChapterCount), 0.95)
        : 1;
      send({
        kind: 'phase',
        phaseId: 1,
        progress: p,
        label: PHASES[1].label,
        live: running.length > 0 ? {
          totalChapters,
          chapters: running.map(r => ({
            chapterIndex: r.chapterIndex + 1,
            chapterTitle: r.chapterTitle,
            elapsedMs: r.elapsedMs,
            estMs: r.chapterEstMs,
          })),
        } : undefined,
      });
    };

    async function runChapter(i: number): Promise<void> {
      const ch = recordRef.chapterHints[i];
      const chapterEstMs = chapterEstMsFor(ch.body.length);
      const loggedOverages = new Set<number>();
      const loggedHeartbeats = new Set<number>();
      const startedAt = Date.now();
      inFlight.set(i, {
        chapterIndex: i,
        chapterTitle: ch.title,
        chapterEstMs,
        startedAt,
        elapsedMs: 0,
      });

      const tickOverall = (elapsed: number) => {
        const slot = inFlight.get(i);
        if (slot) slot.elapsedMs = elapsed;
        sendLiveTick();
        /* Over-budget log thresholds — fire once per chapter. */
        for (const t of OVERAGE_LOG_THRESHOLDS) {
          if (loggedOverages.has(t)) continue;
          if (elapsed >= chapterEstMs * t) {
            loggedOverages.add(t);
            log(1, `Chapter ${i + 1}/${totalChapters} still running — ${humanSeconds(elapsed)} elapsed (est was ${humanSeconds(chapterEstMs)}, ${t}× exceeded). Continuing.`);
          }
        }
        /* Wall-clock heartbeats. */
        for (const ms of HEARTBEAT_MS_THRESHOLDS) {
          if (loggedHeartbeats.has(ms)) continue;
          if (elapsed >= ms) {
            loggedHeartbeats.add(ms);
            const overageRecent = Array.from(loggedOverages).some(t =>
              Math.abs(chapterEstMs * t - ms) < 5000,
            );
            if (!overageRecent) {
              log(1, `Chapter ${i + 1}/${totalChapters} — ${humanSeconds(elapsed)} elapsed, still waiting on the model.`);
            }
          }
        }
      };

      log(1, `Chapter ${i + 1}/${totalChapters} — ${ch.title} (${ch.body.length.toLocaleString()} chars, ~${humanSeconds(chapterEstMs)}) via ${analyzerLabel}…`);
      let chapterLastHeartbeatAt = 0;
      const result = await analyzer.runStage2Chapter(
        manuscriptId,
        ch.id,
        buildStage2ChapterInbox(manuscriptId, recordRef.title, stage1, ch),
        {
          signal: abortController.signal,
          onWaiting: (elapsed) => tickOverall(elapsed),
          /* Per-chunk heartbeat so the user sees evidence of model output
             on each chapter. Stage 2's existing wall-clock heartbeat log
             lines already cover the silence-watchdog purpose. */
          onChunk: (info) => {
            const now = Date.now();
            if (now - chapterLastHeartbeatAt < HEARTBEAT_EVENT_THROTTLE_MS) return;
            chapterLastHeartbeatAt = now;
            const charsPerSec = info.elapsedMs > 0
              ? Math.round((info.receivedBytes * 1000) / info.elapsedMs)
              : 0;
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
        },
      );
      for (const s of result.sentences) s.chapterId = ch.id;
      sentencesByChapter.set(ch.id, result.sentences);
      cachedChapters[ch.id] = result.sentences;
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
      completedSet.add(i);
      inFlight.delete(i);
      log(1, `Chapter ${i + 1}/${totalChapters} done — ${result.sentences.length.toLocaleString()} sentences in ${humanSeconds(chDuration)}`);

      /* Update observed-pace tracker. Race-safe because JS is single-threaded
         — increments interleave but sums are associative. */
      actualMsTotal += chDuration;
      actualCharsTotal += ch.body.length;
      const observedRate = actualMsTotal / actualCharsTotal;
      const remaining = remainingNonCachedChars(-1); // re-scan whole list against current cache
      if (remaining.count > 0) {
        const remainingEstMs = Math.round(observedRate * remaining.chars);
        const secsPer1k = observedRate;
        log(1, `Refined pace — ${secsPer1k.toFixed(1)}s per 1,000 chars · ~${humanSeconds(remainingEstMs)} remaining over ${remaining.count} chapter${remaining.count === 1 ? '' : 's'}.`);
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

    /* Concurrency pool — keep up to `concurrency` chapters in flight at a
       time. The first failure aborts new task dispatch, but already-running
       tasks finish their work and write to the cache, so a resume picks up
       cleanly from where the run left off. */
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
    log(1, `Attributed ${allSentences.length.toLocaleString()} sentences across ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}`);
    /* Per-character line counts, sorted by lines descending — most prominent first. */
    {
      const lineCounts = new Map<string, number>();
      for (const s of allSentences) {
        lineCounts.set(s.characterId, (lineCounts.get(s.characterId) ?? 0) + 1);
      }
      const top = stage1.characters
        .map(c => ({ name: c.name, lines: lineCounts.get(c.id) ?? 0 }))
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 4);
      for (const t of top) log(1, `${t.name}: ${t.lines.toLocaleString()} lines`);
    }
    send({ kind: 'phase', phaseId: 1, progress: 1, label: PHASES[1].label });

    /* ── Phase 2: matching library — empty for first slice. */
    markPhase(2);
    log(2, 'No library matches yet (voice library matching is not wired up for this slice).');
    for (let i = 1; i <= 3; i++) {
      send({ kind: 'phase', phaseId: 2, progress: i / 3, label: PHASES[2].label });
      await new Promise(r => setTimeout(r, PHASES[2].durationMs / 3));
    }

    /* ── Compose the AnalyseResponse. */
    const chapterTitleById = new Map(stage1.chapters.map(c => [c.id, c.title]));
    const chapters = record.chapterHints.map(h => ({
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
    const folded = foldMinorCast(stage1.characters, allSentences, {
      minLines: userSettings.minorCastMinLines,
    });
    if (folded.summary.foldedCount > 0) {
      const parts: string[] = [];
      if (folded.summary.intoMale)   parts.push(`${folded.summary.intoMale} → Unknown male`);
      if (folded.summary.intoFemale) parts.push(`${folded.summary.intoFemale} → Unknown female`);
      log(1, `Folded ${folded.summary.foldedCount} background character${folded.summary.foldedCount === 1 ? '' : 's'} (${parts.join(', ')}) — names rolled into aliases.`);
    }
    if (folded.summary.droppedSilent > 0) {
      const sample = folded.dropped.slice(0, 4).join(', ');
      const more = folded.dropped.length > 4 ? `, +${folded.dropped.length - 4} more` : '';
      log(1, `Dropped ${folded.summary.droppedSilent} non-speaking character${folded.summary.droppedSilent === 1 ? '' : 's'} from the cast (${sample}${more}) — no attributed dialogue, narrator covers them.`);
    }

    const characters = attachLinesAndScenes(
      assignPaletteColors(folded.characters),
      folded.sentences,
    );

    const totalElapsed = Date.now() - startedAt;
    const bookId = record.bookId ?? bookIdFromTitle(record.title);
    const response = {
      bookId,
      manuscriptId,
      title: record.title,
      phaseTimings: PHASES.map(p => ({ id: p.id, label: p.label, duration: endPhase(p.id) || Math.round(totalElapsed / PHASES.length) })),
      characters,
      chapters,
      sentences: folded.sentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    // Persist cast.json + refreshed manuscript-edits.json + state.json back
    // into the on-disk book. Only runs for books that came through POST
    // /api/books (workspace flow); legacy POST /api/manuscripts uploads
    // have no bookDir and are skipped.
    //
    // Skipped when the SSE client has disconnected: writing cast.json flips
    // the library status to `cast_pending`, which routes a re-open of the
    // book to the confirm screen. If the user navigated away mid-run we
    // don't want them to come back to a confirm screen for a run they
    // perceive as unfinished — the cache still holds the per-chapter
    // progress so a follow-up open resumes cheaply.
    if (record.bookDir && !clientGone) {
      try {
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), { sentences: folded.sentences });
        await writeJsonAtomic(castJsonPath(record.bookDir), { characters });
        const statePath = stateJsonPath(record.bookDir);
        const prev = await readJson<BookStateJson>(statePath);
        if (prev) {
          /* Preserve the excluded flag — analysis owns chapter titles/
             durations, the user owns excluded. Match on id so a re-run
             after a re-parse picks up whichever ids the parser produced. */
          const prevExcludedById = new Map<number, boolean>();
          for (const c of prev.chapters) {
            if (c.excluded) prevExcludedById.set(c.id, true);
          }
          const next: BookStateJson = {
            ...prev,
            chapters: chapters.map(c => ({
              id: c.id,
              title: c.title,
              slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
              duration: c.duration,
              excluded: prevExcludedById.get(c.id) || undefined,
            })),
            updatedAt: new Date().toISOString(),
          };
          await writeJsonAtomic(statePath, next);
        }
      } catch (persistErr) {
        console.error('[analysis] failed to persist .audiobook/* for', record.bookDir, persistErr);
        // Non-fatal — the analysis result still streams back to the client.
      }
    }

    send({ kind: 'result', response });
    res.end();
  } catch (e) {
    /* Client-disconnect short-circuit. Abort propagated up from the
       analyzer's fetch — there's no client to send an error to in the
       normal case, and we don't want this filling the server log with a
       fake "failed" entry every time a user navigates away mid-analysis.
       The send() is still issued (with `code: 'aborted'`) as a
       belt-and-suspenders: if the abort fired for a non-disconnect
       reason or there's a race where the client is briefly still
       listening, they get a structured event instead of the
       "Analysis stream ended without a result event" frontend fallback. */
    if (e instanceof AnalysisAbortedError) {
      console.log(`[analysis] aborted ${manuscriptId} (client disconnected)`);
      /* Bypass the clientGone gate on send() — the abort came from a
         disconnect, but there are race windows where the client is
         briefly still reading (browser hasn't torn down the fetch
         consumer yet). Writing to a truly-closed connection just hits
         the local TCP buffer and gets discarded, so the worst case is
         a silent no-op; the best case is the frontend gets a
         structured event instead of falling through to its
         "Analysis stream ended without a result event" message. */
      try {
        res.write(`data: ${JSON.stringify({ kind: 'error', code: 'aborted', message: 'Analysis aborted (client disconnected or server restarted).' })}\n\n`);
      } catch { /* connection already torn down */ }
      try { res.end(); } catch { /* already ended */ }
      return;
    }
    /* Structured dump — SDK errors don't stringify cleanly with bare
       console.error, which means the upstream status + details get lost in
       the log. Match the shape the route surfaces to the UI so debugging
       reads the same on both sides. */
    const parsedLog = tryParseApiError((e as Error)?.message ?? String(e));
    console.error('[analysis] failed', {
      model: activeModelId,
      name: (e as Error)?.name,
      status: (e as { status?: number })?.status,
      upstreamStatus: parsedLog?.status,
      upstreamCode: parsedLog?.code,
      message: (e as Error)?.message,
      details: parsedLog?.details,
    });
    const { code, message, detail } = describeError(e, analyzerLabel);
    send({ kind: 'error', code, message, detail });
    res.end();
  }
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

  /* Mirror the full-route disconnect guard — see the comment on the parent
     analysis route. The subset route writes cast.json on completion too,
     so the same "no premature confirm-screen flip on navigate-away"
     contract applies. Same abort plumbing too: a navigate-away aborts
     the in-flight Ollama fetch via the StageCall.signal threaded into
     runStage2Chapter below. Same critical detail: must use
     res.on('close'), not req.on('close') — the latter fires
     immediately after Express's body-parser consumes the POST body,
     which is NOT a client disconnect. See the comment on the full
     analysis route above. */
  let clientGone = false;
  const abortController = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    abortController.abort();
  });

  const send = (payload: unknown) => {
    if (clientGone) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const log = (phaseId: number, message: string) => {
    send({ kind: 'log', phaseId, message });
  };

  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) {
    send({ kind: 'error', code: 'unknown_manuscript', message: `No manuscript found for id "${manuscriptId}".` });
    return res.end();
  }

  const body = req.body as { chapterIds?: unknown; model?: unknown };
  const rawIds = Array.isArray(body?.chapterIds) ? body.chapterIds : [];
  const requestedIds = Array.from(new Set(
    rawIds.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)),
  ));
  if (requestedIds.length === 0) {
    send({ kind: 'error', code: 'bad_request', message: 'chapterIds is required and must be a non-empty array of integers.' });
    return res.end();
  }

  /* Validate against the manuscript record so a stale frontend id doesn't
     produce a confusing "chapter not found mid-stream" log line. */
  const hintsById = new Map(record.chapterHints.map(h => [h.id, h]));
  const targets = requestedIds
    .map(id => hintsById.get(id))
    .filter((h): h is NonNullable<typeof h> => !!h);
  if (targets.length === 0) {
    send({ kind: 'error', code: 'bad_request', message: 'None of the requested chapter ids match this manuscript.' });
    return res.end();
  }
  const skippedExcluded = targets.filter(h => h.excluded);
  if (skippedExcluded.length > 0) {
    /* Hard-stop rather than silently re-analyzing — the typical reason a
       caller hits this with excluded=true is a frontend bug where the
       toggle endpoint wasn't awaited before subset analysis kicked off.
       Better to fail fast than to leave half-state on disk. */
    send({
      kind: 'error',
      code: 'chapter_excluded',
      message: `Cannot run analysis on excluded chapter${skippedExcluded.length === 1 ? '' : 's'}: ${skippedExcluded.map(c => c.title).join(', ')}. Flip the exclude flag first via POST /api/books/.../chapters/:chapterId/exclude.`,
    });
    return res.end();
  }
  const toRun = targets.filter(h => !h.excluded);

  const requestedModel = typeof body?.model === 'string' ? body.model : undefined;
  let selection: AnalyzerSelection;
  try {
    selection = selectAnalyzer({ model: requestedModel });
  } catch (e) {
    send({ kind: 'error', message: (e as Error).message });
    return res.end();
  }
  const analyzer = selection.analyzer;
  const analyzerLabel = engineLabel(selection.engine, selection.model);

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
    log(0, `Re-analyzing ${toRun.length} chapter${toRun.length === 1 ? '' : 's'} via ${analyzerLabel}.`);
    send({ kind: 'phase', phaseId: 0, progress: 0.02, label: PHASES[0].label });

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
      send({ kind: 'cast-update', characters: Array.from(roster.values()) });
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
        const result = await analyzer.runStage1Chapter(
          manuscriptId,
          ch.id,
          buildStage1ChapterInbox(manuscriptId, record.title, ch, Array.from(rebuildRoster().values())),
          { signal: abortController.signal },
        );
        chapterCast[ch.id] = result.characters;
        cache.chapterCast = chapterCast;
        if (cache.failedChapterIds?.length) {
          cache.failedChapterIds = cache.failedChapterIds.filter(id => id !== ch.id);
        }
        await saveAnalysisCache(manuscriptId, cache);
        /* Mirror the cache write into cast.json so a subset retry's
           progress is reflected on disk too — matches the full route's
           interim write contract. */
        if (record.bookDir && !clientGone) {
          const interim = buildInterimCast(chapterCast, record.chapterHints.map(h => h.id));
          if (interim.length > 0) {
            try {
              await writeJsonAtomic(castJsonPath(record.bookDir), { characters: interim });
            } catch (persistErr) {
              console.warn('[analysis-subset] interim cast.json write failed', persistErr);
            }
          }
        }
        log(0, `Chapter ${ch.id} cast — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'} detected.`);
        emitCastUpdate();
      } catch (chErr) {
        if (chErr instanceof AnalysisAbortedError) throw chErr;
        chapterCast[ch.id] = [];
        cache.chapterCast = chapterCast;
        const failedSet = new Set(cache.failedChapterIds ?? []);
        failedSet.add(ch.id);
        cache.failedChapterIds = Array.from(failedSet);
        await saveAnalysisCache(manuscriptId, cache);
        log(0, `❌ Chapter ${ch.id} cast FAILED — ${ch.title}: ${(chErr as Error).message}`);
        send({ kind: 'chapter-failed', chapterId: ch.id, message: (chErr as Error).message });
        emitCastUpdate();
      }
      send({ kind: 'phase', phaseId: 0, progress: 0.02 + 0.93 * ((idx + 1) / toRun.length), label: PHASES[0].label });
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
    const characters = Array.from(finalRoster.values());
    sortEvidence(characters);
    const verified = verifyEvidenceAgainstSource(characters, record.sourceText, msg => log(0, msg));
    const stage1: Stage1Output = {
      characters,
      chapters: record.chapterHints.map(c => ({ id: c.id, title: c.title })),
    };
    const remainingFailedCastIds = cache.failedChapterIds ?? [];
    if (remainingFailedCastIds.length === 0) {
      cache.stage1 = stage1;
    }
    await saveAnalysisCache(manuscriptId, cache);
    await persistDroppedQuotesBatch(record.bookDir, manuscriptId, 'analysis-chapters', verified);
    send({ kind: 'cast-update', characters: stage1.characters });
    send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });

    /* ── Phase 1 (subset). Sentence attribution for the new chapters only.
       Cached chapters are left alone — their sentences stay in
       cache.chapters as-is.
       Skip Phase 1 entirely when cast is still incomplete — the
       subset route can't safely attribute sentences without a final
       roster, and writing partial sentences to cache.chapters would
       have to be re-done after the next retry batch finalises stage1.
       The main /analysis/stream gate will run Phase 1 for these
       chapters once the user resolves the remaining failures. */
    if (remainingFailedCastIds.length > 0) {
      log(0, `Cast retry done. ${remainingFailedCastIds.length} chapter${remainingFailedCastIds.length === 1 ? '' : 's'} still need retry before Phase 1 can run.`);
      return res.end();
    }
    /* Retry-after-cast-incomplete flow: the main pipeline hasn't run
       Phase 1 globally, so attributing JUST `toRun` here would emit a
       result with only those chapters' sentences and the view's
       onComplete would advance to the confirm screen with a near-empty
       book. End cleanly instead — the client's auto-resume effect
       will fire /analysis/stream which discovers cache.stage1 is set
       and runs Phase 1 across every chapter. */
    if (!stage1Existed) {
      log(0, 'All cast detection retries succeeded — resuming full analysis to run Phase 1 globally.');
      return res.end();
    }
    send({ kind: 'phase', phaseId: 1, progress: 0.02, label: PHASES[1].label });
    for (let idx = 0; idx < toRun.length; idx++) {
      const ch = toRun[idx];
      log(1, `Chapter ${ch.id} — ${ch.title}: attributing sentences via ${analyzerLabel}…`);
      const result = await analyzer.runStage2Chapter(
        manuscriptId,
        ch.id,
        buildStage2ChapterInbox(manuscriptId, record.title, stage1, ch),
        { signal: abortController.signal },
      );
      for (const s of result.sentences) s.chapterId = ch.id;
      cachedChapters[ch.id] = result.sentences;
      cache.chapters = cachedChapters;
      await saveAnalysisCache(manuscriptId, cache);
      log(1, `Chapter ${ch.id} done — ${result.sentences.length.toLocaleString()} sentences.`);
      send({ kind: 'phase', phaseId: 1, progress: 0.02 + 0.93 * ((idx + 1) / toRun.length), label: PHASES[1].label });
    }

    /* Stitch the full sentence list across all cached chapters (old + new),
       in narrative order. Excluded chapters contribute nothing. */
    const allSentences: SentenceOutput[] = [];
    for (const h of record.chapterHints) {
      if (h.excluded) continue;
      const arr = cachedChapters[h.id];
      if (arr) allSentences.push(...arr);
    }

    /* Re-fold the cast against the merged sentence set so the bucket
       attributions stay coherent with the new chapters' attributions. */
    const folded = foldMinorCast(stage1.characters, allSentences);
    if (folded.summary.droppedSilent > 0) {
      const sample = folded.dropped.slice(0, 4).join(', ');
      const more = folded.dropped.length > 4 ? `, +${folded.dropped.length - 4} more` : '';
      log(1, `Dropped ${folded.summary.droppedSilent} non-speaking character${folded.summary.droppedSilent === 1 ? '' : 's'} from the cast (${sample}${more}) — no attributed dialogue, narrator covers them.`);
    }
    const enriched = attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences);

    const chapterTitleById = new Map(stage1.chapters.map(c => [c.id, c.title]));
    const chaptersOut = record.chapterHints.map(h => ({
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
      phaseTimings: PHASES.map(p => ({ id: p.id, label: p.label, duration: 0 })),
      characters: enriched,
      chapters: chaptersOut,
      sentences: folded.sentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    /* Persist cast.json + manuscript-edits.json + state.json so a refresh
       (or a follow-up generation pass) sees the merged state.
       Skipped when the SSE client has disconnected — see the parent
       analysis route comment for why we don't flip the library status
       in the background. */
    if (record.bookDir && !clientGone) {
      try {
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), { sentences: folded.sentences });
        await writeJsonAtomic(castJsonPath(record.bookDir), { characters: enriched });
        const statePath = stateJsonPath(record.bookDir);
        const prev = await readJson<BookStateJson>(statePath);
        if (prev) {
          const prevExcludedById = new Map<number, boolean>();
          for (const c of prev.chapters) {
            if (c.excluded) prevExcludedById.set(c.id, true);
          }
          const next: BookStateJson = {
            ...prev,
            chapters: chaptersOut.map(c => ({
              id: c.id,
              title: c.title,
              slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
              duration: c.duration,
              excluded: prevExcludedById.get(c.id) || undefined,
            })),
            updatedAt: new Date().toISOString(),
          };
          await writeJsonAtomic(statePath, next);
        }
      } catch (persistErr) {
        console.error('[analysis-subset] failed to persist .audiobook/* for', record.bookDir, persistErr);
      }
    }

    send({ kind: 'result', response });
    res.end();
  } catch (e) {
    if (e instanceof AnalysisAbortedError) {
      console.log(`[analysis-subset] aborted ${manuscriptId} (client disconnected)`);
      try {
        res.write(`data: ${JSON.stringify({ kind: 'error', code: 'aborted', message: 'Analysis aborted (client disconnected or server restarted).' })}\n\n`);
      } catch { /* connection already torn down */ }
      try { res.end(); } catch { /* already ended */ }
      return;
    }
    const { code, message, detail } = describeError(e, analyzerLabel);
    console.error('[analysis-subset] failed', { manuscriptId, code, message });
    send({ kind: 'error', code, message, detail });
    res.end();
  }
});

/* The Gemini SDK throws `ApiError` instances whose `.message` is the raw
   JSON envelope (e.g. `{"error":{"code":503,"message":"...","status":"...","details":[...]}}`).
   Surface a friendly, copy-pasteable line for the UI plus a short `code` the
   client can switch on (rate_limit | unavailable | internal | invalid_key |
   network | unknown), and a structured `detail` string the UI can show in a
   collapsible block — preserves the upstream details[] array which usually
   names the field/quota that triggered the failure. */
function describeError(
  err: unknown,
  modelLabel: string,
): { code: string; message: string; detail?: string } {
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;

  const parsed = tryParseApiError(raw);
  if (parsed) {
    const code = classifyStatus(parsed.code ?? status, parsed.message);
    /* Only trim quota messages — 4xx/5xx bodies are usually short and
       informative (an INVALID_ARGUMENT body names the failed field), so
       trimming them throws away the only useful diagnostic. */
    const trimmed = code === 'rate_limit' || code === 'daily_quota'
      ? trimQuotaMessage(parsed.message)
      : parsed.message;
    const statusSuffix = parsed.status ? ` (${parsed.status})` : '';
    const detail = formatErrorDetail(parsed, raw);
    return {
      code,
      message: `${modelLabel} returned ${parsed.code ?? status ?? '???'}${statusSuffix}: ${trimmed}`,
      detail,
    };
  }

  if (status) {
    return { code: classifyStatus(status, raw), message: `${modelLabel} returned ${status}: ${raw}` };
  }
  return { code: 'unknown', message: raw || 'Analysis failed.' };
}

/* Build the detail blob shown in the UI's collapsible. Prefer the
   structured details[] from the upstream envelope; fall back to the raw
   error body so debugging never has to round-trip to the server log. */
function formatErrorDetail(
  parsed: { status?: string; details?: unknown[] },
  raw: string,
): string | undefined {
  const lines: string[] = [];
  if (parsed.status) lines.push(`status: ${parsed.status}`);
  if (parsed.details && parsed.details.length > 0) {
    lines.push('details:');
    lines.push(JSON.stringify(parsed.details, null, 2));
  }
  if (lines.length === 0) {
    /* No structured details — fall back to the raw SDK message, trimmed.
       Useful when the error wasn't a Google API envelope (e.g. network). */
    const trimmed = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
    return trimmed.trim() || undefined;
  }
  return lines.join('\n');
}

/* Google's 429 body is wall-of-text — strip everything after the first
   sentence so the UI alert stays tractable. The full text still lives in
   the server console (and the `detail` blob) for debugging. */
function trimQuotaMessage(message: string): string {
  const firstStop = message.search(/[.\n]/);
  if (firstStop > 0 && firstStop < 240) return message.slice(0, firstStop + 1).trim();
  return message.slice(0, 240) + (message.length > 240 ? '…' : '');
}

function tryParseApiError(
  raw: string,
): { code?: number; message: string; status?: string; details?: unknown[] } | null {
  /* SDK messages often look like 'got status: 503 UNAVAILABLE. {"error":{...}}'.
     Find the first '{' and try to parse from there. */
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as {
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };
    if (obj?.error?.message) {
      return {
        code: obj.error.code,
        message: obj.error.message,
        status: obj.error.status,
        details: obj.error.details,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function classifyStatus(status: number | undefined, message?: string): string {
  if (!status) return 'unknown';
  if (status === 429) {
    /* Distinguish per-day "free tier exhausted" from short-term per-minute
       throttling — the user-facing remedies differ (switch model / wait
       until quota reset vs. just retry). */
    if (message && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(message)) return 'daily_quota';
    return 'rate_limit';
  }
  if (status === 503) return 'unavailable';
  if (status === 500) return 'internal';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 400) return 'bad_request';
  return 'unknown';
}
