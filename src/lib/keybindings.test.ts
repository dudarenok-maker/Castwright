/* fe-2 keybindings — key normalisation + the global-shortcut hook. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  normalizeKeyEvent,
  isTextEntryTarget,
  formatKeyLabel,
  useKeyBinding,
} from './keybindings';

function press(opts: KeyboardEventInit, target: EventTarget = window): void {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('normalizeKeyEvent', () => {
  it('maps the space bar to "Space"', () => {
    expect(normalizeKeyEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }))).toBe('Space');
  });
  it('uppercases a single letter so k and K bind alike', () => {
    expect(normalizeKeyEvent(new KeyboardEvent('keydown', { key: 'k' }))).toBe('K');
    expect(normalizeKeyEvent(new KeyboardEvent('keydown', { key: 'K' }))).toBe('K');
  });
  it('returns null for multi-char keys', () => {
    expect(normalizeKeyEvent(new KeyboardEvent('keydown', { key: 'Enter' }))).toBeNull();
  });
});

describe('isTextEntryTarget', () => {
  it('is true for inputs/textareas and false for a div', () => {
    expect(isTextEntryTarget(document.createElement('input'))).toBe(true);
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true);
    expect(isTextEntryTarget(document.createElement('div'))).toBe(false);
  });
});

describe('formatKeyLabel', () => {
  it('passes through Space and letters', () => {
    expect(formatKeyLabel('Space')).toBe('Space');
    expect(formatKeyLabel('K')).toBe('K');
  });
});

describe('useKeyBinding', () => {
  it('fires the handler on the bound key', () => {
    const handler = vi.fn();
    renderHook(() => useKeyBinding('Space', handler));
    press({ code: 'Space', key: ' ' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rebinding makes the new key fire and the old key stop', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ key }) => useKeyBinding(key, handler), {
      initialProps: { key: 'Space' },
    });
    rerender({ key: 'K' });
    press({ key: 'k' });
    expect(handler).toHaveBeenCalledTimes(1);
    press({ code: 'Space', key: ' ' }); // old binding no longer active
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores keydown from a text-entry target', () => {
    const handler = vi.fn();
    renderHook(() => useKeyBinding('K', handler));
    const input = document.createElement('input');
    document.body.appendChild(input);
    press({ key: 'k' }, input);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores modifier chords (Ctrl/Cmd+key stays free)', () => {
    const handler = vi.fn();
    renderHook(() => useKeyBinding('K', handler));
    press({ key: 'k', ctrlKey: true });
    press({ key: 'k', metaKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not bind when disabled', () => {
    const handler = vi.fn();
    renderHook(() => useKeyBinding('Space', handler, false));
    press({ code: 'Space', key: ' ' });
    expect(handler).not.toHaveBeenCalled();
  });
});
