import { describe, it, expect, vi } from 'vitest';
import { castRendersOnQwen, startGenerationFlow } from './start-generation-flow';
import { uiActions } from './ui-slice';
import type { Character } from '../lib/types';
import type { VoiceLibraryEntry } from './voice-library-slice';
import type { AppDispatch, RootState } from './index';

const char = (over: Partial<Character>): Character => ({ id: 'c', name: 'C', ...over }) as Character;

const healthyEntry = (over: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry =>
  ({
    voiceUuid: 'v1',
    name: 'Voice One',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: { qwen: { status: 'ready', baseModel: 'x' } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    master: { transcript: 'a transcript', transcriptSource: 'whisper' } as VoiceLibraryEntry['master'],
    ...over,
  }) as VoiceLibraryEntry;

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
  /* `dispatch` is a bare mock (no real thunk middleware), so a `fetchVoiceLibrary()`
     dispatch (the only OTHER thunk this flow dispatches) arrives here as a plain
     function argument — every other dispatch this flow makes is a plain ui-slice
     action object. `opts.fetchFails` flips it to reject, exercising Decision 5's
     fail-open path without needing a real store. */
  const run = async (
    characters: Character[],
    ttsModelKey: string,
    opts: {
      bookId?: string;
      language?: string;
      libraryEntries?: VoiceLibraryEntry[];
      fetchFails?: boolean;
    } = {},
  ) => {
    const dispatch = vi.fn((action: unknown) => {
      if (typeof action === 'function') {
        return opts.fetchFails
          ? Promise.reject(new Error('fetch failed'))
          : Promise.resolve({ voices: opts.libraryEntries ?? [] });
      }
      return action;
    });
    const bookId = opts.bookId ?? 'b1';
    const getState = () =>
      ({
        cast: { characters },
        ui: { ttsModelKey, stage: { kind: 'ready', bookId } },
        voices: { voices: [] },
        voiceLibrary: { entries: opts.libraryEntries ?? [] },
        library: { books: [{ bookId, language: opts.language ?? 'en' }] },
      }) as unknown as RootState;
    await startGenerationFlow()(dispatch as unknown as AppDispatch, getState);
    return dispatch;
  };

  it('opens the tier prompt for a fully-designed Qwen book', async () => {
    const dispatch = await run(
      [char({ ttsEngine: 'qwen', lines: 5, overrideTtsVoices: { qwen: { name: 'v1' } } })],
      'qwen3-tts-0.6b',
    );
    expect(dispatch).toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });

  it('starts immediately for a non-Qwen book (no tier choice to make)', async () => {
    const dispatch = await run([char({ ttsEngine: 'kokoro' })], 'kokoro-v1');
    expect(dispatch).toHaveBeenCalledWith(uiActions.requestStartGeneration());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
  });

  it('opens the voice-readiness gate for a speaking undesigned Qwen character', async () => {
    const dispatch = await run([char({ ttsEngine: 'qwen', lines: 5 })], 'qwen3-tts-0.6b');
    expect(dispatch).toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());
  });

  it('skips the gate and opens the tier prompt when only a 0-line character is undesigned', async () => {
    const dispatch = await run([char({ ttsEngine: 'qwen', lines: 0 })], 'qwen3-tts-0.6b');
    expect(dispatch).toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    expect(dispatch).not.toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });

  it('opens the gate for a non-English book with an undesigned speaking Qwen character', async () => {
    const dispatch = await run([char({ ttsEngine: 'qwen', lines: 5 })], 'qwen3-tts-0.6b', {
      language: 'ru',
    });
    expect(dispatch).toHaveBeenCalledWith(uiActions.openVoiceReadinessGate({ bookId: 'b1' }));
  });

  it('toggles startGenerationPending around the whole flow, even when no fetch is needed', async () => {
    const dispatch = await run([char({ ttsEngine: 'kokoro' })], 'kokoro-v1');
    const calls = dispatch.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual(uiActions.setStartGenerationPending(true));
    expect(calls[calls.length - 1]).toEqual(uiActions.setStartGenerationPending(false));
  });

  describe('plan 276 — clone-readiness gate', () => {
    it('reaches the clone gate for a Coqui-only cloned cast that cannot resolve on its routed engine — the tier-prompt guard must not short-circuit it, and it must not open the tier prompt either', async () => {
      const cast = [
        char({
          ttsEngine: 'coqui',
          overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
        }),
      ];
      const dispatch = await run(cast, 'coqui-xtts-v2', { libraryEntries: [healthyEntry()] });
      expect(dispatch).toHaveBeenCalledWith(uiActions.openCloneReadinessGate({ bookId: 'b1' }));
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.requestStartGeneration());

      // fetchVoiceLibrary (a function dispatch) must run BEFORE the verdict fires the gate.
      const calls = dispatch.mock.calls.map((c) => c[0]);
      const fetchIdx = calls.findIndex((a) => typeof a === 'function');
      const gateIdx = calls.findIndex(
        (a) => (a as { type?: string })?.type === uiActions.openCloneReadinessGate({ bookId: 'b1' }).type,
      );
      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeLessThan(gateIdx);
    });

    it('fires for a character routed to Kokoro even though the cast never renders on Qwen', async () => {
      const cast = [
        char({
          ttsEngine: 'kokoro',
          overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
        }),
      ];
      const dispatch = await run(cast, 'kokoro-v1', { libraryEntries: [healthyEntry()] });
      expect(dispatch).toHaveBeenCalledWith(uiActions.openCloneReadinessGate({ bookId: 'b1' }));
    });

    it('does not fire — and starts generation normally — for a qwen-cloned voice on a coqui-routed character carrying BOTH cast slots (rule 7 silence)', async () => {
      const cast = [
        char({
          ttsEngine: 'coqui',
          overrideTtsVoices: {
            qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' },
            coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' },
          },
        }),
      ];
      const dispatch = await run(cast, 'coqui-xtts-v2', { libraryEntries: [healthyEntry()] });
      expect(dispatch).toHaveBeenCalledWith(uiActions.requestStartGeneration());
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.openCloneReadinessGate({ bookId: 'b1' }));
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    });

    it('fails open on a fetchVoiceLibrary rejection — generation starts rather than blocking on an advisory it could not compute', async () => {
      const cast = [
        char({
          ttsEngine: 'coqui',
          overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
        }),
      ];
      const dispatch = await run(cast, 'coqui-xtts-v2', {
        libraryEntries: [healthyEntry()],
        fetchFails: true,
      });
      expect(dispatch).toHaveBeenCalledWith(uiActions.requestStartGeneration());
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.openCloneReadinessGate({ bookId: 'b1' }));
      expect(dispatch).not.toHaveBeenCalledWith(uiActions.openStartGenPrompt());
    });

    it('skips fetchVoiceLibrary entirely for a plain cast with no cloned or legacy slot at all', async () => {
      const dispatch = await run([char({ ttsEngine: 'coqui' })], 'coqui-xtts-v2');
      const calls = dispatch.mock.calls.map((c) => c[0]);
      expect(calls.some((a) => typeof a === 'function')).toBe(false);
    });
  });
});
