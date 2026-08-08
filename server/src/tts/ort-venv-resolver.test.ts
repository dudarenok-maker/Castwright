import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSidecarVenvDir, sidecarVenvPresent } from '../diagnostics/venv.js';

const saved = process.env.SIDECAR_VENV_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SIDECAR_VENV_DIR;
  else process.env.SIDECAR_VENV_DIR = saved;
});

describe('resolveSidecarVenvDir', () => {
  it('defaults to the in-repo venv', () => {
    delete process.env.SIDECAR_VENV_DIR;
    expect(resolveSidecarVenvDir('/repo')).toBe(join('/repo', 'server', 'tts-sidecar', '.venv'));
  });

  it('honours SIDECAR_VENV_DIR (the versioned-install override)', () => {
    process.env.SIDECAR_VENV_DIR = '/opt/app/venv';
    expect(resolveSidecarVenvDir('/repo')).toBe('/opt/app/venv');
  });

  it('sidecarVenvPresent returns false when no venv exists at the resolved dir', () => {
    delete process.env.SIDECAR_VENV_DIR;
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
    expect(sidecarVenvPresent(repoRoot)).toBe(false);
  });

  it('sidecarVenvPresent returns true for the POSIX layout (bin/python)', () => {
    delete process.env.SIDECAR_VENV_DIR;
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
    const binDir = join(repoRoot, 'server', 'tts-sidecar', '.venv', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'python'), '');
    expect(sidecarVenvPresent(repoRoot)).toBe(true);
  });

  it('sidecarVenvPresent returns true for the Windows layout (Scripts/python.exe)', () => {
    delete process.env.SIDECAR_VENV_DIR;
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
    const scriptsDir = join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'python.exe'), '');
    expect(sidecarVenvPresent(repoRoot)).toBe(true);
  });
});
