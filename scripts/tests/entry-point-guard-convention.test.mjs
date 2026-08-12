// Guards the #2291 fix from regressing: no scripts/*.mjs|*.mts file may
// hand-roll a NEW direct-execution guard instead of going through
// scripts/lib/is-main-module.mjs's isDirectlyInvoked().
//
// SCOPE (widened by two repo-wide sweeps that found the same class OUTSIDE
// scripts/, where the original version of this scan never looked — a
// shipped launcher, 9 sidecar installer scripts, and 3 server/src TypeScript
// entry points were all still hand-rolling the un-realpathed comparison).
// This file now scans FOUR roots:
//   1. scripts/**  (excluding scripts/tests/) — the original #2291 scope.
//   2. The repo root's top-level *.mjs/*.mts files only, NOT recursive —
//      today that's just launch.mjs (the release-zip's stable entry point)
//      and eslint.config.mjs (clean; doesn't reference either token).
//   3. server/tts-sidecar/scripts/**  (excluding any tests/ subdir, though
//      none exists there today) — the sidecar's installer/bootstrap CLIs,
//      all reachable from the running app (VenvBootstrap route, Account →
//      Models UI) or as documented manual troubleshooting commands.
//   4. server/src/**  (*.ts/*.mts, excluding any tests/ subdir, though none
//      exists there today) — the TypeScript backend, added after a sweep
//      found the production server's own entry point (index.ts) and two
//      attribution-eval CLIs hand-rolling the same broken comparison. This
//      root was deliberately left OUT of the original #2291/repo-wide fixes
//      pending its own false-positive check (server/src is a much larger,
//      actively-developed tree); that check found exactly one false
//      trigger — a doc comment quoting `process.argv[1]` as prose, not an
//      actual guard — which was fixed by rewording the comment rather than
//      allowlisting it. See MIGRATED_SITES_SERVER_SRC below.
// A file in ANY of the four roots is checked against the same positive
// invariant below; violations from all four are reported together.
//
// Detection envelope (read before trusting a green run here):
//
// WHAT THIS CATCHES: a POSITIVE invariant, not a blacklist of specific
// broken spellings. Any production file under the four roots above
// (excluding their own tests/ dirs and the helper itself) whose source
// references BOTH the `import.meta.url` token AND an argv[1]-shaped token
// (see HAS_ARGV1_TOKEN below) is treated as "this file is doing SOME kind
// of direct-invocation check" — those are the only two ingredients any
// such check (hand-rolled or not) needs. If it also doesn't import+use
// isDirectlyInvoked from is-main-module.mjs, it's a violation. This is
// deliberately broader than "detect an equality operator between the
// two": the first sweep of this fix (#2291) caught 22 sites with a
// literal `import.meta.url === X` comparison via exactly that narrower
// regex, then MISSED 14 more sites using
// `resolve(argv[1]) === fileURLToPath(import.meta.url)` (an
// intermediate-variable shape, still an equality, but spelled differently
// enough that the operator-adjacency regex didn't match it) and 5 more
// using `import.meta.url === \`file://${argv[1]}\`` (a template-literal
// spelling of the same equality). A second, repo-wide sweep then found 10
// MORE sites this scan's scripts/-only walk couldn't see at all — not a
// new spelling, but a location the scan never visited (launch.mjs at the
// repo root, and 9 files under server/tts-sidecar/scripts/ using
// `import.meta.url === pathToFileURL(process.argv[1]).href`, a shape that
// handles the Windows two-vs-three-slash issue but still skips the
// realpath step, so it still misses across a junction). A THIRD sweep then
// found 10 more sites this scan COULD see (they're inside scripts/) but
// whose shape it was blind to: a pure basename/suffix match on
// `process.argv[1]` alone with zero `import.meta.url` references anywhere
// in the file (guard-commit-subjects.mjs, guard-protected-push.mjs,
// is-docs-only-push.mjs, remint-anchored-variants.mjs,
// repair-narrator-credit.mjs, validate-commit-msg.mjs,
// validate-pr-issue-link.mjs, wt-list.mjs, wt-merge.mjs, wt-new.mjs) — see
// the next section, this used to be listed as an accepted gap rather than
// an actual finding, which was itself wrong (a false "no file does this"
// claim sitting next to 10 files that did). All ten are migrated now and
// live in MIGRATED_SITES below. Enumerating known EQUALITY shapes as
// additional regexes would still miss a future one — a NEW file that
// computes the comparison via a helper function, a switch, a Set.has(), or
// anything else that isn't textually an operator next to the token. The
// "references both tokens, doesn't route through the shared helper"
// invariant catches all of those by construction, because there is no way
// to compare "was this file the entry point" other than consulting both
// import.meta.url and SOME reference to argv[1] somehow — PROVIDED the
// argv[1] reference is one HAS_ARGV1_TOKEN actually matches, which is
// narrower than "any argv[1] access" (see HAS_ARGV1_TOKEN's own comment,
// and the next section, for the one indirection shape even the widened
// regex can't see). It does NOT, however, catch a violation living
// somewhere this scan never walks — see the next paragraph.
//
// WHAT THIS CANNOT CATCH:
//  - A file outside all four scanned roots. A fifth CLI-shaped directory
//    (e.g. a future apps/android tool, or a new top-level scripts-like
//    folder) would be invisible until added here. server/src/** WAS this
//    gap until it was folded in as the fourth root above — its three #2291
//    sites (index.ts, attribution-eval/capture-cli.ts,
//    attribution-eval/run-eval-cli.ts) were found and migrated by a repo-
//    wide sweep before the scan itself could see that directory at all; a
//    new hand-rolled guard landing there today IS now caught, by
//    `walkServerSrcTree` and MIGRATED_SITES_SERVER_SRC below.
//  - An indirect argv[1] access where "1" isn't textually adjacent to
//    `argv` — e.g. `const IDX = 1; process.argv[IDX]`. HAS_ARGV1_TOKEN
//    matches four textual shapes (`argv[1]`, `argv.at(1)`, `argv.slice(1)`,
//    and the `[, x] = process.argv` destructure that skips argv[0] to bind
//    argv[1] as `x`) — chosen because between them they cover every
//    concrete spelling found in this repo (including the reviewer-supplied
//    fixtures pinned by the "detector envelope" tests below) while a
//    fully-unbounded `/process\.argv\b/` was tried and rejected: simulated
//    against this repo it flags 9 files whose only argv/import.meta.url
//    usage is ordinary CLI-flag parsing (`.slice(2)`, `.includes('--x')`,
//    `process.argv[2]`) with no direct-invocation check anywhere, each of
//    which would need its own ALLOWLIST entry to explain away — pure noise
//    that would bury the next real finding under it. A dataflow-indirect
//    case like the `IDX` example above is undetectable by any local regex
//    (the "1" isn't in the same textual token as `argv` at all) — accepted
//    as a residual gap, same tier as the next bullet, rather than chased
//    with a dataflow analyzer this repo has no other use for.
//  - A guard built on a completely different mechanism that never
//    references import.meta.url at all when deciding whether it's the
//    entry point — e.g. one that compares `__filename` (CommonJS-style, or
//    a hand-derived equivalent) instead, or builds the comparison string
//    dynamically at runtime rather than referencing either token literally.
//    Locating "is this the entry point" logic with no import.meta.url
//    reference anywhere in the file is unusual enough (and easy enough to
//    catch in review) that this residual gap is accepted rather than built
//    for.
//  - A file where the two tokens appear for entirely unrelated reasons
//    (e.g. import.meta.url used only for __dirname, argv[1] used only as a
//    positional CLI argument, with no direct-invocation check anywhere).
//    None of the current files hit this today (verified by the ALLOWLIST
//    review test below, which asserts every allowlisted file still
//    contains a recognizable direct-invocation shape) but a new one would
//    need an allowlist entry with that reasoning documented, same as any
//    other exception.
//  - A non-`.mjs`/`.mts` file. `scripts/preflight-ffmpeg.cjs` uses
//    `require.main === module` — CommonJS's own equivalent, which is NOT
//    vulnerable to this bug (require.main and module are both resolved by
//    the same CJS loader instance, so there's no realpath-mismatch
//    opportunity) — so it's correctly out of scope, not a gap.
//  - Whether the shared helper (scripts/lib/is-main-module.mjs) actually
//    SHIPS to the files that import it. A migrated-but-shipped file
//    importing a helper that isn't in the release zip's manifest is a
//    different failure mode (a hard crash, not a silent no-op) — covered
//    separately, by the "shared helper ships in the release zip" test
//    near the bottom of this file, not by the scan above.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { matchesManifest } from '../build-release-zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(here, '..');
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
const SIDECAR_SCRIPTS_DIR = resolve(REPO_ROOT, 'server', 'tts-sidecar', 'scripts');
const SERVER_SRC_DIR = resolve(REPO_ROOT, 'server', 'src');

