/* srv-33 (plan 188) — companion device-token management.

   Mounted under `/api`, so these routes sit behind the srv-20 LAN guard: only
   a caller already holding the shared secret (or an existing device token), or
   a loopback caller (the local admin UI), can mint/list/revoke devices.

     GET    /api/devices        — list paired devices (no secrets)
     POST   /api/devices        — mint a new per-device token (returned ONCE)
     DELETE /api/devices/:id     — revoke a device

   Reconcile, not absorb: the srv-20 shared secret keeps working; this is the
   multi-device refinement layered on top. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { createDevice, listDevices, revokeDevice } from '../workspace/device-tokens.js';

export const devicesRouter = Router();

devicesRouter.get('/devices', (_req: Request, res: Response) => {
  res.json({ devices: listDevices() });
});

devicesRouter.post('/devices', async (req: Request, res: Response) => {
  const raw = (req.body as { label?: unknown } | undefined)?.label;
  const label = typeof raw === 'string' ? raw : 'Device';
  const { device, token } = await createDevice(label, 30);
  // The raw token is shown exactly once — only its hash is persisted.
  res.status(201).json({ ...device, token });
});

devicesRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  const ok = await revokeDevice(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Unknown device.' });
    return;
  }
  res.json({ ok: true });
});
