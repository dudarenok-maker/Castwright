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
  coverImagePath,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
} from './paths.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from './state-migrate.js';
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
  /** Schema version of the on-disk shape. Stamped on every write by
      `stampStateSchema` in `server/src/workspace/state-migrate.ts`.
      Absent in legacy files written before the seam landed — those are
      interpreted as v1 by `migrateStateJson`. See plan 27 for the
      rename-vs-add policy. */
  schema?: number;
  bookId: string;
  manuscriptId: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  manuscriptFile: string; // e.g. 'manuscript.epub'
  castConfirmed: boolean;
  chapters: Array<{
    id: number;
    title: string;
    slug: string;
    duration?: string;
    excluded?: boolean;
    /** TTS model key that produced this chapter's audio file. Stamped on
        successful render (server/src/routes/generation.ts post-render
        block) and backfilled lazily from audio/<slug>.segments.json on
        scan for chapters that pre-date this field. Used by the frontend
        to surface "engine drift" — chapters generated with a different
        engine than the project's current `ui.ttsModelKey`. Optional so
        unrendered chapters and very old state.json files load cleanly. */
    audioModelKey?: string;
    /** ISO timestamp when the audio was rendered. Mirrors segments file's
        `synthesizedAt`. Used as a tie-breaker for cast-drift detection
        (was the cast confirmed before or after the audio was made?). */
    audioRenderedAt?: string;
  }>;
  coverGradient: [string, string];
  /** Cached cover-image metadata. Bytes live next to state.json at
      .audiobook/cover.jpg (see `coverImagePath` in workspace/paths.ts).
      Populated by the OpenLibrary fetch (server/src/cover/openlibrary.ts)
      OR by a local upload (server/src/cover/upload.ts) and reverted by
      DELETE /api/books/:bookId/cover. Optional so books imported before
      this feature continue to load and fall back to the procedural
      gradient on the card.

      Plan 36 shipped `openLibraryId`/`originalUrl`/`fetchedAt`; plan 40
      added `source` (discriminator), `originalFilename` + `uploadedAt`
      (local uploads only), and `framing` (render-time pan + zoom). All
      added fields are optional; legacy records without `source` infer
      `source: 'openlibrary'` by the presence of `openLibraryId`. */
  coverImage?: {
    /** Plan 40 — discriminator. Absent on legacy records; presence of
        `openLibraryId` infers `'openlibrary'`. */
    source?: 'openlibrary' | 'local';
    openLibraryId?: string;
    originalUrl?: string;
    fetchedAt?: string;
    originalFilename?: string | null;
    uploadedAt?: string;
    framing?: {
      offsetX: number;
      offsetY: number;
      zoom: number;
    };
  };
  createdAt: string;
  updatedAt: string;
  /** Chapter-title parser version that produced the current titles.
      When less than `CHAPTER_TITLE_PARSER_VERSION` (or absent), the
      book-state GET handler runs a non-destructive title refresh
      against the saved source file and bumps this field. Slug, audio,
      analysis state, etc. are all preserved across the refresh. See
      `server/src/parsers/version.ts`. */
  chapterTitleParserVersion?: number;
  /* Editable audiobook metadata surfaced by the Listen view's metadata editor.
     Optional so older state.json files keep loading; absent fields fall back
     to library/cast defaults on the frontend. */
  narratorCredit?: string | null;
  genre?: string | null;
  publicationDate?: string | null;
  /* Long-form "about this audiobook" copy, surfaced in the M4B `desc` /
     `ldes` atoms during Voice export (plan 33). Free-form text (markdown
     line breaks are preserved in the editor; M4B atoms carry plain text). */
  description?: string | null;
  /* Per-book editorial notes — source attribution, license, narration
     intent, in-progress thoughts. Workspace-internal (never exported).
     Plain text with markdown line breaks preserved verbatim. Plan 67. */
  notes?: string | null;
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
  /** Server-relative URL to the cached cover image when one is on disk
      (`<bookDir>/.audiobook/cover.jpg`). Undefined when no cover has
      been fetched / picked — the card / Listen header fall back to the
      procedural gradient. */
  coverImageUrl?: string;
  /** Plan 40 — optional pan + zoom applied at render time. Absent →
      bare `object-cover` (pre-plan-40 behaviour). Only meaningful
      when `coverImageUrl` is present too. */
  coverFraming?: { offsetX: number; offsetY: number; zoom: number };
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

