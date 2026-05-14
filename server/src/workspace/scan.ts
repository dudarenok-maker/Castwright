/* Walk the books/ tree (three levels: Author/Series/Book), merge each book's
   .audiobook/state.json with its on-disk audio/ contents, and return a shape
   matching the GET /api/library response. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOKS_ROOT,
  audioDir,
  bookDirByDisplay,
  castJsonPath,
  changeLogJsonPath,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
} from './paths.js';
import { readJson } from './state-io.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';

export type LibraryBookStatus =
  | 'not_analysed'
  | 'analysing'
  | 'cast_pending'
  | 'generating'
  | 'complete'
  | 'unreadable'
  | 'orphaned';

export interface BookStateJson {
  bookId: string;
  manuscriptId: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  manuscriptFile: string;       // e.g. 'manuscript.epub'
  castConfirmed: boolean;
  chapters: Array<{ id: number; title: string; slug: string; duration?: string; excluded?: boolean }>;
  coverGradient: [string, string];
  createdAt: string;
  updatedAt: string;
  /* Editable audiobook metadata surfaced by the Listen view's metadata editor.
     Optional so older state.json files keep loading; absent fields fall back
     to library/cast defaults on the frontend. */
  narratorCredit?: string | null;
  genre?: string | null;
  publicationDate?: string | null;
}

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

const MANUSCRIPT_EXTS = ['.epub', '.md', '.markdown', '.txt', '.pdf'];

/* Cast.json shape — only the fields scanBook reads. Kept minimal here; the
   authoritative shape lives in server/src/tts/synthesise-chapter.ts. */
interface CastJsonForScan {
  characters?: Array<{ id?: string; voiceId?: string }>;
}

/* Segments file shape — only durationSec matters for runtime totals. */
interface SegmentsJsonForScan {
  durationSec?: number;
}

function formatRuntime(totalSec: number): string {
  const totalMin = Math.round(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name);
  } catch { return []; }
}

function findManuscriptFile(bookDir: string): string | null {
  const files = listFiles(bookDir);
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.startsWith('manuscript.') && MANUSCRIPT_EXTS.some(ext => lower.endsWith(ext))) {
      return f;
    }
  }
  return null;
}

function deterministicGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const palette: Array<[string, string]> = [
    ['#3C194F', '#0F0E0D'],
    ['#6B6663', '#1A1A1A'],
    ['#D4A04E', '#7B5A26'],
    ['#A43C6C', '#3C194F'],
    ['#1F3A5F', '#0A1628'],
    ['#5C3A1E', '#2A1810'],
    ['#3E5F4A', '#162820'],
    ['#7A2E3C', '#2A0F14'],
  ];
  return palette[Math.abs(h) % palette.length];
}

function relativeTimeFromMs(then: number): string {
  const diffMs = Date.now() - then;
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(then).toLocaleDateString();
}

function mtimeMs(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return Date.now(); }
}