// The two ingredients ANY direct-invocation check needs, regardless of how
// it's spelled — see the header above for why this is a positive
// invariant rather than a list of known-bad equality spellings.
const HAS_URL_TOKEN = /import\.meta\.url/;
// Four textual shapes of "this file reads argv[1]", not just the literal
// `argv[1]` subscript — a reviewer audit found three working, real guards
// this narrower form couldn't see: `process.argv.at(1)`,
// `process.argv.slice(1)[0]`, and `const [, entry] = process.argv;`
// (destructuring that skips argv[0] to bind argv[1] as `entry`). See the
// "WHAT THIS CANNOT CATCH" section above for why this stops short of a
// fully-unbounded `/process\.argv\b/` (it would drown in false positives
// from ordinary `.slice(2)`/`.includes('--x')` CLI-flag parsing) and for
// the one indirection shape (`const IDX = 1; argv[IDX]`) even this widened
// form still can't see. The four alternatives pinned by the "detector
// envelope" fixture tests below.
const HAS_ARGV1_TOKEN =
  /process\.argv\[1\]|process\.argv\.at\(1\)|process\.argv\.slice\(1\)|\[\s*,\s*\w+\s*\]\s*=\s*process\.argv\b/;

// Detects `import { isDirectlyInvoked } from '...is-main-module.mjs'` (or
// any relative depth) without caring about import-statement formatting.
const USES_HELPER = /isDirectlyInvoked/;
const IMPORTS_HELPER_FILE = /from\s+['"][^'"]*is-main-module\.mjs['"]/;

