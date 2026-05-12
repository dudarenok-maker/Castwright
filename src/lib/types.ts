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

/* ── App-domain types not modelled in the OpenAPI spec ────────────────── */

/* Named palette keys live in src/lib/colors.ts (CHAR_COLORS). Widened to
   string because the analysis backend emits 30 procedural slot names
   (`slot-4`..`slot-30`) — see colors.ts CHARACTER_SLOTS and the server's
   assignPaletteColors in server/src/routes/analysis.ts. */
export type CharColor = string;

export interface Voice {
  id: string;
  character: string;
  bookTitle: string;
  bookId: string;
  attributes: string[];
  gradient: [string, string];
  usedIn: number;
  source: 'current' | 'library';
  reusable?: boolean;
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
  | { kind: 'ready';     bookId: string; view: View; currentChapterId: number; openProfileId: string | null };
