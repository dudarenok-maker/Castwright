/* srv-20 (plan 188 / BACKLOG #425) — optional shared-secret token guard
   for the opt-in LAN exposure surface.

   OFF by default: the guard enforces ONLY when LAN HTTPS mode is on AND a
   token is configured via `LAN_AUTH_TOKEN`. So `npm start` (loopback) and
   existing LAN users who haven't set the env are completely unaffected —
   enabling it is a deliberate opt-in. Loopback requests always bypass.

   Mounted on `/api` + `/workspace`. `/cert/root.crt` (the public mkcert CA
   the companion fetches over the untrusted bootstrap channel *before* it
   can pin + present a token) and `/audio` are deliberately NOT guarded. */
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCookie } from 'cookie';
import type { Request, Response, NextFunction } from './http.js';
import { isLanHttpsEnabled } from './routes/export-lan.js';
import { isValidDeviceToken } from './workspace/device-tokens.js';

/* The configured shared secret, or undefined when unset/empty. */
export function getLanAuthToken(): string | undefined {
  const t = process.env.LAN_AUTH_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/* Default persistence: append LAN_AUTH_TOKEN=<token> to the .env file so it
   survives restarts (device pairings keyed to it stay valid). We only reach here
   when the file has NO LAN_AUTH_TOKEN line (getLanAuthToken() returned undefined),
   so a plain append can't produce a duplicate key. Injectable for tests. */
function appendTokenToEnv(envPath: string, line: string): void {
  const needsNl = existsSync(envPath) && !readFileSync(envPath, 'utf8').endsWith('\n');
  appendFileSync(envPath, `${needsNl ? '\n' : ''}${line}\n`, 'utf8');
}

/** When LAN HTTPS is REQUESTED but no `LAN_AUTH_TOKEN` is configured, mint a random
 *  256-bit token, set it on `process.env`, and persist it to `envPath` so it's
 *  stable across restarts. This closes the hole where LAN-on-without-a-token leaves
 *  `requireLanToken` a no-op and the whole `/api` reachable UNAUTHENTICATED from the
 *  LAN. No-op when LAN is off (dev/test, or explicit `LAN_HTTPS=0`) or a token
 *  already exists. Returns the effective token, or undefined when LAN is off.
 *  `persist` is injectable so tests don't touch the real .env. */
export function ensureLanAuthToken(
  envPath: string = resolve(process.cwd(), '.env'),
  persist: (envPath: string, line: string) => void = appendTokenToEnv,
): string | undefined {
  if (!isLanHttpsEnabled()) return undefined;
  const existing = getLanAuthToken();
  if (existing !== undefined) return existing;
  const token = randomBytes(32).toString('hex');
  process.env.LAN_AUTH_TOKEN = token;
  try {
    persist(envPath, `LAN_AUTH_TOKEN=${token}`);
  } catch (err) {
    console.warn(
      `[server] could not persist LAN_AUTH_TOKEN to ${envPath}: ${(err as Error).message} — ` +
        `it will regenerate next boot (paired devices would need to re-pair).`,
    );
  }
  return token;
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
