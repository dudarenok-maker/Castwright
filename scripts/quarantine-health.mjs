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

   CONSTRAINT: `docs/testing/flaky-register.md` MUST contain exactly one markdown
   table (the register itself). The row-walking logic counts any `| ... |` line
   that isn't a header/separator as a candidate data row; a second unrelated table
   elsewhere in that file would be misread as malformed register rows and fire
   the parse-failure guard falsely. This is not a code bug today (the register
   currently has exactly one table), but it's a constraint on future edits to
   that file.

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
   That try/catch only fires on a THROWN exception, though, and neither
   `runVitestJson` nor `classifyRunResult` throws by construction — every
   spawn/timeout/parse failure is caught and classified, not thrown. A run
   that legitimately times out therefore does NOT unwind into that catch; it
   returns normally (as a 'timed-out' outcome) and the loop moves on to the
   next run.

   That matters because `VITEST_RUN_TIMEOUT_MS` (5 min) applies PER vitest
   invocation, and one run can make up to three of them (frontend, server
   main, server slow) — worst case 5 * 3 = 15 min for a single run, and
   `RUNS` (default 5) of those would be 75 min, well past
   `.github/workflows/quarantine-health.yml`'s `timeout-minutes: 30` job cap.
   The REAL guarantee this script makes is a wall-clock BUDGET on the run
   loop itself (`RUN_LOOP_WALL_CLOCK_BUDGET_MS`, 20 min): before starting
   each run, it checks whether that run's own worst case (its actual number
   of domain invocations * VITEST_RUN_TIMEOUT_MS) still fits inside the
   remaining budget; if not, the loop stops starting new runs and the report
   is emitted on however many runs actually completed — an honest partial
   report rather than a promise ("a partial report is emitted even when a
   later run dies") that a timeout can silently outrun. 20 minutes leaves
   ~10 minutes of margin inside the 30-minute job cap for checkout/npm
   install/`apt-get install ffmpeg` and the `gh issue view` calls that run
   AFTER this loop — see `worstCaseRunMs`/`budgetExceeded` (pure,
   unit-tested) and the arithmetic pinned in quarantine-health.test.mjs.

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
import { ghSpawn } from './gh.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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

// Classifies WHY a QUARANTINE_HEALTH_RUNS override needs a warning (or
// doesn't), separate from resolveRuns's own fallback value (re-review
// finding 8). Two bugs in the old inline check this replaces:
//   1. It compared `String(RUNS) !== envValue` against the RAW env string —
//      a merely whitespace-padded but otherwise valid value (' 5 ') fails
//      that string comparison even though `Number(' 5 ')` parses to a valid
//      5, so it tripped a spurious "not a positive integer" warning for
//      input that was fine.
//   2. It always said "defaulting to N" — accurate for a genuinely invalid
//      value (falls back to the true default, 5), but misleading for a
//      valid-but-fractional value ('2.9' floors to 2, which is NOT "the
//      default", it's a floor of the value actually given).
// Returns null (no warning needed), 'invalid' (falls back to the default),
// or 'fractional' (valid but floored).
export function classifyRunsOverride(envValue) {
  if (envValue === undefined) return null;
  const n = Number(envValue);
  if (!(Number.isFinite(n) && n > 0)) return 'invalid';
  if (!Number.isInteger(n)) return 'fractional';
  return null;
}

// Internal generator: yields well-formed data row cells (≥5 cells) from the
// markdown table, regardless of File cell contents. Used by parseRegister to
// produce entries, and by countRegisterDataRows to count structurally valid
// rows. The HTML-comment state tracking (re-review finding 1) lives here.
// Callers handle empty File cells themselves — parseRegister skips them when
// building entries (can't use a row with no file), but countRegisterDataRows
// counts them as "data rows" for validation purposes so the loud-failure guard
// can detect rows with empty File cells as unparsed (fixing Bug A: empty File
// cells must not silently vanish).
//
// Note: rows with <5 cells are NOT yielded here — countUnparsedDataRows must
// handle them separately via yieldAllCandidateRows to detect malformed rows
// (Fix 3: <5 cell rows are parse failures, not silent skips).
export function* yieldDataRowCells(markdown) {
  let inComment = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    let visible = '';
    let remainder = rawLine;
    while (remainder.length > 0) {
      if (inComment) {
        const closeIdx = remainder.indexOf('-->');
        if (closeIdx === -1) {
          remainder = '';
        } else {
          inComment = false;
          remainder = remainder.slice(closeIdx + 3);
        }
      } else {
        const openIdx = remainder.indexOf('<!--');
        if (openIdx === -1) {
          visible += remainder;
          remainder = '';
        } else {
          visible += remainder.slice(0, openIdx);
          inComment = true;
          remainder = remainder.slice(openIdx + 4);
        }
      }
    }

    const line = visible.trim();
    if (!line.startsWith('|')) continue; // prose, blank lines
    if (isSeparatorRow(line)) continue; // the `|---|---|` separator row
    if (isHeaderRow(line)) continue; // the header row

    const cells = splitTableRow(line);
    if (cells.length < 5) continue; // not a well-formed 6-column data row

    yield cells; // Yield the full row's cells for the caller to use
  }
}