async function scanBook(author: string, series: string, title: string): Promise<LibraryBook | null> {
  const bookDir = bookDirByDisplay(author, series, title);
  const manuscriptFile = findManuscriptFile(bookDir);
  const stateJson = stateJsonPath(bookDir);
  const castJson = castJsonPath(bookDir);
  const dotDir = dotAudiobook(bookDir);
  const hasState = existsSync(stateJson);
  const hasCast = existsSync(castJson);

  // Folder with neither manuscript nor state — skip as not-a-book.
  if (!manuscriptFile && !hasState) return null;

  let state: BookStateJson | null = null;
  let unreadable = false;
  if (hasState) {
    try {
      state = await readJson<BookStateJson>(stateJson);
    } catch {
      unreadable = true;
    }
  }

  const bookId = state?.bookId ?? makeBookId(author, series, title);
  const coverGradient = state?.coverGradient ?? deterministicGradient(bookId);
  /* Excluded chapters (front/back-matter the user opted out of narrating)
     don't count toward the chapterCount or completion math — otherwise a
     12-chapter book with 2 excluded would stall at 10/12 forever. */
  const activeChapters = state?.chapters.filter(c => !c.excluded) ?? [];
  const chapterCount = activeChapters.length;
  const audioFiles = manuscriptFile ? listFiles(audioDir(bookDir)).filter(f => /\.(mp3|m4a|wav|opus)$/i.test(f)) : [];
  const completedChapters = audioFiles.length;
  const lastWorkedOn = relativeTimeFromMs(mtimeMs(existsSync(dotDir) ? dotDir : bookDir));

  /* Cast-derived counts: characterCount = total cast entries; voiceCount =
     distinct voice ids (multiple characters can share a library voice). A
     malformed cast.json leaves counts at 0 — the surrounding status logic
     surfaces 'unreadable' separately when state.json itself fails to parse;
     cast.json being broken without state.json being broken is rare enough
     that we don't gate the whole row on it. */
  let castCharacterCount = 0;
  let castVoiceCount = 0;
  if (hasCast) {
    try {
      const cast = await readJson<CastJsonForScan>(castJson);
      const characters = cast?.characters ?? [];
      castCharacterCount = characters.length;
      const voiceIds = new Set<string>();
      for (const c of characters) {
        const vid = c.voiceId ?? c.id;
        if (vid) voiceIds.add(vid);
      }
      castVoiceCount = voiceIds.size;
    } catch { /* ignore; counts stay at 0 */ }
  }

  /* Runtime totals come from each chapter's <slug>.segments.json (written
     by the synthesis pipeline). We sum every chapter that has one — a
     partially-generated book reports the runtime it has so far. Returning
     undefined when the total is 0 keeps the card showing '—' rather than
     '0m' for books that haven't generated yet. */
  let totalSec = 0;
  if (state) {
    for (const ch of activeChapters) {
      const segPath = join(audioDir(bookDir), `${ch.slug}.segments.json`);
      try {
        const meta = await readJson<SegmentsJsonForScan>(segPath);
        if (meta && typeof meta.durationSec === 'number' && Number.isFinite(meta.durationSec)) {
          totalSec += meta.durationSec;
        }
      } catch { /* malformed segments file → skip */ }
    }
  }
  const runtime = totalSec > 0 ? formatRuntime(totalSec) : undefined;

  /* An empty or malformed cast.json (characters: []) is NOT a confirmable
     cast — the analysis either didn't finish, was reset, or produced no
     characters. Treat it as if cast.json weren't there, so the status falls
     back to 'analysing' instead of stranding the book at the misleading
     'Cast confirmation' badge with no characters behind it. */
  const hasUsableCast = hasCast && castCharacterCount > 0;

  /* Per-chapter analysis cache (server/handoff/cache/{manuscriptId}.json)
     records each chapter as Phase 1 completes. If the analysis aborted
     halfway — rate limit, crash, the user closed the tab mid-stream and
     came back — cast.json may already exist with characters even though
     some chapters never ran. Cross-check the cache against the active
     (non-excluded) chapter list so the badge surfaces 'analysing' until
     every chapter is actually analysed; that's the signal the resume
     button needs to be honest about what's still pending. */
  let analysedChapterCount = 0;
  if (state?.manuscriptId) {
    try {
      const cache = await loadAnalysisCache(state.manuscriptId);
      const cachedIds = new Set(Object.keys(cache.chapters ?? {}).map(k => Number(k)));
      for (const ch of activeChapters) {
        if (cachedIds.has(ch.id)) analysedChapterCount += 1;
      }
    } catch { /* missing/corrupt cache → treat as nothing analysed */ }
  }
  const analysisComplete = chapterCount === 0 || analysedChapterCount >= chapterCount;

  let status: LibraryBookStatus;
  if (unreadable) status = 'unreadable';
  else if (hasState && !manuscriptFile) status = 'orphaned';
  else if (!hasState && manuscriptFile) status = 'not_analysed';
  else if (state && (!hasUsableCast || !analysisComplete)) status = 'analysing';
  else if (state && !state.castConfirmed) status = 'cast_pending';
  else if (state && state.castConfirmed && completedChapters < chapterCount) status = 'generating';
  else status = 'complete';

  /* Distinct progress signals for the two intermediate states:
       - 'analysing' shows analysed chapters / total (matches the analysing
         view's per-chapter ticks),
       - 'generating' shows synthesised chapters / total (audio files on
         disk). Mixing them confused users who saw "Reading manuscript…
         60%" on a book that had 60% of audio files but 0% of analysis. */
  const analysingProgress = chapterCount > 0 ? analysedChapterCount / chapterCount : 0;
  const generatingProgress = chapterCount > 0 ? completedChapters / chapterCount : 0;

  return {
    bookId,
    title: state?.title ?? title,
    author: state?.author ?? author,
    series: state?.series ?? series,
    seriesPosition: state?.seriesPosition ?? null,
    isStandalone: state?.isStandalone ?? false,
    status,
    manuscriptId: state?.manuscriptId,
    chapterCount,
    completedChapters,
    characterCount: castCharacterCount,
    voiceCount: castVoiceCount,
    progress: status === 'analysing' ? analysingProgress
            : status === 'generating' ? generatingProgress
            : undefined,
    runtime,
    lastWorkedOn,
    coverGradient,
  };
}

