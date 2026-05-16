import type { components } from './api-types';

export type Character = components['schemas']['Character'] & {
  matchFactors?: components['schemas']['MatchFactor'][];
};
/* `phase` is a UI-only sub-state set from the `chapter_assembling` SSE tick.
   It lets the Generate view distinguish "synthesising sentences" from the
   short disk-write phase between the last group and chapter_complete, so
   the bar doesn't appear stuck at 99 %. Not part of the wire schema. */
export type Chapter = components['schemas']['Chapter'] & {
  phase?: 'assembling' | null;
};

/* Sentence follows the OpenAPI spec; the optional `confidence` is a UI-only
   field used by ManuscriptView to flag low-confidence speaker attributions. */
export type Sentence = components['schemas']['Sentence'] & {
  confidence?: number;
};
export type Revision  = components['schemas']['Revision'];
export type DriftEvent      = components['schemas']['DriftEvent'];
export type MatchFactor     = components['schemas']['MatchFactor'];
export type GenerationTick  = components['schemas']['GenerationTick'];
export type ChapterAudio    = components['schemas']['ChapterAudio'];
export type UploadResponse  = components['schemas']['UploadResponse'];
export type AnalyseResponse = components['schemas']['AnalyseResponse'];
export type VoiceMatchResponse = components['schemas']['VoiceMatchResponse'];
export type RevisionsResponse  = components['schemas']['RevisionsResponse'];
export type VoiceSample        = components['schemas']['VoiceSample'];
export type VoiceSampleRequest = components['schemas']['VoiceSampleRequest'];
export type TtsModelKey        = NonNullable<VoiceSampleRequest['modelKey']>;

/* ── App-domain types not modelled in the OpenAPI spec ────────────────── */

/* Named palette keys live in src/lib/colors.ts (CHAR_COLORS). Widened to
   string because the analysis backend emits 30 procedural slot names
   (`slot-4`..`slot-30`) — see colors.ts CHARACTER_SLOTS and the server's
   assignPaletteColors in server/src/routes/analysis.ts. */
export type CharColor = string;

/* The OpenAPI generator widens `gradient` to `string[]`, but our render code
   relies on the tuple shape `[string, string]`. Override that one field so
   the type matches reality. */
export type Voice = Omit<components['schemas']['Voice'], 'gradient'> & {
  gradient: [string, string];
};
export type VoiceLibraryResponse = { voices: Voice[] };

/* Base-voice catalog — the unmodified speakers each TTS engine exposes.
   Used by the Voices view's "Base voices" tab and the Profile Drawer's
   override picker. The (engine, name) pair is the stable identity; the
   server uses it to route a raw audition or to apply a per-cast override
   to chapter synthesis (see `pickVoiceForEngine`). */
export type BaseVoice = components['schemas']['BaseVoice'];
export type BaseVoiceCatalog = components['schemas']['BaseVoiceCatalog'];
export type TtsEngine = NonNullable<BaseVoice['engine']>;

/* User-level account defaults + non-secret server overrides. Mirrors the
   /api/user/settings response. Read-only fields (apiKeyStatus, workspaceRoot,
   workspaceSource) come from the server's env layer and can't be edited
   through the PUT endpoint. */
export type UserSettings = components['schemas']['UserSettings'];
export type UserSettingsPatch = components['schemas']['UserSettingsPatch'];

export interface Book {
  id: string;
  title: string;
  author: string;
  series: string;
  status: 'generating' | 'complete' | 'cast_pending' | 'analysing';
  progress?: number;
  chapterCount: number | null;
  completedChapters?: number;
  characterCount: number | null;
  voiceCount: number | null;
  matchedFromLibrary?: number;
  runtime?: string;
  lastWorkedOn: string;
  coverGradient: [string, string];
  pinned?: boolean;
}

/* ── Import + confirm-metadata flow ───────────────────────────────────── */

