/* API client surface. Real backend lives behind the same `api.*` shape;
   the components never know whether they're talking to fetch() or to
   the mocks below.

   Toggle with VITE_USE_MOCKS=true (.env.development). */

import type {
  UploadResponse, AnalyseResponse, VoiceMatchResponse,
  RevisionsResponse, ChapterAudio, GenerationTick, Character,
  Voice, VoiceSample, TtsModelKey, LibraryResponse, VoiceLibraryResponse,
  ImportResponse, ConfirmBookRequest, ConfirmBookResponse,
  BookStateResponse, PutStateRequest, WorkspaceChangeLogResponse,
  UserSettings, UserSettingsPatch, DroppedQuotesResponse,
  AnalysisStateResponse,
  BookExportRequest, BookExportJob, ExportLanInfo,
  BaseVoice, TtsEngine,
} from './types';
import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';
import { ANALYSIS_NORTHERN_STAR } from '../mocks/canned-data';
import { MOCK_LIBRARY } from '../mocks/library';
import { MOCK_BASE_VOICES, MOCK_VOICE_LIBRARY } from '../mocks/voices';
import { MATCH_FACTORS } from '../data/match-factors';
import { PENDING_REVISIONS } from '../data/revisions';
import { VOICE_DRIFT_EVENTS } from '../data/drift';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
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
  onChapterFailed?: (e: { chapterId: number; message: string }) => void;
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
  onThrottle?: (e: { phaseId: number; chapterIndex: number; model: string; waitMs: number; reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after' }) => void;
  /** One-shot event emitted at Phase 0 entry when the analyzer has
      pre-seeded its per-chapter prompt with characters carried over
      from prior books in the same series (plan 04 + plan 09). The
      analysing view renders a small "Carrying in N characters from
      prior books" pill so the user sees the context being applied.
      `names` is the first three for display; `count` is the total. */
  onSeriesPrior?: (e: { count: number; names: string[] }) => void;
  /** Override the server's default analysis model (e.g. 'gemini-3-flash-preview').
      Sent as JSON body to POST /api/manuscripts/:id/analysis. Ignored when
      the server runs in ANALYZER=manual mode. */
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
export interface MatchArgs { bookId: string; characters: Character[]; }
export interface MergeCharactersArgs { bookId: string; sourceId: string; targetId: string; }
export interface MergeCharactersResponse { characters: Character[]; }
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

export interface BaseVoiceSampleArgs {
  engine: TtsEngine;
  speakerName: string;
  /** Caller's currently-selected modelKey. The server re-maps to a
      compatible model when this doesn't route to `engine`. */
  modelKey: TtsModelKey;
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

async function mockGetBaseVoices(): Promise<{ voices: BaseVoice[] }> {
  await wait(40);
  return { voices: MOCK_BASE_VOICES };
}

async function mockSetVoiceOverride(
  _voiceId: string,
  _override: BaseVoice | null,
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
        fromBookId: c.matchedFrom.bookId ?? '',
        fromBookTitle: c.matchedFrom.bookTitle ?? '',
        fromCharacterId: c.matchedFrom.characterId ?? c.id,
        score: c.matchedFrom.confidence ?? 0,
        factors: factors.map(f => ({ id: f.id, label: f.label, score: f.score, detail: f.detail })),
      }],
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

function mockStreamGeneration({ getChapters, onTick: rawOnTick }: StreamArgs): () => void {
  const onTick = safeOnTick(rawOnTick);
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

async function mockGetBaseVoiceSample({ modelKey }: BaseVoiceSampleArgs): Promise<VoiceSample> {
  await wait(200);
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

async function realGetBaseVoices(): Promise<{ voices: BaseVoice[] }> {
  const res = await fetch('/api/voices/base');
  if (!res.ok) throw new Error(`Base-voice catalog fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realSetVoiceOverride(voiceId: string, override: BaseVoice | null): Promise<void> {
  const res = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/override`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ override }),
  });
  if (!res.ok) throw new Error(`Voice override update failed (${res.status}): ${(await res.text()) || res.statusText}`);
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

/* Cold-boot rehydration for the top-bar AnalysisPill (plan 32, E2).
   Server resolves memory-first / disk-fallback / running→paused
   coercion (see server/src/routes/book-state.ts). Returns null on
   404 so the caller can treat "no in-flight analysis" the same as
   "endpoint not reachable" — both equivalent to "no pill". */
async function realGetAnalysisState(bookId: string): Promise<AnalysisStateResponse | null> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/analysis/state`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Analysis state fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

/* Mock counterpart — returns null (no in-flight analysis) since mock
   mode has no disk-backed workspace nor a live analyzer. Layout's
   discovery effect treats null the same as 404 (no pill). */
async function mockGetAnalysisState(_bookId: string): Promise<AnalysisStateResponse | null> {
  await wait(20);
  return null;
}

/* Per-book dropped-quote ledger. Append-only file written by the two
   analysis routes after the verify pass — see
   server/src/store/dropped-quotes.ts for the envelope shape and
   server/src/routes/book-state.ts for the handler. Returns an empty
   envelope when the file doesn't exist yet (no analysis run has
   produced drops). */
async function realGetDroppedQuotes(bookId: string): Promise<DroppedQuotesResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/dropped-quotes`);
  if (!res.ok) throw new Error(`Dropped-quotes fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
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
  kind: 'phase' | 'result' | 'error' | 'log' | 'heartbeat' | 'cast-update' | 'eta' | 'chapter-failed' | 'chapter-resolved' | 'throttle' | 'series-prior';
  phaseId?: number;
  progress?: number;
  label?: string;
  response?: AnalyseResponse;
  message?: string;
  code?: string;
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
      the first three for the "Carrying in Wren, Marlow, Oduvan +N" pill
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
  constructor(message: string, code: string, detail?: string, prevCharCount?: number, nextCharCount?: number) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.detail = detail;
    this.prevCharCount = prevCharCount;
    this.nextCharCount = nextCharCount;
  }
}

async function realAnalyseManuscript(manuscriptId: string, { signal, onPhase, onLog, onHeartbeat, onEta, onCastUpdate, onChapterFailed, onChapterResolved, onThrottle, onSeriesPrior, model, fresh, allowStage1Shrink }: AnalyseOpts = {}): Promise<AnalyseResponse> {
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
        onChapterFailed?.({ chapterId: payload.chapterId, message: payload.message });
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
        (payload.reason === 'rpm' || payload.reason === 'tpm' || payload.reason === 'rpd' || payload.reason === 'retry-after')
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

async function realMergeCharacters({ bookId, sourceId, targetId }: MergeCharactersArgs): Promise<MergeCharactersResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Character merge failed (${res.status}).`);
  }
  return res.json();
}

