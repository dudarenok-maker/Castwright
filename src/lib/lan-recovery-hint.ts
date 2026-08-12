/** True loopback only — `castwright.local` is the mDNS name every device on
 *  the LAN resolves, so it is NOT evidence the user is sitting at the host. */
export function isLoopbackHost(): boolean {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** Recovery pointer for a 401 caused by this browser's LAN authorization
 *  lapsing. The library panel's error state (book-library.tsx) is the only
 *  caller — the LAN-access card's own 401-on-listDevices state
 *  (lan-access-card.tsx) renders the SERVER's message instead (#2278 review
 *  Finding 1), because that branch never renders the "Authorize this
 *  browser" button this hint's non-loopback wording points at, and because
 *  the server can name the actually-bound port directly where this
 *  client-side helper cannot. If the recovery wording changes here, it has
 *  no bearing on that other copy — they're deliberately separate, not
 *  drifted. `castwright.local` is the mDNS name every device on the LAN
 *  resolves, so it is NOT evidence the user is sitting at the host; only
 *  true loopback counts. */
export function recoveryHint(): string {
  const onHost = isLoopbackHost();
  if (!onHost) return 'Open Castwright on the computer running it and use “Authorize this browser”, then reload here.';
  // location.port is '' on the :443 forwarder path — never promise a port we don't know.
  return window.location.port
    ? `Open https://localhost:${window.location.port} on this computer and use “Authorize this browser”.`
    : 'Open Castwright on this computer and use “Authorize this browser” under Account → LAN access.';
}