// Explicit, narrow, documented exceptions — same shape as the cast-lock
// guard's allowlist (server/src/workspace/cast-lock.guard.test.ts): each
// entry is keyed on an exact relative path, not a directory or a pattern,
// so a NEW unmigrated file is never silently swept in by name proximity.
const ALLOWLIST = new Map([]);

// The 54 sites this branch has migrated to date (22 from the original
// #2291 sweep + 14 from the resolve()/fileURLToPath equality shape + 5
// from the `file://${argv[1]}` template-literal shape + 2 from the
// basename/suffix-match shape originally allowlisted as immune + 1,
// run-sidecar-tests.mjs, migrated off its own hand-rolled double-realpath
// fix once PR #2293 merged and this branch picked it up + 10 more found by
// a later review pass: a pure basename/suffix match on process.argv[1]
// alone with zero import.meta.url references anywhere in the file — a
// shape this scan's scripts/ walk could see fine but the old
// HAS_ARGV1_TOKEN/header wrongly claimed no file in the repo used) — used
// below to assert the migration is actually complete, not just that
// nothing NEW regresses. Keeping this list literal (rather than deriving
// it from the scan) means a file silently falling OUT of the scan's view
// (e.g. an edit that removes the raw-comparison text without adding the
// helper import) still gets caught.
const MIGRATED_SITES = [
  // Original 22-file sweep (literal `import.meta.url === X` shape).
  'build-demo-covers.mjs',
  'capture-companion.mjs',
  'check-import-cycles.mjs',
  'ci-scope.mjs',
  'code-stats.mjs',
  'diff-analysis-ab.mjs',
  'eval-attribution.mjs',
  'generate-release-notes-wiki.mjs',
  'run-golden-audio.mjs',
  'sync-wiki.mjs',
  'verify-cache.mjs',
  'backlog-sync.mjs',
  'bulk-add-project-items.mjs',
  'bump-version.mjs',
  'check-no-budget-poll.mjs',
  'clear-done-project-items.mjs',
  'link-sub-issues.mjs',
  'migrate-backlog-to-issues.mjs',
  'release-body.mjs',
  'release-notes-gate.mjs',
  'render-brand-pngs.mjs',
  'strip-chore-moscow-labels.mjs',
  // 14 sites with the resolve()/fileURLToPath equality shape.
  'build-companion-apk.mjs',
  'build-release-zip.mjs',
  'launch-sidecar.mjs',
  'start-app.mjs',
  'start-app-prod.mjs',
  'quarantine-health.mjs',
  'recover-missing-character.mjs',
  'relufs-existing.mjs',
  'rexing-existing.mjs',
  'restart-after-upgrade.mjs',
  'setup-versioned-install.mjs',
  'stage-marketing-screenshots.mjs',
  'sync-docs-to-public.mjs',
  'repair-cast-id-drift.mjs',
  // 5 sites with the `file://${argv[1]}` + basename-fallback shape,
  // migrated for consistency (they were not broken — the basename fallback
  // already rescued them — but the point of this branch is one shared
  // mechanism, not N).
  'invalidate-stale-qwen-base-samples.mjs',
  'mdns-responder.mjs',
  'repair-qwen-voice-uuid-keys.mjs',
  'setup-lan-certs.mjs',
  'transition-local-to-castwright.mjs',
  // 2 sites with a pure argv[1]-only basename/suffix-match shape,
  // originally allowlisted as "immune to realpath/junction mismatch" but
  // migrated anyway for consistency — the point of this branch is one shared
  // mechanism across all scripts, not multiple fallback patterns.
  'check-onbox-register.mjs',
  'repair-missing-book-language.mts',
  // The formerly-allowlisted site: fixed independently on PR #2293 with its
  // own hand-rolled double-realpath copy, migrated onto the shared helper
  // now that #2293 has merged and this branch picked it up.
  'run-sidecar-tests.mjs',
  // 10 sites with a pure argv[1]-only basename/suffix-match shape and ZERO
  // import.meta.url references anywhere in the file — the blind spot the
  // header used to (wrongly) claim was empty. Several are husky-hook or CI
  // entry points (validate-commit-msg.mjs is the commit-msg hook;
  // guard-protected-push.mjs and is-docs-only-push.mjs run in pre-push;
  // guard-commit-subjects.mjs backstops pre-push; validate-pr-issue-link.mjs
  // is a required CI check; wt-new.mjs/wt-merge.mjs/wt-list.mjs are the
  // worktree tooling) — each was smoke-run through its real invocation
  // shape (commit-msg file, simulated pre-push stdin, direct CLI args)
  // before and after migration to confirm identical behavior.
  'guard-commit-subjects.mjs',
  'guard-protected-push.mjs',
  'is-docs-only-push.mjs',
  'remint-anchored-variants.mjs',
  'repair-narrator-credit.mjs',
  'validate-commit-msg.mjs',
  'validate-pr-issue-link.mjs',
  'wt-list.mjs',
  'wt-merge.mjs',
  'wt-new.mjs',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (relative(SCRIPTS_DIR, full) === 'tests') continue; // avoid comment false-positives
      out.push(...walk(full));
    } else if (/\.(mjs|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function relScripts(absPath) {
  return relative(SCRIPTS_DIR, absPath).replace(/\\/g, '/');
}

// --- Detector envelope: pins HAS_ARGV1_TOKEN's own matching behavior
// directly, independent of any real file in the repo. A reviewer audit ran
// the (then-narrower, argv[1]-literal-only) regex over four working, real,
// junction-breakable guards and found all four invisible to it — this
// fixture set is exactly those four spellings, plus a handful of ordinary
// CLI-flag-parsing shapes that must NOT match (see the "WHAT THIS CANNOT
// CATCH" header section for why a fully-unbounded /process\.argv\b/ was
// rejected: simulated against this repo it flagged 9 files that only ever
// use process.argv for flag parsing, with zero direct-invocation check).
test('HAS_ARGV1_TOKEN matches every known argv[1]-access spelling', () => {
  const shouldMatch = [
    ['literal subscript', 'if (process.argv[1] === x) {}'],
    ['.at(1)', 'const entry = process.argv.at(1);'],
    ['.slice(1)[0]', 'const entry = process.argv.slice(1)[0];'],
    ['bare .slice(1)', 'const rest = process.argv.slice(1);'],
    ['destructure skipping argv[0]', 'const [, entry] = process.argv;'],
  ];
  for (const [label, code] of shouldMatch) {
    assert.ok(HAS_ARGV1_TOKEN.test(code), `expected to match (${label}): ${code}`);
  }
});

test('HAS_ARGV1_TOKEN does not match ordinary CLI-flag parsing (the false-positive it was calibrated against)', () => {
  const shouldNotMatch = [
    ['args starting after script path', 'const argv = process.argv.slice(2);'],
    ['positional arg at index 2', "const bookDir = process.argv[2];"],
    ['flag search', "const apply = process.argv.includes('--apply');"],
    ['flag value lookup', "const i = process.argv.indexOf('--book');"],
    ['destructure skipping argv[0] AND argv[1]', 'const [, , bookDir, slug] = process.argv;'],
  ];
  for (const [label, code] of shouldNotMatch) {
    assert.ok(!HAS_ARGV1_TOKEN.test(code), `expected NOT to match (${label}): ${code}`);
  }
});

test('HAS_ARGV1_TOKEN cannot see an indirect argv[1] access through a variable (documented, accepted gap)', () => {
  // Pinned as a KNOWN MISS, not a should-pass case — see the header's
  // "WHAT THIS CANNOT CATCH" section. This test fails (forcing a header
  // update) the day someone teaches the regex to see through indirection;
  // until then it documents the gap is real, not just claimed.
  const code = 'const IDX = 1;\nif (process.argv[IDX] === x) {}';
  assert.ok(
    !HAS_ARGV1_TOKEN.test(code),
    'this indirect-index shape was expected to stay invisible to the regex — if this now ' +
      'fails, HAS_ARGV1_TOKEN grew smarter than the header claims; update the header instead ' +
      'of just this assertion',
  );
});

// --- Extended scope (repo-wide sweep, see header): repo-root top-level
// files (non-recursive) and server/tts-sidecar/scripts/** (recursive,
// excluding any tests/ subdir — none exists there today, but the check is
// defensive rather than assuming that stays true).

function relRepo(absPath) {
  return relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

/** Immediate *.mjs/*.mts files in `dir` only — no recursion. */
function walkFlat(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (/\.(mjs|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Recursive *.mjs/*.mts walk of `dir`, skipping any 'tests' subdirectory. */
function walkTree(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'tests') continue; // avoid comment false-positives
      out.push(...walkTree(full));
    } else if (/\.(mjs|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Explicit, narrow, documented exceptions for the extended-scope roots —
// same shape and same "keyed on exact relative path" discipline as
// ALLOWLIST above, kept as its own map so a root-level or sidecar
// exception can never be confused with a scripts/ one.
//
// launch.mjs was migrated to the shared helper in this branch's first pass,
// then MOVED BACK to a hand-rolled (but still both-sides-realpath-correct)
// inline guard by a review round: it is the one file in the repo that ships
// OUTSIDE the versioned release directory (<install>/launch.mjs, stable,
// never replaced by an upgrade), while scripts/lib/is-main-module.mjs only
// ever ships under <install>/releases/vX.Y.Z/. Importing the shared helper
// there resolves fine in a dev checkout and even through a repo-link/
// junction (both scripts/lib/ and launch.mjs move together), but crashes at
// import time with ERR_MODULE_NOT_FOUND at the documented split-install
// layout — invisibly, since restart-after-upgrade.mjs spawns it detached
// with stdio: 'ignore'. See launch.mjs's own isDirectlyInvoked comment for
// the full reasoning, and scripts/tests/launch-install-layout.test.mjs for
// the regression coverage (that test fails against a helper-importing
// launch.mjs at this layout — this allowlist entry is not a green rubber
// stamp, it is what keeps this scan from re-flagging the correct fix).
const ALLOWLIST_EXTRA = new Map([
  [
    'launch.mjs',
    'Deliberately self-contained — see the comment by its own isDirectlyInvoked ' +
      'for why it cannot depend on scripts/lib/is-main-module.mjs (that only ships ' +
      'under <install>/releases/vX.Y.Z/, never at the install root launch.mjs lives at).',
  ],
]);

// The 9 sites the repo-wide sweep found outside scripts/'s original scan:
// server/tts-sidecar/scripts/ installer/bootstrap CLIs, all using the
// un-realpathed `import.meta.url === pathToFileURL(process.argv[1]).href`
// shape. (launch.mjs was also found by that same sweep and briefly migrated
// here too, but is now its own ALLOWLIST_EXTRA entry above — see its
// comment for why.)
const MIGRATED_SITES_EXTRA = [
  'server/tts-sidecar/scripts/accelerator-profile.mjs',
  'server/tts-sidecar/scripts/bootstrap-venv.mjs',
  'server/tts-sidecar/scripts/ensure-python312.mjs',
  'server/tts-sidecar/scripts/install-coqui.mjs',
  'server/tts-sidecar/scripts/install-kokoro.mjs',
  'server/tts-sidecar/scripts/install-ort.mjs',
  'server/tts-sidecar/scripts/install-qwen3.mjs',
  'server/tts-sidecar/scripts/install-torch.mjs',
  'server/tts-sidecar/scripts/install-whisper.mjs',
];

test('no scripts/*.mjs|*.mts file hand-rolls a direct-invocation check outside the allowlist', () => {
  const files = walk(SCRIPTS_DIR).filter((f) => relScripts(f) !== 'lib/is-main-module.mjs');
  const violations = [];
  const usingHelper = [];

  for (const file of files) {
    const rel = relScripts(file);
    const source = readFileSync(file, 'utf8');
    // Positive invariant: a file referencing BOTH ingredients is doing SOME
    // form of direct-invocation check, however it's spelled.
    if (!(HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source))) continue;

    if (ALLOWLIST.has(rel)) continue; // documented, narrow exception

    const migrated = USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source);
    if (migrated) {
      usingHelper.push(rel);
    } else {
      violations.push(rel);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `hand-rolled direct-invocation check(s) found outside scripts/lib/is-main-module.mjs and the ` +
      `allowlist — migrate to isDirectlyInvoked(): ${violations.join(', ')}`,
  );
  // `usingHelper` collects a file that hits BOTH raw ingredients (so it
  // passed the `continue` above) AND already imports+uses the shared
  // helper — i.e. a HALF migration: the raw process.argv[1] token should
  // have been removed entirely once isDirectlyInvoked() took over deciding
  // that, exactly as the "still contains a raw process.argv[1] reference"
  // check does for the explicit MIGRATED_SITES list in the next test below.
  // This is that same check generalized to every file the scan can see, not
  // just the ones already named in MIGRATED_SITES — so a NEW file that
  // half-migrates itself (imports the helper but leaves a stray argv[1]
  // reference behind) is caught here even before anyone adds it to that
  // list. A clean migration removes the raw token entirely, so this is
  // expected to be empty; it was previously computed and never asserted on
  // (dead code masking exactly this gap).
  assert.deepEqual(
    usingHelper,
    [],
    `file(s) import and use the shared helper but still contain a raw process.argv[1] ` +
      `reference elsewhere — clean it up, the helper alone should decide direct invocation: ${usingHelper.join(', ')}`,
  );
});

test('every one of this branch\'s 54 migrated sites actually imports and uses the helper', () => {
  const missing = [];
  for (const rel of MIGRATED_SITES) {
    const source = readFileSync(join(SCRIPTS_DIR, rel), 'utf8');
    if (!(USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source))) {
      missing.push(rel);
    }
    // And the raw ingredients must not ALSO still form an unrouted
    // comparison — a file that imports the helper but ALSO still has a
    // leftover hand-rolled comparison elsewhere would be a half-migration.
    // (isDirectlyInvoked's own implementation lives in is-main-module.mjs,
    // not here, so a migrated site legitimately keeps at most one
    // `import.meta.url` reference for isDirectlyInvoked's argument — the
    // check below is just "does it still contain a raw argv[1] token",
    // which a clean migration removes entirely.)
    if (HAS_ARGV1_TOKEN.test(source)) {
      missing.push(`${rel} (still contains a raw process.argv[1] reference)`);
    }
  }
  assert.deepEqual(missing, [], `not fully migrated: ${missing.join(', ')}`);
});

// Expected size of ALLOWLIST once the #2291 migration is complete. A literal
// count rather than an unconstrained loop: with ALLOWLIST empty, the "every
// allowlist entry still exists..." check below iterates zero times and would
// otherwise pass having asserted nothing at all -- an empty allowlist proving
// the migration is complete only if that emptiness is itself checked for,
// not just assumed by omission. Bumping ALLOWLIST without also bumping this
// constant (and documenting why in the new entry's value) fails the test
// below, so a new exception can't land silently.
const EXPECTED_ALLOWLIST_SIZE = 0;

// Not-vacuous check: the allowlist itself must still describe files that
// actually exist and still match the shape it excuses. An allowlist entry
// for a file that was since fixed for real (or deleted) would silently
// stop proving anything about that file.
test('every allowlist entry still exists and still references both direct-invocation ingredients', () => {
  assert.equal(
    ALLOWLIST.size,
    EXPECTED_ALLOWLIST_SIZE,
    `ALLOWLIST has ${ALLOWLIST.size} entrie(s) but EXPECTED_ALLOWLIST_SIZE is ` +
      `${EXPECTED_ALLOWLIST_SIZE} -- if you intentionally added or removed an ` +
      `entry, update EXPECTED_ALLOWLIST_SIZE to match (a new entry also needs ` +
      `its own documented reason, same as the existing ones did).`,
  );
  for (const rel of ALLOWLIST.keys()) {
    const full = join(SCRIPTS_DIR, rel);
    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      assert.fail(`allowlist entry ${rel} no longer exists — remove it from ALLOWLIST`);
    }
    assert.ok(
      HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source),
      `allowlist entry ${rel} no longer references both import.meta.url and process.argv[1] — it may already be fixed or its shape changed; remove it from ALLOWLIST so the scan covers it`,
    );
  }
});

// --- Extended-scope tests (repo-root top-level files + server/tts-sidecar/
// scripts/**) — same positive-invariant logic as the scripts/ tests above,
// applied to the two additional roots the repo-wide sweep found.

test(
  'no root *.mjs|*.mts file or server/tts-sidecar/scripts/** file hand-rolls a ' +
    'direct-invocation check outside the allowlist',
  () => {
    const files = [...walkFlat(REPO_ROOT), ...walkTree(SIDECAR_SCRIPTS_DIR)];
    const violations = [];
    const usingHelper = [];

    for (const file of files) {
      const rel = relRepo(file);
      const source = readFileSync(file, 'utf8');
      // Positive invariant: a file referencing BOTH ingredients is doing SOME
      // form of direct-invocation check, however it's spelled.
      if (!(HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source))) continue;

      if (ALLOWLIST_EXTRA.has(rel)) continue; // documented, narrow exception

      const migrated = USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source);
      if (migrated) {
        usingHelper.push(rel);
      } else {
        violations.push(rel);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `hand-rolled direct-invocation check(s) found outside scripts/lib/is-main-module.mjs and the ` +
        `ALLOWLIST_EXTRA allowlist — migrate to isDirectlyInvoked(): ${violations.join(', ')}`,
    );
    // Same half-migration check as the scripts/ scan above — see its
    // comment for why `usingHelper` should be empty for a clean migration,
    // and why that's worth asserting rather than leaving computed-but-unused.
    assert.deepEqual(
      usingHelper,
      [],
      `file(s) import and use the shared helper but still contain a raw process.argv[1] ` +
        `reference elsewhere — clean it up, the helper alone should decide direct invocation: ${usingHelper.join(', ')}`,
    );
  },
);

test('every one of the 9 sidecar sites migrated outside scripts/ actually imports and uses the helper', () => {
  const missing = [];
  for (const rel of MIGRATED_SITES_EXTRA) {
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (!(USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source))) {
      missing.push(rel);
    }
    // Same half-migration check as the scripts/ list above — see that
    // test's comment for why a raw argv[1] token surviving is a violation
    // even when the helper is also imported.
    if (HAS_ARGV1_TOKEN.test(source)) {
      missing.push(`${rel} (still contains a raw process.argv[1] reference)`);
    }
  }
  assert.deepEqual(missing, [], `not fully migrated: ${missing.join(', ')}`);
});

// Expected size of ALLOWLIST_EXTRA — same "empty allowlist proven non-empty
// (or empty) on purpose, not just assumed" discipline as
// EXPECTED_ALLOWLIST_SIZE above. 1: launch.mjs — see its entry's own
// comment for why it deliberately keeps a hand-rolled (but still
// both-sides-realpath-correct) inline guard instead of importing the shared
// helper.
const EXPECTED_ALLOWLIST_EXTRA_SIZE = 1;

test('every ALLOWLIST_EXTRA entry still exists and still references both direct-invocation ingredients', () => {
  assert.equal(
    ALLOWLIST_EXTRA.size,
    EXPECTED_ALLOWLIST_EXTRA_SIZE,
    `ALLOWLIST_EXTRA has ${ALLOWLIST_EXTRA.size} entrie(s) but EXPECTED_ALLOWLIST_EXTRA_SIZE is ` +
      `${EXPECTED_ALLOWLIST_EXTRA_SIZE} -- if you intentionally added or removed an ` +
      `entry, update EXPECTED_ALLOWLIST_EXTRA_SIZE to match (a new entry also needs ` +
      `its own documented reason, same as the existing ones did).`,
  );
  for (const rel of ALLOWLIST_EXTRA.keys()) {
    const full = join(REPO_ROOT, rel);
    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      assert.fail(`allowlist entry ${rel} no longer exists — remove it from ALLOWLIST_EXTRA`);
    }
    assert.ok(
      HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source),
      `allowlist entry ${rel} no longer references both import.meta.url and process.argv[1] — it may already be fixed or its shape changed; remove it from ALLOWLIST_EXTRA so the scan covers it`,
    );
  }
});

