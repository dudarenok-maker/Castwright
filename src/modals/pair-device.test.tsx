import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PairDeviceModal } from './pair-device';
import { api, ApiError } from '../lib/api';

const SESSION = {
  qrPayload: 'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R',
  hostPort: '192.168.1.5:8443',
  port: 8443,
  code: 'K7QF3M2P',
  fpTag: 'J4XQ2A7BWZ9K3M5R',
  expiresAt: Date.now() + 300000,
};

const generate = () =>
  fireEvent.click(screen.getByRole('button', { name: /generate pairing code/i }));

describe('PairDeviceModal (QR redesign)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens on the naming step, not straight into a session fetch', () => {
    const spy = vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    expect(screen.getByTestId('pair-device-naming')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the typed device name to createPairSession', async () => {
    const spy = vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: "Anna's phone" } });
    generate();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("Anna's phone"));
  });

  it('renders the compact QR + manual fields from the session payload', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-qr-image')).toBeInTheDocument());
    expect(screen.getByText('192.168.1.5:8443')).toBeInTheDocument();
    expect(screen.getByText('K7QF3M2P')).toBeInTheDocument();
    expect(screen.getByText('J4XQ2A7BWZ9K3M5R')).toBeInTheDocument();
  });

  it('shows the unavailable state when the session 409s', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed (409): not-lan-https'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-unavailable')).toBeInTheDocument());
  });

  it('shows the restricted guidance when the session 403s (reached via a bare LAN IP)', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed (403): ...'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-restricted')).toBeInTheDocument());
  });

  // #2278 review Finding 2 — the modal used to hardcode
  // `https://localhost:8443` in this panel's copy, so an install with
  // LAN_HTTPS_PORT overridden pointed the user at a dead address. It now
  // renders the SERVER's own message verbatim (pairingOriginHint(), already
  // port-correct) instead of composing its own — this pins that a non-default
  // port in the server's message actually reaches the screen. fromServer:
  // true (round 3, Finding 1) — this IS a genuine parsed JSON `{error}` body.
  it('renders the server-provided, port-correct guidance on a 403 — not a hardcoded 8443', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(
      new ApiError(
        'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
        403,
        true,
      ),
    );
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    expect(
      await screen.findByText(/start pairing from https:\/\/localhost:9443 or https:\/\/castwright\.local/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/localhost:8443/i)).not.toBeInTheDocument();
  });

  // #2278 review round 3, Finding 1 — a 403 whose body wasn't genuine JSON
  // `{error}` prose (an HTML 403 from an interposed proxy, or the :443
  // forwarder) leaves ApiError.fromServer at its default false and the
  // message a bare "pair session failed (403)" developer string. Before this
  // round that string became the modal's ENTIRE restricted panel; it must
  // now render the generic fallback instead.
  it('falls back to generic guidance on a 403 whose body was not genuine server prose (ApiError.fromServer false)', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(
      new ApiError('pair session failed (403)', 403), // fromServer defaults false
    );
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    expect(
      await screen.findByText('Pairing can only be started from the computer running Castwright.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pair session failed/i)).not.toBeInTheDocument();
  });

  // #2278 review round 3, Finding 2 — a live ApiError.status must decide
  // 409-vs-403 on its own; the /\bNNN\b/ regex fallback exists only for a
  // plain Error with no status (e.g. this suite's own older mocks below), so
  // it must not fire when a real status is present, even if the server's own
  // message happens to contain a "409"-looking substring (a port, say).
  it('a live 403 status routes to restricted even when the message body contains "409" (LAN_HTTPS_PORT edge case)', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(
      new ApiError(
        'Start pairing from https://localhost:409 or https://castwright.local on the computer running Castwright.',
        403,
        true,
      ),
    );
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    expect(await screen.findByTestId('pair-device-restricted')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-device-unavailable')).not.toBeInTheDocument();
  });

  it('shows a generic error on a non-409/403 failure', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('network down'));
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-device-error')).toBeInTheDocument());
  });

  it('renders a countdown for the pairing code', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue(SESSION);
    render(<PairDeviceModal open onClose={() => {}} />);
    generate();
    await waitFor(() => expect(screen.getByTestId('pair-code-countdown')).toBeInTheDocument());
    expect(screen.getByTestId('pair-code-countdown').textContent).toMatch(/expires in \d+:\d{2}/);
  });
});
