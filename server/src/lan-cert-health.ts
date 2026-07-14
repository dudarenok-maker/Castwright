/* ops-28 — pure cert-health decision logic for GET /api/lan/cert/status.
   No filesystem / no crypto here so the health matrix is exhaustively
   unit-testable. The route (routes/lan-cert.ts) does the fs + X509 parse and
   feeds the results in. IP-coverage is INFORMATIONAL: uncoveredIps is reported
   but never changes `health` (see the spec's "Why IP-coverage is
   informational"). */

export type CertHealth = 'healthy' | 'missing' | 'expired';

/** Parse the `IP Address:`-prefixed entries out of X509Certificate.subjectAltName,
    which is a single comma-joined string like
    "DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.42". */
export function parseCertIps(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('IP Address:'))
    .map((entry) => entry.slice('IP Address:'.length).trim());
}

export function computeCertHealth(args: {
  certExists: boolean;
  keyExists: boolean;
  parsed: { notAfter: Date; ips: string[] } | null;
  currentLanIps: string[];
  now: Date;
}): { health: CertHealth; uncoveredIps: string[] } {
  const { certExists, keyExists, parsed, currentLanIps, now } = args;
  if (!certExists || !keyExists || parsed === null) {
    return { health: 'missing', uncoveredIps: [] };
  }
  if (parsed.notAfter.getTime() <= now.getTime()) {
    return { health: 'expired', uncoveredIps: [] };
  }
  const covered = new Set(parsed.ips);
  const uncoveredIps = currentLanIps.filter((ip) => !covered.has(ip));
  return { health: 'healthy', uncoveredIps };
}