// --- server/src/** (repo-wide sweep, see header): the TypeScript backend
// source tree. Recursive, .ts/.mts only (no .mjs lives there today), skipping
// any tests/ subdir — none exists there today (server/src's own tests are
// colocated *.test.ts files, not a tests/ folder) — but the check is
// defensive rather than assuming that stays true, matching walkTree's own
// defensive skip above. This root was added after a repo-wide sweep found
// and hand-migrated its three #2291 sites (index.ts,
// analyzer/attribution-eval/capture-cli.ts,
// analyzer/attribution-eval/run-eval-cli.ts) — see the header's former "WHAT
// THIS CANNOT CATCH" note for the incident this closes. server/dist/** and
// node_modules never enter this walk at all: they are siblings of
// server/src, not descendants of it, so there is nothing to exclude.

/** Recursive *.ts/*.mts walk of `dir`, skipping any 'tests' subdirectory. */
function walkServerSrcTree(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'tests') continue; // avoid comment false-positives
      out.push(...walkServerSrcTree(full));
    } else if (/\.(ts|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Explicit, narrow, documented exceptions for server/src/** — same
// "keyed on exact relative path" discipline as ALLOWLIST/ALLOWLIST_EXTRA
// above. Empty: the one file that tripped the positive invariant here
// (server/src/index.ts) did so purely through a doc comment quoting
// `process.argv[1]` as prose while explaining why the file no longer
// hand-rolls that compare — not an actual guard. Rewording that one
// sentence removed the false trigger at its source instead of allowlisting
// it, so this list proves what it says it proves: zero known exceptions,
// not "zero exceptions we bothered to explain away."
const ALLOWLIST_SERVER_SRC = new Map([]);

// The 3 sites a repo-wide sweep found under server/src/** — invisible to
// this scan until this root was added — all using an un-realpathed (or
// only-one-side-realpathed) `process.argv[1]` compare:
// `process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`
// for the two attribution-eval CLIs, and
// `pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url`
// for index.ts, the production server's own entry point.
const MIGRATED_SITES_SERVER_SRC = [
  'server/src/index.ts',
  'server/src/analyzer/attribution-eval/capture-cli.ts',
  'server/src/analyzer/attribution-eval/run-eval-cli.ts',
];

test(
  'no server/src/**/*.ts|*.mts file hand-rolls a direct-invocation check outside the allowlist',
  () => {
    const files = walkServerSrcTree(SERVER_SRC_DIR);
    const violations = [];
    const usingHelper = [];

    for (const file of files) {
      const rel = relRepo(file);
      const source = readFileSync(file, 'utf8');
      // Positive invariant: a file referencing BOTH ingredients is doing SOME
      // form of direct-invocation check, however it's spelled.
      if (!(HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source))) continue;

      if (ALLOWLIST_SERVER_SRC.has(rel)) continue; // documented, narrow exception

      const migrated = USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source);
      if (migrated) {
        usingHelper.push(rel);
      } else {
        violations.push(rel);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `hand-rolled direct-invocation check(s) found outside scripts/lib/is-main-module.mjs and the ` +
        `ALLOWLIST_SERVER_SRC allowlist — migrate to isDirectlyInvoked(): ${violations.join(', ')}`,
    );
    // Same half-migration check as the other two scans above — see the
    // scripts/ scan's comment for why `usingHelper` should be empty for a
    // clean migration.
    assert.deepEqual(
      usingHelper,
      [],
      `file(s) import and use the shared helper but still contain a raw process.argv[1] ` +
        `reference elsewhere — clean it up, the helper alone should decide direct invocation: ${usingHelper.join(', ')}`,
    );
  },
);

