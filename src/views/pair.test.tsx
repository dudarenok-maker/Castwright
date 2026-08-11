import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { api } from '../lib/api';
import { PairShell } from './pair';

vi.mock('../lib/api', () => ({
  api: { redeemBrowserPair: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

function renderPair(search = '/pair?c=ABC', { strict = false } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[search]}>
      <Routes>
        <Route path="/pair" element={<PairShell />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('PairShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.redeemBrowserPair).mockResolvedValue({ label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' });
  });

  // Any earlier assertion failure would otherwise leak a history.replaceState
  // stub into every later test in this file.
  afterEach(() => vi.restoreAllMocks());

  it('renders the authorize screen', () => {
    renderPair();
    expect(screen.getByText(/Authorize this browser/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Authorize/i })).toBeInTheDocument();
  });

  it('calls redeemBrowserPair with the code and navigates home on success', async () => {
    renderPair('/pair?c=ABC');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    await waitFor(() => {
      expect(api.redeemBrowserPair).toHaveBeenCalledWith({ code: 'ABC' });
    });
    await waitFor(() => {
      expect(screen.getByText('home')).toBeInTheDocument();
    });
  });

  it('shows expired error on 401', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('expired', 401));
    renderPair('/pair?c=OLD');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    await waitFor(() => {
      expect(screen.getByText(/expired/i)).toBeInTheDocument();
    });
  });

  it('shows rate-limit error on 429', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('rate', 429));
    renderPair('/pair?c=XXX');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    await waitFor(() => {
      expect(screen.getByText(/wait a minute/i)).toBeInTheDocument();
    });
  });

  it('disables the button when no code is present', () => {
    renderPair('/pair');
    expect(screen.getByRole('button', { name: /Authorize/i })).toBeDisabled();
  });

  it('redeems on mount when self=1, scrubbing the code before the call', async () => {
    const order: string[] = [];
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { order.push('scrub'); });
    vi.mocked(api.redeemBrowserPair).mockImplementation(async () => {
      order.push('redeem');
      return { label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' };
    });
    renderPair('/pair?c=ABC&self=1');
    await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenCalledWith({ code: 'ABC' }));
    expect(order).toEqual(['scrub', 'redeem']);
  });

  // REGRESSION GUARD, not a red-phase test — see Step 2.
  it('does not auto-redeem without self=1', async () => {
    renderPair('/pair?c=ABC');
    await new Promise((r) => setTimeout(r, 20));
    expect(api.redeemBrowserPair).not.toHaveBeenCalled();
  });

  it('auto-redeems exactly once — the didRun guard survives StrictMode double-invoking the effect', async () => {
    vi.mocked(api.redeemBrowserPair).mockResolvedValue({
      label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    // StrictMode deliberately mounts → runs effects → cleans up → runs effects
    // again in development, to surface effects that aren't idempotent. This
    // is exactly the scenario didRun exists to guard against.
    renderPair('/pair?c=ABC&self=1', { strict: true });
    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
    expect(api.redeemBrowserPair).toHaveBeenCalledTimes(1);
  });

  it('offers Retry after a 503 and reuses the captured code', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.redeemBrowserPair)
      .mockRejectedValueOnce(new ApiError('degraded', 503))
      .mockResolvedValueOnce({ label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' });
    renderPair('/pair?c=ABC&self=1');
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenNthCalledWith(2, { code: 'ABC' }));
  });

  it('does not offer Retry after a 429', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('rate', 429));
    renderPair('/pair?c=ABC&self=1');
    expect(await screen.findByText(/wait a minute/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('QR-path retry does not scrub the URL before the second attempt', async () => {
    const { ApiError } = await import('../lib/api');
    const order: string[] = [];
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { order.push('scrub'); });
    let callCount = 0;
    vi.mocked(api.redeemBrowserPair).mockImplementation(async () => {
      order.push('redeem');
      callCount += 1;
      if (callCount === 1) throw new ApiError('degraded', 503);
      return { label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' };
    });
    // No self=1 — this is the manual QR/click journey, not the self-bind mount.
    renderPair('/pair?c=ABC');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(order).toContain('scrub'));
    // Exactly one scrub, and it comes AFTER both redeem attempts — i.e. never
    // before the retry's redeemBrowserPair call, unlike the self-bind path.
    expect(order).toEqual(['redeem', 'redeem', 'scrub']);
  });

  it('shows a network-restriction message on 403 and offers no Retry', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('forbidden', 403));
    renderPair('/pair?c=ABC');
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    expect(
      await screen.findByText('Pairing only works from your own network.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
