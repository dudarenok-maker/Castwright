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
import { parse as parseCookie } from 'cookie';
import type { Request, Response, NextFunction } from './http.js';
import { isLanHttpsEnabled } from './routes/export-lan.js';
import { isValidDeviceToken } from './workspace/device-tokens.js';

/* The configured shared secret, or undefined when unset/empty. */
export function getLanAuthToken(): string | undefined {
  const t = process.env.LAN_AUTH_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/* Assumes a direct (un-proxied) bind — `req.ip` is the real remote address. */
export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(ip);
}

/** Parse the cw_lan cookie defensively — this runs on EVERY /api request, so an
 *  unguarded throw here (e.g. a future `cookie` version that rejects bad input)
 *  would 500 the entire API. cookie@0.7.x doesn't throw, but the catch is cheap
 *  insurance for the hottest path. The same helper also backs the CSRF guard's
 *  cookie detection, so auth and CSRF agree on whether a request carries the cookie. */
export function readCwLanCookie(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return undefined;
  try {
    const v = parseCookie(cookieHeader)['__Host-cw_lan'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/* Pull the token from the `__Host-cw_lan` cookie (first), then
   `Authorization: Bearer …`, the `X-Lan-Token` header, or a `?token=`
   query param (the QR can carry it either way). */
export function extractToken(req: Request): string | undefined {
  const c = readCwLanCookie(req.headers['cookie']);
  if (c !== undefined) return c;
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
