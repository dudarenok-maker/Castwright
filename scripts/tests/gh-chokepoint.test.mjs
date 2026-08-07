// #2184 — every script under scripts/ that spawns the `gh` CLI must go
// through the shared chokepoint (scripts/gh.mjs's gh()/ghSpawn()), which
// unconditionally scrubs the GIT_DIR/GIT_WORK_TREE-family env vars
// (scripts/git-env.mjs) and defaults `cwd` to repoRoot. Before this, 14 call
// sites across 12 scripts each grew their own local `gh()`/`ghAvailable()`
// helper (or an inline execFileSync/spawnSync call) and NONE of them
// scrubbed — see scripts/gh.mjs's header for the full incident history
// (#2169, #2175).
//
// This guard replaces scripts/tests/bump-version.test.mjs's old
// "every gh() / ghAvailable() / gh run watch call site scrubs its env" test,
// which slices bump-version.mjs's source around three hardcoded function
// names — it protected exactly those three call sites and nothing else, so
// it couldn't have caught the other 11 that turned out to exist (the whole
// premise of #2184's decision comment: "the issue's list ... is incomplete").
// This test asserts the STRONGER, structural invariant instead: no
// JS/TS script anywhere under scripts/ may invoke the `gh` binary directly,
// except scripts/gh.mjs itself. A call site nobody has thought of yet fails
// this by default, which is the entire point. (PowerShell/Python scripts
// under scripts/ are NOT scanned — see KNOWN BLIND SPOTS below; "no script"
// in this file's test name/assertions means the JS/TS family specifically.)
//
// Detection strategy: read every scripts/**/*.{mjs,cjs,js,mts,cts,ts} file
// as source text (no real `gh` process is ever spawned — see
// bump-version.test.mjs's sibling comment on why that's impractical
// cross-platform) and pattern-match two shapes:
//   1. ANY call expression whose first OR second argument is the literal
//      string 'gh', "gh", or `gh`, immediately followed by a comma —
//      matched on the ARGUMENT, not the callee's name. The second-argument
//      case exists for `runCommand(label, 'gh', args)` — runCommand's real
//      signature (scripts/lib/run-command.mjs) puts the binary name second,
//      behind a label — and is recognized only when the leading (label)
//      argument is a simple token: a bare identifier, a number, or a
//      quoted string (see KNOWN BLIND SPOTS for what that excludes). This
//      is what catches a custom local wrapper (`run('gh', …)` — the actual
//      shape
//      generate-release-notes-wiki.mjs shipped with until this same round: a
//      real chokepoint bypass this guard originally MISSED, because the
//      first version only recognized execFileSync/spawnSync and their
//      tracked node:child_process import aliases, not an arbitrary wrapper
//      function that happens to forward to one of those internally) exactly
//      as readily as a direct `execFileSync('gh', …)` or an aliased import
//      (`import { execFileSync as _x } from 'node:child_process'` then
//      `_x('gh', …)`) — callee identity no longer matters at all for this
//      shape. The trailing-comma requirement is what makes backtick a safe
//      quote char here: every real `gh`-spawning call passes at least one
//      more argument (the args array, or an options object) after the
//      binary name, so the closing quote is always followed by a comma —
//      but bump-version.mjs's own error-message prose, `'...GitHub CLI
//      (\`gh\`) authenticated, but \`gh\` was not found...'`, closes its
//      first backtick-quoted "gh" with `)`, not `,` (prose, not a call), so
//      it stays unmatched even with backtick included in the quote class.
//      An EARLIER version of this rule dropped backtick entirely to dodge
//      that same false positive — but that also silently stopped catching
//      a backtick-quoted real call (`run(\`gh\`, …)`), which is worse: an
//      undocumented hole, not a documented trade-off. The comma requirement
//      closes the false positive without giving up backtick coverage.
//   2. execSync('gh ...') / exec('gh ...') — a single shell-command string
//      whose first token is "gh". This shape stays scoped to the four
//      canonical node:child_process entry points (plus any local alias a
//      file's own `import { … } from 'node:child_process'` declares for
//      them, per 9fe14ded) — generalizing it the same way as shape 1 would
//      false-positive on any ordinary string that merely starts with "gh "
//      (e.g. prose) passed to an unrelated function, which shape 1 avoids
//      only because it requires an EXACT 'gh'/"gh" argument, not a prefix
//      match.
//
// Each file is scanned for its own `import { … } from 'node:child_process'`
// statement first, and any local alias bound there to execSync/exec is added
// to shape 2's recognized names. Shape 1 needs no such tracking anymore —
// it no longer restricts by callee name at all, so an aliased import is
// already covered by "any callee" without special-casing it.
//
// Inline pragma: a line whose text contains the literal `gh-chokepoint-allow`
// is excluded from both shapes entirely (#2203 review Finding F5). The scan
// is raw text with no comment- or string-stripping, so it has no way to tell
// a real call apart from a comment merely documenting one (e.g.
// `// don't write execFileSync('gh', […]) here`) or a test assertion whose
// shape coincides (`assert.equal('gh', recorded[0])` reads as a call to
// `equal` with 'gh' as its first argument). The pragma is the escape hatch
// for exactly that: put it on the offending line and the scanner skips it.
// It suppresses ONE line, not a file or a block — there is no
// pragma-disable/pragma-enable pairing, deliberately, so a stray pragma
// can't silently blind the scanner to everything after it.
//
// KNOWN BLIND SPOTS (a source-text scan can't see everything):
//   - The binary held in a variable (`const bin = 'gh'; execFileSync(bin, …)`
//     or `run(bin, …)`) is NOT caught — this scanner only recognizes a
//     LITERAL 'gh'/"gh"/`gh` string as the call's own argument text, it does
//     not do any data-flow analysis.
//   - A command string built by concatenation split across an expression
//     (e.g. `execSync('g' + 'h ...')`) is NOT caught, same reason.
//   - Shape 2 (the full shell-command-string call) is still scoped to the
//     four canonical node:child_process entry points and their tracked
//     aliases — a custom wrapper that forwards a shell string internally
//     (`function runShell(cmd) { return execSync(cmd); }` called as
//     `runShell('gh issue list')`) is NOT caught, because the literal
//     'gh issue list' text never appears as an argument to execSync/exec
//     at THAT call site — only shape 1's exact-'gh'-argument case was
//     generalized to an arbitrary callee.
//   - Shape 1 requires a comma after the closing quote (the trade for
//     letting backtick back into the quote class without reopening the
//     bump-version.mjs prose false positive — see the shape-1 comment
//     above). A call whose ONLY argument is the literal 'gh'/"gh"/`gh`
//     itself, with nothing after it — e.g. `probe('gh')` — is NOT caught.
//     No real call site in this repo is shaped that way today (every real
//     `gh` invocation also passes an args array and/or an options object),
//     so this is a live, deliberate trade-off, not an accident — flagged
//     here so it stays a documented one.
//   - Shape 1's second-argument case (`runCommand(label, 'gh', args)`) only
//     recognizes a SIMPLE leading token — a bare identifier, a number, or a
//     quoted string — immediately before the 'gh' argument. A leading
//     argument that is itself a call, a template literal with
//     interpolation, a computed/member expression, or any other non-trivial
//     expression is NOT recognized, because the scanner does not parse
//     balanced parens/brackets in that position — e.g.
//     `runCommand(buildLabel(x), 'gh', args)` is NOT caught. No real call
//     site in this repo passes anything but a plain string literal as
//     runCommand's `label`, so this is latent, not live.
//   - A binary-name variant — `execFileSync('gh.exe', …)`,
//     `execFileSync('/usr/bin/gh', …)`, or any other path/extension form
//     that isn't the exact 4-character token `gh` — is NOT caught; this
//     scanner matches the literal string 'gh' only.
//   - The obfuscation class — computed member access
//     (`cp['exec' + 'FileSync']('gh', …)`), `.call`/`.apply`, a
//     comma-expression, an optional call (`fn?.('gh', …)`), or an inline
//     comment wedged between the 'gh' literal and its comma — is
//     structurally out of reach for a source-text regex scan; a real parser
//     (or an ESLint AST rule) would be needed to close that class, and this
//     file does not attempt to.
//   - Non-JS/TS scripts under scripts/ (11 `.ps1`, 3 `.psm1`, 4 `.py`) are
//     entirely OUT OF SCOPE — `listScriptFiles()` below only walks the
//     JS/TS family. No `gh` invocation exists in any of them today (a
//     PowerShell `gh …` or Python `subprocess.run(['gh', …])` call would
//     need its own, differently-shaped pattern), so this is a documented
//     gap, not a silent one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '..');
const repoRoot = resolve(scriptsDir, '..');
const ghWrapperPath = resolve(scriptsDir, 'gh.mjs');
// This file's own source is excluded from the repo-wide scan below — its
// synthetic fixture strings and comments deliberately CONTAIN the literal
// patterns the scanner looks for (that's the whole point of the mutation
// tests further down), so scanning this file as if it were a production
// script would self-trigger on every one of those fixtures. No other file
// under scripts/tests/ does this (verified: nothing else matches either
// pattern below except gh.mjs and this file) — a real `gh`-calling test file
// would still be caught.
const selfPath = resolve(here, 'gh-chokepoint.test.mjs');

