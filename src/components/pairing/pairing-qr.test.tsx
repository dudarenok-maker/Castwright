import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PairingQr } from './pairing-qr';

describe('PairingQr', () => {
  it('renders a QR image and Regenerate button for a CWP1 companion payload', async () => {
    render(
      <PairingQr
        payload="CWP1*h*c*f"
        expiresAt={Date.now() + 300000}
        onRegenerate={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByRole('img', { name: /qr/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('renders a QR image and Regenerate button for a URL payload', async () => {
    render(
      <PairingQr
        payload="https://192.168.1.5:8443/admin"
        expiresAt={Date.now() + 300000}
        onRegenerate={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByRole('img', { name: /qr/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });
});
