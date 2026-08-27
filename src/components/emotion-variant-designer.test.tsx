import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { castSlice } from '../store/cast-slice';
import { EmotionVariantDesigner } from './emotion-variant-designer';

const designQwenVoice = vi.fn();
const removeQwenVariant = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    designQwenVoice: (...a: unknown[]) => designQwenVoice(...a),
    removeQwenVariant: (...a: unknown[]) => removeQwenVariant(...a),
  },
}));

function makeStore(characters: any[]) {
  return configureStore({
    reducer: { cast: castSlice.reducer },
    preloadedState: { cast: { ...castSlice.getInitialState(), characters } },
  });
}

beforeEach(() => {
  designQwenVoice.mockReset();
  designQwenVoice.mockResolvedValue({
    voiceId: 'qwen-wren__angry',
    previewUrl: '/audio/voices/wren__angry.mp3',
  });
  removeQwenVariant.mockReset();
  removeQwenVariant.mockResolvedValue(undefined);
});

describe('fs-25 — EmotionVariantDesigner', () => {
  const baseChar = { id: 'wren', name: 'Wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } };

  it('is gated: with no base voice it shows the "design the main voice first" hint', () => {
    const store = makeStore([{ id: 'wren', name: 'Wren' }]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          character={{ id: 'wren', name: 'Wren', attributes: [] } as never}
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
          character={{ id: 'wren', name: 'Wren', attributes: [] } as never}
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
      ).toMatchObject({ variants: { angry: { name: 'qwen-wren__angry' } } }),
    );
    // the api was called with the emotion + a variant-scoped sample id.
    expect(designQwenVoice).toHaveBeenCalledWith('b1', 'wren', {
      sampleVoiceId: 'v1__angry',
      modelKey: 'qwen3-tts-0.6b',
      emotion: 'angry',
    });
    // a Play button for the just-designed variant's audition appears (preview
    // without a full generation run).
    await waitFor(() => expect(screen.getByTestId('variant-play-angry')).toBeTruthy());
  });

  /* #1954 — a cloned voice cannot carry emotion variants: the server refuses
     with 409 `clone_protected`, so the UI must never offer the action. Derived
     from the character itself (not a prop) so no render site can forget it —
     the whole defect was a gate present on one branch and absent on another. */
  describe('#1954 — cloned voices', () => {
    const clonedOnQwen = {
      id: 'lyra',
      name: 'Lyra',
      attributes: [],
      overrideTtsVoices: {
        qwen: { name: 'qwen-lyra-lib-uuid', libraryUuid: 'lyra-lib-uuid', provenance: 'cloned' },
      },
    };

    it('replaces the designer with an actionable hint for a qwen-cloned character', () => {
      const store = makeStore([clonedOnQwen]);
      render(
        <Provider store={store}>
          <EmotionVariantDesigner
            bookId="b1"
            character={clonedOnQwen as never}
            sampleVoiceId="v1"
            modelKey="qwen3-tts-0.6b"
            baseDesigned
            variants={undefined}
          />
        </Provider>,
      );

      const hint = screen.getByTestId('variant-cloned-hint');
      expect(hint.textContent).toMatch(/cloned voice/i);
      expect(hint.textContent).toMatch(/designed voice/i);
      /* No controls at all — not merely disabled ones. `baseDesigned` is true
         here (a cloned slot carries a name), which is exactly why the old
         `!baseDesigned`-only gate let this through. */
      expect(screen.queryByTestId('variant-designer')).toBeNull();
      expect(screen.queryByLabelText('Design the Angry variant')).toBeNull();
    });

    it('also gates a character cloned on COQUI (matches the server-side whole-character test)', () => {
      const clonedOnCoqui = {
        id: 'zara',
        name: 'Zara',
        attributes: [],
        overrideTtsVoices: {
          qwen: { name: 'qwen-v_zara' },
          coqui: { name: 'xtts-zara-uuid', libraryUuid: 'zara-uuid', provenance: 'cloned' },
        },
      };
      const store = makeStore([clonedOnCoqui]);
      render(
        <Provider store={store}>
          <EmotionVariantDesigner
            bookId="b1"
            character={clonedOnCoqui as never}
            sampleVoiceId="v1"
            modelKey="qwen3-tts-0.6b"
            baseDesigned
            variants={undefined}
          />
        </Provider>,
      );
      expect(screen.getByTestId('variant-cloned-hint')).toBeTruthy();
      expect(screen.queryByTestId('variant-designer')).toBeNull();
    });

    it('does not gate a plain DESIGNED voice-library assignment', () => {
      /* Guard against over-refusing: `provenance: 'designed'` is not a clone,
         and its variant flow is untouched by this fix. */
      const designedFromLibrary = {
        id: 'wren',
        name: 'Wren',
        attributes: [],
        overrideTtsVoices: {
          qwen: { name: 'qwen-wren', libraryUuid: 'wren-lib', provenance: 'designed' },
        },
      };
      const store = makeStore([designedFromLibrary]);
      render(
        <Provider store={store}>
          <EmotionVariantDesigner
            bookId="b1"
            character={designedFromLibrary as never}
            sampleVoiceId="v1"
            modelKey="qwen3-tts-0.6b"
            baseDesigned
            variants={undefined}
          />
        </Provider>,
      );
      expect(screen.queryByTestId('variant-cloned-hint')).toBeNull();
      expect(screen.getByTestId('variant-designer')).toBeTruthy();
    });

    it('replaces the designer with an actionable hint when clonedElsewhereInSeries is true, even with no book-local clone', () => {
      const clonedElsewhere = { id: 'lyra', name: 'Lyra', attributes: [], clonedElsewhereInSeries: true };
      const store = makeStore([clonedElsewhere]);
      render(
        <Provider store={store}>
          <EmotionVariantDesigner
            bookId="b1"
            character={clonedElsewhere as never}
            sampleVoiceId="v1"
            modelKey="qwen3-tts-0.6b"
            baseDesigned
            variants={undefined}
          />
        </Provider>,
      );
      const hint = screen.getByTestId('variant-cloned-hint');
      expect(hint.textContent).toMatch(/cloned voice/i);
      expect(screen.queryByTestId('variant-designer')).toBeNull();
    });
  });

  it('shows "Designed" (not a Design button) for an already-designed variant', () => {
    const store = makeStore([baseChar]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          character={{ id: 'wren', name: 'Wren', attributes: [] } as never}
          sampleVoiceId="v1"
          modelKey="qwen3-tts-0.6b"
          baseDesigned
          variants={{ whisper: { name: 'qwen-wren__whisper' } }}
        />
      </Provider>,
    );
    expect(screen.getByTestId('variant-done-whisper')).toBeTruthy();
    expect(screen.queryByLabelText('Design the Whisper variant')).toBeNull();
  });

  it('fs-34 — removing a designed variant calls the API and drops it from redux', async () => {
    const store = makeStore([
      {
        ...baseChar,
        overrideTtsVoices: { qwen: { name: 'qwen-wren', variants: { whisper: { name: 'qwen-wren__whisper' } } } },
      },
    ]);
    render(
      <Provider store={store}>
        <EmotionVariantDesigner
          bookId="b1"
          character={{ id: 'wren', name: 'Wren', attributes: [] } as never}
          sampleVoiceId="v1"
          modelKey="qwen3-tts-0.6b"
          baseDesigned
          variants={{ whisper: { name: 'qwen-wren__whisper' } }}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByLabelText('Remove the Whisper variant'));
    expect(removeQwenVariant).toHaveBeenCalledWith('b1', 'wren', 'whisper');
    await waitFor(() => {
      const qwen = (store.getState().cast.characters[0] as unknown as typeof baseChar)
        .overrideTtsVoices.qwen as { variants?: unknown };
      expect(qwen.variants).toBeUndefined();
    });
  });
});
