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
   existing prefix); a test injects one to model junction and 8.3 shapes deterministically
   (the win32 test also exercises the default one against a real directory). */
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

/* Other spellings of the home dir, each a WHOLE path: the resolved (real) home, and every
   hint prefix (`os.tmpdir()`, TEMP, ... which the OS writes in short form) that resolves
   to it, cut at the depth the RESOLVED hint sits below the resolved home. Windows' short-name algorithm is not modelled
   (non-ASCII letters, hash forms and `~N` collisions all break a model); the filesystem
   is asked instead. The comparison is against the RESOLVED home, not the string
   `os.homedir()` returned, so a relocated profile (junctioned `C:\Users`, a junctioned
   profile folder, an 8.3-spelled ancestor) still matches. A sibling (`JORDAN~2`) resolves
   to another folder, so it never matches, which keeps it from collapsing to `~`
   (`expandHomePath` would turn that into the user's own home). Spellings are never mixed
   per segment, so a junction elsewhere into home cannot make a lookalike path collapse.
   No hint, an unresolvable one, or a resolver error: no alias. */
const spellingCache = new Map<string, string[]>();

function homeSpellings(
  home: string,
  hints: string[],
  resolve?: (p: string) => string,
): string[] {
  const cacheKey = `${home}|${hints.join('|')}`;
  const cached = resolve ? undefined : spellingCache.get(cacheKey);
  if (cached) return cached;
  const out: string[] = [];
  const res = resolve ?? resolveExisting;
  try {
    const realHome = res(home);
    const realKey = normKey(realHome);
    const seen = new Set([normKey(home)]);
    if (!seen.has(realKey)) {
      out.push(realHome);
      seen.add(realKey);
    }
    const segs = (p: string) => p.split(/[\\/]+/).length;
    for (const hint of hints) {
      const hs = hint.split(/[\\/]+/);
      while (hs.length > 1 && hs[hs.length - 1] === '') hs.pop();
      try {
        /* the cut is how many segments the hint has beyond home once both are resolved,
           so a junction that changes the depth (`C:\Users` -> `D:\Profiles`) is followed */
        const cut = hs.length - (segs(res(hs.join('\\'))) - segs(realHome));
        if (cut < 1 || cut > hs.length) continue;
        const prefix = hs.slice(0, cut).join('\\');
        const key = normKey(prefix);
        if (seen.has(key)) continue;
        if (normKey(res(prefix)) === realKey) {
          out.push(prefix);
          seen.add(key);
        }
      } catch {
        // an unresolvable hint contributes nothing
      }
    }
  } catch {
    out.length = 0;
  }
  if (!resolve) spellingCache.set(cacheKey, out);
  return out;
}

function defaultShortPaths(): string[] {
  const e = process.env;
  return [tmpdir(), e.TEMP, e.TMP, e.APPDATA, e.LOCALAPPDATA].filter((p): p is string => !!p);
}

/* Regex source matching the home dir however a path spells it: any run of
   separators between segments (`C:\Users\a`, `C:/Users/a`, the doubled
   `C:\\Users\\a` of a Python repr), plus, on win32, each verified alternative spelling of
   the whole path (resolved home, 8.3 hint prefix). Callers append their own boundary
   lookahead. */
function homeRegexSource(home: string, win: boolean, shortPaths?: string[], resolve?: (p: string) => string): string {
  const sepRe = win ? '[\\\\/]+' : '/+';
  const split = win ? /[\\/]+/ : /\/+/;
  const spell = (p: string) => p.split(split).map(escRe).join(sepRe);
  const alts = win ? homeSpellings(home, shortPaths ?? defaultShortPaths(), resolve) : [];
  return `(?:${[home, ...alts].map(spell).join('|')})`;
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
