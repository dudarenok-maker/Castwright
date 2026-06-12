// Pairs with docs/features/archive/00-stage-machine.md, docs/features/archive/01-hash-router.md

import { describe, expect, it } from 'vitest';
import { uiSlice, uiActions, type UiState } from './ui-slice';
import { stageToHash } from '../lib/router';
import type { Stage } from '../lib/types';

import { DEFAULT_MODEL } from '../lib/models';
import { DEFAULT_TTS_MODEL } from '../lib/tts-models';

const baseState = (stage: Stage): UiState => ({
  stage,
  currentTrack: null,
  matchDetailFor: null,
  regenChapter: null,
  regenInitialScope: null,
  regenCharacterCtx: null,
  previewRegen: null,
  staleAudio: null,
  showRevisionPlayer: false,
  revisionHistoryFor: null,
  showDriftReport: false,
  driftReportCharacterFilter: null,
  previewMode: false,
  selectedModel: DEFAULT_MODEL,
  ttsModelKey: DEFAULT_TTS_MODEL,
  selectedModelExplicit: false,
  ttsModelKeyExplicit: false,
  themeOverride: null,
  reuploadingBookId: null,
  queueModalOpen: false,
  rebaselineModalOpen: false,
  rebaselineBookId: null,
});

describe('uiSlice — openBook status→stage routing', () => {
  it('analysing → analysing stage', () => {
    const next = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.openBook({ id: 'ns', status: 'analysing', manuscriptId: 'm1' }),
    );
    expect(next.stage).toEqual({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' });
  });

  it('cast_pending → confirm stage', () => {
    const next = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.openBook({ id: 'ns', status: 'cast_pending' }),
    );
    expect(next.stage).toEqual({ kind: 'confirm', bookId: 'ns', openProfileId: null });
  });

  it('complete → ready stage on listen view', () => {
    const next = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.openBook({ id: 'ns', status: 'complete' }),
    );
    expect(next.stage).toMatchObject({
      kind: 'ready',
      bookId: 'ns',
      view: 'listen',
      currentChapterId: 3,
      openProfileId: null,
    });
  });

  it('generating → ready stage on generate view', () => {
    const next = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.openBook({ id: 'ns', status: 'generating' }),
    );
    expect(next.stage).toMatchObject({ kind: 'ready', bookId: 'ns', view: 'generate' });
  });

  it('unknown status falls back to cast view', () => {
    const next = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.openBook({ id: 'ns', status: 'something-else' }),
    );
    expect(next.stage).toMatchObject({ kind: 'ready', bookId: 'ns', view: 'cast' });
  });
});

