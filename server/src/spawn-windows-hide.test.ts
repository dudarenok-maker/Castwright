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

import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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

/* Content-filter step, extracted as its own function so it's independently
   testable against an explicit candidate list — not just via the real
   directory scan, whose enumeration order isn't something a test should
   depend on for determinism.

   Keeps only candidates that actually contain a spawn call.
   blankCommentsAndStrings blanks out comments AND string literals so prose
   that merely mentions a spawn name is never matched. CALL_RE is global, so
   lastIndex is reset before EVERY candidate's .test() call — without this,
   a candidate whose match leaves lastIndex parked mid-string would cause the
   NEXT candidate's .test() to start scanning partway through its own source
   (or past its end entirely for a short file), silently excluding it from
   the floor even though it does spawn something.

   File read errors propagate loudly (matching scanFile()'s behaviour), not
   silently as a fail-open — a permissions or race-condition error during the
   scan phase is a failure, not a skipped file. */
function filterSpawningFiles(candidates: string[]): string[] {
  return candidates.filter(f => {
    const src = blankCommentsAndStrings(readFileSync(f, 'utf8'));
    CALL_RE.lastIndex = 0;
    return CALL_RE.test(src);
  });
}

/* Subtract EXTERNAL_FILES_EXCLUSIONS-style entries (repo-relative paths) from
   an absolute-path file list. Extracted as its own function so the exclusion
   mechanism itself is exercised by a test — EXTERNAL_FILES_EXCLUSIONS is
   empty today, which without a dedicated test leaves this whole branch
   (pass-3/final-pass review, #2716: an "untested disarm lever") dead code
   that could silently stop excluding, or silently start over-excluding, with
   nothing to catch either direction. */
function applyExclusions(files: string[], exclusions: string[]): string[] {
  if (exclusions.length === 0) return [...new Set(files)];
  const kept = files.filter(f => {
    const rel = f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
    return !exclusions.includes(rel);
  });
  return [...new Set(kept)];
}

/* Build the EXTERNAL_FILES_FLOOR by scanning candidate directories for files
   that actually contain spawn calls (content-filtered via CALL_RE), then
   concatenating manual entries and subtracting exclusions.

   Directory scope (derived from the old 49-entry hand list):
   - REPO_ROOT non-recursive, .mjs/.ts (covers launch.mjs, vite.config.ts)
   - scripts/ recursive, .mjs/.cjs/.js, EXCLUDING scripts/tests/
   - server/tts-sidecar/scripts/ recursive, .mjs
   - pinokio-scripts/lib/ recursive, .js/.mjs

   The content filter reuses blankCommentsAndStrings() + CALL_RE to avoid
   matching spawn names that merely appear in comments or strings, so a file
   that doesn't actually spawn anything is never swept in. */
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
  const filtered = filterSpawningFiles(candidates);

  // Concatenate manual entries
  const withManual = [...filtered, ...EXTERNAL_FILES_MANUAL];

  return applyExclusions(withManual, EXTERNAL_FILES_EXCLUSIONS);
}

const EXTERNAL_FILES_FLOOR = externalFilesFloor();
/* Belt-and-suspenders: externalFilesFloor()'s content filter runs CALL_RE.test()
   in a loop, which parks lastIndex at a nonzero offset after the last match.
   Reset here so no later caller of CALL_RE inherits leftover state from the
   floor-building phase — scanFile() resets on entry too, but a shared g-flagged
   regex must never be trusted to arrive clean. */
CALL_RE.lastIndex = 0;

/* pipSpawners() was a narrower pip-specific scan over scripts/ and
   server/tts-sidecar/scripts/. It is now superseded by externalFilesFloor()'s
   content filter (CALL_RE — "does this file spawn anything") which is a strict
   superset of the old PIP_SPAWN_RE check ("does this file spawn pip"). Anything
   pipSpawners() would have found is already caught by the broader scan, so it
   has been removed as dead code per #2736. */
