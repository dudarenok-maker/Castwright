/* castwright-local-port-cert — the server-owned port-443 TCP forwarder that
   lets `https://castwright.local` (and any bare LAN IP) work with no port
   typed, by relaying raw bytes to the real HTTPS server on LAN_HTTPS_PORT
   (default 8443). See the design spec:
   docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md

   Host-blind by design: this never inspects the Host header or SNI, so it
   relays ANY connection reaching :443 to the real server — simple (no TLS
   termination, no per-hostname routing table), but it means every LAN IP
   also becomes reachable on :443 with no port, not just the friendly
   hostname (see server/src/csrf-origin.ts's port-less-IP allow-list entry,
   which exists specifically to cover this).

   Rate-limit key collapse (round 3 observation, deliberately deferred —
   tracked as ops-24 / #1309): because the forwarder is a raw TCP relay,
   every forwarded client presents the same upstream source address
   (127.0.0.2) to the app, including to IP-keyed rate limiters
   (middleware/rate-limit.ts's apiLimiter, pairing.ts's redeemLimiter). All
   bare-hostname/bare-IP clients therefore share one rate-limit bucket
   instead of getting per-client ceilings. This is inherent to any TCP-level
   forwarder that loses the original client IP (not specific to the
   127.0.0.2 choice — 127.0.0.1 would have the identical effect). Most
   ceilings (e.g. apiLimiter) are generous enough relative to a single-user
   LAN tool's real traffic that the collapse is a non-issue, but
   pairing.ts's redeemLimiter (5 requests/60s) is the sharper case: one
   device's pairing attempts routed through this forwarder can lock out
   every other LAN device's pairing attempts for up to a minute. Triaged and
   explicitly deferred rather than fixed here — see ops-24 (#1309) for the
   tracked follow-up. */

import net from 'node:net';
import { shouldSpawnMdnsResponder } from './mdns-owner.js';

export interface PortForwarderHandle {
  server: net.Server;
  close: () => Promise<void>;
  isBound: () => boolean;
}

/** True only for the start:lan shape (lanHttps AND NODE_ENV=production) —
    delegates to shouldSpawnMdnsResponder's identical gating logic rather than
    duplicating it, so the two can never silently drift apart. dev:lan's
    server leg also sets LAN_HTTPS=1, and must not also get a port-443
    forwarder it doesn't advertise or own. */
export function shouldSpawnPortForwarder(
  lanHttps: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldSpawnMdnsResponder(lanHttps, env);
}

/** Start the :443-to-targetPort raw TCP forwarder. Never throws — a bind
    failure surfaces via the server's own 'error' event (logged here), not a
    synchronous throw, so the caller always gets a usable handle back. */
export function startPortForwarder(
  targetPort: number,
  opts: {
    listenPort?: number;
    createServerFn?: typeof net.createServer;
    connectFn?: typeof net.connect;
    warn?: (...args: unknown[]) => void;
    /** Test-only hook: invoked synchronously once per accepted connection,
        after all of this handler's listeners are attached to `client`/
        `upstream`. Exists so tests can await the moment it's actually safe
        to drive `upstream`'s events, instead of using the client socket's
        own 'connect' event as a synchronization proxy — the client-connect
        and server-accept callbacks are independently-scheduled reactions to
        the same TCP handshake, so their relative order isn't guaranteed
        (see lan-port-forwarder.test.ts's "round 5 (Finding 2)" tests). */
    onConnection?: () => void;
  } = {},
): PortForwarderHandle {
  const {
    listenPort = 443,
    createServerFn = net.createServer,
    connectFn = net.connect,
    warn = console.warn,
    onConnection,
  } = opts;

  /* Tracks every currently-accepted client socket so close() can force-evict
     them. net.Server (unlike http.Server) has no closeAllConnections() — that
     method only exists on http.Server — so net.Server.close()'s callback only
     fires once every accepted connection has ended NATURALLY. A phone with an
     open keep-alive HTTPS connection through this forwarder would otherwise
     hang close() (and index.ts's shutdown() Promise.all) indefinitely. */
  const openClientSockets = new Set<net.Socket>();
  let bound = false;

  const server = createServerFn((client) => {
    openClientSockets.add(client);
    /* localAddress: '127.0.0.2' (NOT the default 127.0.0.1) is a required
       security invariant, not an incidental detail (adversarial review
       round 2). Without it, this connection would present as trusted
       loopback to server/src/lan-auth.ts's isLoopbackRequest(), silently
       bypassing the LAN_AUTH_TOKEN gate (requireLanToken) for every client
       reaching the app through this forwarder. 127.0.0.0/8 is entirely
       loopback (RFC 5735), so 127.0.0.2 is just as non-routable and
       local-only as 127.0.0.1 — it costs nothing functionally. */
    const upstream = connectFn({
      port: targetPort,
      host: '127.0.0.1',
      localAddress: '127.0.0.2',
    });

    const destroyBoth = () => {
      client.destroy();
      upstream.destroy();
      openClientSockets.delete(client);
    };

    let upstreamConnected = false;
    upstream.once('connect', () => {
      upstreamConnected = true;
    });

    client.pipe(upstream);
    upstream.pipe(client);
    /* If the bind above ever fails at runtime (e.g. Windows refuses an
       unassigned 127.x local address), the failure is per-connection, not a
       server-level bind error: :443 still accepts the client fine, then
       THIS connect errors. Distinct log line from the listener-level warn
       below so the two failure modes aren't conflated. This same listener
       also fires for errors AFTER a successful connect (e.g. a mid-relay
       ECONNRESET/EPIPE once piping has started) — the upstreamConnected flag
       distinguishes the two so the log doesn't mislead a reader into
       troubleshooting a connect/bind issue when the real cause was a
       mid-session drop. */
    upstream.once('error', (err) => {
      const message = upstreamConnected
        ? `upstream connection dropped`
        : `upstream connect failed`;
      warn(`[lan-port-forwarder] ${message}: ${(err as Error).message}`);
      destroyBoth();
    });
    client.once('error', destroyBoth);
    client.once('close', destroyBoth);
    upstream.once('close', destroyBoth);
    onConnection?.();
  });

  /* .on (not .once): net.Server can emit 'error' more than once over its
     lifetime — not just at initial bind time (e.g. a transient EMFILE/resource
     -exhaustion error while accepting a burst of connections, without the
     server actually closing). A .once() listener deregisters after the first
     firing, so any SECOND 'error' event later in the process's life would have
     no listener attached — Node treats an unhandled 'error' event on an
     EventEmitter as an uncaught exception, crashing the entire process, not
     just this convenience forwarder. Matches crash-logging.ts's
     listenWithAutoRebind, which uses .on for the identical reason. */
  server.on('error', (err) => {
    warn(
      `[lan-port-forwarder] could not bind :${listenPort} (port already in use, or ` +
        `permission denied): ${(err as Error).message}. The bare-hostname/bare-IP ` +
        `convenience won't work; the explicit :${targetPort} URL is unaffected.`,
    );
  });

  server.listen(listenPort, '0.0.0.0');
  server.once('listening', () => {
    bound = true;
  });

  return {
    server,
    isBound: () => bound,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        // Force-evict any still-open client sockets (see openClientSockets'
        // own comment above) so the close() callback above can fire promptly
        // instead of waiting on a connection that may never end naturally.
        for (const socket of openClientSockets) socket.destroy();
      }),
  };
}
