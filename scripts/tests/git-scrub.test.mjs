// #2216 — every direct `git` invocation under scripts/ and pinokio-scripts/
// must scrub the repository-LOCATION GIT_* env vars (scrubGitEnv,
// scripts/git-env.mjs: GIT_DIR/GIT_WORK_TREE/GIT_OBJECT_DIRECTORY/
// GIT_COMMON_DIR — NOT GIT_INDEX_FILE, deliberately, per the #2216
// correction on the issue), applied UNCONDITIONALLY at every call site
// rather than triaged per site.
//
// Modeled on scripts/tests/gh-chokepoint.test.mjs, but the shape of what
// "covered" means is DIFFERENT and deliberately so. gh-chokepoint asserts a
// single-chokepoint invariant — "every `gh` call routes through gh.mjs" —
// and separately (its own Finding F1) asserts gh.mjs's two functions each
// apply the scrub. That two-part split is necessary there because ALL `gh`
// traffic funnels through one file. Here there is no single chokepoint: most
// sites call execFileSync/spawnSync/execSync directly with 'git' as an
// argument and scrub inline at that exact call; a few (verify-cache.mjs) go
// through a local one-hop wrapper (`gitEnv()`); and a few (sync-wiki.mjs) go
// through a local wrapper (`run()`) that forwards to the shared,
// already-scrubbing scripts/lib/run-command.mjs chokepoint. So THIS guard
// folds routing and the scrub-PROPERTY check into one pass: for every
// matched 'git' call, it resolves whether a scrub is PROVABLY applied —
// inline, via a same-file wrapper, or via the run-command.mjs chokepoint —
// and reports a violation otherwise.
//
// #2216 review round 2 (PR #2227) found this guard reproduced #2184's exact
// failure shape a FOURTH time: a purely textual "does the string
// 'scrubGitEnv(' appear somewhere in this call's source" check passes when
// the scrub is present as inert text — dead code, a comment, an uninvoked
// name reference, a shadowed/unimported name, or an object literal that
// spreads a real scrub result and then re-adds a hostile key afterward. Six
// concrete bypasses were demonstrated, all previously green. This revision
// closes five of them structurally (not by patching each individual PoC —
// see "What changed" below) and documents the sixth, which needs real
// control-flow analysis, as an explicit blind spot with its own test proving
// it is NOT caught. See NEUTRALISATION tests below for each closed bypass,
// and KNOWN BLIND SPOT tests for what remains open.
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
// --- What changed from the pre-review version, and why -------------------
// The old version's per-match check was: "does the extracted call text
// contain the substring 'scrubGitEnv(' ANYWHERE" (check a), OR "does the
// env: value's NAME resolve to a hardcoded trusted name" (check b/c) with
// `if (name === 'scrubGitEnv') return true` applied regardless of whether
// that name was actually invoked, locally shadowed, or even imported. Each
// of those looseness's is exactly one of the six bypasses:
//   1. `env: scrubGitEnv` (uninvoked reference) — the hardcoded name-match
//      didn't check for a trailing `(`.
//   2. `{ ...scrubGitEnv(), GIT_DIR: hostile }` — a real scrubGitEnv() call
//      IS present as a substring, but a later key in the same object
//      re-adds what it just stripped.
//   3. a same-file `function scrubGitEnv() { return process.env; }`
//      shadowing the import — the hardcoded name-match trusted the NAME,
//      not what it resolves to in scope.
//   4. an unbalanced `(` inside a string argument (e.g. `['foo(']`) — the
//      paren-balance scanner wasn't string-aware, so it could run past the
//      call's real closing paren and swallow a LATER, unrelated
//      `scrubGitEnv(` call into the "same" extracted text.
//   5. a wrapper that scrubs on only one branch — the body check was a bare
//      substring test with no control-flow awareness.
//   6. `scrubGitEnv()` appearing only inside a comment — the scan never
//      stripped comments before searching.
//
// Bypasses 1, 2, 3, 4 and 6 are closed structurally, not by matching each
// PoC's literal shape:
//   - `stripComments()` removes `//` and `/* */` content (string-aware, so
//     a `//` or `/*` inside a real string literal is not mistaken for a
//     comment opener) before ANY scrub-detection pattern runs against
//     extracted text — closes 6, and would close a comment-hidden hostile
//     override the same way.
//   - `scanBalanced()` (used by both `extractCallText` and
//     `extractDeclarationBody`) skips over quoted-string and
//     template-literal content entirely when counting matching brackets, so
//     a paren embedded in a string can never desynchronize the boundary —
//     closes 4.
//   - `findEnvValue()` now distinguishes an INVOKED reference (`NAME(`) from
//     a bare one (`NAME` with no trailing paren) — `isTerminal()` refuses to
//     trust `scrubGitEnv`/`runCommand` by name unless `invoked` is true —
//     closes 1.
//   - `isTerminal()` also refuses to trust either name if the file has a
//     LOCAL declaration of that name (`hasLocalDeclaration`) — a shadow
//     takes priority, and `resolvesToScrub` inspects the SHADOW's own body
//     instead of the trusted terminal — closes 3. It also requires a
//     verified import path (`fileImportsFrom`, extended to recognize the
//     CommonJS `require(path.join(...))` shape pinokio-scripts uses, not
//     just a bare string-literal require) — a site that forgot the import
//     is now flagged as unscrubbed instead of silently trusted, closing the
//     asymmetry with `runCommand`'s existing (weaker) import check and the
//     "passes the guard, throws ReferenceError at runtime" failure mode.
//   - `hasHostileOverride()` scans for the literal attack shape — a
//     `...scrubGitEnv(...)` spread followed OR preceded, in the same
//     brace-delimited scope, by one of the four repo-location keys as an
//     object-literal property — and vetoes the match regardless of any
//     other passing signal. `isExactScrubSpreadObject()` independently
//     requires an inline object-literal `env:` value to be NOTHING BUT a
//     `...scrubGitEnv(...)` spread — both close 2. Neither is a general
//     data-flow prover; see KNOWN BLIND SPOTS for what they still miss.
//
// Bypass 5 (branch-only scrub) is NOT closed — see the KNOWN BLIND SPOT
// test near the bottom. Detecting it needs real control-flow/reachability
// analysis (which return paths are live), which is out of scope for a
// source-text scanner. Recording it honestly rather than pretending a
// partial textual heuristic covers it.
//
// --- Resolving whether a match is scrubbed ------------------------------
// For each matched call, extract its full call-expression text
// (`extractCallText`, string/comment-aware balanced-paren scan), strip
// comments, veto on a hostile-override signature, then check — in this
// order, but as independent proofs (any ONE passing is enough; a wrapper
// that unconditionally scrubs makes a call safe regardless of what its own
// `env:` value happens to be):
//   (a) an `env:` key (or object-shorthand `env`) whose value is a call to,
//       or a same-file wrapper that resolves (through `resolvesToScrub`) to,
//       a verified `scrubGitEnv`/`runCommand` invocation;
//   (b) an `env:` key whose value is an inline object literal that is
//       EXACTLY a `...scrubGitEnv(...)` spread and nothing else;
//   (c) the call's own CALLEE NAME resolves the same way as (a) — covers a
//       wrapper invoked with no `env:` key visible at the call site at all,
//       e.g. sync-wiki.mjs's `run('git', args, cwd)`.
//
// --- KNOWN BLIND SPOTS (a source-text scan can't see everything) --------
//   - Bypass 5 (branch-only scrub) — see above; has its own test.
//   - The SAME shape, one level up: a scrub call present but in genuinely
//     DEAD/unreachable code (an `if (false)` block, code after an
//     unconditional `return`/`throw`). No control-flow analysis here either.
//     This also means the dedicated `runCommand` scrub-property test below
//     can't tell a live scrub apart from a dead one — it reuses the same
//     extraction machinery as the main scanner (so it's no longer a bespoke
//     regex probe), but inherits this same limitation, honestly.
//   - Same coverage gaps as gh-chokepoint's scanner: a binary held in a
//     variable, a command string built by concatenation, computed member
//     access / .call/.apply, a leading argument before 'git' that isn't a
//     simple token (bare identifier / number / quoted string).
//   - Resolution is same-file only, except the two explicit, import-verified
//     terminal names (`scrubGitEnv`, `runCommand`) — a wrapper defined in a
//     THIRD file is not chased.
//   - Resolution caps at MAX_RESOLVE_DEPTH hops through bare-identifier/
//     bare-call chains; a longer chain reports a (false-positive) violation
//     rather than silently passing — the safer failure direction for a
//     guard.
//   - An `env:` value that is not a bare identifier, a bare call, or an
//     exact scrub-spread object — a member expression, a ternary, a
//     template literal, multiple spreads — is not resolved; same
//     "reports a violation instead of guessing" bias.
//   - `hasHostileOverride`/`isExactScrubSpreadObject` catch the ONE
//     demonstrated attack shape (spread-then-key or key-then-spread within
//     the same brace scope). They are pattern matches, not a real object-
//     merge evaluator — e.g. mutating an already-scrubbed variable
//     afterward (`const env = scrubGitEnv(); env.GIT_DIR = 'x';`) is NOT
//     detected. Not one of the six demonstrated bypasses, named here for
//     honesty since it's the same class.
//   - scripts/tests/** and pinokio-scripts/**/*.test.js are OUT OF SCOPE —
//     these create throwaway git repos as test fixtures under an explicit
//     cwd, a different risk profile than the ambient-env hazard this issue
//     is about, and #2216's own enumeration is scoped to production
//     tooling. This file itself is also excluded (its fixtures deliberately
//     contain the literal patterns being scanned for).
//   - PowerShell/Python scripts under scripts/ are NOT scanned — same
//     documented gap as gh-chokepoint (none call git today).
//   - `scrubGitEnv`/`runCommand` imported under an ALIAS (`as`-renamed) are
//     not recognized as the terminal names — only the canonical names are
//     checked for.
//   - `fileImportsFrom` checks a path-SUFFIX match, not a resolved canonical
//     path: `import { scrubGitEnv } from '../../evil/git-env.mjs'` passes,
//     because the specifier text ends in `git-env.mjs`. Adversarial-only —
//     no accidental typo produces this shape, only a deliberately-planted
//     decoy file — and closing it needs real relative-path resolution
//     against the scanned file's own directory (does `../../evil/
//     git-env.mjs`, resolved from THIS file, actually point at
//     scripts/git-env.mjs?), which is out of scope for a source-text
//     scanner. Deliberately left open rather than partially patched; see
//     its own test below for the honest proof.
//   - `'git'` as a THIRD (or later) argument — `foo(a, b, 'git', args)` — is
//     not recognized. Shape 1's leading-token handling only covers a single
//     optional token before 'git', matching the one real second-argument
//     shape in this repo (`runCommand(label, 'git', args)`); no real site
//     needs a third position today.

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
const GIT_LOCATION_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

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