async function mockMergeCharacters({ sourceId, targetId }: MergeCharactersArgs): Promise<MergeCharactersResponse> {
  /* Mock mode has no persisted cast — return an empty list so callers in a
     mocked environment can wire the call without crashing. Real merging is
     only meaningful against the workspace backend. */
  await wait(60);
  void sourceId; void targetId;
  return { characters: [] };
}

async function realOverrideLibraryCast(args: OverrideLibraryCastArgs): Promise<OverrideLibraryCastResponse> {
  const res = await fetch('/api/library-cast/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Library override failed (${res.status}).`);
  }
  return res.json();
}

async function mockOverrideLibraryCast(args: OverrideLibraryCastArgs): Promise<OverrideLibraryCastResponse> {
  /* Mock mode has no workspace to write back to; the override is only
     meaningful against the real backend. Mirror mockMergeCharacters and
     return synthetic records on both sides so the UI can fire the call
     without crashing in the design-system environment. */
  await wait(60);
  const stub = (id: string): Character => ({ id, name: id, role: '', color: 'eliza' } as Character);
  return {
    source: stub(args.sourceCharacterId),
    target: stub(args.targetCharacterId),
  };
}

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
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not json */ }
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
  return { id: chapterId, title: `Chapter ${chapterId}`, slug: `${String(chapterId).padStart(2, '0')}-mock`, excluded };
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
  { signal, onPhase, onLog, onHeartbeat, onEta, onCastUpdate, onChapterFailed, onChapterResolved, onThrottle, onSeriesPrior, model, allowStage1Shrink }: AnalyseOpts = {},
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
        onChapterFailed?.({ chapterId: payload.chapterId, message: payload.message });
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
        (payload.reason === 'rpm' || payload.reason === 'tpm' || payload.reason === 'rpd' || payload.reason === 'retry-after')
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
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6));
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

/* Raw-speaker audition — bypasses the attribute picker so the user can
   preview an unmodified model voice (Base voices tab + family-header Play).
   The synthetic voiceId in the URL is just a routing carrier; the server
   caches by (engine, speakerName) regardless. */
