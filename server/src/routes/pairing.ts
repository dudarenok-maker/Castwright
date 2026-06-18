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
import rateLimit from 'express-rate-limit';
import type { Request, Response } from '../http.js';
import { isLanHttpsEnabled, enumerateLanUrls } from './export-lan.js';
import { resolveRootCaPath } from './cert-root.js';
import { crockfordBase32 } from '../lib/crockford-base32.js';
import { createPairingSession, redeemPairingSession } from '../workspace/pairing-sessions.js';
import { createDevice, clampTtlDays } from '../workspace/device-tokens.js';
import { isLoopbackRequest, isLanTokenEnforced, isPrivateNetworkRequest } from '../lan-auth.js';
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
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Pairing sessions can only be created from the host UI.' });
    return;
  }
  if (!isLanHttpsEnabled()) {
    res.status(409).json({ error: 'not-lan-https' });
    return;
  }
  const { urls, port } = enumerateLanUrls(Number(process.env.LAN_HTTPS_PORT ?? 8443), 'https');
  const host = urls[0]?.replace(/^https:\/\//, '');
  const fpTag = caFingerprintTag();
  if (!host || !fpTag) {
    res.status(409).json({ error: !host ? 'no-lan-url' : 'no-ca' });
    return;
  }
  const { code, expiresAt } = createPairingSession();
  const q = new URLSearchParams({ h: host, c: code, f: fpTag });
  const qrPayload = `https://www.castwright.ai/pair?${q.toString()}`;
  res.json({ qrPayload, hostPort: host, port, code, fpTag, expiresAt });
});

export const pairRedeemRouter = Router();

pairRedeemRouter.post('/redeem', express.json({ limit: '1kb' }), async (req: Request, res: Response) => {
  if (!isPrivateNetworkRequest(req)) {
    res.status(403).json({ error: 'Pairing can only be redeemed from the local network.' });
    return;
  }
  const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const label = typeof body.label === 'string' ? body.label : 'Device';
  const result = redeemPairingSession(code);
  if (!result.ok) {
    const status = result.reason === 'unknown' ? 401 : 410;
    res.status(status).json({ error: result.reason });
    return;
  }
  const { token } = await createDevice(label, ttl());
  res.status(201).json({ token });
});

// dedicated limiter — NOT skipped under Vitest (the global apiLimiter is).
// Exported so tests can reset its store between cases (shared IP under supertest).
export const browserRedeemLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? 'unknown',
});

pairRedeemRouter.post(
  '/redeem-browser',
  browserRedeemLimiter,
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
    const { device, token } = await createDevice(result.label ?? 'Device', ttlDays);
    res.cookie('__Host-cw_lan', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttlDays * 86_400_000,
    });
    res.status(201).json({ label: device.label, expiresAt: device.expiresAt });
  },
);