// Removes `//` line comments and block comments from `text`, string-aware
// (a `//` or block-comment opener inside a real quoted string is not
// treated as a comment). Does not attempt to track `${…}` interpolation
// boundaries inside a template literal — see KNOWN BLIND SPOTS.
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const two = ch + (text[i + 1] ?? '');
    if (two === '//') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      out += '\n';
      i = nl + 1;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** String/comment-aware balanced-bracket scan. Starting at `openIndex`
 *  (which must point at `openChar`), returns the index just PAST the
 *  matching `closeChar`. Quoted-string and comment content is skipped
 *  entirely — a bracket inside a string can never affect the count (closes
 *  the #2216-review "unbalanced paren in a string argument" bypass). */
function scanBalanced(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === closeChar) {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return source.length;
}

/** Balanced-paren extraction of a call's full text, starting at the index
 *  of its callee identifier. String/comment-aware (see scanBalanced). */
function extractCallText(source, startIndex) {
  const openIdx = source.indexOf('(', startIndex);
  if (openIdx === -1) return source.slice(startIndex);
  const end = scanBalanced(source, openIdx, '(', ')');
  return source.slice(startIndex, end);
}

/** Extracts `export function NAME(...) { ... }` / `function NAME(...) {
 *  ... }` / `const NAME = (...) => { ... }`'s body text via string/comment-
 *  aware brace scanning, or null if no such declaration exists in
 *  `source`. */
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
  const openIdx = header.index + header[0].length - 1; // the opening '{'
  const end = scanBalanced(source, openIdx, '{', '}');
  return source.slice(openIdx, end);
}

