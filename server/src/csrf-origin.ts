/* CSRF defense for cookie-authenticated browser requests (LAN device auth).
   Cookie creds auto-attach cross-site; a header/Bearer token (companion) does
   not, so we only gate requests that actually carry the __Host-cw_lan cookie.
   Allow-list = the LAN HTTPS origins + explicit loopback origins, recomputed
   per request (NICs change), never empty. Fail-closed on absent Origin+Referer
   for state-changing methods. */
import type { Request, Response, NextFunction } from './http.js';
import { enumerateLanUrls } from './routes/export-lan.js';
import { readCwLanCookie } from './lan-auth.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedOrigins(): Set<string> {
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
  const loopback = [
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://[::1]:${port}`,
  ];
  try {
    const { urls } = enumerateLanUrls(port, 'https'); // ['https://192.168.x.y:8443', ...]
    return new Set<string>([...urls, ...loopback]);
  } catch {
    // Fail closed: if NIC enumeration ever throws, still allow loopback only —
    // never let an exception turn every cookie-bearing write into a 500.
    return new Set<string>(loopback);
  }
}

function originOf(req: Request): string | undefined {
  const o = req.headers['origin'];
  if (typeof o === 'string' && o.length > 0) return o;
  const r = req.headers['referer'];
  if (typeof r === 'string' && r.length > 0) {
    try { return new URL(r).origin; } catch { return undefined; }
  }
  return undefined;
}

function hasCwLanCookie(req: Request): boolean {
  // Use the SAME parser as the auth guard (readCwLanCookie → cookie.parse), so a
  // cookie that authenticates the request is never treated as "no cookie" here —
  // a regex/parse divergence would silently drop CSRF protection.
  return readCwLanCookie(req.headers['cookie']) !== undefined;
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has((req.method ?? 'GET').toUpperCase())) return next();
  if (!hasCwLanCookie(req)) return next(); // header/Bearer or loopback: not cookie-CSRF-able
  const origin = originOf(req);
  if (origin !== undefined && allowedOrigins().has(origin)) return next();
  res.status(403).json({ error: 'Cross-origin request rejected.' });
}
