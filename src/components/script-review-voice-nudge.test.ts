import { describe, it, expect, vi } from 'vitest';
import { maybePushVoiceNudge } from './script-review-diff';
import { QWEN_MODEL_KEY } from '../lib/tts-voice-mapping';

describe('maybePushVoiceNudge', () => {
  it('pushes a nudge on a qwen project with the right payload + dedupeKey', () => {
    const dispatch = vi.fn();
    maybePushVoiceNudge(dispatch, {
      ttsModelKey: 'qwen3-tts-0.6b',
      startBookId: 'b1',
      createdCharacters: [{ id: 'mara', name: 'Mara' }],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0];
    expect(action.type).toBe('notifications/pushToast');
    expect(action.payload.dedupeKey).toBe('off-roster-voice-nudge:b1');
    // modelKey is the constant sampleModelKeyForEngine('qwen', …) substitutes,
    // NOT an echo of the input — assert against the constant so a future
    // "fix" that echoes the input fails this test.
    expect(action.payload.nudge).toEqual({
      bookId: 'b1',
      characterIds: ['mara'],
      modelKey: QWEN_MODEL_KEY,
      names: ['Mara'],
    });
  });

  it('does nothing on a preset-engine (kokoro) project', () => {
    const dispatch = vi.fn();
    maybePushVoiceNudge(dispatch, {
      ttsModelKey: 'kokoro-v1',
      startBookId: 'b1',
      createdCharacters: [{ id: 'mara', name: 'Mara' }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when no characters were created', () => {
    const dispatch = vi.fn();
    maybePushVoiceNudge(dispatch, {
      ttsModelKey: 'qwen3-tts-0.6b', startBookId: 'b1', createdCharacters: [],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
