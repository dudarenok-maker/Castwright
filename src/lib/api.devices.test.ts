import { afterEach, describe, it, expect, vi } from 'vitest';
import { api, ApiError } from './api';

it('ApiError carries a numeric status', () => {
  const e = new ApiError('nope', 401);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(401);
});

// #2278 review round 3, Finding 1 — fromServer defaults false for a direct
// `new ApiError(...)` call (the vast majority of call sites, which never
// went through apiErrorFromResponse); only apiErrorFromResponse itself sets
// it true, and only when it genuinely parsed a JSON `{error}` body.
it('ApiError.fromServer defaults to false', () => {
  expect(new ApiError('nope', 401).fromServer).toBe(false);
  expect(new ApiError('nope', 401, true).fromServer).toBe(true);
});

/* #2278 review Finding 1 — api.listDevices / api.createDevicePairSession used
   to discard the server's JSON `{ error }` body and throw a synthetic
   "<action> failed (<status>)" string instead. Several LAN-guard 401/403
   bodies now carry actionable, port-correct pairing guidance
   (`pairingOriginHint()` on the server) that the LAN-access card renders
   verbatim — these wire-contract tests pin that the parsing actually
   happens, not just that the card trusts whatever `api.*` hands it (which
   the component tests mock at the `api` boundary and so can't see this). */
describe('api.listDevices / api.createDevicePairSession — error-body wire contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listDevices surfaces the server\'s JSON error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(api.listDevices()).rejects.toMatchObject({
      status: 401,
      message:
        'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
      fromServer: true,
    });
  });

  it('listDevices falls back to a synthetic message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 500 })),
    );

    await expect(api.listDevices()).rejects.toMatchObject({
      status: 500,
      message: 'list devices failed (500)',
      fromServer: false,
    });
  });

  it('createDevicePairSession surfaces the server\'s JSON error message on a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(api.createDevicePairSession({ label: 'Phone' })).rejects.toMatchObject({
      status: 403,
      message:
        'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
      fromServer: true,
    });
  });
});

// #2278 review round 3, Finding 3 — /api/library sits behind the same
// requireLanToken guard as listDevices, so its 401 body now carries the same
// port-correct pairing guidance; realGetLibrary must parse it the same way
// (previously it only ever threw a raw-text-embedded synthetic string).
describe('api.getLibrary — error-body wire contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces the server\'s JSON error message on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(api.getLibrary()).rejects.toMatchObject({
      status: 401,
      message:
        'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
      fromServer: true,
    });
  });

  it('falls back to a synthetic message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })),
    );

    await expect(api.getLibrary()).rejects.toMatchObject({
      status: 500,
      message: 'Library scan failed (500)',
      fromServer: false,
    });
  });

  /* #2278 review round 4, Finding 9 — the rendered message deliberately lost
     its `: <body text>` suffix, which is right for the reader (a reverse
     proxy's HTML error page is not a sentence to show anyone) and wrong for
     whoever has to debug a 502 from a gateway. The body is logged instead, so
     the diagnostic survives in devtools without reaching the panel. */
  it('logs the raw body text when it falls back, so a proxy/gateway fault stays debuggable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }),
        ),
    );

    await expect(api.getLibrary()).rejects.toMatchObject({
      message: 'Library scan failed (502)',
      fromServer: false,
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('502 Bad Gateway'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Library scan failed (502)'));
  });

  /* #2278 review round 4 (nit) — realRegenerateLanCert hand-rolled
     apiErrorFromResponse's body parse minus the flag, five lines from the
     shared helper, so its errors were the one LAN-route family that could
     carry real server prose with fromServer FALSE — the exact pairing the
     flag exists to make impossible. It uses the helper now. */
  it('regenerateLanCert parses the server\'s error body through the shared helper', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'mkcert is not installed.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );

    await expect(api.regenerateLanCert()).rejects.toMatchObject({
      status: 500,
      message: 'mkcert is not installed.',
      fromServer: true,
    });
  });

  /* A genuinely parsed body is the caller's to render, so it is NOT also
     logged — the log line exists only for the case nothing readable reached
     the UI. */
  it('does not log when the server\'s own message was parsed and handed to the caller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Missing or invalid LAN access token.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );

    await expect(api.getLibrary()).rejects.toMatchObject({ fromServer: true });
    expect(spy).not.toHaveBeenCalled();
  });
});
