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
        requested: true, active: true, health: 'healthy',
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

  it('Revoke removes the row (the re-fetch returns it revoked)', async () => {
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
    vi.mocked(api.createDevicePairSession).mockRejectedValue(new ApiError('pair-session failed (403)', 403));

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
      new ApiError('pair-session failed (403)', 403),
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

  it('shows a working-exit recovery pointer on 401 from listDevices (no crash)', async () => {
    vi.mocked(api.listDevices).mockRejectedValue(new ApiError('Unauthorized', 401));

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
    vi.mocked(api.listDevices).mockRejectedValue(new ApiError('Unauthorized', 401));
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
    vi.mocked(api.listDevices).mockRejectedValue(new ApiError('Unauthorized', 401));

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