// Fixture-based proof: the server/src/** root's detection logic — not just
// its wiring to the real repo path — actually flags a planted hand-rolled
// guard, and does NOT flag a properly-migrated sibling. A root added but
// never exercised against a positive case is theatre; this drives
// walkServerSrcTree and the shared regexes against a throwaway temp
// directory shaped like server/src, independent of anything in the repo.
test('server/src scan detects a planted hand-rolled guard in a server/src-shaped fixture tree', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'entry-point-guard-server-src-'));
  try {
    const fixtureDir = join(tmpRoot, 'server', 'src', 'analyzer', 'attribution-eval');
    mkdirSync(fixtureDir, { recursive: true });

    const plantedGuard = join(fixtureDir, 'fake-cli.ts');
    writeFileSync(
      plantedGuard,
      [
        "import { resolve } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        '',
        "if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {",
        "  console.log('direct');",
        '}',
        '',
      ].join('\n'),
    );

    // A properly-migrated sibling in the same fixture tree must NOT be
    // flagged — proves the assertion below isn't just "any file in this
    // directory gets flagged."
    writeFileSync(
      join(fixtureDir, 'fake-migrated-cli.ts'),
      [
        "import { isDirectlyInvoked } from '../../../../scripts/lib/is-main-module.mjs';",
        '',
        'if (isDirectlyInvoked(import.meta.url)) {',
        "  console.log('direct');",
        '}',
        '',
      ].join('\n'),
    );

    // A file inside a 'tests' subdirectory must be skipped, same as the
    // real scan's defensive exclusion.
    const fixtureTestsDir = join(fixtureDir, 'tests');
    mkdirSync(fixtureTestsDir, { recursive: true });
    writeFileSync(
      join(fixtureTestsDir, 'fake-cli.test.ts'),
      "if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {}\n",
    );

    const files = walkServerSrcTree(join(tmpRoot, 'server', 'src'));
    const violations = [];
    const usingHelper = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!(HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source))) continue;
      const migrated = USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source);
      if (migrated) {
        usingHelper.push(file);
      } else {
        violations.push(file);
      }
    }

    assert.deepEqual(
      violations,
      [plantedGuard],
      'expected the planted hand-rolled guard to be the only flagged violation',
    );
    assert.deepEqual(usingHelper, [], 'the migrated sibling should not be flagged at all');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('every one of the 3 server/src sites migrated outside scripts/ actually imports and uses the helper', () => {
  const missing = [];
  for (const rel of MIGRATED_SITES_SERVER_SRC) {
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (!(USES_HELPER.test(source) && IMPORTS_HELPER_FILE.test(source))) {
      missing.push(rel);
    }
    // Same half-migration check as the other two migrated-sites lists above
    // — a clean migration removes the raw argv[1] token entirely.
    if (HAS_ARGV1_TOKEN.test(source)) {
      missing.push(`${rel} (still contains a raw process.argv[1] reference)`);
    }
  }
  assert.deepEqual(missing, [], `not fully migrated: ${missing.join(', ')}`);
});

