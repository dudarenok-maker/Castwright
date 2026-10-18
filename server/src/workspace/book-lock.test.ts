/* #3400 — `withBookLock` runs `fn` inline when the current async context
   already holds the book (so the scan self-heal can nest under a handler that
   holds it). AsyncLocalStorage propagates into work the holder spawns and does
   NOT await, so "held" must mean held RIGHT NOW: once the holder settles, that
   detached work is no longer inside the lock and must queue like anyone else. */

import { describe, it, expect } from 'vitest';
import { withBookLock } from './book-lock.js';

const tick = (n: number) => new Promise<void>((r) => setTimeout(r, n));

describe('withBookLock', () => {
  it('runs a nested acquisition inline (no deadlock) while the holder is still running', async () => {
    const out = await withBookLock('nest', async () => withBookLock('nest', async () => 'inner'));
    expect(out).toBe('inner');
  });

  it('serialises two plain acquisitions of the same book', async () => {
    const events: string[] = [];
    const a = withBookLock('ser', async () => {
      events.push('a-start');
      await tick(20);
      events.push('a-end');
    });
    const b = withBookLock('ser', async () => {
      events.push('b-start');
    });
    await Promise.all([a, b]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('queues detached work a released holder left behind instead of running it inline', async () => {
    const events: string[] = [];
    let detached!: Promise<void>;
    await withBookLock('detached', async () => {
      /* fire-and-forget: inherits the holder's async context */
      detached = new Promise<void>((resolve) => {
        setTimeout(() => {
          void withBookLock('detached', async () => {
            events.push('detached-run');
          }).then(resolve);
        }, 20);
      });
    });
    /* the holder has released; a second holder now owns the book */
    const second = withBookLock('detached', async () => {
      events.push('second-start');
      await tick(80);
      events.push('second-end');
    });
    await Promise.all([second, detached]);
    expect(events).toEqual(['second-start', 'second-end', 'detached-run']);
  });

  it('still runs a nested acquisition inline from work the holder awaits after spawning detached work', async () => {
    const out = await withBookLock('mixed', async () => {
      setTimeout(() => void 0, 1);
      await tick(5);
      return withBookLock('mixed', async () => 'ok');
    });
    expect(out).toBe('ok');
  });
});
