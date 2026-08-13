import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allKnobs } from './registry.js';
import { resolveKnob } from './resolver.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';
import { renderManagedBlock, BEGIN, END } from './env-example.js';

const REAL_ENV_EXAMPLE = fileURLToPath(new URL('../../.env.example', import.meta.url));

describe('.env.example managed block', () => {
  it('includes every non-prompt knob with its default', () => {
    const block = renderManagedBlock();
    expect(block.startsWith(BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(END)).toBe(true);
    expect(block).toContain('STAGE2_MIN_COVERAGE=');
    expect(block).toContain('GPU_RESERVE_MB=');
    // prompts have no env → must NOT appear
    expect(block).not.toContain('prompt.castDetection');
  });

  /* #2179 — every knob line ships COMMENTED (`# KEY=default`), not active
     (`KEY=default`), so a fresh server/.env produced by copying this file
     leaves every knob at source:'default', locked:false. Only the shipped
     value is documentation; nothing is applied until a deployer deliberately
     uncomments a line. */
  it('emits every knob line commented out, never active', () => {
    const block = renderManagedBlock();
    for (const k of allKnobs()) {
      if (k.isPrompt || !k.env) continue;
      const activeLine = new RegExp(`^${k.env}=`, 'm');
      const commentedLine = new RegExp(`^# ${k.env}=`, 'm');
      expect(block).not.toMatch(activeLine);
      expect(block).toMatch(commentedLine);
    }
  });

  it('keeps the help comment directly above each (now-commented) knob line', () => {
    const block = renderManagedBlock();
    const lines = block.split('\n');
    const gpuReserveIdx = lines.findIndex((l) => l === '# GPU_RESERVE_MB=500');
    expect(gpuReserveIdx).toBeGreaterThan(0);
    expect(lines[gpuReserveIdx - 1]).toMatch(/^# .+\[.*\]$/);
  });
});

/* #2179 acceptance criteria — round-trip the SHIPPED server/.env.example
   through the real env loader (`process.loadEnvFile`, the same Node API
   `server/src/load-env.ts` calls) and confirm `resolveKnob`'s `locked`
   contract still holds in both directions: the shipped file (all comments)
   locks nothing, and a deliberately uncommented line still locks. This is
   the property the whole issue exists to fix — it deserves its own
   integration-level check, not just an assertion on renderManagedBlock's
   string output. */
describe('.env.example round-trip through the real env loader (#2179)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetUserSettingsCache();
    // Defensive: strip every registered env var from this process's env
    // first, so a stray export on the dev/CI box can't make a "locks
    // nothing" assertion pass by accident.
    for (const k of allKnobs()) {
      if (k.env) delete process.env[k.env];
    }
  });

  afterEach(() => {
    /* Mutate process.env IN PLACE — never `process.env = {...}`. That
       wholesale reassignment replaces the native env binding with a plain
       object; `process.loadEnvFile()` keeps writing through the ORIGINAL
       native binding, so every loadEnvFile call in a later test would
       silently stop landing on whatever `process.env` now points to. This
       was caught live: the second test below read back `undefined` for a
       key its own loadEnvFile call had just "set", entirely because the
       first test's cleanup had reassigned process.env wholesale. */
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const k of Object.keys(originalEnv)) {
      process.env[k] = originalEnv[k];
    }
    _resetUserSettingsCache();
  });

  function writeTempEnv(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'castwright-env-example-'));
    const file = join(dir, '.env');
    writeFileSync(file, contents, 'utf8');
    return file;
  }

  it('a fresh copy of the shipped .env.example locks nothing — every env-backed knob stays source:"default", locked:false', () => {
    const shipped = readFileSync(REAL_ENV_EXAMPLE, 'utf8');
    process.loadEnvFile(writeTempEnv(shipped));

    for (const k of allKnobs()) {
      if (k.isPrompt || !k.env) continue;
      const state = resolveKnob(k);
      expect(state.source, `${k.env} unexpectedly resolved via ${state.source}`).toBe('default');
      expect(state.locked, `${k.env} unexpectedly locked`).toBe(false);
    }
  });

  it('uncommenting a single line restores source:"env", locked:true for that knob — and ONLY that knob', () => {
    const shipped = readFileSync(REAL_ENV_EXAMPLE, 'utf8');
    const uncommented = shipped.replace(/^# GPU_RESERVE_MB=500$/m, 'GPU_RESERVE_MB=777');
    // Sanity: the replace actually matched the shipped line shape — if
    // renderManagedBlock's format ever drifts, this fails loudly instead of
    // silently testing nothing.
    expect(uncommented).not.toBe(shipped);

    process.loadEnvFile(writeTempEnv(uncommented));

    const gpuKnob = allKnobs().find((k) => k.env === 'GPU_RESERVE_MB')!;
    const gpuState = resolveKnob(gpuKnob);
    expect(gpuState.source).toBe('env');
    expect(gpuState.locked).toBe(true);
    expect(gpuState.effective).toBe(777);

    // Every OTHER env-backed knob stays unlocked — uncommenting one line
    // must not accidentally activate its neighbours.
    for (const k of allKnobs()) {
      if (k.isPrompt || !k.env || k.env === 'GPU_RESERVE_MB') continue;
      const state = resolveKnob(k);
      expect(state.source, `${k.env} unexpectedly resolved via ${state.source}`).toBe('default');
      expect(state.locked, `${k.env} unexpectedly locked`).toBe(false);
    }
  });
});

/* #2179 — pinokio-scripts/lib/write-env.js's WORKSPACE_DIR replace
   (`/^WORKSPACE_DIR=.*$/m`) only matches an ACTIVE line. WORKSPACE_DIR is
   hand-authored above the generated block and was deliberately NOT swept
   into it — a future emitter change that did sweep it would silently break
   the replace (the regex simply wouldn't match `# WORKSPACE_DIR=...`),
   which means every Pinokio install would inherit the literal placeholder
   `../audiobook-workspace` instead of the real per-install path. Pinned
   here against the REAL shipped file, not a synthetic fixture. */
describe('server/.env.example: WORKSPACE_DIR stays an active, rewritable assignment (#2179)', () => {
  it('ships uncommented', () => {
    const shipped = readFileSync(REAL_ENV_EXAMPLE, 'utf8');
    expect(shipped).toMatch(/^WORKSPACE_DIR=/m);
    expect(shipped).not.toMatch(/^# WORKSPACE_DIR=/m);
  });
});
