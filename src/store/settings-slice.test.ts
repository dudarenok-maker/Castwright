/* fe-2 settings slice — reducers + the autosave-debounce clamp. */

import { describe, it, expect } from 'vitest';
import {
  settingsSlice,
  settingsActions,
  DEFAULT_KEYBINDINGS,
  DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_DEBOUNCE_MIN_MS,
  AUTOSAVE_DEBOUNCE_MAX_MS,
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
});

describe('setKeybinding / resetKeybinding', () => {
  it('overrides a binding then resets it to the default', () => {
    const overridden = reducer(initial, settingsActions.setKeybinding({ action: 'play-pause', key: 'K' }));
    expect(overridden.keybindings['play-pause']).toBe('K');
    const reset = reducer(overridden, settingsActions.resetKeybinding('play-pause'));
    expect(reset.keybindings['play-pause']).toBe(DEFAULT_KEYBINDINGS['play-pause']);
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
