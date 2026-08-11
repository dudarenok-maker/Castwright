/* #2239 — dedicated unit coverage for the module this task moved
   `clearNotLinkedEdgesForDroppedRejections` into. No test drove the LOCKED
   variant's write payload directly before this file: `cast-link-orphan
   .test.ts`'s only exercise of it (`writeBookOnDisk`, ~line 79) seeds
   `cast.json` as `JSON.stringify({ characters })` — no sibling top-level key
   — so a regression that dropped every OTHER key on write (as the pre-fix
   `{ characters: cast.characters }` shape did) would have produced
   byte-identical output there and passed silently. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { castJsonPath } from '../workspace/paths.js';
import { clearNotLinkedEdgesForDroppedRejections } from './not-linked-edges.js';

let bookDir: string;
const BOOK_ID = 'book-hollow-tide';

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'not-linked-edges-'));
});

afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

/* No writer in this repo emits a sibling top-level key on cast.json today
   (every reader types it as `{ characters: [...] }` only — see the review
   finding this test closes). `schemaVersion` is an arbitrary but
   plausible-looking stand-in, chosen because `cast-id-history.json` already
   carries a sibling `schema` field, so a future cast.json migration adding
   the equivalent is a realistic way this could stop being hypothetical. */
function writeCast(characters: object[]): void {
  const path = castJsonPath(bookDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, characters }));
}

function readCastRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8'));
}

describe('clearNotLinkedEdgesForDroppedRejections (locked variant)', () => {
  it('clears the matching notLinkedTo edge AND preserves a sibling top-level cast.json key', async () => {
    writeCast([
      { id: 'narrator', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'mayrin' }] },
      { id: 'mairin' },
    ]);

    await clearNotLinkedEdgesForDroppedRejections(bookDir, BOOK_ID, [
      { from: 'mayrin', to: 'mairin' },
    ]);

    const raw = readCastRaw();

    // Assertion 3 (kept honest): the edge is actually cleared — a test that
    // only checked the sibling key would pass even if the helper did nothing.
    const narrator = (raw.characters as Array<{ id: string; notLinkedTo?: unknown[] }>).find(
      (c) => c.id === 'narrator',
    );
    expect(narrator?.notLinkedTo).toEqual([]);

    // Assertion 4 (the regression assertion, [G6]): the sibling top-level
    // key survives the write — this is what `{ characters: cast.characters }`
    // (pre-[G3]-fix) would have dropped.
    expect(raw.schemaVersion).toBe(1);
  });
});
