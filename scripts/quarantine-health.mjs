#!/usr/bin/env node
/* ops-32 — quarantine-lane health report (#1864).

   `npm run test:quarantine` is a non-gating pass/fail lane: nothing reports
   its state, so a PERMANENTLY red quarantined test (a defect the register is
   lying about) is indistinguishable from a genuinely flaky one. #1854 sat red
   for three weeks because of exactly this — quarantine hid a broken test
   instead of deferring a rewrite.

   A single run can't tell "intermittent" from "never passes" apart, so this
   runs the lane RUNS times (default 5 — a "handful" per the issue: enough to
   catch a common flake rate and to be confident about "never passes" without
   turning the report into a long-running matrix job) and buckets each
   quarantined test by its outcome across those runs:

     - always-passes  — every run passed. Candidate to graduate back to gating.
     - intermittent    — some passed, some failed. Genuinely flaky; the
                          register row is honest.
     - never-passes    — every run failed. Not flaky — broken. The register
                          row is lying and quarantine is hiding a defect.
     - not-found       — the test could not be located in ANY run. The
                          register row is stale (renamed/moved test or file).

   Unlike `test:quarantine` (which chains all three vitest legs with `&&`, so
   the first red leg stops the rest), this needs every leg's result on every
   run regardless of the others — so each leg is invoked independently and
   its result recorded, never used to gate a later leg.

   It also does NOT run the full three suites unfiltered like `test:quarantine`
   does. It resolves, from the register itself, exactly which test FILES are
   quarantined, and passes only those files as explicit vitest CLI arguments —
   bounding the runtime by the (small) quarantined set rather than the whole
   gating suite, RUNS times over. A server-domain file's home config (main vs.
   `vitest.config.slow.ts`) isn't hardcoded here (that would be a third place
   to keep in sync with the "mirror invariant" `vitest.config.slow.ts` already
   documents) — both configs are tried per server file and whichever one
   actually contains it reports real results; the other reports zero matched
   tests for it, which is harmless.

   A vitest run whose explicit file list resolves to zero real test files
   (e.g. a stale register row pointing at a moved/renamed file, or the
   config that doesn't own a given server file) would otherwise be a hard CLI
   error ("no test files found"). `--passWithNoTests` turns that into a clean,
   zero-tests JSON payload instead — verified below, not assumed:
   `{ success: true, testResults: [] }`. flattenVitestJson handles that
   degenerate shape as "no outcomes", which aggregate() turns into a
   `not-found` bucket entry (not a crash).

   An EMPTY register (true as of #1858) is a clean no-op: parseRegister()
   returns zero rows, main() short-circuits before spawning a single vitest
   process, and the report says so. This is the main path this script's very
   first run exercises, not an edge case.

   Non-blocking by design: this ALWAYS exits 0 for test outcomes (any bucket,
   including "never-passes") — that's the whole point, the lane must never
   gate a merge. The one case that exits non-zero is the register file itself
   being unreadable (ENOENT/permission error) — a genuinely broken setup, not
   a test-outcome verdict. Even then nothing depends on this script's exit
   code: it isn't wired into verify.yml or any required check, and the
   workflow step also sets `continue-on-error: true` as a second layer.

   Run: `node scripts/quarantine-health.mjs`
   Override run count for local iteration: `QUARANTINE_HEALTH_RUNS=2 node scripts/quarantine-health.mjs`
   Writes to stdout always; also appends to $GITHUB_STEP_SUMMARY when set (CI). */

import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_PATH = resolve(ROOT, 'docs/testing/flaky-register.md');
const RUNS = Number(process.env.QUARANTINE_HEALTH_RUNS) || 5;

// ---------------------------------------------------------------------------
// Pure functions (unit-tested in scripts/tests/quarantine-health.test.mjs)
// ---------------------------------------------------------------------------

