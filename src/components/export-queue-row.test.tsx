import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExportQueueRow } from './export-queue-row';
import type { ExportQueueItem } from '../lib/types';

function item(overrides: Partial<ExportQueueItem> = {}): ExportQueueItem {
  return {
    id: 'exp_1',
    filename: 'book.srt',
    format: 'srt',
    size: '4 KB',
    status: 'done',
    timestamp: 'just now',
    destination: 'Downloaded',
    ...overrides,
  };
}

describe('ExportQueueRow — cancelling state (srv-96)', () => {
  it('shows "Cancelling…" with no progress bar and no Retry or Download button', () => {
    const { container } = render(
      <ExportQueueRow
        item={item({ status: 'cancelling', progress: 0.4 })}
        onDownload={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText('Cancelling…')).toBeInTheDocument();
    expect(container.querySelector('.pulse-bar')).toBeNull();
    expect(screen.queryByTitle(/Retry/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Download/)).not.toBeInTheDocument();
  });

  it('still draws the progress bar for a running row (guards the selector above)', () => {
    const { container } = render(
      <ExportQueueRow item={item({ status: 'in_progress', progress: 0.4 })} />,
    );
    expect(container.querySelector('.pulse-bar')).not.toBeNull();
  });
});

describe('ExportQueueRow — warning display (fs-52)', () => {
  it('shows the warning caption on a done row that has one', () => {
    render(<ExportQueueRow item={item({ warning: 'Could not verify staleness for some chapters.' })} />);
    expect(screen.getByText(/Could not verify staleness/)).toBeInTheDocument();
  });

  it('falls back to the destination caption when there is no warning', () => {
    render(<ExportQueueRow item={item({ destination: 'Downloaded' })} />);
    expect(screen.getByText('Downloaded')).toBeInTheDocument();
  });

  it('prioritises errorReason over warning on a failed row (should never co-occur, but errorReason wins)', () => {
    render(
      <ExportQueueRow
        item={item({ status: 'failed', errorReason: 'Build failed.', warning: 'Ignored.' })}
      />,
    );
    expect(screen.getByText('Build failed.')).toBeInTheDocument();
    expect(screen.queryByText('Ignored.')).not.toBeInTheDocument();
  });
});
