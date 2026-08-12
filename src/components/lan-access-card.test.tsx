import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LanAccessCard } from './lan-access-card';
import { ApiError } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      listDevices: vi.fn(),
      createDevicePairSession: vi.fn(),
      revokeDevice: vi.fn(),
      regenerateLanCert: vi.fn(),
      getLanCertStatus: vi.fn().mockResolvedValue({
        requested: true, active: true, boundPort: 8443, health: 'healthy',
        certHosts: ['192.168.1.42'], currentLanIps: ['192.168.1.42'],
        uncoveredIps: [], expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    },
  };
});

vi.mock('./pairing/pairing-qr', () => ({
  PairingQr: ({ payload }: { payload: string }) => (
    <img src={`data:mock,${payload}`} alt="Pairing QR code" data-testid="mock-qr" />
  ),
}));

import { api } from '../lib/api';

const DEVICE = {
  id: '1',
  label: 'Mike phone',
  createdAt: '2026-01-15T10:00:00Z',
  expiresAt: '2026-07-15T10:00:00Z',
  lastSeenAt: undefined,
  revoked: false,
};

const PAIR_SESSION = {
  url: 'https://local.test:8443/#/pair?c=ABC',
  code: 'ABC',
  expiresAt: Date.now() + 300_000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe('LanAccessCard', () => {
  it('renders device label, added date, expires date, and Revoke calls revokeDevice', async () => {
    // Revoke is loopback-only (#2269) — stub a loopback host explicitly so
    // this assertion doesn't ride jsdom's default location incidentally.
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443' });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });
    vi.mocked(api.revokeDevice).mockResolvedValue({ ok: true });

    render(<LanAccessCard />);

    await waitFor(() => screen.getByText('Mike phone'));

    expect(screen.getByText('Mike phone')).toBeInTheDocument();

    const listItem = screen.getByText('Mike phone').closest('li');
    expect(listItem).toBeTruthy();
    const metaText = listItem!.textContent ?? '';
    expect(metaText).toMatch(/added/);
    expect(metaText).toMatch(/expires/);

    const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
    fireEvent.click(revokeBtn);
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('1'));
  });

  it('does not render a revoked device', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [{ ...DEVICE, revoked: true }] });

    render(<LanAccessCard />);

    await waitFor(() => screen.getByText('LAN access'));
    expect(screen.queryByText('Mike phone')).not.toBeInTheDocument();
  });

  // #2269 — revoke is loopback-only server-side now; the control must not be
  // presented to a caller who would only get a 403 for pressing it. The
  // empty action cell that leaves also gets an explanation (review round 2,
  // Finding 4) rather than sitting there with no way to tell why it's gone.
  // Pins the ACTUAL guidance, not just "some text is present": recoveryHint()
  // (the 401/lapsed-auth helper) would also satisfy a looser assertion here,
  // but its "Authorize this browser" instruction is a dead end from
  // castwright.local — that button always navigates back to
  // castwright.local, so following it can never bring the hostname back to
  // loopback. The right message names the loopback address revoke needs.
  it('hides the Revoke control for a non-loopback caller (castwright.local), and explains the loopback-only fix in its place — not the unrelated 401 recovery hint', async () => {
    vi.stubGlobal('location', { hostname: 'castwright.local', port: '' });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });

    render(<LanAccessCard />);

    await waitFor(() => screen.getByText('Mike phone'));
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/revoking only works from https:\/\/localhost:8443/i),
    ).toBeInTheDocument();
    // recoveryHint()'s wording must NOT be what renders here — it points at
    // "Authorize this browser", which is not the fix for a hidden Revoke button.
    expect(screen.queryByText(/authorize this browser/i)).not.toBeInTheDocument();
  });

  // #2269 review round 2, Finding 1 — isLoopbackHost() is a hostname-only,
  // client-side heuristic: on `https://localhost/` reached through the :443
  // forwarder (or via castwright.local while the hostname still happens to
  // read as loopback), the button renders but the server's peer is 127.0.0.2,
  // never loopback, so the click still 403s. revoke() must not let that come
  // back as the raw `revoke failed (403)` string the way it used to.
  it('shows actionable guidance instead of the raw code on a 403 from revokeDevice', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443' });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });
    vi.mocked(api.revokeDevice).mockRejectedValue(new ApiError('revoke failed (403)', 403));

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('Mike phone'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(
        screen.getByText(/revoking only works from https:\/\/localhost:8443/i),
      ).toBeInTheDocument(),
    );
  });

  it('Revoke removes the row (the re-fetch returns it revoked)', async () => {
    // Revoke is loopback-only (#2269) — stub a loopback host explicitly so
    // this assertion doesn't ride jsdom's default location incidentally.
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443' });
    vi.mocked(api.listDevices)
      .mockResolvedValueOnce({ devices: [DEVICE] })
      .mockResolvedValueOnce({ devices: [{ ...DEVICE, revoked: true }] });
    vi.mocked(api.revokeDevice).mockResolvedValue({ ok: true });

    render(<LanAccessCard />);

    await waitFor(() => screen.getByText('Mike phone'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('Mike phone')).not.toBeInTheDocument());
  });

  it('Authorize a device: type label → createDevicePairSession called → QR img appears', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue(PAIR_SESSION);

    render(<LanAccessCard />);

    const input = screen.getByPlaceholderText('Device name');
    fireEvent.change(input, { target: { value: 'My Laptop' } });

    const authorizeBtn = screen.getByRole('button', { name: 'Authorize a device' });
    fireEvent.click(authorizeBtn);

    await waitFor(() =>
      expect(api.createDevicePairSession).toHaveBeenCalledWith({ label: 'My Laptop' }),
    );

    expect(screen.getByTestId('mock-qr')).toBeInTheDocument();
  });

  it('shows a "castwright.local" pairing link when the session includes a friendlyUrl', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue({
      ...PAIR_SESSION,
      friendlyUrl: 'https://castwright.local/#/pair?c=ABC',
    });

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() => expect(screen.getByTestId('mock-qr')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /open pairing link on castwright\.local/i });
    expect(link).toHaveAttribute('href', 'https://castwright.local/#/pair?c=ABC');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not show the pairing link when the session has no friendlyUrl (dev:lan, or a live-but-unreachable start:lan)', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue(PAIR_SESSION); // no friendlyUrl field

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() => expect(screen.getByTestId('mock-qr')).toBeInTheDocument());

    expect(
      screen.queryByRole('link', { name: /open pairing link on castwright\.local/i }),
    ).not.toBeInTheDocument();
  });

  it('shows actionable guidance instead of the raw code on a 403 (reached via a bare LAN IP)', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    // #2278 review Finding 1 — the card renders the server's own message
    // verbatim now (see src/lib/api.ts's apiErrorFromResponse), so the mock
    // carries the actual guidance text rather than a synthetic placeholder.
    // fromServer: true (round 3, Finding 1) — this IS a genuine parsed body.
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError(
        'Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.',
        403,
        true,
      ),
    );

    render(<LanAccessCard />);
    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() =>
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:8443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mock-qr')).not.toBeInTheDocument();
  });

  // #2278 review round 3, Finding 1 — a 403 whose body wasn't genuine JSON
  // `{error}` prose (an HTML 403 from an interposed proxy, or the :443
  // forwarder) falls back to the synthetic "pair-session failed (403)"
  // developer string in ApiError.message, with fromServer left at its
  // default false. That raw string must never reach the user — the card
  // must show the generic fallback instead.
  it('falls back to generic guidance on a 403 whose body was not genuine server prose (ApiError.fromServer false)', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError('pair-session failed (403)', 403), // fromServer defaults false
    );

    render(<LanAccessCard />);
    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() =>
      expect(
        screen.getByText('Pairing can only be started from the computer running Castwright.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/pair-session failed/i)).not.toBeInTheDocument();
  });

  it('navigates to the friendly URL with self=1 when authorizing this browser', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue({
      url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
      friendlyUrl: 'https://castwright.local/#/pair?c=ABC',
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
    render(<LanAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
    await waitFor(() =>
      expect(api.createDevicePairSession).toHaveBeenCalledWith({
        label: 'This computer',
        selfBind: true,
      }),
    );
    expect(assign).toHaveBeenCalledWith('https://castwright.local/#/pair?c=ABC&self=1');
  });

  it("explains when castwright.local is not reachable instead of navigating", async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue({
      url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
    }); // no friendlyUrl
    const assign = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
    render(<LanAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
    expect(await screen.findByText(/castwright\.local isn't reachable/i)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows the "LAN mode is not active" message on a 409 from createDevicePairSession, without navigating', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError('pair-session failed (409)', 409),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
    render(<LanAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
    expect(
      await screen.findByText(/lan mode is not active on this server/i),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows actionable guidance instead of the raw code on a 403 from createDevicePairSession (self-bind), without navigating', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError(
        'Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.',
        403,
        true, // fromServer — a genuine parsed body (round 3, Finding 1)
      ),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
    render(<LanAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
    expect(
      await screen.findByText(/start pairing from https:\/\/localhost:8443 or https:\/\/castwright\.local/i),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to generic guidance on a 403 from createDevicePairSession (self-bind) whose body was not genuine server prose', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError('pair-session failed (403)', 403), // fromServer defaults false
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
    render(<LanAccessCard />);
    fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
    expect(
      await screen.findByText('Pairing can only be started from the computer running Castwright.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pair-session failed/i)).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a working-exit recovery pointer on 401 from listDevices (no crash)', async () => {
    // #2278 review Finding 1 — the card renders the SERVER's 401 message
    // verbatim (requireLanToken builds it from pairingOriginHint() —
    // server/src/lan-auth.ts), not a client-composed hint.
    vi.mocked(api.listDevices).mockRejectedValue(
      new ApiError(
        'Missing or invalid LAN access token. Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.',
        401,
      ),
    );

    render(<LanAccessCard />);

    await waitFor(() =>
      // The card's own 401 branch doesn't render the "Authorize this browser"
      // button (it lives in the else branch), so recoveryHint()'s pointer
      // back at that button would be circular — this names the concrete
      // working exit instead, same copy as the 403 branch above.
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:8443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
  });

  it('gives the same working-exit pointer on 401 regardless of the viewing hostname (location.port === "")', async () => {
    vi.mocked(api.listDevices).mockRejectedValue(
      new ApiError(
        'Missing or invalid LAN access token. Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.',
        401,
      ),
    );
    vi.stubGlobal('location', { hostname: 'localhost', port: '' });

    render(<LanAccessCard />);

    await waitFor(() =>
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:8443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
  });

  it('Regenerate certificate: click -> success re-fetches and re-renders LanCertStatus', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.regenerateLanCert).mockResolvedValue({
      hosts: ['localhost', 'castwright.local', '192.168.1.42'],
    });

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('LAN access'));

    const btn = screen.getByRole('button', { name: /regenerate certificate/i });
    fireEvent.click(btn);

    await waitFor(() => expect(api.regenerateLanCert).toHaveBeenCalled());
    expect(await screen.findByTestId('lan-cert-status-admin')).toBeInTheDocument();
  });

  it('Regenerate certificate: click -> failure shows the server error message', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.regenerateLanCert).mockRejectedValue(new Error('mkcert is not installed'));

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('LAN access'));

    fireEvent.click(screen.getByRole('button', { name: /regenerate certificate/i }));

    await waitFor(() => expect(screen.getByText('mkcert is not installed')).toBeInTheDocument());
  });

  it('Regenerate certificate button is hidden when viewing from a paired phone (401 on listDevices)', async () => {
    vi.mocked(api.listDevices).mockRejectedValue(
      new ApiError(
        'Missing or invalid LAN access token. Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.',
        401,
      ),
    );

    render(<LanAccessCard />);
    await waitFor(() =>
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:8443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /regenerate certificate/i })).not.toBeInTheDocument();
  });

  it('hides "Authorize this browser" when viewed from castwright.local — mintable-from-a-phone would let a phone stamp itself "This computer"', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.stubGlobal('location', { hostname: 'castwright.local', port: '' });

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('LAN access'));

    expect(screen.queryByRole('button', { name: /authorize this browser/i })).not.toBeInTheDocument();
    // Structural guard: the button is absent because the loopback gate excluded
    // it specifically, not because the whole authorized branch failed to render
    // (e.g. a broken listDevices call) — "Authorize a device" always renders here.
    expect(screen.getByRole('button', { name: 'Authorize a device' })).toBeInTheDocument();
  });

  it('shows "Authorize this browser" when viewed from localhost (true loopback)', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443' });

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('LAN access'));

    expect(screen.getByRole('button', { name: /authorize this browser/i })).toBeInTheDocument();
  });

  it('shows "Authorize this browser" when viewed from localhost via the :443 forwarder (empty port) — the motivating scenario for the loopback check', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.stubGlobal('location', { hostname: 'localhost', port: '' });

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('LAN access'));

    expect(screen.getByRole('button', { name: /authorize this browser/i })).toBeInTheDocument();
  });
});

