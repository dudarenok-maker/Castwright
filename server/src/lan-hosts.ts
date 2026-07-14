/* ops-28 — server-side LAN IPv4 enumeration for GET /api/lan/cert/status.
   Deliberately re-derived here rather than imported from
   scripts/setup-lan-certs.mjs: that .mjs can process.exit and lives across the
   scripts↔server boundary the regenerate route already avoids crossing (see
   routes/lan-cert.ts). The parity test pins the filter rules to the script's
   enumerateLanIps. NOTE: routes/export-lan.ts holds a third copy of this same
   filter (enumerateLanUrls) — left as-is (out of ops-28 scope). */
import { networkInterfaces } from 'node:os';

export function enumerateLanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      if (iface.address.startsWith('169.254.')) continue;
      ips.push(iface.address);
    }
  }
  return ips;
}
