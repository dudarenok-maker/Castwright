import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/* The banner probes GET /api/companion/apk (HEAD) on mount via
   api.checkCompanionApk, and the Pair-a-device modal creates a session via
   api.createPairSession. Mock both. */
vi.mock('../../lib/api', () => ({
  api: {
    checkCompanionApk: vi.fn(async () => ({ available: false, sizeBytes: null })),
    createPairSession: vi.fn(async () => ({
      qrPayload: 'https://www.castwright.ai/pair?h=192.168.86.20%3A8443&c=ABCD1234&f=TAGABC123',
      hostPort: '192.168.86.20:8443',
      port: 8443,
      code: 'ABCD1234',
      fpTag: 'TAGABC123',
      expiresAt: Date.now() + 300000,
    })),
  },
}));

import { CompanionAppBanner } from './companion-app-banner';
import { api } from '../../lib/api';

const mockedCheck = vi.mocked(api.checkCompanionApk);

beforeEach(() => {
  mockedCheck.mockReset();
  mockedCheck.mockResolvedValue({ available: false, sizeBytes: null });
});

describe('CompanionAppBanner', () => {
  it('renders the Castwright Companion heading', async () => {
    render(<CompanionAppBanner />);
    expect(
      await screen.findByRole('heading', { name: /castwright companion/i }),
    ).toBeInTheDocument();
  });

  it('marks the companion app as coming soon', async () => {
    render(<CompanionAppBanner />);
    const banner = await screen.findByTestId('companion-app-banner');
    expect(within(banner).getByTestId('coming-soon-badge')).toBeInTheDocument();
  });

  it('shows Google Play and App Store install buttons', async () => {
    render(<CompanionAppBanner />);
    expect(await screen.findByTestId('companion-store-google-play')).toBeInTheDocument();
    expect(screen.getByTestId('companion-store-app-store')).toBeInTheDocument();
  });

  it('keeps both store buttons non-functional', async () => {
    render(<CompanionAppBanner />);
    expect(await screen.findByTestId('companion-store-google-play')).toBeDisabled();
    expect(screen.getByTestId('companion-store-app-store')).toBeDisabled();
  });

  it('gives each store button an explicit accessible label', async () => {
    render(<CompanionAppBanner />);
    expect(
      await screen.findByLabelText(/castwright companion on google play/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/castwright companion on the app store/i),
    ).toBeInTheDocument();
  });

  it('hides the Download .apk button when no APK is available', async () => {
    render(<CompanionAppBanner />);
    await screen.findByTestId('companion-app-banner');
    expect(screen.queryByTestId('companion-store-apk')).toBeNull();
  });

  it('shows a Download .apk download link once an APK is available', async () => {
    mockedCheck.mockResolvedValue({ available: true, sizeBytes: 14_680_064 });
    render(<CompanionAppBanner />);
    const apk = await screen.findByTestId('companion-store-apk');
    expect(apk).toHaveAttribute('href', '/api/companion/apk');
    expect(apk).toHaveAttribute('download');
    expect(apk).toHaveTextContent(/download \.apk/i);
    // It's a real link, not a disabled control.
    expect(apk.tagName).toBe('A');
  });

  it('surfaces the APK size hint when known', async () => {
    mockedCheck.mockResolvedValue({ available: true, sizeBytes: 14_680_064 });
    render(<CompanionAppBanner />);
    const apk = await screen.findByTestId('companion-store-apk');
    expect(apk).toHaveTextContent(/14 MB/);
  });

  it('leaves the store buttons disabled even when the APK is available', async () => {
    mockedCheck.mockResolvedValue({ available: true, sizeBytes: 1024 });
    render(<CompanionAppBanner />);
    await screen.findByTestId('companion-store-apk');
    expect(screen.getByTestId('companion-store-google-play')).toBeDisabled();
    expect(screen.getByTestId('companion-store-app-store')).toBeDisabled();
  });

  it('shows a Pair a device button that opens the pairing QR modal', async () => {
    render(<CompanionAppBanner />);
    const pair = await screen.findByTestId('companion-pair-device');
    expect(pair).toBeEnabled();
    // Modal is closed until clicked.
    expect(screen.queryByTestId('pair-device-modal')).toBeNull();
    pair.click();
    expect(await screen.findByTestId('pair-device-modal')).toBeInTheDocument();
    // The QR renders from the mocked LAN pairing info.
    expect(await screen.findByTestId('pair-qr-image')).toBeInTheDocument();
  });
});
