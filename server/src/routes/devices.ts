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
import {
  createDevice,
  listDevices,
  revokeDevice,
  clampTtlDays,
  DeviceStoreDegradedError,
} from '../workspace/device-tokens.js';
import { createPairingSession } from '../workspace/pairing-sessions.js';
import {
  FRIENDLY_HOSTNAME,
  isLanTokenEnforced,
  isLoopbackRequest,
  mayStartPairingSession,
  PAIRING_ORIGIN_HINT,
} from '../lan-auth.js';
import { enumerateLanUrls } from './export-lan.js';
import { getLanRuntime } from '../lan-runtime.js';
import { configValue } from '../config/resolver.js';

export const devicesRouter = Router();

// #2204 review (F2/F7) — a degraded store must answer 503 with the reason,
// not the shape of a genuine result: 200/{devices:[]} (list), 404 "Unknown
// device." (revoke), or an opaque 500 (mint) all lie about what happened.
function respondIfDegraded(res: Response, err: unknown): boolean {
  if (err instanceof DeviceStoreDegradedError) {
    res.status(503).json({ error: err.message });
    return true;
  }
  return false;
}

devicesRouter.get('/devices', (_req: Request, res: Response) => {
  try {
    res.json({ devices: listDevices() });
  } catch (err) {
    if (!respondIfDegraded(res, err)) throw err;
  }
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
  try {
    const { device, token } = await createDevice(label, ttl);
    // The raw token is shown exactly once — only its hash is persisted.
    res.status(201).json({ ...device, token });
  } catch (err) {
    if (!respondIfDegraded(res, err)) throw err;
  }
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
  // Server-derived, never client-asserted alone: both loopback (the security
  // gate — mayStartPairingSession above also admits an already-paired device
  // on castwright.local, so without this conjunct any LAN phone could set
  // selfBind and later revoke the host's own credential) AND the client's
  // explicit ask (this route serves both the "Authorize this browser" self-bind
  // and the QR panel's cross-device pairing, which must NOT self-bind) are
  // required. A loopback caller is already exempt from the LAN guard, so
  // letting it set this flag grants nothing it didn't already have.
  const selfBind = isLoopbackRequest(req) && (req.body as { selfBind?: unknown })?.selfBind === true;
  const { code, expiresAt } = createPairingSession(label, undefined, 10, selfBind);
  const liveness = req.app.get('friendlyHostnameLiveness') as
    (() => { mdns: boolean; forwarder: boolean }) | undefined;
  const live = liveness?.();
  // mDNS resolves the name; the :443 forwarder is what makes the port
  // implicit. With the responder up and the forwarder down,
  // https://castwright.local:<bound port> still works — emit that rather
  // than dropping the friendly flow entirely (#2258).
  const friendlyUrl = live?.mdns
    ? `https://${FRIENDLY_HOSTNAME}${live.forwarder ? '' : `:${port}`}/#/pair?c=${code}`
    : undefined;
  res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt, friendlyUrl });
});

// revoke — LOOPBACK-ONLY, symmetric with the mint route above (#2269): a
// stolen browser cookie that cannot mint a fresh token must equally not be
// able to revoke the legitimate owner's, which is the denial-of-service half
// of the same threat model the mint comment names.
devicesRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Devices can only be revoked from the host UI.' });
    return;
  }
  try {
    const ok = await revokeDevice(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Unknown device.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (!respondIfDegraded(res, err)) throw err;
  }
});
