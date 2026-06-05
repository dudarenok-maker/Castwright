/* fs-2 / fs-32c — shared cross-language designed-voice re-check. Pins the
   clearing contract used by BOTH the generate path and the fs-26 splice
   re-record path: a reused designed Qwen voice whose baked manifest language ≠
   the book's is cleared (so the forbidKokoroFallback gate blocks it as
   undesigned); a matching-language voice is left intact. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CastCharacter } from './synthesise-chapter.js';

let workspaceRoot: string;
let qwenVoicesDir: string;
let clearMismatchedDesignedVoices: typeof import('./verify-designed-voice-language.js').clearMismatchedDesignedVoices;

/* paths.ts captures WORKSPACE_DIR at module-load, and the module is cached for
   the whole file — so set the workspace ONCE before importing the helper and
   share the same qwen-voices dir across cases (unique voice names per case). */
beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voice-lang-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  qwenVoicesDir = join(workspaceRoot, 'voices', 'qwen');
  mkdirSync(qwenVoicesDir, { recursive: true });
  ({ clearMismatchedDesignedVoices } = await import('./verify-designed-voice-language.js'));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeManifest(name: string, language: string): void {
  writeFileSync(join(qwenVoicesDir, `${name}.json`), JSON.stringify({ language }));
}

function char(id: string, designedName?: string): CastCharacter {
  return {
    id,
    name: id,
    ttsEngine: 'qwen',
    overrideTtsVoices: designedName ? { qwen: { name: designedName } } : {},
  };
}

describe('clearMismatchedDesignedVoices', () => {
  it('clears a designed Qwen voice whose manifest language ≠ the book language', async () => {
    writeManifest('voice-en', 'English'); // designed under an English book
    const cast = [char('hero', 'voice-en')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('keeps a designed voice whose manifest language matches', async () => {
    writeManifest('voice-ru', 'Russian');
    const cast = [char('hero', 'voice-ru')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen?.name).toBe('voice-ru');
  });

  it('clears when the manifest file is missing entirely', async () => {
    const cast = [char('hero', 'no-such-voice')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('leaves undesigned characters untouched', async () => {
    const cast = [char('narrator')]; // no qwen override
    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');
    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });
});