/** TRUE if `source` has a LOCAL `function NAME(...)`/`const NAME =`/
 *  `let NAME =` declaration (as opposed to a destructured import, e.g.
 *  `const { NAME } = require(...)`, which this deliberately does NOT
 *  match). A local declaration SHADOWS an import of the same name — see
 *  isTerminal(). */
function hasLocalDeclaration(source, name) {
  const re = new RegExp(
    `\\b(?:export\\s+)?(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=|let\\s+${name}\\s*=)`,
  );
  return re.test(source);
}

/** Does the scanned file import `importedName` from a path whose SPECIFIER
 *  TEXT ends in `pathSuffix`? This is a suffix match on the literal source
 *  text, not a resolved canonical path — it does not follow `../` segments
 *  or verify the specifier actually reaches scripts/git-env.mjs /
 *  scripts/lib/run-command.mjs on disk. See KNOWN BLIND SPOTS for the
 *  adversarial gap that leaves open (a decoy `evil/git-env.mjs`) and why it
 *  is deliberately not closed. Recognizes the ESM form AND the CommonJS
 *  `const { name } = require(<expr>)` form where `<expr>` may be a bare
 *  string literal OR an arbitrary expression (e.g.
 *  `path.join(__dirname, …, 'git-env.mjs')`, pinokio-scripts/lib/
 *  resolve-release.js's real shape) — the require call's own argument text
 *  just needs SOME quoted segment ending in `pathSuffix`. Guards the
 *  `scrubGitEnv`/`runCommand` scrub-terminal trust — see header. */
