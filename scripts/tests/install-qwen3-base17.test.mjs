// install-qwen3-base17.test.mjs — pin that qwenPrefetchModels always includes
// the 1.7B-Base model, even when --skip-design suppresses VoiceDesign.
// The 1.7B-Base is needed for the anchored emotion-variant workflow (fs-55)
// regardless of whether the user wants to design voices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenPrefetchModels } from '../../server/tts-sidecar/scripts/install-qwen3.mjs';

test('1.7B-Base prefetched even with --skip-design (needed for variant minting)', () => {
  const a = qwenPrefetchModels({ skipDesign: false });
  assert.ok(a.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'));
  assert.ok(a.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
  const b = qwenPrefetchModels({ skipDesign: true });
  assert.ok(b.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'));
  assert.ok(!b.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
});