// Internal generator: yields ALL candidate rows (including malformed ones with
// <5 cells), with per-row metadata. Used by countUnparsedDataRows to detect
// rows that are structurally invalid — they must count as unparsed entries so
// the loud-failure guard catches malformed registers (Fix 3). Shares the same
// HTML-comment state tracking and header/separator skipping as yieldDataRowCells.
// NOTE: this counts ANY `| ... |` line as a candidate row (after skipping
// headers/separators). docs/testing/flaky-register.md must have exactly one
// markdown table, or a second table's rows would be misread as malformed data
// rows and fire the parse-failure guard.
function* yieldAllCandidateRows(markdown) {
  let inComment = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    let visible = '';
    let remainder = rawLine;
    while (remainder.length > 0) {
      if (inComment) {
        const closeIdx = remainder.indexOf('-->');
        if (closeIdx === -1) {
          remainder = '';
        } else {
          inComment = false;
          remainder = remainder.slice(closeIdx + 3);
        }
      } else {
        const openIdx = remainder.indexOf('<!--');
        if (openIdx === -1) {
          visible += remainder;
          remainder = '';
        } else {
          visible += remainder.slice(0, openIdx);
          inComment = true;
          remainder = remainder.slice(openIdx + 4);
        }
      }
    }

    const line = visible.trim();
    if (!line.startsWith('|')) continue; // prose, blank lines
    if (isSeparatorRow(line)) continue; // the `|---|---|` separator row
    if (isHeaderRow(line)) continue; // the header row

    const cells = splitTableRow(line);
    yield { cells, wellFormed: cells.length >= 5 };
  }
}

// Recognizes recognized "this row IS quarantined" values in the Quarantined
// column. A cell is treated as quarantined if it either:
//   1. Starts with "Quarantined" (e.g. "Quarantined (2026-08-01)" or just "Quarantined"), or
//   2. Matches a bare YYYY-MM-DD date pattern (legacy format from before the
//      startsWith check was added — bare dates were previously used to mark rows
//      as quarantined; this is preserved for backward compatibility).
// Anything else (including unrecognized formats and empty cells) is NOT treated
// as a recognized quarantined value — a separate check must count those as unparsed.
export function isQuarantinedCell(cellValue) {
  const trimmed = (cellValue ?? '').trim();
  if (trimmed.startsWith('Quarantined')) return true;
  // Bare date pattern YYYY-MM-DD (legacy format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return true;
  return false;
}

// Recognizes "this row is NOT quarantined" values in the Quarantined column.
// A row explicitly marked "Not quarantined" (e.g. "Not quarantined — still gates")
// is in scope for the normal gating suite and must NOT be re-run or reported by
// the quarantine lane. This is distinct from an unrecognized value (which should
// be a parse error).
export function isNotQuarantinedCell(cellValue) {
  const trimmed = (cellValue ?? '').trim();
  return trimmed.startsWith('Not quarantined');
}

