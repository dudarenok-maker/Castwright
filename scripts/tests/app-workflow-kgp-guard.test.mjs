// scripts/tests/app-workflow-kgp-guard.test.mjs
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// app.yml's `android` job guards that the KGP escape-hatch flags stay in
// android/gradle.properties (ops-17 / #790). Flutter's migrators re-add a
// DELETED flag as false, but they are built only in the Gradle build
// (`flutter build`, buildGradleApp), not by `flutter pub get`. A guard placed
// after a build passes on the very deletion it exists to catch, so the guard
// sits right after checkout, ahead of the Flutter SDK step (and so ahead of
// every Flutter command, whatever spelling the step uses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appYml = readNormalized(resolve(repoRoot, '.github', 'workflows', 'app.yml'));

const GUARD = 'name: Guard KGP escape-hatch flags';
// The step that installs the SDK: no Flutter command can run before it.
const FLUTTER_ACTION = 'uses: subosito/flutter-action';

/** The `android` job's text, up to the next top-level job. */
function androidJob(text) {
  const start = text.indexOf('\n  android:\n');
  assert.notEqual(start, -1, 'app.yml has no android job');
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z][\w-]*:\n/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** True when the guard step precedes the Flutter SDK step in the job. */
function guardRunsFirst(job) {
  const guardAt = job.indexOf(GUARD);
  const action = job.indexOf(FLUTTER_ACTION);
  return guardAt !== -1 && action !== -1 && guardAt < action;
}

test('app.yml runs the KGP flag guard before the Flutter SDK step (#790)', () => {
  assert.ok(guardRunsFirst(androidJob(appYml)), 'move the guard above subosito/flutter-action');
});

const job = (...steps) => ['  android:', '    steps:', ...steps, ''].join('\n');
const ACTION = `      - ${FLUTTER_ACTION}@v2`;
const GUARD_STEP = `      - ${GUARD} (x)`;

test('guardRunsFirst rejects the old order, guard after the builds (#790)', () => {
  assert.equal(guardRunsFirst(job(ACTION, '      - run: flutter pub get', GUARD_STEP)), false);
});

test('guardRunsFirst rejects a guard after a named flutter step (#790)', () => {
  const named = ['      - name: Get deps', '        run: flutter pub get'].join('\n');
  assert.equal(guardRunsFirst(job(ACTION, named, GUARD_STEP)), false);
});

test('guardRunsFirst rejects a guard after a `run: |` flutter step (#790)', () => {
  const block = ['      - name: Build', '        run: |', '          flutter pub get', '          flutter build apk --debug'].join('\n');
  assert.equal(guardRunsFirst(job(ACTION, block, GUARD_STEP)), false);
});

test('guardRunsFirst accepts the guard ahead of named and block steps (#790)', () => {
  const block = ['      - name: Build', '        run: |', '          flutter build apk --debug'].join('\n');
  assert.equal(guardRunsFirst(job(GUARD_STEP, ACTION, block)), true);
});

test('guardRunsFirst fails closed when the Flutter SDK step is missing (#790)', () => {
  assert.equal(guardRunsFirst(job(GUARD_STEP, '      - run: flutter pub get')), false);
});

/** The guard step's shell script, exactly as app.yml carries it. */
function guardScript() {
  const lines = androidJob(appYml).split('\n');
  const at = lines.findIndex((l) => l.includes(GUARD));
  assert.notEqual(at, -1, 'guard step not found');
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  assert.notEqual(run, -1, 'guard step has no `run: |` block');
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length >= indent); i++) {
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

/** Run the guard in a scratch checkout whose gradle.properties holds `props`. */
function runGuard(script, props) {
  const dir = mkdtempSync(join(tmpdir(), 'kgp-guard-'));
  try {
    mkdirSync(join(dir, 'android'));
    writeFileSync(join(dir, 'android', 'gradle.properties'), props);
    return spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const INTACT = 'org.gradle.jvmargs=-Xmx4G\nandroid.builtInKotlin=false\nandroid.newDsl=false\n';
const DELETED = 'org.gradle.jvmargs=-Xmx4G\n';
const COMMENTED = 'org.gradle.jvmargs=-Xmx4G\n#android.builtInKotlin=false\n#android.newDsl=false\n';

test('the guard matches whole lines (-qxF), not substrings (#790)', () => {
  // Pure text pin, so it holds where no usable bash exists. A `#`-commented flag
  // is absent to Flutter's line-anchored migrators, yet contains the flag text.
  assert.match(guardScript(), /grep -qxF "\$flag"/);
});

// Behavioural check. It needs a bash that can run the script; a positive control
// (the intact file must exit 0) decides that, so a missing or WSL bash skips
// instead of reporting a false red. The -qxF text pin above holds either way.
const bashUsable = runGuard(guardScript(), INTACT).status === 0;
const skip = bashUsable ? false : 'no usable bash on this runner';

test('guard script: intact flags exit 0', { skip }, () => {
  assert.equal(runGuard(guardScript(), INTACT).status, 0);
});

test('guard script: both flag lines deleted exit 1', { skip }, () => {
  assert.equal(runGuard(guardScript(), DELETED).status, 1);
});

test('guard script: both flags commented out exit 1 (#790)', { skip }, () => {
  assert.equal(runGuard(guardScript(), COMMENTED).status, 1);
});
