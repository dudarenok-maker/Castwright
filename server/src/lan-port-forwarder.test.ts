import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { shouldSpawnPortForwarder, startPortForwarder } from './lan-port-forwarder.js';

describe('shouldSpawnPortForwarder', () => {
  it('is false when lanHttps is false, regardless of NODE_ENV', () => {
    expect(shouldSpawnPortForwarder(false, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is true for the start:lan shape: lanHttps=true AND NODE_ENV=production', () => {
    expect(shouldSpawnPortForwarder(true, { NODE_ENV: 'production' })).toBe(true);
  });

  it('is false for the dev:lan server-leg shape: lanHttps=true but NODE_ENV unset', () => {
    expect(shouldSpawnPortForwarder(true, {})).toBe(false);
  });

  it('is false when NODE_ENV is set but not production', () => {
    expect(shouldSpawnPortForwarder(true, { NODE_ENV: 'development' })).toBe(false);
  });
});

/* Real net sockets throughout (no mocking) — this is the integration test the
   design spec calls for, and it doubles as the one place that actually proves
   the 127.0.0.2 localAddress bind works on the box running the tests (the
   spec explicitly flags this as needing a real bind, not just inference). */
describe('startPortForwarder', () => {
  function listenAndGetPort(server: net.Server): Promise<number> {
    return new Promise((resolve) => {
      server.once('listening', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') throw new Error('expected AddressInfo');
        resolve(addr.port);
      });
    });
  }

  it('relays bytes in both directions between client and upstream', async () => {
    // Dummy upstream: an echo server on an ephemeral port. IPv4-pinned for
    // the same reason as the SECURITY test below (avoid dual-stack ambiguity).
    const upstream = net.createServer((sock) => sock.pipe(sock));
    upstream.listen(0, '127.0.0.1');
    const upstreamPort = await listenAndGetPort(upstream);

    const handle = startPortForwarder(upstreamPort, { listenPort: 0 });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    const received = await new Promise<string>((resolve) => {
      client.once('connect', () => client.write('ping'));
      client.once('data', (chunk) => resolve(chunk.toString()));
    });
    expect(received).toBe('ping');

    client.destroy();
    await handle.close();
    upstream.close();
  });

  it('SECURITY: the upstream connection presents as 127.0.0.2, never 127.0.0.1', async () => {
    let observedRemoteAddress: string | undefined;
    const upstream = net.createServer((sock) => {
      observedRemoteAddress = sock.remoteAddress;
      sock.end();
    });
    /* Bind IPv4-only explicitly (not the default unspecified host, which
       binds the dual-stack `::` when available) — a dual-stack socket
       reports an accepted IPv4 peer as the IPv4-mapped `::ffff:127.0.0.2`,
       which would false-fail the exact-string assertion below on a
       perfectly correct implementation. This is the ONLY automated guardian
       of the auth-bypass fix (adversarial review round 2) — pin the family
       so a false failure can never tempt a future editor into loosening the
       assertion instead of fixing the real test. */
    upstream.listen(0, '127.0.0.1');
    const upstreamPort = await listenAndGetPort(upstream);

    const handle = startPortForwarder(upstreamPort, { listenPort: 0 });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    await new Promise<void>((resolve) => client.once('close', () => resolve()));

    // This is the assertion that would fail loudly if the localAddress
    // invariant were ever accidentally dropped, e.g. during a refactor —
    // 127.0.0.1 here would mean forwarded LAN traffic silently bypasses
    // requireLanToken's isLoopbackRequest() check (server/src/lan-auth.ts).
    expect(observedRemoteAddress).toBe('127.0.0.2');
    expect(observedRemoteAddress).not.toBe('127.0.0.1');

    await handle.close();
    upstream.close();
  });

  it('close() resolves even when a connection is still open through the forwarder (does not hang)', async () => {
    const upstream = net.createServer(() => {
      // Deliberately never close this socket, simulating an open keep-alive connection.
    });
    upstream.listen(0, '127.0.0.1');
    const upstreamPort = await listenAndGetPort(upstream);

    const handle = startPortForwarder(upstreamPort, { listenPort: 0 });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    // Without closeAllConnections(), this would hang forever (Vitest's default
    // test timeout would eventually fail it) — with the fix, it resolves promptly.
    await handle.close();

    client.destroy();
    upstream.close();
  });

  it('warns (does not throw) when the listen port is already in use', async () => {
    const blocker = net.createServer();
    /* Bind 0.0.0.0 explicitly, matching the family startPortForwarder itself
       binds — a blocker on a different address family than the forwarder's
       0.0.0.0 bind may not actually collide on every platform (a dual-stack
       ::-only blocker vs. an IPv4-only forwarder bind, for instance), which
       would hang this test waiting for an 'error' that never fires. */
    blocker.listen(0, '0.0.0.0');
    const blockedPort = await listenAndGetPort(blocker);

    const warn = vi.fn();
    const handle = startPortForwarder(9999, { listenPort: blockedPort, warn });

    await new Promise<void>((resolve) => handle.server.once('error', () => resolve()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(String(blockedPort));

    await handle.close();
    blocker.close();
  });

  it('round 5 (Finding 1): survives and still warns on a SECOND error event on the same server (net.Server can emit "error" more than once)', async () => {
    // No real bind is needed here — this proves the listener itself
    // (server.on vs server.once) stays attached, independent of what
    // triggers the error. A .once() listener would leave the second
    // emit()'d 'error' with no handler, which Node treats as an uncaught
    // exception and crashes the whole process — exactly the regression
    // this guards against.
    const warn = vi.fn();
    const handle = startPortForwarder(9999, { listenPort: 0, warn });
    await new Promise<void>((resolve) => handle.server.once('listening', () => resolve()));

    handle.server.emit('error', new Error('first transient error'));
    handle.server.emit('error', new Error('second transient error'));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('first transient error');
    expect(warn.mock.calls[1]?.[0]).toContain('second transient error');

    await handle.close();
  });

  /* Minimal fake upstream socket: an EventEmitter with the handful of
     stream-ish methods startPortForwarder actually calls (pipe/write/end/
     destroy). Driving 'connect' and 'error' on it directly (rather than via
     a real socket + real network timing) makes both the pre-connect and
     post-connect log-message variants deterministic. */
  class FakeUpstreamSocket extends EventEmitter {
    pipe() {
      return this;
    }
    write() {
      return true;
    }
    end() {
      return this;
    }
    destroy() {
      this.emit('close');
    }
  }

  it('round 5 (Finding 2): logs "upstream connect failed" for an error BEFORE any successful connect', async () => {
    const fakeUpstream = new FakeUpstreamSocket();
    const warn = vi.fn();
    let resolveConnected: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const handle = startPortForwarder(9999, {
      listenPort: 0,
      warn,
      connectFn: () => fakeUpstream as unknown as net.Socket,
      // Synchronize on the server's own listener-attach point, not on the
      // client socket's 'connect' event — see round 5 (Finding 2) below,
      // and the comment on the `onConnection` opt in lan-port-forwarder.ts,
      // for why the latter is a race (ECONNRESET flake, issue #1351).
      onConnection: () => resolveConnected(),
    });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    await connected;

    fakeUpstream.emit('error', new Error('ECONNREFUSED'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('upstream connect failed');
    expect(warn.mock.calls[0]?.[0]).not.toContain('upstream connection dropped');

    client.destroy();
    await handle.close();
  });

  it('round 5 (Finding 2): logs "upstream connection dropped" (not "upstream connect failed") for an error AFTER a successful connect', async () => {
    const fakeUpstream = new FakeUpstreamSocket();
    const warn = vi.fn();
    let resolveConnected: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const handle = startPortForwarder(9999, {
      listenPort: 0,
      warn,
      connectFn: () => fakeUpstream as unknown as net.Socket,
      // Synchronize on the server's own listener-attach point, not on the
      // client socket's 'connect' event. The client-connect and server-accept
      // callbacks are independently-scheduled reactions to the same TCP
      // handshake, so their relative order isn't guaranteed by Node — on an
      // adverse ordering, this test's synchronous emit('error') below would
      // fire before upstream.once('error', ...) was attached, and Node
      // treats an unhandled 'error' event as an uncaught exception (observed
      // as an ECONNRESET crash on macOS CI, issue #1351).
      onConnection: () => resolveConnected(),
    });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    await connected;

    // Simulate a successful connect, then a mid-relay drop (e.g. ECONNRESET).
    fakeUpstream.emit('connect');
    fakeUpstream.emit('error', new Error('ECONNRESET'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('upstream connection dropped');
    expect(warn.mock.calls[0]?.[0]).not.toContain('upstream connect failed');

    client.destroy();
    await handle.close();
  });
});
