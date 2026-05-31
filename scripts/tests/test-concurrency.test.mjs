// Unit tests for the shared test-concurrency helpers. node:test (run via
// `npm run test:hooks`), no extra deps — matches the sibling hook test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lowConcurrency,
  frontendPoolCap,
  serverMaxForks,
} from '../test-concurrency.mjs';

test('lowConcurrency is false when unset', () => {
  assert.equal(lowConcurrency({}), false);
});

test('lowConcurrency is true for "1" and "true"', () => {
  assert.equal(lowConcurrency({ LOW_CONCURRENCY: '1' }), true);
  assert.equal(lowConcurrency({ LOW_CONCURRENCY: 'true' }), true);
});

test('lowConcurrency is false for other values', () => {
  assert.equal(lowConcurrency({ LOW_CONCURRENCY: '0' }), false);
});

test('frontendPoolCap is undefined when not low (preserves plan-45 default)', () => {
  assert.equal(frontendPoolCap({}, 16), undefined);
});

test('frontendPoolCap is half the cores when low', () => {
  assert.equal(frontendPoolCap({ LOW_CONCURRENCY: '1' }, 16), 8);
});

test('frontendPoolCap never drops below 1', () => {
  assert.equal(frontendPoolCap({ LOW_CONCURRENCY: '1' }, 1), 1);
});

test('serverMaxForks is 2 normally and 1 under low concurrency', () => {
  assert.equal(serverMaxForks({}), 2);
  assert.equal(serverMaxForks({ LOW_CONCURRENCY: '1' }), 1);
});
