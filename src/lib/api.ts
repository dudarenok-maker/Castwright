/* API client surface. Real backend lives behind the same `api.*` shape;
   the components never know whether they're talking to fetch() or to
   the mocks below.

   Toggle with VITE_USE_MOCKS=true (.env.development). */

import type {
  UploadResponse, AnalyseResponse, VoiceMatchResponse,
  RevisionsResponse, ChapterAudio, GenerationTick, Character,
  Voice, VoiceSample, TtsModelKey, LibraryResponse, VoiceLibraryResponse,
  ImportResponse, ConfirmBookRequest, ConfirmBookResponse,
  BookStateResponse, PutStateRequest,
} from './types';
import { ANALYSIS_NORTHERN_STAR } from '../mocks/canned-data';
import { MOCK_LIBRARY } from '../mocks/library';
import { MOCK_VOICE_LIBRARY } from '../mocks/voices';
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
export interface AnalyseOpts {
  onPhase?: (e: { phaseId: number; progress: number; live?: AnalysisLiveInfo }) => void;
  /** Narrative log lines streamed from the server. Surface them in the
      active phase so the user sees real progress (e.g. detected characters,
      sentence counts) instead of canned snippets. */
  onLog?: (e: { phaseId: number; message: string }) => void;
  /** Override the server's default analysis model (e.g. 'gemini-3-flash-preview').
      Sent as JSON body to POST /api/manuscripts/:id/analysis. Ignored when
      the server runs in ANALYZER=manual mode. */
  model?: string;
  /** Discard any cached partial progress for this manuscript before running.
      The "Start fresh" button in the analysing view sets this. */
  fresh?: boolean;
}
export interface MatchArgs { bookId: string; characters: Character[]; }
export interface StreamArgs {
  bookId: string;
  modelKey: TtsModelKey;
  /** Optional chapter subset; defaults to all chapters lacking audio on disk. */
  chapterIds?: number[];
  /** Re-synthesise even if a chapter's WAV already exists. */
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
  }>;
  onTick: (ev: GenerationTick & { type: GenerationTick['type'] }) => void;
}
export interface AudioArgs { bookId: string; chapterId: number; duration?: string; }
export interface PollArgs  { bookId: string; }
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

/* ── mock implementations ────────────────────────────────────────────── */

async function mockGetLibrary(): Promise<LibraryResponse> {
  await wait(120);
  return MOCK_LIBRARY;
}

async function mockGetVoices(_args?: { currentBookId?: string }): Promise<VoiceLibraryResponse> {
  await wait(80);
  return MOCK_VOICE_LIBRARY;
}

async function mockSetVoicePin(_voiceId: string, _pinned: boolean): Promise<void> {
  await wait(20);
}

