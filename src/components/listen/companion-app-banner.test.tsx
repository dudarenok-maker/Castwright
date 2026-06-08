import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { CompanionAppBanner } from './companion-app-banner';

describe('CompanionAppBanner', () => {
  it('renders the Castwright Companion heading', () => {
    render(<CompanionAppBanner />);
    expect(
      screen.getByRole('heading', { name: /castwright companion/i }),
    ).toBeInTheDocument();
  });

  it('marks the companion app as coming soon', () => {
    render(<CompanionAppBanner />);
    const banner = screen.getByTestId('companion-app-banner');
    expect(within(banner).getByTestId('coming-soon-badge')).toBeInTheDocument();
  });

  it('shows Google Play and App Store install buttons', () => {
    render(<CompanionAppBanner />);
    expect(screen.getByTestId('companion-store-google-play')).toBeInTheDocument();
    expect(screen.getByTestId('companion-store-app-store')).toBeInTheDocument();
  });

  it('keeps both store buttons non-functional while mocked', () => {
    render(<CompanionAppBanner />);
    expect(screen.getByTestId('companion-store-google-play')).toBeDisabled();
    expect(screen.getByTestId('companion-store-app-store')).toBeDisabled();
  });

  it('gives each store button an explicit accessible label', () => {
    render(<CompanionAppBanner />);
    expect(
      screen.getByLabelText(/castwright companion on google play/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/castwright companion on the app store/i),
    ).toBeInTheDocument();
  });
});
