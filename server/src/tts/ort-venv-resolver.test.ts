import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
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

  it('sidecarVenvPresent still works after the extraction', () => {
    delete process.env.SIDECAR_VENV_DIR;
    expect(typeof sidecarVenvPresent('/nope')).toBe('boolean');
  });
});