async function realGetBaseVoiceSample({ engine, speakerName, modelKey }: BaseVoiceSampleArgs): Promise<VoiceSample> {
  const carrier = `raw-${engine}-${speakerName}`;
  const res = await fetch(`/api/voices/${encodeURIComponent(carrier)}/sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, rawEngine: engine, rawSpeaker: speakerName }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* not json */ }
    throw new Error(detail || `Base voice sample failed (${res.status}).`);
  }
  return res.json();
}

/* Real SSE reader for chapter generation. Mirrors the analysis-stream pattern
   above: open a long-running POST, parse `data: <json>` frames, dispatch each
   payload to onTick. Returns a canceller that aborts the fetch. */
function realStreamGeneration({ bookId, modelKey, chapterIds, force, onTick: rawOnTick }: StreamArgs): () => void {
  const onTick = safeOnTick(rawOnTick);
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
  }).catch(err => {
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
  }).catch(err => {
    console.warn('[api] pauseAnalysis failed:', err);
  });
}

async function mockPauseAnalysis(_: { manuscriptId: string }): Promise<void> {
  return Promise.resolve();
}

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
     as authoritative. */
  modelLoaded?: boolean;
  loading?: boolean;
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

async function realGetWorkspaceChangelog(args: GetWorkspaceChangelogArgs = {}): Promise<WorkspaceChangeLogResponse> {
  const qs = new URLSearchParams();
  if (args.limit != null) qs.set('limit', String(args.limit));
  if (args.before)        qs.set('before', args.before);
  const url = qs.toString() ? `/api/workspace/changelog?${qs}` : '/api/workspace/changelog';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Workspace changelog fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function mockGetWorkspaceChangelog(_args: GetWorkspaceChangelogArgs = {}): Promise<WorkspaceChangeLogResponse> {
  /* CHANGE_LOG_EVENTS is intentionally empty (see src/data/change-log.ts).
     The mock stays contract-correct so VITE_USE_MOCKS=true exercises the
     same shape the real server returns; under mocks the Activity view sees
     the empty state, which is exactly what the real server returns for a
     fresh workspace. */
  await wait(60);
  return {
    events: CHANGE_LOG_EVENTS.map(e => ({
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

/* ── User settings ─────────────────────────────────────────────────────
   Real path round-trips through GET / PUT /api/user/settings. Mock path
   keeps an in-memory copy seeded from the same FRONTEND_ACCOUNT_DEFAULTS
   that mirrors the server's DEFAULT_USER_SETTINGS, so the Account view
   stays consistent under VITE_USE_MOCKS=true. */
const MOCK_USER_SETTINGS: UserSettings = {
  ...FRONTEND_ACCOUNT_DEFAULTS,
  apiKeyStatus:         'unset',
  workspaceRoot:        '(mock)/audiobook-workspace',
  workspaceSource:      'default',
};

async function realGetUserSettings(): Promise<UserSettings> {
  const res = await fetch('/api/user/settings');
  if (!res.ok) throw new Error(`User settings fetch failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realPutUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  const res = await fetch('/api/user/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`User settings save failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function mockGetUserSettings(): Promise<UserSettings> {
  await wait(50);
  return { ...MOCK_USER_SETTINGS };
}

async function mockPutUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  await wait(50);
  /* Strip read-only fields a misbehaving caller might submit so the mock
     path enforces the same invariant as the server. */
  const { displayName, defaultAnalysisModel, defaultTtsEngine, defaultTtsModelKey,
          sidecarUrl, workspaceDirOverride, exportSyncFolder } = patch;
  Object.assign(MOCK_USER_SETTINGS, Object.fromEntries(
    Object.entries({ displayName, defaultAnalysisModel, defaultTtsEngine,
                     defaultTtsModelKey, sidecarUrl, workspaceDirOverride, exportSyncFolder })
      .filter(([, v]) => v !== undefined),
  ));
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

async function realCreateBookExport(bookId: string, body: BookExportRequest): Promise<BookExportJob> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const err = (await res.json().catch(() => ({}))) as { missing?: string[] };
    throw new ExportIncompleteError(err.missing ?? []);
  }
  if (!res.ok) throw new Error(`Export request failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realGetBookExport(bookId: string, exportId: string): Promise<BookExportJob> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/exports/${encodeURIComponent(exportId)}`);
  if (!res.ok) throw new Error(`Export poll failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realGetExportLanUrls(): Promise<ExportLanInfo> {
  const res = await fetch(`/api/export/lan`);
  if (!res.ok) throw new Error(`LAN URL probe failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

/* Mock path: simulate a ~3 s build by ticking a fake job through three
   progress phases. The "downloadUrl" points at a data: URL so a real
   click does fire a browser download under VITE_USE_MOCKS=true (it'll
   just be a tiny stub zip). */
const MOCK_EXPORT_JOBS = new Map<string, BookExportJob>();
const MOCK_EXPORT_TIMERS = new Map<string, ReturnType<typeof setTimeout>[]>();

async function mockCreateBookExport(bookId: string, body: BookExportRequest): Promise<BookExportJob> {
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
  timers.push(setTimeout(() => {
    const j = MOCK_EXPORT_JOBS.get(id);
    if (j) MOCK_EXPORT_JOBS.set(id, { ...j, progress: 0.25 });
  }, 700));
  timers.push(setTimeout(() => {
    const j = MOCK_EXPORT_JOBS.get(id);
    if (j) MOCK_EXPORT_JOBS.set(id, { ...j, progress: 0.6 });
  }, 1500));
  timers.push(setTimeout(() => {
    const j = MOCK_EXPORT_JOBS.get(id);
    if (!j) return;
    const blob = new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06].concat(Array(18).fill(0)))], { type: 'application/zip' });
    MOCK_EXPORT_JOBS.set(id, {
      ...j,
      status: 'done',
      progress: 1,
      sizeBytes: 22,
      downloadUrl: URL.createObjectURL(blob),
      syncPath: body.destination === 'sync-folder' ? 'C:\\Users\\dudar\\OneDrive\\Audiobooks\\Mock.zip' : null,
      completedAt: new Date().toISOString(),
    });
  }, 2400));
  MOCK_EXPORT_TIMERS.set(id, timers);
  return job;
}

