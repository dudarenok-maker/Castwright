// The root package-lock.json's root-package entry must carry the same
// engines as package.json. #4443 raised the floor to >=24.16.0 without
// regenerating the lock, so the next `npm install` dirtied the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (name) => JSON.parse(readFileSync(resolve(repoRoot, name), 'utf8'));

test('root package-lock.json engines match package.json engines', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
});
