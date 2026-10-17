/* #3700 review pass 1 — `updateStateJsonLocked` must not resurrect a deleted
 * book: an absent state.json (DELETE raced the update) means NO write, and
 * `writeJsonAtomic`'s mkdir must not recreate the book dir. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStateJsonLocked } from './state-migrate.js';

describe('updateStateJsonLocked — absent state.json (#3700)', () => {
  it('writes nothing and does not recreate the book dir when state.json is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'audiobook-update-locked-'));
    try {
      const bookDir = join(root, 'deleted-book');
      mkdirSync(bookDir, { recursive: true });
      const statePath = join(bookDir, '.audiobook', 'state.json');
      // The DELETE route removed the whole book dir after the caller resolved it.
      rmSync(bookDir, { recursive: true, force: true });

      let mutated = false;
      const result = await updateStateJsonLocked(statePath, (fresh) => {
        mutated = true;
        return { ...fresh, title: 'resurrected' };
      });

      expect(mutated).toBe(false);
      expect(result).toBeNull();
      expect(existsSync(bookDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
