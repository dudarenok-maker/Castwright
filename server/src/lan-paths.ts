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

/* Exact inverse of collapseHomePath: a leading `~` (alone, or followed by a
   separator) becomes the home dir. `~user`, `a~b`, absolute paths and an empty
   home are returned unchanged. */
export function expandHomePath(
  p: string,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): string {
  const win = (opts.platform ?? process.platform) === 'win32';
  const isSep = (c: string | undefined) => c === '/' || (win && c === '\\');
  let home = opts.home ?? homedir();
  while (home.length > 1 && isSep(home[home.length - 1])) home = home.slice(0, -1);
  if (!home) return p;
  if (p === '~') return home;
  if (p[0] === '~' && isSep(p[1])) return home + p.slice(1);
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

/* Install/bootstrap/pull job snapshots: `step` / `error` are free text that can
   embed host paths (subprocess output, spawn errors), `manualInstallerPath` is a
   bare path. Returns a shallow copy for non-loopback; loopback gets the job as-is. */
export function jobForClient<T extends object>(req: Request, job: T): T {
  if (isLoopbackRequest(req)) return job;
  const out = { ...job } as Record<string, unknown>;
  for (const k of ['step', 'error'] as const) {
    if (typeof out[k] === 'string') out[k] = textForClient(req, out[k] as string);
  }
  if (typeof out.manualInstallerPath === 'string') {
    out.manualInstallerPath = pathForClient(req, out.manualInstallerPath);
  }
  return out as T;
}

export function pathForClientOrNull(req: Request, p: string | null): string | null {
  return p === null ? null : pathForClient(req, p);
}
