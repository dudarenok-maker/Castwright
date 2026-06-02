/* fe-2 — keyboard-shortcut primitives.
 *
 * A small, framework-light layer the mini-player uses to bind play/pause to a
 * user-overridable key (settings-slice). Generalises the window-keydown pattern
 * the marker `M` shortcut already uses in mini-player.tsx: ignore events from
 * text-entry targets, ignore modifier chords, match a NORMALISED key token.
 *
 * Normalised token: 'Space' for the space bar (its event.key is a literal ' ',
 * which is unreadable in a settings UI), or a single uppercased character like
 * 'K'. Other keys aren't bindable in v1 and normalise to null. */

import { useEffect } from 'react';
import type { TextScale } from '../store/settings-slice';

/** Root-font-size percentage for each text-scale step. Tailwind's type scale is
    rem-based, so scaling `<html>`'s font-size scales the whole UI. */
export const TEXT_SCALE_PERCENT: Record<TextScale, number> = {
  normal: 100,
  large: 112,
  larger: 125,
};

/** True when the event originated in a text-entry control, where a global
    shortcut must NOT fire (typing 'k' in a field shouldn't toggle playback). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

/** Reduce a keydown to a bindable token, or null if it isn't bindable.
    'Space' for the space bar; a single printable char uppercased (so 'k' and
    'K' bind identically). Modifier-only presses and multi-char keys → null. */
export function normalizeKeyEvent(e: KeyboardEvent): string | null {
  if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') return 'Space';
  if (e.key.length === 1) {
    const upper = e.key.toUpperCase();
    /* Only letters/digits/punctuation — a single visible char. */
    return upper.trim() === '' ? null : upper;
  }
  return null;
}

/** Human label for a normalised token, for the rebind UI. */
export function formatKeyLabel(key: string): string {
  if (key === 'Space') return 'Space';
  return key;
}

/**
 * Bind a single global keyboard shortcut to `handler`.
 *
 * Mirrors the marker-`M` listener already in the mini-player: window-level
 * keydown, skip text-entry targets, skip modifier chords (so Ctrl/Cmd+K stays
 * available to the browser), preventDefault on a match (the space bar would
 * otherwise scroll the page).
 *
 * @param key      normalised token to match (e.g. 'Space', 'K'); empty/falsey disables.
 * @param handler  fired on a match.
 * @param enabled  gate the listener (default true).
 */
export function useKeyBinding(
  key: string,
  handler: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled || !key) return;
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntryTarget(e.target)) return;
      if (normalizeKeyEvent(e) !== key) return;
      e.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, handler, enabled]);
}
