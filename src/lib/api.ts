/* API client surface. Real backend lives behind the same `api.*` shape;
   the components never know whether they're talking to fetch() or to
   the mocks below.

   Toggle with VITE_USE_MOCKS=true (.env.development). */

import type {
  AppInfo,
  CompanionApkAvailability,
  Emotion,
  UpgradeStageResult,
  UpgradeStatePayload,
  UploadResponse,
  AnalyseResponse,
  VoiceMatchResponse,
  RevisionsResponse,
  ChapterAudio,
  GenerationTick,
  Character,
  Voice,
  VoiceSample,
  TtsModelKey,
  LibraryResponse,
  VoiceLibraryResponse,
  ImportResponse,
  ConfirmBookRequest,
  ConfirmBookResponse,
  BookStateResponse,
  BookStateJson,
  ChangeLogEvent,
  PutStateRequest,
  WorkspaceChangeLogResponse,
  UserSettings,
  UserSettingsPatch,
  DroppedQuotesResponse,
  AnalysisStateResponse,
  ActiveAnalysesResponse,
  CoverCandidate,
  BookExportRequest,
  BookExportJob,
  BookShareLink,
  ExportLanInfo,
  BaseVoice,
  TtsEngine,
  ChapterLoudness,
  ResourceTelemetryRecord,
  ConfigResponse,
  ConfigValues,
  PromptState,
  PairSessionInfo,
} from './types';
import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';
import { initialCharacters } from '../data/characters';
import { ANALYSIS_NORTHERN_STAR } from '../mocks/canned-data';
import { MOCK_LIBRARY } from '../mocks/library';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
} from '../mocks/marketing/hollow-tide';
import { MOCK_BASE_VOICES, MOCK_VOICE_LIBRARY } from '../mocks/voices';
import { MATCH_FACTORS } from '../data/match-factors';
import { PENDING_REVISIONS } from '../data/revisions';
import { VOICE_DRIFT_EVENTS } from '../data/drift';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import { parseDuration } from './time';
/* Bundled mock audio assets — two short tones so the a/b player + mini
   player + voice samples have something audible to render under
   VITE_USE_MOCKS. ~88 KB each. stub-a (440 Hz) is the "current/A" /
   preserved-previous tone, stub-b (880 Hz) is the "new/B" / fresh-render
   tone. Audibly distinct so a/b in mock mode tells a real story. */
import stubAudioA from '../mocks/audio/stub-a.mp3?url';
import stubAudioB from '../mocks/audio/stub-b.mp3?url';

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
/* Marketing screenshot capture flag (.env.marketing → `--mode marketing`).
   When set, the mock layer serves the additive "Hollow Tide" demo fixtures.
   Off in dev / e2e / prod. */
const DEMO_CAPTURE = import.meta.env.VITE_DEMO_CAPTURE === '1';

/* ── shared helpers ──────────────────────────────────────────────────── */

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inferFormat(fileName?: string): 'markdown' | 'plaintext' | 'epub' | 'pdf' | 'mobi' | null {
  if (!fileName) return null;
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const map: Record<string, 'markdown' | 'plaintext' | 'epub' | 'pdf' | 'mobi'> = {
    md: 'markdown',
    markdown: 'markdown',
    txt: 'plaintext',
    text: 'plaintext',
    epub: 'epub',
    pdf: 'pdf',
    mobi: 'mobi',
    azw3: 'mobi',
  };
  return map[m[1]] ?? null;
}

/* ── argument types ──────────────────────────────────────────────────── */

export interface UploadArgs {
  /** Inline text (used for paste + .md/.txt sample). */
  text?: string;
  /** Raw file (used for binary formats like PDF/EPUB). */
  file?: File;
  fileName?: string;
  format?: 'markdown' | 'plaintext' | 'epub' | 'pdf' | 'mobi';
}
/** Realtime "what's running right now" payload piggybacked on phase ticks.
    Server emits one of these every 500ms while any stage-2 chapter is in
    flight; the analysing view renders one elapsed-of-estimate row per
    in-flight chapter, so a slow chapter doesn't visually hide the chapters
    progressing alongside it. */
export interface AnalysisLiveChapter {
  chapterIndex: number;
  chapterTitle: string;
  elapsedMs: number;
  estMs: number;
}
export interface AnalysisLiveInfo {
  totalChapters: number;
  chapters: AnalysisLiveChapter[];
}
export interface AnalysisHeartbeat {
  phaseId: number;
  /** Bytes of model output received so far on the in-flight LLM call. */
  receivedBytes: number;
  /** Smoothed throughput across the call (receivedBytes / elapsedMs). */
  charsPerSec: number;
  /** Wall-clock since the LLM call started. */
  elapsedMs: number;
  /** Wall-clock since the previous chunk landed — large values during a
      live call mean the model has stalled. */
  sinceLastChunkMs: number;
  /** Stage 2 only: 1-based chapter index this heartbeat is reporting on. */
  chapterIndex?: number;
}

export interface AnalyseOpts {
  /** Lets callers (the analysing view's useEffect cleanup) tear down the
      underlying SSE fetch when the effect re-runs. Without this, a
      "Try again" / model-switch click leaves the previous fetch alive
      until the browser GC's it — at concurrency=1 the server keeps
      working on the old request while the new one queues, manifesting
      to the user as cascading aborts in the server log. */
  signal?: AbortSignal;
  onPhase?: (e: { phaseId: number; progress: number; live?: AnalysisLiveInfo }) => void;
  /** Narrative log lines streamed from the server. Surface them in the
      active phase so the user sees real progress (e.g. detected characters,
      sentence counts) instead of canned snippets. */
  onLog?: (e: { phaseId: number; message: string }) => void;
  /** Streaming chunk heartbeat from the analyzer's LLM call. Throttled
      server-side to ~one event per 2s. Designed to render as a live
      one-liner under the active phase header — does NOT enter the log
      buffer, so it can't pollute the cached phase summary. */
  onHeartbeat?: (e: AnalysisHeartbeat) => void;
  /** Refined total-remaining-ms estimate emitted after each chapter
      completes. The server computes this from observed wall-clock
      throughput, so it tracks whichever model the user actually picked
      (Gemini ≈ 4ms/char, local Ollama ≈ 10ms/char). Drives the heading's
      "~N minutes" line — it replaces the static word-count-based
      describeSize string once the first chapter lands. */
  onEta?: (e: { remainingMs: number }) => void;
  /** Live cast snapshot from Phase 0a (per-chapter cast detection). The
      server emits this after each chapter's cast lands, with the full
      running roster. Drives the analysing-view live cast preview so the
      user sees characters appear chapter-by-chapter instead of waiting
      for a whole-book Phase 0 pass to finish. */
  onCastUpdate?: (e: { characters: import('./types').Character[] }) => void;
  /** A chapter's Phase 0a cast detection threw across the analyzer's
      built-in retry. The run continues without it; the chapter id is
      persisted to the analysis cache so the analysing view can render a
      per-chapter Retry button. Emitted by both the full and subset
      analysis routes. */
  onChapterFailed?: (e: { chapterId: number; message: string; code?: string; remediation?: string }) => void;
  /** A previously-failed chapter just had its Phase 0a re-run succeed
      (either via the main route re-queueing failedChapterIds on resume,
      or via the subset retry route). The chapter id has been cleared
      from cache.failedChapterIds server-side. The analysing view drops
      the corresponding Retry row in response so the panel never lags
      behind the cache. Emitted by both the full and subset routes. */
  onChapterResolved?: (e: { chapterId: number }) => void;
  /** The Gemini rate limiter delayed a request to stay under RPM/TPM/RPD
      or to honor a 429 retry-delay. The analysing view renders a
      "Throttling Gemini … · resuming in Ns" pill on the affected
      per-chapter row instead of letting it look like a hang. Only
      emitted when the wait exceeds ~1s. */
  onThrottle?: (e: {
    phaseId: number;
    chapterIndex: number;
    model: string;
    waitMs: number;
    reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after';
  }) => void;
  /** One-shot event emitted at Phase 0 entry when the analyzer has
      pre-seeded its per-chapter prompt with characters carried over
      from prior books in the same series (plan 04 + plan 09). The
      analysing view renders a small "Carrying in N characters from
      prior books" pill so the user sees the context being applied.
      `names` is the first three for display; `count` is the total. */
  onSeriesPrior?: (e: { count: number; names: string[] }) => void;
  /** Override the server's default analysis model (e.g. 'gemini-3-flash-preview').
      Sent as JSON body to POST /api/manuscripts/:id/analysis. */
  model?: string;
  /** Discard any cached partial progress for this manuscript before running.
      The "Start fresh" button in the analysing view sets this. */
  fresh?: boolean;
  /** Explicit opt-in to accept a stage1 shrink. The server emits
      `stage1_shrink_refused` when a new roster would replace a much
      larger existing one (default: refuse when new < 0.5 * old AND old
      >= 3 characters). The analysing view surfaces the choice as an
      "Accept smaller roster" button; clicking re-fires the request
      with this flag set, which bypasses the gate for that attempt. */
  allowStage1Shrink?: boolean;
}
export interface MatchArgs {
  bookId: string;
  characters: Character[];
}
export interface MergeCharactersArgs {
  bookId: string;
  sourceId: string;
  targetId: string;
}
export interface MergeCharactersResponse {
  characters: Character[];
}
/* POST /api/books/:bookId/cast/:characterId/series-patch — cross-book
   Compare save propagation. Applies the patch to the source character
   AND every series-sibling cast.json row that the plan-94 dedup rule
   recognises as the same person (case/punct-insensitive name+alias
   match). Body is intentionally narrow: voice override + audio-affecting
   fields are NOT accepted here (those are book-local decisions).
   Response separates successful writes from failed ones so the caller
   can surface a per-book error toast alongside the success toast. */
export interface SeriesPatchCharacterArgs {
  bookId: string;
  characterId: string;
  patch: {
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    tone?: {
      warmth?: number;
      pace?: number;
      authority?: number;
      emotion?: number;
    };
  };
}
export interface SeriesPatchTarget {
  bookId: string;
  bookTitle: string;
  characterId: string;
}
export interface SeriesPatchFailure {
  bookId: string;
  bookTitle: string;
  error: string;
}
export interface SeriesPatchCharacterResponse {
  updated: SeriesPatchTarget[];
  failed: SeriesPatchFailure[];
}
/* Symmetric "best-of-both" profile merge across the current book and a
   matched library book: both end up with the same merged identity (longest
   description wins, attributes / aliases unioned, source wins on identity
   conflicts), while each side keeps its own audio identity, per-book
   metrics, and per-book evidence. Server returns both merged records so
   the confirm view can refresh its in-memory source character. */
export interface OverrideLibraryCastArgs {
  sourceBookId: string;
  sourceCharacterId: string;
  targetBookId: string;
  targetCharacterId: string;
}
export interface OverrideLibraryCastResponse {
  source: Character;
  target: Character;
}
/* Manual continuity link to a prior series book — used when the
   auto-matcher's name-score floor missed a legitimate link (e.g. "Dex"
   in book 1 vs "Dexter Alvin Diznee" in book 2). Server appends
   source.name to the prior book's character.aliases on disk, then
   returns the matchedFrom payload the frontend dispatches via
   castActions.applyManualMatch so the "Continuity preserved" footer +
   "Sync profile" checkbox light up exactly like an auto-match. */
export interface LinkPriorCharacterArgs {
  bookId: string;
  sourceCharacterId: string;
  targetBookId: string;
  targetCharacterId: string;
}
export interface LinkPriorCharacterResponse {
  matchedFrom: {
    bookId: string;
    characterId: string;
    bookTitle: string;
    confidence: number;
  };
  voiceId?: string;
  /* Profile content merged FROM the prior character onto the source at link
     time (representative quotes + descriptors). Present only when the merge
     actually changed something. The frontend applies it via applyManualMatch
     so the open drawer shows the reused character's quotes without a reload. */
  profile?: {
    evidence?: import('./types').Character['evidence'];
    attributes?: string[];
    description?: string;
    tone?: import('./types').Character['tone'];
    gender?: import('./types').Character['gender'];
    ageRange?: import('./types').Character['ageRange'];
  };
}
/* Series roster — the union of confirmed casts across every prior book
   in the same (author, series). Powers the Profile Drawer's "From prior
   books in <series>" optgroup so the user can manually link to a
   character the auto-matcher missed. Standalones, unconfirmed casts,
   and the source book itself are excluded by the server. */
export interface SeriesRosterEntry {
  id: string;
  name: string;
  bookId: string;
  bookTitle: string;
  voiceId?: string;
  aliases?: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
}
export interface SeriesRosterResponse {
  characters: SeriesRosterEntry[];
}
/* GET /api/books/:bookId/series-cast — the FULL cast (every cast.json field:
   lines, voiceStyle, overrideTtsVoices, ttsEngine, voiceId, …) of every OTHER
   confirmed book in the same (author, series). Distinct from getSeriesRoster's
   thin entries — the rebaseline modal needs the same shape getBookState
   returns so it can merge series-mates onto the anchor cast (merge-series-cast.ts).
   Each character also carries `sourceBookId`/`sourceBookTitle` provenance. */
export interface SeriesCastResponse {
  characters: import('./types').Character[];
}
/* POST /api/books/:bookId/cast/add-from-roster — add a new local
   character pulled from a prior series-mate's cast. Used by the
   manuscript-view reassign picker when the analyzer missed a
   recurring series character entirely (no local row to link via the
   sibling cast/link-prior endpoint). Server appends a new row to the
   source book's cast.json with voiceId + voiceState='reused' +
   matchedFrom populated, and returns the full new character record so
   the frontend can dispatch castActions.addCharacter and immediately
   reassign the sentence in one click. */
export interface AddFromSeriesRosterArgs {
  bookId: string;
  targetBookId: string;
  targetCharacterId: string;
}
export interface AddFromSeriesRosterResponse {
  character: import('./types').Character;
}
/* POST /api/books/:bookId/cast/unlink-alias — split a misplaced alias
   chip off its current character and back into its own standalone cast
   member. Server reads the preserved Phase-0a chapterCast to identify
   which chapters originally featured the alias, then returns candidate
   sentence ids (sentences currently attributed to the source character
   in those chapters) so the frontend's reattribute modal can let the
   user move the right lines via the existing per-sentence picker.
   No sentence rewrites happen server-side. */
export interface UnlinkAliasArgs {
  bookId: string;
  sourceCharacterId: string;
  aliasName: string;
}
export interface UnlinkAliasImpactedChapter {
  chapterId: number;
  candidateSentenceIds: number[];
}
export interface UnlinkAliasResponse {
  /** The newly-minted standalone character — frontend appends this to
      the cast slice via a delta reducer rather than replacing the full
      list. */
  newCharacter: Character;
  /** Chapters whose Phase-0a roster originally listed this alias, each
      with the IDs of sentences currently attributed to the source
      character so the Reattribute Lines modal can render them. */
  impactedChapters: UnlinkAliasImpactedChapter[];
}
/* POST /api/books/:bookId/cast/add-alias — append a name to a
   character's aliases list (idempotent; case-insensitive dedup; rejects
   the character's own name to keep self-aliases out). Future analyzer
   runs of subsequent books in the series will route the alias to this
   character via the matcher. */
export interface AddAliasArgs {
  bookId: string;
  characterId: string;
  aliasName: string;
}
export interface AddAliasResponse {
  /** Echo of the addition: target character + the alias text, plus the
      `alreadyPresent` flag so the frontend can distinguish a no-op
      re-add from a fresh append without diffing the cast. */
  characterId: string;
  alias: string;
  alreadyPresent: boolean;
}
/* POST /api/books/:bookId/cast/:characterId/voice-style/generate (single)
   and /cast/voice-style/generate-all (batch) — plan 108. The server makes
   ONE Gemini (`gemini-3.1-flash-lite`) call per character from the
   character's full profile + dialogue evidence, persists the resulting
   natural-language voice-design persona on the character in cast.json, and
   returns it. The batch route loops the cast (narrator skipped by default),
   tolerates per-character failures, and returns the successes keyed by
   character id alongside a per-character failure map. The persona seeds the
   Qwen sidecar's bespoke voice-design flow; the drawer UI (Wave 4) lets the
   user edit it. */
export interface GenerateVoiceStyleResponse {
  voiceStyle: string;
}
export interface GenerateAllVoiceStylesResponse {
  voiceStyles: Record<string, string>;
  failures: Record<string, string>;
}

/* Persona (`instruct`) read back from a character's already-DESIGNED Qwen
   voice sidecar (plan 149). The drawer calls this lazily to seed the "Voice
   persona" textarea when `character.voiceStyle` is empty but the voice is
   designed — so a reused/origin character whose persona was never mirrored
   onto `voiceStyle` still shows it (and isn't blocked from re-designing).
   `instruct` is '' when no sidecar/persona exists on disk. */
export interface FetchDesignedPersonaResponse {
  instruct: string;
}

/* Design + audition a bespoke Qwen voice for a cast member (plan 108,
   Wave 4). The server proxies the sidecar's /qwen/design-voice, which
   caches a reusable speaker embedding under a derived voiceId. The audition
   speaks the character's own line and is written into the voice-sample cache,
   so `previewUrl` IS the 12s sample — clicking "Play 12s" afterwards is a
   cache hit, not a second synthesis. The Profile Drawer plays `previewUrl`
   and, on Save, pins `voiceId` into overrideTtsVoices.qwen. */
export interface DesignQwenVoiceArgs {
  /** Natural-language persona. Defaults server-side to the character's
      persisted voiceStyle when omitted. */
  persona?: string;
  /** The voiceId path the /sample player will use as its cache scope — pass
      the same value the drawer would send to getVoiceSample. */
  sampleVoiceId: string;
  /** The TTS modelKey the sample is cached under (the Qwen sample key). */
  modelKey: TtsModelKey;
  /** Plan 161 — stage the design under a `-preview` sibling id instead of
      overwriting the live voice, so the A/B compare can audition it without
      committing. The drawer promotes it on approve / discards on cancel. */
  preview?: boolean;
  /** fs-25 — design an emotion VARIANT (whisper/angry/excited/sad) under
      `<base>__<emotion>` with an emotion-augmented instruct; the server records
      it on `overrideTtsVoices.qwen.variants[emotion]`. Omit for the base voice. */
  emotion?: Emotion;
}

export interface DesignQwenVoiceResponse {
  /** Derived cache voiceId (the designed-voice embedding id — `…-preview`
      when designed with `preview: true`). */
  voiceId: string;
  /** Stable URL of the cached audition MP3 (= the 12s sample). Not a blob —
      nothing to revoke. */
  previewUrl: string;
}

/** Plan 161 — promote a previewed design onto the character's stable voiceId
    (commit) or discard it (cancel). */
export interface PromoteQwenVoiceArgs {
  previewVoiceId: string;
  sampleVoiceId: string;
  modelKey: TtsModelKey;
}
export interface PromoteQwenVoiceResponse {
  /** The committed (stable) voiceId. */
  voiceId: string;
  /** URL of the audition cached under the committed id. */
  url: string;
}

/** Optional scope for a voice-override write (plan 108). Default
    'workspace' (back-compat); 'series' limits the write to the
    (author, series) of `bookId`. */
export interface VoiceOverrideScope {
  scope?: 'series' | 'workspace';
  bookId?: string;
}
export interface StreamArgs {
  bookId: string;
  modelKey: TtsModelKey;
  /** Optional chapter subset; defaults to all chapters lacking audio on disk. */
  chapterIds?: number[];
  /** Re-synthesise even if a chapter's MP3 already exists. */
  force?: boolean;
  /** Used by the mock to drive its in-memory progress; ignored by the real
      implementation (the server knows what's on disk). Keep it optional so
      callers can stop providing it once the mock is gone. The full `Chapter`
      shape is what the middleware feeds back, including `characters` — the
      mock uses that to cycle the active speaker pill as progress advances. */
  getChapters?: () => Array<{
    id: number;
    state: string;
    progress?: number;
    totalLines?: number;
    characters: Record<string, string>;
    /** Hydrated duration string ('MM:SS' / 'HH:MM:SS' / '00:00' placeholder).
        Mock uses it to back-derive a plausible `durationSec` for the
        chapter_complete tick so the Listen-view chapter row flips to a
        real value when the fixture carries one. Empty / '00:00' falls
        back to a synthetic per-line average. */
    duration?: string;
  }>;
  onTick: (ev: GenerationTick & { type: GenerationTick['type'] }) => void;
  /** Mock-only: number of chapters to keep in-flight in parallel. Mirrors the
      server's `GEN_WORKERS` (default 1 — see plan 87 archive). The
      real `streamGeneration` ignores this; the mock uses it to interleave SSE
      events across K chapters so browser-level specs can pin the parallel-SSE
      contract. Defaults to 1 when unset, capped by the number of queued
      chapters at tick time. Vitest callers pass through the StreamArgs object;
      the e2e harness can additionally seed `window.__mockGenConcurrency` to
      override without touching the middleware. */
  mockGenConcurrency?: number;
  /** Plan 102 — workspace queue entry id this stream is fulfilling. Threaded
      to the server so it can stamp every tick (including the new `resume_from`
      ack) with the id, letting the frontend dispatcher correlate ticks back
      to the right queue row even when entries from different books interleave.
      Optional for back-compat — pre-plan-102 callers still work, ticks just
      don't carry the field. */
  queueEntryId?: string;
}
/** fs-26 — one SSE frame from the per-character splice endpoint. */
export type SpliceTick =
  | { type: 'splice_start'; chapterId: number; mode: 'remix' | 'rerecord'; characterId: string }
  | { type: 'progress'; chapterId: number; characterId?: string; progress: number }
  | { type: 'chapter_assembling'; chapterId: number; progress: number }
  | {
      type: 'splice_complete';
      chapterId: number;
      characterId: string;
      mode: 'remix' | 'rerecord';
      durationSec: number;
      segmentCount: number;
      hasPreviousAudio: boolean;
    }
  | { type: 'chapter_failed'; chapterId?: number; errorReason: string };

export interface SpliceArgs {
  bookId: string;
  chapterId: number;
  /** `remix` applies a dB gain (no GPU); `rerecord` re-synthesises. */
  mode: 'remix' | 'rerecord';
  characterId: string;
  /** remix only — signed dB, clamped server-side to [-24, +24]. */
  gainDb?: number;
  /** rerecord only — optional subset of the character's segments. */
  segmentIndices?: number[];
  /** rerecord only — TTS model to synthesise with. */
  modelKey?: TtsModelKey;
  onTick: (ev: SpliceTick) => void;
  /** Optional cancellation (e.g. user cancels a multi-chapter batch). */
  signal?: AbortSignal;
}

export interface AudioArgs {
  bookId: string;
  chapterId: number;
  duration?: string;
}
export interface PollArgs {
  bookId: string;
}
export interface VoiceSampleArgs {
  voiceId: string;
  voice: Voice;
  modelKey: TtsModelKey;
  text?: string;
  /* Optional character context — description, evidence quotes, gender, age,
     tone — that the server uses to pick a more appropriate Gemini voice and
     to render an in-character sample script. */
  characterHint?: {
    description?: string;
    role?: string;
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    evidence?: string[];
    tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  };
}

export interface BaseVoiceSampleArgs {
  engine: TtsEngine;
  speakerName: string;
  /** Caller's currently-selected modelKey. The server re-maps to a
      compatible model when this doesn't route to `engine`. */
  modelKey: TtsModelKey;
  /** Optional sample text the server should speak. When omitted the
      server falls back to its canned RAW_SAMPLE_TEXT. Used by the
      profile-drawer preview affordance so the user can audition a
      candidate voice on a line of their choosing. */
  text?: string;
}

/* ── mock implementations ────────────────────────────────────────────── */

async function mockGetLibrary(): Promise<LibraryResponse> {
  await wait(120);
  if (DEMO_CAPTURE) return HOLLOW_TIDE_LIBRARY;
  return MOCK_LIBRARY;
}

async function mockGetVoices(_args?: { currentBookId?: string }): Promise<VoiceLibraryResponse> {
  await wait(80);
  if (DEMO_CAPTURE) return HOLLOW_TIDE_VOICES;
  return MOCK_VOICE_LIBRARY;
}

async function mockSetVoicePin(_voiceId: string, _pinned: boolean): Promise<void> {
  await wait(20);
}

async function mockGetBaseVoices(): Promise<{ voices: BaseVoice[] }> {
  await wait(40);
  return { voices: MOCK_BASE_VOICES };
}

async function mockSetVoiceOverride(
  _voiceId: string,
  _override: BaseVoice | null,
  _opts?: VoiceOverrideScope,
): Promise<void> {
  await wait(20);
}

async function mockSetVoiceOverrideLinked(
  _bookId: string,
  characterId: string,
  _override: BaseVoice | null,
): Promise<LinkedOverrideResponse> {
  /* Single-book mock workspace — no series-mates to propagate to. Echo a
     benign success so the rebaseline approve round-trips under VITE_USE_MOCKS. */
  await wait(20);
  return { canonicalVoiceId: characterId, updated: [], failed: [] };
}

/* Mock Qwen voice design — returns a deterministic derived voiceId and a
   cache-style sample URL (matching the real route's shape, now that the
   audition IS the cached 12s sample) so the drawer's audition button
   round-trips under VITE_USE_MOCKS without a live sidecar. */
async function mockDesignQwenVoice(
  _bookId: string,
  characterId: string,
  { sampleVoiceId, modelKey, preview, emotion }: DesignQwenVoiceArgs,
): Promise<DesignQwenVoiceResponse> {
  await wait(120);
  const variantSuffix = emotion ? `__${emotion}` : '';
  const voiceId = `qwen-${characterId}${variantSuffix}${preview ? '-preview' : ''}`;
  const suffix = preview ? '-preview' : '';
  const previewUrl = `/audio/voices/${sampleVoiceId}-${modelKey}${suffix}-mock.mp3`;
  return { voiceId, previewUrl };
}

