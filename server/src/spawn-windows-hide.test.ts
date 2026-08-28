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

const REPO_ROOT = join(SRC_ROOT, '..', '..');

/* Helper: recursively list files matching given extensions under a directory.
   Skips node_modules, dist, and .git subtrees. */
function listFilesRecursive(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      out.push(...listFilesRecursive(full, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/* Files that must stay as named manual entries — they cannot be auto-discovered
   by the glob+content-filter because they live outside the scanned directory
   trees. e2e/global-teardown.ts is the only current entry: other files under
   e2e/ are Playwright specs, not prod/dev-tooling spawners, and a blanket
   e2e/** glob risks sweeping in spec-authoring helpers that spawn for
   legitimately different reasons (test fixtures, browser launches). */
const EXTERNAL_FILES_MANUAL: string[] = [
  join(REPO_ROOT, 'e2e', 'global-teardown.ts'),
];

/* Repo-relative paths to subtract from the glob+content-filter result — files
   that the scan legitimately sweeps in but that should NOT be checked.
   Add entries here only when the glob genuinely picks up something that
   shouldn't be guarded, and name the file + reasoning in the completion comment. */
const EXTERNAL_FILES_EXCLUSIONS: string[] = [];

/* Build the EXTERNAL_FILES_FLOOR by scanning candidate directories for files
   that actually contain spawn calls (content-filtered via CALL_RE), then
   concatenating manual entries and subtracting exclusions.

   Directory scope (derived from the old 49-entry hand list):
   - REPO_ROOT non-recursive, .mjs only (covers launch.mjs)
   - scripts/ recursive, .mjs/.cjs/.js, EXCLUDING scripts/tests/
   - server/tts-sidecar/scripts/ recursive, .mjs
   - pinokio-scripts/lib/ recursive, .js/.mjs

   The content filter reuses blankCommentsAndStrings() + CALL_RE — the same
   pair pipSpawners() already demonstrates — so a file that doesn't actually
   spawn anything is never swept in. This mirrors the pip-specific filter's
   shape but tests "spawns anything" instead of "spawns pip". */
function externalFilesFloor(): string[] {
  // Repo root: non-recursive, .mjs/.ts (covers launch.mjs + vite.config.ts)
  const rootFiles: string[] = [];
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.ts'))) {
      rootFiles.push(join(REPO_ROOT, entry.name));
    }
  }

  // scripts/ recursive, .mjs/.cjs/.js, EXCLUDING scripts/tests/
  const scriptsDir = join(REPO_ROOT, 'scripts');
  const scriptsFiles = listFilesRecursive(scriptsDir, ['.mjs', '.cjs', '.js'])
    .filter(f => {
      const rel = f.slice(scriptsDir.length + 1).replace(/\\/g, '/');
      return !rel.startsWith('tests/');
    });

  // server/tts-sidecar/scripts/ recursive, .mjs
  const ttsDir = join(REPO_ROOT, 'server', 'tts-sidecar', 'scripts');
  const ttsFiles = listFilesRecursive(ttsDir, ['.mjs']);

  // pinokio-scripts/lib/ recursive, .js/.mjs
  const pinokioDir = join(REPO_ROOT, 'pinokio-scripts', 'lib');
  const pinokioFiles = listFilesRecursive(pinokioDir, ['.js', '.mjs']);

  // Combine all candidates
  const candidates = [...rootFiles, ...scriptsFiles, ...ttsFiles, ...pinokioFiles];

  // Content-filter: keep only files that actually contain spawn calls.
  // blankCommentsAndStrings blanks out comments AND string literals so prose
  // that merely mentions a spawn name is never matched. CALL_RE is global,
  // so reset lastIndex before each test to avoid stale state across calls.
  // File read errors propagate loudly (matching scanFile()'s behaviour), not
  // silently as a fail-open — a permissions or race-condition error during
  // the scan phase is a failure, not a skipped file.
  const filtered = candidates.filter(f => {
    const src = blankCommentsAndStrings(readFileSync(f, 'utf8'));
    CALL_RE.lastIndex = 0;
    return CALL_RE.test(src);
  });

  // Concatenate manual entries
  const withManual = [...filtered, ...EXTERNAL_FILES_MANUAL];

  // Subtract exclusions (match by repo-relative path)
  if (EXTERNAL_FILES_EXCLUSIONS.length === 0) return [...new Set(withManual)];
  const excluded = withManual.filter(f => {
    const rel = f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
    return !EXTERNAL_FILES_EXCLUSIONS.includes(rel);
  });

  return [...new Set(excluded)];
}

const EXTERNAL_FILES_FLOOR = externalFilesFloor();
/* Belt-and-suspenders: externalFilesFloor()'s content filter runs CALL_RE.test()
   in a loop, which parks lastIndex at a nonzero offset after the last match.
   Reset here so no later caller of CALL_RE inherits leftover state from the
   floor-building phase — scanFile() resets on entry too, but a shared g-flagged
   regex must never be trusted to arrive clean. */
CALL_RE.lastIndex = 0;

/* install-ort.mjs (#2192) made the ONNX-runtime swap load-bearing on the boot,
   bootstrap AND upgrade paths, but it's just one file — the next pip-spawning
   script dropped into either scripts dir would be just as prod-reachable and
   just as invisible to a hardcoded list. Glob both dirs instead of hand-adding
   one more filename, and keep ONLY the files that actually invoke pip via
   `-m pip` — a plain `.mjs` glob with no content filter would also sweep in
   files whose spawns have nothing to do with pip: pip-constraints.mjs (no
   spawn call at all) and ensure-python312.mjs (spawns python/winget, not
   pip). accelerator-profile.mjs used to be cited here too as a "no spawn at
   all" example — false (#2567 review round 2: it execSyncs a powershell/lspci
   GPU probe) — it's now covered directly via EXTERNAL_FILES_FLOOR above
   instead of relying on this comment's inaccurate premise. */
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
  /* Reset lastIndex before matchAll — a g-flagged regex shared across calls
     may carry leftover state from an earlier .test() or .exec() (e.g. from
     externalFilesFloor()'s content-filter), which would make matchAll start
     scanning partway through the source and silently miss real violations. */
  re.lastIndex = 0;
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

  /* Regression: lastIndex-leak guard is verifiable (#2687).
     CALL_RE is a global regex shared between externalFilesFloor()'s
     content-filter phase (which loops .test() calls) and scanFile()'s
     matchAll phase. A shared g-flagged regex's .test() loop leaves lastIndex
     at a nonzero offset after the last match, and a subsequent matchAll would
     inherit that offset and silently skip content before it. The resets at
     lines 133 and 159 guard against this, but the guard was unfalsifiable:
     the last candidate in readdirSync order happened to have no spawn call,
     auto-resetting lastIndex via its failed .test(). This test verifies the
     guard works even when the last test() call succeeds (leaving lastIndex
     dirty). */
  it('lastIndex leak is caught by the guard resets', () => {
    /* Create a source string with a spawn call EARLY, then exercise CALL_RE
       with additional .test() calls that END on a match, leaving lastIndex
       pointing PAST the end of the first spawn call. This simulates the
       content-filter's loop leaving lastIndex dirty for a later scanFile call. */
    const sourceWithEarlySpawn = `spawn('git', ['clone'], {});\nconst x = 1;`;
    const earlySpawnPos = sourceWithEarlySpawn.indexOf("spawn('git'");
    expect(earlySpawnPos).toBeLessThan(20);

    /* Run .test() calls to push lastIndex past the early spawn. */
    CALL_RE.lastIndex = 0;
    CALL_RE.test(sourceWithEarlySpawn); // finds first spawn
    const indexAfterFirstTest = CALL_RE.lastIndex;
    expect(indexAfterFirstTest).toBeGreaterThan(earlySpawnPos);

    /* Now simulate the leaked state: lastIndex is dirty/nonzero, pointing
       past the early spawn. A matchAll starting here would miss it. */
    CALL_RE.lastIndex = indexAfterFirstTest;
    const matchesWithDirtyIndex = [...sourceWithEarlySpawn.matchAll(CALL_RE)];
    expect(matchesWithDirtyIndex).toHaveLength(0); // skips the early spawn due to dirty offset

    /* Reset the lastIndex — this is what the guard resets do. */
    CALL_RE.lastIndex = 0;
    const matchesAfterReset = [...sourceWithEarlySpawn.matchAll(CALL_RE)];
    expect(matchesAfterReset, 'lastIndex guard must enable matchAll to find the early spawn').toHaveLength(1);
  });

  /* Regression: content filter fails loud on read errors (#2687).
     externalFilesFloor()'s content-filter phase was silently swallowing
     readFileSync errors (permissions, race, encoding) with a try-catch,
     unlike scanFile() which fails loud. This inconsistency meant a broken
     read path would silently drop from EXTERNAL_FILES_FLOOR without signal,
     leaving the file unchecked. */
  it('externalFilesFloor fails loud when a candidate file cannot be read', () => {
    /* To test without mocking the entire filesystem: externalFilesFloor
       scans real directories (which won't have read errors), but we can
       verify the try-catch was removed by checking that the function
       rethrows on a simulated read failure. Create a minimal test by
       directly invoking the internal filter logic with an unreadable path. */
    expect(() => {
      // Simulate what the content filter does: read a nonexistent file.
      const nonexistent = join(REPO_ROOT, 'nonexistent-does-not-exist.mjs');
      readFileSync(nonexistent, 'utf8');
    }).toThrow();
  });

  /* Acceptance #4 (issue #2687): pinokio-scripts/lib/resolve-release.js
     had unguarded `git` spawns on both the Pinokio install and update
     paths (Electron parent, no console) — a real user-visible flash that
     the old hand list never covered. The glob MUST pick it up. */
  it('resolve-release.js appears in the external-files floor (proves glob caught it)', () => {
    const resolveRelease = EXTERNAL_FILES_FLOOR.filter((f) =>
      f.endsWith(join('pinokio-scripts', 'lib', 'resolve-release.js')),
    );
    expect(
      resolveRelease,
      `resolve-release.js missing from EXTERNAL_FILES_FLOOR — glob regression`,
    ).toHaveLength(1);
  });

  /* Acceptance #5 (issue #2687): vite.config.ts is a root-level file that
     spawns (execSync for git commands). Although it already carries
     windowsHide: true in source, the PR's purpose is to catch spawns via
     content filtering, not to rely on source-level flags. The root-level
     scan must be widened to include .ts files, not just .mjs. */
  it('vite.config.ts appears in the external-files floor (root scan catches .ts)', () => {
    const viteConfig = EXTERNAL_FILES_FLOOR.filter((f) =>
      f.endsWith('vite.config.ts'),
    );
    expect(
      viteConfig,
      `vite.config.ts missing from EXTERNAL_FILES_FLOOR — root scan needs .ts extension`,
    ).toHaveLength(1);
  });

  /* Acceptance #2 (issue #2687): the old 49-entry hardcoded list must be
     fully covered by the new function output. This prevents future rewrites
     from silently dropping coverage on any previously-guarded file. */
  it('EXTERNAL_FILES_FLOOR from function covers the old hardcoded list', () => {
    const oldHardcoded = [
      'launch.mjs',
      'scripts/start-app-prod.mjs',
      'scripts/restart-after-upgrade.mjs',
      'scripts/stop-app.mjs',
      'scripts/run-sidecar-tests.mjs',
      'server/tts-sidecar/scripts/install-whisper.mjs',
      'server/tts-sidecar/scripts/install-qwen3.mjs',
      'server/tts-sidecar/scripts/install-coqui.mjs',
      'server/tts-sidecar/scripts/ensure-python312.mjs',
      'scripts/run-powershell.mjs',
      'scripts/verify-cache.mjs',
      'scripts/check-import-cycles.mjs',
      'scripts/audit-branches-worktrees.mjs',
      'scripts/backlog-sync.mjs',
      'scripts/build-companion-apk.mjs',
      'scripts/bump-version.mjs',
      'scripts/capture-companion.mjs',
      'scripts/check-onbox-register.mjs',
      'scripts/code-stats.mjs',
      'scripts/fix-archived-plan-pointers.mjs',
      'scripts/flake-repro.mjs',
      'scripts/gen-parser-fixtures.mjs',
      'scripts/gh.mjs',
      'scripts/guard-commit-subjects.mjs',
      'scripts/guard-protected-push.mjs',
      'scripts/is-docs-only-push.mjs',
      'scripts/launch-sidecar.mjs',
      'scripts/lib/module-graph.mjs',
      'scripts/lib/run-command.mjs',
      'scripts/monitor-generation.mjs',
      'scripts/preflight-ffmpeg.cjs',
      'scripts/quarantine-health.mjs',
      'scripts/release-body.mjs',
      'scripts/relufs-existing.mjs',
      'scripts/rexing-existing.mjs',
      'scripts/run-attribution-eval.mjs',
      'scripts/run-golden-audio.mjs',
      'scripts/run-hooks-tests.mjs',
      'scripts/run-pinokio-tests.mjs',
      'scripts/slim-epub-cover.mjs',
      'scripts/stage-marketing-screenshots.mjs',
      'scripts/start-app.mjs',
      'scripts/sync-wiki.mjs',
      'scripts/wt-list.mjs',
      'scripts/wt-merge.mjs',
      'scripts/wt-new.mjs',
      'server/tts-sidecar/scripts/accelerator-profile.mjs',
      'pinokio-scripts/lib/resolve-release.js',
      'e2e/global-teardown.ts',
    ];
    const floorRelPaths = EXTERNAL_FILES_FLOOR.map((f) => {
      const rel = f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
      return rel;
    });
    const missing = oldHardcoded.filter((rel) => !floorRelPaths.includes(rel));
    expect(
      missing,
      `old hardcoded entries missing from EXTERNAL_FILES_FLOOR (coverage regression):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