// A quote char shared by shape 2 below: ', ", or `.
const Q = `['"\`]`;

// The canonical node:child_process entry points shape 2 recognizes by
// default, before any per-file import-alias is added to them.
const SHELL_CANONICAL_NAMES = ['execSync', 'exec'];

// Matches `import { … } from 'node:child_process'` (single- or
// double-quoted module specifier only — a backtick can't legally appear
// there, so Q is deliberately not reused for this one). `[^}]*` spans
// newlines with no `/s` flag needed, so a specifier list broken across
// multiple lines is still captured whole.
const CHILD_PROCESS_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])node:child_process\2/g;

/** Finds every local alias this file's own `node:child_process` import(s)
 *  bind to execSync/exec — e.g. `import { execSync as sh } from
 *  'node:child_process'` adds 'sh' to shape 2's recognized names. Names with
 *  no alias present resolve to themselves, and are already covered by the
 *  canonical defaults below, so only actual `as`-renames add anything new.
 *  Returns a Set seeded with the canonical names. */
function collectShellAliases(source) {
  const shell = new Set(SHELL_CANONICAL_NAMES);
  CHILD_PROCESS_IMPORT_RE.lastIndex = 0;
  let importMatch;
  while ((importMatch = CHILD_PROCESS_IMPORT_RE.exec(source))) {
    const specifiers = importMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specifiers) {
      const [imported, local = imported] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (SHELL_CANONICAL_NAMES.includes(imported)) shell.add(local);
    }
  }
  return shell;
}

