/* srv-96 — the mock export cancel takes the same two steps as the server:
   `cancelling` while the work stops, then `cancelled`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BookExportJob } from './types';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api } = await import('./api');

/** Run a mock call to completion under fake timers (each one waits briefly). */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(150);
  return p;
}

const startJob = (): Promise<BookExportJob> =>
  settle(api.createBookExport('mock-book', { format: 'mp3-zip', destination: 'download' }));
const cancel = (id: string) => settle(api.cancelBookExport('mock-book', id));
const read = (id: string) => settle(api.getBookExport('mock-book', id));

describe('mock export cancel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads cancelling first, then cancelled with completedAt and the reason', async () => {
    const { id } = await startJob();
    await cancel(id);

    const stopping = await read(id);
    expect(stopping.status).toBe('cancelling');
    expect(stopping.completedAt).toBeNull();
    expect(stopping.errorReason).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    const stopped = await read(id);
    /* Also proves the build timers were cleared: none of them flips it to done. */
    expect(stopped.status).toBe('cancelled');
    expect(stopped.completedAt).toEqual(expect.any(String));
    expect(stopped.errorReason).toBe('Cancelled by user.');
  });

  it('still settles when cancelled a second time while cancelling', async () => {
    const { id } = await startJob();
    await cancel(id);
    await cancel(id);

    await vi.advanceTimersByTimeAsync(5000);
    expect((await read(id)).status).toBe('cancelled');
  });

  it('leaves a finished job untouched', async () => {
    const { id } = await startJob();
    await vi.advanceTimersByTimeAsync(5000);
    const done = await read(id);
    expect(done.status).toBe('done');

    await cancel(id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await read(id)).toEqual(done);
  });
});
