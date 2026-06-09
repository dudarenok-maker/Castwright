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
import { ensureChapterUuids } from './chapter-uuid.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { formatDuration } from '../audio/format-duration.js';
import { engineBreakdownFromSnapshots } from '../audio/engine-breakdown.js';
import { normaliseBookLanguage } from '../tts/language.js';

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
    /** srv-35 (plan 190) — immutable per-chapter identifier, stable across
        restructure (merge/split/reorder) and rename, unlike the positional
        `id` and the `id`-embedding `slug`. Minted lazily by
        `ensureChapterUuids` (server/src/workspace/chapter-uuid.ts) at the
        read seams that already persist (scan, book-state GET, restructure),
        so legacy books gain a uuid on first touch — no schema bump (plan 27
        add policy). The sync manifest (srv-32) and resume bookmarks key by
        this. Optional so legacy state.json files load cleanly. */
    uuid?: string;
    duration?: string;
    excluded?: boolean;
    /** "Not queued" hold — the user explicitly removed this (un-rendered)
        chapter from the generation queue (queue-modal delete of its
        chapter-scope entry). Distinct from `excluded`: a held chapter stays
        PART of the book (no audio cleanup, still counts toward the book being
        "not fully generated"), it's just not on the work queue and the
        auto-work resume must NOT re-enqueue it. Cleared when the user clicks
        "Generate this chapter". Persisted so the choice survives reload —
        without it, `chapter.state` re-hydrates to "queued" and the row lies.
        Optional so legacy state.json files load cleanly. */
    held?: boolean;
    /** TTS model key that produced this chapter's audio file. Stamped on
        successful render (server/src/routes/generation.ts post-render
        block) and backfilled lazily from audio/<slug>.segments.json on
        scan for chapters that pre-date this field. Used by the frontend
        to surface "engine drift" — chapters generated with a different
        engine than the project's current `ui.ttsModelKey`. Optional so
        unrendered chapters and very old state.json files load cleanly. */
    audioModelKey?: string;
    /** Distinct speaking characters per TTS engine they ACTUALLY rendered in
        (per-character routing, plan 108). Stamped on render and backfilled
        from segments `characterSnapshots` on scan. Drives the mixed-engine
        "Kokoro (1), Qwen (6)" caption; for a uniform chapter it has one key
        matching `audioModelKey`'s engine. Optional for legacy/unrendered. */
    audioEngines?: Record<string, number>;
    /** ISO timestamp when the audio was rendered. Mirrors segments file's
        `synthesizedAt`. Used as a tie-breaker for cast-drift detection
        (was the cast confirmed before or after the audio was made?). */
    audioRenderedAt?: string;
    /** Sticky flag set by `renameChapter` (and by merge/split when an
        explicit title override is supplied). Locks the title against
        both heuristic refresh paths: the opportunistic
        `refreshChapterTitles` on book-state GET and the explicit POST
        `/api/books/:bookId/chapters/refresh-titles`. Absent or false
        on parser-derived titles so heuristic improvements can still
        land. Round-trips through `state.json` and through the portable
        book bundle (plan 75). */
    titleOverridden?: boolean;
    /** Durable record of the LAST synthesis FAILURE for this chapter.
        Only `'failed'` is ever persisted — "done" is derived from the
        audio file on disk (`completedSlugs`) and "queued" is the absence
        of both, so a full status enum would just duplicate disk truth.
        Written by the generation route's failure path and CLEARED on a
        successful render, so a chapter that failed (no audio on disk)
        re-hydrates as "Failed · reason" instead of the misleading
        "Queued" after a reload or queue-clear. Distinct from
        `analysis.failedChapterIds` (Phase 0/1 analysis failures).
        Optional so legacy state.json files load cleanly. */
    generationState?: 'failed';
    /** Human-readable reason for the persisted `generationState: 'failed'`.
        Mirrors the `chapter_failed` SSE broadcast's `errorReason`. */
    generationError?: string;
    /** fs-19 — stable machine code for the failure class (drives the
        frontend's remediation rendering). Mirrors the `chapter_failed`
        broadcast's `errorCode`. Cleared on a successful render. */
    generationErrorCode?: string;
    /** fs-19 — concrete "what to do about it" copy for the failure.
        Mirrors the `chapter_failed` broadcast's `remediation`. Cleared on
        a successful render. */
    generationRemediation?: string;
    /** srv-27 — advisory post-synthesis QA verdict for this chapter's audio.
        Stamped on a successful render; drives the "Suspect" badge in the
        Generate + Listen views. Optional so legacy state.json files load
        cleanly. ADVISORY only — never gates completion. */
    audioQa?: {
      status: 'ok' | 'suspect';
      reasons: string[];
      measuredLufs: number | null;
      truePeakDb: number | null;
      durationSec: number;
      expectedSec: number | null;
      checkedAt: string;
    };
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
    /** Discriminator. Legacy records (pre-multi-source) may carry
        `openLibraryId` instead of `candidateId`; both are unused at read
        time (the scan only checks presence + the bytes on disk). */
    source?: 'openlibrary' | 'apple' | 'google' | 'local';
    /** Composite `<source>:<localId>` written by the multi-source fetch. */
    candidateId?: string;
    /** Legacy (plan 36) — OpenLibrary-only id. Read-tolerated, not written. */
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
  /* Per-book chapter audio output format. Stamped on every state.json
     write; absent on books written before plan 72 — those are interpreted
     as `'mp3'` by callers (the read path defaults at the seam, see
     `bookStateAudioFormat` below). Values: `'mp3'` (libmp3lame VBR V2,
     default), `'aac-m4a'` (AAC-LC ≈ 128 kbps in an M4A container) or
     `'opus'` (libopus ≈ 96 kbps VBR in an Ogg container). Drives the
     extension used by `generation.ts` and the codec dispatch in
     `server/src/tts/mp3.ts:encodePcmToAudio`. */
  audioFormat?: 'mp3' | 'aac-m4a' | 'opus';
  /* User-editable free-form tag strings. Powers the library view's
     tag-chip filter row (plan 73). Optional on disk so books written
     before the field landed continue to load — `scanBook` defaults to
     `[]` so the wire shape always carries the array. Edits round-trip
     through PUT /api/books/:bookId/state with `slice: 'state'`. */
  tags?: string[];
  /* BCP-47 manuscript language (fs-2). Default `'en'`. Drives same-language
     narration: a non-`'en'` book forces every character — INCLUDING the
     narrator — onto a designed Qwen voice and BLOCKS the Kokoro
     cross-language fallback (Kokoro is English-only). Optional on disk so
     books written before fs-2 keep loading; the read path defaults at the
     seam (`bookStateLanguage` below) so callers never read `state.language`
     directly. Additive optional field — `CURRENT_STATE_SCHEMA` does NOT bump
     (plan 27 rename-vs-add policy). Set at confirm time by
     `server/src/routes/import.ts`. */
  language?: string;
}