export async function scanLibrary(): Promise<LibraryResponse> {
  ensureWorkspace();
  const authors: LibraryAuthor[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    const seriesList: LibrarySeries[] = [];
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      const books: LibraryBook[] = [];
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const book = await scanBook(authorName, seriesName, titleName);
        if (book) books.push(book);
      }
      if (books.length) {
        books.sort((a, b) => (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0) || a.title.localeCompare(b.title));
        seriesList.push({ name: seriesName, books });
      }
    }
    if (seriesList.length) {
      seriesList.sort((a, b) => a.name === 'Standalones' ? 1 : b.name === 'Standalones' ? -1 : a.name.localeCompare(b.name));
      authors.push({ name: authorName, series: seriesList });
    }
  }
  authors.sort((a, b) => a.name.localeCompare(b.name));
  return { authors };
}

/** Locate a book on disk by its slug-based bookId. Walks the three-level tree
    and reads each `.audiobook/state.json` to match. Used by the per-book
    routes (GET/PUT /api/books/:bookId/state). O(N) in books — fine for a
    single-user local install; can be replaced with an in-memory index later. */
export async function findBookByBookId(bookId: string): Promise<{
  bookDir: string;
  author: string;
  series: string;
  title: string;
  state: BookStateJson;
} | null> {
  return findBookBy(state => state.bookId === bookId);
}

/** Locate a book by its manuscriptId — used to re-hydrate the in-memory
    manuscript record after a server restart so the analysis route can
    resume from cache. */
export async function findBookByManuscriptId(manuscriptId: string): Promise<{
  bookDir: string;
  author: string;
  series: string;
  title: string;
  state: BookStateJson;
} | null> {
  return findBookBy(state => state.manuscriptId === manuscriptId);
}

/** Each event in `.audiobook/change-log.json` for a single book, paired with
    the book's identifying info. Used by the workspace changelog aggregator
    to attach `bookId`/`bookTitle`/`author` to every event so the workspace
    Change log view can render cross-book context. */
export interface BookChangeLogEvents {
  bookId: string;
  bookTitle: string;
  author: string;
  events: unknown[];
}

/** Walk the books/ tree and yield each book's change-log entries. Books with
    no `.audiobook/change-log.json` are skipped silently — that's the normal
    state for a freshly-imported book that hasn't seen a logged action yet. */
export async function listAllChangeLogs(): Promise<BookChangeLogEvents[]> {
  ensureWorkspace();
  const out: BookChangeLogEvents[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(dir)).catch(() => null);
        if (!state) continue;
        const log = await readJson<{ events?: unknown[] }>(changeLogJsonPath(dir)).catch(() => null);
        const events = log?.events ?? [];
        if (events.length === 0) continue;
        out.push({
          bookId: state.bookId,
          bookTitle: state.title,
          author: state.author,
          events,
        });
      }
    }
  }
  return out;
}

async function findBookBy(predicate: (state: BookStateJson) => boolean): Promise<{
  bookDir: string;
  author: string;
  series: string;
  title: string;
  state: BookStateJson;
} | null> {
  ensureWorkspace();
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(join(dir, '.audiobook', 'state.json')).catch(() => null);
        if (state && predicate(state)) {
          return { bookDir: dir, author: authorName, series: seriesName, title: titleName, state };
        }
      }
    }
  }
  return null;
}
