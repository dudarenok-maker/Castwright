import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors the plain-function mock style used by sibling route/middleware
// tests (e.g. pairing.test.ts, lan-auth.test.ts) — configValue is a
// synchronous read, so a vi.fn() swap is enough, no async setup needed.
const mockConfigValue = vi.fn();
vi.mock('../config/resolver.js', () => ({
  configValue: (key: string) => mockConfigValue(key),
}));

import { requireVoiceLibraryEnabled } from './voice-library-gate.js';

function mkRes() {
  const res = { statusCode: 200, body: undefined as unknown };
  return {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(body: unknown) {
      res.body = body;
      return this;
    },
    _res: res,
  };
}

describe('requireVoiceLibraryEnabled', () => {
  beforeEach(() => {
    mockConfigValue.mockReset();
  });

  it('404s with an actionable body and never calls next() when the setting is off', () => {
    mockConfigValue.mockReturnValue(false);
    let called = false;
    const res = mkRes();

    requireVoiceLibraryEnabled({} as never, res as never, () => {
      called = true;
    });

    expect(mockConfigValue).toHaveBeenCalledWith('voices.library.enabled');
    expect(called).toBe(false);
    expect(res._res.statusCode).toBe(404);
    expect(res._res.body).toEqual({ error: 'voice library disabled' });
  });

  it('calls next() and does not respond when the setting is on (default)', () => {
    mockConfigValue.mockReturnValue(true);
    let called = false;
    const res = mkRes();

    requireVoiceLibraryEnabled({} as never, res as never, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(res._res.statusCode).toBe(200);
    expect(res._res.body).toBeUndefined();
  });
});