/* Segments file shape — durationSec for runtime totals; modelKey +
   synthesizedAt for lazy backfill of state.json's audioModelKey /
   audioRenderedAt fields on legacy chapters that pre-date those fields
   landing in state.json (see backfillAudioModelKeys below). */
interface SegmentsJsonForScan {
  durationSec?: number;
  modelKey?: string;
  synthesizedAt?: string;
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
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function findManuscriptFile(bookDir: string): string | null {
  const files = listFiles(bookDir);
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.startsWith('manuscript.') && MANUSCRIPT_EXTS.some((ext) => lower.endsWith(ext))) {
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
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

async function scanBook(
  author: string,
  series: string,
  title: string,
): Promise<LibraryBook | null> {
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
  /* Only surface coverImageUrl when both the state.json metadata AND
     the bytes are present. State without the file (or vice versa) means
     a half-completed fetch — the card falls back to the gradient until
     the next user-driven pick. */
  const coverImageUrl =
    state?.coverImage && existsSync(coverImagePath(bookDir))
      ? `/api/books/${bookId}/cover`
      : undefined;
  const coverFraming = coverImageUrl ? state?.coverImage?.framing : undefined;
  /* Excluded chapters (front/back-matter the user opted out of narrating)
     don't count toward the chapterCount or completion math — otherwise a
     12-chapter book with 2 excluded would stall at 10/12 forever. */
  const activeChapters = state?.chapters.filter((c) => !c.excluded) ?? [];
  const chapterCount = activeChapters.length;
  const audioFiles = manuscriptFile
    ? listFiles(audioDir(bookDir)).filter((f) => /\.(mp3|m4a|opus)$/i.test(f))
    : [];
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
    } catch {
      /* ignore; counts stay at 0 */
    }
  }

  /* Runtime totals come from each chapter's <slug>.segments.json (written
     by the synthesis pipeline). We sum every chapter that has one — a
     partially-generated book reports the runtime it has so far. Returning
     undefined when the total is 0 keeps the card showing '—' rather than
     '0m' for books that haven't generated yet.

     Side mission on the same loop: lazy-backfill `audioModelKey` and
     `audioRenderedAt` onto state.chapters from each segments file. These
     fields landed in state.json with the engine-drift work (plan 35) but
     pre-existing books only have them inside segments.json — bringing
     them up to state.json on the next scan means subsequent chapter-list
     reads don't have to re-open every segments file just to compute
     drift. Shared helper because findBookBy also benefits when the
     book-state route is hit before a library scan has run. */
  let totalSec = 0;
  if (state) {
    const result = await backfillAudioModelKeysFromSegments(bookDir, state);
    state = result.state;
    totalSec = result.totalSec;
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
      const cachedIds = new Set(Object.keys(cache.chapters ?? {}).map((k) => Number(k)));
      for (const ch of activeChapters) {
        if (cachedIds.has(ch.id)) analysedChapterCount += 1;
      }
    } catch {
      /* missing/corrupt cache → treat as nothing analysed */
    }
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
    progress:
      status === 'analysing'
        ? analysingProgress
        : status === 'generating'
          ? generatingProgress
          : undefined,
    runtime,
    lastWorkedOn,
    coverGradient,
    coverImageUrl,
    coverFraming,
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
        books.sort(
          (a, b) =>
            (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0) || a.title.localeCompare(b.title),
        );
        seriesList.push({ name: seriesName, books });
      }
    }
    if (seriesList.length) {
      seriesList.sort((a, b) =>
        a.name === 'Standalones' ? 1 : b.name === 'Standalones' ? -1 : a.name.localeCompare(b.name),
      );
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
  return findBookBy((state) => state.bookId === bookId);
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
  return findBookBy((state) => state.manuscriptId === manuscriptId);
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
        const log = await readJson<{ events?: unknown[] }>(changeLogJsonPath(dir)).catch(
          () => null,
        );
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
        /* readStateJsonWithRecovery walks .bak.N on a corrupt main file
           so a torn write or schema-migration bug doesn't hide the book
           from per-book routes; `.catch(() => null)` still absorbs the
           total-loss case (no backups parsed either) — the lookup
           silently returns null and the route layer responds 404 as
           it would on a genuinely missing book. */
        const raw = await readStateJsonWithRecovery(join(dir, '.audiobook', 'state.json')).catch(
          () => null,
        );
        if (raw && predicate(raw)) {
          /* Apply the same lazy backfill we run during library scan — so
             a user opening a specific book's detail page (without going
             through the library first) still gets the engine-drift
             upgrade. Cheap on books that have already been upgraded:
             the helper short-circuits to a no-op once every chapter
             carries audioModelKey. */
          const { state } = await backfillAudioModelKeysFromSegments(dir, raw);
          return { bookDir: dir, author: authorName, series: seriesName, title: titleName, state };
        }
      }
    }
  }
  return null;
}