// Parses the register's markdown table into one entry per quarantined TEST
// (a row can name more than one backtick-quoted test sharing a file, as the
// wake-lock row did — each becomes its own entry). Never throws on malformed
// input: a table with no data rows (including the current, empty register)
// simply yields []; that IS the empty-register no-op path, not a distinct
// error case.
export function parseRegister(markdown) {
  const entries = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue; // prose, HTML comments, blank lines
    if (/^\|\s*-+\s*\|/.test(line)) continue; // the `|---|---|` separator row
    if (/^\|\s*Test\s*\|/i.test(line)) continue; // the header row

    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 5) continue; // not a well-formed 6-column data row

    const [testCell, fileCell, , , issueCell] = cells;
    const file = fileCell.replace(/`/g, '').trim();
    if (!file) continue;

    const testNames = [...testCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (testNames.length === 0) continue;

    const issueNumbers = [...(issueCell ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

    for (const testName of testNames) {
      entries.push({ testName, file, issueNumbers });
    }
  }
  return entries;
}

// 'server/src/routes/generation.test.ts' → 'server'; anything else → 'frontend'.
export function fileDomain(file) {
  return file.startsWith('server/') ? 'server' : 'frontend';
}

// 'server/src/routes/generation.test.ts' → 'src/routes/generation.test.ts'
// (the path vitest expects when invoked with cwd=server/).
export function serverRelativePath(file) {
  return file.startsWith('server/') ? file.slice('server/'.length) : file;
}

// Strips the repo-root prefix off an absolute path vitest's JSON reporter
// reports (which, on this codebase's Windows dev box, already comes back
// forward-slashed) and normalises to forward slashes, so the result matches
// the register's File column format regardless of host OS separators.
// String-prefix based rather than node:path based on purpose: the exact
// separator vitest emits varies by platform/version and this only needs to
// be robust to that, not to arbitrary relative-path algebra.
export function toRepoRelative(absPath, root = ROOT) {
  const normAbs = String(absPath).replace(/\\/g, '/');
  const normRoot = String(root).replace(/\\/g, '/');
  if (!normAbs.startsWith(normRoot)) return normAbs;
  return normAbs.slice(normRoot.length).replace(/^\/+/, '');
}

// Flattens one vitest `--reporter=json` payload into a flat list of
// { file, title, fullName, status }. Tolerates the degenerate
// `--passWithNoTests` zero-match shape (`testResults: []`, or a missing/
// malformed payload) by returning [] rather than throwing.
export function flattenVitestJson(json, root = ROOT) {
  if (!json || !Array.isArray(json.testResults)) return [];
  const out = [];
  for (const fileResult of json.testResults) {
    const file = toRepoRelative(fileResult?.name ?? '', root);
    for (const a of fileResult.assertionResults ?? []) {
      out.push({ file, title: a.title, fullName: a.fullName, status: a.status });
    }
  }
  return out;
}

// Finds a register entry's outcome within one run's flattened outcome list.
// Matches by file + leaf title first (the register's Test column is written
// as the leaf test title, e.g. "engages on the one in-flight chapter and
// releases once it completes" — see the pre-graduation #1854 row), then
// falls back to an exact/substring match against vitest's ancestor-prefixed
// `fullName` for resilience if a future row is written that way instead.
export function findOutcome(outcomes, file, testName) {
  const inFile = outcomes.filter((o) => o.file === file);
  return (
    inFile.find((o) => o.title === testName) ??
    inFile.find((o) => o.fullName === testName) ??
    inFile.find((o) => o.fullName?.includes(testName)) ??
    null
  );
}

// Classifies one entry's per-run statuses (each 'passed' | 'failed'-ish |
// null-if-not-found) into a bucket. Anything other than vitest's literal
// 'passed' status (failed, skipped, todo) counts as a non-pass — a
// quarantined test that only ever reports 'skipped' is not evidence it's
// healthy.
export function classifyEntry(perRunStatuses) {
  const found = perRunStatuses.filter((s) => s !== null);
  const notFound = perRunStatuses.length - found.length;
  if (found.length === 0) {
    return { bucket: 'not-found', passed: 0, failed: 0, notFound };
  }
  const passed = found.filter((s) => s === 'passed').length;
  const failed = found.length - passed;
  const bucket = failed === 0 ? 'always-passes' : passed === 0 ? 'never-passes' : 'intermittent';
  return { bucket, passed, failed, notFound };
}

// Combines register entries with per-run outcome lists into the final,
// classified rows the report is built from.
export function aggregate(entries, perRunOutcomes) {
  return entries.map((entry) => {
    const perRunStatuses = perRunOutcomes.map((outcomes) => {
      const hit = findOutcome(outcomes, entry.file, entry.testName);
      return hit ? hit.status : null;
    });
    return {
      ...entry,
      ...classifyEntry(perRunStatuses),
      runs: perRunStatuses.length,
    };
  });
}

// Renders the final markdown report. `issueStates` maps issue number → 'OPEN'
// | 'CLOSED' | null (unknown — e.g. `gh` unavailable or the call failed).
export function formatReport({ entries, runs, issueStates }) {
  const lines = ['# Quarantine lane health report', ''];

  if (entries.length === 0) {
    lines.push(
      'No quarantined tests are currently registered in `docs/testing/flaky-register.md` — nothing to run. Clean no-op.',
    );
    return lines.join('\n');
  }

  lines.push(`Ran the quarantine lane ${runs} time(s). Bucket legend:`);
  lines.push('');
  lines.push('- **always-passes** — every run passed; candidate to graduate back into the gating suite.');
  lines.push('- **intermittent** — some runs passed, some failed; genuinely flaky, the register row is honest.');
  lines.push('- **never-passes** — every run failed; not flaky, just broken — the register row is likely lying.');
  lines.push('- **not-found** — could not be located in any run; the register row is stale (renamed/moved test or file).');
  lines.push('');
  lines.push('| Test | File | Bucket | Passed / found | Tracking issue | Issue state |');
  lines.push('|------|------|--------|-----------------|-----------------|-------------|');
  for (const e of entries) {
    const issueCol = e.issueNumbers.length ? e.issueNumbers.map((n) => `#${n}`).join(', ') : '—';
    const stateCol = e.issueNumbers.length
      ? e.issueNumbers.map((n) => issueStates.get(n) ?? 'unknown').join(', ')
      : '—';
    const found = e.runs - e.notFound;
    const passedCol = `${e.passed}/${found}${e.notFound ? ` (${e.notFound} not found)` : ''}`;
    lines.push(
      `| \`${e.testName}\` | \`${e.file}\` | ${e.bucket} | ${passedCol} | ${issueCol} | ${stateCol} |`,
    );
  }

  const neverPasses = entries.filter((e) => e.bucket === 'never-passes');
  if (neverPasses.length) {
    lines.push('');
    lines.push(
      `**${neverPasses.length} test(s) never passed across ${runs} run(s)** — not flaky, just broken. Investigate before trusting the register row's diagnosis.`,
    );
  }

  const closedTracking = entries.filter((e) =>
    e.issueNumbers.some((n) => issueStates.get(n) === 'CLOSED'),
  );
  if (closedTracking.length) {
    lines.push('');
    lines.push(
      `**${closedTracking.length} row(s) cite a CLOSED tracking issue** — orphaned debt with no owner; see the table above.`,
    );
  }

  const notFound = entries.filter((e) => e.bucket === 'not-found');
  if (notFound.length) {
    lines.push('');
    lines.push(
      `**${notFound.length} row(s) could not be located** in any of the ${runs} run(s) — the register row's Test/File text likely no longer matches the code.`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O (thin — deliberately not unit-tested; the pure functions above own the
// logic this delegates to)
// ---------------------------------------------------------------------------

function runVitestJson(cwd, config, files) {
  if (files.length === 0) return { testResults: [] };
  const args = ['vitest', 'run', '--reporter=json', '--passWithNoTests'];
  if (config) args.push('--config', config);
  args.push(...files);
  // npx is a .cmd shim on Windows; Node refuses to spawn a .cmd directly
  // (EINVAL) unless routed through a shell (same idiom as
  // scripts/run-golden-audio.mjs). Passed as ONE pre-quoted command string
  // (not `spawnSync('npx', args, {shell:true})`) — that array form triggers
  // Node's DEP0190 ("args passed with shell:true are not escaped") on
  // current Node; none of these args ever contain spaces/shell metacharacters
  // (repo paths are kebab-case), but quoting each defensively costs nothing.
  // `npx` itself must stay UNQUOTED — quoting it broke Windows' npx.cmd shim's
  // own self-location logic (it started looking for
  // node_modules/npm/bin/npx-cli.js relative to the wrong place and crashed
  // with MODULE_NOT_FOUND), verified against this repo's node_modules.
  const command = `npx ${args.map((a) => `"${a}"`).join(' ')}`;
  const r = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    // RUN_QUARANTINE=1 is what turns quarantinedIt/quarantinedDescribe from
    // it.skip into a real it — without it every quarantined test reports
    // 'skipped' here and would misclassify as never-passes for EVERY test,
    // register-wide. Real env var, not a vitest `env:` config key (mirrors
    // `cross-env RUN_QUARANTINE=1` in the `test:quarantine` script).
    env: { ...process.env, RUN_QUARANTINE: '1' },
  });
  if (r.error) {
    console.error(`quarantine-health: failed to spawn vitest in ${cwd}: ${r.error.message}`);
    return { testResults: [] };
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    console.error(`quarantine-health: could not parse vitest JSON output in ${cwd}: ${err.message}`);
    if (r.stderr) console.error(r.stderr);
    return { testResults: [] };
  }
}

function checkIssueState(issueNumber) {
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'state', '-q', '.state'], {
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  const state = r.stdout.trim();
  return state || null;
}

function emit(report) {
  console.log(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, report + '\n');
}

function main() {
  let markdown;
  try {
    markdown = readFileSync(REGISTER_PATH, 'utf8');
  } catch (err) {
    console.error(`quarantine-health: could not read register at ${REGISTER_PATH}: ${err.message}`);
    process.exitCode = 1; // genuinely broken setup, not a test-outcome verdict
    return;
  }

  const rows = parseRegister(markdown);
  if (rows.length === 0) {
    emit(formatReport({ entries: [], runs: 0, issueStates: new Map() }));
    return; // clean no-op — exit 0
  }

  const frontendFiles = [...new Set(rows.filter((r) => fileDomain(r.file) === 'frontend').map((r) => r.file))];
  const serverFiles = [
    ...new Set(rows.filter((r) => fileDomain(r.file) === 'server').map((r) => serverRelativePath(r.file))),
  ];
  const serverRoot = resolve(ROOT, 'server');

  const perRunOutcomes = [];
  for (let i = 0; i < RUNS; i++) {
    console.log(`quarantine-health: run ${i + 1}/${RUNS}`);
    const outcomes = [];
    if (frontendFiles.length) {
      outcomes.push(...flattenVitestJson(runVitestJson(ROOT, undefined, frontendFiles)));
    }
    if (serverFiles.length) {
      outcomes.push(...flattenVitestJson(runVitestJson(serverRoot, 'vitest.config.ts', serverFiles)));
      outcomes.push(...flattenVitestJson(runVitestJson(serverRoot, 'vitest.config.slow.ts', serverFiles)));
    }
    perRunOutcomes.push(outcomes);
  }

  const entries = aggregate(rows, perRunOutcomes);

  const uniqueIssues = [...new Set(rows.flatMap((r) => r.issueNumbers))];
  const issueStates = new Map(uniqueIssues.map((n) => [n, checkIssueState(n)]));

  emit(formatReport({ entries, runs: RUNS, issueStates }));
  // Always exit 0 for test outcomes, including "never-passes" — this lane is
  // non-blocking by design (see the header comment).
}

// Only run when invoked directly (not when imported by tests) — mirrors the
// same guard used in scripts/stage-marketing-screenshots.mjs.
const invokedAsCli = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedAsCli) main();
