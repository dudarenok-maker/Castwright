import type { components } from './api-types';

export type Character = components['schemas']['Character'] & {
  matchFactors?: components['schemas']['MatchFactor'][];
  /* Provenance stamped by GET /api/books/:bookId/series-cast onto every
     sibling character so the rebaseline modal knows which book a row came
     from (the open/anchor book's own rows carry neither field). Used by
     mergeSeriesCast for the notLinkedTo guard + the approve home-book. */
  sourceBookId?: string;
  sourceBookTitle?: string;
};
/* `phase` is a UI-only sub-state set from the `chapter_assembling`,
   `chapter_verifying`, and `chapter_recovering` SSE ticks. It lets the Generate
   view distinguish "synthesising sentences" from the short disk-write phase
   (`assembling`) between the last group and chapter_complete, the post-synthesis
   ASR content-QA pass (`verifying`, srv-31), and a mid-render sidecar
   recycle/respawn ride-out (`recovering`, Wave 3 C2) — so the bar doesn't appear
   stuck at 99 % and a healthy respawn doesn't read as a silent stall. Not part
   of the wire schema.

   `lufs` is a UI-only mirror of the chapter's EBU R128 sidecar payload
   (plan 71). Hydrated lazily from the book-state endpoint's per-chapter
   `chapterLufs` map and from the chapter-audio meta endpoint on per-row
   playback. Absent → no loudnorm pass has landed for this chapter (legacy
   / disabled / silent-source). `null` distinguishes "fetched but no data"
   from "not fetched yet". See plan 77 for the report-card consumer. */
export type Chapter = components['schemas']['Chapter'] & {
  phase?: 'assembling' | 'verifying' | 'recovering' | null;
  lufs?: components['schemas']['ChapterLoudness'] | null;
  /* fs-13 — accumulated SET (as a Redux-serialisable array) of manuscript
     sentence ids whose same-speaker group has COMPLETED during the live run.
     Unioned from each progress tick's `completedSentenceIds`; cleared when the
     chapter (re)starts. Lets the Generate view derive each character's EXACT
     done count under out-of-order completion (poolWidth > 1 + Qwen batching)
     instead of approximating from the chapter-wide `currentLine` count.
     UI-only / not persisted. Absent → fall back to the `currentLine`
     approximation (older server, or before the first completion tick). */
  completedSentenceIds?: number[];
};

/* Sentence follows the OpenAPI spec; the optional `confidence` is a UI-only
   field used by ManuscriptView to flag low-confidence speaker attributions. */
export type Sentence = components['schemas']['Sentence'] & {
  confidence?: number;
};
/* fs-25 — per-quote delivery emotion enum (source of truth: openapi → api-types). */
export type Emotion = components['schemas']['Emotion'];
export type Revision = components['schemas']['Revision'];
/* Plan 77 — EBU R128 loudness sidecar payload, surfaced on the
   ChapterAudio meta endpoint and in the book-state response's
   per-chapter `chapterLufs` map. Persisted disk shape lives at
   <bookDir>/audio/<slug>.lufs.json (plan 71). Field names are stable
   contract with the sidecar JSON. Consumers MUST gate drift
   comparisons on twoPass === true — single-pass values are nominal
   target values, not real post-filter measurements. */
export type ChapterLoudness = components['schemas']['ChapterLoudness'];
/* srv-27 — advisory post-synthesis audio QA verdict. */
export type ChapterQaVerdict = components['schemas']['ChapterQaVerdict'];
/* fs-20 — per-run resource telemetry record (admin trend panel). */
export type ResourceTelemetryRecord = components['schemas']['ResourceTelemetryRecord'];
export type DriftEvent = components['schemas']['DriftEvent'];
export type TimelineEntry = components['schemas']['TimelineEntry'];
export type MatchFactor = components['schemas']['MatchFactor'];
export type GenerationTick = components['schemas']['GenerationTick'];
export type ChapterAudio = components['schemas']['ChapterAudio'];
export type UploadResponse = components['schemas']['UploadResponse'];
export type AnalyseResponse = components['schemas']['AnalyseResponse'];
export type VoiceMatchResponse = components['schemas']['VoiceMatchResponse'];
export type RevisionsResponse = components['schemas']['RevisionsResponse'];
export type VoiceSample = components['schemas']['VoiceSample'];
export type VoiceSampleRequest = components['schemas']['VoiceSampleRequest'];
export type TtsModelKey = NonNullable<VoiceSampleRequest['modelKey']>;

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
/* srv-2 — per-book state.json auto-backup preferences. Declared as an
   intersection on top of the generated schema so the three optional fields
   are available to the slice + Account view even before `openapi:types`
   regenerates `api-types.ts`. Mirrors the server's userSettingsSchema. */
