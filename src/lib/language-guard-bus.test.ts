/* language-guard-bus — verifies the 409 language-unset detector against the
   two body shapes the four client sites actually emit, and the non-language
   409 pass-through. The two-shape split is the whole point: a detector that
   checks only `error` silently misses qwen-voice, which puts the marker in
   `code`. (#2246 Task 9c) */

import { describe, it, expect, vi } from 'vitest';
import {
  setLanguageGuardHandler,
  emitLanguageGuard,
  isLanguageUnsetBody,
} from './language-guard-bus';

describe('isLanguageUnsetBody', () => {
  it('accepts the simple shape { error: "language_unset" } (splice / qa-repair / analysis)', () => {
    expect(isLanguageUnsetBody(409, JSON.stringify({ error: 'language_unset' }))).toBe(true);
  });

  it('accepts the qwen-voice shape { error: <message>, code: "language_unset" }', () => {
    expect(
      isLanguageUnsetBody(409, JSON.stringify({ error: 'Voices need a language first', code: 'language_unset' })),
    ).toBe(true);
  });

  it('rejects a 409 whose body is NOT about an unset language (guard must not fire on every 409)', () => {
    expect(isLanguageUnsetBody(409, JSON.stringify({ error: 'analysis already running' }))).toBe(false);
    expect(isLanguageUnsetBody(409, JSON.stringify({ error: 'collision' }))).toBe(false);
  });

  it('rejects non-JSON bodies and non-409 statuses', () => {
    expect(isLanguageUnsetBody(500, JSON.stringify({ error: 'language_unset' }))).toBe(false);
    expect(isLanguageUnsetBody(409, '<html>gateway timeout</html>')).toBe(false);
  });
});

describe('language-guard bus', () => {
  it('routes a request to the registered handler and reports it was accepted', () => {
    const handler = vi.fn(() => true);
    setLanguageGuardHandler(handler);
    const req = { selector: { bookId: 'b1' }, shape: '409' as const, onRetry: () => {} };
    expect(emitLanguageGuard(req)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(req);
    setLanguageGuardHandler(null);
  });

  it('reports false (no handling) when no handler is mounted', () => {
    setLanguageGuardHandler(null);
    expect(
      emitLanguageGuard({ selector: { bookId: 'b1' }, shape: '409', onRetry: () => {} }),
    ).toBe(false);
  });

  it('reports false when the handler refuses the request (selector matched no library book)', () => {
    const handler = vi.fn(() => false);
    setLanguageGuardHandler(handler);
    expect(
      emitLanguageGuard({ selector: { manuscriptId: 'm_unknown' }, shape: '409', onRetry: () => {} }),
    ).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    setLanguageGuardHandler(null);
  });
});
