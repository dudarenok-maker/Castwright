/* The ACTUAL LAN listen state, recorded by index.ts the moment the server binds.
   Consumers that advertise LAN URLs / mint pairing QRs (GET /api/export/lan,
   POST /api/pair/session) MUST read this, NOT the REQUESTED flag isLanHttpsEnabled():
   when LAN is requested but the mkcert certs are missing the server degrades to
   loopback HTTP, and advertising `https://<lan-ip>:8443` would hand out dead URLs /
   an unscannable pairing QR. Defaults to non-LAN (loopback HTTP) until index.ts
   sets the real state at boot; the effective decision is fixed for the process
   lifetime (a cert regenerated at runtime is hot-swapped but never rebinds). */
export interface LanRuntime {
  /** true only when the server actually bound HTTPS on the LAN (requested AND certs present). */
  httpsActive: boolean;
  /** the port the server actually bound. */
  port: number;
}

let runtime: LanRuntime = { httpsActive: false, port: Number(process.env.PORT ?? 8080) };

export function setLanRuntime(next: LanRuntime): void {
  runtime = next;
}

export function getLanRuntime(): LanRuntime {
  return runtime;
}
