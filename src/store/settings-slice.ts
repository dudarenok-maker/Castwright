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
 * normalizeKeyEvent): 'Space', or a single uppercased character like 'K'.
 * Rebindable actions: play/pause + skip-forward / skip-back (fe-24, J/L mirror
 * YouTube — arrow keys aren't bindable because normalizeKeyEvent returns null
 * for them). */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type KeyboardActionId = 'play-pause' | 'skip-forward' | 'skip-back';
export type TextScale = 'normal' | 'large' | 'larger';

export const DEFAULT_KEYBINDINGS: Record<KeyboardActionId, string> = {
  'play-pause': 'Space',
  'skip-forward': 'L',
  'skip-back': 'J',
};

/* Bound the autosave debounce to a sane window — fast enough that a save still
   feels immediate, slow enough to actually coalesce bursts. Clamped on write so
   a hand-edited localStorage blob can't set 0 (write-storm) or a huge value
   (silent data-loss on close). */
export const AUTOSAVE_DEBOUNCE_MIN_MS = 100;
export const AUTOSAVE_DEBOUNCE_MAX_MS = 10_000;
export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 500;

/* fe-24 — skip-back/forward deltas. Clamped to a sane window on write so a
   hand-edited localStorage blob can't set a useless 0 s skip or an absurd
   multi-minute jump. Defaults mirror common audiobook players (back 15 s,
   forward 30 s). */
export const SKIP_SEC_MIN = 5;
export const SKIP_SEC_MAX = 120;
export const SKIP_FORWARD_SEC_DEFAULT = 30;
export const SKIP_BACK_SEC_DEFAULT = 15;

/* fe-25 — mini-player output volume (0..1), device-local. Clamped on write so a
   hand-edited localStorage blob can't push the audio element out of range. */
export const PLAYER_VOLUME_DEFAULT = 1;

export interface SettingsState {
  keybindings: Record<KeyboardActionId, string>;
  highContrast: boolean;
  textScale: TextScale;
  autosaveDebounceMs: number;
  autoAdvance: boolean;
  skipForwardSec: number;
  skipBackSec: number;
  playerVolume: number;
}

const initialState: SettingsState = {
  keybindings: { ...DEFAULT_KEYBINDINGS },
  highContrast: false,
  textScale: 'normal',
  autosaveDebounceMs: DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  autoAdvance: true,
  skipForwardSec: SKIP_FORWARD_SEC_DEFAULT,
  skipBackSec: SKIP_BACK_SEC_DEFAULT,
  playerVolume: PLAYER_VOLUME_DEFAULT,
};

/* Clamp a skip delta to [SKIP_SEC_MIN, SKIP_SEC_MAX], falling back to the
   supplied default on a non-finite value (mirrors the autosave clamp). */
function clampSkipSec(value: number, fallback: number): number {
  const v = Math.round(value);
  return Number.isFinite(v) ? Math.min(SKIP_SEC_MAX, Math.max(SKIP_SEC_MIN, v)) : fallback;
}

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
    setAutoAdvance(state, action: PayloadAction<boolean>) {
      state.autoAdvance = action.payload;
    },
    setSkipForwardSec(state, action: PayloadAction<number>) {
      state.skipForwardSec = clampSkipSec(action.payload, SKIP_FORWARD_SEC_DEFAULT);
    },
    setSkipBackSec(state, action: PayloadAction<number>) {
      state.skipBackSec = clampSkipSec(action.payload, SKIP_BACK_SEC_DEFAULT);
    },
    setPlayerVolume(state, action: PayloadAction<number>) {
      const v = action.payload;
      state.playerVolume = Number.isFinite(v)
        ? Math.min(1, Math.max(0, v))
        : PLAYER_VOLUME_DEFAULT;
    },
  },
});

export const settingsActions = settingsSlice.actions;
