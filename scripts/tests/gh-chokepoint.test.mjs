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
// This test asserts the STRONGER, structural invariant instead: no script
// anywhere under scripts/ may invoke the `gh` binary directly, except
// scripts/gh.mjs itself. A call site nobody has thought of yet fails this by
// default, which is the entire point.
//
// Detection strategy: read every scripts/**/*.mjs file as source text (no
// real `gh` process is ever spawned — see bump-version.test.mjs's sibling
// comment on why that's impractical cross-platform) and pattern-match two
// shapes:
//   1. ANY call expression whose first argument is the literal string 'gh'
//      or "gh" — matched on the ARGUMENT, not the callee's name. This is
//      what catches a custom local wrapper (`run('gh', …)` — the actual
//      shape generate-release-notes-wiki.mjs shipped with until this same
//      round: a real chokepoint bypass this guard originally MISSED,
//      because the first version only recognized execFileSync/spawnSync and
//      their tracked node:child_process import aliases, not an arbitrary
//      wrapper function that happens to forward to one of those
//      internally) exactly as readily as a direct `execFileSync('gh', …)`
//      or an aliased import (`import { execFileSync as _x } from
//      'node:child_process'` then `_x('gh', …)`) — callee identity no
//      longer matters at all for this shape. Backtick-quoted literals are
//      deliberately NOT matched here (single/double only): a backtick is
//      common in prose that merely *mentions* `gh` rather than calling it
//      (e.g. bump-version.mjs's own error-message text, `"...GitHub CLI
//      (\`gh\`) authenticated, but \`gh\` was not found..."`, which reads as
//      `('gh')`-shaped to a naive scan if backtick were an accepted quote
//      char here) — matching it would false-positive on exactly that kind
//      of comment/string, not a real call site.
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
// KNOWN BLIND SPOTS (a source-text scan can't see everything):
//   - The binary held in a variable (`const bin = 'gh'; execFileSync(bin, …)`
//     or `run(bin, …)`) is NOT caught — this scanner only recognizes a
//     LITERAL 'gh'/"gh" string as the call's own argument text, it does not
//     do any data-flow analysis.
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

// Shape 1: any call expression whose first argument is the literal string
// 'gh' or "gh" — the callee can be ANY identifier (or property-access name),
// not just execFileSync/spawnSync or a tracked alias of them. This is what
// catches a custom local wrapper (`run('gh', …)`) as readily as a direct
// call. Nothing but a matching close-quote may follow "gh" (so this never
// matches a longer string that merely STARTS with "gh", e.g. 'ghost' or
// 'gh-labels'). Single/double quotes only — see the header comment for why
// backtick is deliberately excluded here.
const DIRECT_CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(\s*(['"])gh\2/g;

// Shape 2: execSync('gh …') / exec('gh …') — or a local alias of either —
// a single shell-command string whose first token is "gh" (followed by
// whitespace, or immediately closed as a bare 'gh' with no args). Still
// scoped to the tracked node:child_process entry points; see header comment.
function buildShellCallRe(names) {
  return new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*(${Q})\\s*gh(?=[\\s'"\`])`, 'g');
}

/** Scans one file's source text for a raw `gh` invocation via either shape,
 *  including through any local alias its own `node:child_process` import
 *  declares for execSync/exec (shape 2 only — shape 1 needs no alias
 *  tracking, it matches any callee). Returns an array of { kind, line,
 *  snippet }. Pure — exported so the per-shape mutation tests below can
 *  exercise it directly against synthetic fixtures, not just real repo
 *  files. */
export function findRawGhCalls(source) {
  const shell = collectShellAliases(source);
  const violations = [];
  for (const re of [DIRECT_CALL_RE, buildShellCallRe(shell)]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const line = source.slice(0, m.index).split('\n').length;
      violations.push({ kind: m[1], line, snippet: m[0] });
    }
  }
  return violations;
}

function listScriptFiles() {
  return readdirSync(scriptsDir, { recursive: true })
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => resolve(scriptsDir, f));
}

test('no script under scripts/ invokes the `gh` binary directly except scripts/gh.mjs (#2184)', () => {
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
