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
  const run = (
    characters: Character[],
    ttsModelKey: string,
    opts: { bookId?: string; language?: string } = {},
  ) => {
    const dispatch = vi.fn();
    const bookId = opts.bookId ?? 'b1';
    const getState = () =>
      ({
        cast: { characters },
        ui: { ttsModelKey, stage: { kind: 'ready', bookId } },
        voices: { voices: [] },
        library: { books: [{ bookId, language: opts.language ?? 'en' }] },
      }) as unknown as RootState;
    startGenerationFlow()(dispatch, getState);
    return dispatch;
  };

  it('opens the tier prompt for a fully-designed Qwen book', () => {
    const dispatch = run(
      [char({ ttsEngine: 'qwen', lines: 5, overrideTtsVoices: { qwen: { name: 'v1' } } })],
      'qwen3-tts-0.6b',
    );
    expect(dispatch).toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });

  it('starts immediately for a non-Qwen book (no tier choice to make)', () => {
    const dispatch = run([char({ ttsEngine: 'kokoro' })], 'kokoro-v1');
    expect(dispatch).toHaveBeenCalledWith(uiActions.requestStartGeneration());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
  });

  it('opens the voice-readiness gate for a speaking undesigned Qwen character', () => {
    const dispatch = run([char({ ttsEngine: 'qwen', lines: 5 })], 'qwen3-tts-0.6b');
    expect(dispatch).toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());
  });

  it('skips the gate and opens the tier prompt when only a 0-line character is undesigned', () => {
    const dispatch = run([char({ ttsEngine: 'qwen', lines: 0 })], 'qwen3-tts-0.6b');
    expect(dispatch).toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });

  it('opens the gate for a non-English book with an undesigned speaking Qwen character', () => {
    const dispatch = run([char({ ttsEngine: 'qwen', lines: 5 })], 'qwen3-tts-0.6b', {
      language: 'ru',
    });
    expect(dispatch).toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });
});
