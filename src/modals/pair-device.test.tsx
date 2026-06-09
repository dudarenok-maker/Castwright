import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/* The modal fetches GET /api/export/lan via api.getExportLanUrls. Mock it so
   each test drives the LAN/pairing state. qrcode stays real (jsdom renders a
   data: URL fine), so we assert the QR <img> actually appears. */
vi.mock('../lib/api', () => ({
  api: { getExportLanUrls: vi.fn() },
}));

import { PairDeviceModal, toPairingPayload } from './pair-device';
import { api } from '../lib/api';
import type { ExportLanInfo } from '../lib/types';

const mockedLan = vi.mocked(api.getExportLanUrls);

const COMPLETE: ExportLanInfo = {
  urls: ['https://192.168.86.20:8443'],
  port: 8443,
  protocol: 'https',
  token: 'lan-token-abc',
  caFingerprint: 'AB:CD:EF:01',
};

beforeEach(() => {
  mockedLan.mockReset();
});

describe('toPairingPayload', () => {
  it('returns null for null info', () => {
    expect(toPairingPayload(null)).toBeNull();
  });

  it('returns null when not HTTPS (no CA trust possible)', () => {
    expect(
      toPairingPayload({ urls: ['http://192.168.1.42:8080'], port: 8080, protocol: 'http' }),
    ).toBeNull();
  });

  it('returns null when the token is missing', () => {
    expect(toPairingPayload({ ...COMPLETE, token: undefined })).toBeNull();
  });

  it('returns null when the CA fingerprint is missing', () => {
    expect(toPairingPayload({ ...COMPLETE, caFingerprint: undefined })).toBeNull();
  });

  it('returns null when there is no reachable URL', () => {
    expect(toPairingPayload({ ...COMPLETE, urls: [] })).toBeNull();
  });

  it('maps a complete HTTPS info to {url, token, caFingerprint}', () => {
    expect(toPairingPayload(COMPLETE)).toEqual({
      url: 'https://192.168.86.20:8443',
      token: 'lan-token-abc',
      caFingerprint: 'AB:CD:EF:01',
    });
  });
});

describe('PairDeviceModal', () => {
  it('renders nothing when closed', () => {
    mockedLan.mockResolvedValue(COMPLETE);
    const { container } = render(<PairDeviceModal open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockedLan).not.toHaveBeenCalled();
  });

  it('renders a scannable QR image and the manual values when pairing is available', async () => {
    mockedLan.mockResolvedValue(COMPLETE);
    render(<PairDeviceModal open onClose={() => {}} />);

    const img = await screen.findByTestId('pair-qr-image');
    expect(img).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/));

    // Manual-entry fallback carries all three values verbatim.
    expect(screen.getByText('https://192.168.86.20:8443')).toBeInTheDocument();
    expect(screen.getByText('lan-token-abc')).toBeInTheDocument();
    expect(screen.getByText('AB:CD:EF:01')).toBeInTheDocument();
  });

  it('explains how to enable pairing when not in LAN HTTPS mode', async () => {
    mockedLan.mockResolvedValue({ urls: ['http://192.168.1.42:8080'], port: 8080, protocol: 'http' });
    render(<PairDeviceModal open onClose={() => {}} />);

    expect(await screen.findByTestId('pair-device-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-image')).toBeNull();
  });

  it('shows an error state when the LAN probe fails', async () => {
    mockedLan.mockRejectedValue(new Error('boom'));
    render(<PairDeviceModal open onClose={() => {}} />);
    expect(await screen.findByTestId('pair-device-error')).toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked', async () => {
    mockedLan.mockResolvedValue(COMPLETE);
    const onClose = vi.fn();
    render(<PairDeviceModal open onClose={onClose} />);
    await screen.findByTestId('pair-qr-image');
    screen.getByTestId('pair-device-backdrop').click();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
