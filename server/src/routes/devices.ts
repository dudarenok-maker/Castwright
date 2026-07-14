/* srv-33 (plan 188) — companion device-token management.

   Mounted under `/api`, so these routes sit behind the srv-20 LAN guard: only
   a caller already holding the shared secret (or an existing device token), or
   a loopback caller (the local admin UI), can mint/list/revoke devices.

     GET    /api/devices        — list paired devices (no secrets)
     POST   /api/devices        — mint a new per-device token (returned ONCE)
     DELETE /api/devices/:id     — revoke a device
     POST   /api/devices/pair-session — create a QR pairing session (loopback-only)

   Reconcile, not absorb: the srv-20 shared secret keeps working; this is the
   multi-device refinement layered on top. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { createDevice, listDevices, revokeDevice, clampTtlDays } from '../workspace/device-tokens.js';
import { createPairingSession } from '../workspace/pairing-sessions.js';
import {
  isLanTokenEnforced,
  isLoopbackRequest,
  mayStartPairingSession,
  PAIRING_ORIGIN_HINT,
} from '../lan-auth.js';
import { enumerateLanUrls } from './export-lan.js';
import { getLanRuntime } from '../lan-runtime.js';
import { configValue } from '../config/resolver.js';

export const devicesRouter = Router();

devicesRouter.get('/devices', (_req: Request, res: Response) => {
  res.json({ devices: listDevices() });
});

// admin mint — LOOPBACK-ONLY (defense-in-depth: a stolen browser cookie must NOT
// be able to mint a fresh, durable device token that survives revoking the stolen
// one — minting stays a physical-desktop capability), and clamps the TTL.
devicesRouter.post('/devices', async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Devices can only be minted from the host UI.' });
    return;
  }
  const raw = (req.body as { label?: unknown } | undefined)?.label;
  const label = typeof raw === 'string' ? raw : 'Device';
  const ttl = clampTtlDays(configValue('lan.deviceTokenTtlDays'));
  const { device, token } = await createDevice(label, ttl);
  // The raw token is shown exactly once — only its hash is persisted.
  res.status(201).json({ ...device, token });
});

// browser pairing session — startable from loopback (the host UI) OR an already-paired
// device on the friendly hostname (see mayStartPairingSession); requires enforcement so
// the cookie is meaningful + HTTPS. Bare-LAN-IP access stays loopback-only.
devicesRouter.post('/devices/pair-session', (req: Request, res: Response) => {
  if (!mayStartPairingSession(req)) {
    res.status(403).json({ error: PAIRING_ORIGIN_HINT });
    return;
  }
  if (!isLanTokenEnforced()) {
    res.status(409).json({ error: 'lan-auth-not-enforced' });
    return;
  }
  // Use the ACTUAL bound runtime (like pairing.ts / GET /lan), not a hardcoded 8443:
  // a cert-less box degraded to loopback HTTP would otherwise hand out a dead
  // https://<ip>:8443 pairing URL.
  const { httpsActive, port } = getLanRuntime();
  if (!httpsActive) {
    res.status(409).json({ error: 'not-lan-https' });
    return;
  }
  const { urls } = enumerateLanUrls(port, 'https');
  const host = urls[0]?.replace(/^https:\/\//, '');
  if (!host) {
    res.status(409).json({ error: 'no-lan-url' });
    return;
  }
  const label = typeof (req.body as { label?: unknown })?.label === 'string'
    ? (req.body as { label: string }).label : 'Device';
  const { code, expiresAt } = createPairingSession(label, undefined, 10);
  const isFriendlyHostnameReachable = req.app.get('isFriendlyHostnameReachable') as
    (() => boolean) | undefined;
  const friendlyUrl = isFriendlyHostnameReachable?.() === true
    ? `https://castwright.local/#/pair?c=${code}`
    : undefined;
  res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt, friendlyUrl });
});

devicesRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  const ok = await revokeDevice(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Unknown device.' });
    return;
  }
  res.json({ ok: true });
});
