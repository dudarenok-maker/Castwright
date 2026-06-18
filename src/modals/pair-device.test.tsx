import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PairDeviceModal } from './pair-device';
import { api } from '../lib/api';

describe('PairDeviceModal (QR redesign)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the compact QR + manual fields from the session payload', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue({
      qrPayload: 'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R',
      hostPort: '192.168.1.5:8443', port: 8443,
      code: 'K7QF3M2P', fpTag: 'J4XQ2A7BWZ9K3M5R', expiresAt: Date.now() + 300000,
    });
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-qr-image')).toBeInTheDocument());
    expect(screen.getByText('192.168.1.5:8443')).toBeInTheDocument();
    expect(screen.getByText('K7QF3M2P')).toBeInTheDocument();
    expect(screen.getByText('J4XQ2A7BWZ9K3M5R')).toBeInTheDocument();
  });

  it('shows the unavailable state when the session 409s', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed (409): not-lan-https'));
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-device-unavailable')).toBeInTheDocument());
  });

  it('shows a generic error on a non-409 failure', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('network down'));
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-device-error')).toBeInTheDocument());
  });

  it('renders a countdown for the pairing code', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue({
      qrPayload: 'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R',
      hostPort: '192.168.1.5:8443', port: 8443,
      code: 'K7QF3M2P', fpTag: 'J4XQ2A7BWZ9K3M5R', expiresAt: Date.now() + 300000,
    });
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-code-countdown')).toBeInTheDocument());
    expect(screen.getByTestId('pair-code-countdown').textContent).toMatch(/expires in \d+:\d{2}/);
  });
});
