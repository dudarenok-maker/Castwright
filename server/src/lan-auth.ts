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
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseCookie } from 'cookie';
import type { Request, Response, NextFunction } from './http.js';
import { isLanHttpsEnabled } from './routes/export-lan.js';
import { isValidDeviceToken } from './workspace/device-tokens.js';

/* The configured shared secret, or undefined when unset/empty. */
export function getLanAuthToken(): string | undefined {
  const t = process.env.LAN_AUTH_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/* Read a token from the shared token file, or undefined if absent/empty/unreadable. */
function readTokenFile(tokenFile: string): string | undefined {
  try {
    const t = readFileSync(tokenFile, 'utf8').trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/** When LAN HTTPS is REQUESTED but no `LAN_AUTH_TOKEN` is configured, mint a random
 *  256-bit token, set it on `process.env`, and persist it to `tokenFile` so it's
 *  stable. This closes the hole where LAN-on-without-a-token leaves `requireLanToken`
 *  a no-op and the whole `/api` reachable UNAUTHENTICATED from the LAN.
 *
 *  `tokenFile` MUST be a cross-release location (index.ts passes the shared run dir,
 *  which honours APP_RUN_DIR) — NOT the per-release `server/.env`, or a versioned
 *  upgrade would re-mint and force every paired device to re-pair. Precedence:
 *  (1) an explicit `LAN_AUTH_TOKEN` env value always wins; (2) an existing token
 *  file is adopted; (3) otherwise mint + write the file with an EXCLUSIVE create so
 *  a concurrent boot can't clobber it — if another process won the race we re-read
 *  and adopt theirs, so both converge on one token. No-op (undefined) when LAN is off. */
export function ensureLanAuthToken(
  tokenFile: string = resolve(process.cwd(), '.lan-auth-token'),
): string | undefined {
  if (!isLanHttpsEnabled()) return undefined;
  const fromEnv = getLanAuthToken();
  if (fromEnv !== undefined) return fromEnv;
  const fromFile = readTokenFile(tokenFile);
  if (fromFile !== undefined) {
    process.env.LAN_AUTH_TOKEN = fromFile;
    return fromFile;
  }
  // Mint + persist. Always via EXCLUSIVE create (flag 'wx') so concurrent boots
  // converge on ONE token instead of the last-writer-wins divergence a plain 'w'
  // overwrite causes (an earlier writer could adopt its own token in-memory, then a
  // later writer clobbers the disk → paired devices 401 on the next restart). The
  // exclusive winner keeps its token; every loser RE-READS and adopts the winner's.
  // An empty/corrupt file (external truncate/`touch`) is removed and re-created
  // exclusively rather than overwritten, so self-heal never introduces divergence.
  try {
    mkdirSync(dirname(tokenFile), { recursive: true });
  } catch {
    /* fall through — the write attempts below surface the real failure */
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', flag: 'wx' });
      process.env.LAN_AUTH_TOKEN = token; // we exclusively created it — it is ours
      return token;
    } catch {
      // The file already exists. A valid token there is the convergence point —
      // adopt it. An empty/corrupt file gets removed so the next iteration can
      // re-create it exclusively.
      const existing = readTokenFile(tokenFile);
      if (existing !== undefined) {
        process.env.LAN_AUTH_TOKEN = existing;
        return existing;
      }
      try {
        rmSync(tokenFile, { force: true });
      } catch {
        /* another boot may have removed it already — retry the exclusive create */
      }
    }
  }
  // Persistently unwritable/contended — still guard the API this run in-memory.
  const fallback = randomBytes(32).toString('hex');
  process.env.LAN_AUTH_TOKEN = fallback;
  console.warn(
    `[server] could not persist the LAN auth token to ${tokenFile} — it will regenerate ` +
      `next boot (paired devices would need to re-pair).`,
  );
  return fallback;
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
