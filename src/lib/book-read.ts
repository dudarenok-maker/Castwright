/* #3967 — bounded book-state reads, moved out of components/layout.tsx so store
   middleware and views can share them without importing a component (#3426). */

const REVISIONS_HYDRATE_RETRY_BASE_MS = 2000;
const REVISIONS_HYDRATE_RETRY_MAX_MS = 30000;
export const BOOK_READ_TIMEOUT_MS = 15000;
export const retryDelayMs = (attempt: number) =>
  Math.min(REVISIONS_HYDRATE_RETRY_BASE_MS * 2 ** attempt, REVISIONS_HYDRATE_RETRY_MAX_MS);

/** The rejection `within` gives an expired bound — told apart by type, not message. */
export class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'ReadTimeoutError';
  }
}

/* #3967 — a bounded book-state read that retries an EXPIRED attempt on the
   hydrate's schedule (retryDelayMs) until it lands: the late answer a bare
   `within` gave up on is not lost for good. `onExpire` fires on each expiry
   (attempt index). Aborting `outer` — the caller's cleanup — aborts the
   in-flight read, cancels the pending retry timer, and rejects with an
   AbortError; a non-timeout rejection passes through unretried. */
export function readWithRetry<T>(
  read: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  timers: Set<ReturnType<typeof setTimeout>>,
  onExpire?: (attempt: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let inner: AbortController | undefined;
    const onAbort = () => {
      if (retryTimer) clearTimeout(retryTimer);
      inner?.abort();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (outer.aborted) return onAbort();
    outer.addEventListener('abort', onAbort, { once: true });
    const attempt = (n: number): void => {
      const ctrl = new AbortController();
      inner = ctrl;
      within(read(ctrl.signal), BOOK_READ_TIMEOUT_MS, timers, () => ctrl.abort()).then(
        (v) => {
          outer.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          if (outer.aborted) return;
          if (e instanceof ReadTimeoutError) {
            onExpire?.(n);
            const t = setTimeout(() => {
              timers.delete(t);
              attempt(n + 1);
            }, retryDelayMs(n));
            retryTimer = t;
            timers.add(t);
            return;
          }
          outer.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    };
    attempt(0);
  });
}

/* #3426 — settle `p`, or reject after `ms` if it hasn't. `onExpire` (after the
   rejection) lets the caller abort the request; otherwise `p` is not cancelled
   and its late answer is discarded. `timers` collects the bound's timer so the
   caller's cleanup can clear it. */
export function within<T>(
  p: Promise<T>,
  ms: number,
  timers: Set<ReturnType<typeof setTimeout>>,
  onExpire?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reject(new ReadTimeoutError(ms));
      onExpire?.();
    }, ms);
    timers.add(timer);
    p.then(
      (v) => { clearTimeout(timer); timers.delete(timer); resolve(v); },
      (e) => { clearTimeout(timer); timers.delete(timer); reject(e); },
    );
  });
}
