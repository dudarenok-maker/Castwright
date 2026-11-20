// Outcome check for a Playwright run (#4203): fail unless the JSON report shows
// tests actually ran and none were skipped. A gate that is wired correctly can
// still be all-skips (a missing baseline dir, --pass-with-no-tests, a
// project-conditional test.skip); a config-spelling test cannot see that.
//
//   node scripts/assert-playwright-ran.mjs <report.json>
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

if (isDirectlyInvoked(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: assert-playwright-ran.mjs <report.json>');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read the Playwright JSON report ${file}: ${e.message}`);
    process.exit(1);
  }
  const problem = checkStats(report);
  if (problem) {
    console.error(`Playwright outcome check failed: ${problem}`);
    process.exit(1);
  }
  console.log(`Playwright outcome check ok: ${report.stats.expected} passed, 0 skipped`);
}