export interface ImportCandidate {
  tempId: string;
  format: UploadResponse['format'];
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  sourceText: string;
  wordCount: number;
  byteSize: number;
  /* Per-chapter wordCount is what powers the confirm view's auto-suggest
     heuristic (front-matter detection by length). Optional because older
     server builds didn't expose it. */
  chapters: Array<{ id: number; title: string; wordCount?: number }>;
}

export interface ImportResponse {
  tempId: string;
  candidate: Omit<ImportCandidate, 'tempId'>;
}

export interface ConfirmBookRequest {
  tempId: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  title: string;
  isStandalone: boolean;
  /* Slugs (server-derived `${id-pad}-${slug(title)}`) for chapters the
     user pre-excluded from analysis at the confirm stage. The server
     re-derives the same slug from its parsed chapter list and matches. */
  excludedSlugs?: string[];
}

export interface ConfirmBookResponse extends UploadResponse {
  bookId: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  paths: { bookDir: string; manuscript: string; dotAudiobook: string };
}

/* ── Book state (re-hydration on open) ────────────────────────────────── */

export interface BookStateJson {
  bookId: string;
  manuscriptId: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  manuscriptFile: string;
  castConfirmed: boolean;
  chapters: Array<{
    id: number;
    title: string;
    slug: string;
    duration?: string;
    excluded?: boolean;
    /** TTS model key that produced this chapter's existing audio.
        Stamped at render time and lazy-backfilled from the segments
        file for legacy chapters. Mirror of the server's BookStateJson
        type (`server/src/workspace/scan.ts`). Drives the engine-drift
        badge per plan 35. */
    audioModelKey?: TtsModelKey;
    /** ISO timestamp when the audio was synthesised; mirrors the
        segments file's `synthesizedAt`. */
    audioRenderedAt?: string;
  }>;
  coverGradient: [string, string];
  createdAt: string;
  updatedAt: string;
  /* Editable book-level audiobook metadata exposed in the Listen view's
     metadata editor. All optional so state.json files written before the
     Listen-meta wiring landed continue to load — the slice falls back to
     library/cast defaults when these are missing. */
  narratorCredit?: string | null;
  genre?: string | null;
  /** ISO 'YYYY-MM-DD' (no time component — pure calendar date). */
  publicationDate?: string | null;
}

export interface BookStateResponse {
  state: BookStateJson;
  cast: { characters: Character[] } | null;
  /** Lightweight manuscript meta (wordCount, format) pulled from the
      in-memory ManuscriptRecord. Lets the Analysing screen show a size-aware
      ETA without loading the full sourceText. */
  manuscript: { wordCount: number; format: UploadResponse['format'] } | null;
  manuscriptEdits: { sentences?: Sentence[] } | null;
  revisions: {
    pending?: Revision[];
    drift?: DriftEvent[];
    dismissed?: string[];
    /** Per-revision A/B segment selections captured at accept time. Written
        by `revisionsActions.acceptRevision`; not yet consumed in-app
        (future per-segment TTS regen). */
    acceptedSelections?: Record<string, Record<number, 'A' | 'B'>>;
  } | null;
  /** Slugs of chapters that already have an audio file on disk. */
  completedSlugs: string[];
  /** chapterId → analysed speaker ids. Derived from the analysis cache and
      used by hydrateFromBookState so each chapter row seeds only the
      characters that actually speak in that chapter; without this the
      reducer falls back to all-cast and the Generate view's pill list
      flickers from filtered to everyone on hydrate. */
  chapterCharacters?: Record<number, string[]>;
  /** Editorial activity trail (regenerate confirms, etc.). Null when no
      change-log.json has been written yet — the layout falls back to an
      empty list so the Activity view doesn't replay a stale demo seed for
      a book that hasn't been touched. */
  changeLog: ChangeLogEvent[] | null;
  /** Persistent analysis state surfaced to the analysing view so it can
      render per-chapter Retry buttons after reload. failedChapterIds is
      the set of chapters whose Phase 0a cast detection threw across the
      analyzer's built-in retry — server-side they live in the analysis
      cache. */
  analysis?: { failedChapterIds: number[] };
}

