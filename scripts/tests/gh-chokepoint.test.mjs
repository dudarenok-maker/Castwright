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
//   1. execFileSync('gh', ...) / spawnSync('gh', ...) — the binary passed as
//      a literal first argument, single/double/backtick-quoted.
//   2. execSync('gh ...') / exec('gh ...') — a single shell-command string
//      that STARTS with `gh` as its own token, same three quote styles.
//
// The match is keyed off the ARGUMENT (a literal 'gh'), not a hardcoded
// callee name — a file that does `import { execFileSync as run } from
// 'node:child_process'` and then calls `run('gh', …)` is just as much a
// chokepoint bypass as calling `execFileSync('gh', …)` directly, and an
// author reaching for an alias (accidentally or to dodge this exact guard)
// must not silently escape it. Each source file is scanned for its own
// `import { … } from 'node:child_process'` statement(s) first, and any
// local alias bound there to execFileSync/spawnSync/execSync/exec is added
// to the set of recognized callee names alongside the canonical ones — so
// `_x('gh', …)` is caught when (and only when) `_x` really is one of those
// four imports under another name. This is narrower than "any call whose
// first argument is 'gh', regardless of callee" would be: a same-shaped
// call through an unrelated, non-aliased wrapper — e.g. a locally-defined
// `run(cmd, args)` that forwards to spawnSync internally, called as
// `run('gh', …)` — is NOT caught, because `run` is never bound to a
// node:child_process import in that file. (One real instance of exactly
// this shape exists today, outside this branch's scope: see the blind
// spots below.)
//
// KNOWN BLIND SPOTS (a source-text scan can't see everything — stated
// plainly, per the #2184 brief, the way the existing GIT_DIR-decoy test's
// neighbour comment states its own impracticality):
//   - The binary held in a variable (`const bin = 'gh'; execFileSync(bin, …)`)
//     is NOT caught — this scanner only recognizes a LITERAL 'gh' string as
//     the call's own argument text, it does not do any data-flow analysis.
//   - A command string built by concatenation split across an expression
//     (e.g. `execSync('g' + 'h ...')`) is NOT caught, same reason.
//   - A completely different mechanism for running a binary (a shell script
//     shelled out to, `child_process.fork`, a `child_process.spawn` promise
//     wrapper defined elsewhere, `util.promisify(exec)`, etc.) is NOT caught
//     — only the four documented node:child_process entry points are
//     pattern-matched.
//   - A call through a locally-defined wrapper function that is not itself
//     an aliased import of one of the four entry points — e.g. a helper
//     `function run(cmd, args) { return spawnSync(cmd, args); }` called as
//     `run('gh', …)` — is NOT caught. Import-alias tracking closes the
//     direct-alias hole (`import { execFileSync as run } …`) but does not
//     do call-graph analysis through an intermediate function.
// What IS caught, in addition to the above: an execFileSync/spawnSync/
// execSync/exec call under any locally-declared import alias for those
// four names, both single- and double-quoted (and backtick, for the
// direct-call shape) forms, and a call whose arguments are split across
// multiple lines (the regexes allow arbitrary whitespace, including
// newlines, between the opening paren and the quoted binary/command).

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
// synthetic fixture strings deliberately CONTAIN the literal patterns the
// scanner looks for (that's the whole point of the mutation tests further
// down), so scanning this file as if it were a production script would
// self-trigger on every one of those fixtures. No other file under
// scripts/tests/ does this (verified: nothing else matches the two regexes
// below except gh.mjs and this file) — a real `gh`-calling test file would
// still be caught.
const selfPath = resolve(here, 'gh-chokepoint.test.mjs');

// A quote char shared by both patterns below: ', ", or `.
const Q = `['"\`]`;

// The canonical node:child_process entry points each shape recognizes by
// default, before any per-file import-alias is added to them.
const DIRECT_CANONICAL_NAMES = ['execFileSync', 'spawnSync'];
const SHELL_CANONICAL_NAMES = ['execSync', 'exec'];

// Matches `import { … } from 'node:child_process'` (single- or
// double-quoted module specifier only — a backtick can't legally appear
// there, so Q is deliberately not reused for this one). `[^}]*` spans
// newlines with no `/s` flag needed, so a specifier list broken across
// multiple lines is still captured whole.
const CHILD_PROCESS_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])node:child_process\2/g;

/** Finds every local alias this file's own `node:child_process` import(s)
 *  bind to each of the four tracked entry points — e.g. `import {
 *  execFileSync as run } from 'node:child_process'` adds 'run' to the
 *  direct-shape names. Names with no alias present resolve to themselves,
 *  and are already covered by the canonical defaults below, so only actual
 *  `as`-renames add anything new. Returns { direct, shell } Sets seeded
 *  with the canonical names. */
function collectChildProcessAliases(source) {
  const direct = new Set(DIRECT_CANONICAL_NAMES);
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
      if (DIRECT_CANONICAL_NAMES.includes(imported)) direct.add(local);
      if (SHELL_CANONICAL_NAMES.includes(imported)) shell.add(local);
    }
  }
  return { direct, shell };
}

// Shape 1: execFileSync('gh', …) / spawnSync('gh', …) — or a local alias of
// either, per collectChildProcessAliases() above — the binary is the call's
// own first argument, and nothing but a matching close-quote may follow
// "gh" (so this never matches a longer string that merely STARTS with
// "gh", e.g. 'ghost' or 'gh-labels').
function buildDirectCallRe(names) {
  return new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*(${Q})gh\\2`, 'g');
}

// Shape 2: execSync('gh …') / exec('gh …') — or a local alias of either —
// a single shell-command string whose first token is "gh" (followed by
// whitespace, or immediately closed as a bare 'gh' with no args).
function buildShellCallRe(names) {
  return new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*(${Q})\\s*gh(?=[\\s'"\`])`, 'g');
}

/** Scans one file's source text for a raw `gh` invocation via either shape,
 *  including through any local alias its own `node:child_process` import
 *  declares for the four tracked entry points. Returns an array of {
 *  kind, line, snippet }. Pure — exported so the per-shape mutation tests
 *  below can exercise it directly against synthetic fixtures, not just
 *  real repo files. */
export function findRawGhCalls(source) {
  const { direct, shell } = collectChildProcessAliases(source);
  const violations = [];
  for (const re of [buildDirectCallRe(direct), buildShellCallRe(shell)]) {
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
