import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

   #2052 widened this from a single-file guard to a directory-wide sweep of
   `gpu/`. It was originally scoped to THIS file alone because
   `gpu/sidecar-vram-sample.ts` carried a pre-existing, out-of-scope violation
   (a dynamic `import('../routes/sidecar-health.js')` that didn't currently
   close a cycle, so madge's --circular report didn't flag it) that a
   directory-wide version would have tripped on. #2052 fixed that file (routed
   through `sidecar-health-gate.ts` instead), so the sweep can now cover every
   `.ts` source file directly under `gpu/` (excluding `.test.ts` files — a test
   file legitimately imports a route module to register a fake provider, e.g.
   this file's own dynamic `import('./sidecar-health-gate.js')` sibling in
   `sidecar-vram-sample.test.ts`). This is a static source scan, not an
   import-graph tool (madge isn't a project dependency) — it directly encodes
   the rule text. */
describe('gpu/*.ts never imports from routes/ (#2013 / #2052 layering guard)', () => {
  it('no gpu/*.ts source file has a literal-quoted static, dynamic, or type-only import from ../routes/ (residual gaps in the comment below)', () => {
    const gpuDir = dirname(fileURLToPath(import.meta.url));
    const sourceFiles = readdirSync(gpuDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(sourceFiles.length).toBeGreaterThan(0); // sanity: the sweep found files to check
    /* Independent review (PR #2048, finding F5) — the prior two-regex form
       used `['"]` only, so a dynamic `import(`../routes/...`)` (backtick
       template literal, no interpolation) sailed through undetected. The
       backtick variant of that same shape was simply unguarded, a hole worth
       closing on its own merits. Collapsed to ONE regex over the whole quote
       class (`'`, `"`, and backtick) instead of separately matching
       `from '...'` / `import('...')` shapes — a path preceded by EITHER
       keyword, in any of the three quote styles, now trips it.

       Residual (independent review, PR #2048, finding F5, follow-up) — this
       is a literal-string regex, not an import-graph tool, so it still stays
       silent on: string concatenation (`'../rou' + 'tes/'`), an interpolated
       template segment, a variable/constant holding the path, a backslash
       separator (`..\\routes\\`), a path reached via `../../routes/`, a
       no-trailing-slash `'../routes'`, and any re-export chained through an
       intermediate module — this guard reads only literal source text, file
       by file. It is fail-closed the other way too: the regex also fires on
       a COMMENT that happens to contain a backtick path like
       `` `../routes/x` `` — this repo's own idiom for citing a path in
       prose — so a maintainer documenting this very rule in a comment using
       that shape would trip a false positive. Today no `gpu/*.ts` source
       file's own comments write that shape, so the sweep currently passes,
       but that's incidental, not guaranteed by anything the regex enforces. */
    const offenders = sourceFiles.filter((f) => {
      const src = readFileSync(join(gpuDir, f), 'utf8');
      return /['"`]\.\.\/routes\//.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
