/* ops-7 — install-qwen3.mjs FA2-wheel integrity helpers. The script's main() is
   guarded (runs only when invoked directly), so importing it here is inert. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { flashAttnWheelPin, sha256File, resolveFlashAttnInstall } from '../../tts-sidecar/scripts/install-qwen3.mjs';

describe('sha256File', () => {
  it('hashes a file to its lowercased hex digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sha-'));
    try {
      const p = join(dir, 'x.bin');
      writeFileSync(p, Buffer.from('hello'));
      /* sha256("hello") — known vector. */
      expect(sha256File(p)).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flashAttnWheelPin', () => {
  it('reads the committed manifest (currently UNPINNED → null)', () => {
    /* The FA2 wheel ships unpinned until blessed on a box that has it, so the
       pin reader returns null and install-qwen3 warns + proceeds rather than
       failing. When a hash is blessed in model-hashes.json this flips to the
       digest and the integrity gate activates. */
    expect(flashAttnWheelPin()).toBeNull();
  });
});

describe('resolveFlashAttnInstall (AMD-aware gate)', () => {
  // FlashAttention-2 is an NVIDIA-only accelerator; SDPA is the default attention
  // impl everywhere it isn't installed. The AMD skip is checked FIRST so an
  // AMD-Windows box never tries to install the NVIDIA/CUDA FA2 wheel.
  it('skips on AMD — no ROCm FA2 wheel (SDPA is the default)', () => {
    const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp311', profile: 'amd' });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/ROCm|AMD|SDPA/i);
  });
  it('skips when not requested', () => {
    expect(
      resolveFlashAttnInstall({ enabled: false, platform: 'win32', pyTag: 'cp311', profile: 'nvidia' }).action,
    ).toBe('skip');
  });
  it('skips off-Windows (no pinned wheel)', () => {
    expect(
      resolveFlashAttnInstall({ enabled: true, platform: 'linux', pyTag: 'cp311', profile: 'nvidia' }).action,
    ).toBe('skip');
  });
  // The pinned wheel is cp311 + torch2.6/cu124. On the cp312 venv it skips →
  // Qwen runs on SDPA. A matched cp312/torch2.8 wheel is a separate owed
  // NVIDIA-perf follow-up; we don't point install at a mismatched wheel.
  it('skips on a non-cp311 venv (pinned wheel is cp311-only → SDPA on 3.12)', () => {
    expect(
      resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp312', profile: 'nvidia' }).action,
    ).toBe('skip');
  });
  it('installs on the matched NVIDIA win32 + cp311 stack', () => {
    const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp311', profile: 'nvidia' });
    expect(r.action).toBe('install');
    expect(r.url).toMatch(/flash_attn.*cp311.*win_amd64\.whl/);
  });
});
