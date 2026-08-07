// #2216 — every direct `git` invocation under scripts/ and pinokio-scripts/
// must scrub the repo-discovery GIT_* env vars (scrubGitEnv,
// scripts/git-env.mjs), applied UNCONDITIONALLY at every call site rather
// than triaged per site (see the issue's decision comment for why:
// GIT_INDEX_FILE is the one such var an ordinary git hook DOES export, and
// scrubbing it is neutral-to-protective for every site in this repo today).
//
// Modeled on scripts/tests/gh-chokepoint.test.mjs, but the shape of what
// "covered" means is DIFFERENT and deliberately so. gh-chokepoint asserts a
// single-chokepoint invariant — "every `gh` call routes through gh.mjs" —
// and separately (its own Finding F1) asserts gh.mjs's two functions each
// apply the scrub. That two-part split is necessary there because ALL `gh`
// traffic funnels through one file. Here there is no single chokepoint: 20
// of the 23 sites this issue covers call execFileSync/spawnSync/execSync
// directly with 'git' as an argument and scrub inline at that exact call;
// two (verify-cache.mjs) go through a local one-hop wrapper (`gitEnv()`);
// and six (sync-wiki.mjs) go through a local wrapper (`run()`) that forwards
// to the shared, already-scrubbing scripts/lib/run-command.mjs chokepoint.
// So THIS guard folds routing and the scrub-property check into one pass:
// for every matched 'git' call, it resolves whether a scrub is PROVABLY
// applied — inline, via a same-file wrapper, or via the run-command.mjs
// chokepoint — and reports a violation otherwise. Deleting `env:
// scrubGitEnv(...)` from any inline site, or deleting the `scrubGitEnv(`
// call from `gitEnv()`'s own body, makes THIS SAME test go red — there is
// no separate allowlist step to keep in sync, which is exactly the property
// #2184's first guard (routing-only) lacked and that incident's issue calls
// out explicitly. See the neutralisation tests near the bottom of this file
// for the synthetic proof, and the PR description for a live proof against
// a real repo file (scrub deleted from guard-protected-push.mjs, guard
// observed red, reverted).
//
// --- Detection strategy ------------------------------------------------
// Two shapes, mirroring gh-chokepoint's:
//   Shape 1: any call expression whose first OR second argument is the
//     literal string 'git'/"git"/`git`, immediately followed by a comma —
//     callee-agnostic (catches a direct execFileSync('git', …) as readily
//     as a custom wrapper run('git', …) or an aliased import). Same
//     comma-after-closing-quote requirement as gh-chokepoint, for the same
//     reason (lets backtick stay in the quote class without false-
//     positiving on backtick-quoted prose).
//   Shape 2: execSync('git …') / exec('git …') (or a locally aliased
//     import of either) — a shell-command string whose first token is
//     "git". Scoped to the four canonical node:child_process entry points
//     plus any local alias a file's own `import { … } from
//     'node:child_process'` or CommonJS `require('node:child_process')`
//     declares for them.
//
// --- Resolving whether a match is scrubbed ------------------------------
// For each matched call, extract its full call-expression text (balanced-
// paren scan from the callee identifier to the matching close paren), then
// check, in this order (any ONE passing is enough — see below for why OR,
// not else-if):
//   (a) the call's own text contains the literal substring 'scrubGitEnv(' —
//       covers every inline `env: scrubGitEnv(...)` site.
//   (b) the call's own text has an `env:` key (or object-shorthand `env`)
//       whose value — a bare identifier or a call — resolves to a scrub.
//       Resolution looks up same-file declarations (`function NAME(...) {
//       ... }`, `const NAME = (...) => { ... }`, or `const NAME = <expr>;`
//       for a plain variable) and checks whether the found body/RHS itself
//       contains 'scrubGitEnv(' — chasing through ONE further identifier if
//       the RHS is itself a bare call (e.g. `const env = gitEnv();` chases
//       into `gitEnv`'s own body). Capped at MAX_RESOLVE_DEPTH hops.
//   (c) the call's OWN CALLEE NAME (not just its env: value) resolves the
//       same way — covers a wrapper invoked with no env: key visible at the
//       call site at all, e.g. sync-wiki.mjs's `run('git', args, cwd)`,
//       where `run()`'s own body unconditionally forwards to
//       scripts/lib/run-command.mjs's `runCommand`, which itself
//       unconditionally scrubs (proven by its own dedicated test below).
//       `runCommand` is trusted as a scrub-terminal ONLY when the scanned
//       file's own source has an `import { runCommand } from …` naming a
//       path ending `run-command.mjs` — so an unrelated same-named local
//       function can't accidentally short-circuit this.
// These are combined with OR (not resolved in strict order and stopped at
// the first success) because they are independent proofs of the same
// property — e.g. a wrapper whose body unconditionally scrubs makes a call
// safe REGARDLESS of what env: value the call site happens to pass, since
// the wrapper's own scrub would be applied to whatever env it's handed.
//
// --- KNOWN BLIND SPOTS (a source-text scan can't see everything) --------
//   - Same coverage gaps as gh-chokepoint's scanner: a binary held in a
//     variable, a command string built by concatenation, computed member
//     access / .call/.apply, a leading argument before 'git' that isn't a
//     simple token (bare identifier / number / quoted string).
//   - Resolution is same-file only, except the one explicit, verified
//     runCommand exception above — a wrapper defined in a THIRD file (not
//     git-env.mjs, not run-command.mjs) is not chased.
//   - Resolution caps at MAX_RESOLVE_DEPTH hops through bare-identifier/
//     bare-call chains; a longer chain is not resolved and reports a
//     (false-positive) violation rather than silently passing — the safer
//     failure direction for a guard.
//   - An `env:` value that is not a bare identifier or a bare call — a
//     member expression, a ternary, an object spread, a template literal —
//     is not resolved; same "reports a violation instead of guessing" bias.
//   - scripts/tests/** and pinokio-scripts/**/*.test.js are OUT OF SCOPE —
//     these create throwaway git repos as test fixtures under an explicit
//     cwd, a different risk profile than the ambient-env hazard this issue
//     is about, and #2216's own enumeration is scoped to production
//     tooling. This file itself is also excluded (its fixtures deliberately
//     contain the literal patterns being scanned for).
//   - PowerShell/Python scripts under scripts/ are NOT scanned — same
//     documented gap as gh-chokepoint (none call git today).
//   - `scrubGitEnv`/`runCommand` imported under an ALIAS (`as`-renamed) are
//     not recognized — only the canonical names are checked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '..');
const repoRoot = resolve(scriptsDir, '..');
const pinokioDir = resolve(repoRoot, 'pinokio-scripts');
const selfPath = resolve(here, 'git-scrub.test.mjs');
const runCommandPath = resolve(scriptsDir, 'lib', 'run-command.mjs');

