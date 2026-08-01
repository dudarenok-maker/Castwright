/* Node-side Whisper install detector (srv-31). Pins the filesystem probe backing
   the admin-console installer's detect/recheck. Mirrors qwen-install-detect. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  whisperModelPresent,
  fasterWhisperInstalled,
  detectWhisperInstallStateOnDisk,
} from './whisper-install-detect.js';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';

const REPO_NAME = 'models--Systran--faster-whisper-base';

let hubCache: string;
let repoRoot: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  hubCache = mkdtempSync(join(tmpdir(), 'whisper-hub-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'whisper-repo-'));
  process.env.HF_HUB_CACHE = hubCache;
  delete process.env.HF_HOME;
  delete process.env.ASR_MODEL; // use the default `base`
});

afterEach(() => {
  rmSync(hubCache, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function seedModel(filename: string): void {
  const snap = join(hubCache, REPO_NAME, 'snapshots', 'rev1');
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, filename), Buffer.alloc(16));
}

function seedVenvPackage(): void {
  mkdirSync(
    join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'faster_whisper'),
    { recursive: true },
  );
}

describe('whisperModelPresent', () => {
  it('is true when the CTranslate2 model.bin is in the snapshot', () => {
    seedModel('model.bin');
    expect(whisperModelPresent()).toBe(true);
  });

  it('is false when only metadata (config.json) is present', () => {
    seedModel('config.json');
    expect(whisperModelPresent()).toBe(false);
  });

  it('is false on an empty cache', () => {
    expect(whisperModelPresent()).toBe(false);
  });

  it('resolves its default through the qa.asr.model REGISTRY OVERRIDE, not just env (PR #2008 review, Major 1)', () => {
    /* Before the fix, whisperModelPresent()'s default was a module-load-time
       `process.env.ASR_MODEL` const, so a registry override (set from
       Advanced Configuration, with no ASR_MODEL env var present) was
       invisible here — the probe kept checking 'base' regardless. */
    seedModel('model.bin'); // seeds Systran/faster-whisper-base
    _setUserSettingsCacheForTest({ configOverrides: { 'qa.asr.model': 'small' } });
    try {
      expect(whisperModelPresent()).toBe(false); // 'base' is present, 'small' isn't
    } finally {
      _resetUserSettingsCache();
    }
  });
});

describe('fasterWhisperInstalled', () => {
  it('is true when faster_whisper is in the sidecar venv site-packages', () => {
    seedVenvPackage();
    expect(fasterWhisperInstalled(repoRoot)).toBe(true);
  });

  it('is false when the venv has no faster_whisper', () => {
    expect(fasterWhisperInstalled(repoRoot)).toBe(false);
  });
});

describe('detectWhisperInstallStateOnDisk', () => {
  it("→ 'not-installed' when the package is absent", () => {
    seedModel('model.bin'); // model but no package
    expect(detectWhisperInstallStateOnDisk(repoRoot)).toBe('not-installed');
  });

  it("→ 'model-missing' when the package is present but the model is not", () => {
    seedVenvPackage();
    expect(detectWhisperInstallStateOnDisk(repoRoot)).toBe('model-missing');
  });

  it("→ 'ready' when both package and model are present", () => {
    seedVenvPackage();
    seedModel('model.bin');
    expect(detectWhisperInstallStateOnDisk(repoRoot)).toBe('ready');
  });

  it("→ 'model-missing' for an overridden qa.asr.model even though the DEFAULT base is ready (PR #2008 review, Major 1)", () => {
    seedVenvPackage();
    seedModel('model.bin'); // seeds Systran/faster-whisper-base only
    _setUserSettingsCacheForTest({ configOverrides: { 'qa.asr.model': 'small' } });
    try {
      expect(detectWhisperInstallStateOnDisk(repoRoot)).toBe('model-missing');
    } finally {
      _resetUserSettingsCache();
    }
  });
});