async function mockPromoteQwenVoice(
  _bookId: string,
  _characterId: string,
  { previewVoiceId, sampleVoiceId, modelKey }: PromoteQwenVoiceArgs,
): Promise<PromoteQwenVoiceResponse> {
  await wait(60);
  const voiceId = previewVoiceId.replace(/-preview$/, '');
  return { voiceId, url: `/audio/voices/${sampleVoiceId}-${modelKey}-mock.mp3` };
}

async function mockDiscardQwenPreview(
  _bookId: string,
  _characterId: string,
  _args: PromoteQwenVoiceArgs,
): Promise<void> {
  await wait(20);
}

async function mockImportManuscript({ text, file, fileName }: UploadArgs): Promise<ImportResponse> {
  await wait(250);
  const effectiveName = fileName ?? file?.name ?? null;
  const effectiveText = text ?? '';
  const h1 = effectiveText.match(/^#\s+(.+)$/m);
  const stem = effectiveName?.replace(/\.[^.]+$/, '') ?? '';
  const m = /^(?<author>.+?)\s+-\s+(?<series>.+?)\s+(?<pos>\d+)\s+-\s+(?<title>.+)$/.exec(stem);
  let title = (h1 && h1[1].trim()) || m?.groups?.title || stem || 'Untitled manuscript';
  let series: string | null = m?.groups?.series ?? null;
  let seriesPosition: number | null = m?.groups?.pos ? parseInt(m.groups.pos, 10) : null;
  /* Bug B: mirror server-side parseSeriesFromTitle so e2e specs can
     exercise the "EPUB title carries the series in a parenthetical"
     path without a live server. Conservative parenthetical only. */
  let seriesFromTitle = false;
  if (!series && title) {
    const titleMatch =
      /^(?<title>.+?)\s*\((?<series>.+?)\s+(?:Book|#)\s*(?<pos>\d+(?:\.\d+)?)\)\s*$/i.exec(title);
    if (titleMatch?.groups) {
      title = titleMatch.groups.title!.trim();
      series = titleMatch.groups.series!.trim();
      seriesPosition = parseFloat(titleMatch.groups.pos!);
      seriesFromTitle = true;
    }
  }
  const candidate = {
    format: (inferFormat(effectiveName ?? undefined) ?? 'markdown') as UploadResponse['format'],
    title,
    author: m?.groups?.author ?? null,
    series,
    seriesPosition,
    seriesFromTitle,
    sourceText: effectiveText,
    wordCount: effectiveText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: file ? file.size : new Blob([effectiveText]).size,
    chapters: [{ id: 1, title: 'Chapter 1' }],
  };
  return { tempId: 'imp_' + Math.random().toString(36).slice(2, 10), candidate };
}

/* In-memory mock backing store for book state, keyed by bookId. Patterns
   match MOCK_EXPORT_JOBS (below) — module-scoped so writes survive across
   calls within a session. Cleared by a full page reload, since mocks have
   no disk.

   Pre-seeded with the 'complete' books from `src/data/books.ts` so the
   Listen view + mini-player has chapters to render when the user clicks
   straight into a ready book under mocks (e.g. the e2e
   `listen-playback.spec.ts` walkthrough). Without the seed, mockGetBookState
   returned null → Layout's hydrate effect short-circuited → chapters slice
   stayed empty → Listen view rendered a disabled "Play from the start"
   button against an empty playlist. */
const MOCK_BOOK_STATES = new Map<string, BookStateResponse>();

/* Solway Bay — the 'complete' fixture book at src/data/books.ts.
   18 chapters, all rendered. Durations sum to roughly 11h 24m to match the
   library card's `runtime`. Slugs follow the `NN-kebab-title` convention
   the server uses (see scan.ts `slug()` helper). */
const SB_CHAPTERS: BookStateJson['chapters'] = [
  { id: 1, title: 'Arrival', slug: '01-arrival', duration: '38:24' },
  { id: 2, title: 'The Pier', slug: '02-the-pier', duration: '42:17' },
  { id: 3, title: 'Lights in the Window', slug: '03-lights-in-the-window', duration: '31:08' },
  { id: 4, title: 'A Letter from London', slug: '04-a-letter-from-london', duration: '36:55' },
  { id: 5, title: 'The Storm', slug: '05-the-storm', duration: '44:02' },
  { id: 6, title: 'Morning Tide', slug: '06-morning-tide', duration: '33:19' },
  { id: 7, title: 'The Keeper at Dusk', slug: '07-the-keeper-at-dusk', duration: '40:11' },
  { id: 8, title: 'A Boat in the Reeds', slug: '08-a-boat-in-the-reeds', duration: '37:45' },
  { id: 9, title: 'The Memorial', slug: '09-the-memorial', duration: '29:33' },
  { id: 10, title: 'Inheritance', slug: '10-inheritance', duration: '41:50' },
  { id: 11, title: "The Whaler's Wife", slug: '11-the-whalers-wife', duration: '35:22' },
  { id: 12, title: 'A Bell at Midnight', slug: '12-a-bell-at-midnight', duration: '32:48' },
  { id: 13, title: 'Crossing', slug: '13-crossing', duration: '38:17' },
  { id: 14, title: 'The Diary', slug: '14-the-diary', duration: '43:01' },
  { id: 15, title: 'Salt and Glass', slug: '15-salt-and-glass', duration: '36:09' },
  { id: 16, title: 'The Search', slug: '16-the-search', duration: '39:54' },
  { id: 17, title: 'Solway Bay', slug: '17-solway-bay', duration: '40:33' },
  { id: 18, title: 'Light Returning', slug: '18-light-returning', duration: '28:42' },
];

function buildSolwayBayMockState(): BookStateResponse {
  const now = new Date().toISOString();
  /* Plan 77 — seed each chapter with a deterministic mock LUFS payload so
     the listen-view report card has something to render under mocks. The
     spread mixes on-target (most), slight-drift (a couple), and off-target
     (one) chapters so the demo content exercises every badge colour. Two
     chapters intentionally carry `twoPass: false` to exercise the
     single-pass-degrades-to-neutral path, and one is left as `null` to
     prove the missing-sidecar fallback. */
  const target = -16;
  const driftPattern: Array<{ deltaFromTarget: number; twoPass: boolean } | null> = [
    { deltaFromTarget: 0.1, twoPass: true },
    { deltaFromTarget: -1.2, twoPass: true },
    { deltaFromTarget: 0.4, twoPass: true },
    { deltaFromTarget: 2.6, twoPass: true },
    { deltaFromTarget: -0.5, twoPass: true },
    { deltaFromTarget: 0.0, twoPass: true },
    { deltaFromTarget: -3.2, twoPass: true },
    { deltaFromTarget: 0.7, twoPass: true },
    { deltaFromTarget: 4.4, twoPass: true },
    { deltaFromTarget: -0.3, twoPass: true },
    { deltaFromTarget: 0.0, twoPass: false },
    { deltaFromTarget: -0.1, twoPass: true },
    { deltaFromTarget: 1.1, twoPass: true },
    null,
    { deltaFromTarget: 0.0, twoPass: false },
    { deltaFromTarget: -0.6, twoPass: true },
    { deltaFromTarget: 0.2, twoPass: true },
    { deltaFromTarget: 0.0, twoPass: true },
  ];
  const chapterLufs: Record<number, ChapterLoudness | null> = {};
  for (let i = 0; i < SB_CHAPTERS.length; i++) {
    const ch = SB_CHAPTERS[i];
    const pattern = driftPattern[i] ?? null;
    if (pattern === null) {
      chapterLufs[ch.id] = null;
      continue;
    }
    chapterLufs[ch.id] = {
      i: target + pattern.deltaFromTarget,
      lra: 7 + (i % 3),
      tp: -1.5 - (i % 2) * 0.4,
      target,
      twoPass: pattern.twoPass,
      measuredAt: new Date(Date.now() - (i + 1) * 36_000_000).toISOString(),
    };
  }
  return {
    state: {
      bookId: 'sb',
      manuscriptId: 'mns_sb',
      title: 'Solway Bay',
      author: 'Marin Vale',
      series: 'Northern Coast Trilogy',
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: true,
      chapters: SB_CHAPTERS,
      coverGradient: ['#6B6663', '#1A1A1A'],
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
      genre: null,
      publicationDate: null,
    },
    /* cast stays null so the existing voices-compare e2e spec's
       "Compare button disabled under mocks (cast slice empty)"
       assertion continues to hold. Listen view doesn't need cast to
       render the chapter playlist. */
    cast: null,
    manuscript: { wordCount: 82_400, format: 'epub' },
    manuscriptEdits: null,
    revisions: null,
    /* Every chapter is rendered (matches the library card's
       completedChapters: 18). hydrateFromBookState then flips each
       chapter row to state: 'done', which makes them appear as
       playable in the Listen view's playlist. */
    completedSlugs: SB_CHAPTERS.map((c) => c.slug),
    chapterCharacters: undefined,
    chapterLufs,
    changeLog: null,
    analysis: undefined,
  };
}

/* Northern Star — primary mock book referenced by mostly every test
   fixture (`ANALYSIS_NORTHERN_STAR`, profile-drawer specs, voice-mapping
   specs). Plan 60 (voice library global-tab compare) needs a non-null
   `cast` field so `api.getBookState('ns')` resolves the initial cast
   when the user kicks off Compare from the global `#/voices` tab. The
   rest of the response is minimal — only the fields the global-compare
   flow reads (cast) and a barebones `state` so type-narrowing doesn't
   surprise downstream callers if they bump into it. */
function buildNorthernStarMockState(): BookStateResponse {
  const now = new Date().toISOString();
  return {
    state: {
      bookId: 'ns',
      manuscriptId: 'mns_ns',
      title: 'The Northern Star',
      author: 'Marin Vale',
      series: 'Northern Coast Trilogy',
      seriesPosition: 2,
      isStandalone: false,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#3C194F', '#0F0E0D'],
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
      genre: null,
      publicationDate: null,
    },
    cast: { characters: initialCharacters },
    manuscript: { wordCount: 78_300, format: 'epub' },
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: [],
    chapterCharacters: undefined,
    changeLog: null,
    analysis: undefined,
  };
}

/* Carrick's Compass — third Northern Coast Trilogy book. Plan 101 bug fix:
   hosts the cross-book duplicate partner "Eliza" (voice `v_eliza_cc`),
   which pairs with "Eliza Gray" (`v_eliza` in `ns`) on the shared Kore
   base voice. Unlike `sb` (cast: null), this book carries a NON-null cast
   so the duplicate-review modal can hydrate both sides, resolve their
   Characters, and enable the link/variant buttons. The cast contains the
   Eliza partner (resolves `v_eliza_cc` via voiceId) plus First Mate Greene
   (the existing `v_navigator` cc voice) so `findCharacterForVoice` lands a
   match on the foreign side. */
/* fe-15 — Carrick's Compass carries BOTH a non-null cast AND chapters its
   cast speaks in, so the profile-regen preview flow (change a voice →
   Regenerate this character → Preview → A/B player) is e2e-drivable under
   mocks. `eliza_cc` speaks in CH1/2/3 (CH1 is the preview sample, CH2/3 fan
   out on Approve); `greene` speaks in CH2/3/4. completedSlugs stays empty so
   the chapters hydrate `queued` and mockStreamGeneration can drive them. */
const CC_CHAPTERS: BookStateJson['chapters'] = [
  { id: 1, title: 'Casting Off', slug: '01-casting-off', duration: '34:12' },
  { id: 2, title: 'Dead Reckoning', slug: '02-dead-reckoning', duration: '41:55' },
  { id: 3, title: 'The Lee Shore', slug: '03-the-lee-shore', duration: '38:07' },
  { id: 4, title: 'Landfall', slug: '04-landfall', duration: '29:44' },
];

function buildCarricksCompassMockState(): BookStateResponse {
  const now = new Date().toISOString();
  return {
    state: {
      bookId: 'cc',
      manuscriptId: 'mns_cc',
      title: "Carrick's Compass",
      author: 'Marin Vale',
      series: 'Northern Coast Trilogy',
      seriesPosition: 3,
      isStandalone: false,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: true,
      chapters: CC_CHAPTERS,
      coverGradient: ['#D4A04E', '#7B5A26'],
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
      genre: null,
      publicationDate: null,
    },
    cast: {
      characters: [
        {
          id: 'eliza_cc',
          name: 'Eliza',
          role: 'Returning stowaway',
          color: 'eliza',
          attributes: ['Female', 'Alto', 'Working-class London', '20s', 'Defiant'],
          voiceId: 'v_eliza_cc',
          voiceState: 'reused',
          description: 'The same Eliza, three books on — older, no less sharp.',
        },
        {
          id: 'greene',
          name: 'First Mate Greene',
          role: 'Navigator',
          color: 'halloran',
          attributes: ['Female', 'Mezzo', 'Irish', '40s', 'Pragmatic'],
          voiceId: 'v_navigator',
          voiceState: 'generated',
          description: 'Reads the coast by feel. Trusts the compass less than her gut.',
        },
      ],
    },
    manuscript: { wordCount: 91_200, format: 'epub' },
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: [],
    chapterCharacters: { 1: ['eliza_cc'], 2: ['eliza_cc', 'greene'], 3: ['eliza_cc', 'greene'], 4: ['greene'] },
    changeLog: null,
    analysis: undefined,
  };
}

/* Seed the default fixtures. Called at module init AND from
   _resetMockBookStates so per-test resets restore the default surface. */
function seedDefaultMockBookStates(): void {
  MOCK_BOOK_STATES.set('sb', buildSolwayBayMockState());
  MOCK_BOOK_STATES.set('ns', buildNorthernStarMockState());
  MOCK_BOOK_STATES.set('cc', buildCarricksCompassMockState());
}
seedDefaultMockBookStates();

function emptyBookStateResponse(bookId: string): BookStateResponse {
  const now = new Date().toISOString();
  return {
    state: {
      bookId,
      manuscriptId: '',
      title: '',
      author: '',
      series: '',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: '',
      castConfirmed: false,
      chapters: [],
      coverGradient: ['#ffd6c2', '#f3a8d0'],
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
      genre: null,
      publicationDate: null,
    },
    cast: null,
    manuscript: null,
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: [],
    chapterCharacters: undefined,
    changeLog: null,
    analysis: undefined,
  };
}

/* Apply a slice-write the same way `server/src/routes/book-state.ts:312`
   does: `state` patch-merges over editorial fields; every other slice
   full-replaces the matching sub-slice. The mock doesn't need the
   server's folder-rename / chapter-title-refresh logic — it just owns
   the response shape the UI sees. */
function applyMockSliceWrite(prev: BookStateResponse, req: PutStateRequest): BookStateResponse {
  switch (req.slice) {
    case 'cast':
      return { ...prev, cast: req.patch as BookStateResponse['cast'] };
    case 'manuscript':
      return { ...prev, manuscriptEdits: req.patch as BookStateResponse['manuscriptEdits'] };
    case 'revisions':
      return { ...prev, revisions: req.patch as BookStateResponse['revisions'] };
    case 'changeLog': {
      const events =
        (req.patch as { events?: ChangeLogEvent[] } | null | undefined)?.events ?? null;
      return { ...prev, changeLog: events };
    }
    case 'state': {
      const patch = (req.patch ?? {}) as Partial<BookStateJson>;
      const next: BookStateJson = {
        ...prev.state,
        castConfirmed: patch.castConfirmed ?? prev.state.castConfirmed,
        chapters: patch.chapters ?? prev.state.chapters,
        title: patch.title ?? prev.state.title,
        author: patch.author ?? prev.state.author,
        series: patch.series ?? prev.state.series,
        seriesPosition:
          patch.seriesPosition !== undefined ? patch.seriesPosition : prev.state.seriesPosition,
        isStandalone: patch.isStandalone ?? prev.state.isStandalone,
        narratorCredit:
          patch.narratorCredit !== undefined ? patch.narratorCredit : prev.state.narratorCredit,
        genre: patch.genre !== undefined ? patch.genre : prev.state.genre,
        publicationDate:
          patch.publicationDate !== undefined ? patch.publicationDate : prev.state.publicationDate,
        description: patch.description !== undefined ? patch.description : prev.state.description,
        notes: patch.notes !== undefined ? patch.notes : prev.state.notes,
        updatedAt: new Date().toISOString(),
      };
      return { ...prev, state: next };
    }
    default:
      return prev;
  }
}

/* Exported so api.mock-state.test.ts can hit the mock pair directly,
   bypassing the USE_MOCKS toggle (which the api module locks at import
   time — flipping the env in a test file is too late). */
export async function mockGetBookState(bookId: string): Promise<BookStateResponse | null> {
  await wait(60);
  if (DEMO_CAPTURE && HOLLOW_TIDE_BOOK_STATES.has(bookId)) {
    return HOLLOW_TIDE_BOOK_STATES.get(bookId) ?? null;
  }
  return MOCK_BOOK_STATES.get(bookId) ?? null;
}

export async function mockPutBookState(bookId: string, req: PutStateRequest): Promise<void> {
  await wait(20);
  const prev = MOCK_BOOK_STATES.get(bookId) ?? emptyBookStateResponse(bookId);
  MOCK_BOOK_STATES.set(bookId, applyMockSliceWrite(prev, req));
}

/** Test-only: drop the in-memory mock-state table and restore the
 *  default fixtures. Tests that want a truly empty store can call
 *  MOCK_BOOK_STATES.clear() directly (only the in-file specs in
 *  api.mock-state.test.ts do this today). */
export function _resetMockBookStates(): void {
  MOCK_BOOK_STATES.clear();
  seedDefaultMockBookStates();
}

/* Plan 47 — listen-progress mocks. Module-scope Map so a PUT-then-GET
   round-trips inside a single mock-mode session. Reset for tests via
   _resetMockListenProgress (api.mock-state.test.ts can call this when
   it wants a clean slate). */
const MOCK_LISTEN_PROGRESS = new Map<string, ListenProgress>();

export async function mockGetListenProgress(bookId: string): Promise<ListenProgress | null> {
  await wait(15);
  return MOCK_LISTEN_PROGRESS.get(bookId) ?? null;
}

export async function mockPutListenProgress(
  bookId: string,
  args: {
    chapterId: number;
    currentSec: number;
    playbackRate?: number;
    markers?: ListenProgressMarker[];
  },
): Promise<ListenProgress> {
  await wait(15);
  const record: ListenProgress = {
    chapterId: args.chapterId,
    currentSec: args.currentSec,
    updatedAt: new Date().toISOString(),
    ...(args.playbackRate !== undefined ? { playbackRate: args.playbackRate } : {}),
    ...(args.markers !== undefined ? { markers: args.markers } : {}),
  };
  MOCK_LISTEN_PROGRESS.set(bookId, record);
  return record;
}

export function _resetMockListenProgress(): void {
  MOCK_LISTEN_PROGRESS.clear();
}

async function mockConfirmBook(body: ConfirmBookRequest): Promise<ConfirmBookResponse> {
  await wait(180);
  const bookId = `${body.author.toLowerCase().replace(/[^a-z0-9]+/g, '-')}__${body.isStandalone ? 'standalones' : body.series.toLowerCase().replace(/[^a-z0-9]+/g, '-')}__${body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return {
    bookId,
    manuscriptId: 'mns_' + Math.random().toString(36).slice(2, 10),
    title: body.title,
    author: body.author,
    series: body.isStandalone ? 'Standalones' : body.series,
    seriesPosition: body.isStandalone ? null : body.seriesPosition,
    isStandalone: body.isStandalone,
    format: 'markdown',
    wordCount: 0,
    byteSize: 0,
    uploadedAt: new Date().toISOString(),
    sourceText: '',
    paths: { bookDir: '(mock)', manuscript: '(mock)', dotAudiobook: '(mock)' },
  };
}

async function mockUploadManuscript({
  text,
  file,
  fileName,
  format,
}: UploadArgs): Promise<UploadResponse> {
  await wait(350);
  const effectiveName = fileName ?? file?.name;
  const effectiveText = text ?? '';
  const h1 = effectiveText.match(/^#\s+(.+)$/m);
  const title =
    (h1 && h1[1].trim()) ||
    (effectiveName ? effectiveName.replace(/\.[^.]+$/, '') : 'Untitled manuscript');
  return {
    manuscriptId: 'mns_' + Math.random().toString(36).slice(2, 10),
    format: format || inferFormat(effectiveName) || 'markdown',
    title,
    wordCount: effectiveText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: file ? file.size : new Blob([effectiveText]).size,
    uploadedAt: new Date().toISOString(),
    sourceText: effectiveText,
  };
}

async function mockAnalyseManuscript(
  manuscriptId: string,
  { onPhase }: AnalyseOpts = {},
): Promise<AnalyseResponse> {
  if (DEMO_CAPTURE) {
    const p = HOLLOW_TIDE_POSED.analysing;
    onPhase?.({ phaseId: p.phaseId, progress: p.phaseProgress });
    // Freeze on the analysing screen: never resolve, never advance.
    return new Promise<never>(() => {});
  }
  const res = ANALYSIS_NORTHERN_STAR;
  for (const ph of res.phaseTimings) {
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const progress = Math.min(1, (Date.now() - start) / ph.durationMs);
        onPhase?.({ phaseId: ph.id, progress });
        if (progress >= 1) {
          clearInterval(t);
          resolve();
        }
      }, 60);
    });
  }
  return {
    bookId: res.bookId,
    manuscriptId,
    title: res.title,
    phaseTimings: res.phaseTimings.map((p) => ({
      id: p.id,
      label: p.label,
      duration: p.durationMs,
    })),
    characters: res.characters,
    chapters: res.chapters,
    sentences: res.sentences,
    libraryMatches: res.libraryMatches,
  };
}

async function mockMatchVoices({ bookId, characters }: MatchArgs): Promise<VoiceMatchResponse> {
  await wait(450);
  const matches: VoiceMatchResponse['matches'] = (characters || []).map((c) => {
    const factors = MATCH_FACTORS[c.id] || [];
    if (!c.matchedFrom || !factors.length || !c.voiceId) {
      return { characterId: c.id, candidates: [] };
    }
    return {
      characterId: c.id,
      candidates: [
        {
          voiceId: c.voiceId,
          fromBookId: c.matchedFrom.bookId ?? '',
          fromBookTitle: c.matchedFrom.bookTitle ?? '',
          fromCharacterId: c.matchedFrom.characterId ?? c.id,
          score: c.matchedFrom.confidence ?? 0,
          factors: factors.map((f) => ({
            id: f.id,
            label: f.label,
            score: f.score,
            detail: f.detail,
          })),
        },
      ],
    };
  });
  return { bookId, matches };
}

/* Wrap an onTick callback so a thrown reducer (or any downstream listener)
   doesn't propagate out of the stream wrapper as an unhandled rejection.
   Without this, a reducer crash from a malformed tick bubbles into React's
   error path and — with no app-level boundary — looks to the user like a
   page reload. Logged so regressions are still visible in DevTools. */
function safeOnTick(onTick: StreamArgs['onTick']): StreamArgs['onTick'] {
  return (ev) => {
    try {
      onTick(ev);
    } catch (e) {
      console.error('[api] onTick listener threw, swallowing to avoid app crash:', e);
    }
  };
}

function mockStreamGeneration({
  getChapters,
  onTick: rawOnTick,
  mockGenConcurrency,
}: StreamArgs): () => void {
  const onTick = safeOnTick(rawOnTick);
  if (DEMO_CAPTURE) {
    const g = HOLLOW_TIDE_POSED.generating;
    // One in-flight chapter at ~60%; the 7 completed chapters come from the
    // book-state completedSlugs already hydrated into the queue.
    onTick({
      type: 'progress',
      chapterId: g.chapterId,
      characterId: null,
      progress: 0.6,
      currentLine: 360,
      totalLines: 600,
    });
    return () => {};
  }
  /* Mock the real server's parallel-chapter SSE cadence (plan 87 archive,
     `GEN_WORKERS`, default 1). The server keeps K chapters
     in-flight on a bounded worker pool, so progress / chapter_complete
     events for multiple chapters interleave on the wire — each keyed by
     `chapterId`. Three behaviours that matter:

     1. K-wide in-flight set: every tick advances every chapter that is
        currently `in_progress` and emits a `progress` or `chapter_complete`
        event keyed by that chapter's id. The serial-loop assumption
        (singular `active`) was the gap plan 87 broke server-side and the
        reason the parallel SSE orchestration was only server-vitest-pinned,
        not browser-e2e-pinned.
     2. Auto-promote on completion: when an in-flight chapter crosses
        progress >= 1 (chapter_complete), pull the next queued chapter into
        the set in the SAME tick with its initial 0.01 progress event so
        the K-wide capacity stays saturated. Without this, the heartbeat
        goes cold between chapter N's complete and chapter N+1's first
        progress event and the stall banner pops up while the queue still
        has work.
     3. Cycle characters: rotate the active character per chapter every
        few ticks so the per-character `in_progress` pill walks through
        the cast and the active-speaker caption updates.

     `mockGenConcurrency` (default 1) caps the in-flight set width and
     mirrors `GEN_WORKERS` on the server. Browser-level e2e
     specs can seed `window.__mockGenConcurrency` to force the value
     deterministically without re-plumbing the middleware. */
  const requestedK =
    mockGenConcurrency ??
    (typeof window !== 'undefined'
      ? (window as unknown as { __mockGenConcurrency?: number }).__mockGenConcurrency
      : undefined) ??
    1;
  const targetK = Math.max(1, Math.floor(requestedK));

  const tick = () => {
    const chapters = getChapters?.() ?? [];
    const inFlight = chapters.filter((c) => c.state === 'in_progress');
    const queued = chapters.filter((c) => c.state === 'queued');

    if (inFlight.length === 0 && queued.length === 0) {
      onTick({ type: 'idle' });
      return;
    }

    /* Advance every chapter currently in-flight. Track which ones complete
       on this tick so we can backfill the K-wide set from `queued` in the
       same tick. */
    let completedThisTick = 0;
    for (const active of inFlight) {
      const totalLines = active.totalLines || 600;
      const nextProgress = Math.min(1, (active.progress || 0) + 0.02);
      const currentLine = Math.round(totalLines * nextProgress);
      const cast = Object.keys(active.characters).filter((k) => active.characters[k] !== 'skipped');
      const characterId =
        cast.length > 0
          ? cast[Math.min(cast.length - 1, Math.floor(nextProgress * cast.length))]
          : null;
      if (nextProgress >= 1) completedThisTick += 1;
      /* Mirror the real server's contract: chapter_complete carries
         `durationSec` so the Listen row updates without waiting on the
         (mock-omitted) chapter_assembling tick. Re-uses the chapter's
         pre-canned duration when present; falls back to a synthetic
         ~5 s-per-line value otherwise. */
      const isComplete = nextProgress >= 1;
      const mockDurationSec =
        active.duration && active.duration !== '00:00'
          ? parseDuration(active.duration)
          : totalLines * 5;
      onTick({
        type: isComplete ? 'chapter_complete' : 'progress',
        chapterId: active.id,
        characterId,
        progress: nextProgress,
        currentLine,
        totalLines,
        ...(isComplete ? { durationSec: mockDurationSec } : {}),
      });
    }

    /* Backfill the in-flight set up to K. Two paths land here:
       1. Cold start: nothing was in-flight (`inFlight.length === 0`), pull
          min(K, queued.length) chapters in.
       2. Steady state: a chapter completed this tick, pull `completedThisTick`
          replacements in (still capped by remaining queue).
       Both paths emit an initial 0.01 `progress` event per pulled chapter,
       interleaved with the in-flight ticks already emitted above. */
    const stillInFlight = inFlight.length - completedThisTick;
    const slotsToFill = Math.max(0, targetK - stillInFlight);
    const toPromote = queued.slice(0, Math.min(slotsToFill, queued.length));
    for (const nextUp of toPromote) {
      onTick({
        type: 'progress',
        chapterId: nextUp.id,
        characterId: null,
        progress: 0.01,
        currentLine: 0,
        totalLines: nextUp.totalLines || 600,
      });
    }
  };
  const handle = setInterval(tick, 1200);
  return () => clearInterval(handle);
}

/* fs-26 mock — emits the start → assembling → complete arc synchronously so
   mock-mode (e2e / unit) drives the splice flow without a backend. */
async function mockStreamSplice({ chapterId, mode, characterId, onTick }: SpliceArgs): Promise<void> {
  onTick({ type: 'splice_start', chapterId, mode, characterId });
  await wait(80);
  onTick({ type: 'chapter_assembling', chapterId, progress: 0.99 });
  await wait(80);
  onTick({
    type: 'splice_complete',
    chapterId,
    characterId,
    mode,
    durationSec: 120,
    segmentCount: 1,
    hasPreviousAudio: true,
  });
}

async function mockGetChapterAudio({ chapterId, duration }: AudioArgs): Promise<ChapterAudio> {
  await wait(120);
  const totalSec = parseDuration(duration || '10:00');
  const peakCount = 240;
  /* Deterministic per-chapter envelope: seed a tiny LCG from chapterId so each
     chapter has a stable-but-distinct waveform. (Was Math.random() — fine when
     peaks went unrendered, but the Listen-view rows now draw them, so the
     listen.png / listen-dark.png visual snapshots need a deterministic shape.) */
  let seed = ((Number(chapterId) || 1) * 1009) % 233280;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const peaks = Array.from({ length: peakCount }, (_, i) => {
    const base = 0.35 + 0.45 * Math.sin((i / peakCount) * Math.PI);
    return Math.max(0.05, Math.min(1, base + (rand() - 0.5) * 0.35));
  });
  /* Deterministic per-character segment layout so the Listen-view per-line
     re-record resolver (fs-26) has something to bite on in mock mode: split
     the chapter into three contiguous spans (narrator / halloran / narrator). */
  const third = totalSec / 3;
  return {
    url: stubAudioB,
    durationSec: totalSec,
    peaks,
    sampleRate: 44100,
    segments: [
      { start: 0, end: third, characterId: 'narrator', sentenceId: 1 },
      { start: third, end: third * 2, characterId: 'halloran', sentenceId: 2 },
      { start: third * 2, end: totalSec, characterId: 'narrator', sentenceId: 3 },
    ],
  };
}

/* Previous (A) audio for the revision-diff a/b player. Mock mode always
   resolves — the real backend 404s when no preserved pair exists. */
async function mockGetChapterAudioPrevious({ duration }: AudioArgs): Promise<ChapterAudio> {
  await wait(120);
  const totalSec = parseDuration(duration || '10:00');
  return {
    url: stubAudioA,
    durationSec: totalSec,
    peaks: [],
    sampleRate: 44100,
    segments: [],
  };
}

async function mockGetVoiceSample({ modelKey }: VoiceSampleArgs): Promise<VoiceSample> {
  await wait(200);
  return { url: stubAudioA, durationSec: 12, cached: false, modelKey };
}

async function mockGetBaseVoiceSample({ modelKey }: BaseVoiceSampleArgs): Promise<VoiceSample> {
  await wait(200);
  return { url: stubAudioA, durationSec: 12, cached: false, modelKey };
}

/* Mock accept (DELETE /audio/previous) and reject (POST /audio/previous/restore)
   for the revision-diff a/b player. Both no-op in mock mode — the slice is
   the source of truth, the disk state is fictional. */
async function mockAcceptChapterRevision(_args: {
  bookId: string;
  chapterId: number;
}): Promise<void> {
  await wait(100);
}

async function mockRejectChapterRevision(_args: {
  bookId: string;
  chapterId: number;
}): Promise<void> {
  await wait(100);
}

async function mockPollRevisions(args: PollArgs): Promise<RevisionsResponse> {
  await wait(200);
  /* Filter drift to the requested book so the mock mirrors the server's
     per-book endpoint shape. The dev fixture seeds events for two
     books — the modal's multi-book grouping only renders if the slice
     accumulates entries from each book separately, which is what
     happens when `applyPoll` is called once per book.

     NOTE: `pending` is returned for every book (the slice's `applyPoll`
     replaces `pending` wholesale regardless of bookId, so scoping it here
     would let a background poll of an empty book wipe the active book's
     pending). The fe-15 profile-regen-preview spec clears `pending` itself
     before opening its preview stub to avoid the phantom-revision collision. */
  return {
    pending: PENDING_REVISIONS,
    drift: VOICE_DRIFT_EVENTS.filter((d) => !args.bookId || d.bookId === args.bookId),
  };
}

/* ── real fetch-based implementations ────────────────────────────────── */

async function realGetLibrary(): Promise<LibraryResponse> {
  const res = await fetch('/api/library');
  if (!res.ok)
    throw new Error(`Library scan failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realGetVoices(args?: {
  currentBookId?: string;
  engine?: string;
}): Promise<VoiceLibraryResponse> {
  const params = new URLSearchParams();
  if (args?.currentBookId) params.set('currentBookId', args.currentBookId);
  if (args?.engine) params.set('engine', args.engine);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`/api/voices${qs}`);
  if (!res.ok)
    throw new Error(
      `Voice library fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realSetVoicePin(voiceId: string, pinned: boolean): Promise<void> {
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok)
    throw new Error(
      `Voice pin update failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
}

async function realGetBaseVoices(): Promise<{ voices: BaseVoice[] }> {
  const res = await fetch('/api/voices/base');
  if (!res.ok)
    throw new Error(
      `Base-voice catalog fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realSetVoiceOverride(
  voiceId: string,
  override: BaseVoice | null,
  opts?: VoiceOverrideScope,
): Promise<void> {
  const body: { override: BaseVoice | null; scope?: string; bookId?: string } = { override };
  if (opts?.scope) body.scope = opts.scope;
  if (opts?.bookId) body.bookId = opts.bookId;
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/override`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `Voice override update failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
}

/* POST /api/books/:bookId/cast/:characterId/voice-override-linked (plan 122).
   Name/alias-aware series voice write used by the rebaseline approve: unifies
   voiceId across the recurring character's whole name/alias group and writes
   the override to every member book — so approving a collapsed modal row can't
   silently skip a book on a divergent key. Server rediscovers the group
   (respecting notLinkedTo); the caller only supplies the representative's home
   (bookId, characterId). */
export interface LinkedOverrideResponse {
  canonicalVoiceId: string;
  updated: Array<{ bookId: string; bookTitle: string; characterId: string }>;
  failed: Array<{ bookId: string; bookTitle: string; error: string }>;
}

async function realSetVoiceOverrideLinked(
  bookId: string,
  characterId: string,
  override: BaseVoice | null,
): Promise<LinkedOverrideResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/voice-override-linked`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override }),
    },
  );
  if (!res.ok)
    throw new Error(
      `Linked voice override failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realDesignQwenVoice(
  bookId: string,
  characterId: string,
  { persona, sampleVoiceId, modelKey, preview, emotion }: DesignQwenVoiceArgs,
): Promise<DesignQwenVoiceResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/design-voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(persona !== undefined ? { persona } : {}),
        sampleVoiceId,
        modelKey,
        ...(preview ? { preview: true } : {}),
        ...(emotion ? { emotion } : {}),
      }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Voice design failed (${res.status}).`);
  }
  /* Response is JSON { voiceId, url } pointing at the cached audition MP3 —
     which is also the 12s sample the player will hit. */
  const data = (await res.json()) as { voiceId?: string; url?: string };
  return {
    voiceId: data.voiceId ?? `qwen-${characterId}${preview ? '-preview' : ''}`,
    previewUrl: data.url ?? '',
  };
}

