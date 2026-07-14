import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LanCertStatus } from './lan-cert-status';
import { api } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, getLanCertStatus: vi.fn(), regenerateLanCert: vi.fn() } };
});

const status = (over: Partial<import('../lib/api').LanCertStatus> = {}) => ({
  requested: true, active: false, health: 'healthy' as const,
  certHosts: ['127.0.0.1', '192.168.1.42'], currentLanIps: ['192.168.1.42'],
  uncoveredIps: [], expiresAt: '2099-01-01T00:00:00.000Z', ...over,
});

describe('LanCertStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "restart to apply" note when healthy but not active', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(status({ health: 'healthy', active: false }));
    render(<LanCertStatus variant="wizard" />);
    expect(await screen.findByTestId('lan-cert-restart-note')).toBeInTheDocument();
  });

  it('shows the coverage hint when uncoveredIps is non-empty', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(
      status({ health: 'healthy', active: true, uncoveredIps: ['10.0.0.9'] }),
    );
    render(<LanCertStatus variant="admin" />);
    expect(await screen.findByTestId('lan-cert-coverage-hint')).toHaveTextContent('10.0.0.9');
  });

  it('regenerate calls the API then re-fetches status', async () => {
    vi.mocked(api.getLanCertStatus)
      .mockResolvedValueOnce(status({ health: 'missing', active: false, certHosts: [], expiresAt: null }))
      .mockResolvedValueOnce(status({ health: 'healthy', active: false }));
    vi.mocked(api.regenerateLanCert).mockResolvedValue({ hosts: ['192.168.1.42'] });
    render(<LanCertStatus variant="wizard" />);
    fireEvent.click(await screen.findByRole('button', { name: /set up|regenerate/i }));
    await waitFor(() => expect(api.regenerateLanCert).toHaveBeenCalled());
    await waitFor(() => expect(api.getLanCertStatus).toHaveBeenCalledTimes(2));
  });

  it('shows the wiki troubleshooting link on regenerate error', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(status({ health: 'missing', certHosts: [], expiresAt: null }));
    vi.mocked(api.regenerateLanCert).mockRejectedValue(new Error('mkcert not found'));
    render(<LanCertStatus variant="wizard" />);
    fireEvent.click(await screen.findByRole('button', { name: /set up|regenerate/i }));
    expect(await screen.findByRole('link', { name: /troubleshoot/i })).toHaveAttribute(
      'href', expect.stringContaining('LAN-HTTPS-Troubleshooting'),
    );
  });
});
