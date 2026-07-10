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
