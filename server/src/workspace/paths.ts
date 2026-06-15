/* Workspace path resolution and slug helpers.

   Workspace root resolves from WORKSPACE_DIR (env), defaulting to
   ../castwright-workspace relative to the server folder. The books/ tree is
   always three levels deep: <Author>/<Series>/<Book>. Standalone titles use
   a synthetic series named 'Standalones'. */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unicodeKebab } from '../util/safe-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');

/* WORKSPACE_DIR resolves relative to server/ (where .env lives). The default
   lands inside the repo at <repo>/castwright-workspace/, so opening the
   project in a file browser surfaces the library too. Override to put it
   anywhere — absolute paths are honoured as-is.

   Resolution precedence (boot-time only — restart required to change):
     1. user-settings.json `workspaceDirOverride` (synchronous best-effort read)
     2. WORKSPACE_DIR env var
     3. built-in `../castwright-workspace` default
   This is read once at module load — `WORKSPACE_ROOT` is a const export
   the rest of the server caches via destructuring, so mutating it mid-process
   would corrupt path resolution. The UI flags edits as "restart required". */
const ENV_DIR = process.env.WORKSPACE_DIR?.trim();
const OVERRIDE_DIR = readBootOverride();
const RESOLVED_DIR =
  OVERRIDE_DIR ?? (ENV_DIR && ENV_DIR.length > 0 ? ENV_DIR : '../castwright-workspace');
export const WORKSPACE_ROOT = resolve(SERVER_ROOT, RESOLVED_DIR);
export const BOOKS_ROOT = join(WORKSPACE_ROOT, 'books');
export const WORKSPACE_SOURCE: 'env' | 'default' | 'override' = OVERRIDE_DIR
  ? 'override'
  : ENV_DIR && ENV_DIR.length > 0
    ? 'env'
    : 'default';

/* Sync best-effort read of user-settings.json so the boot-time workspace
   resolution can honour an override without an async dance. A missing or
   malformed file falls through to env/default — never blocks startup. */
function readBootOverride(): string | null {
  try {
    /* Synchronous read so this can run inline during module load without
       blocking ESM hoisting on a top-level await. The file is small
       (a few hundred bytes); missing or malformed falls through silently. */
    const path = join(SERVER_ROOT, 'user-settings.json');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { workspaceDirOverride?: unknown };
    const override = parsed?.workspaceDirOverride;
    return typeof override === 'string' && override.trim().length > 0 ? override.trim() : null;
  } catch {
    return null;
  }
}

export function ensureWorkspace(): void {
  mkdirSync(BOOKS_ROOT, { recursive: true });
}

/** URL-safe slug. Deburrs accented Latin, lowercases, collapses non-(letter|
    number) to '-', trims, caps at 80 chars. Plan 219: uses the shared
    Unicode-preserving kebab so a non-Latin title/author (Cyrillic) yields a
    distinct slug instead of collapsing to `untitled` — which made `makeBookId`
    map EVERY Russian book to `untitled__standalones__untitled`. ASCII output is
    byte-identical to the pre-219 slug. */
export function slug(s: string): string {
  return unicodeKebab(s).slice(0, 80).replace(/-+$/g, '') || 'untitled';
}

export const STANDALONES_SERIES = 'Standalones';

/** Compose bookId from human-readable parts. Stable, URL-safe, machine-independent. */
export function makeBookId(author: string, series: string, title: string): string {
  return `${slug(author)}__${slug(series || STANDALONES_SERIES)}__${slug(title)}`;
}

/** Parse a bookId back into its three slug parts. Returns null if malformed. */
export function parseBookId(
  bookId: string,
): { authorSlug: string; seriesSlug: string; titleSlug: string } | null {
  const parts = bookId.split('__');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { authorSlug: parts[0], seriesSlug: parts[1], titleSlug: parts[2] };
}

/** Path to the book folder on disk, given the display strings the user confirmed.
    Uses the display strings verbatim — directories preserve original casing/spaces
    so the user sees readable folder names, while bookId stays slug-based. */
export function bookDirByDisplay(author: string, series: string, title: string): string {
  return join(BOOKS_ROOT, author, series || STANDALONES_SERIES, title);
}

export function dotAudiobook(bookDir: string): string {
  return join(bookDir, '.audiobook');
}

export function audioDir(bookDir: string): string {
  return join(bookDir, 'audio');
}

/** Plan 79 — user-visible exports folder sibling to `audio/` and `.audiobook/`.
    Finished artifacts (M4B, MP3.ZIP, AAC/Opus zips, portable bundle, and
    the per-chapter MP3 folder) land here under their slugged filenames so
    the user can grab them from File Explorer without opening the hidden
    `.audiobook/` jail. Per-export isolation is gone — clobber-newest-wins
    keeps `<slug>.m4b` always pointing at the latest build. */
export function bookExportsDir(bookDir: string): string {
  return join(bookDir, 'exports');
}

/** Plan 79 — manifest jail. The user-facing artifact lives in `exports/`;
    the per-job JSON manifest (status, sizeBytes, downloadUrl, format, etc.)
    stays hidden under `.audiobook/export-manifests/<exportId>.json` so it
    doesn't clutter the exports folder the user actually browses. */
export function bookExportManifestsDir(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'export-manifests');
}

export function stateJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'state.json');
}

export function castJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast.json');
}

