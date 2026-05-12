/* Workspace path resolution and slug helpers.

   Workspace root resolves from WORKSPACE_DIR (env), defaulting to
   ../audiobook-workspace relative to the server folder. The books/ tree is
   always three levels deep: <Author>/<Series>/<Book>. Standalone titles use
   a synthetic series named 'Standalones'. */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');

/* WORKSPACE_DIR resolves relative to server/ (where .env lives). The default
   lands inside the repo at <repo>/audiobook-workspace/, so opening the
   project in a file browser surfaces the library too. Override to put it
   anywhere — absolute paths are honoured as-is. */
const ENV_DIR = process.env.WORKSPACE_DIR?.trim();
export const WORKSPACE_ROOT = resolve(SERVER_ROOT, ENV_DIR && ENV_DIR.length > 0 ? ENV_DIR : '../audiobook-workspace');
export const BOOKS_ROOT = join(WORKSPACE_ROOT, 'books');

export function ensureWorkspace(): void {
  mkdirSync(BOOKS_ROOT, { recursive: true });
}

/** URL-safe slug. Strips diacritics, lowercases, replaces non-alnum with '-',
    collapses runs, trims, caps at 80 chars. */
export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export const STANDALONES_SERIES = 'Standalones';

/** Compose bookId from human-readable parts. Stable, URL-safe, machine-independent. */
export function makeBookId(author: string, series: string, title: string): string {
  return `${slug(author)}__${slug(series || STANDALONES_SERIES)}__${slug(title)}`;
}

/** Parse a bookId back into its three slug parts. Returns null if malformed. */
export function parseBookId(bookId: string): { authorSlug: string; seriesSlug: string; titleSlug: string } | null {
  const parts = bookId.split('__');
  if (parts.length !== 3 || parts.some(p => !p)) return null;
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

export function stateJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'state.json');
}

export function castJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast.json');
}

export function manuscriptEditsJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'manuscript-edits.json');
}

export function revisionsJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'revisions.json');
}

/** Workspace-level voice metadata (pin flags). Spans every book in the
    workspace, so it lives at the workspace root rather than inside any
    one book's .audiobook/ folder. */
export function voicesMetaPath(): string {
  return join(WORKSPACE_ROOT, 'voices.json');
}
