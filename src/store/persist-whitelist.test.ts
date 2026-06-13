/* Guards the fix for the sticky analyzer-model bug: a per-run model pick
   (ui.selectedModel / selectedModelExplicit) must NOT be persisted, so it
   reverts to the saved account default on reload instead of silently
   shadowing analysisEngine forever. The TTS engine pick stays persisted —
   that stickiness is a separate, intentional preference. */

import { describe, expect, it } from 'vitest';
import { UI_PERSIST_WHITELIST } from './index';

describe('UI persist whitelist — analyzer model override is transient', () => {
  it('omits selectedModel and selectedModelExplicit so a per-run pick reverts on reload', () => {
    expect(UI_PERSIST_WHITELIST).not.toContain('selectedModel');
    expect(UI_PERSIST_WHITELIST).not.toContain('selectedModelExplicit');
  });

  it('still persists the TTS engine pick (separate, intentional stickiness)', () => {
    expect(UI_PERSIST_WHITELIST).toContain('ttsModelKey');
    expect(UI_PERSIST_WHITELIST).toContain('ttsModelKeyExplicit');
  });
});
