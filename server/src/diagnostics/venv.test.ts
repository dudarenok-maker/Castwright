import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarVenvPresent } from './venv.js';

describe('sidecarVenvPresent', () => {
  it('false when the venv python is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    expect(sidecarVenvPresent(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('true when a venv python exists under either layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    mkdirSync(join(root, 'server', 'tts-sidecar', '.venv', 'bin'), { recursive: true });
    writeFileSync(join(root, 'server', 'tts-sidecar', '.venv', 'bin', 'python'), '');
    expect(sidecarVenvPresent(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