// #2278 review round 2 (Findings 1, 4, 5, 6) — the mechanism split in two:
// the pairing/401 hints are now the SERVER's own message (pairingOriginHint()
// in server/src/lan-auth.ts, already port-correct) rendered verbatim by the
// card — no client-side cert-status fetch involved at all for those. Only the
// revoke hint (whose server-side 403 stays a generic, non-port message)
// still needs the port client-side, and now gets it from <LanCertStatus>'s
// existing onStatus callback rather than a second independent fetch. These
// tests use a non-default port (9443) so they'd fail against a hardcoded
// 8443 and pass only with the real port threaded through.
describe('LanAccessCard — #2278 LAN HTTPS port copy', () => {
  it('names the actually-bound port in the pairing hint (403 from createDevicePairSession) — straight from the server message, no cert-status fetch involved', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError(
        'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
        403,
        true, // fromServer — a genuine parsed body (round 3, Finding 1)
      ),
    );

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() =>
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:9443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/localhost:8443/i)).not.toBeInTheDocument();
  });

  it('names the actually-bound port in the revoke hint (non-loopback caller, castwright.local)', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      requested: true, active: true, boundPort: 9443, health: 'healthy',
      certHosts: [], currentLanIps: [], uncoveredIps: [], expiresAt: null,
    });
    vi.stubGlobal('location', { hostname: 'castwright.local', port: '' });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });

    render(<LanAccessCard />);

    await waitFor(() =>
      expect(screen.getByText(/revoking only works from https:\/\/localhost:9443/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/localhost:8443/i)).not.toBeInTheDocument();
  });

  it('names the actually-bound port in the revoke hint (403 from revokeDevice)', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', port: '9443' });
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      requested: true, active: true, boundPort: 9443, health: 'healthy',
      certHosts: [], currentLanIps: [], uncoveredIps: [], expiresAt: null,
    });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });
    vi.mocked(api.revokeDevice).mockRejectedValue(new ApiError('revoke failed (403)', 403));

    render(<LanAccessCard />);
    await waitFor(() => screen.getByText('Mike phone'));
    await screen.findByTestId('lan-cert-status-admin');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(screen.getByText(/revoking only works from https:\/\/localhost:9443/i)).toBeInTheDocument(),
    );
  });

  // #2278 review Findings 1 + 4 — the mechanism this branch shipped first
  // (a card-level GET /api/lan/cert/status fetch) COULD NOT WORK: that route
  // sits behind the identical requireLanToken guard as listDevices, so a 401
  // on one always means a 401 on the other in production — the previous
  // version of this test pinned exactly that impossible combination (401 on
  // listDevices, 200 on getLanCertStatus) and passed anyway, proving nothing
  // about production behaviour. The fix moves the guidance server-side
  // instead: requireLanToken's own 401 body already carries the live port
  // (server/src/lan-auth.ts's pairingOriginHint()), so the manageHint branch
  // renders e.message and is decoupled from cert-status entirely — pinned
  // here by mocking getLanCertStatus with a DIFFERENT, wrong port (1111) and
  // asserting it never leaks into the visible 401 text. (<LanCertStatus>
  // briefly mounts during the render before manageHint flips, per its own
  // useEffect, so "never called" isn't the invariant to assert — "never
  // rendered" is.)
  it('names the actually-bound port on the 401/manageHint pointer via the SERVER message, decoupled from getLanCertStatus', async () => {
    vi.mocked(api.listDevices).mockRejectedValue(
      new ApiError(
        'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
        401,
      ),
    );
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      requested: true, active: true, boundPort: 1111, health: 'healthy',
      certHosts: [], currentLanIps: [], uncoveredIps: [], expiresAt: null,
    });

    render(<LanAccessCard />);

    await waitFor(() =>
      expect(
        screen.getByText(/start pairing from https:\/\/localhost:9443 or https:\/\/castwright\.local/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/localhost:1111/i)).not.toBeInTheDocument();
  });

  it('drops the https:// address (rather than pointing at a dead http-only port) when LAN HTTPS is not active — the server already decided this, the card just renders it', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockRejectedValue(
      new ApiError('Start pairing on the computer running Castwright.', 403, true),
    );

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() =>
      expect(screen.getByText('Start pairing on the computer running Castwright.')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/https:\/\/localhost/i)).not.toBeInTheDocument();
  });

  it('drops the https:// address in the revoke hint when LAN HTTPS is not active', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      requested: false, active: false, boundPort: 8080, health: 'missing',
      certHosts: [], currentLanIps: [], uncoveredIps: [], expiresAt: null,
    });
    vi.stubGlobal('location', { hostname: 'castwright.local', port: '' });
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [DEVICE] });

    render(<LanAccessCard />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Revoking only works on the computer running Castwright — castwright.local and the :443 shortcut can't be used for this.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/https:\/\/localhost/i)).not.toBeInTheDocument();
  });
});
