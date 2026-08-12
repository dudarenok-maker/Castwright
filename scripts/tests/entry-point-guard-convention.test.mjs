// Guards the #2291 fix from regressing: no scripts/*.mjs|*.mts file may
// hand-roll a NEW direct-execution guard instead of going through
// scripts/lib/is-main-module.mjs's isDirectlyInvoked().
//
// SCOPE (widened by a repo-wide sweep that found the same class OUTSIDE
// scripts/, where the original version of this scan never looked — a
// shipped launcher and 9 sidecar installer scripts were all still hand-
// rolling the un-realpathed comparison). This file now scans THREE roots:
//   1. scripts/**  (excluding scripts/tests/) — the original #2291 scope.
//   2. The repo root's top-level *.mjs/*.mts files only, NOT recursive —
//      today that's just launch.mjs (the release-zip's stable entry point)
//      and eslint.config.mjs (clean; doesn't reference either token).
//   3. server/tts-sidecar/scripts/**  (excluding any tests/ subdir, though
//      none exists there today) — the sidecar's installer/bootstrap CLIs,
//      all reachable from the running app (VenvBootstrap route, Account →
//      Models UI) or as documented manual troubleshooting commands.
// A file in ANY of the three roots is checked against the same positive
// invariant below; violations from all three are reported together.
//
// Detection envelope (read before trusting a green run here):
//
// WHAT THIS CATCHES: a POSITIVE invariant, not a blacklist of specific
// broken spellings. Any production file under the three roots above
// (excluding their own tests/ dirs and the helper itself) whose source
// references BOTH the literal token `import.meta.url` AND the literal
// token `process.argv[1]` is treated as "this file is doing SOME kind of
// direct-invocation check" — those are the only two ingredients any such
// check (hand-rolled or not) needs. If it also doesn't import+use
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
// realpath step, so it still misses across a junction). Enumerating known
// shapes as additional regexes would still miss a future one — a NEW file
// that computes the comparison via a helper function, a switch, a
// Set.has(), or anything else that isn't textually an operator next to
// the token. The "references both tokens, doesn't route through the
// shared helper" invariant catches all of those by construction, because
// there is no way to compare "was this file the entry point" other than
// consulting both import.meta.url and argv[1] somehow. It does NOT,
// however, catch a violation living somewhere this scan never walks —
// see the next paragraph.
//
// WHAT THIS CANNOT CATCH:
//  - A file outside all three scanned roots. A fourth CLI-shaped directory
//    (e.g. a future apps/android tool, or a new top-level scripts-like
//    folder) would be invisible until added here. Widen the ROOTS list
//    below if one appears.
//  - A guard built on a completely different mechanism that never
//    references import.meta.url at all when deciding whether it's the
//    entry point — e.g. a pure basename/suffix match on argv[1] alone with
//    no import.meta.url token anywhere in the file. No file in this repo
//    does this today (every basename-matching file still uses
//    import.meta.url elsewhere, e.g. to derive __dirname, which is what
//    makes the positive invariant able to see it at all) — but a
//    hypothetical future file that imports neither would be invisible to
//    this scan. Locating "is this the entry point" logic with no
//    import.meta.url reference anywhere in the file is unusual enough
//    (and easy enough to catch in review) that this residual gap is
//    accepted rather than built for.
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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesManifest } from '../build-release-zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(here, '..');
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
const SIDECAR_SCRIPTS_DIR = resolve(REPO_ROOT, 'server', 'tts-sidecar', 'scripts');

// The two ingredients ANY direct-invocation check needs, regardless of how
// it's spelled — see the header above for why this is a positive
// invariant rather than a list of known-bad equality spellings.
const HAS_URL_TOKEN = /import\.meta\.url/;
const HAS_ARGV1_TOKEN = /process\.argv\[1\]/;

// Detects `import { isDirectlyInvoked } from '...is-main-module.mjs'` (or
// any relative depth) without caring about import-statement formatting.
const USES_HELPER = /isDirectlyInvoked/;
const IMPORTS_HELPER_FILE = /from\s+['"][^'"]*is-main-module\.mjs['"]/;

// Explicit, narrow, documented exceptions — same shape as the cast-lock
// guard's allowlist (server/src/workspace/cast-lock.guard.test.ts): each
// entry is keyed on an exact relative path, not a directory or a pattern,
// so a NEW unmigrated file is never silently swept in by name proximity.
const ALLOWLIST = new Map([]);

// The 44 sites this branch has migrated to date (22 from the original
// #2291 sweep + 14 from the resolve()/fileURLToPath equality shape + 5
// from the `file://${argv[1]}` template-literal shape + 2 from the
// basename/suffix-match shape originally allowlisted as immune + 1,
// run-sidecar-tests.mjs, migrated off its own hand-rolled double-realpath
// fix once PR #2293 merged and this branch picked it up) — used below
// to assert the migration is actually complete, not just that nothing NEW
// regresses. Keeping this list literal (rather than deriving it from the
// scan) means a file silently falling OUT of the scan's view (e.g. an edit
// that removes the raw-comparison text without adding the helper import)
// still gets caught.
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
const ALLOWLIST_EXTRA = new Map([]);

// The 10 sites the repo-wide sweep found outside scripts/'s original scan:
// launch.mjs at the repo root (the release zip's stable entry point, shipped
// in every install) plus 9 server/tts-sidecar/scripts/ installer/bootstrap
// CLIs, all using the un-realpathed
// `import.meta.url === pathToFileURL(process.argv[1]).href` shape.
const MIGRATED_SITES_EXTRA = [
  'launch.mjs',
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
});

test('every one of this branch\'s 44 migrated sites actually imports and uses the helper', () => {
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
  },
);

test('every one of the 10 sites migrated outside scripts/ actually imports and uses the helper', () => {
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

// Expected size of ALLOWLIST_EXTRA — same "empty allowlist proven empty,
// not just assumed" discipline as EXPECTED_ALLOWLIST_SIZE above.
const EXPECTED_ALLOWLIST_EXTRA_SIZE = 0;

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

// --- The trap: a migrated file is worthless (worse — a hard CRASH instead
// of a silent no-op) if it imports scripts/lib/is-main-module.mjs but that
// file isn't actually in the release zip. launch.mjs and the 9 sidecar
// installers above all ship (see scripts/build-release-zip.mjs's MANIFEST);
// this pins that the shared helper ships alongside them so a future
// manifest edit can't silently break every one of these CLIs in production.
test('the shared helper (scripts/lib/is-main-module.mjs) ships in the release zip', () => {
  assert.equal(
    matchesManifest('scripts/lib/is-main-module.mjs'),
    true,
    'scripts/lib/is-main-module.mjs must be in build-release-zip.mjs\'s MANIFEST.include — ' +
      'launch.mjs and every server/tts-sidecar/scripts/*.mjs installer import it at the top ' +
      'level, so a missing manifest entry crashes those CLIs at import time in a real install.',
  );
  for (const rel of MIGRATED_SITES_EXTRA) {
    assert.equal(
      matchesManifest(rel),
      true,
      `${rel} imports the shared guard helper and must itself ship in the release zip, or the ` +
        `import is dead weight nobody can reach`,
    );
  }
});
