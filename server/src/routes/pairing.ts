/* Companion pairing routes (QR redesign).

   POST /api/pair/session  — loopback-only (the desktop UI). Mints an ephemeral
     code, computes the 128-bit CA fingerprint tag, returns the compact QR
     payload string the modal renders. Mints NO device token.
   POST /api/pair/redeem   — guard-exempt (an unpaired device holds only the
     code). Gated by the code; mints a per-device token over the caller's
     already-cert-pinned channel.

   The redeem router MUST be mounted BEFORE the `/api` LAN-token guard in
   index.ts; the session router AFTER it. */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from '../http.js';
import { enumerateLanUrls } from './export-lan.js';
import { resolveRootCaPath } from './cert-root.js';
import { getLanRuntime } from '../lan-runtime.js';
import { crockfordBase32 } from '../lib/crockford-base32.js';
import { createPairingSession, redeemPairingSession, restorePairingSession } from '../workspace/pairing-sessions.js';
import { createDevice, clampTtlDays, DeviceStoreDegradedError } from '../workspace/device-tokens.js';
import {
  isLanTokenEnforced,
  isPrivateNetworkRequest,
  mayStartPairingSession,
  PAIRING_ORIGIN_HINT,
} from '../lan-auth.js';
import { configValue } from '../config/resolver.js';

/** Effective TTL for device tokens — clamped to a sane positive integer. */
const ttl = () => clampTtlDays(configValue('lan.deviceTokenTtlDays'));

/** First 16 bytes (128 bits) of the CA cert's SHA-256, Crockford-base32. */
export function caFingerprintTag(): string | undefined {
  try {
    const ca = resolveRootCaPath();
    if (!ca) return undefined;
    const hex = new X509Certificate(readFileSync(ca.path)).fingerprint256; // "AB:CD:.."
    const bytes = Buffer.from(hex.replace(/:/g, ''), 'hex');
    return crockfordBase32(bytes.subarray(0, 16));
  } catch {
    return undefined;
  }
}

export const pairSessionRouter = Router();

pairSessionRouter.post('/session', (req: Request, res: Response) => {
  // Loopback (the host UI) OR an already-paired device on the friendly hostname
  // may start a pairing session; bare-LAN-IP access stays loopback-only.
  if (!mayStartPairingSession(req)) {
    res.status(403).json({ error: PAIRING_ORIGIN_HINT });
    return;
  }
  // Gate on what the server ACTUALLY bound, not the requested flag: a cert-less box
  // degraded to loopback HTTP, so a pairing QR pointing at https://<ip>:8443 would
  // be unscannable/dead. httpsActive true implies the LAN HTTPS port is bound.
  const { httpsActive, port: lanPort } = getLanRuntime();
  if (!httpsActive) {
    res.status(409).json({ error: 'not-lan-https' });
    return;
  }
  const { urls, port } = enumerateLanUrls(lanPort, 'https');
  const host = urls[0]?.replace(/^https:\/\//, '');
  const fpTag = caFingerprintTag();
  if (!host || !fpTag) {
    res.status(409).json({ error: !host ? 'no-lan-url' : 'no-ca' });
    return;
  }
  // The desktop names the device up front (Listen-tab modal) so the admin list
  // reads sensibly; stored on the session and preferred over the phone's own
  // label at redeem time. Absent → falls back to the phone's label, then 'Device'.
  const rawLabel = (req.body as { label?: unknown } | undefined)?.label;
  const label = typeof rawLabel === 'string' ? rawLabel : undefined;
  const { code, expiresAt } = createPairingSession(label);
  const q = new URLSearchParams({ h: host, c: code, f: fpTag });
  const qrPayload = `https://www.castwright.ai/pair?${q.toString()}`;
  res.json({ qrPayload, hostPort: host, port, code, fpTag, expiresAt });
});

export const pairRedeemRouter = Router();

// Dedicated per-IP rate limiter shared by BOTH pre-guard mint endpoints
// (/redeem + /redeem-browser). The global apiLimiter does NOT cover pre-guard
// routes (the router responds before it runs), so without this the code-gated
// mints had no rate cap. NOT skipped under Vitest (the global apiLimiter is).
// Exported so tests can reset its store between cases (shared IP under supertest).
export const redeemLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // express-rate-limit v8 rejects a custom keyGenerator that reads the IP
  // without the ipKeyGenerator helper (ERR_ERL_KEY_GEN_IPV6) — it normalises
  // IPv6 to a /56 subnet so v6 clients can't bypass the cap by rotating the
  // host bits. Fall back to 'unknown' only when req.ip is genuinely absent.
  keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
});

pairRedeemRouter.post('/redeem', redeemLimiter, express.json({ limit: '1kb' }), async (req: Request, res: Response) => {
  if (!isPrivateNetworkRequest(req)) {
    res.status(403).json({ error: 'Pairing can only be redeemed from the local network.' });
    return;
  }
  const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const result = redeemPairingSession(code);
  if (!result.ok) {
    const status = result.reason === 'unknown' ? 401 : 410;
    res.status(status).json({ error: result.reason });
    return;
  }
  // Desktop-chosen session label wins (so the admin list matches what the user
  // named on this machine); otherwise the redeeming device's own label; else 'Device'.
  const label = result.label ?? (typeof body.label === 'string' ? body.label : 'Device');
  try {
    const { token } = await createDevice(label, ttl());
    res.status(201).json({ token });
  } catch (err) {
    // #2204 review (F2/F7, pairing-ordering note) — redeemPairingSession above
    // already consumed the one-time code; if the device store can't actually
    // record the new device, the code must not be burned for nothing (a
    // degraded store today, healthy again in a moment, would otherwise force
    // the user to generate a whole new QR code with no explanation). Restore
    // it so the same code is still redeemable for the rest of its original
    // TTL. This does NOT reopen the single-use race: `redeemPairingSession`
    // already closed that synchronously the moment it ran, for every OTHER
    // caller of this code; restoring only re-opens the window for the ONE
    // caller who legitimately holds it and hasn't gotten a device yet.
    restorePairingSession(code);
    if (err instanceof DeviceStoreDegradedError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
});

pairRedeemRouter.post(
  '/redeem-browser',
  redeemLimiter,
  express.json({ limit: '1kb' }),
  async (req: Request, res: Response) => {
    // Same local-network restriction app-17 applies to /redeem: this sibling
    // mint endpoint must not be redeemable from off-LAN either.
    if (!isPrivateNetworkRequest(req)) {
      res.status(403).json({ error: 'Pairing can only be redeemed from the local network.' });
      return;
    }
    if (!isLanTokenEnforced()) {
      res.status(409).json({ error: 'lan-auth-not-enforced' });
      return;
    }
    const code = typeof (req.body as { code?: unknown })?.code === 'string'
      ? (req.body as { code: string }).code : '';
    const result = redeemPairingSession(code);
    if (!result.ok) {
      res.status(result.reason === 'unknown' ? 401 : 410).json({ error: result.reason });
      return;
    }
    const ttlDays = ttl();
    try {
      const { device, token } = await createDevice(result.label ?? 'Device', ttlDays);
      res.cookie('__Host-cw_lan', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: ttlDays * 86_400_000,
      });
      res.status(201).json({ label: device.label, expiresAt: device.expiresAt });
    } catch (err) {
      // Same restore-on-failure as /redeem above -- see that comment for why
      // this doesn't reopen the single-use race.
      restorePairingSession(code);
      if (err instanceof DeviceStoreDegradedError) {
        res.status(503).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);
