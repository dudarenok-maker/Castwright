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
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { resolveRootCaPath } from './cert-root.js';

export const exportLanRouter = Router();

export interface ExportLanInfo {
  urls: string[];
  port: number;
  protocol: 'http' | 'https';
  /* srv-20 — the shared-secret LAN token, present only when LAN_AUTH_TOKEN is
     configured. The companion pairing QR carries it so a device can
     authenticate to the (otherwise guarded) /api surface. */
  token?: string;
  /* srv-20 — the LAN CA's SHA-256 (X.509 fingerprint256), present only when the
     mkcert root CA is resolvable. A pairing client fetches /cert/root.crt,
     computes the same fingerprint, and pins ONLY if it matches (no manual
     hex compare, no OS cert install). */
  caFingerprint?: string;
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

/* srv-20 — the configured shared-secret token (or undefined). Read directly
   from env (not via lan-auth) to avoid a circular import (lan-auth already
   imports isLanHttpsEnabled from here). */
function lanAuthToken(): string | undefined {
  const t = process.env.LAN_AUTH_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/* srv-20 — the LAN CA's SHA-256 fingerprint (standard X.509 fingerprint256).
   Best-effort: undefined when the mkcert CA can't be located / read / parsed. */
export function lanCaFingerprint(): string | undefined {
  try {
    const ca = resolveRootCaPath();
    if (!ca) return undefined;
    return new X509Certificate(readFileSync(ca.path)).fingerprint256;
  } catch {
    return undefined;
  }
}

exportLanRouter.get('/lan', (_req: Request, res: Response) => {
  const httpsMode = isLanHttpsEnabled();
  const port = httpsMode
    ? Number(process.env.LAN_HTTPS_PORT ?? 8443)
    : Number(process.env.PORT ?? 8080);
  const protocol: 'http' | 'https' = httpsMode ? 'https' : 'http';
  const token = lanAuthToken();
  const caFingerprint = lanCaFingerprint();
  res.json({
    ...enumerateLanUrls(port, protocol),
    ...(token !== undefined ? { token } : {}),
    ...(caFingerprint !== undefined ? { caFingerprint } : {}),
  });
});
