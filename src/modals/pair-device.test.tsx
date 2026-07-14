import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PairDeviceModal } from './pair-device';
import { api } from '../lib/api';

const SESSION = {
  qrPayload: 'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R',
  hostPort: '192.168.1.5:8443',
  port: 8443,
  code: 'K7QF3M2P',
  fpTag: 'J4XQ2A7BWZ9K3M5R',
  expiresAt: Date.now() + 300000,
};

const generate = () =>
  fireEvent.click(screen.getByRole('button', { name: /generate pairing code/i }));

describe('PairDeviceModal (QR redesign)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens on the naming step, not straight into a session fetch', () => {
    const spy = vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    expect(screen.getByTestId('pair-device-naming')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the typed device name to createPairSession', async () => {
    const spy = vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: "Anna's phone" } });
    generate();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("Anna's phone"));
  });

  it('renders the compact QR + manual fields from the session payload', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-qr-image')).toBeInTheDocument());
    expect(screen.getByText('192.168.1.5:8443')).toBeInTheDocument();
    expect(screen.getByText('K7QF3M2P')).toBeInTheDocument();
    expect(screen.getByText('J4XQ2A7BWZ9K3M5R')).toBeInTheDocument();
  });

  it('shows the unavailable state when the session 409s', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed (409): not-lan-https'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-unavailable')).toBeInTheDocument());
  });

  it('shows the restricted guidance when the session 403s (reached via a bare LAN IP)', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed (403): ...'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-restricted')).toBeInTheDocument());
  });

  it('shows a generic error on a non-409/403 failure', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('network down'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-error')).toBeInTheDocument());
  });

  it('renders a countdown for the pairing code', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-code-countdown')).toBeInTheDocument());
    expect(screen.getByTestId('pair-code-countdown').textContent).toMatch(/expires in \d+:\d{2}/);
  });
});