async function realPromoteQwenVoice(
  bookId: string,
  characterId: string,
  { previewVoiceId, sampleVoiceId, modelKey }: PromoteQwenVoiceArgs,
): Promise<PromoteQwenVoiceResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/promote-voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewVoiceId, sampleVoiceId, modelKey }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Promoting the voice failed (${res.status}).`);
  }
  const data = (await res.json()) as { voiceId?: string; url?: string };
  return { voiceId: data.voiceId ?? '', url: data.url ?? '' };
}

async function realDiscardQwenPreview(
  bookId: string,
  characterId: string,
  { previewVoiceId, sampleVoiceId, modelKey }: PromoteQwenVoiceArgs,
): Promise<void> {
  /* Best-effort cleanup — swallow failures so a Cancel never blocks the UI. */
  await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/discard-voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewVoiceId, sampleVoiceId, modelKey }),
    },
  ).catch(() => {});
}

async function realImportManuscript({ text, file, fileName }: UploadArgs): Promise<ImportResponse> {
  if (file) {
    const form = new FormData();
    form.append('file', file, fileName ?? file.name);
    const res = await fetch('/api/import', { method: 'POST', body: form });
    if (!res.ok)
      throw new Error(`Import failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  if (text !== undefined) {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, fileName }),
    });
    if (!res.ok)
      throw new Error(`Import failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  throw new Error('importManuscript requires either `text` or `file`.');
}

async function realGetBookState(bookId: string): Promise<BookStateResponse | null> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`);
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      `Book state fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Cold-boot rehydration for the top-bar AnalysisPill (plan 32, E2).
   Server resolves memory-first / disk-fallback / running→paused
   coercion (see server/src/routes/book-state.ts). Returns null on
   404 so the caller can treat "no in-flight analysis" the same as
   "endpoint not reachable" — both equivalent to "no pill". */
async function realGetAnalysisState(bookId: string): Promise<AnalysisStateResponse | null> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/analysis/state`);
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      `Analysis state fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Mock counterpart — returns null (no in-flight analysis) since mock
   mode has no disk-backed workspace nor a live analyzer. Layout's
   discovery effect treats null the same as 404 (no pill). */
async function mockGetAnalysisState(_bookId: string): Promise<AnalysisStateResponse | null> {
  await wait(20);
  return null;
}

/* Workspace-wide cold-boot scan. Library layout calls this once on
   mount; if any snapshots come back AND no live analysis stream is
   already in the slice, the pill seeds from the most-recent one (the
   server sorts DESC by writtenAt so index 0 wins). Failure-tolerant
   on the client: a network error returns an empty list rather than
   throwing so a missing endpoint can't break the library view's
   render. */
async function realGetActiveAnalyses(): Promise<ActiveAnalysesResponse> {
  try {
    const res = await fetch('/api/library/active-analyses');
    if (!res.ok) return { snapshots: [] };
    return res.json();
  } catch {
    return { snapshots: [] };
  }
}

/* Mock counterpart — empty list, same shape. Mock mode has no disk-
   backed workspace, so there's nothing to surface. */
async function mockGetActiveAnalyses(): Promise<ActiveAnalysesResponse> {
  await wait(20);
  return { snapshots: [] };
}

/* Per-book dropped-quote ledger. Append-only file written by the two
   analysis routes after the verify pass — see
   server/src/store/dropped-quotes.ts for the envelope shape and
   server/src/routes/book-state.ts for the handler. Returns an empty
   envelope when the file doesn't exist yet (no analysis run has
   produced drops). */
async function realGetDroppedQuotes(bookId: string): Promise<DroppedQuotesResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/dropped-quotes`);
  if (!res.ok)
    throw new Error(
      `Dropped-quotes fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function mockGetDroppedQuotes(_bookId: string): Promise<DroppedQuotesResponse> {
  await wait(40);
  return { manuscriptId: 'mock', batches: [] };
}

async function realPutBookState(bookId: string, req: PutStateRequest): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok)
    throw new Error(
      `Book state PUT failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
}

/* Plan 47 — per-book resume bookmark.
   GET returns null when no session has been recorded yet (file
   absent). PUT body is `{ chapterId, currentSec }`; server stamps
   updatedAt and returns the saved record. The mini-player calls PUT
   debounced (~once per 5 s) during playback, plus a final flush on
   chapter switch / close. The Listen view reads GET on book hydrate
   for the "Resume at MM:SS" pill.
   Extended in plan 53 with optional `playbackRate` + `markers`. */
export interface ListenProgressMarker {
  id: string;
  chapterId: number;
  sec: number;
  label: string;
  kind: 'note' | 'rerecord';
  createdAt: string;
}

export interface ListenProgress {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
  /* Plan 53. */
  playbackRate?: number;
  markers?: ListenProgressMarker[];
}

/* Plan 53 — PUT body extension. chapterId/currentSec stay required so
   the mini-player's debounced position save needs no extra arguments;
   playbackRate + markers are opt-in patches the picker / marker UI
   pass. */
export interface PutListenProgressArgs {
  chapterId: number;
  currentSec: number;
  playbackRate?: number;
  markers?: ListenProgressMarker[];
}

async function realGetListenProgress(bookId: string): Promise<ListenProgress | null> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/listen-progress`);
  if (!res.ok)
    throw new Error(
      `Listen-progress GET failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realPutListenProgress(
  bookId: string,
  args: PutListenProgressArgs,
): Promise<ListenProgress> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/listen-progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok)
    throw new Error(
      `Listen-progress PUT failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Multi-source cover endpoints (OpenLibrary / Apple Books / Google Books).
   The picker modal calls findCoverCandidates on open, then setCover when
   the user clicks a thumbnail; removeCover reverts to the procedural
   gradient. See server/src/routes/cover.ts for the upstream behaviour. */
async function realFindCoverCandidates(bookId: string): Promise<{ candidates: CoverCandidate[] }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover/candidates`);
  if (!res.ok)
    throw new Error(
      `Cover candidates fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realSetCover(
  bookId: string,
  candidateId: string,
): Promise<{ coverImageUrl: string }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateId }),
  });
  if (!res.ok)
    throw new Error(`Cover save failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realRemoveCover(bookId: string): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover`, { method: 'DELETE' });
  if (!res.ok)
    throw new Error(`Cover remove failed (${res.status}): ${(await res.text()) || res.statusText}`);
}

/* Plan 40 — local-disk cover upload + render-time framing. Server route
   in server/src/routes/cover.ts. */

export type UploadCoverErrorKind = 'invalid_mime' | 'oversize' | 'transcode_failed' | 'unknown';

export class UploadCoverError extends Error {
  constructor(
    public kind: UploadCoverErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'UploadCoverError';
  }
}

async function realUploadCover(
  bookId: string,
  file: File,
): Promise<{ coverImageUrl: string; originalFilename: string | null }> {
  const form = new FormData();
  form.append('image', file, file.name);
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; kind?: string };
    const kind: UploadCoverErrorKind =
      res.status === 415
        ? 'invalid_mime'
        : res.status === 413
          ? 'oversize'
          : res.status === 502
            ? 'transcode_failed'
            : 'unknown';
    throw new UploadCoverError(kind, body.error ?? `Cover upload failed (${res.status})`);
  }
  return res.json();
}

async function realPatchCoverFraming(
  bookId: string,
  framing: { offsetX: number; offsetY: number; zoom: number },
): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover/framing`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(framing),
  });
  if (!res.ok)
    throw new Error(
      `Cover framing save failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
}

/* Mock counterparts. The fake candidates span the three real sources
   (OpenLibrary + Apple Books + Google Books) so the picker's source
   badges render under VITE_USE_MOCKS=true; they point at real
   OpenLibrary image URLs so thumbnails resolve. setCover returns the
   picked URL directly so the library card swaps the cover without a
   real server round-trip. */
const MOCK_COVER_CANDIDATES: CoverCandidate[] = [
  {
    id: 'openlibrary:8739161',
    source: 'openlibrary',
    coverUrl: 'https://covers.openlibrary.org/b/id/8739161-L.jpg',
    edition: 'Aladdin · 2012',
  },
  {
    id: 'apple:1444008227',
    source: 'apple',
    coverUrl: 'https://covers.openlibrary.org/b/id/13035811-L.jpg',
    edition: '2013',
  },
  {
    id: 'google:zNFuDwAAQBAJ',
    source: 'google',
    coverUrl: 'https://covers.openlibrary.org/b/id/14625765-L.jpg',
    edition: 'HarperCollins · 2014',
  },
  {
    id: 'openlibrary:11193889',
    source: 'openlibrary',
    coverUrl: 'https://covers.openlibrary.org/b/id/11193889-L.jpg',
    edition: 'Aladdin · 2015',
  },
];

async function mockFindCoverCandidates(_bookId: string): Promise<{ candidates: CoverCandidate[] }> {
  await wait(180);
  return { candidates: MOCK_COVER_CANDIDATES };
}

async function mockSetCover(
  _bookId: string,
  candidateId: string,
): Promise<{ coverImageUrl: string }> {
  await wait(80);
  const hit = MOCK_COVER_CANDIDATES.find((c) => c.id === candidateId);
  return { coverImageUrl: hit?.coverUrl ?? MOCK_COVER_CANDIDATES[0].coverUrl };
}

async function mockRemoveCover(_bookId: string): Promise<void> {
  await wait(40);
}

async function mockUploadCover(
  _bookId: string,
  file: File,
): Promise<{ coverImageUrl: string; originalFilename: string | null }> {
  await wait(120);
  // Mock returns a transient blob URL so the picker repaints immediately.
  // No server round-trip — the blob lives for the session only.
  const url =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : MOCK_COVER_CANDIDATES[0].coverUrl;
  return { coverImageUrl: url, originalFilename: file.name };
}

async function mockPatchCoverFraming(
  _bookId: string,
  _framing: { offsetX: number; offsetY: number; zoom: number },
): Promise<void> {
  await wait(40);
}

async function realConfirmBook(body: ConfirmBookRequest): Promise<ConfirmBookResponse> {
  const res = await fetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    throw new SlugCollisionError(
      (err as { suggestedTitle?: string }).suggestedTitle ?? `${body.title} (2)`,
    );
  }
  if (!res.ok)
    throw new Error(`Confirm failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

export class SlugCollisionError extends Error {
  suggestedTitle: string;
  constructor(suggestedTitle: string) {
    super(`A book with this title already exists. Try: ${suggestedTitle}`);
    this.name = 'SlugCollisionError';
    this.suggestedTitle = suggestedTitle;
  }
}

async function realUploadManuscript({
  text,
  file,
  fileName,
  format,
}: UploadArgs): Promise<UploadResponse> {
  if (file) {
    const form = new FormData();
    form.append('file', file, fileName ?? file.name);
    if (format) form.append('format', format);
    const res = await fetch('/api/manuscripts', { method: 'POST', body: form });
    if (!res.ok)
      throw new Error(`Upload failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  if (text !== undefined) {
    const res = await fetch('/api/manuscripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title: undefined, fileName }),
    });
    if (!res.ok)
      throw new Error(`Upload failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  throw new Error('uploadManuscript requires either `text` or `file`.');
}

interface AnalysisStreamEvent {
  kind:
    | 'phase'
    | 'result'
    | 'error'
    | 'log'
    | 'heartbeat'
    | 'cast-update'
    | 'eta'
    | 'chapter-failed'
    | 'chapter-resolved'
    | 'throttle'
    | 'series-prior';
  phaseId?: number;
  progress?: number;
  label?: string;
  response?: AnalyseResponse;
  message?: string;
  code?: string;
  remediation?: string;
  chapterId?: number;
  /** Structured upstream detail (Google's `status` + `details[]` for ApiError
      envelopes; falls back to the raw SDK message). Rendered in a collapsible
      block in the analysing view so the headline stays readable. */
  detail?: string;
  /** Carried on `stage1_shrink_refused` error events so the view can render
      a precise "Would drop from N to M characters" prompt without
      regex'ing the message string. */
  prevCharCount?: number;
  nextCharCount?: number;
  /** Carried on the `series-prior` event emitted once at Phase 0 entry.
      `count` is the total number of carry-over characters; `names` is
      the first three for the "Carrying in Sophie, Keefe, Elwin +N" pill
      copy. Series carry-over is detection-time only -- the confirm-time
      voice-match (plan 09) is a separate surface. */
  count?: number;
  names?: string[];
  live?: AnalysisLiveInfo;
  /* Heartbeat fields. */
  receivedBytes?: number;
  charsPerSec?: number;
  elapsedMs?: number;
  sinceLastChunkMs?: number;
  chapterIndex?: number;
  /* cast-update field — full running-roster snapshot from Phase 0a. */
  characters?: import('./types').Character[];
  /* eta field — server's refined total remaining wall-clock ms. */
  remainingMs?: number;
  /* throttle fields. `waitMs` is how long the analyzer is sleeping
     before its next attempt; `reason` is which of RPM/TPM/RPD/Google's
     retry-delay forced the wait. `model` lets the UI name the model in
     the pill copy ("Throttling Gemini 3.1 Flash Lite · resuming in 4s"). */
  model?: string;
  waitMs?: number;
  reason?: 'rpm' | 'tpm' | 'rpd' | 'retry-after';
}

export class AnalysisError extends Error {
  code: string;
  detail?: string;
  /** Populated for `stage1_shrink_refused` errors so the analysing view
      can render a precise "Would drop from N to M characters" banner +
      "Accept smaller roster" button without parsing the message. */
  prevCharCount?: number;
  nextCharCount?: number;
  /** Human-readable remediation hint from the server's FailureCode
      classification — mirrors the `remediation` field on `kind:'error'`
      SSE events and surfaces in the run-error panel. */
  remediation?: string;
  constructor(
    message: string,
    code: string,
    detail?: string,
    prevCharCount?: number,
    nextCharCount?: number,
    remediation?: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.detail = detail;
    this.prevCharCount = prevCharCount;
    this.nextCharCount = nextCharCount;
    this.remediation = remediation;
  }
}

async function realAnalyseManuscript(
  manuscriptId: string,
  {
    signal,
    onPhase,
    onLog,
    onHeartbeat,
    onEta,
    onCastUpdate,
    onChapterFailed,
    onChapterResolved,
    onThrottle,
    onSeriesPrior,
    model,
    fresh,
    allowStage1Shrink,
  }: AnalyseOpts = {},
): Promise<AnalyseResponse> {
  const hasBody = model !== undefined || fresh !== undefined || allowStage1Shrink !== undefined;
  const res = await fetch(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify({ model, fresh, allowStage1Shrink }) : undefined,
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Analysis stream failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AnalyseResponse | null = null;

  const handle = (payload: AnalysisStreamEvent) => {
    if (payload.kind === 'phase') {
      if (typeof payload.phaseId === 'number' && typeof payload.progress === 'number') {
        onPhase?.({ phaseId: payload.phaseId, progress: payload.progress, live: payload.live });
      }
    } else if (payload.kind === 'log') {
      if (typeof payload.phaseId === 'number' && typeof payload.message === 'string') {
        onLog?.({ phaseId: payload.phaseId, message: payload.message });
      }
    } else if (payload.kind === 'heartbeat') {
      if (
        typeof payload.phaseId === 'number' &&
        typeof payload.receivedBytes === 'number' &&
        typeof payload.charsPerSec === 'number' &&
        typeof payload.elapsedMs === 'number' &&
        typeof payload.sinceLastChunkMs === 'number'
      ) {
        onHeartbeat?.({
          phaseId: payload.phaseId,
          receivedBytes: payload.receivedBytes,
          charsPerSec: payload.charsPerSec,
          elapsedMs: payload.elapsedMs,
          sinceLastChunkMs: payload.sinceLastChunkMs,
          chapterIndex: payload.chapterIndex,
        });
      }
    } else if (payload.kind === 'cast-update') {
      if (Array.isArray(payload.characters)) {
        onCastUpdate?.({ characters: payload.characters });
      }
    } else if (payload.kind === 'eta') {
      if (typeof payload.remainingMs === 'number') {
        onEta?.({ remainingMs: payload.remainingMs });
      }
    } else if (payload.kind === 'chapter-failed') {
      if (typeof payload.chapterId === 'number' && typeof payload.message === 'string') {
        onChapterFailed?.({
          chapterId: payload.chapterId,
          message: payload.message,
          code: payload.code,
          remediation: payload.remediation,
        });
      }
    } else if (payload.kind === 'chapter-resolved') {
      if (typeof payload.chapterId === 'number') {
        onChapterResolved?.({ chapterId: payload.chapterId });
      }
    } else if (payload.kind === 'throttle') {
      if (
        typeof payload.phaseId === 'number' &&
        typeof payload.chapterIndex === 'number' &&
        typeof payload.model === 'string' &&
        typeof payload.waitMs === 'number' &&
        (payload.reason === 'rpm' ||
          payload.reason === 'tpm' ||
          payload.reason === 'rpd' ||
          payload.reason === 'retry-after')
      ) {
        onThrottle?.({
          phaseId: payload.phaseId,
          chapterIndex: payload.chapterIndex,
          model: payload.model,
          waitMs: payload.waitMs,
          reason: payload.reason,
        });
      }
    } else if (payload.kind === 'series-prior') {
      if (typeof payload.count === 'number' && Array.isArray(payload.names)) {
        onSeriesPrior?.({
          count: payload.count,
          names: payload.names.filter((n): n is string => typeof n === 'string'),
        });
      }
    } else if (payload.kind === 'result' && payload.response) {
      result = payload.response;
    } else if (payload.kind === 'error') {
      throw new AnalysisError(
        payload.message || 'Analysis failed.',
        payload.code ?? 'unknown',
        payload.detail,
        payload.prevCharCount,
        payload.nextCharCount,
        payload.remediation,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      if (!dataLines.length) continue;
      const payload = JSON.parse(dataLines.join('\n')) as AnalysisStreamEvent;
      handle(payload);
    }
  }

  if (!result) throw new Error('Analysis stream ended without a result event.');
  return result;
}

/* fs-33 — emotion-only backfill stream. Mirrors realAnalyseManuscript's SSE
   reader. Emits per-chapter progress + annotation batches; the caller applies
   them to the manuscript store (fill-only-empty) and persists them. */
export interface DetectEmotionsOpts {
  signal?: AbortSignal;
  model?: string;
  onPhase?: (e: { progress: number; label?: string; chapterId?: number }) => void;
  onThrottle?: (e: { chapterId: number; waitMs: number; reason: string }) => void;
  onAnnotation?: (e: {
    chapterId: number;
    annotations: Array<{ sentenceId: number; emotion: string }>;
  }) => void;
}
export interface DetectEmotionsResult {
  annotatedChapters: number;
  totalAnnotations: number;
}
export class DetectEmotionsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DetectEmotionsError';
  }
}

async function realDetectEmotions(
  bookId: string,
  { signal, model, onPhase, onThrottle, onAnnotation }: DetectEmotionsOpts = {},
): Promise<DetectEmotionsResult> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/annotate-emotion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model !== undefined ? { model } : {}),
    signal,
  });
  if (res.status === 404) throw new DetectEmotionsError('Book not found.', 'not_found');
  if (!res.ok || !res.body) throw new Error(`Detect-emotions stream failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: DetectEmotionsResult | null = null;

  const handle = (p: Record<string, unknown>) => {
    switch (p.kind) {
      case 'phase':
        if (typeof p.progress === 'number') {
          onPhase?.({
            progress: p.progress,
            label: typeof p.label === 'string' ? p.label : undefined,
            chapterId: typeof p.chapterId === 'number' ? p.chapterId : undefined,
          });
        }
        break;
      case 'throttle':
        if (typeof p.chapterIndex === 'number' && typeof p.waitMs === 'number') {
          onThrottle?.({
            chapterId: p.chapterIndex,
            waitMs: p.waitMs,
            reason: String(p.reason ?? ''),
          });
        }
        break;
      case 'annotation':
        if (typeof p.chapterId === 'number' && Array.isArray(p.annotations)) {
          onAnnotation?.({
            chapterId: p.chapterId,
            annotations: p.annotations as Array<{ sentenceId: number; emotion: string }>,
          });
        }
        break;
      case 'result':
        result = {
          annotatedChapters: typeof p.annotatedChapters === 'number' ? p.annotatedChapters : 0,
          totalAnnotations: typeof p.totalAnnotations === 'number' ? p.totalAnnotations : 0,
        };
        break;
      case 'error':
        throw new DetectEmotionsError(
          typeof p.message === 'string' ? p.message : 'Emotion detection failed.',
          typeof p.code === 'string' ? p.code : 'unknown',
        );
      /* heartbeat / chapter-failed are advisory — ignored by the client. */
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      if (!dataLines.length) continue;
      handle(JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
    }
  }

  if (!result) throw new Error('Detect-emotions stream ended without a result event.');
  return result;
}

async function mockDetectEmotions(
  _bookId: string,
  { onPhase, onAnnotation }: DetectEmotionsOpts = {},
): Promise<DetectEmotionsResult> {
  await wait(60);
  onPhase?.({ progress: 0.5, label: 'Detecting emotions — chapter 1', chapterId: 1 });
  onAnnotation?.({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'excited' }] });
  onPhase?.({ progress: 1, label: 'Done' });
  return { annotatedChapters: 1, totalAnnotations: 1 };
}

/* fs-34 — drop a designed Qwen emotion variant (route deletes the slot + .pt). */
async function realRemoveQwenVariant(
  bookId: string,
  characterId: string,
  emotion: string,
): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(
      characterId,
    )}/emotion-variant/${encodeURIComponent(emotion)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Remove-variant failed (${res.status}).`);
  }
}

