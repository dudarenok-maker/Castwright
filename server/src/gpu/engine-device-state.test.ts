import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  setLastKnownEngineDevices,
  getLastKnownEngineDevice,
  _resetEngineDevicesForTests,
} from './engine-device-state.js';

describe('engine-device-state', () => {
  beforeEach(() => _resetEngineDevicesForTests());

  it('defaults every tracked engine to unknown', () => {
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('returns unknown for an engine outside {kokoro, coqui, qwen}', () => {
    expect(getLastKnownEngineDevice('gemini')).toBe('unknown');
  });

  it('records a reachable devices map per engine', () => {
    setLastKnownEngineDevices({ kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' });
    expect(getLastKnownEngineDevice('kokoro')).toBe('cpu');
    expect(getLastKnownEngineDevice('coqui')).toBe('cpu');
    expect(getLastKnownEngineDevice('qwen')).toBe('mps');
  });

  it('maps a null per-engine slot to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: null, qwen: 'cuda' });
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
  });

  it('a null devices map (old sidecar / malformed body) resets every engine to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(null);
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(undefined);
    expect(getLastKnownEngineDevice('kokoro')).toBe('cuda');
  });
});

/* #2013 — CLAUDE.md ("Conventions worth preserving") states that
   `server/src/gpu/` reaches a route module through a leaf gate, never an
   import — a static import, a dynamic `import()`, and even `import type` all
   close a cycle through `tts/index.ts`. This module violated exactly that
   rule (`import type { SidecarDeviceMap } from
   '../routes/sidecar-health.js'`), pushing `npx madge --circular --extensions
   ts server/src` to 16 cycles against the documented 15-cycle baseline. Fixed
   by relocating `SidecarDeviceFamily`/`SidecarDeviceMap` into this module
   (routes/sidecar-health.ts now imports them back, the allowed direction).

   Scoped to THIS file, not a directory-wide sweep of gpu/ — a repo-wide scan
   turned up a pre-existing, out-of-scope violation in
   gpu/sidecar-vram-sample.ts (a dynamic `import('../routes/sidecar-health.js')`
   that doesn't currently close a cycle, so madge's --circular report doesn't
   flag it) which a directory-wide version of this guard would trip on;
   fixing that is out of scope here (reported separately, not fixed). This is
   a static source scan, not an import-graph tool (madge isn't a project
   dependency) — it directly encodes the rule text for the one file this PR
   touches. */
describe('engine-device-state.ts never imports from routes/ (#2013 layering guard)', () => {
  it('this module has no static, dynamic, or type-only import from ../routes/', () => {
    const thisFile = fileURLToPath(import.meta.url).replace(/\.test\.ts$/, '.ts');
    const src = readFileSync(thisFile, 'utf8');
    /* Independent review (PR #2048, finding F5) — the prior two-regex form
       used `['"]` only, so a dynamic `import(`../routes/...`)` (backtick
       template literal, no interpolation) sailed through undetected. Proven
       live: `gpu/sidecar-vram-sample.ts:41` already reaches a route module
       this exact way, so backtick dynamic import is the established local
       idiom, not an exotic case. Collapsed to ONE regex over the whole
       quote class (`'`, `"`, and backtick) instead of separately matching
       `from '...'` / `import('...')` shapes — a path preceded by EITHER
       keyword, in any of the three quote styles, now trips it. */
    const hit = /['"`]\.\.\/routes\//.test(src);
    expect(hit).toBe(false);
  });
});
