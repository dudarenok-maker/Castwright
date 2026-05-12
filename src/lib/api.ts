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

function inferFormat(fileName?: string): 'markdown' | 'plaintext' | 'epub' | 'pdf' | null {
  if (!fileName) return null;
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const map: Record<string, 'markdown' | 'plaintext' | 'epub' | 'pdf'> = {
    md: 'markdown', markdown: 'markdown', txt: 'plaintext', text: 'plaintext',
    epub: 'epub', pdf: 'pdf',
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
  format?: 'markdown' | 'plaintext' | 'epub' | 'pdf';
}
export interface AnalyseOpts {
  onPhase?: (e: { phaseId: number; progress: number }) => void;
  /** Narrative log lines streamed from the server. Surface them in the
      active phase so the user sees real progress (e.g. detected characters,
      sentence counts) instead of canned snippets. */
  onLog?: (e: { phaseId: number; message: string }) => void;
  /** Override the server's default analysis model (e.g. 'gemini-3-flash-preview').
      Sent as JSON body to POST /api/manuscripts/:id/analysis. Ignored when
      the server runs in ANALYZER=manual mode. */
  model?: string;
}
export interface MatchArgs { bookId: string; characters: Character[]; }
export interface StreamArgs {
  bookId: string;
  getChapters: () => Array<{ id: number; state: string; progress?: number; totalLines?: number }>;
  onTick: (ev: GenerationTick & { type: GenerationTick['type'] }) => void;
}
export interface AudioArgs { bookId: string; chapterId: number; duration?: string; }
export interface PollArgs  { bookId: string; }

/* ── mock implementations ────────────────────────────────────────────── */

async function mockUploadManuscript({ text, file, fileName, format }: UploadArgs): Promise<UploadResponse> {
  await wait(350);
  const effectiveName = fileName ?? file?.name;
  const effectiveText = text ?? '';
  const h1 = effectiveText.match(/^#\s+(.+)$/m);
  const title = (h1 && h1[1].trim())
              || (effectiveName ? effectiveName.replace(/\.[^.]+$/, '') : 'Untitled manuscript');
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

/* ── real fetch-based implementations ────────────────────────────────── */

async function realUploadManuscript({ text, file, fileName, format }: UploadArgs): Promise<UploadResponse> {
  if (file) {
    const form = new FormData();
    form.append('file', file, fileName ?? file.name);
    if (format) form.append('format', format);
    const res = await fetch('/api/manuscripts', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  if (text !== undefined) {
    const res = await fetch('/api/manuscripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title: undefined, fileName }),
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  throw new Error('uploadManuscript requires either `text` or `file`.');
}

interface AnalysisStreamEvent {
  kind: 'phase' | 'result' | 'error' | 'log';
  phaseId?: number;
  progress?: number;
  label?: string;
  response?: AnalyseResponse;
  message?: string;
}

async function realAnalyseManuscript(manuscriptId: string, { onPhase, onLog, model }: AnalyseOpts = {}): Promise<AnalyseResponse> {
  const res = await fetch(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis`, {
    method: 'POST',
    headers: model ? { 'Content-Type': 'application/json' } : undefined,
    body: model ? JSON.stringify({ model }) : undefined,
  });
  if (!res.ok || !res.body) throw new Error(`Analysis stream failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AnalyseResponse | null = null;

  const handle = (payload: AnalysisStreamEvent) => {
    if (payload.kind === 'phase') {
      if (typeof payload.phaseId === 'number' && typeof payload.progress === 'number') {
        onPhase?.({ phaseId: payload.phaseId, progress: payload.progress });
      }
    } else if (payload.kind === 'log') {
      if (typeof payload.phaseId === 'number' && typeof payload.message === 'string') {
        onLog?.({ phaseId: payload.phaseId, message: payload.message });
      }
    } else if (payload.kind === 'result' && payload.response) {
      result = payload.response;
    } else if (payload.kind === 'error') {
      throw new Error(payload.message || 'Analysis failed.');
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
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6));
      if (!dataLines.length) continue;
      const payload = JSON.parse(dataLines.join('\n')) as AnalysisStreamEvent;
      handle(payload);
    }
  }

  if (!result) throw new Error('Analysis stream ended without a result event.');
  return result;
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

/* The remaining three endpoints (generation stream, chapter audio, revisions
   poll) are out of scope for this slice — keep them as the original
   not-wired throws so we surface attempts to use them. */
const real = {
  uploadManuscript:  realUploadManuscript,
  analyseManuscript: realAnalyseManuscript,
  matchVoices:       realMatchVoices,
  streamGeneration:  (_args: StreamArgs): (() => void) => {
    throw new Error('Generation stream not wired yet. Set VITE_USE_MOCKS=true.');
  },
  getChapterAudio:   async (_args: AudioArgs): Promise<ChapterAudio> => {
    throw new Error('Chapter audio not wired yet. Set VITE_USE_MOCKS=true.');
  },
  pollRevisions:     async (_args: PollArgs): Promise<RevisionsResponse> => {
    throw new Error('Revisions poll not wired yet. Set VITE_USE_MOCKS=true.');
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
