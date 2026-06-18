/* srv-20 (plan 188 / BACKLOG #425) — optional shared-secret token guard
   for the opt-in LAN exposure surface.

   OFF by default: the guard enforces ONLY when LAN HTTPS mode is on AND a
   token is configured via `LAN_AUTH_TOKEN`. So `npm start` (loopback) and
   existing LAN users who haven't set the env are completely unaffected —
   enabling it is a deliberate opt-in. Loopback requests always bypass.

   Mounted on `/api` + `/workspace`. `/cert/root.crt` (the public mkcert CA
   the companion fetches over the untrusted bootstrap channel *before* it
   can pin + present a token) and `/audio` are deliberately NOT guarded. */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from './http.js';
import { isLanHttpsEnabled } from './routes/export-lan.js';
import { isValidDeviceToken } from './workspace/device-tokens.js';

/* The configured shared secret, or undefined when unset/empty. */
export function getLanAuthToken(): string | undefined {
  const t = process.env.LAN_AUTH_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(ip);
}

/* Loopback + RFC1918 IPv4 — the LAN reachability the phone uses to redeem.
   NOTE: relies on `req.ip` being the real socket peer — do NOT enable Express
   `trust proxy`, or `X-Forwarded-For` could forge this (same invariant the
   loopback gate depends on; keep them consistent).
   Coupling: this IPv4-only allowlist mirrors `enumerateLanUrls` (IPv4-only, no
   link-local) and Task 8's client-side `_isPrivateIpv4Host` — the two layers
   share this assumption, so if LAN URLs ever gain IPv6/CGNAT both must widen. */
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./];
export function isPrivateNetworkRequest(req: Request): boolean {
  let ip = req.ip ?? req.socket?.remoteAddress ?? '';
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip === '::1') return true;
  return PRIVATE_V4.some((re) => re.test(ip));
}

/* Pull the token from `Authorization: Bearer …`, the `X-Lan-Token`
   header, or a `?token=` query param (the QR can carry it either way). */
export function extractToken(req: Request): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t.length > 0) return t;
  }
  const header = req.headers['x-lan-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* True when the guard is live for this process (LAN mode + token set). */
export function isLanTokenEnforced(): boolean {
  return isLanHttpsEnabled() && getLanAuthToken() !== undefined;
}

export function requireLanToken(req: Request, res: Response, next: NextFunction): void {
  if (!isLanTokenEnforced()) return next();
  if (isLoopbackRequest(req)) return next();
  const provided = extractToken(req);
  if (provided !== undefined) {
    /* Legacy shared secret (srv-20) … */
    const expected = getLanAuthToken();
    if (expected !== undefined && safeEqual(provided, expected)) return next();
    /* … or an individually-revocable per-device token (srv-33). */
    if (isValidDeviceToken(provided)) return next();
  }
  res.status(401).json({ error: 'Missing or invalid LAN access token.' });
}
