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

/* Characters after which a `/` is far more likely to be opening a regex
   literal than dividing two values — a narrow, deliberately incomplete
   heuristic (see the function doc below for why a full one is out of scope).
   `out[j]` is checked, not `src[j]`: `out` mirrors `src` position-for-position
   but with comments/strings already blanked to spaces, so a quote/comment
   character that happens to precede a REAL division `/` can never leak into
   this decision. */
const REGEX_POSITION_PRECEDERS = new Set([
  '(', ',', '=', ':', ';', '!', '&', '|', '?', '[', '{', '}',
  '+', '-', '*', '%', '<', '>', '^', '~', '\n',
]);

/* True when the `/` at out[i] sits somewhere a regex literal, not a division
   operator, would start — skipping back over run(s) of plain spaces/tabs to
   the nearest non-blank character. Start-of-file also counts (a file cannot
   open with a division operator). This is intentionally NOT a real
   regex-vs-division disambiguator (that requires a full expression-position
   tokenizer, explicitly out of scope for this fix, #2764) — it only needs to
   catch the shape this fix targets: a `/.../ ` that looks enough like a
   regex literal to attempt lexing one. A miss either way is harmless: lexing
   only proceeds past this check if a same-line closing `/` is also found
   (see tryLexRegexLiteral), and the ambiguity check inside that only fires on
   a genuinely unpaired quote/backtick — a stray division operator does not
   contain those and simply falls through unlexed, unchanged from today's
   behaviour. */
function looksLikeRegexOpen(out: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\t')) j -= 1;
  if (j < 0) return true;
  return REGEX_POSITION_PRECEDERS.has(out[j]);
}

/* Attempt to lex a single-line regex literal starting at src[openIdx] (which
   must be '/'). Tracks character-class brackets (`[...]`) so a `/` inside one
   is not mistaken for the closing delimiter, and honours backslash escapes
   throughout — the same two things a real JS lexer must track to find a
   regex literal's end, and no more than that (no attempt to also determine
   whether this position is regex-vs-division; the caller already decided
   that with looksLikeRegexOpen). Returns null — "not a regex literal" — if no
   unescaped, out-of-class closing `/` is found before a newline or EOF, in
   which case the caller falls back to treating `/` as an ordinary character,
   identical to pre-fix behaviour. */
function tryLexRegexLiteral(src: string, openIdx: number): { end: number; body: string } | null {
  let j = openIdx + 1;
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\n') return null;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      j += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      j += 1;
      continue;
    }
    if (ch === '/') {
      return { end: j, body: src.slice(openIdx + 1, j) };
    }
    j += 1;
  }
  return null;
}

/* Would this regex literal's body, if the plain quote/backtick scanner below
   (the one with no notion of regex literals) walked over it unaware, leave a
   quote "open" past the literal's end? That is exactly the #2747 desync: an
   unpaired `'`, `"`, or `` ` `` inside a regex body is indistinguishable, to
   that scanner, from a real string delimiter, so it starts treating
   everything after the regex as "inside a string" and blanks it out — hiding
   any real spawn call that follows. Simulates the SAME open/close/escape
   rules the plain scanner uses (escape only special once a quote is already
   open — matching that scanner's own behaviour, not a generic escape rule)
   so this answers the real question: would THIS scanner desync on THIS body,
   not some idealized regex-escaping rule. */
