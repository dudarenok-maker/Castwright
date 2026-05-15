/* GET /api/export/lan — enumerate reachable LAN URLs.

   The export modal renders the first non-loopback IPv4 URL as a clickable
   link + QR code so the user can scan it with Chrome on their Android
   phone, download the audiobook zip over Wi-Fi, and open it with the
   PocketBook Reader Android app. We filter out:
   - 127.x  (loopback — useless from another device)
   - 169.254.x (link-local autoconfig — usually means "no DHCP"; not
     reachable from the user's phone)
   - IPv6 link-local (fe80::) and the unique-local fc00::/7 (router
     mostly doesn't advertise these to phones)

   Order matches `os.networkInterfaces()` enumeration — the modal picks
   the first. Server defaults to listening on all interfaces (Node's
   `app.listen(port)` binds 0.0.0.0), so any of these IPs reaches us. */

import { networkInterfaces } from 'node:os';
import { Router, type Request, type Response } from 'express';

export const exportLanRouter = Router();

export interface ExportLanInfo {
  urls: string[];
  port: number;
}

export function enumerateLanUrls(port: number): ExportLanInfo {
  const urls: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      if (iface.address.startsWith('169.254.')) continue;
      urls.push(`http://${iface.address}:${port}`);
    }
  }
  return { urls, port };
}

exportLanRouter.get('/lan', (_req: Request, res: Response) => {
  const port = Number(process.env.PORT ?? 8080);
  res.json(enumerateLanUrls(port));
});
