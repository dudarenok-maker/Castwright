import { afterEach, describe, it, expect, vi } from 'vitest';
import { api, ApiError } from './api';

it('ApiError carries a numeric status', () => {
  const e = new ApiError('nope', 401);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(401);
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
    });
  });
});
