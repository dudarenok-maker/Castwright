/* fs-1 — pin the what's-new banner: hidden unless showWhatsNew, renders the
   version + notes, dismiss calls the API + refreshes. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  info: null as null | Record<string, unknown>,
  refresh: vi.fn(async () => {}),
  dismissWhatsNew: vi.fn(async () => {}),
}));

vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: h.refresh }),
}));
vi.mock('../lib/api', () => ({ api: { dismissWhatsNew: h.dismissWhatsNew } }));

import { WhatsNewBanner } from './whats-new-banner';

beforeEach(() => {
  h.info = null;
  // Clear (not reassign) so the references captured by the vi.mock factories
  // stay valid across tests.
  h.refresh.mockClear();
  h.dismissWhatsNew.mockClear();
});

describe('WhatsNewBanner', () => {
  it('renders nothing when showWhatsNew is false', () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: false, releaseNotes: '' };
    const { container } = render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the version + release notes when showWhatsNew is true', () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '# v1.6.0\n- In-app upgrades' };
    render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('whats-new-banner')).toBeInTheDocument();
    expect(screen.getByText(/What's new in v1\.6\.0/)).toBeInTheDocument();
    expect(screen.getByText(/In-app upgrades/)).toBeInTheDocument();
  });

  it('dismiss calls the API and refreshes', async () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '' };
    render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(h.dismissWhatsNew).toHaveBeenCalledOnce());
    expect(h.refresh).toHaveBeenCalled();
  });
});
