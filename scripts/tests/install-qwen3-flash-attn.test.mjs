// Tests for the opt-in FlashAttention-2 wheel gate in install-qwen3.mjs.
// Run via `npm run test:hooks` (node --test, no extra deps).
//
// The wheel itself can't be exercised here (Windows + CUDA only) — the testable
// seam is the pure platform/version decision. Importing the installer module
// also asserts (implicitly) that it stays inert on import: if its main() ran
// here it would findVenvPython() -> process.exit(1) and kill this test process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFlashAttnInstall,
  FLASH_ATTN_WHEEL_URL,
} from '../../server/tts-sidecar/scripts/install-qwen3.mjs';

test('win32 + cp311 + enabled → installs the pinned wheel', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp311' });
  assert.equal(r.action, 'install');
  assert.equal(r.url, FLASH_ATTN_WHEEL_URL);
});

test('pinned wheel targets exactly cp311 / torch2.6 / cu124 / win_amd64', () => {
  // Guards against an accidental URL edit drifting off our installed stack.
  assert.match(FLASH_ATTN_WHEEL_URL, /cu124torch2\.6\.0/);
  assert.match(FLASH_ATTN_WHEEL_URL, /cp311-cp311-win_amd64\.whl$/);
});

test('non-Windows → skip (SDPA remains the default), never installs', () => {
  for (const platform of ['darwin', 'linux']) {
    const r = resolveFlashAttnInstall({ enabled: true, platform, pyTag: 'cp311' });
    assert.equal(r.action, 'skip');
    assert.match(r.reason, /no pinned wheel/);
    assert.equal(r.url, undefined);
  }
});

test('wrong Python minor → skip with a cp311-only reason', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp312' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /cp311-only/);
  assert.match(r.reason, /cp312/);
});

test('not opted in → silent skip, no install', () => {
  const r = resolveFlashAttnInstall({ enabled: false, platform: 'win32', pyTag: 'cp311' });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'not requested');
});
