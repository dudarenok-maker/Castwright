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
     - not-found       — the test could not be located in any USABLE run
                          (a run whose vitest invocation actually completed).
                          The register row is stale (renamed/moved test or
                          file).
     - unknown         — every run that could have covered this test crashed
                          or timed out before producing usable output. This is
                          explicitly NOT a verdict — see "Runner failures"
                          below. Preferred over guessing "not-found" or
                          "never-passes", both of which would be a confident,
                          wrong report.
     - not-covered     — a Playwright (`e2e/**`) register row. See "Playwright
                          rows" below.

   This tool's entire purpose is telling *intermittent* apart from
   *never-passes*. A wrong bucket is worse than no report, because nothing
   else is watching this lane — so several of the design points below exist
   specifically to avoid a confident, false classification.

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
   `not-found` bucket entry (not a crash) *when the run that produced it
   genuinely completed* — see "Runner failures" below for the case where it
   didn't.

   Every invocation forces `--retry=0` (buildVitestArgs). Both
   vitest.config.ts and server/vitest.config.ts set `retry: 1` (plan 45); the
   JSON reporter reports only the FINAL post-retry state, so left alone, a
   test with a genuine 30%-per-attempt flake rate fails a given RUN only
   ~9% of the time (needs both the first attempt AND its retry to fail) —
   about a 62% chance all five runs come back "passed", misclassifying a
   real flake as always-passes ("candidate to graduate"). Forcing
   `--retry=0` here makes each run one real attempt, independent of whatever
   retry policy the gating suite carries (and independent of
   vitest.config.slow.ts, which sets no `retry` at all — the bias was also
   inconsistent between lanes before this).

   Playwright rows: the flaky register is explicitly ONE table covering both
   the vitest quarantine lane and the Playwright `@quarantine` tag / `npm run
   test:e2e:quarantine` (see
   docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md).
   Routing an `e2e/**` row through the frontend vitest include (`src/**` +
   `skills/**`) matches zero files, which used to bucket it `not-found` —
   asserting a live, correctly-registered Playwright spec is a stale row,
   which is exactly the false-confident-report failure mode this tool exists
   to avoid. This version does NOT wire up the Playwright JSON reporter (a
   different shape from vitest's, and multi-run Playwright orchestration is
   more than this report should carry yet) — it detects `e2e/**` rows via
   fileDomain() and reports them as `not-covered`: "this runner doesn't check
   this row, run `npm run test:e2e:quarantine` yourself." That is an honest
   "we don't know" rather than a wrong "stale."

   Runner failures (a crashed or hung vitest invocation, not a failing test):
   `spawnSync` now carries a bounded `timeout` (VITEST_RUN_TIMEOUT_MS) and
   `classifyRunResult` (pure, unit-tested) tags each invocation 'ok' /
   'timed-out' / 'crashed' instead of silently collapsing every failure mode
   into `{ testResults: [] }`. A timeout and a crash are DIFFERENT diagnoses —
   a hang is the more urgent one (it's precisely #1854's supertest-lazy-
   dispatch shape) — so they're tagged distinctly in the runner's own log,
   though both feed the same "this run produced no usable data" path into
   classification: a test whose only covering run(s) failed to execute gets
   bucketed `unknown`, not folded into `not-found` (which would blame the
   register row for a runner problem it didn't cause) or `never-passes`
   (which would call a runner crash a broken test). If some but not all runs
   for a test's domain failed to execute, those specific runs are excluded
   from that entry's pass/fail tally (an `unavailable` count, reported
   alongside `notFound`) rather than counted as evidence either way — a
   partial answer from fewer runs beats a wrong answer from a fabricated one.
   The main loop also wraps each run in a try/catch so a run that fails in
   a way `classifyRunResult` doesn't anticipate still lets the script emit
   whatever runs it already completed, rather than losing the whole report.

   `QUARANTINE_HEALTH_RUNS` is guarded (resolveRuns, pure/unit-tested): 0,
   negative, or non-numeric values fall back to the default 5 with a logged
   warning, rather than running zero runs and reporting every row `not-found`
   (which classifyEntry would otherwise happily do — 0 runs, 0 found, 0
   not-found, technically "not-found" bucket, and silently wrong).

   An EMPTY register (true as of #1858) is a clean no-op: parseRegister()
   returns zero rows, main() short-circuits before spawning a single vitest
   process, and the report says so. This is the main path this script's very
   first run exercises, not an edge case.

   Non-blocking by design: this ALWAYS exits 0 for test outcomes (any bucket,
   including "never-passes" and "unknown") — that's the whole point, the lane
   must never gate a merge. The one case that exits non-zero is the register
   file itself being unreadable (ENOENT/permission error) — a genuinely broken
   setup, not a test-outcome verdict. Even then nothing depends on this
   script's exit code: it isn't wired into verify.yml or any required check,
   and the workflow step also sets `continue-on-error: true` as a second
   layer.

   Run: `node scripts/quarantine-health.mjs`
   Override run count for local iteration: `QUARANTINE_HEALTH_RUNS=2 node scripts/quarantine-health.mjs`
   Writes to stdout always; also appends to $GITHUB_STEP_SUMMARY when set (CI). */

import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_PATH = resolve(ROOT, 'docs/testing/flaky-register.md');

// ---------------------------------------------------------------------------
// Pure functions (unit-tested in scripts/tests/quarantine-health.test.mjs)
// ---------------------------------------------------------------------------

// Resolves QUARANTINE_HEALTH_RUNS to a positive integer run count, falling
// back to the default 5 for anything else (unset, empty, zero, negative,
// non-numeric, fractional-rounds-to-zero). Guards against a misconfigured
// env var silently producing a zero-run report that buckets every row
// `not-found` (see the header comment).
export function resolveRuns(envValue) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

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
    if (isSeparatorRow(line)) continue; // the `|---|---|` separator row
    if (isHeaderRow(line)) continue; // the header row

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

// The `|---|---|` markdown table separator row. Given the current
// testCell-must-contain-backticks requirement above, a row this matches can
// never also survive the backtick check (its first cell is provably just
// dashes+whitespace, never backtick-quoted text) — so parseRegister's own
// integration behaviour can't distinguish "guard present" from "guard
// removed" for real register content. Pinned directly (quarantine-health.
// test.mjs) rather than via a contrived parseRegister fixture, so the guard's
// own contract stays asserted even though it's currently redundant defense.
export function isSeparatorRow(line) {
  return /^\|\s*-+\s*\|/.test(line);
}

// The register's header row (`| Test | File | ... |`). Same redundancy note
// as isSeparatorRow above: the header cell's literal, un-backtick-quoted
// "Test" text already fails the downstream backtick check on its own.
export function isHeaderRow(line) {
  return /^\|\s*Test\s*\|/i.test(line);
}

// 'server/src/routes/generation.test.ts' → 'server';
// 'e2e/foo.spec.ts' → 'e2e' (Playwright — see the header comment's
// "Playwright rows" section, not covered by this runner);
// anything else → 'frontend'.
export function fileDomain(file) {
  if (file.startsWith('server/')) return 'server';
  if (file.startsWith('e2e/')) return 'e2e';
  return 'frontend';
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

// Classifies one entry's per-run statuses. Each element is 'passed' |
// failed-ish (any other vitest status — failed/skipped/todo count as a
// non-pass) | null (not found in an otherwise-usable run) | 'run-unavailable'
// (the run's vitest invocation for this entry's domain crashed or timed out
// before producing usable output — see the header comment's "Runner
// failures" section).
//
// 'run-unavailable' runs are excluded from the found/not-found tally
// entirely (an `unavailable` count instead) rather than being counted as
// evidence either way. If EVERY run is unavailable, the entry buckets
// `unknown` — deliberately distinct from `not-found` (which would blame the
// register row) and `never-passes` (which would call a runner crash a
// broken test).
export function classifyEntry(perRunStatuses) {
  const usable = perRunStatuses.filter((s) => s !== 'run-unavailable');
  const unavailable = perRunStatuses.length - usable.length;
  if (usable.length === 0) {
    return { bucket: 'unknown', passed: 0, failed: 0, notFound: 0, unavailable };
  }
  const found = usable.filter((s) => s !== null);
  const notFound = usable.length - found.length;
  if (found.length === 0) {
    return { bucket: 'not-found', passed: 0, failed: 0, notFound, unavailable };
  }
  const passed = found.filter((s) => s === 'passed').length;
  const failed = found.length - passed;
  const bucket = failed === 0 ? 'always-passes' : passed === 0 ? 'never-passes' : 'intermittent';
  return { bucket, passed, failed, notFound, unavailable };
}

// Combines register entries with per-run outcome lists into the final,
// classified rows the report is built from. `perRunFailedDomains[i]` (a Set
// of 'frontend' | 'server') names which domains' vitest invocation failed to
// execute on run i — an entry in that domain gets 'run-unavailable' for that
// run instead of being matched against (necessarily incomplete) outcomes.
// An `e2e/**` entry (Playwright) is never matched at all — see fileDomain().
export function aggregate(entries, perRunOutcomes, perRunFailedDomains = []) {
  return entries.map((entry) => {
    const domain = fileDomain(entry.file);
    if (domain === 'e2e') {
      return {
        ...entry,
        bucket: 'not-covered',
        passed: 0,
        failed: 0,
        notFound: 0,
        unavailable: 0,
        runs: perRunOutcomes.length,
      };
    }
    const perRunStatuses = perRunOutcomes.map((outcomes, i) => {
      if (perRunFailedDomains[i]?.has(domain)) return 'run-unavailable';
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
  lines.push(
    '- **not-found** — could not be located in any usable run; the register row is stale (renamed/moved test or file).',
  );
  lines.push(
    '- **unknown** — every run that could have covered this test crashed or timed out; no usable data — not a verdict, investigate the runner failures.',
  );
  lines.push(
    '- **not-covered** — a Playwright (`e2e/**`) row; this runner only exercises vitest quarantine suites — check manually via `npm run test:e2e:quarantine`.',
  );
  lines.push('');
  lines.push('| Test | File | Bucket | Passed / found | Tracking issue | Issue state |');
  lines.push('|------|------|--------|-----------------|-----------------|-------------|');
  for (const e of entries) {
    const issueCol = e.issueNumbers.length ? e.issueNumbers.map((n) => `#${n}`).join(', ') : '—';
    const stateCol = e.issueNumbers.length
      ? e.issueNumbers.map((n) => issueStates.get(n) ?? 'unknown').join(', ')
      : '—';
    const unavailable = e.unavailable ?? 0;
    const notFound = e.notFound ?? 0;
    const found = e.runs - notFound - unavailable;
    const passedCol =
      e.bucket === 'not-covered'
        ? '—'
        : `${e.passed}/${found}${notFound ? ` (${notFound} not found)` : ''}${
            unavailable ? ` (${unavailable} run(s) crashed/timed out)` : ''
          }`;
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

  const unknownEntries = entries.filter((e) => e.bucket === 'unknown');
  if (unknownEntries.length) {
    lines.push('');
    lines.push(
      `**${unknownEntries.length} test(s) have no usable data** — every run that could have covered them crashed or timed out. This is NOT a verdict about the test; investigate the runner failures in the job log first.`,
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
      `**${notFound.length} row(s) could not be located** in any of the ${runs} usable run(s) — the register row's Test/File text likely no longer matches the code.`,
    );
  }

  const notCovered = entries.filter((e) => e.bucket === 'not-covered');
  if (notCovered.length) {
    lines.push('');
    lines.push(
      `**${notCovered.length} row(s) are Playwright specs** (\`e2e/**\`) not covered by this runner — check them manually via \`npm run test:e2e:quarantine\`.`,
    );
  }

  const partiallyUnavailable = entries.filter(
    (e) => (e.unavailable ?? 0) > 0 && e.bucket !== 'unknown',
  );
  if (partiallyUnavailable.length) {
    lines.push('');
    lines.push(
      `**${partiallyUnavailable.length} row(s) had at least one run excluded** — its vitest invocation crashed or timed out, so that run contributed no data and was not counted as a pass or a failure.`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O (thin — deliberately not unit-tested; the pure functions above own the
// logic this delegates to)
// ---------------------------------------------------------------------------

const RUNS = resolveRuns(process.env.QUARANTINE_HEALTH_RUNS);
if (process.env.QUARANTINE_HEALTH_RUNS !== undefined && String(RUNS) !== process.env.QUARANTINE_HEALTH_RUNS) {
  console.error(
    `quarantine-health: QUARANTINE_HEALTH_RUNS="${process.env.QUARANTINE_HEALTH_RUNS}" is not a positive integer — defaulting to ${RUNS} run(s).`,
  );
}

// Bounded per-invocation budget so a #1854-style deadlock (the process hangs
// rather than failing) can't block the whole script forever — generous for
// the small, explicit quarantined-file list this always runs with, but finite.
const VITEST_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const GH_TIMEOUT_MS = 30 * 1000;

// Builds vitest's CLI argv (pure — unit-tested). `--retry=0` overrides
// vitest.config.ts / server/vitest.config.ts's `retry: 1` (plan 45) so each
// of the RUNS is one real attempt, not a best-of-two — see the header
// comment's `--retry=0` paragraph.
export function buildVitestArgs(config, files) {
  const args = ['vitest', 'run', '--reporter=json', '--passWithNoTests', '--retry=0'];
  if (config) args.push('--config', config);
  args.push(...files);
  return args;
}

// Classifies one spawnSync result (pure — unit-tested against synthetic
// result-shaped objects, no real process spawn needed) into 'ok' /
// 'timed-out' / 'crashed', distinguishing a runner failure from a legitimate
// zero-match JSON payload. See the header comment's "Runner failures" section.
export function classifyRunResult(r) {
  if (r.error) {
    const timedOut = r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
    return {
      runOutcome: timedOut ? 'timed-out' : 'crashed',
      testResults: [],
      errorMessage: r.error.message,
    };
  }
  if (r.signal) {
    // Killed by a signal with no explicit spawn error attached (platform-
    // dependent on how a timeout kill is surfaced) — still a hang, not a
    // clean exit.
    return { runOutcome: 'timed-out', testResults: [], errorMessage: `killed by signal ${r.signal}` };
  }
  let json;
  try {
    json = JSON.parse(r.stdout ?? '');
  } catch (err) {
    return { runOutcome: 'crashed', testResults: [], errorMessage: `could not parse vitest JSON output: ${err.message}` };
  }
  if (!json || !Array.isArray(json.testResults)) {
    return { runOutcome: 'crashed', testResults: [], errorMessage: 'vitest JSON payload had no testResults array' };
  }
  return { runOutcome: 'ok', testResults: json.testResults };
}

function runVitestJson(cwd, config, files) {
  if (files.length === 0) return { runOutcome: 'ok', testResults: [] };
  const args = buildVitestArgs(config, files);
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
    timeout: VITEST_RUN_TIMEOUT_MS,
    // RUN_QUARANTINE=1 is what turns quarantinedIt/quarantinedDescribe from
    // it.skip into a real it — without it every quarantined test reports
    // 'skipped' here and would misclassify as never-passes for EVERY test,
    // register-wide. Real env var, not a vitest `env:` config key (mirrors
    // `cross-env RUN_QUARANTINE=1` in the `test:quarantine` script).
    env: { ...process.env, RUN_QUARANTINE: '1' },
  });
  const result = classifyRunResult(r);
  if (result.runOutcome !== 'ok') {
    console.error(`quarantine-health: vitest run in ${cwd} ${result.runOutcome}: ${result.errorMessage}`);
    if (r.stderr) console.error(r.stderr);
  }
  return result;
}

function checkIssueState(issueNumber) {
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'state', '-q', '.state'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
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
  const perRunFailedDomains = [];
  let abortedEarly = false;
  try {
    for (let i = 0; i < RUNS; i++) {
      console.log(`quarantine-health: run ${i + 1}/${RUNS}`);
      const outcomes = [];
      const failedDomains = new Set();
      if (frontendFiles.length) {
        const fe = runVitestJson(ROOT, undefined, frontendFiles);
        if (fe.runOutcome !== 'ok') failedDomains.add('frontend');
        outcomes.push(...flattenVitestJson(fe));
      }
      if (serverFiles.length) {
        const serverMain = runVitestJson(serverRoot, 'vitest.config.ts', serverFiles);
        const serverSlow = runVitestJson(serverRoot, 'vitest.config.slow.ts', serverFiles);
        if (serverMain.runOutcome !== 'ok' || serverSlow.runOutcome !== 'ok') failedDomains.add('server');
        outcomes.push(...flattenVitestJson(serverMain), ...flattenVitestJson(serverSlow));
      }
      perRunOutcomes.push(outcomes);
      perRunFailedDomains.push(failedDomains);
    }
  } catch (err) {
    // Defensive belt-and-suspenders: runVitestJson/classifyRunResult never
    // throw by construction (every spawn/timeout/parse failure is caught and
    // classified), but if something still does, emit whatever runs already
    // completed instead of losing the report entirely — the whole point of
    // the timeout/crash handling above is that one bad run must not black
    // out the rest (finding 5).
    console.error(`quarantine-health: aborted early after ${perRunOutcomes.length}/${RUNS} run(s): ${err.message}`);
    abortedEarly = true;
  }

  const entries = aggregate(rows, perRunOutcomes, perRunFailedDomains);

  const uniqueIssues = [...new Set(rows.flatMap((r) => r.issueNumbers))];
  const issueStates = new Map(uniqueIssues.map((n) => [n, checkIssueState(n)]));

  const report = formatReport({ entries, runs: perRunOutcomes.length, issueStates });
  emit(
    abortedEarly
      ? `${report}\n\n**Aborted early after ${perRunOutcomes.length}/${RUNS} planned run(s)** — see the job log for the error.`
      : report,
  );
  // Always exit 0 for test outcomes, including "never-passes" and "unknown"
  // — this lane is non-blocking by design (see the header comment).
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
