/* Console-window-flash regression guard (windowsHide invariant).
 *
 * Symptom this locks down: on Windows, a prod app launched without an
 * attached console (the fs-1 versioned-dir launcher runs detached) gives
 * every spawned console program — ffmpeg.exe, ffprobe.exe, git.exe, the
 * Python sidecar, pip — its OWN new console window, which flashes open and
 * vanishes. During audio generation/export the server spawns ffmpeg per
 * sentence and per chapter, so the windows flash "constantly". In dev
 * (`npm start` from a terminal) the children inherit the existing console,
 * so the bug is invisible there — which is exactly how it slipped in.
 *
 * The fix is `windowsHide: true` on EVERY child_process call. Rather than
 * unit-test each call site, this scans the source globally and asserts the
 * invariant: any new spawn that forgets the flag fails here, before it can
 * ever ship a flashing window to a user.
 *
 * Three scans (round 2 widened the net after launchers + injectable-spawnFn
 * installers slipped through the server/src-only round-1 scan):
 *   1. direct child_process calls in `server/src/**`,
 *   2. indirect `spawnFn(...)` calls in `server/src/**` (the install
 *      bootstraps spawn through a function pointer the bare scan can't see),
 *   3. the prod launcher + start/stop + model-installer scripts that live
 *      OUTSIDE server/src (a hidden parent does not stop a grandchild pip /
 *      python from popping its own console). */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = import.meta.dirname;

/* child_process entry points that launch an OS process (and therefore can
   pop a console window on Windows). Bare `exec`/`execSync` are included for
   completeness even though the codebase doesn't use them today. */
const SPAWN_NAMES = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec'];

/* Lookbehind rejects member calls and same-suffix identifiers so we never
   match `someRegex.exec(...)`, `child.spawn(...)`, or a local `respawn(...)`
   helper — only top-level `spawn(`, `spawnSync(`, `execFile(`, etc. */
const CALL_RE = new RegExp(String.raw`(?<![.\w])(${SPAWN_NAMES.join('|')})\s*\(`, 'g');

/* Indirect spawners. The install bootstraps (whisper/coqui/qwen/ollama) launch
   their child through an injectable `spawnFn` function pointer, so the
   bare-call scan above can't see them — exactly the round-1 blind spot. Match
   any `spawnFn(` (bare OR member, e.g. `this.spawnFn(`) and demand the flag. */
const INDIRECT_RE = /\bspawnFn\s*\(/g;

/* Prod-reachable and test-only spawn sites OUTSIDE server/src that the tree
   scan can't reach: the versioned-dir launcher (launch.mjs), the prod start/stop
   scripts, the upgrade restarter, the model installer scripts (which spawn
   pip), test runners (which spawn python/pip/pytest), and a python-discovery
   helper (ensure-python312.mjs, which spawns python/winget — neither pip nor
   pytest). A hidden parent does NOT stop a grandchild from popping its own
   console on Windows, so each grandchild needs the flag too.

   This floor is a HARDCODED list, not derived from anything — `launch.mjs`
   itself spawns no pip, so it can never be picked up by pipSpawners() below.
   Replacing the floor with a glob would silently drop it and the guard would
   get WEAKER while appearing to get stronger. Keep it as-is; only ADD to it. */
const REPO_ROOT = join(SRC_ROOT, '..', '..');
const EXTERNAL_FILES_FLOOR = [
  'launch.mjs',
  'scripts/start-app-prod.mjs',
  'scripts/restart-after-upgrade.mjs',
  'scripts/stop-app.mjs',
  'scripts/run-sidecar-tests.mjs',
  'server/tts-sidecar/scripts/install-whisper.mjs',
  'server/tts-sidecar/scripts/install-qwen3.mjs',
  'server/tts-sidecar/scripts/install-coqui.mjs',
  'server/tts-sidecar/scripts/ensure-python312.mjs',
].map((rel) => join(REPO_ROOT, rel));

/* install-ort.mjs (#2192) made the ONNX-runtime swap load-bearing on the boot,
   bootstrap AND upgrade paths, but it's just one file — the next pip-spawning
   script dropped into either scripts dir would be just as prod-reachable and
   just as invisible to a hardcoded list. Glob both dirs instead of hand-adding
   one more filename, and keep ONLY the files that actually invoke pip via
   `-m pip` — a plain `.mjs` glob with no content filter would also sweep in
   files with no spawn call at all (pip-constraints.mjs, accelerator-profile.mjs)
   and files whose spawns have nothing to do with pip (ensure-python312.mjs). */
const PIP_SPAWN_RE = /-m['"]?\s*,?\s*['"]pip/;

/* Blank line comments and block comments only — NOT string/template content.
   This is deliberately weaker than blankCommentsAndStrings above: PIP_SPAWN_RE
   has to see the actual quoted '-m'/'pip' argv tokens, which live INSIDE string
   literals, so blanking string content the way the windowsHide scan does would
   erase the very thing being detected and pipSpawners() would select nothing.
   String/template boundaries are still tracked (so a comment-opening sequence
   embedded in a string is never mistaken for a real comment start) but their
   content passes through untouched.

   Known blind spot: a plain string or template literal that merely MENTIONS
   "-m pip" as prose (a log/help line, not a real spawn argv) is not fully ruled
   out — PIP_SPAWN_RE requires a quote directly before "pip" (no `?` on that
   group), which is what saves scripts/run-sidecar-tests.mjs's `.venv/bin/python
   -m pip install …` help text from a false-positive match (no quote precedes
   "pip" there), but a prose string that happens to quote the word — e.g.
   `console.log("... -m 'pip' ...")` — would still match with nothing actually
   spawning pip.

   Second known blind spot, the opposite (dangerous) direction: a variable
   holding the pip token. `spawnSync(python, ['-m', PIP_MODULE])` where
   `PIP_MODULE = 'pip'` does NOT match PIP_SPAWN_RE, because the pattern
   requires the literal quoted text "pip" adjacent to the quote — a real spawn
   would silently drop out of pipSpawners() coverage. No file currently in
   scope uses that shape; the EXTERNAL_FILES_FLOOR hardcoded list above
   backstops the known offenders regardless of what pipSpawners() finds.

   Third known blind spot: blankComments does not lex regex literals. A regex
   containing an unpaired quote character (e.g. a pattern matching /it['"]s/)
   is read char-by-char like everything else, so that lone quote is mistaken
   for the start of a string and desyncs the quote-tracking state — everything
   after it, including a real line or block comment, is then treated as string
   content and left unblanked rather than blanked. Unlike the two blind spots
   above, this one is safe by construction: it can only make PIP_SPAWN_RE see
   MORE raw text (an unblanked comment), never less, so the guard can only get
   stricter (over-select a file into EXTERNAL_FILES) — it can never miss a real
   pip spawner because of this gap. No file currently in scope contains such a
   regex literal. */
function blankComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const keepWhitespace = (ch: string) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') out.push(keepWhitespace(src[i++]));
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepWhitespace(src[i++]));
      if (i < src.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out.push(src[i], src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out.push(src[i++]);
      }
      if (i < src.length) {
        out.push(src[i]);
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/* Non-recursive on purpose — both dirs are flat script drops, not trees. */
function pipSpawners(): string[] {
  const dirs = [
    join(REPO_ROOT, 'server', 'tts-sidecar', 'scripts'),
    join(REPO_ROOT, 'scripts'),
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const full = join(dir, entry.name);
      if (PIP_SPAWN_RE.test(blankComments(readFileSync(full, 'utf8')))) out.push(full);
    }
  }
  return out;
}

const EXTERNAL_FILES = [...new Set([...EXTERNAL_FILES_FLOOR, ...pipSpawners()])];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    if (entry.name === 'test-setup.ts') continue;
    out.push(full);
  }
  return out;
}