async function mockImportManuscript({ text, file, fileName }: UploadArgs): Promise<ImportResponse> {
  await wait(250);
  const effectiveName = fileName ?? file?.name ?? null;
  const effectiveText = text ?? '';
  const h1 = effectiveText.match(/^#\s+(.+)$/m);
  const stem = effectiveName?.replace(/\.[^.]+$/, '') ?? '';
  const m = /^(?<author>.+?)\s+-\s+(?<series>.+?)\s+(?<pos>\d+)\s+-\s+(?<title>.+)$/.exec(stem);
  const candidate = {
    format: (inferFormat(effectiveName ?? undefined) ?? 'markdown') as UploadResponse['format'],
    title: (h1 && h1[1].trim()) || m?.groups?.title || stem || 'Untitled manuscript',
    author: m?.groups?.author ?? null,
    series: m?.groups?.series ?? null,
    seriesPosition: m?.groups?.pos ? parseInt(m.groups.pos, 10) : null,
    sourceText: effectiveText,
    wordCount: effectiveText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: file ? file.size : new Blob([effectiveText]).size,
    chapters: [{ id: 1, title: 'Chapter 1' }],
  };
  return { tempId: 'imp_' + Math.random().toString(36).slice(2, 10), candidate };
}

async function mockGetBookState(_bookId: string): Promise<BookStateResponse> {
  // Mocks don't have a disk-backed workspace; return null to signal "no
  // persistent state yet" so the UI falls back to its in-memory defaults.
  await wait(60);
  throw new Error('Book state hydration is not available in mock mode (no disk workspace).');
}

async function mockPutBookState(_bookId: string, _req: PutStateRequest): Promise<void> {
  await wait(20);
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
  /* Mock the real server's "one progress tick per same-speaker group" cadence
     well enough that the Generate view's line / character counters tick
     visibly. Two behaviours that matter:

     1. Auto-promote: when the active chapter completes, advance the next
        queued chapter into in_progress on the next tick — the real server
        does this implicitly by emitting a `progress` tick for chapter N+1
        right after chapter N's complete. Without this, the mock just
        emits `idle` forever once chapter 1 is done, the heartbeat goes
        cold, and the stall banner pops up while the queue still has work.
     2. Cycle characters: rotate the active character every few ticks so
        the per-character `in_progress` pill actually moves through the
        cast, the active-speaker caption updates, and the user gets a
        steady "something is happening" signal even before chapter %
        ticks visibly. */
  const tick = () => {
    const chapters = getChapters?.() ?? [];
    let active = chapters.find(c => c.state === 'in_progress');
    if (!active) {
      const nextUp = chapters.find(c => c.state === 'queued');
      if (!nextUp) { onTick({ type: 'idle' }); return; }
      /* Bootstrap the next chapter with a tiny non-zero progress so the
         live `chapter.state` flips to in_progress on the slice and our
         next tick finds it. */
      onTick({
        type: 'progress',
        chapterId: nextUp.id,
        characterId: null,
        progress: 0.01,
        currentLine: 0,
        totalLines: nextUp.totalLines || 600,
      });
      return;
    }
    const totalLines = active.totalLines || 600;
    const nextProgress = Math.min(1, (active.progress || 0) + 0.02);
    const currentLine = Math.round(totalLines * nextProgress);
    /* Pick a non-skipped character to surface as the live speaker, cycling
       proportionally with progress so the per-character pill walks through
       the cast in roughly the order they appear. */
    const cast = Object.keys(active.characters).filter(k => active.characters[k] !== 'skipped');
    const characterId = cast.length > 0
      ? cast[Math.min(cast.length - 1, Math.floor(nextProgress * cast.length))]
      : null;
    onTick({
      type: nextProgress >= 1 ? 'chapter_complete' : 'progress',
      chapterId: active.id,
      characterId,
      progress: nextProgress,
      currentLine,
      totalLines,
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

async function mockGetVoiceSample({ modelKey }: VoiceSampleArgs): Promise<VoiceSample> {
  await wait(200);
  /* No real audio in mock mode — frontend treats a null url as a
     "samples need a live server" signal. */
  return { url: '', durationSec: 12, cached: false, modelKey };
}

async function mockPollRevisions(_args: PollArgs): Promise<RevisionsResponse> {
  await wait(200);
  return {
    pending: PENDING_REVISIONS,
    drift:   VOICE_DRIFT_EVENTS,
  };
}

/* ── real fetch-based implementations ────────────────────────────────── */

async function realGetLibrary(): Promise<LibraryResponse> {
  const res = await fetch('/api/library');
  if (!res.ok) throw new Error(`Library scan failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realGetVoices(args?: { currentBookId?: string; engine?: string }): Promise<VoiceLibraryResponse> {
  const params = new URLSearchParams();
  if (args?.currentBookId) params.set('currentBookId', args.currentBookId);
  if (args?.engine) params.set('engine', args.engine);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`/api/voices${qs}`);
  if (!res.ok) throw new Error(`Voice library fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realSetVoicePin(voiceId: string, pinned: boolean): Promise<void> {
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`Voice pin update failed (${res.status}): ${(await res.text()) || res.statusText}`);
}

async function realImportManuscript({ text, file, fileName }: UploadArgs): Promise<ImportResponse> {
  if (file) {
    const form = new FormData();
    form.append('file', file, fileName ?? file.name);
    const res = await fetch('/api/import', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Import failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  if (text !== undefined) {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, fileName }),
    });
    if (!res.ok) throw new Error(`Import failed (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }
  throw new Error('importManuscript requires either `text` or `file`.');
}

async function realGetBookState(bookId: string): Promise<BookStateResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`);
  if (!res.ok) throw new Error(`Book state fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realPutBookState(bookId: string, req: PutStateRequest): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Book state PUT failed (${res.status}): ${(await res.text()) || res.statusText}`);
}

async function realConfirmBook(body: ConfirmBookRequest): Promise<ConfirmBookResponse> {
  const res = await fetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    throw new SlugCollisionError((err as { suggestedTitle?: string }).suggestedTitle ?? `${body.title} (2)`);
  }
  if (!res.ok) throw new Error(`Confirm failed (${res.status}): ${(await res.text()) || res.statusText}`);
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
  code?: string;
  /** Structured upstream detail (Google's `status` + `details[]` for ApiError
      envelopes; falls back to the raw SDK message). Rendered in a collapsible
      block in the analysing view so the headline stays readable. */
  detail?: string;
  live?: AnalysisLiveInfo;
}

export class AnalysisError extends Error {
  code: string;
  detail?: string;
  constructor(message: string, code: string, detail?: string) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.detail = detail;
  }
}

async function realAnalyseManuscript(manuscriptId: string, { onPhase, onLog, model, fresh }: AnalyseOpts = {}): Promise<AnalyseResponse> {
  const hasBody = model !== undefined || fresh !== undefined;
  const res = await fetch(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify({ model, fresh }) : undefined,
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
    } else if (payload.kind === 'result' && payload.response) {
      result = payload.response;
    } else if (payload.kind === 'error') {
      throw new AnalysisError(payload.message || 'Analysis failed.', payload.code ?? 'unknown', payload.detail);
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

export interface ReparseBookResponse {
  state: { chapters: Array<{ id: number; title: string; slug: string }> };
  chapterCount: number;
  chapterTitles: string[];
}
async function realReparseBook(bookId: string): Promise<ReparseBookResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/reparse`, { method: 'POST' });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Re-parse failed (${res.status}).`);
  }
  return res.json();
}

async function realDeleteBook(bookId: string): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Delete failed (${res.status}).`);
  }
}

async function mockDeleteBook(_bookId: string): Promise<void> {
  await wait(80);
}

async function mockReparseBook(_bookId: string): Promise<ReparseBookResponse> {
  await wait(120);
  return { state: { chapters: [] }, chapterCount: 0, chapterTitles: [] };
}

async function realGetVoiceSample({ voiceId, voice, modelKey, text, characterHint }: VoiceSampleArgs): Promise<VoiceSample> {
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, voice, text, characterHint }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Sample synthesis failed (${res.status}).`);
  }
  return res.json();
}

