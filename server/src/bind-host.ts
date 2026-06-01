/* srv-19 — choose the network interface the server binds to.

   Default dev mode (plain HTTP) binds loopback only (`127.0.0.1`) so the
   unauthenticated API + the `/workspace` static mount (all manuscripts /
   audio / state.json / cast.json) are NOT reachable by other machines on a
   shared/untrusted LAN. The opt-in LAN HTTPS mobile flow is *meant* to be
   reachable, so it keeps binding all interfaces (`0.0.0.0`). Power users can
   restore all-interface plain HTTP with `BIND_HOST=0.0.0.0` (or `HOST=…`).

   See docs/security/2026-05-31-security-review.md findings #1 + #2. */
export function selectBindHost(
  lanHttps: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (lanHttps) return '0.0.0.0'; // LAN HTTPS flow unchanged — meant to be reachable
  return env.BIND_HOST ?? env.HOST ?? '127.0.0.1'; // default dev mode: loopback only
}
