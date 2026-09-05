// PR review finding 2 (entry-point-guard convention branch, follow-up to
// #2296/#2297): check-onbox-register.mjs's CLI body used to call
// process.exit() directly, ten times, and was the one script this branch's
// stdout-truncation sweep deliberately did NOT convert — justified in
// a648f31a as "their entire output is 96-136 bytes, far below any
// truncation risk". That measurement only covered the OK path. The FAILURE
// path emits one console.error PER reported error before exiting, and
// .github/workflows/onbox-register-check.yml runs this on ubuntu with
// stdout/stderr on a pipe (ASYNCHRONOUS there, unlike Windows — see
// scripts/build-release-zip.mjs's own die()/CliError comment for the fuller
// account) — a register with many mismatches can queue far more than a
// trivial number of writes before process.exit(1) lands, truncating the
// tail of a required check's log.
//
// The fix wraps the whole CLI body in runCheckOnboxRegisterCli() and
// replaces every process.exit(N) with `throw new CliExitError(N)`, caught
// by a try/catch at the bottom that sets process.exitCode instead of an
// instant kill — see check-onbox-register.mjs's own comment above that
// function for the full account.
//
// This proves two things via a REAL spawned subprocess (the pure
// checkRegister/checkLiveView functions were never at risk — the risk was
// specifically in the CLI's OWN control flow around them, which is what
// changed here):
//   1. exit codes are unchanged (0 on OK, 1 on failure) for the DEFAULT
//      (no-flag) register-vs-live-view path specifically — the existing
//      --against-published CLI tests in check-onbox-register.test.mjs
//      already cover that flag's exit codes, but the no-flag path reads its
//      two files from FIXED locations relative to the script's own file
//      (`new URL('../docs/testing/...', import.meta.url)`), not argv or
//      cwd, so it can't be driven with injectable content the way
//      --against-published can. This builds a standalone fixture tree — a
//      copy of the script plus its two local deps, at the same relative
//      layout, with fake docs/testing/ files — to exercise that exact path.
//   2. a many-mismatch failure surfaces its FULL error list in the captured
//      output. This is NOT a proof that async-pipe truncation is now
//      impossible (that's a POSIX pipe-TIMING property this Windows box
//      cannot reproduce; spawnSync always captures a child's output fully
//      here regardless of platform). It IS a correctness proof that the
//      control-flow extraction — wrapping the body in a function, threading
//      every exit through one throw/catch — didn't drop, reorder, or
//      short-circuit any report() call on the way to the now-deferred exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(HERE, '..');

const GROUP_COUNT = 12; // A..L
const LETTERS = Array.from({ length: GROUP_COUNT }, (_, i) => String.fromCharCode(65 + i));

/**
 * Builds a standalone fixture tree mirroring check-onbox-register.mjs's OWN
 * relative layout — <root>/scripts/check-onbox-register.mjs (+ its two local
 * deps) and <root>/docs/testing/{register.md,live-view.html} — so the CLI's
 * fixed, import.meta.url-relative file reads resolve to INJECTABLE content
 * instead of this repo's real (already-coherent) register.
 */