async function mockRemoveQwenVariant(): Promise<void> {
  await wait(50);
}

async function realMatchVoices({ bookId, characters }: MatchArgs): Promise<VoiceMatchResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/voice-match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characters }),
  });
  if (!res.ok) throw new Error(`Voice match failed (${res.status}).`);
  return res.json();
}

async function realMergeCharacters({
  bookId,
  sourceId,
  targetId,
}: MergeCharactersArgs): Promise<MergeCharactersResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Character merge failed (${res.status}).`);
  }
  return res.json();
}

async function mockMergeCharacters({
  sourceId,
  targetId,
}: MergeCharactersArgs): Promise<MergeCharactersResponse> {
  /* Mock mode has no persisted cast — return an empty list so callers in a
     mocked environment can wire the call without crashing. Real merging is
     only meaningful against the workspace backend. */
  await wait(60);
  void sourceId;
  void targetId;
  return { characters: [] };
}

async function realSeriesPatchCharacter({
  bookId,
  characterId,
  patch,
}: SeriesPatchCharacterArgs): Promise<SeriesPatchCharacterResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/series-patch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  /* 200 = all updated; 207 = partial success. Both carry a body with
     { updated, failed } — the caller decides what to surface. Other
     non-OK statuses throw so the catch-side error toast fires. */
  if (res.status !== 200 && res.status !== 207) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Series patch failed (${res.status}).`);
  }
  return res.json();
}

async function mockSeriesPatchCharacter({
  bookId,
  characterId,
}: SeriesPatchCharacterArgs): Promise<SeriesPatchCharacterResponse> {
  /* Mock mode: pretend the patch landed on the source book only. The
     design-system environment has no persisted workspace to propagate
     to. Tests that exercise the propagation toast stub this method
     directly. */
  await wait(60);
  return {
    updated: [{ bookId, bookTitle: bookId, characterId }],
    failed: [],
  };
}

async function realUnlinkAlias({
  bookId,
  sourceCharacterId,
  aliasName,
}: UnlinkAliasArgs): Promise<UnlinkAliasResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/unlink-alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceCharacterId, aliasName }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Unlink alias failed (${res.status}).`);
  }
  return res.json();
}

async function mockUnlinkAlias({ aliasName }: UnlinkAliasArgs): Promise<UnlinkAliasResponse> {
  /* Mock mode is stateless on the cast side — the redux store holds the
     authoritative shape, and the layout's onUnlinkAlias handler dispatches
     a delta reducer with the response. So all we need to do is mint the
     standalone-character shape; the reducer applies it locally + prunes
     the alias off the source it already knows about.

     impactedChapters is intentionally empty: building a meaningful list
     would require carrying around a parallel chapter-cast snapshot in the
     mock, which doesn't pay for itself. The Reattribute Lines modal
     handles the empty-list case gracefully (the Skip / Done buttons are
     all that's needed). */
  await wait(60);
  const displayName = aliasName.trim();
  if (!displayName) throw new Error('Alias name cannot be empty.');
  const baseId =
    displayName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unnamed';
  const newCharacter: Character = {
    id: baseId,
    name: displayName,
    role: 'character',
    color: 'narrator',
    voiceState: 'generated',
  };
  return { newCharacter, impactedChapters: [] };
}

async function realAddAlias({
  bookId,
  characterId,
  aliasName,
}: AddAliasArgs): Promise<AddAliasResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/add-alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, aliasName }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Add alias failed (${res.status}).`);
  }
  return res.json();
}

async function mockAddAlias({ characterId, aliasName }: AddAliasArgs): Promise<AddAliasResponse> {
  await wait(60);
  const trimmed = aliasName.trim();
  if (!trimmed) {
    throw new Error('Alias name cannot be empty.');
  }
  /* Stateless — the cast-slice reducer dedupes on its own from the live
     store state. Returning alreadyPresent=false unconditionally is fine;
     the reducer no-ops when the alias is already there. */
  return { characterId, alias: trimmed, alreadyPresent: false };
}

async function realGenerateVoiceStyle(
  bookId: string,
  characterId: string,
): Promise<GenerateVoiceStyleResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/voice-style/generate`,
    { method: 'POST' },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Voice-style generation failed (${res.status}).`);
  }
  return res.json();
}

async function realGenerateAllVoiceStyles(bookId: string): Promise<GenerateAllVoiceStylesResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/voice-style/generate-all`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Voice-style batch generation failed (${res.status}).`);
  }
  return res.json();
}

/* Mock voice-style generation — returns a canned persona so the future
   drawer can exercise the round-trip under VITE_USE_MOCKS without a live
   Gemini key. The persona is deterministic per characterId so a test can
   assert on it; the generate-all mock derives one for every non-narrator
   character in the live cast slice (the caller passes the ids it knows
   about, but the mock has no cast on its own, so it just echoes a single
   canned persona keyed by the requested characterId for the single route
   and an empty batch for generate-all — the redux store is authoritative). */
const MOCK_PERSONA = 'a warm, steady adult voice, mid-paced and grounded, quietly confident';

async function mockGenerateVoiceStyle(
  _bookId: string,
  _characterId: string,
): Promise<GenerateVoiceStyleResponse> {
  await wait(80);
  return { voiceStyle: MOCK_PERSONA };
}

async function realFetchDesignedPersona(
  bookId: string,
  characterId: string,
): Promise<FetchDesignedPersonaResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/designed-persona`,
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Designed-persona lookup failed (${res.status}).`);
  }
  return res.json();
}

/* Mock has no on-disk voice sidecars — return an empty persona so the drawer's
   lazy seed is a benign no-op under VITE_USE_MOCKS. */
async function mockFetchDesignedPersona(
  _bookId: string,
  _characterId: string,
): Promise<FetchDesignedPersonaResponse> {
  await wait(40);
  return { instruct: '' };
}

async function mockGenerateAllVoiceStyles(
  _bookId: string,
): Promise<GenerateAllVoiceStylesResponse> {
  await wait(120);
  /* Stateless mock — the cast lives in redux, not the mock. The drawer
     (Wave 4) dispatches setVoiceStyle per returned id; in mock mode the
     batch returns no entries and the UI can fall back to the single route
     per character. */
  return { voiceStyles: {}, failures: {} };
}

async function realOverrideLibraryCast(
  args: OverrideLibraryCastArgs,
): Promise<OverrideLibraryCastResponse> {
  const res = await fetch('/api/library-cast/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Library override failed (${res.status}).`);
  }
  return res.json();
}

async function mockOverrideLibraryCast(
  args: OverrideLibraryCastArgs,
): Promise<OverrideLibraryCastResponse> {
  /* Mock mode has no workspace to write back to; the override is only
     meaningful against the real backend. Mirror mockMergeCharacters and
     return synthetic records on both sides so the UI can fire the call
     without crashing in the design-system environment. */
  await wait(60);
  const stub = (id: string): Character => ({ id, name: id, role: '', color: 'eliza' }) as Character;
  return {
    source: stub(args.sourceCharacterId),
    target: stub(args.targetCharacterId),
  };
}

async function realGetSeriesRoster(bookId: string): Promise<SeriesRosterResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/series-roster`);
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Series roster fetch failed (${res.status}).`);
  }
  return res.json();
}

async function mockGetSeriesRoster(bookId: string): Promise<SeriesRosterResponse> {
  await wait(40);
  void bookId;
  return { characters: MOCK_SERIES_ROSTER };
}

async function realGetSeriesCast(bookId: string): Promise<SeriesCastResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/series-cast`);
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Series cast fetch failed (${res.status}).`);
  }
  return res.json();
}

async function mockGetSeriesCast(bookId: string): Promise<SeriesCastResponse> {
  /* Mock mode has a single-book workspace with no series-mates on disk, so
     there is nothing to aggregate — the rebaseline modal degrades to its
     anchor cast (the open book), which is exactly the pre-aggregation
     behaviour the design-system environment expects. */
  await wait(40);
  void bookId;
  return { characters: [] };
}

async function realLinkPriorCharacter(
  args: LinkPriorCharacterArgs,
): Promise<LinkPriorCharacterResponse> {
  const { bookId, ...body } = args;
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/link-prior`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Manual continuity link failed (${res.status}).`);
  }
  return res.json();
}

/* POST /api/books/:bookId/cast/:characterId/not-linked-to  (plan 101) — the
   user has just declared "these two cross-book characters are intentionally
   different people" (e.g. teenage Sophie vs adult Sophie). Server pair-writes
   a symmetric record to both books' cast.json so the voices-view duplicate-
   candidate detection stops surfacing the pair. Mirror to redux via
   castActions.applyNotLinked. */
export interface NotLinkedToArgs {
  bookId: string;
  characterId: string;
  otherBookId: string;
  otherCharacterId: string;
}
export interface NotLinkedToResponse {
  pair: {
    a: { bookId: string; characterId: string };
    b: { bookId: string; characterId: string };
  };
}

async function realNotLinkedTo(args: NotLinkedToArgs): Promise<NotLinkedToResponse> {
  const { bookId, characterId, ...body } = args;
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/not-linked-to`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Mark-as-variant failed (${res.status}).`);
  }
  return res.json();
}

async function mockNotLinkedTo(args: NotLinkedToArgs): Promise<NotLinkedToResponse> {
  await wait(80);
  return {
    pair: {
      a: { bookId: args.bookId, characterId: args.characterId },
      b: { bookId: args.otherBookId, characterId: args.otherCharacterId },
    },
  };
}

/* DELETE /api/books/:bookId/cast/:characterId/not-linked-to  (fs-11) — undo a
   prior "different on purpose" decision. The server removes the symmetric
   `notLinkedTo` pair from BOTH books' cast.json so the voices-view duplicate
   detector re-surfaces the pair. Mirror to redux via
   castActions.removeNotLinked + the foreign-cast cache counterpart. */
async function realRemoveNotLinkedTo(args: NotLinkedToArgs): Promise<NotLinkedToResponse> {
  const { bookId, characterId, ...body } = args;
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(characterId)}/not-linked-to`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Unmark-variant failed (${res.status}).`);
  }
  return res.json();
}

async function mockRemoveNotLinkedTo(args: NotLinkedToArgs): Promise<NotLinkedToResponse> {
  await wait(80);
  return {
    pair: {
      a: { bookId: args.bookId, characterId: args.characterId },
      b: { bookId: args.otherBookId, characterId: args.otherCharacterId },
    },
  };
}

async function realAddFromSeriesRoster(
  args: AddFromSeriesRosterArgs,
): Promise<AddFromSeriesRosterResponse> {
  const { bookId, ...body } = args;
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/add-from-roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Add-from-roster failed (${res.status}).`);
  }
  return res.json();
}

async function mockAddFromSeriesRoster(
  args: AddFromSeriesRosterArgs,
): Promise<AddFromSeriesRosterResponse> {
  await wait(120);
  const prior = MOCK_SERIES_ROSTER.find(
    (e) => e.bookId === args.targetBookId && e.id === args.targetCharacterId,
  );
  if (!prior) {
    throw new Error(`Target character "${args.targetCharacterId}" not found in mock roster.`);
  }
  /* Mock id mirrors the server's slug pattern so e2e specs reading the
     id from a fixture stay aligned across mock + real. */
  const newId = `${prior.id}_from_${args.targetBookId.slice(0, 8)}`;
  return {
    character: {
      id: newId,
      name: prior.name,
      role: 'character',
      color: 'unset',
      gender: prior.gender,
      ageRange: prior.ageRange,
      voiceId: prior.voiceId,
      voiceState: 'reused',
      matchedFrom: {
        bookId: args.targetBookId,
        characterId: args.targetCharacterId,
        bookTitle: prior.bookTitle,
        confidence: 1,
      },
    } as import('./types').Character,
  };
}

async function mockLinkPriorCharacter(
  args: LinkPriorCharacterArgs,
): Promise<LinkPriorCharacterResponse> {
  /* Echo the canonical prior-roster entry so the drawer can dispatch a
     valid applyManualMatch and the "Continuity preserved" footer surfaces
     in the design environment. */
  await wait(120);
  const prior = MOCK_SERIES_ROSTER.find(
    (e) => e.bookId === args.targetBookId && e.id === args.targetCharacterId,
  );
  return {
    matchedFrom: {
      bookId: args.targetBookId,
      characterId: args.targetCharacterId,
      bookTitle: prior?.bookTitle ?? 'Solway Bay',
      confidence: 1,
    },
    voiceId: prior?.voiceId,
  };
}

/* Canned prior-series roster for The Northern Star. Two characters from
   the (mocked) first book "Solway Bay" that don't appear in the current
   book — gives mock mode something to surface in the "From prior books
   in Northern Coast Trilogy" optgroup. The user picks one to exercise
   the link-prior flow without a real backend on disk. */
const MOCK_SERIES_ROSTER: SeriesRosterEntry[] = [
  {
    id: 'old-halloran',
    name: 'Captain James Halloran',
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    voiceId: 'v_halloran_solway',
    aliases: ['the old captain'],
    gender: 'male',
    ageRange: 'elderly',
  },
  {
    id: 'mae-vance',
    name: 'Mae Vance',
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    voiceId: 'v_mae_vance',
    gender: 'female',
    ageRange: 'adult',
  },
];

export interface ReparseBookResponse {
  state: { chapters: Array<{ id: number; title: string; slug: string }> };
  chapterCount: number;
  chapterTitles: string[];
  /** Rich chapter records used by the re-parse confirmation dialog so it
      can render include/exclude checkboxes with the auto-suggest heuristic
      against the freshly-parsed chapter list. Optional because pre-feature
      server builds omitted it; the dialog falls back to chapterTitles
      when this is missing. */
  chapters?: Array<{
    id: number;
    title: string;
    slug: string;
    wordCount: number;
    excluded: boolean;
  }>;
}
async function realReparseBook(bookId: string): Promise<ReparseBookResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/reparse`, { method: 'POST' });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Re-parse failed (${res.status}).`);
  }
  return res.json();
}

async function realReplaceManuscript(
  bookId: string,
  file: File,
): Promise<ReparseBookResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/replace-manuscript`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Replace manuscript failed (${res.status}).`);
  }
  return res.json();
}

async function realDeleteBook(bookId: string): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Delete failed (${res.status}).`);
  }
}

async function mockDeleteBook(_bookId: string): Promise<void> {
  await wait(80);
}

async function realLoadSample(slug: string): Promise<{ bookId: string }> {
  const res = await fetch(`/api/samples/${encodeURIComponent(slug)}/load`, { method: 'POST' });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Couldn't load the sample (${res.status}).`);
  }
  return res.json();
}
async function mockLoadSample(_slug: string): Promise<{ bookId: string }> {
  await wait(150);
  return { bookId: 'castwright__standalones__the-coalfall-commission' };
}

async function mockReparseBook(_bookId: string): Promise<ReparseBookResponse> {
  await wait(120);
  return { state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] };
}

async function mockReplaceManuscript(
  _bookId: string,
  _file: File,
): Promise<ReparseBookResponse> {
  await wait(120);
  return { state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] };
}

/* Per-chapter exclude toggle. Used by the Generate view's chapter row to
   opt a chapter out of (or back into) analysis + audio. The server flips
   the flag in state.json, propagates to the in-memory ManuscriptRecord,
   and cleans up stale audio when newly excluded. */
export interface SetChapterExcludedResponse {
  id: number;
  title: string;
  slug: string;
  excluded: boolean;
}
async function realSetChapterExcluded(
  bookId: string,
  chapterId: number,
  excluded: boolean,
): Promise<SetChapterExcludedResponse> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/exclude`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Exclude toggle failed (${res.status}).`);
  }
  return res.json();
}

async function mockSetChapterExcluded(
  _bookId: string,
  chapterId: number,
  excluded: boolean,
): Promise<SetChapterExcludedResponse> {
  await wait(60);
  return {
    id: chapterId,
    title: `Chapter ${chapterId}`,
    slug: `${String(chapterId).padStart(2, '0')}-mock`,
    excluded,
  };
}

/* "Not queued" hold toggle — set when the user deletes an un-rendered
   chapter's entry from the generation queue, cleared when they re-queue it.
   Mirrors setChapterExcluded but hits the held endpoint (no audio cleanup
   server-side). See server/src/routes/book-state.ts held handler. */
export interface SetChapterHeldResponse {
  id: number;
  title: string;
  slug: string;
  held: boolean;
}
async function realSetChapterHeld(
  bookId: string,
  chapterId: number,
  held: boolean,
): Promise<SetChapterHeldResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/held`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ held }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Held toggle failed (${res.status}).`);
  }
  return res.json();
}

async function mockSetChapterHeld(
  bookId: string,
  chapterId: number,
  held: boolean,
): Promise<SetChapterHeldResponse> {
  await wait(60);
  /* Persist into the mock book-state like the real server does, so a later
     getBookState re-hydrate keeps the hold (a no-op mock would let the next
     hydrate clobber the optimistic slice flag). */
  const prev = MOCK_BOOK_STATES.get(bookId);
  const ch = prev?.state.chapters.find((c) => c.id === chapterId);
  if (prev && ch) {
    ch.held = held ? true : undefined;
  }
  return {
    id: chapterId,
    title: ch?.title ?? `Chapter ${chapterId}`,
    slug: ch?.slug ?? `${String(chapterId).padStart(2, '0')}-mock`,
    held,
  };
}

/* Plan 78 — user-supplied chapter rename. Server updates state.json
   atomically (trimming whitespace, rejecting empty / >200-char), flips
   `titleOverridden` to true so subsequent heuristic refresh-titles
   passes leave it alone, and renames the on-disk audio file if any
   exists. Sentence ids and analysis cache are untouched — pure label
   mutation. */
export interface RenameChapterResponse {
  id: number;
  title: string;
  slug: string;
  titleOverridden: boolean;
}
async function realRenameChapter(
  bookId: string,
  chapterId: number,
  title: string,
): Promise<RenameChapterResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Chapter rename failed (${res.status}).`);
  }
  return res.json();
}

async function mockRenameChapter(
  _bookId: string,
  chapterId: number,
  title: string,
): Promise<RenameChapterResponse> {
  await wait(60);
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error('Title must not be empty.');
  if (trimmed.length > 200) throw new Error('Title must be 200 characters or fewer.');
  return {
    id: chapterId,
    title: trimmed,
    slug: `${String(chapterId).padStart(2, '0')}-mock`,
    titleOverridden: true,
  };
}

/* Chapter restructure — merge/split/reorder (plan 51).
   Pure-remap semantics: sentences keep their text + characterId +
   voice assignment; only chapterId pointers and per-chapter sentence
   ids are rewritten. Audio for content-changed chapters is deleted on
   disk (chapter unplayable until regen); audio for renumbered-only
   chapters is renamed in place. See docs/features/archive/51-restructure-chapters.md. */
export interface ChapterRestructureResponse {
  chapters: Array<{
    id: number;
    title: string;
    slug: string;
    duration?: string;
    excluded?: boolean;
    audioModelKey?: string;
    audioRenderedAt?: string;
  }>;
  sentenceRemap: Array<{
    oldChapterId: number;
    oldSentenceId: number;
    newChapterId: number;
    newSentenceId: number;
  }>;
  /** Non-fatal advisories from the post-process passes (plan 70a):
      orphan recovery counts, empty-chapter prune counts, generic-title
      renumber counts. Empty / absent when the operation was clean.
      Consumed by the Restructure view to surface a toast. */
  warnings?: string[];
}

async function postRestructure(
  bookId: string,
  endpoint: 'merge' | 'split' | 'reorder' | 'exclude' | 'refresh-titles',
  body: unknown,
): Promise<ChapterRestructureResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Chapter ${endpoint} failed (${res.status}).`);
  }
  return res.json();
}

async function realMergeChapters(
  bookId: string,
  chapterIds: number[],
  mergedTitle?: string,
): Promise<ChapterRestructureResponse> {
  return postRestructure(bookId, 'merge', {
    chapterIds,
    ...(mergedTitle ? { mergedTitle } : {}),
  });
}

async function realSplitChapter(
  bookId: string,
  chapterId: number,
  afterSentenceId: number,
  newTitle?: string,
): Promise<ChapterRestructureResponse> {
  return postRestructure(bookId, 'split', {
    chapterId,
    afterSentenceId,
    ...(newTitle ? { newTitle } : {}),
  });
}

async function realReorderChapters(
  bookId: string,
  order: number[],
): Promise<ChapterRestructureResponse> {
  return postRestructure(bookId, 'reorder', { order });
}

/* Plan 70b — soft-hide / un-hide a set of chapters via Chapter.excluded.
   Sentence remap is identity; audio files are left on disk. */