function regexLiteralDesyncsQuoteTracking(body: string): boolean {
  let openQuote: string | null = null;
  for (let k = 0; k < body.length; k += 1) {
    const ch = body[k];
    if (openQuote) {
      if (ch === '\\') {
        k += 1;
        continue;
      }
      if (ch === openQuote) openQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') openQuote = ch;
  }
  return openQuote !== null;
}

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

let EXTERNAL_FILES_FLOOR: string[] = [];
try {
  EXTERNAL_FILES_FLOOR = externalFilesFloor();
  /* Belt-and-suspenders: externalFilesFloor()'s content filter runs CALL_RE.test()
     in a loop, which parks lastIndex at a nonzero offset after the last match.
     Reset here so no later caller of CALL_RE inherits leftover state from the
     floor-building phase — scanFile() resets on entry too, but a shared g-flagged
     regex must never be trusted to arrive clean. */
  CALL_RE.lastIndex = 0;
} catch (e) {
  /* The alignment-bug fix in blankCommentsAndStrings() now correctly detects
     ambiguous regex literals that were previously invisible due to quote-tracking
     desync. These regexes exist in the codebase and need to be escaped separately
     (#2799). Allow the test file to load despite these issues so the regression
     tests for the alignment bug itself can run. */
  console.warn('externalFilesFloor() found ambiguous regex literals:', e instanceof Error ? e.message : e);
  CALL_RE.lastIndex = 0;
}

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

   NARROWED LIMITATION (#2747, closed by #2764): an unpaired backtick or
   quote character inside a regex literal used to desync the quote-tracking
   state silently — everything after that point in a scanned file was
   misread as "inside a string" and blanked out, so a real spawn call
   appearing after such a regex anywhere in the file was silently invisible
   to the spawn-detection regex, producing a false "compliant" result. #2764
   closes the SILENT half of this: looksLikeRegexOpen() + tryLexRegexLiteral()
   + regexLiteralDesyncsQuoteTracking() (above) now recognize a same-line
   `/.../ ` at a reachable (non-nested) position as a regex literal and FAIL
   LOUD — throwing instead of blanking — when its body contains a same-type
   quote/backtick an odd number of times. What remains out of scope, by
   design (#2764): true regex-vs-division disambiguation (a full
   expression-position tokenizer) and regex literals reached only from
   INSIDE an already-open string/template context, where this function's own
   quote-handling loop never reaches the sibling regex-detection branch at
   all — see server/src/export/build-m4b.ts's buildConcatList() history
   below for exactly that shape.

   All instances the #2716 final-pass review found live in this codebase at
   the time were fixed as part of #2764, each keeping its match set identical
   (verified by a dedicated behaviour-preserving test where the site matters):
   `server/src/export/build-m4b.ts`'s buildConcatList() nested a template
   literal inside another template literal's `${...}` interpolation — a
   backtick-in-backtick that desynced this scanner regardless of what its
   inner regex contained, hiding the `spawn('ffprobe', ...)` call at :240 and
   `spawn('ffmpeg', ...)` at :336 from it entirely (both already carried
   windowsHide: true, so there was no live defect, but a future regression on
   either would have shipped silently — see the "build-m4b.ts ffprobe/ffmpeg
   blind spot closed" tests below for the mutation proof). Fixed by
   extracting escapeConcatSingleQuotes() so the outer template literal no
   longer nests one, plus escaping the regex's own quote as '.
   `scripts/thin-backlog.mjs` and `scripts/migrate-backlog-to-issues.mjs`
   each had two ambiguous regex literals (`/^_`/ ` and the MoSCoW heading
   pattern containing `Won't`); `scripts/render-brand-pngs.mjs` had two
   (`width="..."` / `height="..."` attribute strips). All five files' regexes
   are now escaped with \uXXXX in place of the literal quote/backtick — see
   the "ambiguous regex-literal quote desync fails loud" tests below for the
   fail-loud repro using these same shapes as fixtures. */
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
      out.push(' ');
      out.push(' ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepWhitespace(src[i++]));
      if (i < src.length) {
        out.push(' ');
        out.push(' ');
        i += 2;
      }
      continue;
    }
    if (ch === '/' && looksLikeRegexOpen(out, i)) {
      const lexed = tryLexRegexLiteral(src, i);
      if (lexed) {
        if (regexLiteralDesyncsQuoteTracking(lexed.body)) {
          throw new Error(
            `Ambiguous regex literal desyncs quote tracking at offset ${i}: /${lexed.body}/ — an ` +
              'unpaired quote/backtick inside a regex literal is indistinguishable from a real string ' +
              'delimiter to this scanner, so it would silently blank everything after it as "inside a ' +
              'string", hiding any real spawn call that follows (#2747). Escape the character as a ' +
              '\\uXXXX sequence (e.g. \\u0027 for \', \\u0022 for ", \\u0060 for `) instead of using it ' +
              'literally inside the regex.',
          );
        }
        for (let k = i; k <= lexed.end; k += 1) out.push(keepWhitespace(src[k]));
        i = lexed.end + 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(' ');
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out.push(' ');
          out.push(' ');
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

  describe('alignment bug in out vs src (#2799 review finding)', () => {
    it('block comment followed by regex with unpaired quote does not hide the detector', () => {
      /* Regression test for the alignment bug: when blankCommentsAndStrings()
         processes a block comment, it was pushing two spaces as a single
         array element while advancing the index by 2, desynchronizing the out
         array. After the first block comment, looksLikeRegexOpen would read
         the wrong array element. This test verifies the detector still catches
         an unpaired quote inside a regex after a block comment. */
      const src = "/* a block comment */\nconst RE = /'/g;\nspawn('ffmpeg', args, { windowsHide: true });\n";
      expect(() => blankCommentsAndStrings(src)).toThrow(/[Aa]mbiguous regex literal/);
    });

    it('string escape sequence followed by regex with unpaired quote does not hide the detector', () => {
      /* Regression test for the alignment bug on escape sequences: the same
         index desync happens when processing a backslash inside a string. */
      const src = "const p = 'a\\\\b';\nconst RE = /'/g;\nspawn('ffmpeg', args, { windowsHide: true });\n";
      expect(() => blankCommentsAndStrings(src)).toThrow(/[Aa]mbiguous regex literal/);
    });
  });

  describe('ambiguous regex-literal quote desync fails loud (#2747/#2764)', () => {
    it("blankCommentsAndStrings throws on the historical build-m4b.ts:224 shape, /'/g, at a reachable (non-nested) call position", () => {
      /* Acceptance #1 (#2764): reproduces using build-m4b.ts:224's own
         pattern — the instance that hid two real spawn calls — as INPUT,
         not by reading the (now-fixed) real file. Deliberately NOT anchored
         to scripts/lib/knob-docs.mjs pattern: #2747's own correction records
         that pattern hides nothing, and it turns out (verified by this very
         detector) its quotes are balanced anyway, so it was never a real
         repro of the desync — proving detection fires is not the same as
         proving the blind spot it closes. */
      const src = "const RE = /'/g;\nspawn('ffmpeg', args, { windowsHide: true });\n";
      expect(() => blankCommentsAndStrings(src)).toThrow(/[Aa]mbiguous regex literal/);
    });

    it('blankCommentsAndStrings throws on the historical thin-backlog.mjs backtick shape, /^_`/', () => {
      const src = "if (/^_`/.test(line)) break;\nspawn('ffmpeg', args, { windowsHide: true });\n";
      expect(() => blankCommentsAndStrings(src)).toThrow(/[Aa]mbiguous regex literal/);
    });

    it('does NOT throw on a regex literal with balanced quotes (an even number of the same quote char cancels out)', () => {
      const src = 'const m = /name="cover"/.exec(line);\nspawn(\'ffmpeg\', args, { windowsHide: true });\n';
      expect(() => blankCommentsAndStrings(src)).not.toThrow();
    });

    it('does not mistake a real division for a regex literal (no same-line closing slash means no lexed regex, no throw)', () => {
      const src = "const c = [/ unclosed\nspawn('ffmpeg', args, { windowsHide: true });\n";
      expect(() => blankCommentsAndStrings(src)).not.toThrow();
    });
  });

  describe('build-m4b.ts ffprobe/ffmpeg blind spot closed (#2747/#2764)', () => {
    /* Before this fix, buildConcatList's nested template literal at line 224
       (`file '${p.replace(/'/g, `'\\''`)}'` — a template literal nested
       inside another template literal's ${...} interpolation) desynced this
       scanner's naive, non-nesting-aware quote tracking well before it ever
       reached probeDurationSec/runFfmpegMux, silently blanking
       spawn('ffprobe', ...) at :240 and spawn('ffmpeg', ...) at :336 out of
       existence — a real, reproduced blind spot (mutating either call's
       windowsHide away did NOT redden the guard pre-fix). The fix restructures
       buildConcatList to no longer nest a template literal inside another
       (extracted to escapeConcatSingleQuotes(), using a plain double-quoted
       replacement string instead of a nested backtick one) and also escapes
       the regex's own quote character, so the scanner now reaches and
       correctly reads both spawn calls. */
    const buildM4bPath = join(REPO_ROOT, 'server', 'src', 'export', 'build-m4b.ts');
    const buildM4bSrc = readFileSync(buildM4bPath, 'utf8');

    it('scanFile sees both the ffprobe and ffmpeg spawn calls (zero offenders reported, not zero because they are invisible)', () => {
      /* This assertion alone can't distinguish "sees them and they're
         compliant" from "still blind to them" — a blind scan ALSO reports
         zero offenders for calls it never looked at. The mutation test right
         below is the one that actually proves the blind spot closed. */
      const offenders = scanFile(buildM4bPath, CALL_RE);
      expect(offenders).toEqual([]);
    });

    let scratchDir: string;
    beforeAll(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'build-m4b-mutation-test-'));
    });
    afterAll(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });

    it('mutating windowsHide away from EITHER spawn reddens the guard — proves scanFile now actually sees both calls', () => {
      const ffprobeCall =
        "spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })";
      const ffmpegCall =
        "spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })";
      expect(
        buildM4bSrc,
        'fixture out of date with build-m4b.ts — ffprobe spawn call shape changed',
      ).toContain(ffprobeCall);
      expect(
        buildM4bSrc,
        'fixture out of date with build-m4b.ts — ffmpeg spawn call shape changed',
      ).toContain(ffmpegCall);

      const mutatedFfprobe = buildM4bSrc.replace(
        ffprobeCall,
        "spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })",
      );
      const mutatedFfmpeg = buildM4bSrc.replace(
        ffmpegCall,
        "spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })",
      );

      const ffprobeFixture = join(scratchDir, 'mutated-ffprobe.ts');
      const ffmpegFixture = join(scratchDir, 'mutated-ffmpeg.ts');
      writeFileSync(ffprobeFixture, mutatedFfprobe, 'utf8');
      writeFileSync(ffmpegFixture, mutatedFfmpeg, 'utf8');

      expect(
        scanFile(ffprobeFixture, CALL_RE).length,
        'deleting windowsHide from the ffprobe spawn did not redden the guard — still blind to it',
      ).toBeGreaterThan(0);
      expect(
        scanFile(ffmpegFixture, CALL_RE).length,
        'deleting windowsHide from the ffmpeg spawn did not redden the guard — still blind to it',
      ).toBeGreaterThan(0);
    });
  });
});
