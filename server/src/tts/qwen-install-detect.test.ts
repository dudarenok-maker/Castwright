/* Node-side Qwen install detector (qwen-default phase 1). Pins the boot-time
   filesystem probe used to seed the conditional default before the sidecar
   /health is up. Mirrors the sidecar's _qwen_install_state contract. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qwenWeightsPresent,
  qwenPackageInstalled,
  detectQwenInstallStateOnDisk,
} from './qwen-install-detect.js';

const REPO_NAME = 'models--Qwen--Qwen3-TTS-12Hz-0.6B-Base';

let hubCache: string;
let repoRoot: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  hubCache = mkdtempSync(join(tmpdir(), 'qwen-hub-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'qwen-repo-'));
  process.env.HF_HUB_CACHE = hubCache;
  delete process.env.HF_HOME;
  delete process.env.QWEN_BASE_MODEL; // use the default repo id
});

afterEach(() => {
  rmSync(hubCache, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function seedWeights(filename: string): void {
  const snap = join(hubCache, REPO_NAME, 'snapshots', 'rev1');
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, filename), Buffer.alloc(16));
}

function seedVenvPackage(): void {
  mkdirSync(join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'qwen_tts'), {
    recursive: true,
  });
}

describe('qwenWeightsPresent', () => {
  it('is true when a real weight blob is in the Base snapshot', () => {
    seedWeights('model.safetensors');
    expect(qwenWeightsPresent()).toBe(true);
  });

  it('is false when only metadata (config.json) is present', () => {
    seedWeights('config.json');
    expect(qwenWeightsPresent()).toBe(false);
  });

  it('is false on an empty cache', () => {
    expect(qwenWeightsPresent()).toBe(false);
  });
});

describe('qwenPackageInstalled', () => {
  it('is true when qwen_tts is in the sidecar venv site-packages', () => {
    seedVenvPackage();
    expect(qwenPackageInstalled(repoRoot)).toBe(true);
  });

  it('is false when the venv has no qwen_tts', () => {
    expect(qwenPackageInstalled(repoRoot)).toBe(false);
  });
});

describe('detectQwenInstallStateOnDisk', () => {
  it("→ 'not-installed' when the package is absent", () => {
    seedWeights('model.safetensors'); // weights but no package
    expect(detectQwenInstallStateOnDisk(repoRoot)).toBe('not-installed');
  });

  it("→ 'weights-missing' when the package is present but weights are not", () => {
    seedVenvPackage();
    expect(detectQwenInstallStateOnDisk(repoRoot)).toBe('weights-missing');
  });

  it("→ 'ready' when both package and weights are present", () => {
    seedVenvPackage();
    seedWeights('model.safetensors');
    expect(detectQwenInstallStateOnDisk(repoRoot)).toBe('ready');
  });
});
