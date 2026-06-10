import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPairingSession,
  redeemPairingSession,
  _resetPairingSessionsForTests,
} from './pairing-sessions.js';

describe('pairing-sessions', () => {
  beforeEach(() => _resetPairingSessionsForTests());

  it('creates a session with an 8-char code and future expiry', () => {
    const now = 1_000_000;
    const s = createPairingSession(now);
    expect(s.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(s.expiresAt).toBeGreaterThan(now);
  });

  it('redeems a valid code exactly once', () => {
    const now = 1_000_000;
    const { code } = createPairingSession(now);
    expect(redeemPairingSession(code, now + 1)).toEqual({ ok: true });
    expect(redeemPairingSession(code, now + 2)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('rejects an unknown code', () => {
    expect(redeemPairingSession('ZZZZZZZZ', 1)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired code', () => {
    const now = 1_000_000;
    const { code, expiresAt } = createPairingSession(now);
    expect(redeemPairingSession(code, expiresAt + 1)).toEqual({ ok: false, reason: 'expired' });
  });
});