export type BackupCadence = 'daily' | 'weekly';
export type UserSettings = components['schemas']['UserSettings'] & {
  backupEnabled?: boolean;
  backupCadence?: BackupCadence;
  backupRetention?: number;
};
export type UserSettingsPatch = components['schemas']['UserSettingsPatch'] & {
  backupEnabled?: boolean;
  backupCadence?: BackupCadence;
  backupRetention?: number;
};

/* srv-2 — one auto-backup snapshot of a book's state.json, newest first.
   Mirrors server/src/routes/backup.ts BackupSnapshot. */
export interface BackupSnapshot {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

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
  /** fs-2 — BCP-47 book language ('en' default). Drives the library language
      badge + filter pill. Always present on the wire (server pads to 'en'). */
  language?: string;
}

/* ── Import + confirm-metadata flow ───────────────────────────────────── */

export interface ImportCandidate {
  tempId: string;
  format: UploadResponse['format'];
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  /* Bug B: true when series came from a title-parenthetical heuristic
     rather than authoritative metadata. Drives the "auto-extracted from
     title — verify" chip on the confirm screen. Optional because older
     server builds (pre-Bug-B) don't emit it. */
  seriesFromTitle?: boolean;
  sourceText: string;
  wordCount: number;
  byteSize: number;
  /* fs-2 — BCP-47 language auto-detected from the manuscript text (Cyrillic
     ratio). Seeds the confirm-view language selector; user-overridable.
     Optional because detection runs client-side and older flows omit it. */
  language?: string;
  /* Per-chapter wordCount is what powers the confirm view's auto-suggest
     heuristic (front-matter detection by length). Optional because older
     server builds didn't expose it. */
  chapters: Array<{ id: number; title: string; wordCount?: number }>;
}

export interface ImportResponse {
  tempId: string;
  candidate: Omit<ImportCandidate, 'tempId'>;
}

/* fs-1 — GET /api/info: version + schema + what's-new state. */
export interface AppInfo {
  appVersion: string;
  sidecarVersion: string | null;
  schemas: Record<string, number>;
  lastSeenAppVersion: string | null;
  showWhatsNew: boolean;
  releaseNotes: string;
  /* fs-43 — host hardware for the "Will it run on my machine?" panel
     (server-sourced; optional, absent on an older server). */
  hardware?: {
    platform: string;
    arch: string;
    appleSilicon: boolean;
    label: string;
  };
  /* side-14 — per-engine device ground-truth from the sidecar (null while the
     sidecar's startup probe is pending or the sidecar is down) + the engine
     the server resolves as the current default. Optional: absent on an older
     server. */
  devices?: {
    kokoro: 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | null;
    coqui: 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | null;
    qwen: 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | null;
  } | null;
  devicesState?: 'pending' | 'ready' | 'error' | null;
  activeEngine?: string;
}

/* Result of the "is a newer release available?" check for the Account →
   Application updates card. FAIL-OPEN: `reachable: false` means the release
   source couldn't be reached (private repo / offline / rate-limited) — the
   card then shows only the running version, never an error. */
export interface UpdateStatus {
  reachable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  url: string | null;
}

/* Interim companion-app distribution — availability of the packaged Android
   APK served by GET /api/companion/apk. The Listen-tab banner probes this
   (HEAD) and shows a "Download .apk" button only when `available`. */
export interface CompanionApkAvailability {
  available: boolean;
  sizeBytes: number | null;
}

/* fs-1 — POST /api/upgrade/stage result. */
export interface UpgradeStageResult {
  candidateVersion: string;
  runningVersion: string;
  reqHash: string | null;
  requiresPipInstall: boolean;
  isDowngrade: boolean;
}

export type UpgradePhase = 'idle' | 'staged' | 'applying' | 'restarting' | 'error';

/* fs-1 — GET /api/upgrade/state. */
export interface UpgradeStatePayload {
  phase: UpgradePhase;
  candidateVersion?: string;
  error?: string;
  busy: boolean;
  busyReason?: { generationBooks: string[]; analysisManuscripts: string[] };
}

