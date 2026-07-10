import { describe, it, expect } from 'vitest';
import { bookExportJobToQueueItem } from './export-queue-adapter';
import type { BookExportJob } from './types';

function job(overrides: Partial<BookExportJob>): BookExportJob {
  return {
    id: 'exp_1',
    bookId: 'bk_1',
    format: 'mp3-zip',
    destination: 'download',
    status: 'done',
    filename: 'book.zip',
    sizeBytes: 1024,
    progress: 1,
    downloadUrl: '/download',
    syncPath: null,
    errorReason: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  } as BookExportJob;
}

describe('bookExportJobToQueueItem — captions (fs-52)', () => {
  it('badges a whole-book .srt export as srt', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'srt', captionScope: 'whole-book', filename: 'book.sentence.srt' }),
    );
    expect(item.format).toBe('srt');
  });

  it('badges a whole-book .vtt export as vtt', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'vtt', captionScope: 'whole-book', filename: 'book.sentence.vtt' }),
    );
    expect(item.format).toBe('vtt');
  });

  it('badges a per-chapter caption export as zip regardless of file format', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'srt', captionScope: 'per-chapter', filename: 'book.line.srt.zip' }),
    );
    expect(item.format).toBe('zip');
  });

  it('carries the persisted warning through to the queue item', () => {
    const item = bookExportJobToQueueItem(
      job({
        format: 'captions',
        captionFileFormat: 'srt',
        captionScope: 'whole-book',
        warning: "Some of this book's chapters predate render-time staleness tracking...",
      }),
    );
    expect(item.warning).toMatch(/predate render-time staleness/);
  });

  it('leaves warning undefined when the job has none', () => {
    const item = bookExportJobToQueueItem(job({ format: 'mp3-zip' }));
    expect(item.warning).toBeUndefined();
  });

  /* fs-52 final-review fix — a failed captions job's Retry button
     (src/store/exports-middleware.ts retryExport) reads these three
     fields off the queue item to re-POST a valid captions export
     request; without them the server 400s. */
  it('carries captionFileFormat/captionGranularity/captionScope through to the queue item', () => {
    const item = bookExportJobToQueueItem(
      job({
        format: 'captions',
        captionFileFormat: 'vtt',
        captionGranularity: 'word',
        captionScope: 'per-chapter',
      }),
    );
    expect(item.captionFileFormat).toBe('vtt');
    expect(item.captionGranularity).toBe('word');
    expect(item.captionScope).toBe('per-chapter');
  });

  it('leaves the caption fields undefined for a non-captions job', () => {
    const item = bookExportJobToQueueItem(job({ format: 'mp3-zip' }));
    expect(item.captionFileFormat).toBeUndefined();
    expect(item.captionGranularity).toBeUndefined();
    expect(item.captionScope).toBeUndefined();
  });
});