async function mockGetBookExport(_bookId: string, exportId: string): Promise<BookExportJob> {
  await wait(40);
  const job = MOCK_EXPORT_JOBS.get(exportId);
  if (!job) throw new Error('Mock export not found.');
  return job;
}

async function mockGetExportLanUrls(): Promise<ExportLanInfo> {
  await wait(20);
  return { urls: ['http://192.168.1.42:8080'], port: 8080 };
}

async function mockGetSidecarHealth(): Promise<SidecarHealth> {
  /* Mocks pretend everything's healthy — generation is local and synchronous
     under VITE_USE_MOCKS=true, so there's no real sidecar to probe. */
  await wait(80);
  return {
    status: 'reachable',
    url: '(mock)',
    engines: ['coqui', 'gemini'],
    modelLoaded: MOCK_SIDECAR_MODEL_LOADED,
    loading: false,
    device: MOCK_SIDECAR_MODEL_LOADED ? 'cuda' : null,
  };
}

/* In-memory model state for the mock path — flipped by mockLoadSidecar /
   mockUnloadSidecar so the in-app Load/Stop pill round-trips visibly under
   VITE_USE_MOCKS=true. */
let MOCK_SIDECAR_MODEL_LOADED = false;
let MOCK_OLLAMA_MODEL_LOADED = false;

