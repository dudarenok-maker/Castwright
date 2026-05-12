import type { components } from './api-types';

export type Character = components['schemas']['Character'] & {
  matchFactors?: components['schemas']['MatchFactor'][];
};
export type Chapter   = components['schemas']['Chapter'];

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
  chapters: Array<{ id: number; title: string }>;
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
  chapters: Array<{ id: number; title: string; slug: string; duration?: string }>;
  coverGradient: [string, string];
  createdAt: string;
  updatedAt: string;
}

export interface BookStateResponse {
  state: BookStateJson;
  cast: { characters: Character[] } | null;
  /** Lightweight manuscript meta (wordCount, format) pulled from the
      in-memory ManuscriptRecord. Lets the Analysing screen show a size-aware
      ETA without loading the full sourceText. */
  manuscript: { wordCount: number; format: UploadResponse['format'] } | null;
  manuscriptEdits: { sentences?: Sentence[] } | null;
  revisions: { pending?: Revision[]; drift?: DriftEvent[] } | null;
  /** Slugs of chapters that already have an audio file on disk. */
  completedSlugs: string[];
}

export type StateSlice = 'cast' | 'manuscript' | 'revisions' | 'state';

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
  pinned?: boolean;
}

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
  | 'boundary_move' | 'chapter_complete' | 'generation_started'
  | 'cast_confirm' | 'analysis_complete' | 'import' | 'library_add';

export interface ChangeLogEvent {
  id: number;
  ts: string;
  date: 'today' | 'yesterday' | 'earlier';
  type: ChangeLogType;
  title: string;
  note: string;
  actor: 'you' | 'system';
  chapterId?: number;
  revertible?: boolean;
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

/* ── UI stage discriminated union ─────────────────────────────────────── */

export type View = 'manuscript' | 'cast' | 'library' | 'generate' | 'listen' | 'log';

export type Stage =
  | { kind: 'books' }
  | { kind: 'upload' }
  | { kind: 'analysing'; bookId?: string; manuscriptId?: string | null }
  | { kind: 'confirm';   bookId: string }
  | { kind: 'ready';     bookId: string; view: View; currentChapterId: number; openProfileId: string | null }
  | { kind: 'voices' }
  | { kind: 'changelog' };
