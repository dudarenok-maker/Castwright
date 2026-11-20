import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, sep } from 'node:path';
import type { Request } from './http.js';
import { isLoopbackRequest } from './loopback.js';

/* #4446 — host paths in route bodies leak the OS username (the home dir) to
   LAN peers. Loopback keeps full paths; everyone else gets the home prefix
   collapsed to `~`. A path not under home is passed through unchanged. */

/* `shortPaths`: paths the OS wrote in 8.3 form, the alias is learned from them (win32
   only; default `os.tmpdir()` and the TEMP/TMP/APPDATA/LOCALAPPDATA env paths).
   `resolve`: the filesystem resolver (default `realpathSync.native` of the longest
   existing prefix); a test injects one because real 8.3 names can't be made on demand. */
type PathOpts = {
  home?: string;
  platform?: NodeJS.Platform;
  shortPaths?: string[];
  resolve?: (p: string) => string;
};

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* `realpathSync.native` of `p`, or of its longest existing prefix with the rest appended
   as written. Never throws: nothing resolvable returns `p` unchanged. */
function resolveExisting(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? [real, ...rest].join(sep) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

const normKey = (p: string) => p.split(/[\\/]+/).filter(Boolean).join('/').toLowerCase();

/* The user's OWN alias per home segment, learned from paths the OS itself writes in
   short form (`os.tmpdir()`, TEMP, ...). Windows' short-name algorithm is not modelled
   (non-ASCII letters, hash forms and `~N` collisions all break a model); the filesystem
   is asked instead: a hint's first `segs.length` segments count only when they resolve
   to the home dir itself, and then each differing hint segment is the alias. A sibling
   (`MICHAE~2`) resolves to another folder, so it never matches, which keeps it from
   collapsing to `~` (`expandHomePath` would turn that into the user's own home). No
   hint, an unresolvable one, or a resolver error: no alias. */
const hintCache = new Map<string, (string | undefined)[]>();

function shortAliases(
  home: string,
  segs: string[],
  hints: string[],
  resolve?: (p: string) => string,
): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  const homeKey = normKey(home);
  for (const hint of hints) {
    const hs = hint.split(/[\\/]+/);
    if (hs.length < segs.length) continue;
    const cacheKey = `${home}|${hint}`;
    let found = resolve ? undefined : hintCache.get(cacheKey);
    if (!found) {
      found = [];
      try {
        const prefix = hs.slice(0, segs.length).join('\\');
        if (normKey((resolve ?? resolveExisting)(prefix)) === homeKey) {
          segs.forEach((s, i) => {
            if (i > 0 && hs[i].toLowerCase() !== s.toLowerCase()) found![i] = hs[i];
          });
        }
      } catch {
        found = [];
      }
      if (!resolve) hintCache.set(cacheKey, found);
    }
    found.forEach((a, i) => (out[i] ??= a));
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
function homeRegexSource(home: string, win: boolean, shortPaths?: string[], resolve?: (p: string) => string): string {
  const sepRe = win ? '[\\\\/]+' : '/+';
  const segs = home.split(win ? /[\\/]+/ : /\/+/);
  const aliases = win ? shortAliases(home, segs, shortPaths ?? defaultShortPaths(), resolve) : [];
  return segs
    .map((s, i) => (i > 0 && win && aliases[i] ? `(?:${escRe(s)}|${escRe(aliases[i]!)})` : escRe(s)))
    .join(sepRe);
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
  const re = new RegExp(`^${homeRegexSource(home, win, opts.shortPaths, opts.resolve)}(?=${win ? '[\\\\/]' : '/'}|$)`, win ? 'i' : '');
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
  return text.replace(new RegExp(`${homeRegexSource(home, win, opts.shortPaths, opts.resolve)}${end}`, win ? 'gi' : 'g'), '~');
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