/* Blank out comments AND string/template literals so prose that merely
   mentions a spawn call — a doc comment, or a log line like
   "skipping spawn (current sidecar honoured)" — is never matched. Replaced
   characters become spaces (newlines kept) so byte offsets and line numbers
   stay accurate for error reporting. Single-pass lexer because regex can't
   disambiguate a `//` inside a string from a real line comment. */
function blankCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let i = 0;
  const keepWhitespace = (ch: string) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') out.push(keepWhitespace(src[i++]));
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepWhitespace(src[i++]));
      if (i < src.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(' ');
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(keepWhitespace(src[i++]));
      }
      if (i < src.length) {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/* Given the index of a call's opening paren, return the argument text up to
   its balanced closing paren. Nested parens (e.g. `shell: isWin()`) are
   handled by depth counting; our spawn args contain no parens inside string
   literals, so naive counting is sufficient here. */
function extractCallArgs(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx); // unbalanced — treat the rest as the call
}

/* Scan one file for spawn calls matching `re` whose call args omit
   `windowsHide: true`. Returns repo-relative `path:line — name(...)` offenders. */
function scanFile(file: string, re: RegExp): string[] {
  const offenders: string[] = [];
  const src = blankCommentsAndStrings(readFileSync(file, 'utf8'));
  for (const match of src.matchAll(re)) {
    const name = match[0].replace(/\s*\($/, '').trim();
    const openParenIdx = match.index + match[0].length - 1;
    const callText = extractCallArgs(src, openParenIdx);
    if (!/windowsHide\s*:\s*true/.test(callText)) {
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${rel}:${line} — ${name}(...) missing windowsHide: true`);
    }
  }
  return offenders;
}

describe('windowsHide invariant (no flashing console windows in prod)', () => {
  const serverFiles = listSourceFiles(SRC_ROOT).filter((f) =>
    readFileSync(f, 'utf8').includes('child_process'),
  );

  it('finds at least the known ffmpeg/sidecar spawners (scan is wired up)', () => {
    /* Guard against the scan silently matching nothing (e.g. a refactor that
       moves all spawns) and giving a false green. */
    expect(serverFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('every direct child_process spawn in server/src passes windowsHide: true', () => {
    const offenders = serverFiles.flatMap((f) => scanFile(f, CALL_RE));
    expect(
      offenders,
      `child_process calls missing windowsHide (would flash a console window in prod):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every indirect spawnFn(...) call in server/src passes windowsHide: true', () => {
    /* Only files whose `spawnFn` defaults to a RAW child_process spawn — the
       reliable static tell is that they import `realSpawn`. A `spawnFn` that
       delegates to an already-hiding wrapper (e.g. sidecar-supervisor → the
       windowsHide'd `spawnSidecar`) is exempt: the flag lives in the wrapper,
       and forcing it onto the high-level call would be meaningless. */
    const indirectFiles = listSourceFiles(SRC_ROOT).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes('spawnFn') && src.includes('realSpawn');
    });
    const offenders = indirectFiles.flatMap((f) => scanFile(f, INDIRECT_RE));
    expect(
      offenders,
      `spawnFn() calls missing windowsHide (installer bootstraps would flash):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('prod launcher + start/stop + installer scripts pass windowsHide: true', () => {
    const offenders = EXTERNAL_FILES.flatMap((f) => scanFile(f, CALL_RE));
    expect(
      offenders,
      `spawns outside server/src missing windowsHide (launcher/installer flash):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