// Shape 1: any call expression whose first OR SECOND argument is the
// literal string 'gh', "gh", or `gh` — the callee can be ANY identifier (or
// property-access name), not just execFileSync/spawnSync or a tracked alias
// of them. This is what catches a custom local wrapper (`run('gh', …)`) as
// readily as a direct call — AND `runCommand(label, 'gh', args)`'s
// signature, where the binary name sits second, behind a label (#2203
// review Finding F2: `DIRECT_CALL_RE` used to require 'gh' to be the FIRST
// argument, so `runCommand('probe', 'gh', […])` was invisible to it — the
// most realistic evasion of the ones reviewed, since sync-wiki.mjs already
// imports runCommand directly and the bypass this branch just fixed
// (generate-release-notes-wiki.mjs) was a two-line alias over exactly this
// function). The optional leading token before 'gh' is matched only when
// it's a SIMPLE one — a bare identifier, a number, or a quoted string — not
// an arbitrary expression (see KNOWN BLIND SPOTS). The closing quote around
// 'gh' itself must be followed by a comma (optionally preceded by
// whitespace) — every real `gh`-spawning call passes at least one more
// argument after the binary name, so this is never a real call site's own
// coverage cost; it's what lets backtick stay in the quote class without
// reopening the bump-version.mjs prose false positive (see header comment).
// This also means nothing but a matching close-quote may follow "gh" itself
// (so this never matches a longer string that merely STARTS with "gh",
// e.g. 'ghost' or 'gh-labels').
const DIRECT_CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|['"`][^'"`]*['"`])\s*,\s*)?(['"`])gh\2\s*,/g;

