/* Dependency-free home of the loopback check, so lan-paths.ts can use it without
   importing lan-auth.ts (which pulls routes/export-lan.ts > routes/cert-root.ts back
   into lan-paths.ts: an import cycle, #4446). lan-auth.ts re-exports it. */
import type { Request } from './http.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/* Assumes a direct (un-proxied) bind — `req.ip` is the real remote address. */
export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(ip);
}