export interface ConfirmBookRequest {
  tempId: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  title: string;
  isStandalone: boolean;
  /* fs-2 — BCP-47 manuscript language chosen at confirm (auto-detected,
     user-overridable). Persisted to BookStateJson.language. Defaults 'en'. */
  language?: string;
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
    /** "Not queued" hold — the user removed this un-rendered chapter from the
        generation queue. Mirror of the server's BookStateJson type
        (`server/src/workspace/scan.ts`). Re-hydrated so the row keeps reading
        "Not queued" and the auto-work resume leaves it alone across a reload. */
    held?: boolean;
    /** TTS model key that produced this chapter's existing audio.
        Stamped at render time and lazy-backfilled from the segments
        file for legacy chapters. Mirror of the server's BookStateJson
        type (`server/src/workspace/scan.ts`). Drives the engine-drift
        badge per plan 35. */
    audioModelKey?: TtsModelKey;
    /** Distinct speaking characters per TTS engine they rendered in
        (per-character routing, plan 108). One key on a uniform chapter;
        the full breakdown on a mixed-engine chapter, which the Generation
        view shows as a "Kokoro (1), Qwen (6)" caption. Mirror of the
        server's BookStateJson type. */
    audioEngines?: Partial<Record<TtsEngine, number>>;
    /** ISO timestamp when the audio was synthesised; mirrors the
        segments file's `synthesizedAt`. */
    audioRenderedAt?: string;
    /** Durable record of the last synthesis FAILURE (mirror of the server's
        BookStateJson type). Only `'failed'` is persisted — "done" comes from
        `completedSlugs` (audio on disk) and "queued" is the absence of both.
        Lets a failed chapter re-hydrate as "Failed · reason" instead of the
        misleading "Queued" after a reload / queue-clear. */
    generationState?: 'failed';
    /** Human-readable reason behind `generationState: 'failed'`; surfaced on
        the chapter row's failed-state error box + Retry control. */
    generationError?: string;
    /** fs-19 — stable machine code for the failure class (drives the failed-row
        remediation rendering). Mirror of the server's BookStateJson type. */
    generationErrorCode?: string;
    /** fs-19 — concrete "what to do about it" copy for the failure. Mirror of
        the server's BookStateJson type. */
    generationRemediation?: string;
    /** srv-27 — advisory post-synthesis QA verdict for this chapter's audio.
        Mirror of the server's BookStateJson type; drives the "Suspect" badge. */
    audioQa?: ChapterQaVerdict;
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
  /** Long-form "about this audiobook" copy. Surfaced in the listen-view
      metadata editor and piped into the M4B `desc` / `ldes` atoms during
      Voice export (plan 33). */
  description?: string | null;
  /** Per-book editorial notes — source attribution, license, narration
      intent, in-progress thoughts. Workspace-internal (never exported).
      Plain text with markdown line breaks preserved verbatim. See plan 67. */
  notes?: string | null;
  /** Plan 73 — user-editable free-form tags. Optional on disk so books
      written before the field landed continue to load; the server scan
      pads with `[]` so the wire (`LibraryBook.tags`) always carries an
      array. */
  tags?: string[];
  /** fs-2 — BCP-47 book language ('en' default). Mirrors the server's
      BookStateJson; drives the Listen language badge + cast-view Qwen lock
      for non-English books. */
  language?: string;
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
  /** Plan 77 — per-chapter EBU R128 loudness sidecar payloads keyed
      by chapter id. Read once at book-open so the LUFS report card on
      the Listen view doesn't have to fan out one chapter-audio meta
      fetch per row. Null entry = sidecar missing (legacy chapter /
      `AUDIO_LOUDNORM_ENABLED=false` / silent-source fallthrough). The
      map is empty `{}` when no audio has been generated yet. */
  chapterLufs?: Record<number, ChapterLoudness | null>;
  /** chapterId → analysed speaker ids. Derived from the analysis cache and
      used by hydrateFromBookState so each chapter row seeds only the
      characters that actually speak in that chapter; without this the
      reducer falls back to all-cast and the Generate view's pill list
      flickers from filtered to everyone on hydrate. */
  chapterCharacters?: Record<number, string[]>;
  /** fe-16 — characterId → engine the character ACTUALLY rendered in when it
      differs from its configured engine (`'kokoro'` when a Qwen character fell
      back across any rendered chapter). Threaded into `resolveVoiceStatus` so
      the cast Status pill reads "Fallback (Kokoro)". Empty / undefined when no
      audio has rendered or nothing fell back. */
  renderedFallbackByCharacter?: Record<string, string>;
  /** #650 — render-time sentence→speaker map per rendered chapter
      (`{ [chapterId]: { [sentenceId]: characterId } }`), recovered from each
      chapter's `<slug>.segments.json`. The Generate view diffs it against the
      live manuscript to flag a `done` chapter whose sentences were reassigned
      after it rendered — precise (no reassign-then-undo false positive) and
      immediate. Absent for legacy/unrendered chapters; the view falls back to
      the time-based change-log heuristic when a chapter has no entry. */
  renderedSpeakersByChapter?: Record<number, Record<number, string>>;
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
  analysis?: { failedChapterIds: number[]; failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }> };
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
   applied). See docs/features/archive/32-sticky-analysis.md "Cold-boot
   rehydration". */