// Shape 2: execSync('gh …') / exec('gh …') — or a local alias of either —
// a single shell-command string whose first token is "gh" (followed by
// whitespace, or immediately closed as a bare 'gh' with no args). Still
// scoped to the tracked node:child_process entry points; see header comment.
function buildShellCallRe(names) {
  return new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*(${Q})\\s*gh(?=[\\s'"\`])`, 'g');
}

// #2203 review Finding F5 — a single-line suppression pragma. The scan is
// raw text with no comment- or string-stripping, so a comment documenting
// the rule, or a test assertion whose argument shape coincides
// (`assert.equal('gh', recorded[0])`), reads as a violation with no way for
// the scanner to tell it apart from a real call. Put this literal string
// anywhere on the offending line to suppress it — see header comment for
// the "why" and the deliberate no-block-form design.
const PRAGMA = 'gh-chokepoint-allow';

/** The full text of the line containing `index`, for pragma-checking a
 *  match without re-splitting the whole source per call. */
function lineTextAt(source, index) {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
}

/** Scans one file's source text for a raw `gh` invocation via either shape,
 *  including through any local alias its own `node:child_process` import
 *  declares for execSync/exec (shape 2 only — shape 1 needs no alias
 *  tracking, it matches any callee). A match on a line carrying the
 *  `gh-chokepoint-allow` pragma is skipped. Returns an array of { kind,
 *  line, snippet }. Pure — exported so the per-shape mutation tests below
 *  can exercise it directly against synthetic fixtures, not just real repo
 *  files. */
export function findRawGhCalls(source) {
  const shell = collectShellAliases(source);
  const violations = [];
  for (const re of [DIRECT_CALL_RE, buildShellCallRe(shell)]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      if (lineTextAt(source, m.index).includes(PRAGMA)) continue;
      const line = source.slice(0, m.index).split('\n').length;
      violations.push({ kind: m[1], line, snippet: m[0] });
    }
  }
  return violations;
}

// #2203 review Finding F3 — the JS/TS family, not just `.mjs`. Before this,
// a `gh` call in e.g. `preflight-ffmpeg.cjs` or `audit-stage2-coverage.mts`
// was caught verbatim if renamed to `.mjs` — the escape was purely the
// extension filter. `.ps1`/`.psm1`/`.py` scripts under scripts/ are
// deliberately NOT included; see KNOWN BLIND SPOTS above.
const SCANNED_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];

