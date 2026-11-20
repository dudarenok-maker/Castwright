import { parentPort, threadId } from 'node:worker_threads';

setTimeout(() => {
  parentPort?.postMessage({
    ok: true,
    parsed: { title: 'slow', chapters: [] },
    threadId,
  });
}, 300);
