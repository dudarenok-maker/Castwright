import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { castRendersOnQwen, startGenerationFlow } from './start-generation-flow';
import { uiSlice, uiActions } from './ui-slice';
import { castSlice } from './cast-slice';
import { voiceLibrarySlice } from './voice-library-slice';
import type { Character } from '../lib/types';
import type { VoiceLibraryEntry } from './voice-library-slice';
import type { AppDispatch, RootState } from './index';

/* Backs the real-store fail-open test below (Decision 5) — mocked at the
   `api` boundary, never at the `fetchVoiceLibrary` thunk itself, so the
   thunk's own resolve/reject plumbing (and `.unwrap()`'s re-throw) is
   exercised for real rather than assumed. Same shape as
   `voice-library-slice.test.ts`'s own `api` mock. */
vi.mock('../lib/api', () => ({
  api: { listVoiceLibrary: vi.fn() },
}));
import { api } from '../lib/api';

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
     action object. The production flow calls `.unwrap()` on that dispatch result
     (Decision 5), so the fake must return something `.unwrap()`-able rather than
     a bare value or Promise. This helper only ever exercises the SUCCESS path —
     the fail-open path needs a REAL store + thunk middleware to be exercised
     honestly (a bare mock can't reproduce `createAsyncThunk`'s actual
     resolve-with-a-rejected-action shape), so that case has its own dedicated
     real-store test below rather than a `fetchFails` flag here. */
  const run = async (
    characters: Character[],
    ttsModelKey: string,
    opts: {
      bookId?: string;
      language?: string;
      libraryEntries?: VoiceLibraryEntry[];
    } = {},
  ) => {
    const dispatch = vi.fn((action: unknown) => {
      if (typeof action === 'function') {
        return { unwrap: () => Promise.resolve({ voices: opts.libraryEntries ?? [] }) };
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

    it('does not fire — and starts generation normally — for a qwen-cloned voice on a coqui-routed character carrying BOTH cast slots (rule 8 silence)', async () => {
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
      /* Driven through a REAL store + thunk middleware, deliberately NOT the
         `run()` helper above. `fetchVoiceLibrary` is a `createAsyncThunk`:
         dispatching it returns a promise that ALWAYS resolves (with a
         `rejected` action) unless `.unwrap()`ped, so `run()`'s bare-mock
         `dispatch` — which hands the producer's function argument straight
         to a `Promise.reject(...)` stand-in — accepts a bare
         `try { await dispatch(...) } catch {}` as if it could ever run. It
         can't: a real dispatch of a rejected `createAsyncThunk` never
         throws. Only a real store's thunk middleware, with the real
         `fetchVoiceLibrary` action creator, reproduces that shape. Mutation:
         delete the whole fail-open `try`/`catch` (or drop `.unwrap()` back
         to a bare `await`) from `start-generation-flow.ts` -> this test goes
         red (no `requestStartGeneration`, and the promise the flow returns
         rejects instead of resolving). */
      vi.mocked(api.listVoiceLibrary).mockRejectedValueOnce(new Error('fetch failed'));
      const cast = [
        char({
          ttsEngine: 'coqui',
          overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
        }),
      ];
      const store = configureStore({
        reducer: {
          ui: uiSlice.reducer,
          cast: castSlice.reducer,
          voiceLibrary: voiceLibrarySlice.reducer,
        },
        preloadedState: {
          ui: {
            ...uiSlice.getInitialState(),
            ttsModelKey: 'coqui-xtts-v2',
            stage: {
              kind: 'ready',
              bookId: 'b1',
              view: 'manuscript',
              currentChapterId: 1,
              openProfileId: null,
            },
          } as never,
          cast: { ...castSlice.getInitialState(), characters: cast },
          voiceLibrary: voiceLibrarySlice.getInitialState(),
        },
      });
      const dispatchSpy = vi.spyOn(store, 'dispatch');

      /* Calling the thunk directly (rather than `store.dispatch(thunk)`)
         keeps the same call shape the `run()` helper above uses — this
         thunk's `dispatch`/`getState` parameters are typed against the
         FULL app's `AppDispatch`/`RootState`, which this deliberately
         minimal store doesn't structurally satisfy — while still routing
         every dispatch through the REAL store's real thunk middleware and
         reducers (the spy wraps `store.dispatch` itself, not a copy). */
      await startGenerationFlow()(
        store.dispatch as unknown as AppDispatch,
        store.getState as unknown as () => RootState,
      );

      const types = dispatchSpy.mock.calls.map((c) => (c[0] as { type?: string })?.type);
      expect(types).toContain(uiActions.requestStartGeneration().type);
      expect(types).not.toContain(uiActions.openCloneReadinessGate({ bookId: 'b1' }).type);
      expect(types).not.toContain(uiActions.openStartGenPrompt({}).type);
      // The rejection was genuinely observed, not merely assumed absent.
      expect(store.getState().voiceLibrary.status).toBe('error');
    });

    it('skips fetchVoiceLibrary entirely for a plain cast with no cloned or legacy slot at all', async () => {
      const dispatch = await run([char({ ttsEngine: 'coqui' })], 'coqui-xtts-v2');
      const calls = dispatch.mock.calls.map((c) => c[0]);
      expect(calls.some((a) => typeof a === 'function')).toBe(false);
    });
  });
});