function buildFixture({ registerText, liveViewHtml }) {
  const root = mkdtempSync(join(tmpdir(), 'onbox-cli-noflags-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'docs', 'testing'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, 'check-onbox-register.mjs'), join(root, 'scripts', 'check-onbox-register.mjs'));
  cpSync(join(SCRIPTS_DIR, 'git-env.mjs'), join(root, 'scripts', 'git-env.mjs'));
  cpSync(join(SCRIPTS_DIR, 'lib', 'is-main-module.mjs'), join(root, 'scripts', 'lib', 'is-main-module.mjs'));
  writeFileSync(join(root, 'docs', 'testing', 'onbox-acceptance-register.md'), registerText, 'utf8');
  writeFileSync(
    join(root, 'docs', 'testing', 'onbox-acceptance-register-live-view.html'),
    liveViewHtml,
    'utf8',
  );
  return root;
}

function runFixtureCli(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-onbox-register.mjs')], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
}

// GROUP_COUNT groups, 2 rows each, glance table matching the body — coherent
// by construction (checkRegister reports nothing on its own).
function buildRegisterText() {
  const glanceRows = LETTERS.map((letter) => `| **${letter}** | Setup ${letter} | 2 |`).join('\n');
  const total = GROUP_COUNT * 2;
  const bodySections = LETTERS.map(
    (letter) =>
      `## Group ${letter} — setup ${letter.toLowerCase()}\n\n` +
      `<!-- next-id: ${letter}101 -->\n\n` +
      `### ${letter}1 · thing 1\n\nBody text.\n\n` +
      `### ${letter}2 · thing 2\n\nBody text.\n\n---\n`,
  ).join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${glanceRows}

**${total} owed.** Oldest: **2026-01-01**.

---

${bodySections}`;
}

// A live view that disagrees with EVERY group in TWO independent ways: it
// lists a row ID the register does not have at all (-> an extra-row error)
// and lists that same ID twice (-> a duplicate-row error). GROUP_COUNT groups
// x 2 errors each = 24 register-vs-live-view errors, plus the summary strip's
// owed total (deliberately left at the coherent value here so this fixture
// isolates the per-group errors from the scalar total-mismatch one).
function buildDisagreeingLiveView() {
  const owed = GROUP_COUNT * 2;
  const glanceRows = LETTERS.map(
    (letter) => `      <tr><td><a href="#g${letter.toLowerCase()}">${letter}</a></td><td>Setup ${letter}</td><td>2</td></tr>`,
  ).join('\n');
  const sections = LETTERS.map((letter) => {
    const lower = letter.toLowerCase();
    return `  <section class="group" id="g${lower}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">3 rows</span></h3>
    <summary><span class="num">${letter}1</span><span class="iname">t</span></summary>
    <summary><span class="num">${letter}3</span><span class="iname">t</span></summary>
    <summary><span class="num">${letter}3</span><span class="iname">t</span></summary>
  </section>`;
  }).join('\n\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
${glanceRows}
    </tbody>
  </table>

${sections}
`;
}

// A live view that genuinely agrees with buildRegisterText() (headerCount 2,
// both row IDs per group, owed total matching) — the OK-path baseline.
function buildCoherentLiveView() {
  const owed = GROUP_COUNT * 2;
  const glanceRows = LETTERS.map(
    (letter) => `      <tr><td><a href="#g${letter.toLowerCase()}">${letter}</a></td><td>Setup ${letter}</td><td>2</td></tr>`,
  ).join('\n');
  const sections = LETTERS.map((letter) => {
    const lower = letter.toLowerCase();
    return `  <section class="group" id="g${lower}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">2 rows</span></h3>
    <summary><span class="num">${letter}1</span><span class="iname">t</span></summary>
    <summary><span class="num">${letter}2</span><span class="iname">t</span></summary>
  </section>`;
  }).join('\n\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
${glanceRows}
    </tbody>
  </table>

${sections}
`;
}

test('CLI (no flags), real subprocess: exits 0 against a coherent register + live view', () => {
  const root = buildFixture({ registerText: buildRegisterText(), liveViewHtml: buildCoherentLiveView() });
  try {
    const r = runFixtureCli(root);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /check:onbox-register: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI (no flags), real subprocess: a many-mismatch register exits 1 and reports every error, none dropped', () => {
  const root = buildFixture({ registerText: buildRegisterText(), liveViewHtml: buildDisagreeingLiveView() });
  try {
    const r = runFixtureCli(root);
    assert.equal(r.status, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const combined = r.stdout + r.stderr;

    // One extra-row line and one duplicate-row line PER group — 24 distinct
    // error lines total. Assert every single one is present, not just a
    // sample: a truncation (or a control-flow bug that short-circuits after
    // some groups) would drop a suffix, which checking only the first few
    // groups would miss.
    for (const letter of LETTERS) {
      assert.match(
        combined,
        new RegExp(`Live view's Group ${letter} section has row ${letter}3 that the register's Group ${letter} does not`),
        `missing extra-row line for Group ${letter} — full output:\n${combined}`,
      );
      assert.match(
        combined,
        new RegExp(`Live view: Group ${letter} lists ${letter}3 more than once`),
        `missing duplicate-row line for Group ${letter} — full output:\n${combined}`,
      );
    }

    // Exactly GROUP_COUNT occurrences apiece of the extra-row and
    // duplicate-row error shapes — a coarse count check that catches an
    // accidental duplicate or a silently-skipped group even if the
    // per-letter regexes above somehow both matched something unintended.
    const extraRowCount = (combined.match(/section has row [A-L]3 that the register\u0027s Group [A-L] does not/g) ?? []).length;
    const duplicateRowCount = (combined.match(/lists [A-L]3 more than once/g) ?? []).length;
    assert.equal(extraRowCount, GROUP_COUNT, `expected ${GROUP_COUNT} extra-row lines, got ${extraRowCount}`);
    assert.equal(duplicateRowCount, GROUP_COUNT, `expected ${GROUP_COUNT} duplicate-row lines, got ${duplicateRowCount}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
