// ops-35 (#1877) — pin the preflight's ffmpeg version parser.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
// NOT vitest, and NOT `npm run test:scripts` (that runs Pester).
//
// The corpus is shared with server/src/diagnostics/ffmpeg.test.ts so the CJS
// parser here and the TS one there can never drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/* Requiring the preflight must NOT run the check or exit the process — its
   side effects are guarded behind `require.main === module`. If that guard
   regresses, this import kills the whole node --test run. */
const { parseFfmpegVersion, isBelowFloor, readFfmpegFloor } = require('../preflight-ffmpeg.cjs');

const CASES = JSON.parse(readFileSync(join(HERE, 'fixtures/ffmpeg-version-cases.json'), 'utf8'));

test('preflight exports its parser helpers without executing', () => {
  assert.equal(typeof parseFfmpegVersion, 'function');
  assert.equal(typeof isBelowFloor, 'function');
  assert.equal(typeof readFfmpegFloor, 'function');
});

test('parseFfmpegVersion handles every known build-channel banner', () => {
  for (const c of CASES.parse) {
    assert.equal(parseFfmpegVersion(c.stdout), c.expected, c.name);
  }
});

test('parseFfmpegVersion tolerates non-string input', () => {
  assert.equal(parseFfmpegVersion(undefined), null);
  assert.equal(parseFfmpegVersion(null), null);
});

test('isBelowFloor compares numerically and fails open', () => {
  for (const c of CASES.belowFloor) {
    assert.equal(isBelowFloor(c.version, c.minimum), c.expected, c.name);
  }
});

test('readFfmpegFloor reads the declared floor from root package.json', () => {
  assert.equal(readFfmpegFloor(), '6.0');
});
