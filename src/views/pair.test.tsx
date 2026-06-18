import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

function renderPair(search = '/pair?c=ABC') {
  return render(
    <MemoryRouter initialEntries={[search]}>
      <Routes>
        <Route path="/pair" element={<PairShell />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PairShell', () => {
  beforeEach(() => {
    vi.mocked(api.redeemBrowserPair).mockResolvedValue({ label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' });
  });

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
});
