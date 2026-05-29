/* QwenStatusNotice — install-check + promo banner (qwen-default phase 4). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QwenStatusNotice } from './qwen-status-notice';

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('QwenStatusNotice', () => {
  it('renders the install-check + promo nudge when Qwen is not installed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'not-installed', installed: false }));
    render(<QwenStatusNotice />);
    await waitFor(() => expect(screen.getByTestId('qwen-status-notice')).toBeInTheDocument());
    expect(screen.getByText(/render in Kokoro/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Account → Models/i });
    expect(link).toHaveAttribute('href', '#/account');
  });

  it('renders nothing when Qwen is installed (no nagging installed users)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'ready', installed: true }));
    const { container } = render(<QwenStatusNotice />);
    // Give the probe a tick to resolve, then assert nothing rendered.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('qwen-status-notice')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the probe is unreachable (no false warning)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    render(<QwenStatusNotice />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('qwen-status-notice')).not.toBeInTheDocument();
  });
});
