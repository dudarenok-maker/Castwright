// Guards the wiring of the mobile/tablet visual-baseline gate (#4203).
//
// The owner decided the mobile-chrome / tablet-chrome visual baselines run OFF
// the PR path: in cross-os.yml's `mobile-e2e` job (cron + dispatch) and in
// release.yml's `mobile-e2e` job (every release tag), never in verify.yml.
// `test:e2e:mobile` stays the non-visual suite (--grep-invert), and the new
// `test:e2e:mobile:visual` script reads exactly those baselines, serially.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const VISUAL = 'npm run test:e2e:mobile:visual';

test('test:e2e:mobile:visual reads the mobile + tablet baselines serially, read-only', () => {
  const s = pkg.scripts['test:e2e:mobile:visual'];
  assert.ok(s, 'scripts.test:e2e:mobile:visual must exist');
  assert.ok(s.includes('e2e/responsive/visual.spec.ts'), 'must target visual.spec.ts');
  assert.ok(s.includes('--project=mobile-chrome'), 'must run mobile-chrome');
  assert.ok(s.includes('--project=tablet-chrome'), 'must run tablet-chrome');
  assert.ok(s.includes('--workers=1'), 'visual.spec.ts is serial: --workers=1 required');
  assert.ok(!s.includes('--update-snapshots'), 'must never rewrite baselines');
});

test('test:e2e:mobile stays the non-visual suite', () => {
  const s = pkg.scripts['test:e2e:mobile'];
  assert.ok(s.includes('--grep-invert'), 'must keep --grep-invert');
  assert.ok(s.includes('visual baselines'), 'must keep excluding "visual baselines"');
});

for (const wf of ['cross-os', 'release']) {
  test(`${wf}.yml mobile-e2e runs the visual script after E2E Mobile and uploads test-results/`, () => {
    const doc = yaml.load(read(`.github/workflows/${wf}.yml`));
    const steps = doc.jobs['mobile-e2e'].steps;
    const mobile = steps.findIndex((st) => st.run === 'npm run test:e2e:mobile');
    const visual = steps.findIndex((st) => st.run === VISUAL);
    assert.ok(mobile >= 0, 'E2E Mobile step missing');
    assert.ok(visual >= 0, `missing step with run exactly "${VISUAL}"`);
    assert.ok(visual > mobile, 'visual step must come after the E2E Mobile step');
    const upload = steps.find((st) => String(st.uses || '').startsWith('actions/upload-artifact'));
    assert.ok(upload, 'upload-artifact step missing');
    assert.ok(String(upload.with.path).includes('test-results/'), 'upload path must include test-results/');
  });
}

test('verify.yml (the PR path) does not run the mobile visual script', () => {
  assert.ok(!read('.github/workflows/verify.yml').includes('test:e2e:mobile:visual'));
});

// The step existing is not enough: a step marked non-blocking or skipped, or a
// publish that no longer waits on the job, lets a release ship past a red (or
// never-run) visual gate.
for (const wf of ['cross-os', 'release']) {
  test(`${wf}.yml visual step and mobile-e2e job are blocking and always run`, () => {
    const doc = yaml.load(read(`.github/workflows/${wf}.yml`));
    const job = doc.jobs['mobile-e2e'];
    const step = job.steps.find((st) => st.run === VISUAL);
    assert.ok(step, `missing step with run exactly "${VISUAL}"`);
    assert.ok(!('if' in step), 'visual step must have no `if:` (it would be skippable)');
    assert.ok(
      !('continue-on-error' in step),
      'visual step must not set continue-on-error (a red run must fail the job)',
    );
    assert.ok(!('continue-on-error' in job), 'mobile-e2e job must not set continue-on-error');
    // cross-os.yml's job is legitimately scope-gated (and always runs on dispatch);
    // a release tag has no such gate, so any `if:` there skips the gate.
    if (wf === 'release') assert.ok(!('if' in job), 'release mobile-e2e job must have no `if:`');
  });
}

