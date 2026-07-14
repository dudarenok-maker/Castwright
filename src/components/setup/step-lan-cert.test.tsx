import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepLanCert } from './step-lan-cert';
import { api } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, getLanCertStatus: vi.fn(), regenerateLanCert: vi.fn() } };
});

const base = {
  requested: true, active: false, certHosts: [] as string[],
  currentLanIps: ['192.168.1.42'], uncoveredIps: [] as string[], expiresAt: null,
};

describe('StepLanCert', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the soft-warning banner when requested && missing', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({ ...base, health: 'missing' });
    render(<StepLanCert />);
    expect(await screen.findByTestId('lan-cert-warning-banner')).toBeInTheDocument();
  });

  it('no warning banner when healthy (only a coverage hint / restart note may show)', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      ...base, health: 'healthy', active: true, uncoveredIps: ['10.0.0.9'],
    });
    render(<StepLanCert />);
    await screen.findByTestId('lan-cert-status-wizard');
    expect(screen.queryByTestId('lan-cert-warning-banner')).not.toBeInTheDocument();
  });

  it('no warning banner when not requested even if missing', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({ ...base, requested: false, health: 'missing' });
    render(<StepLanCert />);
    await screen.findByTestId('lan-cert-status-wizard');
    expect(screen.queryByTestId('lan-cert-warning-banner')).not.toBeInTheDocument();
  });
});