export function fileImportsFrom(source, importedName, pathSuffix) {
  const suffixPattern = pathSuffix.replace(/[.]/g, '\\.');
  const esm = new RegExp(
    `import\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s*from\\s*(['"\`])[^'"\`]*${suffixPattern}\\1`,
  );
  if (esm.test(source)) return true;

  const destructureRe = new RegExp(
    `(?:const|let|var)\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s*=\\s*require\\s*\\(`,
    'g',
  );
  let m;
  while ((m = destructureRe.exec(source))) {
    const openIdx = m.index + m[0].length - 1; // the '(' of require(
    const end = scanBalanced(source, openIdx, '(', ')');
    const argsText = source.slice(openIdx, end);
    const quotedSuffixRe = new RegExp(`['"\`][^'"\`]*${suffixPattern}['"\`]`);
    if (quotedSuffixRe.test(argsText)) return true;
  }
  return false;
}

/** Detects the demonstrated attack shape: a `...scrubGitEnv(...)` spread
 *  and one of the four repo-location keys as an object-literal property,
 *  in either order, within the same (unbraced-scoped-by-`}`) text. A veto —
 *  if this matches, the caller treats the match as unscrubbed regardless
 *  of any other positive signal. Pattern-based, not a real merge evaluator
 *  — see KNOWN BLIND SPOTS. */
function hasHostileOverride(text) {
  const keyAlt = GIT_LOCATION_KEYS.join('|');
  const spreadThenKey = new RegExp(
    `\\.\\.\\.\\s*scrubGitEnv\\s*\\([^)]*\\)[^}]*\\b(?:${keyAlt})\\s*:`,
  );
  const keyThenSpread = new RegExp(`\\b(?:${keyAlt})\\s*:[^}]*\\.\\.\\.\\s*scrubGitEnv\\s*\\(`);
  return spreadThenKey.test(text) || keyThenSpread.test(text);
}

/** TRUE if `name`, resolved within `source`, provably applies scrubGitEnv —
 *  directly, through a same-file wrapper's body, or through the
 *  run-command.mjs chokepoint (only when imported from the canonical path
 *  and not locally shadowed). See header for the full algorithm. `invoked`
 *  must be true for `name` to be trusted as a terminal by itself (a bare,
 *  uninvoked reference is never sufficient). */
