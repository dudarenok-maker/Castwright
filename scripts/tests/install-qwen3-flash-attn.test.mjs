// Tests for the opt-in FlashAttention-2 install gate in install-qwen3.mjs.
// Run via `npm run test:hooks` (node --test, no extra deps).
//
// The wheel/pip install itself can't be exercised here (needs a real venv,
// and on Linux a real CUDA Toolkit) — the testable seam is the pure
// platform/version/already-installed decision, plus the env-merge helper.
// Importing the installer module also asserts (implicitly) that it stays
// inert on import: if its main() ran here it would findVenvPython() ->
// process.exit(1) and kill this test process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFlashAttnInstall,
  flashAttnBuildEnv,
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

test('darwin → skip (no known FA2 path), never installs', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'darwin', pyTag: 'cp311' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /no pinned wheel/);
  assert.equal(r.url, undefined);
});

test('linux + nvcc available + not already importable → attempts pip install', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    nvccAvailable: true,
  });
  assert.equal(r.action, 'install-pip');
  assert.equal(r.package, 'flash-attn');
});

test('linux + no nvcc → skip with a CUDA-Toolkit-required reason, never installs', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    nvccAvailable: false,
  });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /nvcc/);
});

test('already importable → reports and defers to manual activation, on any platform/profile', () => {
  const cases = [
    { platform: 'win32', pyTag: 'cp311' },
    { platform: 'linux', pyTag: 'cp311' },
    { platform: 'darwin', pyTag: 'cp311' },
    { platform: 'linux', pyTag: 'cp311', profile: 'amd' },
  ];
  for (const opts of cases) {
    const r = resolveFlashAttnInstall({ enabled: true, alreadyImportable: true, ...opts });
    assert.equal(r.action, 'already-installed');
    assert.match(r.reason, /QWEN_ATTN_IMPL=flash_attention_2/);
    assert.equal(r.url, undefined);
    assert.equal(r.package, undefined);
  }
});

test('amd profile + not already importable → skip (no ROCm wheel)', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    profile: 'amd',
    alreadyImportable: false,
  });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /ROCm/);
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

test('flashAttnBuildEnv defaults MAX_JOBS to 4 when the operator has not set one', () => {
  const result = flashAttnBuildEnv({}, { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' });
  assert.equal(result.MAX_JOBS, '4');
  assert.equal(result.HF_HUB_DISABLE_SYMLINKS_WARNING, '1');
});

test('flashAttnBuildEnv honors an operator-set MAX_JOBS instead of overwriting it', () => {
  const result = flashAttnBuildEnv({ MAX_JOBS: '16' }, {});
  assert.equal(result.MAX_JOBS, '16');
});

test('flashAttnBuildEnv does not mutate the shared baseEnv object', () => {
  const baseEnv = { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  flashAttnBuildEnv({}, baseEnv);
  assert.deepEqual(baseEnv, { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' });
});