const Q = `['"\`]`;
const SHELL_CANONICAL_NAMES = ['execSync', 'exec'];
const MAX_RESOLVE_DEPTH = 3;

// Single-line suppression, mirroring gh-chokepoint's `gh-chokepoint-allow`
// (#2203 Finding F5) — not currently needed by any real site (kept for
// parity/future robustness, exercised by its own test below).
const PRAGMA = 'git-scrub-allow';

// --- Shape 1: literal 'git' as call's 1st or 2nd argument, any callee ----
const DIRECT_CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|['"`][^'"`]*['"`])\s*,\s*)?(['"`])git\2\s*,/g;

// --- Shape 2: execSync('git …') / exec('git …') / aliases ----------------
function buildShellCallRe(names) {
  return new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*(${Q})\\s*git(?=[\\s'"\`])`, 'g');
}

// Recognizes both the ESM `import { execSync as sh } from
// 'node:child_process'` alias form and the CommonJS `const { execSync: sh }
// = require('node:child_process')` alias form (pinokio-scripts is CJS).
const CHILD_PROCESS_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])node:child_process\2/g;
const CHILD_PROCESS_REQUIRE_RE =
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])node:child_process\2\s*\)/g;

function collectShellAliases(source) {
  const shell = new Set(SHELL_CANONICAL_NAMES);
  for (const re of [CHILD_PROCESS_IMPORT_RE, CHILD_PROCESS_REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const specifiers = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const spec of specifiers) {
        const [imported, local = imported] = spec.split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
        if (SHELL_CANONICAL_NAMES.includes(imported)) shell.add(local);
      }
    }
  }
  return shell;
}