/** Resolved chapter audio format for a book — `audioFormat` from
 *  state.json when present, else `'mp3'` (backward compat for state files
 *  written before plan 72). Use everywhere the value drives generation or
 *  on-disk lookup; never read `state.audioFormat` directly so the default
 *  stays in one place. */
export function bookStateAudioFormat(state: BookStateJson): 'mp3' | 'aac-m4a' | 'opus' {
  return state.audioFormat ?? 'mp3';
}

/** Resolved BCP-47 language for a book — `language` from state.json when
 *  present, else `'en'` (backward compat for state files written before
 *  fs-2). Use everywhere the value drives narration routing or the analyzer
 *  preamble; never read `state.language` directly so the default and
 *  normalisation stay in one place. */
export function bookStateLanguage(state: BookStateJson): string {
  return normaliseBookLanguage(state.language);
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
  /** The distinct voice ids (`voiceId ?? id`) behind `voiceCount`. Exposed
      so the library view can union them across books for a library-wide
      DISTINCT-voices total — summing `voiceCount` would count a voice
      reused across a series once per book. Always present (defaults to
      `[]` when cast.json is absent or malformed). */
  voiceIds: string[];
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
  /** Plan 73 — user-editable tags. Always an array on the wire
      (defaults to `[]` for books whose state.json predates the
      field) so the chip-filter row in the library view doesn't need
      to handle the undefined case. */
  tags: string[];
  /** fs-2 — BCP-47 book language. Always present on the wire (defaults to
      `'en'` for books whose state.json predates the field) so the library
      card's language badge + filter pill have a non-optional source. */
  language: string;
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
  /** Per-character render snapshots — source for the `audioEngines` breakdown
      backfill on chapters that pre-date that field (false-drift fix). */
  characterSnapshots?: Record<string, { voiceEngine?: string; renderedFallbackEngine?: string }>;
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
  let castVoiceIds: string[] = [];
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
      castVoiceIds = [...voiceIds];
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
    /* srv-35 — lazy-migrate: mint a stable uuid for any chapter lacking
       one and persist once. Idempotent; subsequent scans are no-ops. Runs
       before the segments backfill so a freshly-uuid'd book is on disk
       even if the segments pass finds nothing to write. */
    if (ensureChapterUuids(state)) {
      try {
        await writeStateJsonAtomic(stateJsonPath(bookDir), state);
      } catch {
        /* best-effort — the next scan retries; in-memory state already
           carries the uuids for this caller. */
      }
    }
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
    voiceIds: castVoiceIds,
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
    /* Plan 73 — surface state.json tags onto the wire. Default to []
       so books written before the field landed render an empty chip
       row rather than tripping the frontend's `book.tags.includes()`
       guard. */
    tags: Array.isArray(state?.tags) ? [...state!.tags] : [],
    /* fs-2 — surface the book language onto the wire, defaulting to 'en'
       at the seam so the card badge / filter pill never see undefined. */
    language: state ? bookStateLanguage(state) : normaliseBookLanguage(undefined),
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

/** Walk every book and return its directory + parsed state.json. A thin
 *  all-books variant of `findBookBy` (which stops at the first match) used
 *  by the srv-32 sync-manifest INDEX, which needs each book's ISO
 *  `updatedAt` + chapter `audioRenderedAt` (the `LibraryBook` wire shape
 *  only carries a relative `lastWorkedOn`). Deliberately lean: a state.json
 *  read per book with backup recovery, NO per-chapter segments I/O — modern
 *  renders already stamp `audioRenderedAt` into state.json
 *  (finalize-chapter-write.ts), so the manifest signal is current without
 *  re-opening every segments file. Corrupt/unreadable books are skipped. */
export async function collectBooks(): Promise<Array<{ bookDir: string; state: BookStateJson }>> {
  ensureWorkspace();
  const out: Array<{ bookDir: string; state: BookStateJson }> = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const raw = await readStateJsonWithRecovery(
          join(dir, '.audiobook', 'state.json'),
        ).catch(() => null);
        if (raw) out.push({ bookDir: dir, state: raw });
      }
    }
  }
  return out;
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
      /* Duration backfill: legacy chapters and chapters rendered via code
         paths that pre-date generation.ts's state.json update block sit at
         the analysis-seeded '00:00' even after their MP3 is on disk. The
         segments file always carries the real PCM-measured durationSec, so
         the same loop that backfills modelKey + renderedAt can repair
         duration without an extra read. Treat empty + '00:00' as equally
         unset — both come from `hydrateFromBookState`'s `c.duration ??
         '00:00'` fallback and the analysis seed. */
      const needsDuration =
        (!ch.duration || ch.duration === '00:00') &&
        typeof meta.durationSec === 'number' &&
        Number.isFinite(meta.durationSec) &&
        meta.durationSec > 0;
      /* Engine breakdown backfill (false-drift fix). Recompute from the render
         snapshots so a legacy chapter gains the mixed-engine detail. New field,
         so a simple presence gate — never overwrites an existing breakdown. */
      const breakdown = meta.characterSnapshots
        ? engineBreakdownFromSnapshots(meta.characterSnapshots)
        : {};
      const needsEngines = !ch.audioEngines && Object.keys(breakdown).length > 0;
      if (needsModelKey || needsRenderedAt || needsDuration || needsEngines) {
        next[i] = {
          ...ch,
          ...(needsModelKey ? { audioModelKey: meta.modelKey } : {}),
          ...(needsRenderedAt ? { audioRenderedAt: meta.synthesizedAt } : {}),
          ...(needsDuration ? { duration: formatDuration(meta.durationSec as number) } : {}),
          ...(needsEngines ? { audioEngines: breakdown } : {}),
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