test('release.yml publish waits on the mobile-e2e job', () => {
  const doc = yaml.load(read('.github/workflows/release.yml'));
  const needs = [].concat(doc.jobs.publish.needs);
  assert.ok(needs.includes('mobile-e2e'), 'publish.needs must include mobile-e2e');
});

// visual.spec.ts skips every test when its e2e/linux/... baseline dir is absent,
// which would turn the gate green with all skips. Pin the dirs as non-empty.
for (const project of ['mobile-chrome', 'tablet-chrome']) {
  test(`${project} linux visual baselines exist (otherwise the gate is all-skips)`, () => {
    const dir = resolve(ROOT, 'e2e', 'linux', 'responsive', 'visual.spec.ts', project);
    const pngs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : [];
    assert.ok(pngs.length > 0, `${dir} must contain committed .png baselines`);
  });
}

// Config spellings can all look right while the run is an all-skip (a missing
// baseline dir, --pass-with-no-tests, a project-conditional test.skip). So the
// visual step writes a JSON report and a follow-up step asserts its OUTCOME.
const ASSERT =
  'node scripts/assert-playwright-ran.mjs playwright-visual-report.json --projects mobile-chrome,tablet-chrome';
for (const wf of ['cross-os', 'release']) {
  test(`${wf}.yml asserts the visual run's outcome from its JSON report`, () => {
    const doc = yaml.load(read(`.github/workflows/${wf}.yml`));
    const steps = doc.jobs['mobile-e2e'].steps;
    const visual = steps.findIndex((st) => st.run === VISUAL);
    const check = steps.findIndex((st) => st.run === ASSERT);
    assert.ok(check === visual + 1, `the step running "${ASSERT}" must directly follow the visual step`);
    assert.equal(steps[visual].env?.PW_JSON_REPORT, 'playwright-visual-report.json');
    assert.ok(!('if' in steps[check]), 'outcome step must have no `if:`');
    assert.ok(!('continue-on-error' in steps[check]), 'outcome step must be blocking');
    assert.ok(!pkg.scripts['test:e2e:mobile:visual'].includes('pass-with-no-tests'));
  });
}

test('assert-playwright-ran fails on no tests, skips, failures; passes on a clean run', async () => {
  const { checkStats } = await import('../assert-playwright-ran.mjs');
  const ok = { stats: { expected: 36, skipped: 0, unexpected: 0, flaky: 0 } };
  assert.equal(checkStats(ok), null);
  assert.match(checkStats({ stats: { ...ok.stats, expected: 0 } }), /expected 0/);
  assert.match(checkStats({ stats: { ...ok.stats, skipped: 2 } }), /skipped/);
  assert.match(checkStats({ stats: { ...ok.stats, unexpected: 1 } }), /failed/);
  assert.match(checkStats({ stats: { ...ok.stats, flaky: 1 } }), /flaky/);
  assert.match(checkStats({}), /no stats/);
});

// A report can pass the totals while one project ran nothing (a testIgnore that
// empties tablet-chrome): require passes PER expected project.
const pw = (project, status = 'expected') => ({ specs: [{ tests: [{ projectName: project, status }] }] });
test('assert-playwright-ran requires passes in every expected project', async () => {
  const { checkProjects } = await import('../assert-playwright-ran.mjs');
  const both = { suites: [{ suites: [pw('mobile-chrome'), pw('tablet-chrome')] }] };
  const mobileOnly = { suites: [{ suites: [pw('mobile-chrome'), pw('mobile-chrome')] }] };
  const want = ['mobile-chrome', 'tablet-chrome'];
  assert.equal(checkProjects(both, want), null);
  assert.match(checkProjects(mobileOnly, want), /tablet-chrome/);
  assert.match(checkProjects({ suites: [] }, want), /mobile-chrome/);
  assert.equal(checkProjects(mobileOnly, []), null);
});
