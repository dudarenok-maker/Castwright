// Guards the wiring of the mobile/tablet visual-baseline gate (#4203).
//
// The owner decided the mobile-chrome / tablet-chrome visual baselines run OFF
// the PR path: in cross-os.yml's `mobile-e2e` job (cron + dispatch) and in
// release.yml's `mobile-e2e` job (every release tag), never in verify.yml.
// `test:e2e:mobile` stays the non-visual suite (--grep-invert), and the new
// `test:e2e:mobile:visual` script reads exactly those baselines, serially.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
