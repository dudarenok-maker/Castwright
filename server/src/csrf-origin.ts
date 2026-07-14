/* CSRF defense for cookie-authenticated browser requests (LAN device auth).
   Cookie creds auto-attach cross-site; a header/Bearer token (companion) does
   not, so we only gate requests that actually carry the __Host-cw_lan cookie.
   Allow-list = the LAN HTTPS origins + explicit loopback origins, recomputed
   per request (NICs change), never empty. Fail-closed on absent Origin+Referer
   for state-changing methods. */
import type { Request, Response, NextFunction } from './http.js';
import { enumerateLanUrls } from './routes/export-lan.js';
import { readCwLanCookie } from './lan-auth.js';
import { getLanRuntime } from './lan-runtime.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* castwright-local-port-cert follow-up: castwright.dev.local is a dev-only
   hostname (only ever resolvable via the dev-only mDNS responder `dev:lan`
   spawns — never advertised in production/start:lan), and its port varies
   per-worktree (scripts/wt-new.mjs writes a per-worktree VITE_PORT into the
   worktree's root .env.local so parallel `npm run dev`/`dev:lan` don't
   collide on 5173). The server process never sees that VITE_PORT (it only
   loads server/.env, not the frontend's root .env.local), so a single
   hardcoded-port literal can't track it. Since the hostname itself is
   already fully trusted, widen along the port dimension only: match any
   port on this exact hostname rather than guessing the right number. Does
   NOT touch castwright.local (the production hostname) or anything
   IP-based. */
const DEV_LAN_HOSTNAME_ORIGIN = /^https:\/\/castwright\.dev\.local:\d+$/;

function allowedOrigins(): Set<string> {
  // srv-60: the actual bound port (post auto-rebind), not the start constant —
  // otherwise a device paired on a shifted port 403s on every mutating request.
  const port = getLanRuntime().port;
  const loopback = [
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://[::1]:${port}`,
  ];
  /* castwright-local-port-cert — the friendly hostnames, plus a port-less
     variant of every enumerated LAN IP AND of loopback. All three are
     needed: the port-443 forwarder (server/src/lan-port-forwarder.ts) is
     host-blind, so it makes a bare `https://<lan-ip>`, `https://localhost`,
     and `https://127.0.0.1` reachable in addition to
     `https://castwright.local` — cookies aren't port-scoped, so a session
     cookie minted on the :8443 origin would otherwise 403 on any of those
     bare paths. This matters especially for loopback because the forwarder
     deliberately sources forwarded traffic from 127.0.0.2 (not 127.0.0.1),
     specifically so it does NOT qualify for the isLoopbackRequest()
     auth-exemption — meaning forwarded bare-loopback traffic MUST pass this
     exact origin check. An unused entry here is inert (nobody's Origin will
     ever equal it if that URL isn't actually served), so all of these are
     added unconditionally rather than threading the forwarder's/dev:lan's
     live/dead state into this module. */
  const friendlyHostnames = [
    `https://castwright.local:${port}`,
    'https://castwright.local',
  ];
  const bareLoopback = ['https://localhost', 'https://127.0.0.1', 'https://[::1]'];
  try {
    const { urls } = enumerateLanUrls(port, 'https'); // ['https://192.168.x.y:8443', ...]
    const bareIps = urls.map((u) => u.replace(`:${port}`, ''));
    return new Set<string>([
      ...urls,
      ...bareIps,
      ...friendlyHostnames,
      ...loopback,
      ...bareLoopback,
    ]);
  } catch {
    // Fail closed: if NIC enumeration ever throws, still allow loopback +
    // the friendly hostnames — never let an exception turn every
    // cookie-bearing write into a 500.
    return new Set<string>([...friendlyHostnames, ...loopback, ...bareLoopback]);
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
  if (
    origin !== undefined &&
    (allowedOrigins().has(origin) ||
      // castwright.dev.local is only ever advertised by dev:lan's own mDNS
      // responder (never in a production start:lan deployment) — gate the
      // leniency to non-production so a LAN device that wins an mDNS-spoofing
      // race for that hostname can't get CSRF-approved against a PRODUCTION
      // instance. Mirrors shouldSpawnMdnsResponder/shouldSpawnPortForwarder's
      // identical NODE_ENV===production discriminator for this feature area.
      (process.env.NODE_ENV !== 'production' && DEV_LAN_HOSTNAME_ORIGIN.test(origin)))
  ) {
    return next();
  }
  res.status(403).json({ error: 'Cross-origin request rejected.' });
}
