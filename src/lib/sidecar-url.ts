/* srv-21 — client-side pre-check for the configurable sidecar URL. The
   authoritative guard runs server-side (server/src/workspace/sidecar-url.ts,
   called at the resolver); this mirror just gives the Account/Model-Manager
   field instant feedback before Save. Allows http(s) on a loopback or RFC-1918
   private host only — the sidecar is always local, so an outbound URL pointing
   at an arbitrary public host is a misconfiguration (or an SSRF foothold). */

/** True if `raw` is a syntactically valid http(s) URL whose host is loopback or
    a private/link-local address (or a *.local / bare hostname). */
export function isPrivateHostUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isPrivateHost(url.hostname);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;

  /* IPv4 dotted-quad → private/loopback/link-local ranges. */
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  /* A bare single-label hostname (no dots) is a LAN name — allow it. A
     multi-label public domain (example.com) is not. */
  return !h.includes('.') && !h.includes(':');
}