/** Drop-reason enum mirrored from server/src/store/dropped-quotes.ts.
    Two logical branches collapse out of verifyEvidenceAgainstSource:
    - `not_in_source`: normalised quote isn't a substring of the source
      (the "stitched fabrication" path)
    - `empty_after_normalisation`: pure whitespace / punctuation / empty
      after normaliseForMatch */
export type DropReason = 'not_in_source' | 'empty_after_normalisation';

export interface DroppedQuoteEntry {
  characterId: string;
  characterName: string;
  /** Capped at 2000 chars server-side — see `truncated`. */
  quote: string;
  truncated: boolean;
  reason: DropReason;
  /** Verbatim copy of the model's optional `note` field on the
      original evidence entry. */
  note?: string;
}

export interface DroppedQuotesBatch {
  recordedAt: string;
  route: 'analysis-stream' | 'analysis-chapters';
  totalDropped: number;
  affectedCharacters: number;
  entries: DroppedQuoteEntry[];
}

export interface DroppedQuotesResponse {
  manuscriptId: string;
  batches: DroppedQuotesBatch[];
}

/* Cold-boot rehydration payload for the AnalysisPill across browser
   reload + server restart. Matches the on-disk
   .audiobook/analysis-state.json shape one-for-one (the server
   returns it verbatim once the running→paused coercion has been
   applied). See docs/features/32-sticky-analysis.md "Cold-boot
   rehydration". */
export interface AnalysisStateResponse {
  manuscriptId: string;
  phaseId: number;
  phaseLabel: string;
  phaseProgress: number;
  /** `running` never appears on the wire from the cold-boot endpoint
      UNLESS a live in-flight job is still serving from memory. The
      server coerces disk-`running` to `paused` when no live job is
      present. */
  state: 'running' | 'paused' | 'halted';
  /** Engine the analyzer was using when this snapshot was written.
      Carried so the reverse-direction local-analyzer guard
      (`src/hooks/use-reverse-local-analyzer-guard.tsx`) sees the
      right engine on a cold-boot rehydrated pill. Undefined for
      pre-E1 snapshots — guard defaults to "do not prompt". */
  engine?: 'local' | 'gemini';
  /** Discriminator for the in-flight job's shape (plan 32 D1).
      `'main'` = full-book sticky run; `'subset'` = per-chapter retry
      via POST /:id/analysis/chapters. Optional — pre-D1 snapshots
      omit it and the pill falls back to main semantics. */
  kind?: 'main' | 'subset';
  /** Set only when `kind === 'subset'`. The chapter ids being
      retried, used by the AnalysisPill to render "Retrying N
      chapters" copy. */
  subsetChapterIds?: number[];
  haltCode?: string;
  haltReason?: string;
  lastTickAt: number;
  writtenAt?: number;
}

export type StateSlice = 'cast' | 'manuscript' | 'revisions' | 'state' | 'changeLog';

export interface PutStateRequest {
  slice: StateSlice;
  patch: unknown;
}

/* ── Library (on-disk workspace) ──────────────────────────────────────── */
/* These shapes mirror GET /api/library. Source of truth is openapi.yaml
   under components.schemas.LibraryResponse; until openapi:types regenerates
   api-types.ts they are also declared here for type-checking. */

export type LibraryBookStatus =
  | 'not_analysed'
  | 'analysing'
  | 'cast_pending'
  | 'generating'
  | 'complete'
  | 'unreadable'
  | 'orphaned';

export interface LibraryBook {
  bookId: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  status: LibraryBookStatus;
  manuscriptId?: string;
  chapterCount: number;
  completedChapters: number;
  characterCount: number;
  voiceCount: number;
  matchedFromLibrary?: number;
  progress?: number;
  runtime?: string;
  lastWorkedOn: string;
  coverGradient: [string, string];
  /** Server-relative URL for the cached cover image when one is on
      disk. Undefined when no cover has been fetched/picked — the card
      and Listen header fall back to `coverGradient`. */
  coverImageUrl?: string;
  pinned?: boolean;
}

export type CoverCandidate = components['schemas']['CoverCandidate'];

export interface LibrarySeries {
  name: string;
  books: LibraryBook[];
}

