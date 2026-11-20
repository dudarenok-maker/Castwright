import { homedir, tmpdir } from 'node:os';
import type { Request } from './http.js';
import { isLoopbackRequest } from './loopback.js';

/* #4446 — host paths in route bodies leak the OS username (the home dir) to
   LAN peers. Loopback keeps full paths; everyone else gets the home prefix
   collapsed to `~`. A path not under home is passed through unchanged. */

/* `shortPaths`: paths the OS wrote in 8.3 form, the alias is learned from them (win32
   only; default `os.tmpdir()` and the TEMP/TMP/APPDATA/LOCALAPPDATA env paths). */
type PathOpts = { home?: string; platform?: NodeJS.Platform; shortPaths?: string[] };

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Windows 8.3 short form of a long segment: spaces and `. " / \ [ ] : ; = ,`
   dropped, first six chars upper-cased, then `~N`. Only the prefix is derivable
   without the filesystem (`~N` depends on which siblings exist), so a candidate is
   only a shape check: `MICHAE~1` and `MICHAE~2` both fit `Michael Dudarenok`. A
   segment that is already a valid 8.3 name has none. */
function isShortFormOf(seg: string, cand: string): boolean {
  if (seg.length <= 8 && !/[ +,;=[\]]/.test(seg)) return false;
  const prefix = seg.replace(/[ .",;=:[\]+]/g, '').slice(0, 6);
  return !!prefix && new RegExp(`^${escRe(prefix)}~\\d+$`, 'i').test(cand);
}

/* The user's OWN alias per home segment, learned from paths the OS itself writes in
   short form (`os.tmpdir()`, TEMP, ...). A path counts only when every segment of the
   home prefix matches (case-insensitively) or is a valid short form of it. Matching
   only that exact alias keeps a same-prefix sibling (`MICHAE~2`) from collapsing to
   `~`, which `expandHomePath` would turn into the user's own home. No hint, no alias. */
function shortAliases(segs: string[], hints: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const hint of hints) {
    const hs = hint.split(/[\\/]+/);
    if (hs.length < segs.length) continue;
    const found: (string | undefined)[] = [];
    const ok = segs.every((s, i) => {
      if (hs[i].toLowerCase() === s.toLowerCase()) return true;
      if (i > 0 && isShortFormOf(s, hs[i])) {
        found[i] = hs[i];
        return true;
      }
      return false;
    });
    if (ok) found.forEach((a, i) => (out[i] ??= a));
  }
  return out;
}

function defaultShortPaths(): string[] {
  const e = process.env;
  return [tmpdir(), e.TEMP, e.TMP, e.APPDATA, e.LOCALAPPDATA].filter((p): p is string => !!p);
}

/* Regex source matching the home dir however a path spells it: any run of
   separators between segments (`C:\Users\a`, `C:/Users/a`, the doubled
   `C:\\Users\\a` of a Python repr), plus, on win32, the user's own discovered 8.3
   alias of a long segment. Callers append their own boundary lookahead. */
function homeRegexSource(home: string, win: boolean, shortPaths?: string[]): string {
  const sep = win ? '[\\\\/]+' : '/+';
  const segs = home.split(win ? /[\\/]+/ : /\/+/);
  const aliases = win ? shortAliases(segs, shortPaths ?? defaultShortPaths()) : [];
  return segs
    .map((s, i) => (i > 0 && win && aliases[i] ? `(?:${escRe(s)}|${escRe(aliases[i]!)})` : escRe(s)))
    .join(sep);
}

function trimHome(home: string, win: boolean): string {
  const isSep = (c: string) => c === '/' || (win && c === '\\');
  while (home.length > 1 && isSep(home[home.length - 1])) home = home.slice(0, -1);
  return home;
}

export function collapseHomePath(p: string, opts: PathOpts = {}): string {
  const win = (opts.platform ?? process.platform) === 'win32';
  const home = trimHome(opts.home ?? homedir(), win);
  if (!home) return p;
  const re = new RegExp(`^${homeRegexSource(home, win, opts.shortPaths)}(?=${win ? '[\\\\/]' : '/'}|$)`, win ? 'i' : '');
  return p.replace(re, '~');
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
  const home = trimHome(opts.home ?? homedir(), win);
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
export function textForClient(req: Request, text: string, opts: PathOpts = {}): string {
  if (isLoopbackRequest(req)) return text;
  const win = (opts.platform ?? process.platform) === 'win32';
  const home = trimHome(opts.home ?? homedir(), win);
  if (!home) return text;
  /* Same end-of-home boundary as collapseHomePath (a separator or end), plus the
     characters that end a path in prose; `ann-x` / `ann.old` stay untouched. Sentence
     punctuation (`.!?`) counts only when it is itself followed by such a terminator or
     the end (`ann.` collapses, `ann.old` does not) and is left in the output. */
  const stop = `$|[\\s'"\`)\\]}>:,;]`;
  const end = `(?=${win ? '[\\\\/]' : '/'}|${stop}|[.!?]+(?:${stop}))`;
  return text.replace(new RegExp(`${homeRegexSource(home, win, opts.shortPaths)}${end}`, win ? 'gi' : 'g'), '~');
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