/** Lazy-migrate `audioModelKey` and `audioRenderedAt` onto every chapter
    in `state.chapters` by reading the corresponding `audio/<slug>.segments.json`
    file. Used by both the library-scan path (where the segments read is
    free because we're already computing runtime) and the per-book detail
    path. Returns the (possibly upgraded) state and the total runtime
    seconds derived from the segments files. Writes state.json back to
    disk via writeJsonAtomic when any chapter actually changed, so steady-
    state callers pay no I/O.

    Skips excluded chapters. Tolerates missing segments files (chapter
    not rendered yet) and malformed JSON (skip silently — the next scan
    will retry). updatedAt is intentionally not bumped because the
    backfill is a lossless metadata migration, not a user-driven change. */
export async function backfillAudioModelKeysFromSegments(
  bookDir: string,
  state: BookStateJson,
): Promise<{ state: BookStateJson; totalSec: number }> {
  let totalSec = 0;
  let backfillNeeded = false;
  const next: BookStateJson['chapters'] = [...state.chapters];
  for (let i = 0; i < state.chapters.length; i++) {
    const ch = state.chapters[i];
    if (ch.excluded) continue;
    const segPath = join(audioDir(bookDir), `${ch.slug}.segments.json`);
    try {
      const meta = await readJson<SegmentsJsonForScan>(segPath);
      if (!meta) continue;
      if (typeof meta.durationSec === 'number' && Number.isFinite(meta.durationSec)) {
        totalSec += meta.durationSec;
      }
      const needsModelKey =
        !ch.audioModelKey && typeof meta.modelKey === 'string' && meta.modelKey.length > 0;
      const needsRenderedAt =
        !ch.audioRenderedAt &&
        typeof meta.synthesizedAt === 'string' &&
        meta.synthesizedAt.length > 0;
      if (needsModelKey || needsRenderedAt) {
        next[i] = {
          ...ch,
          ...(needsModelKey ? { audioModelKey: meta.modelKey } : {}),
          ...(needsRenderedAt ? { audioRenderedAt: meta.synthesizedAt } : {}),
        };
        backfillNeeded = true;
      }
    } catch {
      /* malformed segments file → skip */
    }
  }
  if (backfillNeeded) {
    const upgraded: BookStateJson = { ...state, chapters: next };
    try {
      await writeStateJsonAtomic(stateJsonPath(bookDir), upgraded);
      return { state: upgraded, totalSec };
    } catch {
      /* Best-effort upgrade — a failed write just means the next call
         will try again. Return the upgraded shape in-memory so the
         current caller sees the fields even though disk hasn't caught
         up yet. */
      return { state: upgraded, totalSec };
    }
  }
  return { state, totalSec };
}