const EXTERNAL_FILES = EXTERNAL_FILES_FLOOR;

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
   disambiguate a `//` inside a string from a real line comment.

   KNOWN LIMITATION (#2747): an unpaired backtick or quote character inside a
   regex literal (e.g., /^`+|`+$/g — this exact pattern appears in
   scripts/lib/knob-docs.mjs) will desync the quote-tracking state, causing
   everything after that point in the file to be misread as "inside a
   string" and blanked out. This means a real spawn call appearing after such
   a regex literal anywhere in a scanned file would be silently invisible to
   the spawn-detection regex, producing a false "compliant" result. This is a
   real, reproduced gap, not theoretical. Correctly fixing this requires real
   parsing to distinguish a regex literal from a division operator, and is a
   design-level decision, not a quick patch. See issue #2747 for details. */
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

  describe('lastIndex-leak and fail-open regressions (#2716 PR review, pass 2)', () => {
    /* A scratch dir with throwaway fixture files, NOT under any directory
       externalFilesFloor() scans — these tests call filterSpawningFiles()/
       scanFile() directly with explicit candidate lists, so real directory
       enumeration order (which a test must never depend on for determinism)
       never enters the picture. Created in a beforeAll, removed in an
       afterAll — not an assertion-free `it()` (pass-3 review, #2716: an
       `it()` doesn't run after an earlier failing assertion with --bail,
       leaking the scratch dir; fixed by using a real afterAll instead).
       Creation ALSO moved into beforeAll rather than staying a plain
       describe-body statement (final-pass review, #2716: a plain statement
       runs at collection time regardless of filtering, so an `it.only`/`-t`
       filter that skips every test in this describe still created the
       directory while skipping the afterAll that would have cleaned it up —
       Vitest skips a suite's hooks entirely when every test in it is
       filtered out, so keeping creation IN a hook too makes it symmetric
       with cleanup: both run, or neither does). */
    let scratchDir: string;
    beforeAll(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'spawn-windows-hide-test-'));
    });
    afterAll(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });

    it('scanFile resets lastIndex, so a leaked offset does not hide an early real offender', () => {
      /* Round-2 review found the original version of this test asserted
         ECMAScript matchAll()/.test() semantics on synthetic strings without
         ever calling scanFile() — true regardless of whether this file's own
         `re.lastIndex = 0` reset (scanFile's first line) exists. This version
         calls the REAL scanFile() against a real file, with CALL_RE dirtied
         to an offset that only scanFile()'s own reset can clear. */
      const fixture = join(scratchDir, 'lastindex-fixture.mjs');
      const content = `execSync('echo hi');\n`; // unguarded spawn at offset 0
      writeFileSync(fixture, content, 'utf8');

      // Dirty CALL_RE.lastIndex to a value well past the fixture's length —
      // if scanFile() does NOT reset it, matchAll starts scanning from here
      // (past EOF) and finds nothing.
      CALL_RE.lastIndex = 1000;
      const offenders = scanFile(fixture, CALL_RE);
      CALL_RE.lastIndex = 0; // don't leak dirty state into later tests

      expect(
        offenders,
        'scanFile() missed an offender at the start of the file — the lastIndex reset at its own top is not load-bearing',
      ).toHaveLength(1);
    });

    it('filterSpawningFiles resets lastIndex per candidate, so a dirty leftover cannot hide the NEXT candidate', () => {
      /* Candidate A's spawn call, once matched by CALL_RE.test(), parks
         lastIndex well past candidate B's entire (short) length. If
         filterSpawningFiles() does not reset lastIndex before EVERY
         candidate's .test() call, candidate B's .test() starts scanning from
         that leaked offset — past its own end — and wrongly reports "no
         spawn found", excluding a file that genuinely spawns something. */
      const fixtureA = join(scratchDir, 'a-leaves-dirty-lastindex.mjs');
      const fixtureB = join(scratchDir, 'b-short-real-spawner.mjs');
      writeFileSync(fixtureA, `// padding so the match position is not 0\nexecSync('a');\n`, 'utf8');
      writeFileSync(fixtureB, `spawn('b');\n`, 'utf8'); // short — well within A's leaked offset

      const result = filterSpawningFiles([fixtureA, fixtureB]);

      expect(result, 'candidate A did not survive its own filter pass').toContain(fixtureA);
      expect(
        result,
        'candidate B was silently dropped — a dirty lastIndex leaked from candidate A into candidate B\'s .test() call',
      ).toContain(fixtureB);
    });

    it('filterSpawningFiles fails loud when a candidate cannot be read, not silently drop it', () => {
      /* Calls the REAL function this time (unlike the original version of
         this test, which only proved Node's fs module throws on a missing
         path — never touching externalFilesFloor()'s own code at all). */
      const missing = join(scratchDir, 'does-not-exist.mjs');
      expect(() => filterSpawningFiles([missing])).toThrow();
    });

    /* Final-pass review, #2716: EXTERNAL_FILES_EXCLUSIONS is empty today,
       which — without a test exercising the subtraction step itself —
       leaves that whole branch untested: it could silently stop excluding a
       named entry, or a future edit could silently start over-excluding,
       and nothing would catch either direction. */
    it('applyExclusions actually removes a matching entry and leaves the rest', () => {
      const kept = join(REPO_ROOT, 'scripts', 'kept-example.mjs');
      const excluded = join(REPO_ROOT, 'scripts', 'excluded-example.mjs');
      const result = applyExclusions([kept, excluded], ['scripts/excluded-example.mjs']);
      expect(result).toContain(kept);
      expect(result).not.toContain(excluded);
    });

    it('applyExclusions is a no-op passthrough (deduped) when the exclusion list is empty', () => {
      const a = join(REPO_ROOT, 'scripts', 'a.mjs');
      expect(applyExclusions([a, a], [])).toEqual([a]);
    });
  });

  /* Acceptance #4 (issue #2687): pinokio-scripts/lib/resolve-release.js
     had unguarded `git` spawns on both the Pinokio install and update
     paths (Electron parent, no console) — a real user-visible flash that
     the old hand-maintained list covered manually. The new glob-based scan
     MUST continue to pick it up. */
  it('resolve-release.js appears in the external-files floor (proves glob caught it)', () => {
    const resolveRelease = EXTERNAL_FILES_FLOOR.filter((f) =>
      f.endsWith(join('pinokio-scripts', 'lib', 'resolve-release.js')),
    );
    expect(
      resolveRelease,
      `resolve-release.js missing from EXTERNAL_FILES_FLOOR — glob regression`,
    ).toHaveLength(1);
  });

  /* #2716 PR review, pass 1: vite.config.ts is a root-level file that spawns
     (execSync for git commands). #2687's original spec scoped the root scan
     to .mjs only (it did not name vite.config.ts) — this widening to .ts was
     added afterward, in review, once vite.config.ts's own unguarded spawn was
     found. Although it already carries windowsHide: true in source, the
     guard's purpose is to catch spawns via content filtering, not to rely on
     source-level flags staying correct. */
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
