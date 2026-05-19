/* Tests for the share-clip modal (plan 69). Pairs with the BACKLOG #6
   acceptance:
     - Default window = ±15 s around the playhead → 30 s clip.
     - Drag start / end via the range sliders (jsdom supports
       input[type=range] via .change/.input events).
     - Confirm dispatches a URL with the right
       /api/books/.../clip?start=&duration= params, route encoded.
     - End > start+60 is clamped (server enforces too; we mirror the
       cap so the disabled-confirm state shows up before round-tripping). */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShareClipModal, MAX_CLIP_DURATION_SEC } from './share-clip';
import type { Chapter } from '../lib/types';

const chapter: Chapter = {
  id: 2,
  title: 'Chapter 2',
  duration: '05:00',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done' },
};

function renderModal(overrides: Partial<React.ComponentProps<typeof ShareClipModal>> = {}) {
  const props = {
    open: true,
    bookId: 'book__series__title',
    chapter,
    playheadSec: 90,
    durationSec: 300,
    onClose: vi.fn(),
    onDownload: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ShareClipModal {...props} />) };
}

describe('ShareClipModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false });
    expect(screen.queryByTestId('share-clip-modal')).toBeNull();
  });

  it('renders nothing when chapter is null', () => {
    renderModal({ chapter: null });
    expect(screen.queryByTestId('share-clip-modal')).toBeNull();
  });

  it('defaults the window to ±15 s around the playhead', () => {
    /* Playhead = 1:30 → start = 1:15, end = 1:45, clip = 30 s. */
    renderModal({ playheadSec: 90 });
    const start = screen.getByTestId('share-clip-start-input') as HTMLInputElement;
    const end = screen.getByTestId('share-clip-end-input') as HTMLInputElement;
    expect(start.value).toBe('1:15');
    expect(end.value).toBe('1:45');
    expect(screen.getByTestId('share-clip-length').textContent).toBe('0:30');
  });

  it('centres on chapter midpoint when no playhead is provided', () => {
    /* Duration 5:00 → midpoint 2:30 → ±15 = 2:15 / 2:45. */
    renderModal({ playheadSec: null });
    const start = screen.getByTestId('share-clip-start-input') as HTMLInputElement;
    const end = screen.getByTestId('share-clip-end-input') as HTMLInputElement;
    expect(start.value).toBe('2:15');
    expect(end.value).toBe('2:45');
  });

  it('drags the start range to 1:20 and end range to 1:50, confirm fires the right URL', () => {
    const { props } = renderModal({
      playheadSec: 90,
      durationSec: 300,
      bookId: 'b1',
    });
    /* 1:20 = 80 s, 1:50 = 110 s. */
    fireEvent.change(screen.getByTestId('share-clip-start-range'), {
      target: { value: '80' },
    });
    fireEvent.change(screen.getByTestId('share-clip-end-range'), {
      target: { value: '110' },
    });
    expect(
      (screen.getByTestId('share-clip-start-input') as HTMLInputElement).value,
    ).toBe('1:20');
    expect(
      (screen.getByTestId('share-clip-end-input') as HTMLInputElement).value,
    ).toBe('1:50');

    fireEvent.click(screen.getByTestId('share-clip-confirm'));
    expect(props.onDownload).toHaveBeenCalledTimes(1);
    const url: string = (props.onDownload as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toMatch(/^\/api\/books\/b1\/chapters\/2\/clip\?/);
    expect(url).toMatch(/start=80\.00/);
    expect(url).toMatch(/duration=30\.00/);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('typing into the start input updates the value and clamps below end', () => {
    renderModal({ playheadSec: 90, durationSec: 300 });
    fireEvent.change(screen.getByTestId('share-clip-start-input'), {
      target: { value: '2:00' },
    });
    /* End was 1:45 — start must clamp to end-1 = 1:44 */
    const start = screen.getByTestId('share-clip-start-input') as HTMLInputElement;
    expect(start.value).toBe('1:44');
  });

  it('end input is clamped to start + 60 (the share cap)', () => {
    renderModal({ playheadSec: 90, durationSec: 600 });
    /* Start at 1:15. Force end to a wildly out-of-range value (10:00 == 600 s);
       expect clamp to start + 60 = 1:15 + 0:60 = 2:15. */
    fireEvent.change(screen.getByTestId('share-clip-end-input'), {
      target: { value: '10:00' },
    });
    const end = screen.getByTestId('share-clip-end-input') as HTMLInputElement;
    expect(end.value).toBe('2:15');
    /* 60 s rolls over to 1:00 in mm:ss formatting. */
    expect(screen.getByTestId('share-clip-length').textContent).toBe('1:00');
    expect(MAX_CLIP_DURATION_SEC).toBe(60);
  });

  it('+5 / -5 buttons step the range by 5 s', () => {
    renderModal({ playheadSec: 90, durationSec: 300 });
    /* Start: 1:15 → -5 → 1:10 */
    fireEvent.click(screen.getByTestId('share-clip-start-down'));
    expect(
      (screen.getByTestId('share-clip-start-input') as HTMLInputElement).value,
    ).toBe('1:10');
    /* End: 1:45 → +5 → 1:50 */
    fireEvent.click(screen.getByTestId('share-clip-end-up'));
    expect(
      (screen.getByTestId('share-clip-end-input') as HTMLInputElement).value,
    ).toBe('1:50');
  });

  it('backdrop click invokes onClose', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByTestId('share-clip-backdrop'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('confirm URL encodes the bookId so reserved characters survive the round-trip', () => {
    const { props } = renderModal({ bookId: 'Author With Spaces__series__title' });
    fireEvent.click(screen.getByTestId('share-clip-confirm'));
    const url: string = (props.onDownload as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toContain('Author%20With%20Spaces__series__title');
  });
});
