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
    const s = createPairingSession(undefined, now);
    expect(s.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(s.expiresAt).toBeGreaterThan(now);
  });

  it('redeems a valid code exactly once', () => {
    const now = 1_000_000;
    const { code } = createPairingSession(undefined, now);
    expect(redeemPairingSession(code, now + 1)).toEqual({ ok: true, selfBind: false });
    expect(redeemPairingSession(code, now + 2)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('rejects an unknown code', () => {
    expect(redeemPairingSession('ZZZZZZZZ', 1)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired code', () => {
    const now = 1_000_000;
    const { code, expiresAt } = createPairingSession(undefined, now);
    expect(redeemPairingSession(code, expiresAt + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stashes a label and returns it on redeem', () => {
    const { code } = createPairingSession('Mike phone');
    expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'Mike phone', selfBind: false });
  });

  it('mints a 16-char (80-bit) code at bytes=10', () => {
    const { code } = createPairingSession('x', undefined, 10);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('keeps the 8-char companion code at the default bytes', () => {
    const { code } = createPairingSession();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('is single-use: a second redeem of the same code is consumed', () => {
    const { code } = createPairingSession('x');
    expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'x', selfBind: false });
    expect(redeemPairingSession(code)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('reports unknown for a code never minted', () => {
    expect(redeemPairingSession('NEVERMINTED12345')).toEqual({ ok: false, reason: 'unknown' });
  });

  // #2257 — the 4th positional selfBind param travels through to redeem.
  it('carries the selfBind marker from createPairingSession through to redeem', () => {
    const { code } = createPairingSession('This computer', undefined, 10, true);
    expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'This computer', selfBind: true });
  });

  it('defaults selfBind to false when omitted', () => {
    const { code } = createPairingSession('x', undefined, 10);
    expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'x', selfBind: false });
  });
});
