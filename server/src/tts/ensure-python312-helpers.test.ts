/* ensure-python312.mjs is side-effect-guarded (runs only when invoked
   directly), so importing it here is inert. */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { decidePythonAcquisition } from '../../tts-sidecar/scripts/ensure-python312.mjs';

describe('decidePythonAcquisition', () => {
  it('found on PATH → use it', () => {
    expect(decidePythonAcquisition({ found: 'py -3.12', platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'use', cmd: 'py -3.12' });
  });
  it('absent + winget (Windows) → auto-install', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'auto-install', method: 'winget' });
  });
  it('absent + no winget → guided fallback', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'official-installer' });
  });
  it('absent on Linux → guided (never silent sudo)', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'linux', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'package-manager' });
  });
});