/* Real SSE reader for chapter generation. Mirrors the analysis-stream pattern
   above: open a long-running POST, parse `data: <json>` frames, dispatch each
   payload to onTick. Returns a canceller that aborts the fetch. */
function realStreamGeneration({ bookId, modelKey, chapterIds, force, onTick }: StreamArgs): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelKey, chapterIds, force }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        onTick({
          type: 'chapter_failed',
          errorReason: `Generation stream failed (${res.status}): ${detail || res.statusText}`,
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
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6));
          if (!dataLines.length) continue;
          try {
            const payload = JSON.parse(dataLines.join('\n')) as GenerationTick;
            onTick(payload);
          } catch (e) {
            console.warn('[api] malformed generation tick:', dataLines.join('\n'), e);
          }
        }
      }
    } catch (e) {
      /* Aborts surface as DOMException 'AbortError' — that's the canceller
         doing its job, not a real failure. Anything else is worth surfacing
         as a failed tick so the UI can show something instead of hanging. */
      if ((e as { name?: string })?.name === 'AbortError') return;
      onTick({
        type: 'chapter_failed',
        errorReason: (e as Error).message ?? 'Generation stream failed.',
      });
    }
  })();

  return () => controller.abort();
}

export interface SidecarHealth {
  status: 'reachable' | 'unreachable';
  url: string;
  engines?: string[];
  error?: string;
}

async function realGetSidecarHealth(): Promise<SidecarHealth> {
  const res = await fetch('/api/sidecar/health');
  if (!res.ok) {
    return {
      status: 'unreachable',
      url: '',
      error: `Sidecar probe HTTP ${res.status}`,
    };
  }
  return res.json();
}

async function mockGetSidecarHealth(): Promise<SidecarHealth> {
  /* Mocks pretend everything's healthy — generation is local and synchronous
     under VITE_USE_MOCKS=true, so there's no real sidecar to probe. */
  await wait(80);
  return { status: 'reachable', url: '(mock)', engines: ['coqui', 'gemini'] };
}

/* Chapter audio + revisions polling stay mocked for now — both belong to the
   playback slice that comes after this one. */
const real = {
  getLibrary:        realGetLibrary,
  getVoices:         realGetVoices,
  setVoicePin:       realSetVoicePin,
  getBookState:      realGetBookState,
  putBookState:      realPutBookState,
  importManuscript:  realImportManuscript,
  confirmBook:       realConfirmBook,
  uploadManuscript:  realUploadManuscript,
  analyseManuscript: realAnalyseManuscript,
  matchVoices:       realMatchVoices,
  deleteBook:        realDeleteBook,
  reparseBook:       realReparseBook,
  getVoiceSample:    realGetVoiceSample,
  streamGeneration:  realStreamGeneration,
  getSidecarHealth:  realGetSidecarHealth,
  getChapterAudio:   async ({ bookId, chapterId }: AudioArgs): Promise<ChapterAudio> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Chapter audio fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  pollRevisions:     async (_args: PollArgs): Promise<RevisionsResponse> => {
    /* Return a benign empty payload so the polling effect in App.tsx doesn't
       surface a noisy error every 30s on real backend. */
    return { pending: [], drift: [] };
  },
};

const mock = {
  getLibrary:        mockGetLibrary,
  getVoices:         mockGetVoices,
  setVoicePin:       mockSetVoicePin,
  getBookState:      mockGetBookState,
  putBookState:      mockPutBookState,
  importManuscript:  mockImportManuscript,
  confirmBook:       mockConfirmBook,
  uploadManuscript:  mockUploadManuscript,
  analyseManuscript: mockAnalyseManuscript,
  matchVoices:       mockMatchVoices,
  deleteBook:        mockDeleteBook,
  reparseBook:       mockReparseBook,
  getVoiceSample:    mockGetVoiceSample,
  streamGeneration:  mockStreamGeneration,
  getSidecarHealth:  mockGetSidecarHealth,
  getChapterAudio:   mockGetChapterAudio,
  pollRevisions:     mockPollRevisions,
};

export const api = USE_MOCKS ? mock : real;
export type Api = typeof api;
