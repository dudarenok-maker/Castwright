/* srv-21 — outbound sidecar-URL guard. The configurable `sidecarUrl`
   (user-settings.json) feeds every server→sidecar fetch (synthesize, health,
   load/unload, transcribe, speakers, design-voice). The sidecar is ALWAYS local,
   so a value pointing at an arbitrary public host is a misconfiguration — or an
   SSRF foothold that would make the server fetch attacker-controlled URLs with
   its own privileges. We validate at the single resolver chokepoint
   (getResolvedSidecarUrl) so all call sites inherit the guard.

   Mirrors the frontend pre-check (src/lib/sidecar-url.ts); kept as a separate
   copy because server and frontend code don't share a module. */

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

  /* A bare single-label hostname (no dots) is a LAN name — allow it. */
  return !h.includes('.') && !h.includes(':');
}
