/* fs-33 read-path guard — locks the corrected assumption behind the whole
   feature: a per-quote `emotion` written into manuscript-edits.json (the
   post-fold list the frontend persists) survives `rebuildCacheFromEdits` (run
   by generation.ts before synth) and reaches `pickEmotionVariantVoice`, which
   selects the designed Qwen variant.

   If this test ever goes red, detected/manual emotions would silently NOT
   reach synth — exactly the bug the plan's read-path investigation caught. */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildCacheFromEdits } from './analysis-cache-rebuild.js';
import { loadAnalysisCache } from './analysis-cache.js';
import { pickEmotionVariantVoice } from '../tts/voice-mapping.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '..', '..', 'handoff', 'cache');

const manuscriptId = `m_emotion_readpath_${process.pid}`;

afterEach(() => {
  rmSync(join(CACHE_DIR, `${manuscriptId}.json`), { force: true });
});

describe('fs-33 — emotion survives the edits→cache→synth read path', () => {
  it('an emotion in manuscript-edits.json reaches the cache and selects the Qwen variant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-readpath-'));
    const editsPath = join(dir, 'manuscript-edits.json');
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'The room was quiet.' },
          { id: 2, chapterId: 1, characterId: 'wren', text: '“Get down!”', emotion: 'angry' },
        ],
      }),
    );

    try {
      await rebuildCacheFromEdits(manuscriptId, editsPath);
      const cache = await loadAnalysisCache(manuscriptId);
      const ch1 = cache.chapters[1];
      const tagged = ch1.find((s) => s.id === 2);
      // The emotion survived the rebuild (it would be lost if synth read only
      // a cache the rebuild overwrote without carrying edits fields).
      expect(tagged?.emotion).toBe('angry');

      // And it selects the designed variant at synth time.
      const variants = { angry: { name: 'qwen-v_wren__angry' } };
      const picked = pickEmotionVariantVoice('qwen', variants, tagged?.emotion, 'qwen-v_wren');
      expect(picked).toBe('qwen-v_wren__angry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing variant falls back to the base voice (non-fatal)', () => {
    expect(pickEmotionVariantVoice('qwen', {}, 'angry', 'qwen-v_wren')).toBe('qwen-v_wren');
    expect(pickEmotionVariantVoice('qwen', undefined, 'sad', 'base')).toBe('base');
  });

  it('non-Qwen engines never read emotion (byte-identical to neutral)', () => {
    const variants = { angry: { name: 'should-not-be-used' } };
    expect(pickEmotionVariantVoice('kokoro', variants, 'angry', 'kokoro-base')).toBe('kokoro-base');
  });
});
