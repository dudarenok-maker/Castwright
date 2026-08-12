// Guards the #2291 fix from regressing: no scripts/*.mjs|*.mts file may
// hand-roll a NEW direct-execution guard instead of going through
// scripts/lib/is-main-module.mjs's isDirectlyInvoked().
//
// Detection envelope (read before trusting a green run here):
//
// WHAT THIS CATCHES: a POSITIVE invariant, not a blacklist of specific
// broken spellings. Any production file under scripts/ (excluding
// scripts/tests/** and the helper itself) whose source references BOTH the
// literal token `import.meta.url` AND the literal token `process.argv[1]`
// is treated as "this file is doing SOME kind of direct-invocation check" —
// those are the only two ingredients any such check (hand-rolled or not)
// needs. If it also doesn't import+use isDirectlyInvoked from
// is-main-module.mjs, it's a violation. This is deliberately broader than
// "detect an equality operator between the two": the first sweep of this
// fix (#2291) caught 22 sites with a literal `import.meta.url === X`
// comparison via exactly that narrower regex, then MISSED 14 more sites
// using `resolve(argv[1]) === fileURLToPath(import.meta.url)` (an
// intermediate-variable shape, still an equality, but spelled differently
// enough that the operator-adjacency regex didn't match it) and 5 more
// using `import.meta.url === \`file://${argv[1]}\`` (a template-literal
// spelling of the same equality). Enumerating those two now-known shapes
// as additional regexes would still miss a fourth, fifth, ... hand-rolled
// spelling — a NEW file that computes the comparison via a helper function,
// a switch, a Set.has(), or anything else that isn't textually an operator
// next to the token. The "references both tokens, doesn't route through
// the shared helper" invariant catches all of those by construction,
// because there is no way to compare "was this file the entry point" other
// than consulting both import.meta.url and argv[1] somehow.
//
// WHAT THIS CANNOT CATCH:
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
//    None of scripts/'s current files hit this today (verified by the
//    ALLOWLIST review test below, which asserts every allowlisted file
//    still contains a recognizable direct-invocation shape) but a new one
//    would need an allowlist entry with that reasoning documented, same as
//    any other exception.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(here, '..');

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
const ALLOWLIST = new Map([
  [
    'run-sidecar-tests.mjs',
    'Fixed independently on a separate, unmerged branch (issue #2291, PR ' +
      '#2293) with the identical double-realpath mechanism, hand-rolled ' +
      'rather than via this shared helper. This entry is temporary — will be ' +
      'removed once that PR merges and this branch picks it up.',
  ],
]);

// The 43 sites this branch has migrated to date (22 from the original
// #2291 sweep + 14 from the resolve()/fileURLToPath equality shape + 5
// from the `file://${argv[1]}` template-literal shape + 2 from the
// basename/suffix-match shape originally allowlisted as immune) — used below
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

test('every one of this branch\'s 41 migrated sites actually imports and uses the helper', () => {
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

// Not-vacuous check: the allowlist itself must still describe files that
// actually exist and still match the shape it excuses. An allowlist entry
// for a file that was since fixed for real (or deleted) would silently
// stop proving anything about that file.
test('every allowlist entry still exists and still references both direct-invocation ingredients', () => {
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
