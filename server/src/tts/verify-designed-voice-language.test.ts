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

function char(id: string, designedName?: string, voiceUuid?: string): CastCharacter {
  return {
    id,
    name: id,
    ttsEngine: 'qwen',
    ...(voiceUuid !== undefined ? { voiceUuid } : {}),
    overrideTtsVoices: designedName ? { qwen: { name: designedName } } : {},
  };
}

describe('clearMismatchedDesignedVoices', () => {
  it('clears a designed Qwen voice whose manifest language ≠ the book language', async () => {
    /* Character id 'hero-mismatch' → storage key 'qwen-hero-mismatch'. */
    writeManifest('qwen-hero-mismatch', 'English'); // designed under an English book
    const cast = [char('hero-mismatch', 'Wren')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('keeps a designed voice whose manifest language matches', async () => {
    /* Character id 'hero-match' → storage key 'qwen-hero-match'. */
    writeManifest('qwen-hero-match', 'Russian');
    const cast = [char('hero-match', 'Remy')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen?.name).toBe('Remy');
  });

  it('clears when the manifest file is missing entirely', async () => {
    /* No manifest written for 'hero-missing' → missing → cleared. */
    const cast = [char('hero-missing', 'no-such-voice')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('leaves undesigned characters untouched', async () => {
    const cast = [char('narrator')]; // no qwen override
    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');
    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });

  /* srv-43 regression: the manifest lives at qwen-<uuid>.json, not qwen-<name>.json */
  it('srv-43: uuid-backed voice with matching-language manifest at qwen-<uuid>.json is NOT cleared', async () => {
    const uuid = 'abc123xyz';
    /* Manifest on disk is keyed by uuid (qwen-<uuid>.json), NOT by the human name. */
    writeManifest(`qwen-${uuid}`, 'Russian');
    /* The character has both a voiceUuid AND a qwen.name (human label). */
    const cast = [char('hero', 'wren', uuid)];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    expect(cast[0].overrideTtsVoices?.qwen?.name).toBe('wren');
  });

  it('srv-43: discarded-preview character (voiceUuid, no qwen override) is skipped', async () => {
    /* A character that carries voiceUuid but never had an override committed —
       the guard (`if (!designedName) continue`) must skip it without error. */
    const cast = [char('hero', undefined /* no name */, 'orphan-uuid')];

    await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');

    /* No crash, and the non-existent qwen slot remains absent. */
    expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined();
  });
});
