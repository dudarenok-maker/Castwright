/* Plan 67 — share-link modal coverage.

   The modal is a pure presenter: it renders the URL the parent has
   already minted, copies on button click via the Clipboard API, and
   flips a transient "Copied" state on success. The parent owns the
   async-mint + the post-failure toast.

   These specs pin the four behaviours that make the modal trustworthy:
   - The URL field renders the prop verbatim (no truncation, no
     reformat) so the copied string matches the displayed one.
   - Clicking Copy calls navigator.clipboard.writeText with the URL.
   - Success flips the button to "Copied"; failure routes through
     onCopyFailed and flips to "Copy failed". */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ShareLinkModal } from './share-link';

describe('share-link modal', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not mount when open=false', () => {
    render(
      <ShareLinkModal
        open={false}
        url="https://example.test/share/ABCDEFGHJKMN"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('share-link-modal')).toBeNull();
  });

  it('renders the URL verbatim in a read-only input', () => {
    const url = 'https://example.test/share/ABCDEFGHJKMN';
    render(<ShareLinkModal open={true} url={url} onClose={() => {}} />);
    const input = screen.getByTestId('share-link-url') as HTMLInputElement;
    expect(input.value).toBe(url);
    expect(input.readOnly).toBe(true);
  });

  it('disables the Copy button while the URL is still null (mint in flight)', () => {
    render(<ShareLinkModal open={true} url={null} onClose={() => {}} />);
    const button = screen.getByTestId('share-link-copy') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('writes the URL to the clipboard on Copy click and flips to "Copied"', async () => {
    const url = 'https://example.test/share/ABCDEFGHJKMN';
    render(<ShareLinkModal open={true} url={url} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('share-link-copy'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(url);
    });
    await waitFor(() => {
      expect(screen.getByTestId('share-link-copy').textContent).toMatch(/Copied/i);
    });
  });

  it('routes clipboard failures through onCopyFailed + flips to "Copy failed"', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('permission denied')));
    const onCopyFailed = vi.fn();
    render(
      <ShareLinkModal
        open={true}
        url="https://example.test/share/ABCDEFGHJKMN"
        onClose={() => {}}
        onCopyFailed={onCopyFailed}
      />,
    );
    fireEvent.click(screen.getByTestId('share-link-copy'));
    await waitFor(() => {
      expect(onCopyFailed).toHaveBeenCalledWith('permission denied');
    });
    await waitFor(() => {
      expect(screen.getByTestId('share-link-copy').textContent).toMatch(/Copy failed/i);
    });
  });

  it('Escape closes the modal', () => {
    const onClose = vi.fn();
    render(
      <ShareLinkModal
        open={true}
        url="https://example.test/share/ABCDEFGHJKMN"
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop closes the modal', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ShareLinkModal
        open={true}
        url="https://example.test/share/ABCDEFGHJKMN"
        onClose={onClose}
      />,
    );
    /* Backdrop is the first fixed inset-0 div before the modal panel. */
    const backdrop = container.querySelector('.bg-ink\\/40');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });
});
