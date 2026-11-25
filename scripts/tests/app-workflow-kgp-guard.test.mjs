// scripts/tests/app-workflow-kgp-guard.test.mjs
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// app.yml's `android` job guards that the KGP escape-hatch flags stay in
// android/gradle.properties (ops-17 / #790). Flutter's migrators re-add a
// DELETED flag as false whenever `flutter pub get` or a build runs, so a guard
// placed after any of them passes on the very deletion it exists to catch.
// The guard step must therefore come before the first Flutter step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appYml = readNormalized(resolve(repoRoot, '.github', 'workflows', 'app.yml'));

const GUARD = 'name: Guard KGP escape-hatch flags';
// Any step that runs Flutter tooling, hence the migrators.
const FLUTTER_STEP = /^\s+- run: flutter (pub get|build|analyze|test)/m;

/** The `android` job's text, up to the next top-level job. */
function androidJob(text) {
  const start = text.indexOf('\n  android:\n');
  assert.notEqual(start, -1, 'app.yml has no android job');
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z][\w-]*:\n/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** True when the guard step precedes every Flutter step in the job. */
function guardRunsFirst(job) {
  const guardAt = job.indexOf(GUARD);
  const flutter = job.match(FLUTTER_STEP);
  return guardAt !== -1 && flutter !== null && guardAt < flutter.index;
}

test('app.yml runs the KGP flag guard before any flutter step (#790)', () => {
  assert.ok(guardRunsFirst(androidJob(appYml)), 'move the guard above `flutter pub get`');
});

test('guardRunsFirst rejects the old order, guard after the builds (#790)', () => {
  const old = ['  android:', '    steps:', '      - run: flutter pub get', `      - ${GUARD} (x)`, ''].join('\n');
  assert.equal(guardRunsFirst(old), false);
});
