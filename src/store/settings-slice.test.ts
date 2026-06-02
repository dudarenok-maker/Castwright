/* fe-2 settings slice — reducers + the autosave-debounce clamp. */

import { describe, it, expect } from 'vitest';
import {
  settingsSlice,
  settingsActions,
  DEFAULT_KEYBINDINGS,
  DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_DEBOUNCE_MIN_MS,
  AUTOSAVE_DEBOUNCE_MAX_MS,
  SKIP_FORWARD_SEC_DEFAULT,
  SKIP_BACK_SEC_DEFAULT,
  SKIP_SEC_MIN,
  SKIP_SEC_MAX,
} from './settings-slice';

const reducer = settingsSlice.reducer;
const initial = reducer(undefined, { type: '@@INIT' });

describe('settings-slice initial state', () => {
  it('defaults play/pause to Space, normal scale, 500ms debounce, no high-contrast', () => {
    expect(initial.keybindings['play-pause']).toBe('Space');
    expect(initial.textScale).toBe('normal');
    expect(initial.highContrast).toBe(false);
    expect(initial.autosaveDebounceMs).toBe(DEFAULT_AUTOSAVE_DEBOUNCE_MS);
  });

  it('defaults auto-advance ON and the skip deltas to 30 s / 15 s (fe-23, fe-24)', () => {
    expect(initial.autoAdvance).toBe(true);
    expect(initial.skipForwardSec).toBe(SKIP_FORWARD_SEC_DEFAULT);
    expect(initial.skipBackSec).toBe(SKIP_BACK_SEC_DEFAULT);
  });

  it('defaults skip-forward to L and skip-back to J (fe-24)', () => {
    expect(initial.keybindings['skip-forward']).toBe('L');
    expect(initial.keybindings['skip-back']).toBe('J');
  });
});

describe('setKeybinding / resetKeybinding', () => {
  it('overrides a binding then resets it to the default', () => {
    const overridden = reducer(initial, settingsActions.setKeybinding({ action: 'play-pause', key: 'K' }));
    expect(overridden.keybindings['play-pause']).toBe('K');
    const reset = reducer(overridden, settingsActions.resetKeybinding('play-pause'));
    expect(reset.keybindings['play-pause']).toBe(DEFAULT_KEYBINDINGS['play-pause']);
  });

  it('resets skip-forward back to its L default (fe-24)', () => {
    const overridden = reducer(
      initial,
      settingsActions.setKeybinding({ action: 'skip-forward', key: 'P' }),
    );
    expect(overridden.keybindings['skip-forward']).toBe('P');
    const reset = reducer(overridden, settingsActions.resetKeybinding('skip-forward'));
    expect(reset.keybindings['skip-forward']).toBe('L');
  });
});

describe('setAutoAdvance (fe-23)', () => {
  it('toggles auto-advance off and back on', () => {
    const off = reducer(initial, settingsActions.setAutoAdvance(false));
    expect(off.autoAdvance).toBe(false);
    const on = reducer(off, settingsActions.setAutoAdvance(true));
    expect(on.autoAdvance).toBe(true);
  });
});

describe('setSkipForwardSec / setSkipBackSec clamp (fe-24)', () => {
  it('accepts in-range values', () => {
    expect(reducer(initial, settingsActions.setSkipForwardSec(45)).skipForwardSec).toBe(45);
    expect(reducer(initial, settingsActions.setSkipBackSec(10)).skipBackSec).toBe(10);
  });
  it('clamps below the floor and above the ceiling', () => {
    expect(reducer(initial, settingsActions.setSkipForwardSec(1)).skipForwardSec).toBe(SKIP_SEC_MIN);
    expect(reducer(initial, settingsActions.setSkipForwardSec(999)).skipForwardSec).toBe(SKIP_SEC_MAX);
    expect(reducer(initial, settingsActions.setSkipBackSec(0)).skipBackSec).toBe(SKIP_SEC_MIN);
    expect(reducer(initial, settingsActions.setSkipBackSec(999)).skipBackSec).toBe(SKIP_SEC_MAX);
  });
  it('falls back to the default on a non-finite value', () => {
    expect(reducer(initial, settingsActions.setSkipForwardSec(NaN)).skipForwardSec).toBe(
      SKIP_FORWARD_SEC_DEFAULT,
    );
    expect(reducer(initial, settingsActions.setSkipBackSec(NaN)).skipBackSec).toBe(
      SKIP_BACK_SEC_DEFAULT,
    );
  });
});

describe('accessibility toggles', () => {
  it('sets high-contrast and text scale', () => {
    const hc = reducer(initial, settingsActions.setHighContrast(true));
    expect(hc.highContrast).toBe(true);
    const scaled = reducer(hc, settingsActions.setTextScale('larger'));
    expect(scaled.textScale).toBe('larger');
  });
});

describe('setAutosaveDebounceMs clamp', () => {
  it('accepts an in-range value', () => {
    expect(reducer(initial, settingsActions.setAutosaveDebounceMs(2000)).autosaveDebounceMs).toBe(2000);
  });
  it('clamps below the floor and above the ceiling', () => {
    expect(reducer(initial, settingsActions.setAutosaveDebounceMs(0)).autosaveDebounceMs).toBe(
      AUTOSAVE_DEBOUNCE_MIN_MS,
    );
    expect(reducer(initial, settingsActions.setAutosaveDebounceMs(999999)).autosaveDebounceMs).toBe(
      AUTOSAVE_DEBOUNCE_MAX_MS,
    );
  });
  it('falls back to the default on a non-finite value', () => {
    expect(reducer(initial, settingsActions.setAutosaveDebounceMs(NaN)).autosaveDebounceMs).toBe(
      DEFAULT_AUTOSAVE_DEBOUNCE_MS,
    );
  });
});
