/* fs-21 — bootstrap-venv.mjs helpers. The script's main() is
   guarded (runs only when invoked directly), so importing it here is inert. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { venvPythonPath, venvAlreadyBootstrapped } from '../../tts-sidecar/scripts/bootstrap-venv.mjs';

describe('bootstrap-venv helpers', () => {
  it('venvPythonPath: win32 → Scripts/python.exe, posix → bin/python', () => {
    expect(venvPythonPath('/v', 'win32')).toBe(join('/v', 'Scripts', 'python.exe'));
    expect(venvPythonPath('/v', 'linux')).toBe(join('/v', 'bin', 'python'));
  });
  it('venvAlreadyBootstrapped reflects the python binary presence', () => {
    const d = mkdtempSync(join(tmpdir(), 'v-'));
    expect(venvAlreadyBootstrapped(d, 'linux')).toBe(false);
    mkdirSync(join(d, 'bin'), { recursive: true });
    writeFileSync(join(d, 'bin', 'python'), '');
    expect(venvAlreadyBootstrapped(d, 'linux')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});