/** Wire shape for `GET /api/library/active-analyses` — every book in the
    workspace whose `.audiobook/analysis-state.json` snapshot resolves to
    `paused` or `halted`, sorted by `writtenAt` DESC (freshest first).
    The library layout's cold-boot effect picks the first entry to seed
    the top-bar AnalysisPill so the pill appears immediately on a
    refresh — without the user having to navigate to a specific book's
    analysing route first. The full list is available so a follow-up
    can render per-card "Paused — resume?" badges.

    Disk `running` is coerced to wire `paused` server-side (no live
    in-flight job means the analyzer didn't survive the restart), so the
    `state` field never contains `'running'` over the wire from this
    endpoint. */
export interface ActiveAnalysisSummary {
  bookId: string;
  bookTitle: string;
  manuscriptId: string;
  phaseId: number;
  phaseLabel: string;
  phaseProgress: number;
  state: 'paused' | 'halted';
  engine?: 'local' | 'gemini';
  kind?: 'main' | 'subset';
  subsetChapterIds?: number[];
  haltCode?: string;
  haltReason?: string;
  lastTickAt: number;
  writtenAt: number;
}

export interface ActiveAnalysesResponse {
  snapshots: ActiveAnalysisSummary[];
}

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
  /** Distinct voice ids (`voiceId ?? id`) behind `voiceCount`. The library
      view unions these across books for a library-wide DISTINCT-voices total
      — summing `voiceCount` would count a series-reused voice once per book.
      Optional only so pre-`voiceIds` fixtures/cached payloads still type;
      the server always emits it (defaults to `[]`). */
  voiceIds?: string[];
  matchedFromLibrary?: number;
  progress?: number;
  runtime?: string;
  lastWorkedOn: string;
  coverGradient: [string, string];
  /** Server-relative URL for the cached cover image when one is on
      disk. Undefined when no cover has been fetched/picked — the card
      and Listen header fall back to `coverGradient`. */
  coverImageUrl?: string;
  /** Plan 40 — pan + zoom applied to coverImageUrl at render time.
      Absent → bare object-cover. */
  coverFraming?: components['schemas']['CoverFraming'];
  pinned?: boolean;
  /** Plan 73 — user-editable per-book tags. Always an array on the
      wire (server defaults to `[]` for books whose state.json predates
      the field), so the library view's tag-chip filter row can union
      across books without guarding on undefined. */
  tags: string[];
  /** fs-2 — BCP-47 book language. Present on the wire (server pads to 'en'),
      but typed optional so the ~20 test fixtures + mock factories that build a
      LibraryBook don't all need updating; consumers default to 'en'. */
  language?: string;
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
  | 'regenerate'
  | 'voice_tune'
  | 'voice_reuse'
  | 'voice_lock'
  | 'boundary_move'
  | 'chapter_complete'
  | 'generation_run_complete'
  | 'chapter_failed'
  | 'generation_started'
  | 'cast_confirm'
  | 'name_change'
  | 'analysis_complete'
  | 'import'
  | 'library_add'
  | 'reparse';

/* fs-15/fs-16 — listening stats + continue-listening shapes. Source of truth:
   openapi.yaml components.schemas.LibraryStats / ContinueListeningItem. */
export type LibraryStats = components['schemas']['LibraryStats'];
export type ContinueListeningItem = components['schemas']['ContinueListeningItem'];

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
  /* Plan 82 — re-fire context carried from the wire `BookExportJob`. The
     Retry button on a `failed` row reads these to re-POST the original
     export request via the exports-middleware `retryExport` thunk; the
     Download button on a `done` row reads `bookId` + `exportId` to build
     the `/api/books/{bookId}/exports/{exportId}/download` URL when `url`
     is absent. Optional only for the fixture-based mock fallback rows in
     `src/data/export-queue.ts` — every live `bookExportJobToQueueItem`
     row carries them. */
  bookId?: string;
  exportId?: string;
  wireFormat?: 'mp3-zip' | 'm4b' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip';
  wireDestination?: 'download' | 'sync-folder';
  syncPath?: string;
}

