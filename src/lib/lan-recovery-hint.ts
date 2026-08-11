/** Recovery pointer for a 401 caused by this browser's LAN authorization
 *  lapsing. Shared by the library-panel error state (book-library.tsx) and
 *  the LAN-access card's own 401-on-listDevices state (lan-access-card.tsx)
 *  so the same underlying condition always gives the user the same
 *  instructions. `castwright.local` is the mDNS name every device on the
 *  LAN resolves, so it is NOT evidence the user is sitting at the host;
 *  only true loopback counts. */
export function recoveryHint(): string {
  const h = window.location.hostname;
  const onHost = h === 'localhost' || h === '127.0.0.1';
  if (!onHost) return 'Open Castwright on the computer running it and use “Authorize this browser”, then reload here.';
  // location.port is '' on the :443 forwarder path — never promise a port we don't know.
  return window.location.port
    ? `Open https://localhost:${window.location.port} on this computer and use “Authorize this browser”.`
    : 'Open Castwright on this computer and use “Authorize this browser” under Account → LAN access.';
}