function listScriptFiles() {
  return readdirSync(scriptsDir, { recursive: true })
    .filter((f) => SCANNED_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .map((f) => resolve(scriptsDir, f));
}

test('no JS/TS script under scripts/ invokes the `gh` binary directly except scripts/gh.mjs (#2184)', () => {
  const violations = [];
  for (const file of listScriptFiles()) {
    if (file === ghWrapperPath || file === selfPath) continue;
    const source = readFileSync(file, 'utf8');
    for (const v of findRawGhCalls(source)) {
      violations.push(`  ${relative(repoRoot, file)}:${v.line} — ${v.kind}(...): ${v.snippet}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `raw 'gh' invocation(s) found outside scripts/gh.mjs — route through gh()/ghSpawn() instead:\n${violations.join('\n')}`,
  );
});

// --- Per-shape mutation coverage (findRawGhCalls exercised directly, no ---
// --- repo file I/O — proves each entry point the guard above claims to  ---
// --- cover actually IS covered, one shape at a time).                  ---

test('findRawGhCalls catches execFileSync with a single-quoted "gh"', () => {
  const violations = findRawGhCalls("execFileSync('gh', ['issue', 'list'], { encoding: 'utf8' });");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execFileSync');
});

test('findRawGhCalls catches execFileSync with a double-quoted "gh"', () => {
  const violations = findRawGhCalls('execFileSync("gh", ["issue", "list"], { encoding: "utf8" });');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execFileSync');
});

test('findRawGhCalls catches spawnSync(\'gh\', ...) — a different entry point than execFileSync', () => {
  const violations = findRawGhCalls("const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('findRawGhCalls catches execSync(\'gh ...\') — the shell-string entry point', () => {
  const violations = findRawGhCalls("const out = execSync('gh issue list --json number');");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execSync');
});

test('findRawGhCalls catches exec(\'gh ...\') (callback-style)', () => {
  const violations = findRawGhCalls("exec('gh pr list', (err, stdout) => {});");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'exec');
});

test('findRawGhCalls catches a call whose arguments are split across multiple lines', () => {
  const src = ["execFileSync(", "  'gh',", "  ['issue', 'list'],", "  { encoding: 'utf8' },", ");"].join('\n');
  const violations = findRawGhCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 1); // reports the line the call itself starts on
});

test('findRawGhCalls does not false-positive on a git call or a comment mentioning gh', () => {
  const src = [
    "execFileSync('git', ['status'], { encoding: 'utf8' });",
    '// see gh.mjs for the gh() wrapper',
    "const label = 'gh-labels';",
  ].join('\n');
  assert.deepEqual(findRawGhCalls(src), []);
});

test('findRawGhCalls catches a backtick-quoted "gh" followed by a comma (the previously-undocumented hole)', () => {
  const violations = findRawGhCalls('myRunner(`gh`, ["release", "list"]);');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'myRunner');
});

test('findRawGhCalls does not false-positive on bump-version.mjs\'s own backtick prose mentioning gh', () => {
  // The real string from bump-version.mjs:275 — `(`gh`)` reads as a call
  // shape to a naive scan (identifier "CLI" + "(" + backtick-quoted "gh"),
  // but the closing backtick is followed by ")", not ",", so the
  // comma-requirement keeps this out.
  const src =
    "'The cross-OS gate needs the GitHub CLI (`gh`) authenticated, but `gh` was not found. ' +\n" +
    "  'Install it + `gh auth login`, or pass --skip-cross-os to bypass the gate.'";
  assert.deepEqual(findRawGhCalls(src), []);
});

test('findRawGhCalls catches a call through a locally aliased import of execFileSync (#2184 aliasing hole)', () => {
  const src = [
    "import { execFileSync as _x } from 'node:child_process';",
    "const _probe = _x('gh', ['--version'], { encoding: 'utf8' });",
  ].join('\n');
  const violations = findRawGhCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, '_x');
});

test('findRawGhCalls catches a custom local wrapper called as run(\'gh\', …) — argument-based, not callee-based (#2184 wrapper hole)', () => {
  const src = [
    "function run(cmd, args) { return runCommand('label', cmd, args); }",
    "const out = run('gh', ['release', 'list']);",
  ].join('\n');
  const violations = findRawGhCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'run');
});

test('KNOWN BLIND SPOT: a gh binary held in a variable is not detected', () => {
  const src = "const bin = 'gh';\nexecFileSync(bin, ['issue', 'list'], { encoding: 'utf8' });";
  assert.deepEqual(findRawGhCalls(src), []);
});

test('scripts/gh.mjs itself is excluded from the repo-wide scan (it IS the chokepoint)', () => {
  const files = listScriptFiles();
  assert.ok(files.includes(ghWrapperPath), 'sanity: gh.mjs must be discovered by the file walk');
  // The main guard test above explicitly skips this path; assert that skip
  // is actually necessary — i.e. gh.mjs's own source legitimately contains
  // the pattern the guard looks for, so an accidental removal of the skip
  // would make the guard permanently red for a reason unrelated to a real
  // violation.
  const source = readFileSync(ghWrapperPath, 'utf8');
  assert.ok(findRawGhCalls(source).length >= 2, 'gh.mjs is expected to contain the two real gh()/ghSpawn() invocations');
});

// --- Per-function scrub assertions (#2203 review Finding F1) -------------
// This guard (above) proves ROUTING — that every gh-calling script goes
// through gh.mjs — but until now nothing asserted that gh.mjs's own
// gh()/ghSpawn() actually scrub the env they hand to execFileSync/
// spawnSync. Deleting `env: scrubGitEnv(env)` from EITHER function left
// `npm run test:hooks` fully green (1187 pass, 0 fail) and `npx eslint
// scripts/gh.mjs` only warning (unused vars, exit 0) — a silent regression
// from the bump-version.test.mjs-era test this file replaced, which did
// assert the scrub at each of its three named call sites. These two tests
// close that hole, one function at a time — a single file-wide regex would
// stay green if only one of the two lost its scrub (see the neutralisation
// proof in the PR description / fix report).

/** Extracts the full source text of `export function <name>(...) { ... }`
 *  from gh.mjs's own source, by brace-counting from the function's opening
 *  `{` to its matching close (the object literal inside means a naive
 *  "up to the next blank line" slice isn't safe). */
function extractFunctionSource(source, name) {
  const header = new RegExp(`export function ${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  assert.ok(header, `function ${name} not found in gh.mjs`);
  let depth = 0;
  let i = header.index + header[0].length - 1; // position of the opening '{'
  const start = i;
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

test('gh() applies scrubGitEnv to the env it passes to execFileSync (#2203 review Finding F1)', () => {
  const source = readFileSync(ghWrapperPath, 'utf8');
  const ghSource = extractFunctionSource(source, 'gh');
  assert.match(
    ghSource,
    /env:\s*scrubGitEnv\(/,
    'gh() must scrub its env before handing it to execFileSync — see scripts/gh.mjs header',
  );
});

test('ghSpawn() applies scrubGitEnv to the env it passes to spawnSync (#2203 review Finding F1)', () => {
  const source = readFileSync(ghWrapperPath, 'utf8');
  const ghSpawnSource = extractFunctionSource(source, 'ghSpawn');
  assert.match(
    ghSpawnSource,
    /env:\s*scrubGitEnv\(/,
    'ghSpawn() must scrub its env before handing it to spawnSync — see scripts/gh.mjs header',
  );
});

// --- Second-argument coverage (#2203 review Finding F2) -------------------
// `DIRECT_CALL_RE` used to require 'gh' to be the call's FIRST argument, so
// `runCommand(label, 'gh', args)` — runCommand's real signature puts the
// binary name second, behind a label — was invisible to it. Verified by the
// reviewer: appending `runCommand('probe', 'gh', ['issue','list'])` to a
// script left the guard green before this fix.

test('findRawGhCalls catches "gh" as a SECOND argument — runCommand(label, \'gh\', args) shape (#2203 review Finding F2)', () => {
  const violations = findRawGhCalls("runCommand('probe', 'gh', ['issue', 'list']);");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'runCommand');
});

test('findRawGhCalls still catches "gh" as a first argument after the second-argument fix', () => {
  const violations = findRawGhCalls("execFileSync('gh', ['issue', 'list'], { encoding: 'utf8' });");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execFileSync');
});

test('findRawGhCalls does not false-positive on runCommand\'s real, non-gh call site shape (sync-wiki.mjs:88)', () => {
  const violations = findRawGhCalls("return runCommand('sync-wiki', cmd, args, { cwd });");
  assert.deepEqual(violations, []);
});

test('KNOWN BLIND SPOT: a non-trivial leading argument before a second-position "gh" is not detected', () => {
  const violations = findRawGhCalls("runCommand(buildLabel(x), 'gh', args);");
  assert.deepEqual(violations, []);
});

// --- Extension coverage (#2203 review Finding F3) --------------------------
// Before this, the scan filtered to `f.endsWith('.mjs')` only, so a `gh`
// call in e.g. a `.cjs` or `.mts` script under scripts/ was invisible to
// the guard purely because of its extension — the KNOWN BLIND SPOTS list
// didn't say so, which understated the gap.

test('listScriptFiles scans the JS/TS family, not just .mjs (#2203 review Finding F3)', () => {
  const relPaths = listScriptFiles().map((f) => relative(repoRoot, f));
  assert.ok(relPaths.some((f) => f.endsWith('.cjs')), 'expected at least one .cjs file (preflight-ffmpeg.cjs)');
  assert.ok(relPaths.some((f) => f.endsWith('.mts')), 'expected at least one .mts file (audit-stage2-coverage.mts)');
});

// --- Pragma suppression (#2203 review Finding F5) --------------------------
// The scan is raw text with no comment- or string-stripping, so (a) a
// comment documenting the rule and (b) a test assertion whose shape
// coincides (`assert.equal('gh', recorded[0])`) both read as violations.
// `gh-chokepoint-allow` on the offending line suppresses just that line.

test('findRawGhCalls suppresses a match on a line carrying the gh-chokepoint-allow pragma', () => {
  const src = "execFileSync('gh', ['issue', 'list'], { encoding: 'utf8' }); // gh-chokepoint-allow";
  assert.deepEqual(findRawGhCalls(src), []);
});

test('findRawGhCalls does not suppress a violation on an unrelated line just because another line carries the pragma', () => {
  const src = [
    "// documenting the rule — gh-chokepoint-allow",
    "execFileSync('gh', ['issue', 'list'], { encoding: 'utf8' });",
  ].join('\n');
  const violations = findRawGhCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

test('KNOWN FALSE POSITIVE (documented) suppressed by pragma: a comment demonstrating the call shape', () => {
  const withoutPragma = "// Never write execFileSync('gh', [...]) here";
  assert.equal(findRawGhCalls(withoutPragma).length, 1, 'sanity: the bare comment trips the scanner without the pragma');
  const withPragma = withoutPragma + ' — gh-chokepoint-allow';
  assert.deepEqual(findRawGhCalls(withPragma), []);
});

test('KNOWN FALSE POSITIVE (documented) suppressed by pragma: a test-style assertion whose shape coincides with shape 1', () => {
  const withoutPragma = "assert.equal('gh', recorded[0]);";
  const violations = findRawGhCalls(withoutPragma);
  assert.equal(violations.length, 1, 'sanity: the bare assertion trips the scanner without the pragma');
  assert.equal(violations[0].kind, 'equal');
  const withPragma = withoutPragma + ' // gh-chokepoint-allow';
  assert.deepEqual(findRawGhCalls(withPragma), []);
});