function lineTextAt(source, index) {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
}

/** Balanced-paren extraction of a call's full text, starting at the index
 *  of its callee identifier. Naive (no quote/comment awareness — see KNOWN
 *  BLIND SPOTS), matching the rigor level of gh-chokepoint's own brace
 *  extractor. */
function extractCallText(source, startIndex) {
  const openIdx = source.indexOf('(', startIndex);
  if (openIdx === -1) return source.slice(startIndex);
  let depth = 0;
  let i = openIdx;
  do {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(startIndex, i);
}

/** Extracts `export function NAME(...) { ... }` / `function NAME(...) {
 *  ... }` / `const NAME = (...) => { ... }`'s body text via brace counting,
 *  or null if no such declaration exists in `source`. */
function extractDeclarationBody(source, name) {
  const patterns = [
    new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(
      `(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{`,
    ),
  ];
  let header = null;
  for (const re of patterns) {
    header = re.exec(source);
    if (header) break;
  }
  if (!header) return null;
  let depth = 0;
  let i = header.index + header[0].length - 1; // the opening '{'
  const start = i;
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

/** Does the scanned file import `importedName` from a path ending in
 *  `pathSuffix` (ESM or CJS require)? Guards the `runCommand`
 *  scrub-terminal trust — see header. */
function fileImportsFrom(source, importedName, pathSuffix) {
  const suffixPattern = pathSuffix.replace(/[.]/g, '\\.');
  const esm = new RegExp(
    `import\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s*from\\s*(['"\`])[^'"\`]*${suffixPattern}\\1`,
  );
  const cjs = new RegExp(
    `require\\(\\s*(['"\`])[^'"\`]*${suffixPattern}\\1\\s*\\)[^;]*\\b${importedName}\\b`,
  );
  return esm.test(source) || cjs.test(source);
}

/** TRUE if `name`, resolved within `source`, provably applies scrubGitEnv —
 *  directly, through a same-file wrapper's body, or through the
 *  run-command.mjs chokepoint (only when imported from the canonical
 *  path). See header for the full algorithm. */
function resolvesToScrub(source, name, depth = 0) {
  if (name === 'scrubGitEnv') return true;
  if (name === 'runCommand' && fileImportsFrom(source, 'runCommand', 'run-command.mjs'))
    return true;
  if (depth > MAX_RESOLVE_DEPTH) return false;

  const body = extractDeclarationBody(source, name);
  if (body !== null) {
    if (body.includes('scrubGitEnv(')) return true;
    if (body.includes('runCommand(') && fileImportsFrom(source, 'runCommand', 'run-command.mjs')) {
      return true;
    }
    return false;
  }

  // Plain variable: `const NAME = <expr>;`
  const varMatch = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;\\n]+);`).exec(source);
  if (varMatch) {
    const rhs = varMatch[1].trim();
    if (rhs.includes('scrubGitEnv(')) return true;
    const callMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rhs);
    if (callMatch) return resolvesToScrub(source, callMatch[1], depth + 1);
  }
  return false;
}

/** Finds the `env:` key's value (bare identifier or call) within a call's
 *  extracted text, including shorthand `{ env }`. Returns { name, } or
 *  null. */
function findEnvValue(callText) {
  let m = /\benv\s*:\s*([A-Za-z_$][\w$]*)/.exec(callText);
  if (m) return { name: m[1] };
  m = /(?:\{|,)\s*(env)\s*(?=[,}])/.exec(callText);
  if (m) return { name: 'env' };
  return null;
}

/** Scans one file's source for a `git`-spawning call (either shape) that
 *  cannot be proven to scrub. Pure — exported so the mutation tests below
 *  can exercise it directly against synthetic fixtures, not just real repo
 *  files. Returns [{ kind, line, snippet }]. */
export function findUnscrubbedGitCalls(source) {
  const shell = collectShellAliases(source);
  const violations = [];
  for (const re of [DIRECT_CALL_RE, buildShellCallRe(shell)]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      if (lineTextAt(source, m.index).includes(PRAGMA)) continue;
      const calleeName = m[1];
      const callText = extractCallText(source, m.index);
      const scrubbed =
        callText.includes('scrubGitEnv(') ||
        (findEnvValue(callText) && resolvesToScrub(source, findEnvValue(callText).name)) ||
        resolvesToScrub(source, calleeName);
      if (!scrubbed) {
        const line = source.slice(0, m.index).split('\n').length;
        violations.push({ kind: calleeName, line, snippet: m[0] });
      }
    }
  }
  return violations;
}

const SCANNED_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];

function listFilesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => SCANNED_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .map((f) => resolve(dir, f));
}

function inScopeFiles() {
  const scriptsFiles = listFilesUnder(scriptsDir).filter((f) => {
    const rel = relative(scriptsDir, f);
    return !rel.startsWith('tests' + sep) && !rel.startsWith('tests/');
  });
  const pinokioFiles = listFilesUnder(pinokioDir).filter((f) => !f.endsWith('.test.js'));
  return [...scriptsFiles, ...pinokioFiles].filter((f) => f !== selfPath);
}

test('every direct git invocation under scripts/ and pinokio-scripts/ provably scrubs the GIT_* env vars (#2216)', () => {
  const violations = [];
  for (const file of inScopeFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const v of findUnscrubbedGitCalls(source)) {
      violations.push(`  ${relative(repoRoot, file)}:${v.line} — ${v.kind}(...): ${v.snippet}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `unscrubbed 'git' invocation(s) found — every git spawn under scripts/ or ` +
      `pinokio-scripts/ must apply scrubGitEnv (scripts/git-env.mjs), inline or ` +
      `through a same-file wrapper / the run-command.mjs chokepoint:\n${violations.join('\n')}`,
  );
});

