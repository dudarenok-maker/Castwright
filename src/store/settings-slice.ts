/* fe-2 — power-user tuning settings (device-local).
 *
 * A small slice for preferences that are per-device, not per-account: a
 * rebindable keyboard shortcut, accessibility toggles (high-contrast theme +
 * larger text), and the autosave-debounce knob. Persisted via redux-persist
 * (localStorage) like `themeOverride` on the ui-slice — the whole slice is
 * whitelisted in store/index.ts, so every field round-trips a refresh. These
 * never go to the server (unlike account-slice settings); they describe how
 * THIS browser behaves.
 *
 * Keyboard bindings store a NORMALISED key token (see keybindings.ts
 * normalizeKeyEvent): 'Space', or a single uppercased character like 'K'. v1
 * exposes one rebindable action — play/pause the mini-player. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type KeyboardActionId = 'play-pause';
export type TextScale = 'normal' | 'large' | 'larger';

export const DEFAULT_KEYBINDINGS: Record<KeyboardActionId, string> = {
  'play-pause': 'Space',
};

/* Bound the autosave debounce to a sane window — fast enough that a save still
   feels immediate, slow enough to actually coalesce bursts. Clamped on write so
   a hand-edited localStorage blob can't set 0 (write-storm) or a huge value
   (silent data-loss on close). */
export const AUTOSAVE_DEBOUNCE_MIN_MS = 100;
export const AUTOSAVE_DEBOUNCE_MAX_MS = 10_000;
export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 500;

export interface SettingsState {
  keybindings: Record<KeyboardActionId, string>;
  highContrast: boolean;
  textScale: TextScale;
  autosaveDebounceMs: number;
}

const initialState: SettingsState = {
  keybindings: { ...DEFAULT_KEYBINDINGS },
  highContrast: false,
  textScale: 'normal',
  autosaveDebounceMs: DEFAULT_AUTOSAVE_DEBOUNCE_MS,
};

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setKeybinding(
      state,
      action: PayloadAction<{ action: KeyboardActionId; key: string }>,
    ) {
      state.keybindings[action.payload.action] = action.payload.key;
    },
    resetKeybinding(state, action: PayloadAction<KeyboardActionId>) {
      state.keybindings[action.payload] = DEFAULT_KEYBINDINGS[action.payload];
    },
    setHighContrast(state, action: PayloadAction<boolean>) {
      state.highContrast = action.payload;
    },
    setTextScale(state, action: PayloadAction<TextScale>) {
      state.textScale = action.payload;
    },
    setAutosaveDebounceMs(state, action: PayloadAction<number>) {
      const v = Math.round(action.payload);
      state.autosaveDebounceMs = Number.isFinite(v)
        ? Math.min(AUTOSAVE_DEBOUNCE_MAX_MS, Math.max(AUTOSAVE_DEBOUNCE_MIN_MS, v))
        : DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    },
  },
});

export const settingsActions = settingsSlice.actions;
