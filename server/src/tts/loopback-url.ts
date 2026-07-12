/* The server's own loopback base URL, matching whatever listener index.ts actually
   bound (recorded via setLanRuntime): https on the LAN port when LAN HTTPS is live,
   else plain http on the bound port. The sidecar POSTs phase progress here (AR2).

   Reads the EFFECTIVE runtime, NOT the LAN_HTTPS env flag: since the LAN-HTTPS
   default flip, LAN can be on without LAN_HTTPS being set, and a cert-less box
   degrades to loopback HTTP — either way the requested flag lies about the port,
   which would send sidecar callbacks to a dead port (ECONNREFUSED → silent stalled
   progress). getLanRuntime() is set at boot before any request can reach here. */
import { getLanRuntime } from '../lan-runtime.js';

export function serverLoopbackBaseUrl(): string {
  const { httpsActive, port } = getLanRuntime();
  return `${httpsActive ? 'https' : 'http'}://127.0.0.1:${port}`;
}
