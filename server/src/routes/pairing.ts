/* Companion pairing routes (QR redesign).

   POST /api/pair/session  — loopback-only (the desktop UI). Mints an ephemeral
     code, computes the 80-bit CA fingerprint tag, returns the compact QR
     payload string the modal renders. Mints NO device token.
   POST /api/pair/redeem   — guard-exempt (an unpaired device holds only the
     code). Gated by the code; mints a per-device token over the caller's
     already-cert-pinned channel.

   The redeem router MUST be mounted BEFORE the `/api` LAN-token guard in
   index.ts; the session router AFTER it. */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { isLanHttpsEnabled, enumerateLanUrls } from './export-lan.js';
import { resolveRootCaPath } from './cert-root.js';
import { crockfordBase32 } from '../lib/crockford-base32.js';
import { createPairingSession, redeemPairingSession } from '../workspace/pairing-sessions.js';
import { createDevice } from '../workspace/device-tokens.js';
import { isLoopbackRequest } from '../lan-auth.js';

/** First 10 bytes (80 bits) of the CA cert's SHA-256, Crockford-base32. */
export function caFingerprintTag(): string | undefined {
  try {
    const ca = resolveRootCaPath();
    if (!ca) return undefined;
    const hex = new X509Certificate(readFileSync(ca.path)).fingerprint256; // "AB:CD:.."
    const bytes = Buffer.from(hex.replace(/:/g, ''), 'hex');
    return crockfordBase32(bytes.subarray(0, 10));
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
  const qrPayload = `CWP1*${host}*${code}*${fpTag}`;
  res.json({ qrPayload, hostPort: host, port, code, fpTag, expiresAt });
});

export const pairRedeemRouter = Router();

pairRedeemRouter.post('/redeem', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const label = typeof body.label === 'string' ? body.label : 'Device';
  const result = redeemPairingSession(code);
  if (!result.ok) {
    const status = result.reason === 'unknown' ? 401 : 410;
    res.status(status).json({ error: result.reason });
    return;
  }
  const { token } = await createDevice(label, 30);
  res.status(201).json({ token });
});
