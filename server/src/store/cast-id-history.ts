/* Per-book character id history side-table.

   Tracks which character ids have been superseded and what they were
   replaced with. Stored as a separate JSON file under .audiobook/
   so no schema change is needed on Character or openapi.yaml.

   The supersededBy map is transitive: if a→b then b→c, both a and b
   map to c for O(1) resolution without chasing — regardless of which of
   the two retirements is recorded first. */

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withKeyLock } from '../workspace/file-lock.js';

export interface CastIdHistory {
  schema: 1;
  supersededBy: Record<string, string>;
}

export function castIdHistoryPath(bookDir: string): string {
  return join(bookDir, '.audiobook', 'cast-id-history.json');
}

/** Load the cast id history from disk. Returns empty history if missing or malformed.
 *  Never throws — a lookup side-table must not be able to break a book's render. */
export async function loadCastIdHistory(bookDir: string): Promise<CastIdHistory> {
  try {
    const raw = await readJson<CastIdHistory>(castIdHistoryPath(bookDir));
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.schema === 1 &&
      typeof raw.supersededBy === 'object' &&
      !Array.isArray(raw.supersededBy) &&
      raw.supersededBy !== null
    ) {
      return raw;
    }
  } catch {
    // Malformed JSON or other read error — return empty
  }
  return { schema: 1, supersededBy: {} };
}

/** Record that characterId `from` has been retired and replaced by `to`.
 *  Updates transitive mappings: whether a→b then b→c is recorded, or b→c
 *  then a→b, both a and b end up pointing to c in the final map (O(1)
 *  resolution). */
export async function retireCharacterId(
  bookDir: string,
  from: string,
  to: string,
): Promise<void> {
  // No-op if from === to
  if (from === to) {
    return;
  }

  // Serialize writes per-book
  const bookId = bookDir; // Use bookDir as the lock key
  return withKeyLock(`cast-id-history:${bookId}`, async () => {
    const history = await loadCastIdHistory(bookDir);

    /* Direct reversal (#2040 Task 8 fix round 1, item 3): `to` is itself
       recorded as having been retired in favour of `from` — an earlier call
       said `to -> from`, and this call says the opposite, `from -> to`. Both
       can't be true; the newer call reflects the newer roster and wins.
       Falling through to the forward-dereference below would instead
       resolve `to` through the stale chain back to `from` and write a dead
       self-loop (`from -> from`), while leaving the stale `to -> from`
       entry live — orphaning BOTH ids, since neither's target is a live
       row. Repro (review round 1): dedupe records "антон"->"anton", a later
       remap records the reverse "anton"->"антон"; without this branch the
       history ends up `{"антон":"anton","anton":"anton"}` and
       buildCastResolver drops both. Invert instead: drop the stale entry,
       repoint anything that targeted `from` at `to`, and write `from -> to`. */
    if (history.supersededBy[to] === from) {
      delete history.supersededBy[to];
      for (const [key, value] of Object.entries(history.supersededBy)) {
        if (value === from) {
          history.supersededBy[key] = to;
        }
      }
      history.supersededBy[from] = to;
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
      return;
    }

    // Dereference 'to' through any existing chain first, so the repoint
    // below is order-independent — retiring INTO an already-superseded id
    // must land on its live target, not the stale intermediate.
    const resolvedTo = history.supersededBy[to] ?? to;

    // Never write a self-entry — it would resolve nowhere. The reversal
    // branch above already covers the only way resolvedTo can equal `from`,
    // but keep this as a defensive guard against future changes here.
    if (from === resolvedTo) {
      return;
    }

    // Find all keys that currently point to 'from' and update them to 'to'
    for (const [key, value] of Object.entries(history.supersededBy)) {
      if (value === from) {
        history.supersededBy[key] = resolvedTo;
      }
    }

    // Add/update the new mapping
    history.supersededBy[from] = resolvedTo;

    // Write back
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}