/* Audiobook export job + request schemas, sourced from the OpenAPI spec.
   The export modal polls `BookExportJob` until status === 'done' and
   then triggers a download via `downloadUrl`. */
export type BookExportRequest = components['schemas']['BookExportRequest'];
export type BookExportJob = components['schemas']['BookExportJob'];
export type ExportLanInfo = components['schemas']['ExportLanInfo'];
/* Plan 67 — shareable streaming-link payload returned by
   POST /api/books/{bookId}/share. The frontend opens a copy-to-clipboard
   modal with this URL. */
export type BookShareLink = components['schemas']['BookShareLink'];

/* ── Advanced config knob types ──────────────────────────────────────── */

/** One configurable knob as described by the server. */
export interface KnobDescriptor {
  key: string;
  group: string;
  label: string;
  help: string;
  type: 'number' | 'integer' | 'boolean' | 'string' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** When the knob takes effect: immediately, on sidecar restart, or on server restart. */
  apply: 'live' | 'restart-sidecar' | 'restart-server';
  risk: 'low' | 'medium' | 'high';
  /** True when this knob is a prompt template (backed by /api/config/prompts/:key). */
  isPrompt: boolean;
  default: number | boolean | string;
}

/** A named group of knobs exposed by the server. */
export interface ConfigGroup {
  id: string;
  label: string;
  help: string;
  risk: 'low' | 'medium' | 'high';
  collapsedByDefault: boolean;
}

/** Per-knob runtime value as returned by GET /api/config. */
export interface KnobValue {
  key: string;
  effective: number | boolean | string;
  /** Where the effective value came from. */
  source: 'default' | 'env' | 'override';
  /** True when the server has locked this knob (env-pinned, not user-editable). */
  locked: boolean;
  /** True when the user has an active override for this knob. */
  overridden: boolean;
}

/** Map of key → KnobValue returned by the config endpoints. */
export type ConfigValues = Record<string, KnobValue>;

/** Full response from GET /api/config. */
export interface ConfigResponse {
  groups: ConfigGroup[];
  descriptors: KnobDescriptor[];
  values: ConfigValues;
  restartPending: boolean;
}

/** Prompt state from GET/PUT /api/config/prompts/:id. */
export interface PromptState {
  id: string;
  text: string;
  isForked: boolean;
  defaultText: string;
}

/** Result of POST /api/pair/session — the companion pairing QR payload + the
    fields the modal also shows for manual entry. */
export interface PairSessionInfo {
  qrPayload: string;
  hostPort: string;
  port: number;
  code: string;
  fpTag: string;
  expiresAt: number;
}

/* ── UI stage discriminated union ─────────────────────────────────────── */

export type View =
  | 'manuscript'
  | 'cast'
  | 'library'
  | 'generate'
  | 'listen'
  | 'log'
  | 'restructure';

export type Stage =
  | { kind: 'books' }
  | { kind: 'upload' }
  | { kind: 'analysing'; bookId?: string; manuscriptId?: string | null }
  | { kind: 'confirm'; bookId: string; openProfileId: string | null }
  | {
      kind: 'ready';
      bookId: string;
      view: View;
      currentChapterId: number;
      openProfileId: string | null;
    }
  | { kind: 'voices' }
  | { kind: 'changelog' }
  | { kind: 'account' }
  /* fs-18 — all-users Admin watch console (was the dev-only Worktrees
     dashboard, plan 86). Health board + generation throughput are visible to
     everyone; the git-worktree list inside the view stays gated behind
     `import.meta.env.DEV` (and its `/api/worktrees` server route 404s in prod). */
  | { kind: 'admin' }
  /* fs-23 — In-app Model Manager. Top-level view (like account/admin), reached
     from the Admin view. Consolidates all model install/inventory/residency
     controls that used to live in the Account view. */
  | { kind: 'model-manager' }
  /* fs-21 — first-run setup wizard, reached on the boot gate or from Account. */
  | { kind: 'setup' }
  /* Wave 3 — /about brand page, reached from the Admin view. */
  | { kind: 'about' }
  /* Advanced configuration — tune model, generation, and QA knobs. Reached
     from the Admin view and Account view. */
  | { kind: 'advanced' }
  /* fe-37 — in-app multi-version release-notes history, reached from /about and
     Account → Application updates. */
  | { kind: 'release-notes' }
  /* fe-29 — offline Help / troubleshooting view. focusCode is an untrusted
     string round-tripped from the URL hash; the view validates it. */
  | { kind: 'help'; focusCode?: string }
  /* fs-16 — listening-stats dashboard. */
  | { kind: 'stats' };
