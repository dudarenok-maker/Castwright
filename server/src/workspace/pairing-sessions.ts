/* In-memory ephemeral pairing sessions for the companion QR redesign.

   A session is a single-use, time-boxed `code` that authorises minting ONE
   per-device token via POST /api/pair/redeem. We deliberately persist nothing:
   a pre-auth secret should never hit disk, and losing pending sessions on a
   restart is harmless (re-open the desktop modal). `now` is injected so the
   store is unit-testable without a clock. */
import { randomBytes } from 'node:crypto';
import { crockfordBase32 } from '../lib/crockford-base32.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Session {
  expiresAt: number;
  consumed: boolean;
  label?: string;
}

const sessions = new Map<string, Session>();

function sweep(now: number): void {
  for (const [code, s] of sessions) {
    if (s.consumed || now > s.expiresAt) sessions.delete(code);
  }
}

export interface NewPairingSession {
  code: string;
  expiresAt: number;
  label?: string;
}

export function createPairingSession(
  label?: string,
  now: number = Date.now(),
  bytes = 5,
): NewPairingSession {
  sweep(now);
  const code = crockfordBase32(randomBytes(bytes)); // 5→8 chars (companion), 10→16 chars (browser)
  const expiresAt = now + TTL_MS;
  sessions.set(code, { expiresAt, consumed: false, label });
  return { code, expiresAt, label };
}

export type RedeemResult =
  | { ok: true; label?: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'consumed' };

export function redeemPairingSession(code: string, now: number = Date.now()): RedeemResult {
  const s = sessions.get(code);
  if (!s) return { ok: false, reason: 'unknown' };
  if (s.consumed) return { ok: false, reason: 'consumed' };
  if (now > s.expiresAt) {
    sessions.delete(code);
    return { ok: false, reason: 'expired' };
  }
  s.consumed = true;
  return { ok: true, label: s.label };
}

export function _resetPairingSessionsForTests(): void {
  sessions.clear();
}
