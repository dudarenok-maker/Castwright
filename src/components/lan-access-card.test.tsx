import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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

  it('shows "manage from desktop" note on 401 from listDevices (no crash)', async () => {
    vi.mocked(api.listDevices).mockRejectedValue(new ApiError('Unauthorized', 401));

    render(<LanAccessCard />);

    await waitFor(() =>
      expect(screen.getByText(/manage devices from the desktop/i)).toBeInTheDocument(),
    );
  });
});
