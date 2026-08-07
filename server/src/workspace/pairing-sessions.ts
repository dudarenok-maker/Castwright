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

/** Un-consume a just-redeemed session so a failed downstream mint (e.g. the
 *  device store being unreadable) doesn't burn the one-time code. Only
 *  meaningful immediately after `redeemPairingSession` returned `ok: true`
 *  for this exact code -- the caller is responsible for calling it only
 *  from that failure path, not speculatively. A no-op if the session has
 *  since been swept (consumed sessions are only reaped by the next
 *  `createPairingSession` call, so this is safe to call synchronously
 *  right after a same-tick failure). Deliberately does NOT re-run the
 *  redeem/consume step atomically with anything else: the original
 *  `redeemPairingSession` call already closed the single-use race for
 *  every OTHER caller of the same code by consuming it synchronously the
 *  moment it was read; this only widens the window during which the code
 *  remains valid again, back up to its original TTL, for the one caller
 *  who legitimately holds it and hasn't gotten a device yet. */
export function restorePairingSession(code: string): void {
  const s = sessions.get(code);
  if (s) s.consumed = false;
}

export function _resetPairingSessionsForTests(): void {
  sessions.clear();
}