// --- runCommand's own scrub property (trusted scrub-terminal) ------------
// findUnscrubbedGitCalls trusts `runCommand(` as a scrub-terminal for any
// file that imports it from run-command.mjs — that trust is only sound if
// runCommand ITSELF unconditionally scrubs. Pin that directly, the same way
// gh-chokepoint.test.mjs's F1 tests pin gh()/ghSpawn().

test('runCommand (scripts/lib/run-command.mjs) applies scrubGitEnv to the env it hands to spawnSync', () => {
  const source = readFileSync(runCommandPath, 'utf8');
  assert.match(
    source,
    /env:\s*scrubGitEnv\(/,
    'runCommand must scrub its env before handing it to spawnSync — every file that trusts ' +
      'it as a scrub-terminal (findUnscrubbedGitCalls) depends on this',
  );
});

// --- Per-shape mutation coverage (findUnscrubbedGitCalls exercised -------
// --- directly, no repo file I/O) -----------------------------------------

test("findUnscrubbedGitCalls catches execFileSync('git', …) with no env at all", () => {
  const violations = findUnscrubbedGitCalls(
    "execFileSync('git', ['status'], { encoding: 'utf8' });",
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execFileSync');
});

test("findUnscrubbedGitCalls passes execFileSync('git', …) with inline scrubGitEnv()", () => {
  const violations = findUnscrubbedGitCalls(
    "execFileSync('git', ['status'], { encoding: 'utf8', env: scrubGitEnv() });",
  );
  assert.deepEqual(violations, []);
});

test('findUnscrubbedGitCalls: single-quoted "git"', () => {
  const violations = findUnscrubbedGitCalls("execFileSync('git', ['status'], {});");
  assert.equal(violations.length, 1);
});

test('findUnscrubbedGitCalls: double-quoted "git"', () => {
  const violations = findUnscrubbedGitCalls('execFileSync("git", ["status"], {});');
  assert.equal(violations.length, 1);
});

test('findUnscrubbedGitCalls: backtick-quoted `git` followed by a comma', () => {
  const violations = findUnscrubbedGitCalls('myRunner(`git`, ["status"]);');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'myRunner');
});

test("findUnscrubbedGitCalls catches spawnSync('git', …) — a different entry point", () => {
  const violations = findUnscrubbedGitCalls("spawnSync('git', ['status'], {});");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test("findUnscrubbedGitCalls catches execSync('git …') — the shell-string entry point", () => {
  const violations = findUnscrubbedGitCalls("execSync('git status');");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'execSync');
});

test("findUnscrubbedGitCalls passes execSync('git …') when the env is scrubbed", () => {
  const violations = findUnscrubbedGitCalls("execSync('git status', { env: scrubGitEnv() });");
  assert.deepEqual(violations, []);
});

test("findUnscrubbedGitCalls catches exec('git …') (callback-style)", () => {
  const violations = findUnscrubbedGitCalls("exec('git status', (err, stdout) => {});");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'exec');
});

test("findUnscrubbedGitCalls catches spawn('git', …)", () => {
  const violations = findUnscrubbedGitCalls("spawn('git', ['log'], {});");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawn');
});

test('findUnscrubbedGitCalls catches a call through a locally aliased import of execFileSync', () => {
  const src = [
    "import { execFileSync as _x } from 'node:child_process';",
    "const out = _x('git', ['status'], {});",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, '_x');
});

test('findUnscrubbedGitCalls catches execSync through a locally aliased import', () => {
  const src = ["import { execSync as sh } from 'node:child_process';", "sh('git status');"].join(
    '\n',
  );
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'sh');
});

