/* listen-download-section — Plan 75 adds a 4th "Portable bundle" tile to
   the "Or download a file" rail. This spec pins the tile presence + the
   onPortableBundleExport callback wiring. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListenDownloadSection } from './listen-download-section';

function renderSection(overrides: Partial<Parameters<typeof ListenDownloadSection>[0]> = {}) {
  const defaultProps: Parameters<typeof ListenDownloadSection>[0] = {
    queueItems: [],
    onSendApp: vi.fn(),
    onOpenPocketBookExport: vi.fn(),
    onOpenVoiceExport: vi.fn(),
    onOpenSmartAudiobookExport: vi.fn(),
    onOpenBookplayerExport: vi.fn(),
    onOpenAudiobookshelfExport: vi.fn(),
    onOpenAppleBooksExport: vi.fn(),
    onOpenM4bExport: vi.fn(),
    onOpenMp3ZipExport: vi.fn(),
    onOpenStreamingLink: vi.fn(),
    onCopyExportLink: vi.fn(),
    onRemoveExport: vi.fn(),
    ...overrides,
  };
  return { props: defaultProps, ...render(<ListenDownloadSection {...defaultProps} />) };
}

describe('ListenDownloadSection — Portable bundle tile (plan 75)', () => {
  it('renders the Portable bundle tile alongside the existing three download tiles', () => {
    renderSection({ onPortableBundleExport: vi.fn() });
    expect(screen.getByTestId('download-tile-m4b')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-mp3-zip')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-portable')).toBeInTheDocument();
    const tile = screen.getByTestId('download-tile-portable');
    expect(tile.textContent).toMatch(/Portable bundle/i);
    expect(tile.textContent).toMatch(/Full backup/i);
  });

  it('fires onPortableBundleExport when the tile button is clicked', () => {
    const onPortableBundleExport = vi.fn();
    renderSection({ onPortableBundleExport });
    const tile = screen.getByTestId('download-tile-portable');
    const button = tile.querySelector('button');
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    expect(onPortableBundleExport).toHaveBeenCalledTimes(1);
  });

  it('renders the tile as disabled (coming soon) when no handler is provided', () => {
    renderSection({ onPortableBundleExport: undefined });
    const tile = screen.getByTestId('download-tile-portable');
    const button = tile.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('ListenDownloadSection — Apple Books tile (M4B)', () => {
  it('renders Apple Books as a live tile that opens the export modal', async () => {
    const onOpenAppleBooksExport = vi.fn();
    renderSection({ onOpenAppleBooksExport });
    const btn = screen.getByTestId('listener-app-action-apple_books');
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onOpenAppleBooksExport).toHaveBeenCalledTimes(1);
  });
});