// Parses the register's markdown table into one entry per quarantined TEST
// (a row can name more than one backtick-quoted test sharing a file, as the
// wake-lock row did — each becomes its own entry). Never throws on malformed
// input: a table with no data rows (including the current, empty register)
// simply yields []; that IS the empty-register no-op path, not a distinct
// error case.
//
// A row with an empty File cell (Bug A) is structurally a data row but cannot
// produce an entry (no file to test), so it's skipped here but counted as
// unparsed by countUnparsedDataRows so the loud-failure guard catches it.
//
// A row whose Quarantined cell indicates it is NOT quarantined (e.g. "Not
// quarantined — still gates", like #1981) is also skipped here — that row is
// not quarantined at all, so it must never be re-run by or reported on by
// this tool. Unlike the empty-File-cell case, this is not a parse failure —
// the row parsed fine, it's just out of scope — so it is NOT counted by
// countUnparsedDataRows. A row with an unrecognized Quarantined value is
// handled by countUnparsedDataRows as a parse failure (loud).
export function parseRegister(markdown) {
  const entries = [];
  for (const cells of yieldDataRowCells(markdown)) {
    const [testCell, fileCell, , , issueCell, quarantinedCell] = cells;
    const file = fileCell.replace(/`/g, '').trim();

    // Skip rows with empty File cells — they can't become entries but must
    // still be counted as unparsed data rows by the guard (Bug A).
    if (!file) continue;

    // Skip rows that are explicitly NOT quarantined — they gate the normal
    // suite and must never be re-run by the quarantine lane. This is not a
    // parse failure, just out of scope.
    if (isNotQuarantinedCell(quarantinedCell)) continue;

    // Skip rows that are recognized as quarantined and proceed to extract their
    // test names. Unrecognized Quarantined values are not skipped here — they
    // will be counted as unparsed by countUnparsedDataRows so the loud-failure
    // guard catches the malformed cell.
    if (!isQuarantinedCell(quarantinedCell)) continue;

    // Check for prose format prefix first (Bug C fix: prose prefix takes
    // priority over incidental backticks). Once a #NNNN — prefix is detected,
    // the WHOLE remainder becomes exactly one test name, regardless of how many
    // backtick-quoted spans it contains (0, 1, or many).
    let testNames = [];
    const proseMatch = testCell.match(/^#\d+\s*—\s*(.+)/);
    if (proseMatch) {
      // Prose format — use the whole remainder as a single test name
      testNames.push(proseMatch[1].trim());
    } else {
      // No prose prefix — try backtick-quoted test names (multi-test expansion).
      testNames = [...testCell.matchAll(/\u0060([^\u0060]+)\u0060/g)].map((m) => m[1]);
    }

    if (testNames.length === 0) continue;

    const issueNumbers = [...(issueCell ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

    for (const testName of testNames) {
      entries.push({ testName, file, issueNumbers });
    }
  }
  return entries;
}

// Counts the number of data row candidates (any | ... | line with ≥1 cells,
// not a separator or header). This includes both well-formed rows (≥5 cells)
// and malformed ones (<5 cells — Fix 3). Used by main() to detect when data
// rows are present but yield unparsed entries — that mismatch signals a parser
// bug. Exported for unit testing.
export function countRegisterDataRows(markdown) {
  let count = 0;
  for (const _row of yieldAllCandidateRows(markdown)) {
    count++;
  }
  return count;
}

// Counts data rows that cannot produce a usable entry — a partial-drop
// detection for finding 1, Bug A, Fix 3 (malformed rows), and the fail-open
// Quarantined-cell gap (#2799). A row is "unparsed" if it either:
//   1. Has fewer than 5 cells (malformed row — Fix 3), or
//   2. Has an empty/whitespace-only File cell (Bug A), or
//   3. Has an unrecognized/malformed Quarantined cell value (neither a
//      recognized "quarantined" nor "not quarantined" shape), or
//   4. Has ≥5 cells and a non-empty File cell but neither backtick-quoted
//      test names nor a #NNNN — prose match yield any test name.
// The guard in main() uses this to fire on a partial drop (one or more
// unparsed rows), not just a total drop (all rows unparsed).
// Exported for unit testing.
export function countUnparsedDataRows(markdown) {
  let unparsedCount = 0;
  for (const { cells, wellFormed } of yieldAllCandidateRows(markdown)) {
    // Rows with <5 cells are malformed — they're unparsed (Fix 3).
    if (!wellFormed) {
      unparsedCount++;
      continue;
    }

    const testCell = cells[0];
    const fileCell = cells[1];
    const quarantinedCell = cells[5]; // 6th column, index 5
    const file = fileCell.replace(/`/g, '').trim();

    // Empty File cell is unparsed (Bug A).
    if (!file) {
      unparsedCount++;
      continue;
    }

    // Unrecognized Quarantined cell value is unparsed (#2799). A well-formed
    // row with a recognized "not quarantined" value is NOT unparsed (it's
    // just out of scope and skipped by parseRegister), but an unrecognized
    // value is a parse error and must fail loud.
    if (!isQuarantinedCell(quarantinedCell) && !isNotQuarantinedCell(quarantinedCell)) {
      unparsedCount++;
      continue;
    }

    // Try prose format first (Bug C: prose prefix takes priority over
    // incidental backticks inside the name). Once a #NNNN — prefix is detected,
    // the WHOLE remainder becomes a single test name, regardless of how many
    // backtick-quoted spans it contains. Either way, the row parses successfully.
    const proseMatch = testCell.match(/^#\d+\s*—\s*(.+)/);
    if (proseMatch) continue; // This row parsed successfully.

    // No prose prefix — try backtick-quoted test names.
    const testNames = [...testCell.matchAll(/\u0060([^\u0060]+)\u0060/g)].map((m) => m[1]);
    if (testNames.length > 0) continue; // This row parsed successfully.

    // If we get here, the row is well-formed but unparsed.
    unparsedCount++;
  }
  return unparsedCount;
}

// Analyzes the register markdown and returns a decision object that main()
// uses to branch on the guard logic (finding 2: extracting the guard into a
// testable pure function). Returns { outcome, entries, dataRowCount, unparsedCount }:
//   - outcome === 'empty': no data rows exist — clean no-op.
//   - outcome === 'ok': data rows present, all parse successfully — proceed.
//   - outcome === 'parse-failure': data rows present but some yield zero test
//     names — a parser bug, fail loud.
// The outcome is testable without calling main() or touching the real register
// file (fixing finding 2). Exported for unit testing.
export function planRegisterRun(markdown) {
  const entries = parseRegister(markdown);
  const dataRowCount = countRegisterDataRows(markdown);
  const unparsedCount = countUnparsedDataRows(markdown);

  // No data rows at all — genuinely empty register, clean no-op.
  if (dataRowCount === 0) {
    return { outcome: 'empty', entries, dataRowCount, unparsedCount: 0 };
  }

  // Data rows exist but some/all are unparsed — parser bug, fail loud.
  if (unparsedCount > 0) {
    return { outcome: 'parse-failure', entries, dataRowCount, unparsedCount };
  }

  // Data rows exist and all parse successfully — proceed.
  return { outcome: 'ok', entries, dataRowCount, unparsedCount: 0 };
}

// The `|---|---|` markdown table separator row. This guard is load-bearing:
// without it, separator rows get counted as malformed data rows (< 5 cells)
// and fire the parse-failure guard even though the register is actually fine
// (Fix 3). Pinned directly (quarantine-health.test.mjs) rather than via a
// contrived parseRegister fixture, so the guard's own contract stays asserted.
export function isSeparatorRow(line) {
  return /^\|\s*-+\s*\|/.test(line);
}

// The register's header row (`| Test | File | ... |`). Same load-bearing note
// as isSeparatorRow above: without it, header rows get counted as malformed
// data rows (< 5 cells) and fire the parse-failure guard even though the
// register is actually fine. The literal, un-backtick-quoted "Test" text alone
// is insufficient defense because the <5-cell detection (Fix 3) runs before
// downstream backtick checks.
export function isHeaderRow(line) {
  return /^\|\s*Test\s*\|/i.test(line);
}

// Splits one markdown table row into its cells, honouring the standard
// `\|` escape for a literal pipe INSIDE a cell (e.g. a Symptom cell that
// describes a `|` character). A naive `line.split('|')` treats every pipe
// as a column delimiter, so an escaped pipe shifts every subsequent column
// left by one — silently dropping the Tracking-issue cell into the wrong
// position and losing `issueNumbers` (re-review finding 1: this disables the
// closed-tracking-issue check, the whole lesson of the #399 postmortem).
// The leading/trailing `|` are stripped first (matching the prior
// behaviour), then the split uses a negative lookbehind so `\|` is never
// treated as a delimiter, and each cell has its escape unescaped afterward.
export function splitTableRow(line) {
  const inner = line.slice(1, line.endsWith('|') ? -1 : undefined);
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
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
//
// A minimum-usable-runs FLOOR (re-review finding 4) applies on top of that:
// this tool's entire premise (header comment, "A single run can't tell
// 'intermittent' from 'never passes' apart") is that a verdict needs several
// runs' worth of evidence. Without a floor, 4-of-5 runs unavailable + the
// ONE surviving run passing would render `always-passes` — "candidate to
// graduate back into the gating suite" — off a single data point, exactly
// the single-run confidence the tool exists to avoid. The floor requires a
// MAJORITY of the attempted runs to be usable (ceil(total/2)); below that,
// the verdict degrades to `unknown` rather than asserting a bucket the
// available evidence can't actually support. This does not second-guess a
// deliberately small QUARANTINE_HEALTH_RUNS override (the floor is relative
// to however many runs were actually attempted, not a fixed count) — it
// only catches the case where RUNNER FAILURES shrink the effective sample
// size below what was attempted.
export function minUsableRuns(totalRuns) {
  return Math.ceil(totalRuns / 2);
}

export function classifyEntry(perRunStatuses) {
  const usable = perRunStatuses.filter((s) => s !== 'run-unavailable');
  const unavailable = perRunStatuses.length - usable.length;
  if (usable.length === 0 || usable.length < minUsableRuns(perRunStatuses.length)) {
    const found = usable.filter((s) => s !== null);
    const notFound = usable.length - found.length;
    const passed = found.filter((s) => s === 'passed').length;
    const failed = found.length - passed;
    return { bucket: 'unknown', passed, failed, notFound, unavailable };
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
// of 'frontend' | 'server-main' | 'server-slow') names which vitest
// invocation(s) failed to execute on run i.
//
// The server domain is tracked as TWO sub-flags, not one 'server' flag
// (re-review finding 5). A server file lives in exactly one of the two
// configs (main vs. slow) — both are tried per file and whichever owns it
// reports real results (see the header comment's "mirror invariant"
// paragraph); the other reports zero matched tests for it, harmlessly. Under
// the old single 'server' flag, EITHER config crashing marked every
// server-domain entry 'run-unavailable' for that run, discarding a perfectly
// good result the surviving config already produced. Now: if only one
// config failed, an entry actually FOUND in the surviving config's outcomes
// is trusted (a hit is authoritative regardless of the other config's
// crash); an entry NOT found is still marked 'run-unavailable' rather than
// null/not-found, because it might belong to the crashed config, which never
// got a chance to report it — a genuine "not found" verdict requires BOTH
// configs to have actually run.
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
      const failedSet = perRunFailedDomains[i];
      if (domain === 'server') {
        const mainFailed = !!failedSet?.has('server-main');
        const slowFailed = !!failedSet?.has('server-slow');
        if (mainFailed && slowFailed) return 'run-unavailable';
        const hit = findOutcome(outcomes, entry.file, entry.testName);
        if (hit) return hit.status;
        return mainFailed || slowFailed ? 'run-unavailable' : null;
      }
      if (failedSet?.has(domain)) return 'run-unavailable';
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

  // finding 8: when every registered row is a Playwright (`e2e/**`) spec, the
  // main loop never spawns a single vitest process — "Ran the quarantine
  // lane N time(s)" would falsely claim N real runs happened. Say so.
  if (entries.every((e) => e.bucket === 'not-covered')) {
    lines.push(
      'No vitest runs were needed — every registered row is a Playwright (`e2e/**`) spec; check them manually via `npm run test:e2e:quarantine`. Bucket legend:',
    );
  } else {
    lines.push(`Ran the quarantine lane ${runs} time(s). Bucket legend:`);
  }
  lines.push('');
  lines.push('- **always-passes** — every run passed; candidate to graduate back into the gating suite.');
  lines.push('- **intermittent** — some runs passed, some failed; genuinely flaky, the register row is honest.');
  lines.push('- **never-passes** — every run failed; not flaky, just broken — the register row is likely lying.');
  lines.push(
    '- **not-found** — could not be located in any usable run; the register row is stale (renamed/moved test or file).',
  );
  lines.push(
    '- **unknown** — too few usable runs to render a verdict (every run that could have covered this test crashed/timed out, or fewer than a majority did); not a verdict, investigate the runner failures.',
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
    // finding 4/8: the shared `runs` (total attempted) is the WRONG
    // denominator per-row — a row's own usable-run count (excluding
    // not-found and unavailable runs) can differ from the total attempted,
    // and from other rows in this same list. Each row states its own count.
    const detail = neverPasses
      .map((e) => `\`${e.testName}\` (${e.runs - (e.notFound ?? 0) - (e.unavailable ?? 0)} usable run(s))`)
      .join(', ');
    lines.push(
      `**${neverPasses.length} test(s) never passed in every usable run** — not flaky, just broken: ${detail}. Investigate before trusting the register row's diagnosis.`,
    );
  }

  const unknownEntries = entries.filter((e) => e.bucket === 'unknown');
  if (unknownEntries.length) {
    lines.push('');
    lines.push(
      `**${unknownEntries.length} test(s) have no reliable verdict** — too few of their runs were usable (crashed, timed out, or below the majority floor) to tell intermittent from never-passes apart. This is NOT a verdict about the test; investigate the runner failures in the job log first.`,
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
    // finding 4/8: same per-row-denominator fix as the never-passes callout
    // above — a not-found row's usable-run count equals its notFound count
    // by definition (found === 0 in this bucket), not the shared `runs`.
    const detail = notFound.map((e) => `\`${e.testName}\` (${e.notFound ?? 0} usable run(s))`).join(', ');
    lines.push(
      `**${notFound.length} row(s) could not be located**: ${detail} — the register row's Test/File text likely no longer matches the code.`,
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

// Builds the error message for a parse-failure outcome — when data rows are
// present but some cannot produce usable entries (due to malformed rows with <5
// cells, empty File cells, or unparseable Test cells). Extracted as a pure
// function so it can be unit-tested (fixing finding 3: the message was never
// reaching $GITHUB_STEP_SUMMARY because the parse-failure branch only called
// console.error, not emit()). Exported for unit testing.
export function buildParseFailureMessage(registerPath, dataRowCount, unparsedCount) {
  return `quarantine-health: ${registerPath} contains ${dataRowCount} data row(s) but ${unparsedCount} could not be fully parsed — either the parser can't handle their format, or the register itself is malformed (check for a missing/empty column). This needs a human to look, not a clean no-op.`;
}

// Reports a parse failure: builds the message, emits it to GITHUB_STEP_SUMMARY,
// and sets the exit code. Extracted as a separate function for testability
// (Bug B regression: the emit() path must actually reach $GITHUB_STEP_SUMMARY).
// Exported for unit testing.
export function reportParseFailure(registerPath, dataRowCount, unparsedCount) {
  const message = buildParseFailureMessage(registerPath, dataRowCount, unparsedCount);
  emit(message);
  process.exitCode = 1;
}

// The worst-case wall-clock time ONE run could take, given how many separate
// vitest invocations it makes this run (frontend + server main + server
// slow, each independently bounded by VITEST_RUN_TIMEOUT_MS). Pure —
// unit-tested. See the header comment's wall-clock-budget paragraph
// (re-review finding 3).
export function worstCaseRunMs(frontendFileCount, serverFileCount, perInvocationTimeoutMs) {
  const invocations = (frontendFileCount > 0 ? 1 : 0) + (serverFileCount > 0 ? 2 : 0);
  return invocations * perInvocationTimeoutMs;
}

// True when starting one more run risks exceeding the total wall-clock
// budget for the run loop — i.e. this run's own worst case would push the
// elapsed time past the budget. Pure — unit-tested. See the header comment's
// wall-clock-budget paragraph (re-review finding 3).
export function budgetExceeded(elapsedMs, oneRunWorstCaseMs, budgetMs) {
  return elapsedMs + oneRunWorstCaseMs > budgetMs;
}

// ---------------------------------------------------------------------------
// I/O (thin — deliberately not unit-tested; the pure functions above own the
// logic this delegates to)
// ---------------------------------------------------------------------------

const RUNS = resolveRuns(process.env.QUARANTINE_HEALTH_RUNS);
const runsOverrideIssue = classifyRunsOverride(process.env.QUARANTINE_HEALTH_RUNS);
if (runsOverrideIssue === 'invalid') {
  console.error(
    `quarantine-health: QUARANTINE_HEALTH_RUNS="${process.env.QUARANTINE_HEALTH_RUNS}" is not a positive number — defaulting to ${RUNS} run(s).`,
  );
} else if (runsOverrideIssue === 'fractional') {
  console.error(
    `quarantine-health: QUARANTINE_HEALTH_RUNS="${process.env.QUARANTINE_HEALTH_RUNS}" is not an integer — flooring to ${RUNS} run(s).`,
  );
}

// Bounded per-invocation budget so a #1854-style deadlock (the process hangs
// rather than failing) can't block the whole script forever — generous for
// the small, explicit quarantined-file list this always runs with, but finite.
export const VITEST_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const GH_TIMEOUT_MS = 30 * 1000;

// Total wall-clock budget for the run loop (re-review finding 3) — see the
// header comment's wall-clock-budget paragraph. Must stay comfortably under
// JOB_CAP_MS with margin for checkout/npm-install/apt-get-ffmpeg and the
// post-loop `gh issue view` calls; pinned by an arithmetic test in
// quarantine-health.test.mjs so a future bump to either constant can't
// silently blow the job's timeout budget again.
export const RUN_LOOP_WALL_CLOCK_BUDGET_MS = 20 * 60 * 1000;
// Mirrors `timeout-minutes: 30` in .github/workflows/quarantine-health.yml —
// keep these in sync if that job's cap ever changes.
export const JOB_CAP_MS = 30 * 60 * 1000;

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
    // `r.error.code` is the ONLY reliable discriminator here — a real
    // timeout and a maxBuffer overflow both kill the child with SIGTERM
    // (measured: overflow -> {code:'ENOBUFS', signal:'SIGTERM'}; timeout ->
    // {code:'ETIMEDOUT', signal:'SIGTERM'}), so the old `|| r.signal ===
    // 'SIGTERM'` fallback reported every 64 MB-stdout overflow as a hang
    // (re-review finding 2) — precisely backwards from the header comment's
    // own claim that a hang and a crash are different diagnoses.
    const timedOut = r.error.code === 'ETIMEDOUT';
    return {
      runOutcome: timedOut ? 'timed-out' : 'crashed',
      testResults: [],
      errorMessage: r.error.message,
    };
  }
  if (r.signal) {
    // Killed by a signal with no explicit spawn error attached. Node's own
    // timeout enforcement (verified above) always attaches an `error` with
    // `code: 'ETIMEDOUT'`, so a bare signal here did NOT come from this
    // script's own timeout — it's an external kill. SIGTERM is kept as
    // 'timed-out' (platform-dependent fallback for a timeout surfaced
    // without an accompanying error), but any other signal — notably a
    // runner OOM-killer's SIGKILL — must NOT be reported as a hang; that
    // sends an investigator looking for a deadlock when the real cause is
    // memory (re-review finding 2).
    if (r.signal === 'SIGTERM') {
      return { runOutcome: 'timed-out', testResults: [], errorMessage: `killed by signal ${r.signal}` };
    }
    return {
      runOutcome: 'crashed',
      testResults: [],
      errorMessage: `killed by signal ${r.signal} (possible OOM kill, not a timeout)`,
    };
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
    windowsHide: true,
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
  const r = ghSpawn(['issue', 'view', String(issueNumber), '--json', 'state', '-q', '.state'], {
    timeout: GH_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) return null;
  const state = r.stdout.trim();
  return state || null;
}

export function emit(report) {
  console.log(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, report + '\n');
}

export function main(registerPath = REGISTER_PATH) {
  let markdown;
  try {
    markdown = readFileSync(registerPath, 'utf8');
  } catch (err) {
    console.error(`quarantine-health: could not read register at ${registerPath}: ${err.message}`);
    process.exitCode = 1; // genuinely broken setup, not a test-outcome verdict
    return;
  }

  // Check the register's parsing health. planRegisterRun() handles three cases:
  // 1. Empty register (no data rows) — clean no-op.
  // 2. Parse failure (data rows present but some cannot produce usable entries —
  //    either due to unparseable Test cells, empty File cells, or malformed rows
  //    with <5 cells) — bug.
  // 3. Healthy register (all data rows parse successfully) — proceed to vitest runs.
  // This fixes finding 1 (partial drops now fire the guard, not just total drops),
  // finding 2 (the guard is now a testable pure function, not inline logic),
  // Bug A (empty File cells are now counted as parse failures, not silently skipped),
  // and Fix 3 (malformed rows with <5 cells are now counted as parse failures).
  const plan = planRegisterRun(markdown);
  if (plan.outcome === 'empty') {
    emit(formatReport({ entries: [], runs: 0, issueStates: new Map() }));
    return; // clean no-op — exit 0
  }
  if (plan.outcome === 'parse-failure') {
    reportParseFailure(registerPath, plan.dataRowCount, plan.unparsedCount);
    return;
  }

  const rows = plan.entries;

  const frontendFiles = [...new Set(rows.filter((r) => fileDomain(r.file) === 'frontend').map((r) => r.file))];
  const serverFiles = [
    ...new Set(rows.filter((r) => fileDomain(r.file) === 'server').map((r) => serverRelativePath(r.file))),
  ];
  const serverRoot = resolve(ROOT, 'server');

  const perRunOutcomes = [];
  const perRunFailedDomains = [];
  let abortedEarly = false;
  let budgetExhausted = false;
  // See the header comment's wall-clock-budget paragraph (re-review finding
  // 3): this run's own worst case is fixed for the whole loop (same register,
  // same file lists every iteration), so it's computed once outside the loop.
  const oneRunWorstCaseMs = worstCaseRunMs(frontendFiles.length, serverFiles.length, VITEST_RUN_TIMEOUT_MS);
  const loopStart = Date.now();
  try {
    for (let i = 0; i < RUNS; i++) {
      if (budgetExceeded(Date.now() - loopStart, oneRunWorstCaseMs, RUN_LOOP_WALL_CLOCK_BUDGET_MS)) {
        console.error(
          `quarantine-health: stopping after ${perRunOutcomes.length}/${RUNS} planned run(s) — starting another run risks exceeding the ${RUN_LOOP_WALL_CLOCK_BUDGET_MS / 60000}-minute wall-clock budget.`,
        );
        budgetExhausted = true;
        break;
      }
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
        // Two distinct flags, not one 'server' flag — see aggregate()'s
        // comment (re-review finding 5): a config crashing must not discard
        // the OTHER config's good results for the files it owns.
        if (serverMain.runOutcome !== 'ok') failedDomains.add('server-main');
        if (serverSlow.runOutcome !== 'ok') failedDomains.add('server-slow');
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
  let finalReport = report;
  if (abortedEarly) {
    finalReport += `\n\n**Aborted early after ${perRunOutcomes.length}/${RUNS} planned run(s)** — see the job log for the error.`;
  } else if (budgetExhausted) {
    finalReport += `\n\n**Stopped after ${perRunOutcomes.length}/${RUNS} planned run(s)** — starting another run would have risked exceeding the ${RUN_LOOP_WALL_CLOCK_BUDGET_MS / 60000}-minute wall-clock budget; see the job log.`;
  }
  emit(finalReport);
  // Always exit 0 for test outcomes, including "never-passes" and "unknown"
  // — this lane is non-blocking by design (see the header comment).
}

// Only run when invoked directly (not when imported by tests). See
// scripts/lib/is-main-module.mjs — a resolve()-only comparison misses when
// the invocation crosses a symlink/junction (#2291).
const invokedAsCli = isDirectlyInvoked(import.meta.url);
if (invokedAsCli) main();