async function realExcludeChapters(
  bookId: string,
  chapterIds: number[],
  excluded: boolean,
): Promise<ChapterRestructureResponse> {
  return postRestructure(bookId, 'exclude', { chapterIds, excluded });
}

/* Plan 70b — re-derive chapter titles by re-parsing the source manuscript
   AND opportunistically promoting the first non-dialogue sentence of any
   chapter still carrying a generic "Chapter N" title. */
async function realRefreshChapterTitles(
  bookId: string,
  options: { useFirstLine?: boolean } = {},
): Promise<ChapterRestructureResponse> {
  return postRestructure(bookId, 'refresh-titles', {
    useFirstLine: options.useFirstLine !== false,
  });
}

/* Mock implementations return deterministic shapes good enough for
   Vitest / Playwright. They don't model the slug-rewrite or audio-delete
   side effects; consumers should treat the response as authoritative for
   the new chapter list + sentence remap and re-fetch book-state if they
   need disk-level confirmation. */
async function mockMergeChapters(
  _bookId: string,
  chapterIds: number[],
  mergedTitle?: string,
): Promise<ChapterRestructureResponse> {
  await wait(80);
  const ids = [...chapterIds].sort((a, b) => a - b);
  return {
    chapters: [
      {
        id: 1,
        title: 'Chapter 1',
        slug: '01-chapter-1',
      },
      {
        id: ids[0],
        title: mergedTitle ?? `Merged ${ids.join('+')}`,
        slug: `${String(ids[0]).padStart(2, '0')}-merged`,
      },
    ],
    sentenceRemap: [],
  };
}

async function mockSplitChapter(
  _bookId: string,
  chapterId: number,
  _afterSentenceId: number,
  newTitle?: string,
): Promise<ChapterRestructureResponse> {
  await wait(80);
  return {
    chapters: [
      {
        id: chapterId,
        title: `Chapter ${chapterId}`,
        slug: `${String(chapterId).padStart(2, '0')}-mock`,
      },
      {
        id: chapterId + 1,
        title: newTitle ?? `Chapter ${chapterId} (cont.)`,
        slug: `${String(chapterId + 1).padStart(2, '0')}-mock-cont`,
      },
    ],
    sentenceRemap: [],
  };
}

async function mockReorderChapters(
  _bookId: string,
  order: number[],
): Promise<ChapterRestructureResponse> {
  await wait(80);
  return {
    chapters: order.map((_oldId, i) => ({
      id: i + 1,
      title: `Chapter ${i + 1}`,
      slug: `${String(i + 1).padStart(2, '0')}-mock`,
    })),
    sentenceRemap: [],
  };
}

async function mockExcludeChapters(
  _bookId: string,
  chapterIds: number[],
  excluded: boolean,
): Promise<ChapterRestructureResponse> {
  await wait(40);
  return {
    chapters: chapterIds.map((id) => ({
      id,
      title: `Chapter ${id}`,
      slug: `${String(id).padStart(2, '0')}-mock`,
      ...(excluded ? { excluded: true } : {}),
    })),
    sentenceRemap: [],
    warnings: [],
  };
}

async function mockRefreshChapterTitles(
  _bookId: string,
  _options: { useFirstLine?: boolean } = {},
): Promise<ChapterRestructureResponse> {
  await wait(80);
  return {
    chapters: [
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
    ],
    sentenceRemap: [],
    warnings: ['Re-derived 2 chapter titles from the source manuscript.'],
  };
}

/* Subset re-analysis. Re-runs Phase 0a + Phase 1 for just the requested
   chapters and merges into the existing cache. Used by the un-exclude
   flow in the Generate view: a chapter that was excluded at confirm
   time has no analysis on file, so this catches it up before audio
   generation. Streaming shape is identical to analyseManuscript, so we
   reuse the same AnalyseOpts callback contract. */
async function realRunAnalysisForChapters(
  manuscriptId: string,
  chapterIds: number[],
  {
    signal,
    onPhase,
    onLog,
    onHeartbeat,
    onEta,
    onCastUpdate,
    onChapterFailed,
    onChapterResolved,
    onThrottle,
    onSeriesPrior,
    model,
    allowStage1Shrink,
  }: AnalyseOpts = {},
): Promise<AnalyseResponse> {
  const res = await fetch(
    `/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis/chapters`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterIds, model, allowStage1Shrink }),
      signal,
    },
  );
  if (!res.ok || !res.body) throw new Error(`Subset analysis failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AnalyseResponse | null = null;

  /* Same handler as analyseManuscript — the server emits the identical
     event shapes so the frontend callback contract stays uniform. */
  const handle = (payload: AnalysisStreamEvent) => {
    if (payload.kind === 'phase') {
      if (typeof payload.phaseId === 'number' && typeof payload.progress === 'number') {
        onPhase?.({ phaseId: payload.phaseId, progress: payload.progress, live: payload.live });
      }
    } else if (payload.kind === 'log') {
      if (typeof payload.phaseId === 'number' && typeof payload.message === 'string') {
        onLog?.({ phaseId: payload.phaseId, message: payload.message });
      }
    } else if (payload.kind === 'heartbeat') {
      if (
        typeof payload.phaseId === 'number' &&
        typeof payload.receivedBytes === 'number' &&
        typeof payload.charsPerSec === 'number' &&
        typeof payload.elapsedMs === 'number' &&
        typeof payload.sinceLastChunkMs === 'number'
      ) {
        onHeartbeat?.({
          phaseId: payload.phaseId,
          receivedBytes: payload.receivedBytes,
          charsPerSec: payload.charsPerSec,
          elapsedMs: payload.elapsedMs,
          sinceLastChunkMs: payload.sinceLastChunkMs,
          chapterIndex: payload.chapterIndex,
        });
      }
    } else if (payload.kind === 'cast-update') {
      if (Array.isArray(payload.characters)) {
        onCastUpdate?.({ characters: payload.characters });
      }
    } else if (payload.kind === 'eta') {
      if (typeof payload.remainingMs === 'number') {
        onEta?.({ remainingMs: payload.remainingMs });
      }
    } else if (payload.kind === 'chapter-failed') {
      if (typeof payload.chapterId === 'number' && typeof payload.message === 'string') {
        onChapterFailed?.({
          chapterId: payload.chapterId,
          message: payload.message,
          code: payload.code,
          remediation: payload.remediation,
        });
      }
    } else if (payload.kind === 'chapter-resolved') {
      if (typeof payload.chapterId === 'number') {
        onChapterResolved?.({ chapterId: payload.chapterId });
      }
    } else if (payload.kind === 'throttle') {
      if (
        typeof payload.phaseId === 'number' &&
        typeof payload.chapterIndex === 'number' &&
        typeof payload.model === 'string' &&
        typeof payload.waitMs === 'number' &&
        (payload.reason === 'rpm' ||
          payload.reason === 'tpm' ||
          payload.reason === 'rpd' ||
          payload.reason === 'retry-after')
      ) {
        onThrottle?.({
          phaseId: payload.phaseId,
          chapterIndex: payload.chapterIndex,
          model: payload.model,
          waitMs: payload.waitMs,
          reason: payload.reason,
        });
      }
    } else if (payload.kind === 'series-prior') {
      if (typeof payload.count === 'number' && Array.isArray(payload.names)) {
        onSeriesPrior?.({
          count: payload.count,
          names: payload.names.filter((n): n is string => typeof n === 'string'),
        });
      }
    } else if (payload.kind === 'result' && payload.response) {
      result = payload.response;
    } else if (payload.kind === 'error') {
      throw new AnalysisError(
        payload.message || 'Subset analysis failed.',
        payload.code ?? 'unknown',
        payload.detail,
        payload.prevCharCount,
        payload.nextCharCount,
        payload.remediation,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      if (!dataLines.length) continue;
      const payload = JSON.parse(dataLines.join('\n')) as AnalysisStreamEvent;
      handle(payload);
    }
  }

  if (!result) throw new Error('Subset analysis stream ended without a result event.');
  return result;
}

async function mockRunAnalysisForChapters(
  _manuscriptId: string,
  _chapterIds: number[],
  _opts: AnalyseOpts = {},
): Promise<AnalyseResponse> {
  await wait(120);
  /* Mocks don't have a meaningful subset behaviour — return the canned
     analysis so callers can wire the call without crashing in dev. */
  return ANALYSIS_NORTHERN_STAR;
}

async function realGetVoiceSample({
  voiceId,
  voice,
  modelKey,
  text,
  characterHint,
}: VoiceSampleArgs): Promise<VoiceSample> {
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, voice, text, characterHint }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Sample synthesis failed (${res.status}).`);
  }
  return res.json();
}

/* Raw-speaker audition — bypasses the attribute picker so the user can
   preview an unmodified model voice (Base voices tab + family-header Play).
   The synthetic voiceId in the URL is just a routing carrier; the server
   caches by (engine, speakerName) regardless. */
async function realGetBaseVoiceSample({
  engine,
  speakerName,
  modelKey,
  text,
}: BaseVoiceSampleArgs): Promise<VoiceSample> {
  const carrier = `raw-${engine}-${speakerName}`;
  const res = await fetch(`/api/voices/${encodeURIComponent(carrier)}/sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, rawEngine: engine, rawSpeaker: speakerName, text }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Base voice sample failed (${res.status}).`);
  }
  return res.json();
}

/* Real SSE reader for chapter generation. Mirrors the analysis-stream pattern
   above: open a long-running POST, parse `data: <json>` frames, dispatch each
   payload to onTick. Returns a canceller that aborts the fetch.

   Plan 102 — auto-reconnect on unexpected stream end. Two failure modes today
   would surface as "Worker has gone quiet" until pause-and-resume: (a) `tsx
   watch` restarts the Node server during dev, (b) the server bounces in
   production (Node OOM, manual restart). Both close the SSE without an
   `idle` tick — the server-side `RunningJob` keeps generating (or restarts
   from disk state) but the frontend stops listening. The reconnect loop
   below reopens the same POST so the server emits its `resume_from` ack and
   the queue keeps draining. Bounded by RECONNECT_MAX_ATTEMPTS and gated on
   "we never saw an idle tick" — a clean idle is the only signal that the
   run drained naturally, in which case there's nothing to reconnect to.
   Absorbs the former SSE-survival backlog item (plan 102). */
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

function realStreamGeneration({
  bookId,
  modelKey,
  chapterIds,
  force,
  queueEntryId,
  onTick: rawOnTick,
}: StreamArgs): () => void {
  const onTick = safeOnTick(rawOnTick);
  const controller = new AbortController();
  let attempt = 0;
  let sawIdle = false;
  let sawAnyTick = false;
  let cancelled = false;
  /* Track whether the controller has aborted so the inner catch can
     distinguish "user clicked stop" (AbortError) from "fetch died mid-stream
     and we want to reconnect". */
  controller.signal.addEventListener('abort', () => {
    cancelled = true;
  });

  const openOnce = async (): Promise<{ shouldReconnect: boolean }> => {
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelKey,
          chapterIds,
          force,
          ...(queueEntryId ? { queueEntryId } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        onTick({
          type: 'chapter_failed',
          errorReason: `Generation stream failed (${res.status}): ${detail || res.statusText}`,
        });
        return { shouldReconnect: false };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = raw
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6));
          if (!dataLines.length) continue;
          try {
            const payload = JSON.parse(dataLines.join('\n')) as GenerationTick;
            sawAnyTick = true;
            if (payload.type === 'idle') sawIdle = true;
            onTick(payload);
          } catch (e) {
            console.warn('[api] malformed generation tick:', dataLines.join('\n'), e);
          }
        }
      }
      /* Stream ended cleanly (reader returned done: true). Reconnect only
         when we haven't seen `idle` yet AND we saw at least one real tick
         (so we know the server was alive — a 0-tick close is more likely a
         setup error than a mid-flight bounce). */
      return { shouldReconnect: !cancelled && !sawIdle && sawAnyTick };
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return { shouldReconnect: false };
      /* Network error / server bounce mid-stream lands here. If we'd already
         seen ticks, reconnect — the queue likely still has work. Otherwise
         the failure is the first POST itself; surface to the caller. */
      if (sawAnyTick && !sawIdle) {
        return { shouldReconnect: true };
      }
      onTick({
        type: 'chapter_failed',
        errorReason: (e as Error).message ?? 'Generation stream failed.',
      });
      return { shouldReconnect: false };
    }
  };

  void (async () => {
    while (attempt < RECONNECT_MAX_ATTEMPTS) {
      const { shouldReconnect } = await openOnce();
      if (!shouldReconnect || cancelled) return;
      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', cancelDuringWait);
          resolve();
        }, backoff);
        const cancelDuringWait = () => {
          clearTimeout(timer);
          resolve();
        };
        controller.signal.addEventListener('abort', cancelDuringWait);
      });
      if (cancelled) return;
    }
  })();

  return () => controller.abort();
}

/* fs-26 — per-character splice. One short-lived SSE POST per chapter; resolves
   when the stream ends. Unlike generation there's no reconnect — a splice is
   quick, so a dropped stream surfaces as a failure tick and the caller retries
   that chapter if it wants. */
async function realStreamSplice({
  bookId,
  chapterId,
  mode,
  characterId,
  gainDb,
  segmentIndices,
  modelKey,
  onTick,
  signal,
}: SpliceArgs): Promise<void> {
  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/splice`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          characterId,
          ...(gainDb !== undefined ? { gainDb } : {}),
          ...(segmentIndices ? { segmentIndices } : {}),
          ...(modelKey ? { modelKey } : {}),
        }),
        signal,
      },
    );
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      onTick({
        type: 'chapter_failed',
        chapterId,
        errorReason: `Splice failed (${res.status}): ${detail || res.statusText}`,
      });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = raw
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6));
        if (!dataLines.length) continue;
        try {
          onTick(JSON.parse(dataLines.join('\n')) as SpliceTick);
        } catch (e) {
          console.warn('[api] malformed splice tick:', dataLines.join('\n'), e);
        }
      }
    }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return;
    onTick({ type: 'chapter_failed', chapterId, errorReason: (e as Error).message ?? 'Splice failed.' });
  }
}

/* Real Pause endpoint. Posted by generation-stream-middleware on
   setPaused(true) so the server stops the in-flight run cleanly — the
   server-side abort flips synthesiseChapter's signal, the loop breaks,
   and all attached SSE subscribers receive a final `idle` tick.

   Decoupled from closing the SSE on purpose: browser reload also closes
   the SSE, but the user has not paused. Server treats SSE close as
   "unsubscribe this observer" and only stops the job when this explicit
   POST arrives. */
async function realPauseGeneration({ bookId }: { bookId: string }): Promise<void> {
  /* Fire-and-forget — we don't block the UI on the response. If the
     request fails, the worst case is the run keeps going for an extra
     few seconds until the SSE finishes naturally; the user can hit
     Pause again. */
  await fetch(`/api/books/${encodeURIComponent(bookId)}/generation/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch((err) => {
    console.warn('[api] pauseGeneration failed:', err);
  });
}

/* Mock counterpart — no server to talk to, but we still want the test
   harness to verify the middleware calls this on setPaused. Resolves
   instantly. */
async function mockPauseGeneration(_: { bookId: string }): Promise<void> {
  return Promise.resolve();
}

/* Real Pause endpoint for analysis. Mirrors realPauseGeneration: posts
   to the server's sticky /analysis/pause endpoint so the in-flight
   analyzer loop's controller aborts. Decoupled from closing the SSE
   because B1 made the server treat SSE close as "unsubscribe this
   observer" rather than "abort the job" — the only ways to actually
   stop the job server-side are this endpoint or a `fresh: true` POST
   displacement.
   Idempotent server-side: returns 200 with paused:false when no job
   is running, so a double-click on Pause doesn't 404. */
async function realPauseAnalysis({ manuscriptId }: { manuscriptId: string }): Promise<void> {
  await fetch(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch((err) => {
    console.warn('[api] pauseAnalysis failed:', err);
  });
}

/* ── "Design full cast" bulk-design job (server-owned SSE) ──────────────────
   A single per-book server job designs a Qwen voice for every "Needs voice"
   character, streaming progress over SSE. `startCastDesign` opens the job
   (POST with the id list); `subscribeCastDesign` re-attaches to an in-flight
   one after a browser reload (bare POST, no list). Both share one SSE reader.
   The stream parser mirrors `realAnalyseManuscript`'s `data: <json>` framing. */

export interface CastDesignCallbacks {
  signal?: AbortSignal;
  /** Replayed once on (re)subscribe to a live job so the pill can seed counters. */
  onResumeFrom?: (e: { total: number; done: number; currentName: string | null }) => void;
  /** A character's design is starting. */
  onProgress?: (e: { characterId: string; name: string; done: number; total: number }) => void;
  /** Throttled (~6s) liveness tick during a long single design. */
  onHeartbeat?: (e: { characterId: string }) => void;
  /** A character was designed + persisted; `voiceId` is the bespoke qwen name. */
  onCharacterDesigned?: (e: { characterId: string; voiceId: string }) => void;
  /** fe-32 — a designed emotion VARIANT was persisted (bulk job). */
  onVariantDesigned?: (e: { characterId: string; emotion: Emotion; voiceId: string }) => void;
  /** A character was skipped (already had a Qwen voice when its turn came). */
  onCharacterSkipped?: (e: { characterId: string }) => void;
  /** A character's design failed; the run continues past it. */
  onCharacterFailed?: (e: { characterId: string; name: string; errorReason: string }) => void;
  /** Terminal: the run finished (or there was nothing to do). */
  onIdle?: (e: {
    done: number;
    total: number;
    skipped: number;
    failures: Array<{ characterId: string; name: string; error: string }>;
  }) => void;
  /** Catastrophic abort (NOT a per-character failure). */
  onError?: (e: { code: string; message: string }) => void;
  /** Single-design sub-phase tick (honest progress). */
  onPhase?: (e: { characterId: string; phase: 'designing' | 'rendering' }) => void;
  /** Single re-design finished — preview staged, awaiting A/B compare. */
  onPreviewReady?: (e: {
    characterId: string;
    name: string;
    previewVoiceId: string;
    previewUrl: string;
    persona: string;
  }) => void;
  /** Single-design (re)subscribe seed — replayed once on reload re-attach so the
      slice can open a single snapshot at the right character + phase. */
  onResumeSingle?: (e: {
    characterId: string;
    name: string;
    mode: 'first' | 'redesign';
    phase: 'designing' | 'rendering';
  }) => void;
}

interface CastDesignStreamEvent {
  type: string;
  total?: number;
  done?: number;
  skipped?: number;
  currentName?: string | null;
  characterId?: string;
  name?: string;
  voiceId?: string;
  emotion?: Emotion;
  errorReason?: string;
  failures?: Array<{ characterId: string; name: string; error: string }>;
  code?: string;
  message?: string;
  phase?: 'designing' | 'rendering';
  previewVoiceId?: string;
  previewUrl?: string;
  persona?: string;
  mode?: 'first' | 'redesign';
  url?: string;
}

/** Status of a possibly-live design job (the layout cold-boot probe reads this
    to decide whether to re-subscribe after a reload). */
export interface CastDesignStatus {
  active: boolean;
  total?: number;
  done?: number;
  skipped?: number;
  currentName?: string | null;
  state?: 'running' | 'done' | 'halted';
  failures?: Array<{ characterId: string; name: string; error: string }>;
}

export async function readCastDesignStream(
  res: Response,
  cb: CastDesignCallbacks,
): Promise<void> {
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Cast-design stream failed (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (e: CastDesignStreamEvent) => {
    switch (e.type) {
      case 'resume_from':
        if (e.mode === 'first' || e.mode === 'redesign') {
          // single-design reload re-attach
          cb.onResumeSingle?.({
            characterId: e.characterId ?? '',
            name: e.name ?? e.characterId ?? '',
            mode: e.mode,
            phase: e.phase === 'rendering' ? 'rendering' : 'designing',
          });
        } else {
          cb.onResumeFrom?.({ total: e.total ?? 0, done: e.done ?? 0, currentName: e.currentName ?? null });
        }
        break;
      case 'phase':
        if (typeof e.characterId === 'string' && (e.phase === 'designing' || e.phase === 'rendering'))
          cb.onPhase?.({ characterId: e.characterId, phase: e.phase });
        break;
      case 'designed':
        if (typeof e.characterId === 'string' && typeof e.voiceId === 'string')
          cb.onCharacterDesigned?.({ characterId: e.characterId, voiceId: e.voiceId });
        break;
      case 'preview_ready':
        if (
          typeof e.characterId === 'string' &&
          typeof e.previewVoiceId === 'string' &&
          typeof e.previewUrl === 'string'
        )
          cb.onPreviewReady?.({
            characterId: e.characterId,
            name: e.name ?? e.characterId,
            previewVoiceId: e.previewVoiceId,
            previewUrl: e.previewUrl,
            persona: e.persona ?? '',
          });
        break;
      case 'progress':
        if (typeof e.characterId === 'string')
          cb.onProgress?.({
            characterId: e.characterId,
            name: e.name ?? e.characterId,
            done: e.done ?? 0,
            total: e.total ?? 0,
          });
        break;
      case 'heartbeat':
        if (typeof e.characterId === 'string') cb.onHeartbeat?.({ characterId: e.characterId });
        break;
      case 'character_designed':
        if (typeof e.characterId === 'string' && typeof e.voiceId === 'string')
          cb.onCharacterDesigned?.({ characterId: e.characterId, voiceId: e.voiceId });
        break;
      case 'variant_designed':
        if (
          typeof e.characterId === 'string' &&
          typeof e.emotion === 'string' &&
          typeof e.voiceId === 'string'
        )
          cb.onVariantDesigned?.({ characterId: e.characterId, emotion: e.emotion as Emotion, voiceId: e.voiceId });
        break;
      case 'character_skipped':
        if (typeof e.characterId === 'string')
          cb.onCharacterSkipped?.({ characterId: e.characterId });
        break;
      case 'character_failed':
        if (typeof e.characterId === 'string')
          cb.onCharacterFailed?.({
            characterId: e.characterId,
            name: e.name ?? e.characterId,
            errorReason: e.errorReason ?? 'Voice design failed.',
          });
        break;
      case 'idle':
        cb.onIdle?.({
          done: e.done ?? 0,
          total: e.total ?? 0,
          skipped: e.skipped ?? 0,
          failures: e.failures ?? [],
        });
        break;
      case 'error':
        cb.onError?.({ code: e.code ?? 'unknown', message: e.message ?? 'Cast design failed.' });
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      if (!dataLines.length) continue;
      handle(JSON.parse(dataLines.join('\n')) as CastDesignStreamEvent);
    }
  }
}

export async function realStartCastDesign(
  bookId: string,
  {
    characterIds,
    modelKey,
    scope,
    variantTasks,
  }: {
    characterIds: string[];
    modelKey: string;
    scope?: 'bases' | 'variants' | 'both';
    variantTasks?: { characterId: string; emotions: Emotion[] }[];
  },
  cb: CastDesignCallbacks,
): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterIds, modelKey, scope, variantTasks }),
    signal: cb.signal,
  });
  await readCastDesignStream(res, cb);
}

async function realSubscribeCastDesign(bookId: string, cb: CastDesignCallbacks): Promise<void> {
  /* Bare POST (no characterIds) — the server re-subscribes to the in-flight
     job and replays `resume_from`, or idles immediately if none is live. */
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: cb.signal,
  });
  await readCastDesignStream(res, cb);
}

async function realGetCastDesignStatus(bookId: string): Promise<CastDesignStatus> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design/status`);
  if (!res.ok) return { active: false };
  return (await res.json()) as CastDesignStatus;
}

export interface SingleDesignArgs {
  characterId: string;
  persona: string;
  sampleVoiceId: string;
  modelKey: string;
  preview: boolean;
}

async function realStartSingleDesign(
  bookId: string,
  args: SingleDesignArgs,
  cb: CastDesignCallbacks,
): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(args.characterId)}/design-voice/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        persona: args.persona,
        sampleVoiceId: args.sampleVoiceId,
        modelKey: args.modelKey,
        preview: args.preview,
      }),
      signal: cb.signal,
    },
  );
  await readCastDesignStream(res, cb);
}

async function realSubscribeSingleDesign(bookId: string, cb: CastDesignCallbacks): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/design-single/subscribe`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: cb.signal },
  );
  await readCastDesignStream(res, cb);
}

export interface SingleDesignStatus {
  active: boolean;
  characterId?: string;
  name?: string;
  mode?: 'first' | 'redesign';
  phase?: 'designing' | 'rendering';
}