test('findUnscrubbedGitCalls catches execSync through a CommonJS-required alias (pinokio-scripts shape)', () => {
  const src = ["const { execSync: sh } = require('node:child_process');", "sh('git status');"].join(
    '\n',
  );
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'sh');
});

test('findUnscrubbedGitCalls catches "git" as a SECOND argument — runCommand(label, \'git\', args) shape', () => {
  const violations = findUnscrubbedGitCalls("someWrapper('probe', 'git', ['status']);");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'someWrapper');
});

test('findUnscrubbedGitCalls does not false-positive on a gh call or prose mentioning git', () => {
  // This fixture string is deliberately shaped like a raw `gh` call, to
  // prove findUnscrubbedGitCalls ignores it (it's for `gh`, not `git`).
  // scripts/tests/gh-chokepoint.test.mjs's OWN repo-wide scanner also sweeps
  // scripts/tests/** and would otherwise flag this literal text — the
  // trailing pragma comment on the SAME line is its documented escape hatch
  // (a suppression is per-line, not per-file — see that file's header).
  const src = [
    "execFileSync('gh', ['issue', 'list'], {});", // gh-chokepoint-allow
    '// see git-env.mjs for the scrub',
    "const label = 'git-notes';",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

// --- Resolution through a same-file wrapper (the property #2184's first --
// --- guard lacked, proven at the unit level: a wrapper whose body loses -
// --- its scrub call is caught, not just a routing check). ---------------

test('findUnscrubbedGitCalls resolves env: via a one-hop same-file wrapper function (gitEnv() shape)', () => {
  const src = [
    'function gitEnv() { return scrubGitEnv(); }',
    "spawnSync('git', ['status'], { env: gitEnv() });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION: deleting scrubGitEnv() from the wrapper body makes the SAME call site fail', () => {
  // Same fixture as above, minus the wrapper's own scrub call — simulates
  // #2216's git-env.mjs-composing gitEnv() helper in verify-cache.mjs
  // losing its scrub. This is the synthetic proof of requirement #2: the
  // call SITE text is unchanged, only the callee's OWN body regressed, and
  // the guard still goes red.
  const src = [
    'function gitEnv() { return { ...process.env }; }', // scrub deleted
    "spawnSync('git', ['status'], { env: gitEnv() });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('findUnscrubbedGitCalls resolves env, via a bare-identifier chase to a wrapper (branchDiffFiles shape)', () => {
  const src = [
    'function gitEnv() { return scrubGitEnv(); }',
    'const env = gitEnv();',
    "spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd, encoding: 'utf8', env });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION: deleting the wrapper call from the chased variable makes the SAME call site fail', () => {
  const src = [
    'function gitEnv() { return scrubGitEnv(); }',
    'const env = process.env;', // scrub deleted — no longer calls gitEnv()
    "spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd, encoding: 'utf8', env });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
});

test('findUnscrubbedGitCalls resolves a wrapper with NO env: key at the call site, via runCommand (sync-wiki.mjs shape)', () => {
  const src = [
    "import { runCommand } from './lib/run-command.mjs';",
    "function run(cmd, args, cwd) { return runCommand('label', cmd, args, { cwd }); }",
    "run('git', ['rev-parse', '--short', 'HEAD'], cwd);",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION: a wrapper forwarding to runCommand WITHOUT importing it from run-command.mjs is not trusted', () => {
  // Same shape, but runCommand is NOT imported from the canonical path —
  // an unrelated locally-defined function sharing the name must not
  // silently pass.
  const src = [
    'function runCommand(cmd, args) { return spawnSync(cmd, args); }', // NOT the real chokepoint
    'function run(cmd, args, cwd) { return runCommand(cmd, args); }',
    "run('git', ['rev-parse', '--short', 'HEAD'], cwd);",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'run');
});

test('NEUTRALISATION: a wrapper that stops forwarding to runCommand entirely is caught', () => {
  const src = [
    "import { runCommand } from './lib/run-command.mjs';",
    'function run(cmd, args, cwd) { return spawnSync(cmd, args, { cwd }); }', // no longer forwards
    "run('git', ['rev-parse', '--short', 'HEAD'], cwd);",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'run');
});

// --- Pragma suppression ----------------------------------------------------

test('findUnscrubbedGitCalls suppresses a match on a line carrying the git-scrub-allow pragma', () => {
  const src = "execFileSync('git', ['status'], {}); // git-scrub-allow";
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('findUnscrubbedGitCalls does not suppress a violation on an unrelated line just because another line carries the pragma', () => {
  const src = [
    '// documenting the rule — git-scrub-allow',
    "execFileSync('git', ['status'], {});",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

// --- Sanity: the scanner discovers real files (guards against a broken --
// --- file walk silently making the main test vacuously green) -----------

test('inScopeFiles discovers real production files under both scripts/ and pinokio-scripts/', () => {
  const files = inScopeFiles();
  assert.ok(
    files.some((f) => f.endsWith('verify-cache.mjs')),
    'expected verify-cache.mjs to be discovered',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('lib', 'resolve-release.js'))),
    'expected pinokio-scripts/lib/resolve-release.js to be discovered',
  );
  assert.ok(
    !files.some((f) => f.includes(sep + 'tests' + sep)),
    'scripts/tests/** must be excluded from the scan',
  );
  assert.ok(
    !files.some((f) => f.endsWith('.test.js')),
    'pinokio-scripts/**/*.test.js must be excluded from the scan',
  );
});