// Expected size of ALLOWLIST_SERVER_SRC — same "empty allowlist proven
// non-empty (or empty) on purpose, not just assumed" discipline as
// EXPECTED_ALLOWLIST_SIZE / EXPECTED_ALLOWLIST_EXTRA_SIZE above.
const EXPECTED_ALLOWLIST_SERVER_SRC_SIZE = 0;

test('every ALLOWLIST_SERVER_SRC entry still exists and still references both direct-invocation ingredients', () => {
  assert.equal(
    ALLOWLIST_SERVER_SRC.size,
    EXPECTED_ALLOWLIST_SERVER_SRC_SIZE,
    `ALLOWLIST_SERVER_SRC has ${ALLOWLIST_SERVER_SRC.size} entrie(s) but ` +
      `EXPECTED_ALLOWLIST_SERVER_SRC_SIZE is ${EXPECTED_ALLOWLIST_SERVER_SRC_SIZE} -- if you ` +
      `intentionally added or removed an entry, update EXPECTED_ALLOWLIST_SERVER_SRC_SIZE to ` +
      `match (a new entry also needs its own documented reason, same as the existing ones did).`,
  );
  for (const rel of ALLOWLIST_SERVER_SRC.keys()) {
    const full = join(REPO_ROOT, rel);
    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      assert.fail(`allowlist entry ${rel} no longer exists — remove it from ALLOWLIST_SERVER_SRC`);
    }
    assert.ok(
      HAS_URL_TOKEN.test(source) && HAS_ARGV1_TOKEN.test(source),
      `allowlist entry ${rel} no longer references both import.meta.url and process.argv[1] — it may already be fixed or its shape changed; remove it from ALLOWLIST_SERVER_SRC so the scan covers it`,
    );
  }
});