describe('uiSlice — stage transition guards', () => {
  it('manuscriptUploaded only fires from upload stage', () => {
    const fromUpload = uiSlice.reducer(
      baseState({ kind: 'upload' }),
      uiActions.manuscriptUploaded({ bookId: 'ns', manuscriptId: 'm1' }),
    );
    expect(fromUpload.stage).toEqual({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' });

    const fromBooks = uiSlice.reducer(
      baseState({ kind: 'books' }),
      uiActions.manuscriptUploaded({ bookId: 'ns', manuscriptId: 'm1' }),
    );
    expect(fromBooks.stage).toEqual({ kind: 'books' });
  });

  it('analysisComplete only fires from analysing stage', () => {
    const fromAnalysing = uiSlice.reducer(
      baseState({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' }),
      uiActions.analysisComplete({ bookId: 'ns' }),
    );
    expect(fromAnalysing.stage).toEqual({ kind: 'confirm', bookId: 'ns', openProfileId: null });

    const fromUpload = uiSlice.reducer(
      baseState({ kind: 'upload' }),
      uiActions.analysisComplete({ bookId: 'ns' }),
    );
    expect(fromUpload.stage).toEqual({ kind: 'upload' });
  });

  it('confirmCast only fires from confirm stage', () => {
    const fromConfirm = uiSlice.reducer(
      baseState({ kind: 'confirm', bookId: 'ns', openProfileId: null }),
      uiActions.confirmCast(),
    );
    expect(fromConfirm.stage).toMatchObject({
      kind: 'ready',
      bookId: 'ns',
      view: 'manuscript',
      currentChapterId: 3,
    });

    const fromAnalysing = uiSlice.reducer(
      baseState({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' }),
      uiActions.confirmCast(),
    );
    expect(fromAnalysing.stage).toEqual({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' });
  });
});

describe('uiSlice — hydrateFromUrl + stageToHash round-trip', () => {
  const stages: Stage[] = [
    { kind: 'books' },
    { kind: 'upload' },
    { kind: 'voices' },
    { kind: 'changelog' },
    { kind: 'account' },
    { kind: 'confirm', bookId: 'ns', openProfileId: null },
    { kind: 'confirm', bookId: 'ns', openProfileId: 'halloran' },
    { kind: 'ready', bookId: 'ns', view: 'manuscript', currentChapterId: 3, openProfileId: null },
    { kind: 'ready', bookId: 'ns', view: 'cast', currentChapterId: 5, openProfileId: 'halloran' },
  ];

  it('hydrateFromUrl with a well-formed Stage sets state.stage to that exact value', () => {
    for (const stage of stages) {
      const next = uiSlice.reducer(baseState({ kind: 'books' }), uiActions.hydrateFromUrl(stage));
      expect(next.stage).toEqual(stage);
      // And stageToHash is callable on each variant without throwing.
      expect(typeof stageToHash(stage)).toBe('string');
    }
  });

  it('hydrateFromUrl with a stage missing kind is rejected', () => {
    const start = baseState({ kind: 'confirm', bookId: 'ns', openProfileId: null });
    const next = uiSlice.reducer(start, uiActions.hydrateFromUrl({} as Stage));
    expect(next.stage).toEqual(start.stage);
  });
});

describe('uiSlice — setOpenProfileId across stages', () => {
  it('writes openProfileId on the confirm stage', () => {
    /* "Meet the cast" cards open the same ProfileDrawer the ready-stage
       cast view uses — so the reducer must let the field through here. */
    const start = baseState({ kind: 'confirm', bookId: 'ns', openProfileId: null });
    const next = uiSlice.reducer(start, uiActions.setOpenProfileId('halloran'));
    expect(next.stage).toEqual({ kind: 'confirm', bookId: 'ns', openProfileId: 'halloran' });
  });

  it('writes openProfileId on the ready stage', () => {
    const start = baseState({
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: null,
    });
    const next = uiSlice.reducer(start, uiActions.setOpenProfileId('halloran'));
    expect(next.stage).toMatchObject({ kind: 'ready', openProfileId: 'halloran' });
  });

  it('is a no-op on stages that have no openProfileId slot', () => {
    /* Guard rail — dispatching from books/upload/analysing/etc. must not
       perturb the stage shape (which has no openProfileId field there). */
    const start = baseState({ kind: 'analysing', bookId: 'ns', manuscriptId: 'm1' });
    const next = uiSlice.reducer(start, uiActions.setOpenProfileId('halloran'));
    expect(next.stage).toEqual(start.stage);
  });
});

describe('uiSlice — seed defaults from account settings', () => {
  it('seeds selectedModel + ttsModelKey from fetched account defaults when not yet explicit', () => {
    const start = baseState({ kind: 'books' });
    const next = uiSlice.reducer(start, {
      type: 'account/fetch/fulfilled',
      payload: {
        defaultAnalysisModel: 'gemini-3-flash-preview',
        defaultTtsModelKey: 'gemini-2.5-flash',
      },
    });
    expect(next.selectedModel).toBe('gemini-3-flash-preview');
    expect(next.ttsModelKey).toBe('gemini-2.5-flash');
  });

  it('seeds ttsModelKey from resolvedTtsModelKey (Qwen-when-installed) over the stored default', () => {
    /* The server resolves the effective default to Qwen when it's installed
       while leaving the STORED defaultTtsModelKey on kokoro-v1; the session
       must seed from the resolved key so a Qwen box defaults to bespoke voices. */
    const start = baseState({ kind: 'books' });
    const next = uiSlice.reducer(start, {
      type: 'account/fetch/fulfilled',
      payload: {
        defaultAnalysisModel: 'gemini-3.1-flash-lite',
        defaultTtsModelKey: 'kokoro-v1',
        resolvedTtsModelKey: 'qwen3-tts-0.6b',
      },
    });
    expect(next.ttsModelKey).toBe('qwen3-tts-0.6b');
  });

  it('falls back to the stored default when the server omits resolvedTtsModelKey', () => {
    const start = baseState({ kind: 'books' });
    const next = uiSlice.reducer(start, {
      type: 'account/fetch/fulfilled',
      payload: { defaultAnalysisModel: 'x', defaultTtsModelKey: 'coqui-xtts-v2' },
    });
    expect(next.ttsModelKey).toBe('coqui-xtts-v2');
  });

  it('leaves an explicit user pick alone when account hydrates after', () => {
    let s = baseState({ kind: 'books' });
    s = uiSlice.reducer(s, uiActions.setSelectedModel('gemini-2.5-flash'));
    s = uiSlice.reducer(s, uiActions.setTtsModelKey('gemini-2.5-flash'));
    const next = uiSlice.reducer(s, {
      type: 'account/fetch/fulfilled',
      payload: {
        defaultAnalysisModel: 'gemma-4-31b-it',
        defaultTtsModelKey: 'coqui-xtts-v2',
      },
    });
    expect(next.selectedModel).toBe('gemini-2.5-flash');
    expect(next.ttsModelKey).toBe('gemini-2.5-flash');
  });

  it('also re-seeds when account is updated via save (same code path)', () => {
    const start = baseState({ kind: 'books' });
    const next = uiSlice.reducer(start, {
      type: 'account/save/fulfilled',
      payload: {
        defaultAnalysisModel: 'gemini-3.1-flash-lite',
        defaultTtsModelKey: 'gemini-3.1-flash',
      },
    });
    expect(next.selectedModel).toBe('gemini-3.1-flash-lite');
    expect(next.ttsModelKey).toBe('gemini-3.1-flash');
  });
});

describe('uiSlice — rebaseline modal target bookId', () => {
  it('openRebaselineModal stores the target bookId and opens the modal', () => {
    const start = baseState({ kind: 'voices' });
    const next = uiSlice.reducer(start, uiActions.openRebaselineModal({ bookId: 'b2' }));
    expect(next.rebaselineModalOpen).toBe(true);
    expect(next.rebaselineBookId).toBe('b2');
  });

  it('closeRebaselineModal clears the open flag and the target bookId', () => {
    let s = baseState({ kind: 'voices' });
    s = uiSlice.reducer(s, uiActions.openRebaselineModal({ bookId: 'b2' }));
    s = uiSlice.reducer(s, uiActions.closeRebaselineModal());
    expect(s.rebaselineModalOpen).toBe(false);
    expect(s.rebaselineBookId).toBeNull();
  });
});

describe('uiSlice — overlays do not perturb the stage', () => {
  it('setCurrentTrack updates currentTrack and leaves stage alone', () => {
    const start = baseState({
      kind: 'ready',
      bookId: 'ns',
      view: 'listen',
      currentChapterId: 3,
      openProfileId: null,
    });
    const next = uiSlice.reducer(start, uiActions.setCurrentTrack(5));
    expect(next.currentTrack).toBe(5);
    expect(next.stage).toEqual(start.stage);
  });
});

describe('uiSlice — regenerate-modal scope override', () => {
  it('setRegenInitialScope stores the scope override', () => {
    const start = baseState({ kind: 'books' });
    const next = uiSlice.reducer(start, uiActions.setRegenInitialScope('forward'));
    expect(next.regenInitialScope).toBe('forward');
  });

  it('closing the regenerate modal clears the scope override', () => {
    /* Otherwise a subsequent per-chapter Regenerate would inherit
       scope='forward' from the previous book-level open. */
    let s = baseState({ kind: 'books' });
    s = uiSlice.reducer(s, uiActions.setRegenInitialScope('forward'));
    s = uiSlice.reducer(s, uiActions.setRegenChapter(null));
    expect(s.regenInitialScope).toBeNull();
  });
});


describe('uiSlice — openAbout', () => {
  it('openAbout sets stage.kind to about', () => {
    const s = uiSlice.reducer(baseState({ kind: 'books' }), uiActions.openAbout());
    expect(s.stage.kind).toBe('about');
  });
});

describe('uiSlice — openSetup', () => {
  it('openSetup sets the setup stage', () => {
    const s = uiSlice.reducer(undefined, uiActions.openSetup());
    expect(s.stage).toEqual({ kind: 'setup' });
  });
});
