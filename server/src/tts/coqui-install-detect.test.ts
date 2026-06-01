/* Node-side Coqui install detector. Pins the boot-time filesystem probe used by
   the in-app installer's detect/recheck. TTS_HOME steers both the lib's
   user-data dir and this probe, so the test points it at a temp dir and seeds
   `$TTS_HOME/tts/tts_models--…--xtts_v2/model.pth`. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coquiWeightsPresent,
  coquiPackageInstalled,
  detectCoquiInstallStateOnDisk,
} from './coqui-install-detect.js';

const XTTS_DIR_NAME = 'tts_models--multilingual--multi-dataset--xtts_v2';

let ttsHome: string;
let repoRoot: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  ttsHome = mkdtempSync(join(tmpdir(), 'coqui-home-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'coqui-repo-'));
  process.env.TTS_HOME = ttsHome;
  delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
  rmSync(ttsHome, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

/* The lib resolves the model dir to get_user_data_dir("tts")/<name> =
   $TTS_HOME/tts/<name>. */
function seedWeights(filename: string): void {
  const dir = join(ttsHome, 'tts', XTTS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), Buffer.alloc(16));
}

function seedVenvPackage(): void {
  mkdirSync(join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'TTS'), {
    recursive: true,
  });
}

describe('coquiWeightsPresent', () => {
  it('is true when model.pth is present in the XTTS v2 dir', () => {
    seedWeights('model.pth');
    expect(coquiWeightsPresent()).toBe(true);
  });

  it('is false when only config.json (no model blob) is present', () => {
    seedWeights('config.json');
    expect(coquiWeightsPresent()).toBe(false);
  });

  it('is false on an empty cache', () => {
    expect(coquiWeightsPresent()).toBe(false);
  });
});

describe('coquiPackageInstalled', () => {
  it('is true when the TTS package is in the sidecar venv site-packages', () => {
    seedVenvPackage();
    expect(coquiPackageInstalled(repoRoot)).toBe(true);
  });

  it('is false when the venv has no TTS package', () => {
    expect(coquiPackageInstalled(repoRoot)).toBe(false);
  });
});

describe('detectCoquiInstallStateOnDisk', () => {
  it("→ 'not-installed' when the package is absent", () => {
    seedWeights('model.pth'); // weights but no package
    expect(detectCoquiInstallStateOnDisk(repoRoot)).toBe('not-installed');
  });

  it("→ 'weights-missing' when the package is present but weights are not", () => {
    seedVenvPackage();
    expect(detectCoquiInstallStateOnDisk(repoRoot)).toBe('weights-missing');
  });

  it("→ 'ready' when both package and weights are present", () => {
    seedVenvPackage();
    seedWeights('model.pth');
    expect(detectCoquiInstallStateOnDisk(repoRoot)).toBe('ready');
  });
});
