import { homedir } from 'node:os';
import type { Request } from './http.js';
import { isLoopbackRequest } from './lan-auth.js';

/* #4446 — host paths in route bodies leak the OS username (the home dir) to
   LAN peers. Loopback keeps full paths; everyone else gets the home prefix
   collapsed to `~`. A path not under home is passed through unchanged. */

export function collapseHomePath(
  p: string,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): string {
  const win = (opts.platform ?? process.platform) === 'win32';
  const isSep = (c: string | undefined) => c === '/' || (win && c === '\\');
  let home = opts.home ?? homedir();
  while (home.length > 1 && isSep(home[home.length - 1])) home = home.slice(0, -1);
  if (!home) return p;
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  if (norm(p) === norm(home)) return '~';
  if (norm(p.slice(0, home.length)) === norm(home) && isSep(p[home.length])) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function pathForClient(req: Request, p: string): string {
  return isLoopbackRequest(req) ? p : collapseHomePath(p);
}

/* Free-text variant: collapse every `<home>` occurrence inside a message
   (error strings that embed an absolute path). Loopback keeps the text. */
export function textForClient(req: Request, text: string): string {
  if (isLoopbackRequest(req)) return text;
  const win = process.platform === 'win32';
  let home = homedir();
  while (home.length > 1 && (home.endsWith('/') || (win && home.endsWith('\\')))) home = home.slice(0, -1);
  if (!home) return text;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${esc}(?=[\\\\/]|$|[^\\w])`, win ? 'gi' : 'g'), '~');
}

export function pathForClientOrNull(req: Request, p: string | null): string | null {
  return p === null ? null : pathForClient(req, p);
}
