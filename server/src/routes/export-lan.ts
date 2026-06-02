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
   the first. In LAN HTTPS mode the server binds all interfaces (0.0.0.0,
   see bind-host.ts), so any of these IPs reaches us. (Plain HTTP dev mode
   binds loopback only since srv-19 — these LAN URLs are for the LAN_HTTPS
   flow, which is exactly when this endpoint is meant to be used.)

   Plan 81 mobile + tablet support: when LAN_HTTPS=1 is set, the protocol
   becomes `https` and the default port becomes 8443 to match Node's
   https.createServer listener. The user-visible LAN access protocol
   for the mobile + tablet round runs over HTTPS (mkcert local CA so
   browsers don't show "Not Secure" warnings and clipboard / file-picker
   / mic / camera APIs become available on phone Safari/Chrome). */

import { networkInterfaces } from 'node:os';
import { Router } from 'express';
import type { Request, Response } from '../http.js';

export const exportLanRouter = Router();

export interface ExportLanInfo {
  urls: string[];
  port: number;
  protocol: 'http' | 'https';
}

export function isLanHttpsEnabled(): boolean {
  return process.env.LAN_HTTPS === '1';
}

export function enumerateLanUrls(port: number, protocol: 'http' | 'https' = 'http'): ExportLanInfo {
  const urls: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      if (iface.address.startsWith('169.254.')) continue;
      urls.push(`${protocol}://${iface.address}:${port}`);
    }
  }
  return { urls, port, protocol };
}

exportLanRouter.get('/lan', (_req: Request, res: Response) => {
  const httpsMode = isLanHttpsEnabled();
  const port = httpsMode
    ? Number(process.env.LAN_HTTPS_PORT ?? 8443)
    : Number(process.env.PORT ?? 8080);
  const protocol: 'http' | 'https' = httpsMode ? 'https' : 'http';
  res.json(enumerateLanUrls(port, protocol));
});
