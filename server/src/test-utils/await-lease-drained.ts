/* #4447 — wait for a book's `runBookJob` lease to be released.

   An analysis run's lease is released only after `endJob`'s detached terminal writes
   (`job.terminalWrites`) settle, which is AFTER the SSE response ends. Those writes go through
   `renameWithRetry` (worst case ~3.6 s per rename on Windows), and `runBookJob`'s `done` promise
   is not reachable from the route, so there is no deterministic hook: poll the real registry.
   `vi.waitFor`'s 1 s default is shorter than one slow rename, so give it a realistic budget; a
   passing run still returns the moment the lease is gone.

   `bookJobKinds` is passed in rather than imported: the suites load `book-op-lock` dynamically,
   after `WORKSPACE_DIR` is set. A timeout is rethrown naming the book and the lease, with the
   stack trimmed to the CALLER, so the failure says which wait gave up. */
import { vi } from 'vitest';

export const LEASE_DRAIN_TIMEOUT_MS = 10_000;

export async function awaitLeaseDrained(
  bookJobKinds: (bookId: string) => string[],
  bookId: string,
  lease = 'analysis',
): Promise<void> {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, awaitLeaseDrained);
  try {
    await vi.waitFor(() => {
      const kinds = bookJobKinds(bookId);
      if (kinds.length > 0) throw new Error(`still held: ${JSON.stringify(kinds)}`);
    }, { timeout: LEASE_DRAIN_TIMEOUT_MS });
  } catch (cause) {
    const err = new Error(
      `the '${lease}' lease on book ${bookId} was not released within ${LEASE_DRAIN_TIMEOUT_MS} ms ` +
        `(${(cause as Error).message}); bookJobKinds(${bookId}) !== []`,
    );
    err.stack = `${err.message}\n${(holder.stack ?? '').split('\n').slice(1).join('\n')}`;
    throw err;
  }
}