async function realGetSingleDesignStatus(bookId: string): Promise<SingleDesignStatus> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design-single/status`);
  if (!res.ok) return { active: false };
  return (await res.json()) as SingleDesignStatus;
}

async function mockStartSingleDesign(
  _bookId: string,
  args: SingleDesignArgs,
  cb: CastDesignCallbacks,
): Promise<void> {
  cb.onPhase?.({ characterId: args.characterId, phase: 'designing' });
  await wait(120);
  cb.onPhase?.({ characterId: args.characterId, phase: 'rendering' });
  await wait(80);
  if (args.preview) {
    cb.onPreviewReady?.({
      characterId: args.characterId,
      name: args.characterId,
      previewVoiceId: `qwen-${args.characterId}-preview`,
      previewUrl: `/mock/${args.characterId}-preview.mp3`,
      persona: args.persona,
    });
  } else {
    cb.onCharacterDesigned?.({ characterId: args.characterId, voiceId: `qwen-${args.characterId}` });
  }
  cb.onIdle?.({ done: args.preview ? 0 : 1, total: 1, skipped: 0, failures: [] });
}

async function mockSubscribeSingleDesign(_bookId: string, cb: CastDesignCallbacks): Promise<void> {
  cb.onIdle?.({ done: 0, total: 0, skipped: 0, failures: [] });
}

async function mockGetSingleDesignStatus(_bookId: string): Promise<SingleDesignStatus> {
  return { active: false };
}

async function realPauseCastDesign(bookId: string): Promise<void> {
  await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch((err) => {
    console.warn('[api] pauseCastDesign failed:', err);
  });
}

/* Mock bulk-design — emits a short deterministic sequence (one designed voice
   per character id, plus variant_designed per emotion variant) with small
   delays so the e2e can observe the pill ticking and the rows flipping to
   "Designed". Honors scope: 'bases'=bases only, 'variants'=variants only,
   'both'=both (default). */
async function mockStartCastDesign(
  _bookId: string,
  {
    characterIds,
    scope,
    variantTasks,
  }: {
    characterIds: string[];
    modelKey: string;
    scope?: 'bases' | 'variants' | 'both';
    variantTasks?: { characterId: string; emotions: Emotion[] }[];
  },
  cb: CastDesignCallbacks,
): Promise<void> {
  const baseIds = scope === 'variants' ? [] : characterIds;
  const vTasks = scope === 'bases' ? [] : (variantTasks ?? []);
  const total = baseIds.length + vTasks.reduce((n, t) => n + t.emotions.length, 0);
  let done = 0;
  for (const characterId of baseIds) {
    if (cb.signal?.aborted) return;
    cb.onProgress?.({ characterId, name: characterId, done, total });
    await wait(120);
    if (cb.signal?.aborted) return;
    cb.onCharacterDesigned?.({ characterId, voiceId: `qwen-${characterId}` });
    done += 1;
  }
  for (const t of vTasks) {
    for (const emotion of t.emotions) {
      if (cb.signal?.aborted) return;
      cb.onProgress?.({ characterId: t.characterId, name: t.characterId, done, total });
      await wait(120);
      if (cb.signal?.aborted) return;
      cb.onVariantDesigned?.({ characterId: t.characterId, emotion, voiceId: `qwen-${t.characterId}__${emotion}` });
      done += 1;
    }
  }
  cb.onIdle?.({ done, total, skipped: 0, failures: [] });
}

async function mockSubscribeCastDesign(_bookId: string, cb: CastDesignCallbacks): Promise<void> {
  /* No live job to re-attach to under mocks — idle immediately. */
  cb.onIdle?.({ done: 0, total: 0, skipped: 0, failures: [] });
}

async function mockGetCastDesignStatus(_bookId: string): Promise<CastDesignStatus> {
  return { active: false };
}

async function mockPauseCastDesign(_bookId: string): Promise<void> {
  return Promise.resolve();
}

async function mockPauseAnalysis(_: { manuscriptId: string }): Promise<void> {
  return Promise.resolve();
}

/* fs-23 — In-app Model Manager. Mirrors server/src/routes/models-inventory.ts
   (these /api/models routes are local-ops only, not in the OpenAPI contract, so
   the shape is hand-mirrored rather than generated). */
export type ModelInventoryId =
  | 'kokoro'
  | 'qwen-base'
  | 'qwen-design'
  | 'coqui'
  | 'whisper'
  | `ollama:${string}`;

export interface ModelInventoryItem {
  id: ModelInventoryId;
  kind: 'tts' | 'analyzer' | 'asr';
  label: string;
  present: boolean;
  sizeBytes: number | null;
  diskPath: string | null;
  loaded: boolean;
  installState?: string;
  isDefaultEngine: boolean;
  isFallbackEngine: boolean;
  removable: boolean;
  updatable: boolean;
  integrity?: 'verified' | 'unpinned' | 'mismatch';
}

export interface ModelInventoryResponse {
  ts: string;
  sidecarReachable: boolean;
  items: ModelInventoryItem[];
}

export type ModelRemovalResult =
  | { ok: true; id: string; removed: boolean; freedBytes: number }
  | { ok: false; code?: string; error?: string; remediation?: string };

export interface SidecarHealth {
  status: 'reachable' | 'unreachable';
  url: string;
  engines?: string[];
  error?: string;
  /* Which layer reported the failure. The frontend's fetch can't reach the
     sidecar daemon directly — it always goes through the Node Express
     proxy at :8080. So an `unreachable` can mean two different things:
     - `proxy: 'node'`  — Vite couldn't reach :8080 (Node server crashed,
                          5xx from Vite, network error). Recovery: restart Node.
     - `proxy: 'sidecar'` — Node reached :8080 fine but :8080 couldn't
                            reach :9000. Recovery: restart sidecar.
     Reachable responses always come from `proxy: 'sidecar'` since the
     payload is the daemon's own self-report. Older Node servers don't
     emit this field, so the frontend tolerates absence and falls back
     to a generic "unreachable" message. */
  proxy?: 'node' | 'sidecar';
  /* Load-state surface added when the sidecar grew /load + /unload endpoints
     (see server/tts-sidecar/main.py). Older sidecars don't ship these, so
     the proxy defaults them to `false` / `null` and the UI can treat them
     as authoritative.

     `modelLoaded` / `loading` stay Coqui-specific for back-compat (the
     Coqui pill polls them); `kokoroLoaded` / `kokoroLoading` are the
     Kokoro pair, added when Kokoro got its own in-app Stop pill;
     `qwenLoaded` / `qwenLoading` are the Qwen pair (plan 108, bespoke
     per-character engine). All three pairs fan out from the same /health
     response so useTtsLifecycle stays on one poll per tick. */
  modelLoaded?: boolean;
  loading?: boolean;
  kokoroLoaded?: boolean;
  kokoroLoading?: boolean;
  qwenLoaded?: boolean;
  qwenLoading?: boolean;
  /* Qwen install-state, distinct from load-state (qwenLoaded). Drives the
     conditional default (Qwen-when-installed) + the install-check warning:
     - 'not-installed'   — qwen_tts pip package absent
     - 'weights-missing' — package present, Base weights not yet downloaded
     - 'ready'           — package + weights present, model not resident
     - 'loaded'          — Base model resident in VRAM
     An older sidecar omits the field; the Node proxy normalises absence to
     'not-installed' so a stale build never reports Qwen as usable. */
  qwenPackageInstalled?: boolean;
  qwenWeightsPresent?: boolean;
  qwenInstallState?: 'not-installed' | 'weights-missing' | 'ready' | 'loaded';
  /* ASR (Whisper) model-watch state (srv-31). Display-only — Whisper loads
     lazily on /transcribe and idle-evicts, so there is no Load/Stop pill, just a
     resident indicator. `asrEnabled` is the server's SEG_ASR_ENABLED (gates
     whether the ASR pill shows at all); `asrDevice` is 'cpu' | 'cuda'. Absent on
     an older server → false / null. */
  asrEnabled?: boolean;
  asrLoaded?: boolean;
  asrDevice?: string | null;
  device?: string | null;
}

export interface OllamaHealth {
  status: 'reachable' | 'unreachable';
  url: string;
  models?: string[];
  expectedModel?: string;
  modelPulled?: boolean;
  /* Resident-in-VRAM signal from Ollama's /api/ps probe. The pill needs
     this distinct from `modelPulled` because pulled-but-not-loaded looks
     identical to ready otherwise — and that's the state that caused the
     "Try Again" loop (warm-up succeeded at 2K ctx, analysis reloaded at
     16K ctx mid-request, pill stayed green because pulled never flips). */
  resident?: string[];
  modelResident?: boolean;
  error?: string;
}

export interface ModelControlResult {
  status: 'ready' | 'idle' | 'unloaded' | 'error';
  error?: string;
}

export interface WorkspaceInfo {
  root: string;
  booksRoot: string;
  /** `env` when WORKSPACE_DIR is set in server/.env; `default` when the
      built-in `../audiobook-workspace` relative path is in use. Helps the
      Books page distinguish "I configured this" from "I'm using the
      default and didn't know it was inside the repo." */
  source: 'env' | 'default';
}

async function realGetWorkspaceInfo(): Promise<WorkspaceInfo> {
  const res = await fetch('/api/workspace');
  if (!res.ok) throw new Error(`Workspace info fetch failed (${res.status}).`);
  return res.json();
}

async function mockGetWorkspaceInfo(): Promise<WorkspaceInfo> {
  await wait(40);
  return { root: '(mock)', booksRoot: '(mock)/books', source: 'default' };
}

export interface GetWorkspaceChangelogArgs {
  /** Page size — default 50, capped at 200 server-side. Omit on the first
      request unless you specifically want a smaller/larger window. */
  limit?: number;
  /** ISO timestamp cursor. Pass the previous response's `nextCursor` to
      fetch the next page. Omit on the first request. */
  before?: string | null;
}

async function realGetWorkspaceChangelog(
  args: GetWorkspaceChangelogArgs = {},
): Promise<WorkspaceChangeLogResponse> {
  const qs = new URLSearchParams();
  if (args.limit != null) qs.set('limit', String(args.limit));
  if (args.before) qs.set('before', args.before);
  const url = qs.toString() ? `/api/workspace/changelog?${qs}` : '/api/workspace/changelog';
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Workspace changelog fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function mockGetWorkspaceChangelog(
  _args: GetWorkspaceChangelogArgs = {},
): Promise<WorkspaceChangeLogResponse> {
  /* CHANGE_LOG_EVENTS is intentionally empty (see src/data/change-log.ts).
     The mock stays contract-correct so VITE_USE_MOCKS=true exercises the
     same shape the real server returns; under mocks the Activity view sees
     the empty state, which is exactly what the real server returns for a
     fresh workspace. */
  await wait(60);
  return {
    events: CHANGE_LOG_EVENTS.map((e) => ({
      ...e,
      bookId: 'ns',
      bookTitle: 'Northern Star',
      author: 'Demo Author',
    })),
    nextCursor: null,
    totalCount: 0,
    categoryCounts: { voice: 0, generation: 0, manuscript: 0, cast: 0 },
  };
}

async function realGetSidecarHealth(): Promise<SidecarHealth> {
  /* Two layers can fail here:
     1. The frontend → Node proxy hop (Vite proxy to :8080). A crashed Node
        process surfaces as a fetch-thrown TypeError or a Vite 502/504.
        Tag it `proxy: 'node'` so the UI can say "restart Node," not
        "restart sidecar."
     2. The Node → sidecar hop (Node fetch to :9000). Node returns a JSON
        body with its own status; the daemon reports `proxy: 'sidecar'`
        (or omits the field on older servers, which we backfill). */
  let res: Response;
  try {
    res = await fetch('/api/sidecar/health');
  } catch (e) {
    /* fetch threw — typically TypeError: Failed to fetch when Vite can't
       reach the Node upstream. Distinguishes "Node :8080 down" from
       "sidecar :9000 down." */
    return {
      status: 'unreachable',
      url: '',
      proxy: 'node',
      error: `Node server (:8080) unreachable: ${(e as Error).message}`,
    };
  }
  if (!res.ok) {
    /* Vite proxy returned a 5xx — most commonly because the upstream Node
       process died after start. Same Node-down semantics as the throw
       path; route through the same banner copy. */
    return {
      status: 'unreachable',
      url: '',
      proxy: 'node',
      error: `Node server (:8080) returned HTTP ${res.status}`,
    };
  }
  const body = (await res.json()) as SidecarHealth;
  /* Backfill: older Node servers don't emit `proxy`. Treat any successful
     parse from the Node route as having come from the sidecar layer, so
     the UI's distinguisher logic stays clean. */
  return { ...body, proxy: body.proxy ?? 'sidecar' };
}

/* fs-23 — Model Manager inventory. The Node route does the FS sizing + probe
   folding; the frontend just GETs and renders. */
async function realGetModelInventory(): Promise<ModelInventoryResponse> {
  const res = await fetch('/api/models/inventory');
  if (!res.ok) throw new Error(`Model inventory failed: HTTP ${res.status}`);
  return (await res.json()) as ModelInventoryResponse;
}

/* fs-23 — remove a model's weights. Resolves to a discriminated result so the
   UI can surface the server's guard (loaded / default / fallback / locked)
   without a throw/catch dance. */
async function realRemoveModel(id: string): Promise<ModelRemovalResult> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}/remove`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      code: body.code as string | undefined,
      error: (body.error as string | undefined) ?? `HTTP ${res.status}`,
      remediation: body.remediation as string | undefined,
    };
  }
  return {
    ok: true,
    id: String(body.id ?? id),
    removed: Boolean(body.removed),
    freedBytes: Number(body.freedBytes ?? 0),
  };
}

/* ── User settings ─────────────────────────────────────────────────────
   Real path round-trips through GET / PUT /api/user/settings. Mock path
   keeps an in-memory copy seeded from the same FRONTEND_ACCOUNT_DEFAULTS
   that mirrors the server's DEFAULT_USER_SETTINGS, so the Account view
   stays consistent under VITE_USE_MOCKS=true. */
const MOCK_USER_SETTINGS: UserSettings = {
  ...FRONTEND_ACCOUNT_DEFAULTS,
  /* Mock resolves to the stored Kokoro default so the broad mock/e2e suite's
     engine assumptions are unchanged; tests exercising the Qwen-default seed
     override this fixture (or getUserSettings) directly. */
  resolvedTtsModelKey: FRONTEND_ACCOUNT_DEFAULTS.defaultTtsModelKey,
  apiKeyStatus: 'unset',
  workspaceRoot: '(mock)/audiobook-workspace',
  workspaceSource: 'default',
};

