/* Serialises evict+load sequences. The GpuSemaphore arbitrates EXECUTION (token
   budget around /chat and /synthesize); it neither knows about nor serialises
   model LOADS. This mutex makes evict→verify→load atomic so two concurrent
   starts can't both evict then both load and overcommit. */
let tail: Promise<unknown> = Promise.resolve();
export function withGpuLoadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
