import { describe, it, expect, vi } from 'vitest';
import { castRendersOnQwen, startGenerationFlow } from './start-generation-flow';
import { uiActions } from './ui-slice';
import type { Character } from '../lib/types';
import type { RootState } from './index';

const char = (over: Partial<Character>): Character => ({ id: 'c', name: 'C', ...over }) as Character;

describe('castRendersOnQwen', () => {
  it('is true when a character explicitly renders on Qwen, even off a non-Qwen run default', () => {
    expect(castRendersOnQwen([char({ ttsEngine: 'qwen' })], 'kokoro-v1')).toBe(true);
  });

  it('is true when an engineless character falls to a Qwen run default', () => {
    expect(castRendersOnQwen([char({ ttsEngine: null })], 'qwen3-tts-0.6b')).toBe(true);
  });

  it('is false when no character resolves to Qwen', () => {
    expect(castRendersOnQwen([char({ ttsEngine: 'kokoro' }), char({ ttsEngine: null })], 'kokoro-v1')).toBe(
      false,
    );
  });
});

describe('startGenerationFlow thunk', () => {
  const run = (characters: Character[], ttsModelKey: string) => {
    const dispatch = vi.fn();
    const getState = () =>
      ({ cast: { characters }, ui: { ttsModelKey } }) as unknown as RootState;
    startGenerationFlow()(dispatch, getState);
    return dispatch;
  };

  it('opens the tier prompt for a Qwen book', () => {
    const dispatch = run([char({ ttsEngine: 'qwen' })], 'qwen3-tts-0.6b');
    expect(dispatch).toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());
  });

  it('starts immediately for a non-Qwen book (no tier choice to make)', () => {
    const dispatch = run([char({ ttsEngine: 'kokoro' })], 'kokoro-v1');
    expect(dispatch).toHaveBeenCalledWith(uiActions.requestStartGeneration());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
  });
});