async function realGetUserSettings(): Promise<UserSettings> {
  const res = await fetch('/api/user/settings');
  if (!res.ok)
    throw new Error(
      `User settings fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realPutUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  const res = await fetch('/api/user/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok)
    throw new Error(
      `User settings save failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Plan 49 — dedicated endpoint for the Gemini API key. Kept off the general
   PUT so a misaddressed payload can't leak the secret into an unrelated
   field. The response is the same shape as GET /api/user/settings — the
   slice swaps it in without a follow-up GET. */
async function realPutGeminiKey(key: string | null): Promise<UserSettings> {
  const res = await fetch('/api/user/settings/gemini-key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!res.ok)
    throw new Error(
      `Gemini key save failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* fs-1 — in-app upgrade + app-info endpoints. */
async function realGetAppInfo(): Promise<AppInfo> {
  const res = await fetch('/api/info');
  if (!res.ok)
    throw new Error(`App info fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
/* Interim — HEAD-probe GET /api/companion/apk to learn whether a packaged
   Android APK has been dropped at the server's resolved location. A 404 (or any
   network error) means "no APK"; a 200 carries the byte size via Content-Length.
   Never throws — the banner just hides its download button when unavailable. */
async function realCheckCompanionApk(): Promise<CompanionApkAvailability> {
  try {
    const res = await fetch('/api/companion/apk', { method: 'HEAD' });
    if (!res.ok) return { available: false, sizeBytes: null };
    const len = res.headers.get('Content-Length');
    return { available: true, sizeBytes: len ? Number(len) : null };
  } catch {
    return { available: false, sizeBytes: null };
  }
}
async function realDismissWhatsNew(): Promise<void> {
  const res = await fetch('/api/info/dismiss-whats-new', { method: 'POST' });
  if (!res.ok)
    throw new Error(`Dismiss what's-new failed (${res.status}): ${(await res.text()) || res.statusText}`);
}
async function realUpgradeStage(file: File): Promise<UpgradeStageResult> {
  const form = new FormData();
  form.append('zip', file, file.name);
  const res = await fetch('/api/upgrade/stage', { method: 'POST', body: form });
  if (!res.ok)
    throw new Error(`Upgrade staging failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
async function realUpgradeApply(): Promise<void> {
  const res = await fetch('/api/upgrade/apply', { method: 'POST' });
  if (!res.ok)
    throw new Error(`Upgrade apply failed (${res.status}): ${(await res.text()) || res.statusText}`);
}
async function realUpgradeAbort(): Promise<void> {
  const res = await fetch('/api/upgrade/abort', { method: 'POST' });
  if (!res.ok)
    throw new Error(`Upgrade abort failed (${res.status}): ${(await res.text()) || res.statusText}`);
}
async function realUpgradeState(): Promise<UpgradeStatePayload> {
  const res = await fetch('/api/upgrade/state');
  if (!res.ok)
    throw new Error(`Upgrade state failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

/* fs-1 — mock upgrade surface. The mock is "always up to date" (showWhatsNew
   off, no newer release to stage) so the mock-mode app never offers a phantom
   upgrade; the e2e drives these via page.route stubs instead. */
let mockAppInfo: AppInfo = {
  appVersion: '1.6.0',
  sidecarVersion: '1.6.0',
  schemas: { state: 1, cast: 1, manuscriptEdits: 1, revisions: 1, listenProgress: 1, voices: 1 },
  lastSeenAppVersion: '1.6.0',
  showWhatsNew: false,
  releaseNotes: '# v1.6.0\n\n- In-app upgrades.\n',
  hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
  devices: { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' },
  devicesState: 'ready',
  activeEngine: 'kokoro',
};
async function mockGetAppInfo(): Promise<AppInfo> {
  await wait(40);
  return { ...mockAppInfo };
}
/* Mock has no real server to host an APK, so the companion download is always
   "unavailable" in mock/dev — the banner stays in its store-only state. */
async function mockCheckCompanionApk(): Promise<CompanionApkAvailability> {
  await wait(20);
  return { available: false, sizeBytes: null };
}
async function mockDismissWhatsNew(): Promise<void> {
  await wait(20);
  mockAppInfo = { ...mockAppInfo, showWhatsNew: false };
}
async function mockUpgradeStage(_file: File): Promise<UpgradeStageResult> {
  await wait(50);
  return { candidateVersion: '1.7.0', runningVersion: '1.6.0', reqHash: 'mock', requiresPipInstall: false, isDowngrade: false };
}
async function mockUpgradeApply(): Promise<void> {
  await wait(30);
}
async function mockUpgradeAbort(): Promise<void> {
  await wait(20);
}
async function mockUpgradeState(): Promise<UpgradeStatePayload> {
  await wait(20);
  return { phase: 'idle', busy: false };
}

async function mockGetUserSettings(): Promise<UserSettings> {
  await wait(50);
  return { ...MOCK_USER_SETTINGS };
}

/* Plan 79 — write-probe for the sync-folder Test button. Mock pretends
   any non-empty path is writable so the modal UI can be exercised in
   mock mode without a real disk. Empty / whitespace-only paths report
   ENOENT so the failure branch is reachable too. */
export interface SyncFolderProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
}
async function mockTestSyncFolderPath(path: string): Promise<SyncFolderProbeResult> {
  await wait(120);
  if (!path || path.trim().length === 0) {
    return { ok: false, code: 'ENOENT', message: 'No path supplied.' };
  }
  return { ok: true };
}

async function realTestSyncFolderPath(path: string): Promise<SyncFolderProbeResult> {
  const res = await fetch('/api/user/settings/sync-folder/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok)
    throw new Error(
      `Sync folder probe failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function mockPutGeminiKey(key: string | null): Promise<UserSettings> {
  await wait(50);
  /* apiKeyStatus is marked readonly in the generated type, but the mock
     needs to flip it from save to save. Rebuild the cached fixture via a
     fresh object literal — the next mockGetUserSettings clones from this
     reseeded value. */
  const next: UserSettings = {
    ...MOCK_USER_SETTINGS,
    apiKeyStatus: key && key.trim().length > 0 ? 'set' : 'unset',
  };
  Object.assign(MOCK_USER_SETTINGS, next);
  return { ...MOCK_USER_SETTINGS };
}

async function mockPutUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  await wait(50);
  /* Strip read-only fields a misbehaving caller might submit so the mock
     path enforces the same invariant as the server. */
  const {
    displayName,
    defaultAnalysisModel,
    defaultTtsEngine,
    defaultTtsModelKey,
    sidecarUrl,
    workspaceDirOverride,
    exportSyncFolder,
    analyzerPhase0Model,
    analyzerPhase1Model,
    analyzerPhase1MinLagChapters,
    dualModelEnabled,
    eagerLoadKokoro,
  } = patch;
  Object.assign(
    MOCK_USER_SETTINGS,
    Object.fromEntries(
      Object.entries({
        displayName,
        defaultAnalysisModel,
        defaultTtsEngine,
        defaultTtsModelKey,
        sidecarUrl,
        workspaceDirOverride,
        exportSyncFolder,
        analyzerPhase0Model,
        analyzerPhase1Model,
        analyzerPhase1MinLagChapters,
        dualModelEnabled,
        eagerLoadKokoro,
      }).filter(([, v]) => v !== undefined),
    ),
  );
  return { ...MOCK_USER_SETTINGS };
}

/* ── Audiobook export ───────────────────────────────────────────────────
   POST /api/books/:bookId/exports creates a job. The modal polls
   getBookExport until status === 'done' and follows downloadUrl. The
   `exportIncomplete` field of the throwable error gives the modal a
   per-chapter list so it can render a "Regenerate missing chapters"
   CTA inline. */
export class ExportIncompleteError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Export incomplete: ${missing.length} chapter(s) need audio first.`);
    this.name = 'ExportIncompleteError';
    this.missing = missing;
  }
}

async function realCreateBookExport(
  bookId: string,
  body: BookExportRequest,
): Promise<BookExportJob> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      missing?: string[];
      message?: string;
    };
    /* srv-28 — the disk guard's block verdict also 409s, but it carries
       `error: 'disk_full'` + a `message`, not a `missing` list. Surface its
       message verbatim rather than mislabelling it as an incomplete export. */
    if (err.error === 'disk_full') {
      throw new Error(err.message ?? 'Not enough disk space to export this book.');
    }
    throw new ExportIncompleteError(err.missing ?? []);
  }
  if (!res.ok)
    throw new Error(
      `Export request failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realListBookExports(bookId: string): Promise<BookExportJob[]> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/exports`);
  if (!res.ok)
    throw new Error(`List exports failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realGetBookExport(bookId: string, exportId: string): Promise<BookExportJob> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/exports/${encodeURIComponent(exportId)}`,
  );
  if (!res.ok)
    throw new Error(`Export poll failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

/* Cancels a running export. Idempotent on already-terminal jobs (server
   returns 204 either way). 404 is treated as a no-op — the modal still
   wants to dismiss locally even if the server lost the job. */
async function realCancelBookExport(bookId: string, exportId: string): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/exports/${encodeURIComponent(exportId)}`,
    { method: 'DELETE' },
  );
  if (res.status === 404 || res.status === 204) return;
  if (!res.ok)
    throw new Error(
      `Export cancel failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
}

/* Plan 67 — mint (or look up) a slugged share URL for the book. The
   server caches the slug per bookId so a second call returns the same
   URL — no re-mint churn. The frontend opens a copy-to-clipboard modal
   with the URL on success. */
async function realCreateBookShareLink(bookId: string): Promise<BookShareLink> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok)
    throw new Error(
      `Share-link mint failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realGetExportLanUrls(): Promise<ExportLanInfo> {
  const res = await fetch(`/api/export/lan`);
  if (!res.ok)
    throw new Error(
      `LAN URL probe failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realCreatePairSession(): Promise<PairSessionInfo> {
  const res = await fetch(`/api/pair/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok)
    throw new Error(
      `pair session failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Plan 75 — portable book bundle (single .zip with state + manuscript +
   audio + cover + change-log for one book). The export returns the
   bundle as a Blob the caller can save via URL.createObjectURL + an
   anchor click. The import POSTs a multipart `file` field and returns
   the resolved bookId / targetPath so the library view can refresh and
   navigate. */
export interface PortableImportResult {
  bookId: string;
  targetPath: string;
  importedFiles: number;
  conflict?: { strategy: 'rename' | 'overwrite' | 'fail'; renamedTo?: string };
}

async function realExportPortable(bookId: string): Promise<Blob> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/export/portable`);
  if (!res.ok)
    throw new Error(
      `Portable export failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.blob();
}

async function realImportPortable(file: File): Promise<PortableImportResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`/api/import/portable`, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Portable import failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

async function mockExportPortable(_bookId: string): Promise<Blob> {
  await wait(120);
  /* Tiny valid empty-zip (EOCD only) so a real save-as click does
     trigger a browser download under VITE_USE_MOCKS=true. */
  return new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06].concat(Array(18).fill(0)))], {
    type: 'application/zip',
  });
}

async function mockImportPortable(file: File): Promise<PortableImportResult> {
  await wait(150);
  const baseTitle = file.name.replace(/\.portable\.zip$/i, '').replace(/\.zip$/i, '');
  return {
    bookId: `imported__standalones__${baseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    targetPath: `(mock workspace)/${baseTitle}`,
    importedFiles: 5,
    conflict: { strategy: 'rename', renamedTo: `${baseTitle} (imported)` },
  };
}

/* Mock path: simulate a ~3 s build by ticking a fake job through three
   progress phases. The "downloadUrl" points at a data: URL so a real
   click does fire a browser download under VITE_USE_MOCKS=true (it'll
   just be a tiny stub zip). */
const MOCK_EXPORT_JOBS = new Map<string, BookExportJob>();
const MOCK_EXPORT_TIMERS = new Map<string, ReturnType<typeof setTimeout>[]>();

async function mockCreateBookExport(
  bookId: string,
  body: BookExportRequest,
): Promise<BookExportJob> {
  await wait(120);
  const id = `exp_${Math.random().toString(36).slice(2, 12)}`;
  const job: BookExportJob = {
    id,
    bookId,
    format: body.format,
    destination: body.destination,
    status: 'in_progress',
    filename: `Mock audiobook.${body.format === 'mp3-zip' ? 'zip' : 'm4b'}`,
    sizeBytes: null,
    progress: 0,
    downloadUrl: null,
    syncPath: null,
    errorReason: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  MOCK_EXPORT_JOBS.set(id, job);

  /* Tick progress so a real poller observes the same lifecycle as live. */
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(
    setTimeout(() => {
      const j = MOCK_EXPORT_JOBS.get(id);
      if (j) MOCK_EXPORT_JOBS.set(id, { ...j, progress: 0.25 });
    }, 700),
  );
  timers.push(
    setTimeout(() => {
      const j = MOCK_EXPORT_JOBS.get(id);
      if (j) MOCK_EXPORT_JOBS.set(id, { ...j, progress: 0.6 });
    }, 1500),
  );
  timers.push(
    setTimeout(() => {
      const j = MOCK_EXPORT_JOBS.get(id);
      if (!j) return;
      const blob = new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06].concat(Array(18).fill(0)))], {
        type: 'application/zip',
      });
      MOCK_EXPORT_JOBS.set(id, {
        ...j,
        status: 'done',
        progress: 1,
        sizeBytes: 22,
        downloadUrl: URL.createObjectURL(blob),
        syncPath:
          body.destination === 'sync-folder'
            ? 'C:\\Users\\dudar\\OneDrive\\Audiobooks\\Mock.zip'
            : null,
        completedAt: new Date().toISOString(),
      });
    }, 2400),
  );
  MOCK_EXPORT_TIMERS.set(id, timers);
  return job;
}

async function mockListBookExports(bookId: string): Promise<BookExportJob[]> {
  await wait(40);
  return [...MOCK_EXPORT_JOBS.values()]
    .filter((j) => j.bookId === bookId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function mockGetBookExport(_bookId: string, exportId: string): Promise<BookExportJob> {
  await wait(40);
  const job = MOCK_EXPORT_JOBS.get(exportId);
  if (!job) throw new Error('Mock export not found.');
  return job;
}

async function mockCancelBookExport(_bookId: string, exportId: string): Promise<void> {
  await wait(20);
  const timers = MOCK_EXPORT_TIMERS.get(exportId);
  if (timers) {
    for (const t of timers) clearTimeout(t);
    MOCK_EXPORT_TIMERS.delete(exportId);
  }
  const job = MOCK_EXPORT_JOBS.get(exportId);
  if (job && job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled') {
    MOCK_EXPORT_JOBS.set(exportId, {
      ...job,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      errorReason: 'Cancelled by user.',
    });
  }
}

/* Plan 67 — mock the slug minter so the design-fixture mode shows a
   plausible share URL without round-tripping a server. Stable per
   bookId (memoised in module-scope) so a second click hands back the
   same string, matching the real route's idempotent contract. */
const MOCK_SHARE_LINKS = new Map<string, BookShareLink>();
async function mockCreateBookShareLink(bookId: string): Promise<BookShareLink> {
  await wait(120);
  const cached = MOCK_SHARE_LINKS.get(bookId);
  if (cached) return cached;
  /* 12-char Crockford-style base32 slug, same alphabet as the server's
     newSlug() — matches the SLUG_RE on the share route so the regex
     pattern in e2e tests is satisfied in mock mode too. */
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let slug = '';
  for (let i = 0; i < 12; i += 1) slug += alphabet[Math.floor(Math.random() * alphabet.length)];
  const link: BookShareLink = {
    slug,
    url: `${window.location.origin}/share/${slug}`,
  };
  MOCK_SHARE_LINKS.set(bookId, link);
  return link;
}

async function mockGetExportLanUrls(): Promise<ExportLanInfo> {
  await wait(20);
  /* HTTPS + token + caFingerprint so the companion Pair-a-device QR has a
     complete payload to render in mock mode (the export modal just renders
     urls[0], so https is harmless there). */
  return {
    urls: ['https://192.168.1.42:8443'],
    port: 8443,
    protocol: 'https',
    token: 'mock-lan-token-0123456789abcdef',
    caFingerprint:
      'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  };
}

async function mockCreatePairSession(): Promise<PairSessionInfo> {
  await wait(20);
  const hostPort = '192.168.1.42:8443';
  const code = 'K7QF3M2P';
  const fpTag = 'J4XQ2A7BWZ9K3M5R';
  return {
    qrPayload: `CWP1*${hostPort}*${code}*${fpTag}`,
    hostPort,
    port: 8443,
    code,
    fpTag,
    expiresAt: Date.now() + 300000,
  };
}

/* GPU semaphore state — surfaces the depth/inFlight/max triple from the
   server's GpuSemaphore so the top-bar pill can prefix "GPU busy · N waiting ·"
   when a session is waiting behind another's analyzer / sidecar call.
   See server/src/gpu/semaphore.ts + server/src/routes/gpu-queue.ts. */
export interface GpuQueueState {
  /** Number of acquires waiting in the FIFO queue behind in-flight ops. */
  depth: number;
  /** Number of GPU ops currently holding a slot (analyzer + sidecar combined). */
  inFlight: number;
  /** Configured concurrency ceiling (GPU_CONCURRENCY env var, default 1). */
  max: number;
}

async function realGetGpuQueueState(): Promise<GpuQueueState> {
  /* Permissive: a 404 / 5xx (older server, partial deploy, hot-reload
     mid-poll) shouldn't surface as a user-visible failure. The
     useTtsLifecycle caller treats a rejected promise as "clear the
     depth" — the pill drops back to its default label. */
  const res = await fetch('/api/gpu/queue');
  if (!res.ok) {
    throw new Error(`GPU queue probe HTTP ${res.status}`);
  }
  return (await res.json()) as GpuQueueState;
}

async function mockGetGpuQueueState(): Promise<GpuQueueState> {
  /* Mocks don't run a real semaphore — generation is local + synchronous
     under VITE_USE_MOCKS=true, so the queue is always empty. The shape
     stays contract-correct so any future visual regression on the pill's
     "GPU busy · N waiting ·" prefix can be exercised by stubbing the api
     surface in tests. */
  await wait(20);
  return { depth: 0, inFlight: 0, max: 1 };
}

/* fs-18 — one-shot diagnostics board for the Admin watch console. Mirrors the
   DiagnosticsResponse schema in openapi.yaml; see server/src/routes/diagnostics.ts.
   Polled by the Admin view + the top-bar status dot (~30 s cadence). */
export type DiagnosticsStatus = 'ok' | 'warn' | 'fail';
export type DiagnosticsCheckId =
  | 'gpu'
  | 'sidecar'
  | 'asr'
  | 'analyzer'
  | 'gemini'
  | 'ffmpeg'
  | 'disk';

export interface DiagnosticsCheck {
  id: DiagnosticsCheckId;
  label: string;
  status: DiagnosticsStatus;
  detail: string;
  value?: string | number | null;
}

export interface DiagnosticsResponse {
  ts: string;
  overall: DiagnosticsStatus;
  checks: DiagnosticsCheck[];
}

async function realGetDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await fetch('/api/diagnostics');
  if (!res.ok) {
    throw new Error(`Diagnostics probe HTTP ${res.status}`);
  }
  return (await res.json()) as DiagnosticsResponse;
}

async function mockGetDiagnostics(): Promise<DiagnosticsResponse> {
  /* Mocks have no real processes to probe — generation is local + synchronous
     under VITE_USE_MOCKS=true. Return a contract-correct all-green board so the
     Admin view + status dot render their healthy state in tests / demos. */
  await wait(40);
  return {
    ts: '2026-01-01T00:00:00.000Z',
    overall: 'ok',
    checks: [
      { id: 'gpu', label: 'GPU / VRAM', status: 'ok', detail: 'cuda · 1.2 / 8.0 GB reserved', value: '1.2/8.0 GB' },
      { id: 'sidecar', label: 'Voice engine', status: 'ok', detail: 'reachable · kokoro, qwen', value: 'kokoro, qwen' },
      { id: 'asr', label: 'ASR (Whisper)', status: 'ok', detail: 'off — content-QA disabled' },
      { id: 'analyzer', label: 'Analyzer (Ollama)', status: 'ok', detail: 'reachable · model resident' },
      { id: 'gemini', label: 'Analyzer (Gemini)', status: 'ok', detail: 'not in use' },
      { id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: 'ok', detail: 'both present' },
      { id: 'disk', label: 'Free disk', status: 'ok', detail: '142 GB free', value: 142 },
    ],
  };
}

/* fs-21 — first-run readiness. Mirrors SetupReadiness in
   server/src/routes/setup-readiness.ts. */
export type BlockerStatus = 'pass' | 'fail';
export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerStatus; ffmpeg: BlockerStatus; tts: BlockerStatus; analyzer: BlockerStatus };
  info: { gpu: string };
}

async function realGetSetupReadiness(): Promise<SetupReadiness> {
  const res = await fetch('/api/setup/readiness');
  if (!res.ok) throw new Error(`readiness ${res.status}`);
  return (await res.json()) as SetupReadiness;
}

/* Exported so unit tests can drive it directly (the `api.*` indirection locks
   USE_MOCKS at import). Latches not-ready into sessionStorage from the
   ?setup=notready param so the state survives the redirect to #/setup, where
   the query param is gone. */
export async function mockGetSetupReadiness(): Promise<SetupReadiness> {
  if (window.location.hash.includes('setup=notready')) {
    sessionStorage.setItem('mock-setup-readiness', 'notready');
  }
  const notReady = sessionStorage.getItem('mock-setup-readiness') === 'notready';
  return notReady
    ? {
        ready: false,
        completedAt: null,
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
        info: { gpu: 'CPU — no GPU detected' },
      }
    : {
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
        info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
      };
}

async function realCompleteSetup(): Promise<{ completedAt: string }> {
  const res = await fetch('/api/setup/complete', { method: 'POST' });
  if (!res.ok) throw new Error(`complete ${res.status}`);
  return (await res.json()) as { completedAt: string };
}

export async function mockCompleteSetup(): Promise<{ completedAt: string }> {
  return { completedAt: '2026-06-12T00:00:00.000Z' };
}

export interface SmokeTestResult {
  ok: boolean;
  url?: string;
  durationSec?: number;
  analyzerOk?: boolean;
  analyzerDetail?: string;
  stage?: string;
  error?: string;
}

async function realRunSmokeTest(): Promise<SmokeTestResult> {
  const res = await fetch('/api/setup/smoke', { method: 'POST' });
  if (!res.ok) throw new Error(`smoke ${res.status}`);
  return (await res.json()) as SmokeTestResult;
}

export async function mockRunSmokeTest(): Promise<SmokeTestResult> {
  await wait(800);
  return { ok: true, url: stubAudioA, durationSec: 3.2, analyzerOk: true, analyzerDetail: '(mock)' };
}

async function mockGetSidecarHealth(): Promise<SidecarHealth> {
  /* Mocks pretend everything's healthy — generation is local and synchronous
     under VITE_USE_MOCKS=true, so there's no real sidecar to probe. */
  await wait(80);
  return {
    status: 'reachable',
    url: '(mock)',
    engines: ['coqui', 'kokoro', 'qwen', 'gemini'],
    modelLoaded: MOCK_SIDECAR_MODEL_LOADED,
    loading: false,
    kokoroLoaded: MOCK_SIDECAR_KOKORO_LOADED,
    kokoroLoading: false,
    qwenLoaded: MOCK_SIDECAR_QWEN_LOADED,
    qwenLoading: false,
    qwenInstallState: MOCK_SIDECAR_QWEN_LOADED ? 'loaded' : MOCK_SIDECAR_QWEN_INSTALL_STATE,
    qwenPackageInstalled: MOCK_SIDECAR_QWEN_INSTALL_STATE !== 'not-installed',
    qwenWeightsPresent:
      MOCK_SIDECAR_QWEN_LOADED ||
      MOCK_SIDECAR_QWEN_INSTALL_STATE === 'ready' ||
      MOCK_SIDECAR_QWEN_INSTALL_STATE === 'loaded',
    device:
      MOCK_SIDECAR_MODEL_LOADED || MOCK_SIDECAR_KOKORO_LOADED || MOCK_SIDECAR_QWEN_LOADED
        ? 'cuda'
        : null,
  };
}

/* In-memory removed-model state for the mock path — flipped by mockRemoveModel
   so a Remove in the Model Manager round-trips visibly under VITE_USE_MOCKS. */
const MOCK_REMOVED_MODEL_IDS = new Set<string>();

/* fs-23 — static mock inventory so the Model Manager renders + e2e runs offline
   under VITE_USE_MOCKS=true. Kokoro present + loaded (the resident fallback),
   Qwen base present, Coqui/Whisper absent, one resident Ollama analyzer model.
   Models removed via mockRemoveModel render as not-installed. */
async function mockGetModelInventory(): Promise<ModelInventoryResponse> {
  await wait(80);
  const applyRemoved = (item: ModelInventoryItem): ModelInventoryItem =>
    MOCK_REMOVED_MODEL_IDS.has(item.id)
      ? { ...item, present: false, loaded: false, sizeBytes: null, removable: false }
      : item;
  const items: ModelInventoryItem[] = [
      {
        id: 'kokoro',
        kind: 'tts',
        label: 'Kokoro v1',
        present: true,
        sizeBytes: 346_030_080,
        diskPath: 'server/tts-sidecar/voices/kokoro',
        loaded: MOCK_SIDECAR_KOKORO_LOADED,
        isDefaultEngine: !MOCK_SIDECAR_QWEN_LOADED,
        isFallbackEngine: true,
        removable: true,
        updatable: true,
        integrity: 'verified',
      },
      {
        id: 'qwen-base',
        kind: 'tts',
        label: 'Qwen3-TTS Base (0.6B)',
        present: true,
        sizeBytes: 1_283_457_024,
        diskPath: '~/.cache/huggingface/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base',
        loaded: MOCK_SIDECAR_QWEN_LOADED,
        installState: MOCK_SIDECAR_QWEN_LOADED ? 'loaded' : 'ready',
        isDefaultEngine: MOCK_SIDECAR_QWEN_LOADED,
        isFallbackEngine: false,
        removable: true,
        updatable: true,
      },
      {
        id: 'qwen-design',
        kind: 'tts',
        label: 'Qwen3-TTS VoiceDesign (1.7B)',
        present: true,
        sizeBytes: 3_623_878_656,
        diskPath: '~/.cache/huggingface/hub/models--Qwen--Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        loaded: false,
        isDefaultEngine: false,
        isFallbackEngine: false,
        removable: true,
        updatable: true,
      },
      {
        id: 'coqui',
        kind: 'tts',
        label: 'Coqui XTTS v2',
        present: false,
        sizeBytes: null,
        diskPath: 'server/tts-sidecar/voices/coqui/tts/tts_models--multilingual--multi-dataset--xtts_v2',
        loaded: false,
        isDefaultEngine: false,
        isFallbackEngine: false,
        removable: false,
        updatable: true,
      },
      {
        id: 'whisper',
        kind: 'asr',
        label: 'Whisper ASR (faster-whisper)',
        present: false,
        sizeBytes: null,
        diskPath: '~/.cache/huggingface/hub/models--Systran--faster-whisper-base',
        loaded: false,
        isDefaultEngine: false,
        isFallbackEngine: false,
        removable: false,
        updatable: true,
      },
      {
        id: 'ollama:qwen3.5:4b',
        kind: 'analyzer',
        label: 'qwen3.5:4b',
        present: true,
        sizeBytes: 2_600_000_000,
        diskPath: null,
        loaded: true,
        isDefaultEngine: true,
        isFallbackEngine: false,
        removable: true,
        updatable: true,
      },
  ];
  return {
    ts: new Date().toISOString(),
    sidecarReachable: true,
    items: items.map(applyRemoved),
  };
}

/* fs-23 — mock removal. Honours the same guards the server enforces (loaded /
   default / fallback) so the confirm-modal warnings are exercisable offline,
   then marks the model removed so the next inventory poll shows it gone. */
async function mockRemoveModel(id: string): Promise<ModelRemovalResult> {
  await wait(60);
  if (id === 'kokoro') {
    return { ok: false, code: 'model-is-fallback', error: 'Kokoro is the fallback engine.' };
  }
  if (id === 'ollama:qwen3.5:4b') {
    return { ok: false, code: 'model-loaded', error: 'qwen3.5:4b is loaded.' };
  }
  MOCK_REMOVED_MODEL_IDS.add(id);
  return { ok: true, id, removed: true, freedBytes: 1_283_457_024 };
}

/* In-memory model state for the mock path — flipped by mockLoadSidecar /
   mockUnloadSidecar so the in-app Load/Stop pill round-trips visibly under
   VITE_USE_MOCKS=true. Per-engine flags so the Kokoro pill can be exercised
   independently from Coqui in e2e tests. Kokoro defaults to `true` to mirror
   the real sidecar's eager-preload-at-startup behaviour. */
let MOCK_SIDECAR_MODEL_LOADED = false;
let MOCK_SIDECAR_KOKORO_LOADED = true;
/* Qwen starts unloaded under mocks — it's a button-driven bespoke engine
   like Coqui (no eager preload), so the Qwen pill begins at 'idle'. */
let MOCK_SIDECAR_QWEN_LOADED = false;
/* Mocks pretend Qwen IS installed ('ready') so the conditional default
   resolves to Qwen and the Qwen-default path is exercisable; tests that want
   the not-installed promo/warning stub getSidecarHealth directly. */
const MOCK_SIDECAR_QWEN_INSTALL_STATE: 'not-installed' | 'weights-missing' | 'ready' | 'loaded' =
  'ready';
let MOCK_OLLAMA_MODEL_LOADED = false;

async function realLoadSidecar(
  opts: { engine?: 'coqui' | 'kokoro' | 'qwen' } = {},
): Promise<ModelControlResult> {
  /* Default to Coqui when the caller omits `engine` — preserves back-compat
     with the original signature. The Kokoro / Qwen pills always pass
     `{ engine: 'kokoro' | 'qwen' }` explicitly. */
  const body = opts.engine ? { engine: opts.engine } : {};
  const res = await fetch('/api/sidecar/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realUnloadSidecar(
  opts: { engine?: 'coqui' | 'kokoro' | 'qwen' } = {},
): Promise<ModelControlResult> {
  const body = opts.engine ? { engine: opts.engine } : {};
  const res = await fetch('/api/sidecar/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realLoadAnalyzer(): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/load', { method: 'POST' });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realUnloadAnalyzer(): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/unload', { method: 'POST' });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realGetOllamaHealth(): Promise<OllamaHealth> {
  const res = await fetch('/api/ollama/health');
  if (!res.ok) {
    return { status: 'unreachable', url: '', error: `Ollama probe HTTP ${res.status}` };
  }
  return res.json();
}

async function mockLoadSidecar(
  opts: { engine?: 'coqui' | 'kokoro' | 'qwen' } = {},
): Promise<ModelControlResult> {
  await wait(60);
  if (opts.engine === 'kokoro') {
    MOCK_SIDECAR_KOKORO_LOADED = true;
  } else if (opts.engine === 'qwen') {
    MOCK_SIDECAR_QWEN_LOADED = true;
  } else {
    MOCK_SIDECAR_MODEL_LOADED = true;
  }
  return { status: 'ready' };
}

async function mockUnloadSidecar(
  opts: { engine?: 'coqui' | 'kokoro' | 'qwen' } = {},
): Promise<ModelControlResult> {
  await wait(40);
  if (opts.engine === 'kokoro') {
    MOCK_SIDECAR_KOKORO_LOADED = false;
  } else if (opts.engine === 'qwen') {
    MOCK_SIDECAR_QWEN_LOADED = false;
  } else {
    MOCK_SIDECAR_MODEL_LOADED = false;
  }
  return { status: 'idle' };
}

async function mockLoadAnalyzer(): Promise<ModelControlResult> {
  await wait(60);
  MOCK_OLLAMA_MODEL_LOADED = true;
  return { status: 'ready' };
}

async function mockUnloadAnalyzer(): Promise<ModelControlResult> {
  await wait(40);
  MOCK_OLLAMA_MODEL_LOADED = false;
  return { status: 'unloaded' };
}

async function mockGetOllamaHealth(): Promise<OllamaHealth> {
  await wait(60);
  return {
    status: 'reachable',
    url: '(mock)',
    models: ['qwen3.5:4b'],
    expectedModel: 'qwen3.5:4b',
    modelPulled: true,
    resident: MOCK_OLLAMA_MODEL_LOADED ? ['qwen3.5:4b'] : [],
    modelResident: MOCK_OLLAMA_MODEL_LOADED,
  };
}

/* ── Per-book state.json auto-backup (srv-2) ────────────────────────────
   Real path round-trips through the /api/books/:bookId/backups routes
   (server/src/routes/backup.ts). Mock path keeps an in-memory per-book
   list seeded with a couple of fake snapshots so mock-mode / e2e never
   404s on the Account view's Restore picker. */
async function realListBookBackups(
  bookId: string,
): Promise<{ file: string; sizeBytes: number; createdAt: string }[]> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/backups`);
  if (!res.ok)
    throw new Error(
      `Backups fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  const body = (await res.json()) as {
    backups: { file: string; sizeBytes: number; createdAt: string }[];
  };
  return body.backups;
}

async function realBackupBookNow(bookId: string): Promise<{ file: string }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/backups/now`, {
    method: 'POST',
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Backup failed (${res.status}).`);
  }
  return res.json();
}

async function realRestoreBookBackup(bookId: string, backupFile: string): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupFile }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Restore failed (${res.status}).`);
  }
}

const MOCK_BACKUPS = new Map<string, { file: string; sizeBytes: number; createdAt: string }[]>();

async function mockListBookBackups(
  bookId: string,
): Promise<{ file: string; sizeBytes: number; createdAt: string }[]> {
  await wait(40);
  if (!MOCK_BACKUPS.has(bookId)) {
    const now = Date.now();
    MOCK_BACKUPS.set(bookId, [
      {
        file: 'state.2026-05-31T08-00-00-000Z.json',
        sizeBytes: 18_432,
        createdAt: new Date(now - 3_600_000).toISOString(),
      },
      {
        file: 'state.2026-05-30T08-00-00-000Z.json',
        sizeBytes: 17_980,
        createdAt: new Date(now - 90_000_000).toISOString(),
      },
    ]);
  }
  return [...(MOCK_BACKUPS.get(bookId) ?? [])];
}

async function mockBackupBookNow(bookId: string): Promise<{ file: string }> {
  await wait(60);
  const file = `state.${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const list = MOCK_BACKUPS.get(bookId) ?? [];
  list.unshift({ file, sizeBytes: 18_500, createdAt: new Date().toISOString() });
  MOCK_BACKUPS.set(bookId, list);
  return { file };
}

async function mockRestoreBookBackup(_bookId: string, _backupFile: string): Promise<void> {
  await wait(60);
}

/* ── Advanced config (/api/config + /api/config/prompts) ──────────────── */

/* Canned mock descriptors — four representative knobs across two groups that
   give the UI tests something to render. Keep them small but cover the main
   type variants (number, boolean, enum, string) and apply modes. */
const MOCK_CONFIG_DESCRIPTORS: import('./types').KnobDescriptor[] = [
  {
    key: 'KOKORO_SAMPLE_RATE',
    group: 'tts',
    label: 'Kokoro sample rate',
    help: 'Sample rate (Hz) for Kokoro synthesis output.',
    type: 'integer',
    min: 8000,
    max: 48000,
    step: 1000,
    apply: 'restart-sidecar',
    risk: 'low',
    isPrompt: false,
    default: 24000,
  },
  {
    key: 'SEG_QA_MAX_RERECORDS',
    group: 'tts',
    label: 'Max re-records per segment',
    help: 'How many times the QA gate may re-record a failing segment before giving up.',
    type: 'integer',
    min: 0,
    max: 10,
    step: 1,
    apply: 'live',
    risk: 'low',
    isPrompt: false,
    default: 2,
  },
  {
    key: 'SEG_ASR_ENABLED',
    group: 'tts',
    label: 'ASR content QA',
    help: 'Enable Whisper-based per-segment content QA gate.',
    type: 'boolean',
    apply: 'live',
    risk: 'low',
    isPrompt: false,
    default: false,
  },
  {
    key: 'ANALYZER_STAGE1_PROMPT',
    group: 'analyzer',
    label: 'Stage-1 attribution prompt',
    help: 'System prompt template used for per-sentence speaker attribution.',
    type: 'string',
    apply: 'live',
    risk: 'medium',
    isPrompt: true,
    default: 'Attribute each sentence to its speaker.',
  },
];

const MOCK_CONFIG_GROUPS: import('./types').ConfigGroup[] = [
  {
    id: 'tts',
    label: 'Text-to-speech',
    help: 'Synthesis engine settings.',
    risk: 'low',
    collapsedByDefault: false,
  },
  {
    id: 'analyzer',
    label: 'Analyzer',
    help: 'Analysis prompt templates and tuning.',
    risk: 'medium',
    collapsedByDefault: true,
  },
];

/* In-memory mock config store. Starts with default values; PUT/reset mutate it. */
const MOCK_CONFIG_VALUES: import('./types').ConfigValues = {
  KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 24000, source: 'default', locked: false, overridden: false },
  SEG_QA_MAX_RERECORDS: { key: 'SEG_QA_MAX_RERECORDS', effective: 2, source: 'default', locked: false, overridden: false },
  SEG_ASR_ENABLED: { key: 'SEG_ASR_ENABLED', effective: false, source: 'default', locked: false, overridden: false },
  ANALYZER_STAGE1_PROMPT: { key: 'ANALYZER_STAGE1_PROMPT', effective: 'Attribute each sentence to its speaker.', source: 'default', locked: false, overridden: false },
};

/* In-memory prompt store keyed by id. */
const MOCK_PROMPTS = new Map<string, PromptState>([
  [
    'ANALYZER_STAGE1_PROMPT',
    {
      id: 'ANALYZER_STAGE1_PROMPT',
      text: 'Attribute each sentence to its speaker.',
      isForked: false,
      defaultText: 'Attribute each sentence to its speaker.',
    },
  ],
]);

export async function mockGetConfig(): Promise<ConfigResponse> {
  await wait(40);
  return {
    groups: MOCK_CONFIG_GROUPS,
    descriptors: MOCK_CONFIG_DESCRIPTORS,
    values: { ...MOCK_CONFIG_VALUES },
    restartPending: false,
  };
}