// --- The trap: a migrated file is worthless (worse — a hard CRASH instead
// of a silent no-op) if it imports scripts/lib/is-main-module.mjs but that
// file isn't actually in the release zip. The 9 sidecar installers and 3
// server/src sites above all ship (see scripts/build-release-zip.mjs's
// MANIFEST — 'server/src/**' covers the latter); this pins that the shared
// helper ships alongside all of them so a future manifest edit can't
// silently break any of these entry points in production. launch.mjs is
// deliberately EXCLUDED from this test's loop — it no longer imports the
// helper at all (see its ALLOWLIST_EXTRA entry above) — but it still must
// ship itself; that is covered separately by release-manifest.test.mjs's
// `MANIFEST: includes launch.mjs` case, not duplicated here.
test('the shared helper (scripts/lib/is-main-module.mjs) ships in the release zip', () => {
  assert.equal(
    matchesManifest('scripts/lib/is-main-module.mjs'),
    true,
    'scripts/lib/is-main-module.mjs must be in build-release-zip.mjs\'s MANIFEST.include — ' +
      'every server/tts-sidecar/scripts/*.mjs installer imports it at the top level, so a ' +
      'missing manifest entry crashes those CLIs at import time in a real install.',
  );
  for (const rel of [...MIGRATED_SITES_EXTRA, ...MIGRATED_SITES_SERVER_SRC]) {
    assert.equal(
      matchesManifest(rel),
      true,
      `${rel} imports the shared guard helper and must itself ship in the release zip, or the ` +
        `import is dead weight nobody can reach`,
    );
  }
});