export interface LibraryAuthor {
  name: string;
  series: LibrarySeries[];
}

export interface LibraryResponse {
  authors: LibraryAuthor[];
}

export type ChangeLogType =
  | 'regenerate' | 'voice_tune' | 'voice_reuse' | 'voice_lock'
  | 'boundary_move' | 'chapter_complete' | 'generation_run_complete'
  | 'chapter_failed' | 'generation_started'
  | 'cast_confirm' | 'analysis_complete' | 'import' | 'library_add' | 'reparse';

export interface ChangeLogEvent {
  id: number;
  /** ISO timestamp for events produced at runtime. The view formats this into
      a relative `ts` + bucketed `date` at render time, so persisted entries
      age correctly across reloads. Optional only because the demo fixture
      pre-fills the display fields without a real clock. */
  at?: string;
  ts: string;
  date: 'today' | 'yesterday' | 'earlier';
  type: ChangeLogType;
  title: string;
  note: string;
  actor: 'you' | 'system';
  chapterId?: number;
  revertible?: boolean;
  /** Populated only by GET /api/workspace/changelog so the workspace view can
      show which book each event came from. Per-book change-log.json files on
      disk don't carry these fields — the aggregator attaches them at fetch
      time from the book's state.json. */
  bookId?: string;
  bookTitle?: string;
  author?: string;
}

export interface WorkspaceChangeLogCategoryCounts {
  voice: number;
  generation: number;
  manuscript: number;
  cast: number;
}

export interface WorkspaceChangeLogResponse {
  events: ChangeLogEvent[];
  /** ISO timestamp of the last event in this page when more follow; `null`
      when this page is the tail. Pass it back as `before` to fetch the next
      page. */
  nextCursor: string | null;
  /** Total events across the workspace — not just this page. Drives the
      "All (N)" pill in the Activity view so it stays truthful while the
      user scrolls. */
  totalCount: number;
  /** Per-category totals across the FULL workspace set. Drives the
      Voice/Generation/Manuscript/Cast pills so they don't lie when only
      part of the log is loaded. */
  categoryCounts: WorkspaceChangeLogCategoryCounts;
}

export interface ListenerApp {
  id: string;
  name: string;
  glyph: string;
  gradient: [string, string];
  platforms: string[];
  tagline: string;
  description: string;
  sendVerb: string;
}

export interface WalkthroughStep {
  id: number;
  title: string;
  description: string;
  illustration: string;
  detail?: string;
  input?: { type: string; placeholder: string; value: string };
}

export interface RegenReason {
  id: string;
  label: string;
  description: string;
  custom?: boolean;
}

export interface AnalysisPhase {
  id: number;
  label: string;
  detail: string;
  duration: number;
}

export interface ExportQueueItem {
  id: string;
  filename: string;
  format: 'm4b' | 'm4a' | 'mp3' | 'zip' | 'link';
  size: string;
  status: 'done' | 'in_progress' | 'failed';
  timestamp: string;
  destination: string;
  progress?: number;
  url?: string;
  errorReason?: string;
}

/* Audiobook export job + request schemas, sourced from the OpenAPI spec.
   The export modal polls `BookExportJob` until status === 'done' and
   then triggers a download via `downloadUrl`. */
export type BookExportRequest = components['schemas']['BookExportRequest'];
export type BookExportJob     = components['schemas']['BookExportJob'];
export type ExportLanInfo     = components['schemas']['ExportLanInfo'];

/* ── UI stage discriminated union ─────────────────────────────────────── */

export type View = 'manuscript' | 'cast' | 'library' | 'generate' | 'listen' | 'log';

export type Stage =
  | { kind: 'books' }
  | { kind: 'upload' }
  | { kind: 'analysing'; bookId?: string; manuscriptId?: string | null }
  | { kind: 'confirm';   bookId: string; openProfileId: string | null }
  | { kind: 'ready';     bookId: string; view: View; currentChapterId: number; openProfileId: string | null }
  | { kind: 'voices' }
  | { kind: 'changelog' }
  | { kind: 'account' };
