// Outcome check for a Playwright run (#4203): fail unless the JSON report shows
// tests actually ran and none were skipped. A gate that is wired correctly can
// still be all-skips (a missing baseline dir, --pass-with-no-tests, a
// project-conditional test.skip); a config-spelling test cannot see that.
//
//   node scripts/assert-playwright-ran.mjs <report.json> [--projects a,b]
//
// Deliberately strict: any `failed` OR `flaky` test fails the check, so a test
// that only passed on retry blocks `publish` (owner decision 2026-11-21).
import { readFileSync } from 'node:fs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

export function checkStats(report) {
  const s = report && report.stats;
  if (!s) return 'no stats in the Playwright JSON report';
  if (!(s.expected > 0)) return `expected ${s.expected} passing tests, need > 0`;
  if (s.skipped !== 0) return `${s.skipped} test(s) were skipped, need 0`;
  if (s.unexpected !== 0 || s.flaky !== 0) {
    return `${s.unexpected} failed, ${s.flaky} flaky`;
  }
  return null;
}

// Passing tests per project, so a testIgnore that empties one project fails
// even when the totals look healthy.
export function checkProjects(report, projects) {
  const passed = Object.fromEntries(projects.map((p) => [p, 0]));
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status === 'expected' && t.projectName in passed) passed[t.projectName]++;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  const empty = projects.filter((p) => passed[p] === 0);
  return empty.length ? `no passing tests in project(s): ${empty.join(', ')}` : null;
}

if (isDirectlyInvoked(import.meta.url)) {
  const [file, flag, list] = process.argv.slice(2);
  const projects = flag === '--projects' && list ? list.split(',') : [];
  if (!file) {
    console.error('usage: assert-playwright-ran.mjs <report.json> [--projects a,b]');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read the Playwright JSON report ${file}: ${e.message}`);
    process.exit(1);
  }
  const problem = checkStats(report) ?? checkProjects(report, projects);
  if (problem) {
    console.error(`Playwright outcome check failed: ${problem}`);
    process.exit(1);
  }
  console.log(
    `Playwright outcome check ok: ${report.stats.expected} passed, 0 skipped` +
      (projects.length ? ` (projects: ${projects.join(', ')})` : ''),
  );
}
