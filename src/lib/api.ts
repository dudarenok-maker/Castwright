/* API client surface. Real backend lives behind the same `api.*` shape;
   the components never know whether they're talking to fetch() or to
   the mocks below.

   Toggle with VITE_USE_MOCKS=true (.env.development). */

import type {
  UploadResponse, AnalyseResponse, VoiceMatchResponse,
  RevisionsResponse, ChapterAudio, GenerationTick, Character,
} from './types';
import { ANALYSIS_NORTHERN_STAR } from '../mocks/canned-data';
import { MATCH_FACTORS } from '../data/match-factors';
import { PENDING_REVISIONS } from '../data/revisions';
import { VOICE_DRIFT_EVENTS } from '../data/drift';
import { parseDuration } from './time';

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

/* ── shared helpers ──────────────────────────────────────────────────── */

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function inferFormat(fileName?: string): 'markdown' | 'plaintext' | 'epub' | 'docx' | null {
  if (!fileName) return null;
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const map: Record<string, 'markdown' | 'plaintext' | 'epub' | 'docx'> = {
    md: 'markdown', markdown: 'markdown', txt: 'plaintext', text: 'plaintext',
    epub: 'epub', docx: 'docx',
  };
  return map[m[1]] ?? null;
}

/* ── argument types ──────────────────────────────────────────────────── */

export interface UploadArgs { text: string; fileName?: string; format?: 'markdown' | 'plaintext' | 'epub' | 'docx'; }
export interface AnalyseOpts { onPhase?: (e: { phaseId: number; progress: number }) => void; }
export interface MatchArgs { bookId: string; characters: Character[]; }
export interface StreamArgs {
  bookId: string;
  getChapters: () => Array<{ id: number; state: string; progress?: number; totalLines?: number }>;
  onTick: (ev: GenerationTick & { type: GenerationTick['type'] }) => void;
}
export interface AudioArgs { bookId: string; chapterId: number; duration?: string; }
export interface PollArgs  { bookId: string; }

/* ── mock implementations ────────────────────────────────────────────── */

async function mockUploadManuscript({ text, fileName, format }: UploadArgs): Promise<UploadResponse> {
  await wait(350);
  const h1 = text.match(/^#\s+(.+)$/m);
  const title = (h1 && h1[1].trim())
              || (fileName ? fileName.replace(/\.[^.]+$/, '') : 'Untitled manuscript');
  return {
    manuscriptId: 'mns_' + Math.random().toString(36).slice(2, 10),
    format: format || inferFormat(fileName) || 'markdown',
    title,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    byteSize: new Blob([text]).size,
    uploadedAt: new Date().toISOString(),
    sourceText: text,
  };
}

async function mockAnalyseManuscript(manuscriptId: string, { onPhase }: AnalyseOpts = {}): Promise<AnalyseResponse> {
  const res = ANALYSIS_NORTHERN_STAR;
  for (const ph of res.phaseTimings) {
    const start = Date.now();
    await new Promise<void>(resolve => {
      const t = setInterval(() => {
        const progress = Math.min(1, (Date.now() - start) / ph.durationMs);
        onPhase?.({ phaseId: ph.id, progress });
        if (progress >= 1) { clearInterval(t); resolve(); }
      }, 60);
    });
  }
  return {
    bookId: res.bookId,
    manuscriptId,
    title: res.title,
    phaseTimings: res.phaseTimings.map(p => ({ id: p.id, label: p.label, duration: p.durationMs })),
    characters: res.characters,
    chapters: res.chapters,
    sentences: res.sentences,
    libraryMatches: res.libraryMatches,
  };
}

async function mockMatchVoices({ bookId, characters }: MatchArgs): Promise<VoiceMatchResponse> {
  await wait(450);
  const matches: VoiceMatchResponse['matches'] = (characters || []).map(c => {
    const factors = MATCH_FACTORS[c.id] || [];
    if (!c.matchedFrom || !factors.length || !c.voiceId) {
      return { characterId: c.id, candidates: [] };
    }
    return {
      characterId: c.id,
      candidates: [{
        voiceId: c.voiceId,
        fromBookTitle: c.matchedFrom.bookTitle ?? '',
        score: c.matchedFrom.confidence ?? 0,
        factors: factors.map(f => ({ id: f.id, label: f.label, score: f.score, detail: f.detail })),
      }],
    };
  });
  return { bookId, matches };
}

function mockStreamGeneration({ getChapters, onTick }: StreamArgs): () => void {
  const tick = () => {
    const chapters = getChapters();
    const active = chapters.find(c => c.state === 'in_progress');
    if (!active) { onTick({ type: 'idle' }); return; }
    const nextProgress = Math.min(1, (active.progress || 0) + 0.02);
    onTick({
      type: nextProgress >= 1 ? 'chapter_complete' : 'progress',
      chapterId: active.id,
      characterId: null,
      progress: nextProgress,
      currentLine: Math.round((active.totalLines || 600) * nextProgress),
      totalLines: active.totalLines || 600,
    });
  };
  const handle = setInterval(tick, 1200);
  return () => clearInterval(handle);
}

async function mockGetChapterAudio({ duration }: AudioArgs): Promise<ChapterAudio> {
  await wait(120);
  const totalSec = parseDuration(duration || '10:00');
  const peakCount = 240;
  const peaks = Array.from({ length: peakCount }, (_, i) => {
    const base = 0.35 + 0.45 * Math.sin((i / peakCount) * Math.PI);
    return Math.max(0.05, Math.min(1, base + (Math.random() - 0.5) * 0.35));
  });
  return {
    url: null,
    durationSec: totalSec,
    peaks,
    sampleRate: 44100,
    segments: [],
  };
}

async function mockPollRevisions(_args: PollArgs): Promise<RevisionsResponse> {
  await wait(200);
  return {
    pending: PENDING_REVISIONS,
    drift:   VOICE_DRIFT_EVENTS,
  };
}

/* ── real fetch-based implementations (placeholders) ─────────────────── */

const real = {
  uploadManuscript: async (_args: UploadArgs): Promise<UploadResponse> => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
  analyseManuscript: async (_id: string, _opts?: AnalyseOpts): Promise<AnalyseResponse> => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
  matchVoices: async (_args: MatchArgs): Promise<VoiceMatchResponse> => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
  streamGeneration: (_args: StreamArgs): (() => void) => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
  getChapterAudio: async (_args: AudioArgs): Promise<ChapterAudio> => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
  pollRevisions: async (_args: PollArgs): Promise<RevisionsResponse> => {
    throw new Error('Real API not wired yet. Set VITE_USE_MOCKS=true.');
  },
};

const mock = {
  uploadManuscript:  mockUploadManuscript,
  analyseManuscript: mockAnalyseManuscript,
  matchVoices:       mockMatchVoices,
  streamGeneration:  mockStreamGeneration,
  getChapterAudio:   mockGetChapterAudio,
  pollRevisions:     mockPollRevisions,
};

export const api = USE_MOCKS ? mock : real;
export type Api = typeof api;