export async function mockPutConfig(
  patch: Record<string, number | boolean | string>,
): Promise<{ ok: boolean; applied: string[]; values: ConfigValues }> {
  await wait(30);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key in MOCK_CONFIG_VALUES) {
      MOCK_CONFIG_VALUES[key] = { ...MOCK_CONFIG_VALUES[key], effective: value, source: 'override', overridden: true };
      applied.push(key);
    }
  }
  return { ok: true, applied, values: { ...MOCK_CONFIG_VALUES } };
}

export async function mockResetConfig(
  body: { keys?: string[]; group?: string; all?: boolean },
): Promise<{ ok: boolean; values: ConfigValues }> {
  await wait(30);
  const keysToReset: string[] = body.all
    ? Object.keys(MOCK_CONFIG_VALUES)
    : body.keys
      ? body.keys
      : body.group
        ? MOCK_CONFIG_DESCRIPTORS.filter((d) => d.group === body.group).map((d) => d.key)
        : [];
  for (const key of keysToReset) {
    const descriptor = MOCK_CONFIG_DESCRIPTORS.find((d) => d.key === key);
    if (descriptor && key in MOCK_CONFIG_VALUES) {
      MOCK_CONFIG_VALUES[key] = { key, effective: descriptor.default, source: 'default', locked: false, overridden: false };
    }
  }
  return { ok: true, values: { ...MOCK_CONFIG_VALUES } };
}

export async function mockGetPrompt(id: string): Promise<PromptState> {
  await wait(30);
  const existing = MOCK_PROMPTS.get(id);
  if (existing) return { ...existing };
  const defaultText = `Default prompt for ${id}`;
  return { id, text: defaultText, isForked: false, defaultText };
}

export async function mockPutPrompt(id: string, text: string): Promise<PromptState> {
  await wait(30);
  const existing = MOCK_PROMPTS.get(id);
  const defaultText = existing?.defaultText ?? `Default prompt for ${id}`;
  const updated: PromptState = { id, text, isForked: text !== defaultText, defaultText };
  MOCK_PROMPTS.set(id, updated);
  return { ...updated };
}

export async function mockResetPrompt(id: string): Promise<PromptState> {
  await wait(30);
  const existing = MOCK_PROMPTS.get(id);
  const defaultText = existing?.defaultText ?? `Default prompt for ${id}`;
  const reset: PromptState = { id, text: defaultText, isForked: false, defaultText };
  MOCK_PROMPTS.set(id, reset);
  return { ...reset };
}

export async function mockRestartSidecar(): Promise<{ ok: boolean; error?: string }> {
  await wait(60);
  return { ok: true };
}

/* Test helper — reset the mock config store to its initial defaults. */
export function _resetMockConfig(): void {
  Object.assign(MOCK_CONFIG_VALUES, {
    KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 24000, source: 'default', locked: false, overridden: false },
    SEG_QA_MAX_RERECORDS: { key: 'SEG_QA_MAX_RERECORDS', effective: 2, source: 'default', locked: false, overridden: false },
    SEG_ASR_ENABLED: { key: 'SEG_ASR_ENABLED', effective: false, source: 'default', locked: false, overridden: false },
    ANALYZER_STAGE1_PROMPT: { key: 'ANALYZER_STAGE1_PROMPT', effective: 'Attribute each sentence to its speaker.', source: 'default', locked: false, overridden: false },
  });
  MOCK_PROMPTS.set('ANALYZER_STAGE1_PROMPT', {
    id: 'ANALYZER_STAGE1_PROMPT',
    text: 'Attribute each sentence to its speaker.',
    isForked: false,
    defaultText: 'Attribute each sentence to its speaker.',
  });
}

/* Real implementations for /api/config and /api/config/prompts. */
async function realGetConfig(): Promise<ConfigResponse> {
  const res = await fetch('/api/config');
  if (!res.ok)
    throw new Error(`Config fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realPutConfig(
  patch: Record<string, number | boolean | string>,
): Promise<{ ok: boolean; applied: string[]; values: ConfigValues }> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok)
    throw new Error(
      `Config update failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realResetConfig(
  body: { keys?: string[]; group?: string; all?: boolean },
): Promise<{ ok: boolean; values: ConfigValues }> {
  const res = await fetch('/api/config/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `Config reset failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realGetPrompt(id: string): Promise<PromptState> {
  const res = await fetch(`/api/config/prompts/${encodeURIComponent(id)}`);
  if (!res.ok)
    throw new Error(
      `Prompt fetch failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realPutPrompt(id: string, text: string): Promise<PromptState> {
  const res = await fetch(`/api/config/prompts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok)
    throw new Error(
      `Prompt update failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realResetPrompt(id: string): Promise<PromptState> {
  const res = await fetch(`/api/config/prompts/${encodeURIComponent(id)}/reset`, {
    method: 'POST',
  });
  if (!res.ok)
    throw new Error(
      `Prompt reset failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

async function realRestartSidecar(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/sidecar/restart', { method: 'POST' });
  if (!res.ok)
    throw new Error(
      `Sidecar restart failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  return res.json();
}

/* Chapter audio + revisions polling stay mocked for now — both belong to the
   playback slice that comes after this one. */
const real = {
  listBookBackups: realListBookBackups,
  backupBookNow: realBackupBookNow,
  restoreBookBackup: realRestoreBookBackup,
  getUserSettings: realGetUserSettings,
  putUserSettings: realPutUserSettings,
  putGeminiKey: realPutGeminiKey,
  getAppInfo: realGetAppInfo,
  checkCompanionApk: realCheckCompanionApk,
  dismissWhatsNew: realDismissWhatsNew,
  upgradeStage: realUpgradeStage,
  upgradeApply: realUpgradeApply,
  upgradeAbort: realUpgradeAbort,
  upgradeState: realUpgradeState,
  testSyncFolderPath: realTestSyncFolderPath,
  getLibrary: realGetLibrary,
  getVoices: realGetVoices,
  setVoicePin: realSetVoicePin,
  getBaseVoices: realGetBaseVoices,
  setVoiceOverride: realSetVoiceOverride,
  setVoiceOverrideLinked: realSetVoiceOverrideLinked,
  getBookState: realGetBookState,
  putBookState: realPutBookState,
  getListenProgress: realGetListenProgress,
  putListenProgress: realPutListenProgress,
  findCoverCandidates: realFindCoverCandidates,
  setCover: realSetCover,
  removeCover: realRemoveCover,
  uploadCover: realUploadCover,
  patchCoverFraming: realPatchCoverFraming,
  getAnalysisState: realGetAnalysisState,
  getActiveAnalyses: realGetActiveAnalyses,
  getDroppedQuotes: realGetDroppedQuotes,
  importManuscript: realImportManuscript,
  confirmBook: realConfirmBook,
  uploadManuscript: realUploadManuscript,
  analyseManuscript: realAnalyseManuscript,
  matchVoices: realMatchVoices,
  mergeCharacters: realMergeCharacters,
  seriesPatchCharacter: realSeriesPatchCharacter,
  unlinkAlias: realUnlinkAlias,
  addAlias: realAddAlias,
  generateVoiceStyle: realGenerateVoiceStyle,
  generateAllVoiceStyles: realGenerateAllVoiceStyles,
  fetchDesignedPersona: realFetchDesignedPersona,
  designQwenVoice: realDesignQwenVoice,
  detectEmotions: realDetectEmotions,
  removeQwenVariant: realRemoveQwenVariant,
  promoteQwenVoice: realPromoteQwenVoice,
  discardQwenPreview: realDiscardQwenPreview,
  overrideLibraryCast: realOverrideLibraryCast,
  getSeriesRoster: realGetSeriesRoster,
  getSeriesCast: realGetSeriesCast,
  linkPriorCharacter: realLinkPriorCharacter,
  notLinkedTo: realNotLinkedTo,
  removeNotLinkedTo: realRemoveNotLinkedTo,
  addFromSeriesRoster: realAddFromSeriesRoster,
  deleteBook: realDeleteBook,
  reparseBook: realReparseBook,
  loadSample: realLoadSample,
  replaceManuscript: realReplaceManuscript,
  setChapterExcluded: realSetChapterExcluded,
  setChapterHeld: realSetChapterHeld,
  renameChapter: realRenameChapter,
  mergeChapters: realMergeChapters,
  splitChapter: realSplitChapter,
  reorderChapters: realReorderChapters,
  excludeChapters: realExcludeChapters,
  refreshChapterTitles: realRefreshChapterTitles,
  runAnalysisForChapters: realRunAnalysisForChapters,
  getVoiceSample: realGetVoiceSample,
  getBaseVoiceSample: realGetBaseVoiceSample,
  streamGeneration: realStreamGeneration,
  streamSplice: realStreamSplice,
  pauseGeneration: realPauseGeneration,
  pauseAnalysis: realPauseAnalysis,
  startCastDesign: realStartCastDesign,
  subscribeCastDesign: realSubscribeCastDesign,
  getCastDesignStatus: realGetCastDesignStatus,
  pauseCastDesign: realPauseCastDesign,
  startSingleDesign: realStartSingleDesign,
  subscribeSingleDesign: realSubscribeSingleDesign,
  getSingleDesignStatus: realGetSingleDesignStatus,
  getSidecarHealth: realGetSidecarHealth,
  getModelInventory: realGetModelInventory,
  removeModel: realRemoveModel,
  getGpuQueueState: realGetGpuQueueState,
  getDiagnostics: realGetDiagnostics,
  getSetupReadiness: realGetSetupReadiness,
  completeSetup: realCompleteSetup,
  runSmokeTest: realRunSmokeTest,
  getOllamaHealth: realGetOllamaHealth,
  loadSidecar: realLoadSidecar,
  unloadSidecar: realUnloadSidecar,
  loadAnalyzer: realLoadAnalyzer,
  unloadAnalyzer: realUnloadAnalyzer,
  getWorkspaceInfo: realGetWorkspaceInfo,
  getWorkspaceChangelog: realGetWorkspaceChangelog,
  createBookExport: realCreateBookExport,
  getBookExport: realGetBookExport,
  listBookExports: realListBookExports,
  cancelBookExport: realCancelBookExport,
  createBookShareLink: realCreateBookShareLink,
  exportPortable: realExportPortable,
  importPortable: realImportPortable,
  getExportLanUrls: realGetExportLanUrls,
  createPairSession: realCreatePairSession,
  getChapterAudio: async ({ bookId, chapterId }: AudioArgs): Promise<ChapterAudio> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Chapter audio fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  /* Preserved (A) audio for revision-diff a/b audition. 404 when no
     `.previous.*` pair exists — caller (revision-diff player) handles
     by rendering the "Original audio not preserved" copy. */
  getChapterAudioPrevious: async ({
    bookId,
    chapterId,
  }: AudioArgs): Promise<ChapterAudio | null> => {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio/previous`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Previous audio fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  acceptChapterRevision: async ({
    bookId,
    chapterId,
  }: {
    bookId: string;
    chapterId: number;
  }): Promise<void> => {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio/previous`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Accept revision failed (${res.status}): ${detail || res.statusText}`);
    }
  },
  rejectChapterRevision: async ({
    bookId,
    chapterId,
  }: {
    bookId: string;
    chapterId: number;
  }): Promise<void> => {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio/previous/restore`,
      { method: 'POST' },
    );
    if (res.status === 409) {
      throw new Error('Generation is in flight. Wait for the render to finish before rejecting.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Reject revision failed (${res.status}): ${detail || res.statusText}`);
    }
  },
  pollRevisions: async ({ bookId }: PollArgs): Promise<RevisionsResponse> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/revisions`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Revisions poll failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  /* Plan 83 — background-drift fan-out across non-active books. Active-
     book poll keeps using pollRevisions above; the layout.tsx two-tier
     poller calls this every 120s for every book past the cast-pending
     stage. Server returns { byBookId: { [bookId]: RevisionsResponse } }
     and silently omits any bookId that's not on disk. */
  pollRevisionsBulk: async ({
    bookIds,
  }: {
    bookIds: string[];
  }): Promise<{ byBookId: Record<string, RevisionsResponse> }> => {
    if (bookIds.length === 0) return { byBookId: {} };
    const url = `/api/revisions?bookIds=${bookIds.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Bulk revisions poll failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  /* Plan 86 — dev-only worktree dashboard backing. The server route 404s
     in production; the api caller surfaces that as a thrown Error so the
     view shows a "dev-only" message. */
  getWorktrees: async (): Promise<{
    worktrees: Array<{
      path: string;
      branch: string | null;
      head: string | null;
      ports: Record<string, string>;
      vitePort: number;
      alive: boolean;
    }>;
  }> => {
    const res = await fetch('/api/worktrees');
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Worktrees fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  /* Live generation throughput for the dev top-bar RTF pill (GET
     /api/generation/stats). Fields are all-null when idle. */
  getGenerationStats: async (): Promise<GenerationStatsResponse> => {
    const res = await fetch('/api/generation/stats');
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Generation stats fetch failed (${res.status}): ${detail || res.statusText}`,
      );
    }
    return res.json();
  },
  /* fs-20 — per-run resource telemetry for the Admin trend panel (GET
     /api/generation/telemetry). Newest-first; empty when nothing recorded. */
  getResourceTelemetry: async (
    limit?: number,
  ): Promise<{ records: ResourceTelemetryRecord[] }> => {
    const qs = limit != null ? `?limit=${encodeURIComponent(limit)}` : '';
    const res = await fetch(`/api/generation/telemetry${qs}`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Resource telemetry fetch failed (${res.status}): ${detail || res.statusText}`,
      );
    }
    return res.json();
  },
  getConfig: realGetConfig,
  putConfig: realPutConfig,
  resetConfig: realResetConfig,
  getPrompt: realGetPrompt,
  putPrompt: realPutPrompt,
  resetPrompt: realResetPrompt,
  restartSidecar: realRestartSidecar,
};

const mock = {
  listBookBackups: mockListBookBackups,
  backupBookNow: mockBackupBookNow,
  restoreBookBackup: mockRestoreBookBackup,
  getUserSettings: mockGetUserSettings,
  putUserSettings: mockPutUserSettings,
  putGeminiKey: mockPutGeminiKey,
  getAppInfo: mockGetAppInfo,
  checkCompanionApk: mockCheckCompanionApk,
  dismissWhatsNew: mockDismissWhatsNew,
  upgradeStage: mockUpgradeStage,
  upgradeApply: mockUpgradeApply,
  upgradeAbort: mockUpgradeAbort,
  upgradeState: mockUpgradeState,
  testSyncFolderPath: mockTestSyncFolderPath,
  getLibrary: mockGetLibrary,
  getVoices: mockGetVoices,
  setVoicePin: mockSetVoicePin,
  getBaseVoices: mockGetBaseVoices,
  setVoiceOverride: mockSetVoiceOverride,
  setVoiceOverrideLinked: mockSetVoiceOverrideLinked,
  getBookState: mockGetBookState,
  putBookState: mockPutBookState,
  getListenProgress: mockGetListenProgress,
  putListenProgress: mockPutListenProgress,
  findCoverCandidates: mockFindCoverCandidates,
  setCover: mockSetCover,
  removeCover: mockRemoveCover,
  uploadCover: mockUploadCover,
  patchCoverFraming: mockPatchCoverFraming,
  getAnalysisState: mockGetAnalysisState,
  getActiveAnalyses: mockGetActiveAnalyses,
  getDroppedQuotes: mockGetDroppedQuotes,
  importManuscript: mockImportManuscript,
  confirmBook: mockConfirmBook,
  uploadManuscript: mockUploadManuscript,
  analyseManuscript: mockAnalyseManuscript,
  matchVoices: mockMatchVoices,
  mergeCharacters: mockMergeCharacters,
  seriesPatchCharacter: mockSeriesPatchCharacter,
  unlinkAlias: mockUnlinkAlias,
  addAlias: mockAddAlias,
  generateVoiceStyle: mockGenerateVoiceStyle,
  generateAllVoiceStyles: mockGenerateAllVoiceStyles,
  fetchDesignedPersona: mockFetchDesignedPersona,
  designQwenVoice: mockDesignQwenVoice,
  detectEmotions: mockDetectEmotions,
  removeQwenVariant: mockRemoveQwenVariant,
  promoteQwenVoice: mockPromoteQwenVoice,
  discardQwenPreview: mockDiscardQwenPreview,
  overrideLibraryCast: mockOverrideLibraryCast,
  getSeriesRoster: mockGetSeriesRoster,
  getSeriesCast: mockGetSeriesCast,
  linkPriorCharacter: mockLinkPriorCharacter,
  notLinkedTo: mockNotLinkedTo,
  removeNotLinkedTo: mockRemoveNotLinkedTo,
  addFromSeriesRoster: mockAddFromSeriesRoster,
  deleteBook: mockDeleteBook,
  reparseBook: mockReparseBook,
  loadSample: mockLoadSample,
  replaceManuscript: mockReplaceManuscript,
  setChapterExcluded: mockSetChapterExcluded,
  setChapterHeld: mockSetChapterHeld,
  renameChapter: mockRenameChapter,
  mergeChapters: mockMergeChapters,
  splitChapter: mockSplitChapter,
  reorderChapters: mockReorderChapters,
  excludeChapters: mockExcludeChapters,
  refreshChapterTitles: mockRefreshChapterTitles,
  runAnalysisForChapters: mockRunAnalysisForChapters,
  getVoiceSample: mockGetVoiceSample,
  getBaseVoiceSample: mockGetBaseVoiceSample,
  streamGeneration: mockStreamGeneration,
  streamSplice: mockStreamSplice,
  pauseGeneration: mockPauseGeneration,
  pauseAnalysis: mockPauseAnalysis,
  startCastDesign: mockStartCastDesign,
  subscribeCastDesign: mockSubscribeCastDesign,
  getCastDesignStatus: mockGetCastDesignStatus,
  pauseCastDesign: mockPauseCastDesign,
  startSingleDesign: mockStartSingleDesign,
  subscribeSingleDesign: mockSubscribeSingleDesign,
  getSingleDesignStatus: mockGetSingleDesignStatus,
  getSidecarHealth: mockGetSidecarHealth,
  getModelInventory: mockGetModelInventory,
  removeModel: mockRemoveModel,
  getGpuQueueState: mockGetGpuQueueState,
  getDiagnostics: mockGetDiagnostics,
  getSetupReadiness: mockGetSetupReadiness,
  completeSetup: mockCompleteSetup,
  runSmokeTest: mockRunSmokeTest,
  getOllamaHealth: mockGetOllamaHealth,
  loadSidecar: mockLoadSidecar,
  unloadSidecar: mockUnloadSidecar,
  loadAnalyzer: mockLoadAnalyzer,
  unloadAnalyzer: mockUnloadAnalyzer,
  getWorkspaceInfo: mockGetWorkspaceInfo,
  getWorkspaceChangelog: mockGetWorkspaceChangelog,
  createBookExport: mockCreateBookExport,
  getBookExport: mockGetBookExport,
  listBookExports: mockListBookExports,
  cancelBookExport: mockCancelBookExport,
  createBookShareLink: mockCreateBookShareLink,
  exportPortable: mockExportPortable,
  importPortable: mockImportPortable,
  getExportLanUrls: mockGetExportLanUrls,
  createPairSession: mockCreatePairSession,
  getChapterAudio: mockGetChapterAudio,
  getChapterAudioPrevious: mockGetChapterAudioPrevious,
  acceptChapterRevision: mockAcceptChapterRevision,
  rejectChapterRevision: mockRejectChapterRevision,
  pollRevisions: mockPollRevisions,
  /* Plan 83 — mock fans out via the existing single-book mock for each id.
     Real server runs the per-book helper in parallel; the mock can do the
     same with no rate concerns since it's all in-memory. */
  pollRevisionsBulk: async ({
    bookIds,
  }: {
    bookIds: string[];
  }): Promise<{ byBookId: Record<string, RevisionsResponse> }> => {
    const entries = await Promise.all(
      bookIds.map(async (bookId) => [bookId, await mockPollRevisions({ bookId })] as const),
    );
    const byBookId: Record<string, RevisionsResponse> = {};
    for (const [id, r] of entries) byBookId[id] = r;
    return { byBookId };
  },
  /* Plan 86 — mock returns an empty worktrees list. Production gets
     this same shape via the real api when NODE_ENV !== 'production'. */
  getWorktrees: async (): Promise<{
    worktrees: Array<{
      path: string;
      branch: string | null;
      head: string | null;
      ports: Record<string, string>;
      vitePort: number;
      alive: boolean;
    }>;
  }> => {
    return { worktrees: [] };
  },
  /* Mock has no live pipeline (liveBatchRtf stays null), but ships a small
     deterministic history with a deliberately rising rtf (newest-first) so the
     dev Worktrees throughput table + deterioration tint are exercisable under
     VITE_USE_MOCKS. Fixed ISO timestamps (no Date.now()) keep snapshots stable. */
  getGenerationStats: async (): Promise<GenerationStatsResponse> => {
    const recentChapters = [2.41, 2.12, 1.78, 1.5, 1.31, 1.12, 0.94].map((rtf, i) => ({
      chapterId: 7 - i,
      title: `Chapter ${7 - i}`,
      bookId: 'mock-book',
      modelKey: 'qwen3-tts',
      rtf,
      audioSec: 600,
      synthSec: Math.round(600 * rtf),
      // Newest-first: index 0 is the latest. 9-minute spacing, fixed base.
      at: new Date(Date.parse('2026-06-01T09:00:00Z') + (6 - i) * 9 * 60_000).toISOString(),
    }));
    return {
      chapters: recentChapters.length,
      audioSec: 4200,
      synthSec: 6700,
      rtf: 1.6,
      xRealtime: 0.63,
      chaptersPerHour: 6.4,
      last: null,
      updatedAt: recentChapters[0].at,
      liveBatchRtf: null,
      lastBatchRtf: null,
      batchesInWindow: 0,
      batchUpdatedAt: null,
      recentChapters,
    };
  },
  /* fs-20 — mock per-run resource telemetry. Mirrors the throughput mock's
     newest-first shape; VRAM climbs slightly across the run so the trend
     panel's sparkline has a visible slope in mock mode. */
  getResourceTelemetry: async (
    limit?: number,
  ): Promise<{ records: ResourceTelemetryRecord[] }> => {
    /* Newest-first; the first three rows come from a second book so the Admin
       panel's per-book grouping has more than one group to render in mock mode. */
    const books = [
      { bookId: 'mock-book-stellarlune', bookTitle: 'Stellarlune' },
      { bookId: 'mock-book-stellarlune', bookTitle: 'Stellarlune' },
      { bookId: 'mock-book-stellarlune', bookTitle: 'Stellarlune' },
      { bookId: 'mock-book-unlocked', bookTitle: 'Unlocked' },
      { bookId: 'mock-book-unlocked', bookTitle: 'Unlocked' },
      { bookId: 'mock-book-unlocked', bookTitle: 'Unlocked' },
      { bookId: 'mock-book-unlocked', bookTitle: 'Unlocked' },
    ];
    const records: ResourceTelemetryRecord[] = [2.41, 2.12, 1.78, 1.5, 1.31, 1.12, 0.94].map(
      (rtf, i) => ({
        at: new Date(Date.parse('2026-06-01T09:00:00Z') + (6 - i) * 9 * 60_000).toISOString(),
        bookId: books[i].bookId,
        bookTitle: books[i].bookTitle,
        chapterId: 7 - i,
        title: `Chapter ${7 - i}`,
        modelKey: 'qwen3-tts-0.6b',
        rtf,
        audioSec: 600,
        wallSec: Math.round(600 * rtf),
        vramReservedMb: 3000 + i * 120,
        vramTotalMb: 8192,
        committedHostMb: 4000 + i * 200,
      }),
    );
    return { records: limit != null ? records.slice(0, limit) : records };
  },
  getConfig: mockGetConfig,
  putConfig: mockPutConfig,
  resetConfig: mockResetConfig,
  getPrompt: mockGetPrompt,
  putPrompt: mockPutPrompt,
  resetPrompt: mockResetPrompt,
  restartSidecar: mockRestartSidecar,
};

/* fs-20 — re-export so the Admin trend panel + its tests import the telemetry
   record type from the same `../lib/api` surface as the other admin types. */
export type { ResourceTelemetryRecord } from './types';
/* Re-export config types so the config slice + view import from a single source. */
export type { ConfigResponse, ConfigValues, KnobDescriptor, ConfigGroup, PromptState } from './types';

/** One finished chapter's own throughput, for the dev Worktrees throughput
    table. `rtf` is synth-wall ÷ audio (< 1 = faster than realtime) or null when
    the chapter produced no audio. Mirrors the server's `ChapterThroughputRecord`. */
export interface RecentChapter {
  chapterId: number | string;
  title: string | null;
  bookId: string | null;
  modelKey: string | null;
  rtf: number | null;
  audioSec: number;
  synthSec: number;
  at: string;
}

/** Live generation-throughput snapshot — mirrors the server's
    `generation-stats` accumulator. Backs the dev top-bar RTF pill. */
export interface GenerationStatsResponse {
  chapters: number;
  audioSec: number;
  synthSec: number;
  /** synth-wall ÷ audio over the rolling window (< 1 = faster than realtime). */
  rtf: number | null;
  /** audio ÷ synth-wall — the "Nx realtime" figure. */
  xRealtime: number | null;
  chaptersPerHour: number | null;
  last: {
    chapterId: number | string;
    rtf: number;
    audioSec: number;
    synthSec: number;
    at: string;
  } | null;
  updatedAt: string | null;
  /** Aggregate rtf over the recent-batch window — the LIVE figure that moves
      mid-chapter (< 1 = faster than realtime). null when no batch is recent. */
  liveBatchRtf: number | null;
  /** The single most-recent batch's rtf. */
  lastBatchRtf: number | null;
  batchesInWindow: number;
  batchUpdatedAt: string | null;
  /** Recent finished chapters, NEWEST-FIRST, capped server-side. Survives the
      rolling-window idle reset — backs the dev Worktrees throughput table. */
  recentChapters: RecentChapter[];
}

export const api = USE_MOCKS ? mock : real;
export type Api = typeof api;