function resolvesToScrub(source, name, depth, invoked) {
  if (depth > MAX_RESOLVE_DEPTH) return false;

  // A local declaration always takes priority — even for the two terminal
  // names themselves, since a same-file redefinition SHADOWS an import.
  const body = extractDeclarationBody(source, name);
  if (body !== null) {
    const clean = stripComments(body);
    if (hasHostileOverride(clean)) return false;
    if (/\bscrubGitEnv\s*\(/.test(clean) && isTerminal(source, 'scrubGitEnv', true)) return true;
    if (/\brunCommand\s*\(/.test(clean) && isTerminal(source, 'runCommand', true)) return true;
    return false;
  }

  if (isTerminal(source, name, invoked)) return true;

  // Plain variable: `const NAME = <expr>;`
  const varMatch = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;\\n]+);`).exec(source);
  if (varMatch) {
    const rhs = stripComments(varMatch[1]).trim();
    if (hasHostileOverride(rhs)) return false;
    if (/\bscrubGitEnv\s*\(/.test(rhs) && isTerminal(source, 'scrubGitEnv', true)) return true;
    const callMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rhs);
    if (callMatch) return resolvesToScrub(source, callMatch[1], depth + 1, true);
  }
  return false;
}

/** TRUE if `name` is one of the two trusted scrub-terminal names, actually
 *  INVOKED (not just referenced), not locally shadowed, and imported from
 *  its canonical path. */
function isTerminal(source, name, invoked) {
  if (!invoked) return false;
  if (hasLocalDeclaration(source, name)) return false; // shadowed — caller resolves the shadow's own body instead
  if (name === 'scrubGitEnv') return fileImportsFrom(source, 'scrubGitEnv', 'git-env.mjs');
  if (name === 'runCommand') return fileImportsFrom(source, 'runCommand', 'run-command.mjs');
  return false;
}

/** Finds the `env:` key's value within a call's extracted text — a call
 *  (`env: NAME(`, isCall true), a bare identifier (`env: NAME` with no
 *  trailing paren, or shorthand `{ env }`, isCall false) — or null. Does
 *  NOT match an inline object literal (`env: { ... }`) — see
 *  findEnvObjectLiteral for that shape. */
function findEnvValue(callText) {
  let m = /\benv\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(callText);
  if (m) return { name: m[1], isCall: true };
  m = /\benv\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/.exec(callText);
  if (m) return { name: m[1], isCall: false };
  m = /(?:\{|,)\s*(env)\s*(?=[,}])/.exec(callText);
  if (m) return { name: 'env', isCall: false };
  return null;
}

/** Finds an inline object-literal `env:` value (`env: { ... }`) and
 *  returns its full `{ ... }` text (string/comment-aware balanced-brace
 *  extraction), or null. */
function findEnvObjectLiteral(callText) {
  const m = /\benv\s*:\s*\{/.exec(callText);
  if (!m) return null;
  const openIdx = callText.indexOf('{', m.index);
  const end = scanBalanced(callText, openIdx, '{', '}');
  return callText.slice(openIdx, end);
}

/** TRUE if `objText` (a `{ ... }` slice) contains NOTHING but a single
 *  `...scrubGitEnv(...)` spread — no other property, no other spread. This
 *  independently closes the #2216-review "spread-then-override" bypass:
 *  `{ ...scrubGitEnv(), GIT_DIR: hostile }` fails this (trailing content
 *  after the call's closing paren), and so does `{ GIT_DIR: hostile,
 *  ...scrubGitEnv() }` (content doesn't START with `...`). */
function isExactScrubSpreadObject(objText) {
  const inner = objText.slice(1, -1).trim().replace(/,\s*$/, '');
  return /^\.\.\.\s*scrubGitEnv\s*\([^]*\)$/.test(inner);
}

/** TRUE if the extracted call `rawCallText` (callee `calleeName`) is
 *  provably scrubbed. See the header's "Resolving whether a match is
 *  scrubbed" section for the algorithm. */
function isCallScrubbed(source, calleeName, rawCallText) {
  const clean = stripComments(rawCallText);
  if (hasHostileOverride(clean)) return false;

  const envVal = findEnvValue(clean);
  if (envVal) {
    if (resolvesToScrub(source, envVal.name, 0, envVal.isCall)) return true;
  } else {
    const objLit = findEnvObjectLiteral(clean);
    if (
      objLit &&
      isExactScrubSpreadObject(objLit) &&
      resolvesToScrub(source, 'scrubGitEnv', 0, true)
    ) {
      return true;
    }
  }

  return resolvesToScrub(source, calleeName, 0, true);
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
      if (!isCallScrubbed(source, calleeName, callText)) {
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
// runCommand ITSELF unconditionally scrubs. Pin that directly, reusing the
// SAME extraction/verification machinery the main scanner uses (not a
// bespoke regex probe — see the header's "What changed" section on why a
// standalone `assert.match` probe was itself one of the review's findings).
// Still cannot distinguish a LIVE scrub call from a dead-code one — see
// KNOWN BLIND SPOTS.

test('runCommand (scripts/lib/run-command.mjs) applies scrubGitEnv to the env it hands to spawnSync', () => {
  const source = readFileSync(runCommandPath, 'utf8');
  const body = extractDeclarationBody(source, 'runCommand');
  assert.ok(body, "expected to find runCommand's declaration in run-command.mjs");
  const clean = stripComments(body);
  assert.ok(
    !hasHostileOverride(clean),
    "runCommand's env composition must not spread scrubGitEnv() and then re-add a GIT_* key",
  );
  assert.match(
    clean,
    /\bscrubGitEnv\s*\(/,
    'runCommand must invoke scrubGitEnv when composing the env it hands to spawnSync',
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
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "execFileSync('git', ['status'], { encoding: 'utf8', env: scrubGitEnv() });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
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
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "execSync('git status', { env: scrubGitEnv() });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
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
    "import { scrubGitEnv } from './git-env.mjs';",
    'function gitEnv() { return scrubGitEnv(); }',
    "spawnSync('git', ['status'], { env: gitEnv() });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION: deleting scrubGitEnv() from the wrapper body makes the SAME call site fail', () => {
  // Same fixture as above, minus the wrapper's own scrub call — simulates
  // #2216's git-env.mjs-composing gitEnv() helper in verify-cache.mjs
  // losing its scrub. This is the synthetic proof of "fail if the scrub is
  // deleted from an already-covered site": the call SITE text is unchanged,
  // only the callee's OWN body regressed, and the guard still goes red.
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    'function gitEnv() { return { ...process.env }; }', // scrub deleted
    "spawnSync('git', ['status'], { env: gitEnv() });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('findUnscrubbedGitCalls resolves env, via a bare-identifier chase to a wrapper (branchDiffFiles shape)', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    'function gitEnv() { return scrubGitEnv(); }',
    'const env = gitEnv();',
    "spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd, encoding: 'utf8', env });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION: deleting the wrapper call from the chased variable makes the SAME call site fail', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
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

// --- Review-round-2 bypasses (#2216 / PR #2227), each closed ---------------

test('NEUTRALISATION (bypass 1 — uninvoked name): `env: scrubGitEnv` with no trailing parens is NOT trusted', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], { env: scrubGitEnv });", // reference, never called
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('NEUTRALISATION (bypass 2 — spread then override): `{ ...scrubGitEnv(), GIT_DIR: hostile }` is caught', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], { env: { ...scrubGitEnv(), GIT_DIR: hostile } });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('NEUTRALISATION (bypass 2, reversed order): `{ GIT_DIR: hostile, ...scrubGitEnv() }` is caught', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], { env: { GIT_DIR: hostile, ...scrubGitEnv() } });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('findUnscrubbedGitCalls passes an inline env object that is EXACTLY a scrubGitEnv() spread', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], { env: { ...scrubGitEnv() } });",
  ].join('\n');
  assert.deepEqual(findUnscrubbedGitCalls(src), []);
});

test('NEUTRALISATION (bypass 3 — shadowing): a same-file scrubGitEnv() returning process.env unscrubbed is not trusted', () => {
  const src = [
    'function scrubGitEnv() { return process.env; }', // shadows the real one; never imported here
    "spawnSync('git', ['status'], { env: scrubGitEnv() });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'spawnSync');
});

test('NEUTRALISATION (bypass 3b — forgot the import): scrubGitEnv() with no import in this file is not trusted', () => {
  const src = "spawnSync('git', ['status'], { env: scrubGitEnv() });"; // no import at all
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(
    violations.length,
    1,
    'a call site that would ReferenceError at runtime must not pass the guard',
  );
});

test('NEUTRALISATION (bypass 4 — unbalanced paren in a string argument): does not swallow a later unrelated scrubGitEnv(', () => {
  const src = [
    "execFileSync('git', ['foo('], {});", // no scrub, and an unbalanced '(' inside the string arg
    '',
    "import { scrubGitEnv } from './git-env.mjs';",
    'function unrelatedLegit() { return scrubGitEnv(); }', // a later, real, unrelated scrub call
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(
    violations.length,
    1,
    "the unbalanced '(' inside the string must not let the paren scan run into unrelatedLegit's scrubGitEnv(",
  );
  assert.equal(violations[0].kind, 'execFileSync');
});

test('NEUTRALISATION (bypass 6 — comment only): scrubGitEnv() appearing ONLY in a comment inside the call is not trusted', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], {",
    '  // env: scrubGitEnv(),',
    '});',
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
});

test('NEUTRALISATION (bypass 6b — block comment): scrubGitEnv() inside a /* */ comment is not trusted', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    "spawnSync('git', ['status'], { /* env: scrubGitEnv() */ });",
  ].join('\n');
  const violations = findUnscrubbedGitCalls(src);
  assert.equal(violations.length, 1);
});

// --- KNOWN BLIND SPOT (bypass 5 — NOT closed): branch-only scrub -----------
// A wrapper that only scrubs on one control-flow path still passes, because
// the body check is a text-presence test, not a reachability analysis. This
// is not a partial fix pretending to cover it — it is an honest, exercised
// gap, matching this repo's convention (see gh-chokepoint.test.mjs's own
// KNOWN BLIND SPOT tests) of proving a documented limitation rather than
// only asserting it in prose.

test('KNOWN BLIND SPOT: a wrapper that scrubs on only ONE branch is not detected', () => {
  const src = [
    "import { scrubGitEnv } from './git-env.mjs';",
    'function gitEnv(cond) {',
    '  if (cond) { return scrubGitEnv(); }',
    '  return process.env;', // the live default path is unscrubbed
    '}',
    "spawnSync('git', ['status'], { env: gitEnv(false) });",
  ].join('\n');
  assert.deepEqual(
    findUnscrubbedGitCalls(src),
    [],
    'documented gap: this scanner has no control-flow analysis and cannot tell a live scrub ' +
      'path from a dead one — see the header KNOWN BLIND SPOTS',
  );
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

// --- fileImportsFrom: the CommonJS require(path.join(...)) shape ---------
// pinokio-scripts/lib/resolve-release.js's real import is `const {
// scrubGitEnv } = require(path.join(__dirname, '..', '..', 'scripts',
// 'git-env.mjs'))` — NOT a bare string-literal require(). This pins that
// fileImportsFrom recognizes it (a regression here would silently flag
// every git call in that file as unscrubbed).

test('fileImportsFrom recognizes require(path.join(...)) — not just a bare string literal require()', () => {
  const src =
    "const { scrubGitEnv } = require(path.join(__dirname, '..', '..', 'scripts', 'git-env.mjs'));";
  assert.equal(fileImportsFrom(src, 'scrubGitEnv', 'git-env.mjs'), true);
});

test('fileImportsFrom still recognizes a bare string-literal require()', () => {
  const src = "const { runCommand } = require('./lib/run-command.mjs');";
  assert.equal(fileImportsFrom(src, 'runCommand', 'run-command.mjs'), true);
});

test('fileImportsFrom returns false when the name is not actually imported', () => {
  const src = "const { somethingElse } = require('./git-env.mjs');";
  assert.equal(fileImportsFrom(src, 'scrubGitEnv', 'git-env.mjs'), false);
});

// --- Documented, NOT-closed gaps (honest proof, not just a header claim) ---

test('KNOWN BLIND SPOT: fileImportsFrom accepts a decoy path that merely ends in the right filename', () => {
  const src = "import { scrubGitEnv } from '../../evil/git-env.mjs';";
  assert.equal(
    fileImportsFrom(src, 'scrubGitEnv', 'git-env.mjs'),
    true,
    'documented gap: this is a suffix match on specifier text, not a resolved canonical ' +
      'path — see the header KNOWN BLIND SPOTS',
  );
});

test("KNOWN BLIND SPOT: 'git' as a third (or later) argument is not detected", () => {
  const violations = findUnscrubbedGitCalls("someWrapper('probe', 'label2', 'git', ['status']);");
  assert.deepEqual(
    violations,
    [],
    'documented gap: the leading-token handling covers only ONE optional token before ' +
      "'git' — see the header KNOWN BLIND SPOTS",
  );
});