async function realLoadSidecar(): Promise<ModelControlResult> {
  const res = await fetch('/api/sidecar/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return (await res.json().catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realUnloadSidecar(): Promise<ModelControlResult> {
  const res = await fetch('/api/sidecar/unload', { method: 'POST' });
  return (await res.json().catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realLoadAnalyzer(): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/load', { method: 'POST' });
  return (await res.json().catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realUnloadAnalyzer(): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/unload', { method: 'POST' });
  return (await res.json().catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realGetOllamaHealth(): Promise<OllamaHealth> {
  const res = await fetch('/api/ollama/health');
  if (!res.ok) {
    return { status: 'unreachable', url: '', error: `Ollama probe HTTP ${res.status}` };
  }
  return res.json();
}

async function mockLoadSidecar(): Promise<ModelControlResult> {
  await wait(60);
  MOCK_SIDECAR_MODEL_LOADED = true;
  return { status: 'ready' };
}

async function mockUnloadSidecar(): Promise<ModelControlResult> {
  await wait(40);
  MOCK_SIDECAR_MODEL_LOADED = false;
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

/* Chapter audio + revisions polling stay mocked for now — both belong to the
   playback slice that comes after this one. */
const real = {
  getUserSettings:   realGetUserSettings,
  putUserSettings:   realPutUserSettings,
  getLibrary:        realGetLibrary,
  getVoices:         realGetVoices,
  setVoicePin:       realSetVoicePin,
  getBaseVoices:     realGetBaseVoices,
  setVoiceOverride:  realSetVoiceOverride,
  getBookState:      realGetBookState,
  putBookState:      realPutBookState,
  getAnalysisState:  realGetAnalysisState,
  getDroppedQuotes:  realGetDroppedQuotes,
  importManuscript:  realImportManuscript,
  confirmBook:       realConfirmBook,
  uploadManuscript:  realUploadManuscript,
  analyseManuscript: realAnalyseManuscript,
  matchVoices:       realMatchVoices,
  mergeCharacters:   realMergeCharacters,
  overrideLibraryCast: realOverrideLibraryCast,
  deleteBook:        realDeleteBook,
  reparseBook:       realReparseBook,
  setChapterExcluded:      realSetChapterExcluded,
  runAnalysisForChapters:  realRunAnalysisForChapters,
  getVoiceSample:    realGetVoiceSample,
  getBaseVoiceSample: realGetBaseVoiceSample,
  streamGeneration:  realStreamGeneration,
  pauseGeneration:   realPauseGeneration,
  pauseAnalysis:     realPauseAnalysis,
  getSidecarHealth:  realGetSidecarHealth,
  getOllamaHealth:   realGetOllamaHealth,
  loadSidecar:       realLoadSidecar,
  unloadSidecar:     realUnloadSidecar,
  loadAnalyzer:      realLoadAnalyzer,
  unloadAnalyzer:    realUnloadAnalyzer,
  getWorkspaceInfo:  realGetWorkspaceInfo,
  getWorkspaceChangelog: realGetWorkspaceChangelog,
  createBookExport:  realCreateBookExport,
  getBookExport:     realGetBookExport,
  getExportLanUrls:  realGetExportLanUrls,
  getChapterAudio:   async ({ bookId, chapterId }: AudioArgs): Promise<ChapterAudio> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Chapter audio fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
  pollRevisions:     async ({ bookId }: PollArgs): Promise<RevisionsResponse> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/revisions`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Revisions poll failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
};

const mock = {
  getUserSettings:   mockGetUserSettings,
  putUserSettings:   mockPutUserSettings,
  getLibrary:        mockGetLibrary,
  getVoices:         mockGetVoices,
  setVoicePin:       mockSetVoicePin,
  getBaseVoices:     mockGetBaseVoices,
  setVoiceOverride:  mockSetVoiceOverride,
  getBookState:      mockGetBookState,
  putBookState:      mockPutBookState,
  getAnalysisState:  mockGetAnalysisState,
  getDroppedQuotes:  mockGetDroppedQuotes,
  importManuscript:  mockImportManuscript,
  confirmBook:       mockConfirmBook,
  uploadManuscript:  mockUploadManuscript,
  analyseManuscript: mockAnalyseManuscript,
  matchVoices:       mockMatchVoices,
  mergeCharacters:   mockMergeCharacters,
  overrideLibraryCast: mockOverrideLibraryCast,
  deleteBook:        mockDeleteBook,
  reparseBook:       mockReparseBook,
  setChapterExcluded:      mockSetChapterExcluded,
  runAnalysisForChapters:  mockRunAnalysisForChapters,
  getVoiceSample:    mockGetVoiceSample,
  getBaseVoiceSample: mockGetBaseVoiceSample,
  streamGeneration:  mockStreamGeneration,
  pauseGeneration:   mockPauseGeneration,
  pauseAnalysis:     mockPauseAnalysis,
  getSidecarHealth:  mockGetSidecarHealth,
  getOllamaHealth:   mockGetOllamaHealth,
  loadSidecar:       mockLoadSidecar,
  unloadSidecar:     mockUnloadSidecar,
  loadAnalyzer:      mockLoadAnalyzer,
  unloadAnalyzer:    mockUnloadAnalyzer,
  getWorkspaceInfo:  mockGetWorkspaceInfo,
  getWorkspaceChangelog: mockGetWorkspaceChangelog,
  createBookExport:  mockCreateBookExport,
  getBookExport:     mockGetBookExport,
  getExportLanUrls:  mockGetExportLanUrls,
  getChapterAudio:   mockGetChapterAudio,
  pollRevisions:     mockPollRevisions,
};

export const api = USE_MOCKS ? mock : real;
export type Api = typeof api;
