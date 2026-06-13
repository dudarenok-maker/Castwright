/* Pins the redux-persist whitelist shape for the two persisted slices.
 *
 * Whitelist drift is the single class of mistake that makes a refresh
 * restore the wrong state: adding a field to ui-slice without adding it
 * to UI_PERSIST_WHITELIST silently breaks "refresh keeps you where you
 * were" the moment that field becomes load-bearing; conversely, adding
 * a transient overlay (regenChapter, staleAudio, ...) to the whitelist
 * would resurrect dismissed modals on every refresh. Locking the lists
 * here forces the reviewer to update the test in the same diff and
 * catch the question explicitly.
 *
 * Pairs with `src/store/index.ts` where the configs live and
 * the redux-persist whitelist config which captured the
 * original intent. */

import { describe, it, expect } from 'vitest';
import { UI_PERSIST_WHITELIST, MANUSCRIPT_PERSIST_WHITELIST } from './index';
import { uiSlice } from './ui-slice';
import { manuscriptSlice } from './manuscript-slice';

describe('UI_PERSIST_WHITELIST', () => {
  it('contains exactly the stage + TTS-engine-pick + theme fields that should survive refresh', () => {
    /* Sorted compare so reorder doesn't churn this assertion. NOTE: the
       analyzer-model selectors (selectedModel / selectedModelExplicit) are
       intentionally NOT here — they are a per-run override that must revert to
       the saved default on reload (fix: sticky-model bug). See the transient
       guard below + persist-whitelist.test.ts. */
    expect([...UI_PERSIST_WHITELIST].sort()).toEqual([
      'stage',
      'themeOverride',
      'ttsModelKey',
      'ttsModelKeyExplicit',
    ]);
  });

  it('omits every transient overlay (regen modal, drawer-detail, stale-audio, ...) so refresh does not resurrect dismissed UI', () => {
    /* The init shape of ui-slice carries the full surface area; whatever
       isn't in the whitelist must NOT appear here. */
    const _initial = uiSlice.reducer(undefined, { type: 'noop' });
    const transientKeys: Array<keyof typeof _initial> = [
      'currentTrack',
      'matchDetailFor',
      'regenChapter',
      'regenInitialScope',
      'regenCharacterCtx',
      'previewRegen',
      'staleAudio',
      'showRevisionPlayer',
      'showDriftReport',
      'driftReportCharacterFilter',
      'previewMode',
      'reuploadingBookId',
      /* Per-run analyzer-model override — transient by design so it can't
         silently shadow the saved analysisEngine across reloads/books. */
      'selectedModel',
      'selectedModelExplicit',
    ];
    for (const key of transientKeys) {
      expect(
        UI_PERSIST_WHITELIST,
        `transient field ${String(key)} must not be persisted`,
      ).not.toContain(key);
    }
  });

  it('every whitelisted key exists on the slice initial state (typo-guard)', () => {
    /* Catches a stringly-typed whitelist entry that no longer maps to
       a real slice field — without this, a rename-and-forget would
       silently stop persisting the value. */
    const initial = uiSlice.reducer(undefined, { type: 'noop' });
    for (const key of UI_PERSIST_WHITELIST) {
      expect(initial, `whitelist key ${String(key)} missing from UiState`).toHaveProperty(
        String(key),
      );
    }
  });
});

describe('MANUSCRIPT_PERSIST_WHITELIST', () => {
  it('persists only the minimal book-identity fields the top bar needs before the per-book hydrate resolves', () => {
    expect([...MANUSCRIPT_PERSIST_WHITELIST].sort()).toEqual([
      'bookId',
      'format',
      'manuscriptId',
      'title',
      'wordCount',
    ]);
  });

  it('omits sentences / sourceText / importCandidate / pendingReupload (server-sourced or transient — stale persistence would race the hydrate)', () => {
    const _initial = manuscriptSlice.reducer(undefined, { type: 'noop' });
    const transientKeys: Array<keyof typeof _initial> = [
      'sentences',
      'sourceText',
      'importCandidate',
      'pendingReupload',
    ];
    for (const key of transientKeys) {
      expect(
        MANUSCRIPT_PERSIST_WHITELIST,
        `transient field ${String(key)} must not be persisted`,
      ).not.toContain(key);
    }
  });

  it('every whitelisted key exists on the slice initial state (typo-guard)', () => {
    const initial = manuscriptSlice.reducer(undefined, { type: 'noop' });
    for (const key of MANUSCRIPT_PERSIST_WHITELIST) {
      expect(initial, `whitelist key ${String(key)} missing from ManuscriptState`).toHaveProperty(
        String(key),
      );
    }
  });
});
