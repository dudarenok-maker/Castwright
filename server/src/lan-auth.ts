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
  const expected = getLanAuthToken();
  const provided = extractToken(req);
  if (expected !== undefined && provided !== undefined && safeEqual(provided, expected)) {
    return next();
  }
  res.status(401).json({ error: 'Missing or invalid LAN access token.' });
}
