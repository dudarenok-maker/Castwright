import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { castSlice } from '../store/cast-slice';
import { EmotionVariantDesigner } from './emotion-variant-designer';

const designQwenVoice = vi.fn();
vi.mock('../lib/api', () => ({ api: { designQwenVoice: (...a: unknown[]) => designQwenVoice(...a) } }));

function makeStore(characters: any[]) {
  return configureStore({
    reducer: { cast: castSlice.reducer },
    preloadedState: { cast: { ...castSlice.getInitialState(), characters } },
  });
}

beforeEach(() => {
  designQwenVoice.mockReset();
  designQwenVoice.mockResolvedValue({ voiceId: 'qwen-sophie__angry' });
});

describe('fs-25 — EmotionVariantDesigner', () => {
  const baseChar = { id: 'sophie', name: 'Sophie', overrideTtsVoices: { qwen: { name: 'qwen-sophie' } } };

  it('is gated: with no base voice it shows the "design the main voice first" hint', () => {
    const store = makeStore([{ id: 'sophie', name: 'Sophie' }]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          characterId="sophie"
          sampleVoiceId="v1"
          modelKey="qwen3-tts-0.6b"
          baseDesigned={false}
          variants={undefined}
        />
      </Provider>,
    );
    expect(screen.getByTestId('variant-gate-hint')).toBeTruthy();
    expect(screen.queryByTestId('variant-designer')).toBeNull();
  });

  it('designs a variant and records it in redux so the badge can update live', async () => {
    const store = makeStore([baseChar]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          characterId="sophie"
          sampleVoiceId="v1"
          modelKey="qwen3-tts-0.6b"
          baseDesigned
          variants={undefined}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByLabelText('Design the Angry variant'));
    await waitFor(() =>
      expect(
        (store.getState().cast.characters[0] as unknown as typeof baseChar).overrideTtsVoices.qwen,
      ).toMatchObject({ variants: { angry: { name: 'qwen-sophie__angry' } } }),
    );
    // the api was called with the emotion + a variant-scoped sample id.
    expect(designQwenVoice).toHaveBeenCalledWith('b1', 'sophie', {
      sampleVoiceId: 'v1__angry',
      modelKey: 'qwen3-tts-0.6b',
      emotion: 'angry',
    });
  });

  it('shows "Designed" (not a Design button) for an already-designed variant', () => {
    const store = makeStore([baseChar]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          characterId="sophie"
          sampleVoiceId="v1"
          modelKey="qwen3-tts-0.6b"
          baseDesigned
          variants={{ whisper: { name: 'qwen-sophie__whisper' } }}
        />
      </Provider>,
    );
    expect(screen.getByTestId('variant-done-whisper')).toBeTruthy();
    expect(screen.queryByLabelText('Design the Whisper variant')).toBeNull();
  });
});
