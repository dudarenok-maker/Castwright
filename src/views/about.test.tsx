/* /about — the brand page (fe-37 rebuild). The page is the only in-product
   explanation of the product, so the brand identity, the flagged teaser, engine
   credits, licence, the What's-new link and the version must always be present.
   Assertions reference src/lib/brand.ts constants, never copied strings. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AboutView } from './about';
import { buildInfo } from '../lib/build-info';
import { TAGLINE, MANIFESTO, TEASER, TEASER_FLAG, DOMAIN } from '../lib/brand';

function renderAbout() {
  return render(
    <MemoryRouter>
      <AboutView />
    </MemoryRouter>,
  );
}

describe('AboutView', () => {
  it('renders the v2 primary tagline (not the retired one)', () => {
    renderAbout();
    expect(screen.getByText(TAGLINE)).toBeInTheDocument();
    expect(screen.queryByText(/effortlessly/i)).not.toBeInTheDocument();
  });

  it('renders the manifesto', () => {
    renderAbout();
    expect(screen.getByText(MANIFESTO)).toBeInTheDocument();
  });

  it('renders the teaser WITH its in-development flag (teaser rule)', () => {
    renderAbout();
    expect(screen.getByText(TEASER)).toBeInTheDocument();
    expect(screen.getByText(TEASER_FLAG)).toBeInTheDocument();
  });

  it('credits the TTS engines by name, linked', () => {
    renderAbout();
    expect(screen.getByRole('link', { name: /Kokoro/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Coqui XTTS/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Qwen3-TTS/ })).toBeInTheDocument();
  });

  it('states the source-available licence with a link', () => {
    renderAbout();
    const lic = screen.getByRole('link', { name: /FSL-1\.1-Apache-2\.0/ });
    expect(lic).toHaveAttribute('href', 'https://fsl.software/');
  });

  it('links "What\'s new" to the in-app release-notes route', () => {
    renderAbout();
    const link = screen.getByRole('link', { name: /What.s new/i });
    // Router-agnostic: Browser/MemoryRouter render "/release-notes", HashRouter "#/release-notes".
    expect(link.getAttribute('href')).toMatch(/release-notes$/);
  });

  it('renders the app version string', () => {
    renderAbout();
    expect(screen.getByText(new RegExp(`Castwright v${buildInfo.version}`))).toBeInTheDocument();
  });

  it('carries the alpha-tester ask with the castwright.ai link', () => {
    renderAbout();
    const link = screen.getByRole('link', { name: new RegExp(DOMAIN.replace('.', '\\.'), 'i') });
    expect(link).toHaveAttribute('href', `https://${DOMAIN}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});