/* srv-13 — a reparse deletes cast.json before the next analysis can carry its
   reuse/voice links forward. The reparse handler snapshots the reuse-relevant
   slice of cast.json here first; the analysis route reads it as a fallback for
   `priorCastForMerge` when cast.json is absent, then a fresh cast.json (which
   takes precedence) makes it inert until the next reparse refreshes it. */
export function castReuseCarryoverJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast-reuse-carryover.json');
}

export function manuscriptEditsJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'manuscript-edits.json');
}

/* srv-1 — per-book deterministic merge journal. Each manual merge / auto-fold
   appends or replaces an entry recording which sentences it rewrote, so the
   unlink-alias route can surface exactly those sentences instead of guessing
   from the chapterCast roster. Sibling to manuscript-edits.json. */
export function castMergesJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast-merges.json');
}

export function revisionsJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'revisions.json');
}

export function changeLogJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'change-log.json');
}

/* Per-book listening bookmark — `{ chapterId, currentSec, updatedAt }`.
   Sibling JSON to state.json so the schema-versioning shape from plan
   27 stays stable (state.json's rotating-backup contract is the
   load-bearing piece; this file is cheap to re-derive on loss so it
   stays on bare writeJsonAtomic). Plan 47. */
export function listenProgressJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'listen-progress.json');
}

/** fs-16 — per-book listening-stats sibling to listen-progress.json. */
export function listenStatsJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'listen-stats.json');
}

/* Per-book snapshot of the in-flight analyzer's state — written at phase
   boundaries / on pause / on terminal events. Lets the top-bar
   AnalysisPill rehydrate across browser reload AND server restart
   (the in-memory inFlightAnalysisByManuscript map is wiped by both).
   Sibling to state.json so the cold-boot discovery endpoint in
   book-state.ts can look it up via the same findBookByBookId path. */
export function analysisStateJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'analysis-state.json');
}

/** Per-book dropped-quote ledger. Each Phase 0 verify pass appends a
    batch; we never overwrite, so the user can audit what the model
    fabricated across every analyser run (model switch, retry, etc.).
    File envelope shape lives in store/dropped-quotes.ts. */
export function droppedQuotesJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'dropped-quotes.json');
}

/** Per-book cached cover image. JPEG bytes downloaded via the cover search
    (server/src/cover/store.ts). Sibling to state.json so the
    library scan can discover it cheaply via existsSync. Always a .jpg —
    OpenLibrary serves JPEGs and we don't re-encode. */
export function coverImagePath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cover.jpg');
}

/** Workspace-level voice metadata (pin flags). Spans every book in the
    workspace, so it lives at the workspace root rather than inside any
    one book's .audiobook/ folder. */
export function voicesMetaPath(): string {
  return join(WORKSPACE_ROOT, 'voices.json');
}

/** Workspace-level directory holding bespoke Qwen voice sidecars — one
    `<voiceId>.{json,pt}` pair per designed voice (the `.json` carries the
    design `instruct`/persona + ref text; the `.pt` is the cached embedding).
    Shared across every book, so it lives at the workspace root. Mirrors the
    `QWEN_VOICES_DIR` the sidecar is spawned with (spawn-sidecar.ts). */
export function qwenVoicesDir(): string {
  return join(WORKSPACE_ROOT, 'voices', 'qwen');
}

/** Path to a single designed Qwen voice's JSON sidecar (its `instruct`
    persona + ref text). `name` is the designed voiceId, e.g. `qwen-wren`. */
export function qwenVoiceSidecarPath(name: string): string {
  return join(qwenVoicesDir(), `${name}.json`);
}

/** Plan 102 — workspace-level chapter-generation queue. ONE file holds the
    cross-book queue so the user can mix-and-match order across books in a
    single ordering (e.g. "regenerate these 2 chapters of Book 1, then these
    5 of Book 5, then all of Book 6") without the server needing to
    aggregate-and-reconcile on every read. Sibling to voices.json at the
    workspace root. */
export function queueJsonPath(): string {
  return join(WORKSPACE_ROOT, '.queue.json');
}

/** srv-33 — workspace-level per-device access tokens (companion multi-device
    pairing + revoke, layered on srv-20's shared secret). One file holds every
    paired device's record `{ id, label, tokenHash, createdAt, lastSeenAt?,
    revoked? }`; sibling to voices.json at the workspace root. */
export function deviceTokensJsonPath(): string {
  return join(WORKSPACE_ROOT, 'device-tokens.json');
}

/** srv-2 — workspace-level backup jail. Per-book state.json snapshots live at
    `<WORKSPACE_ROOT>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json` — OUTSIDE the
    book folder so a book move/delete doesn't take its history with it, and so
    every snapshot sits in one place the user can browse/copy. */
export function backupsRootDir(): string {
  return join(WORKSPACE_ROOT, '.backups');
}

export function bookBackupsDir(bookId: string): string {
  return join(backupsRootDir(), bookId);
}

/** fs-20 — workspace-level telemetry jail. Per-run resource telemetry (RTF,
    VRAM, host RAM per chapter) is appended as JSONL to
    `<WORKSPACE_ROOT>/.telemetry/resource-telemetry.jsonl`. Sibling to
    `.backups` at the workspace root so it spans every book and survives a
    single book's move/delete; the admin console's trend panel reads it back. */
export function telemetryDir(): string {
  return join(WORKSPACE_ROOT, '.telemetry');
}
