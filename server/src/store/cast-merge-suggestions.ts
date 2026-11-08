/* Per-book merge suggestions sibling file.

   Two producers feed it: the dedup pass (roster-dedup.ts Tier-2b diminutive
   pairs — e.g. "Оля + Ольга — same person?") and the re-analysis matcher's
   open questions. They persist to a sibling file (NOT inside cast.json) so the
   UI can surface them across browser reloads and re-analyses without the
   cast.json envelope stripping them.

   #4031 — suggestions are DURABLE and keyed by UNORDERED pair. A run adds to
   the file and removes a pair only once it is resolved (a row is gone, the two
   merged, or the pair declined); the old whole-file overwrite is gone. Every
   read-modify-write here is done by a caller holding the cast lock
   (`reconcileSuggestionsLocked` / `removeSuggestionPairsLocked`), because the
   analysis persist and the suggestion routes would otherwise lose each other's
   updates.

   Lifecycle:
     - `reconcileSuggestionsLocked` — a run's add + prune, under the cast lock.
     - `removeSuggestionPairsLocked` — drop resolved pairs (accept), under the
       cast lock.
     - `dismissSuggestionDurably` — the dismiss route: takes the cast lock itself.
     - `loadStoredSuggestions` / `loadSuggestions` — the full stored shape, and
       the `MergeSuggestion` shape the GET route serves.
     - `clearSuggestions` — no-op when absent.

   Same atomic-write + empty-on-missing contract as store/cast-merges.ts. */

import { rm } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { castMergeSuggestionsJsonPath, castJsonPath } from '../workspace/paths.js';
import { withCastLock } from '../workspace/cast-lock.js';
import {
  loadCastIdHistoryWithStatus,
  recordNotSamePerson,
} from './cast-id-history.js';
import type { MergeSuggestion } from '../analyzer/roster-dedup.js';
import type { NotLinkedEntry, StoredSuggestion } from './reanalysis-types.js';

export type { MergeSuggestion };

export interface CastMergeSuggestionsFile {
  suggestions: MergeSuggestion[];
}

/** The unordered key of a pair: the two ids, sorted. */
export function pairKey(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

const keyOf = (a: string, b: string): string => `${a}\u0000${b}`;

/** A file written before #4031 holds `{ sourceId, targetId, reason }` only;
    fill in the pair and the origin, leave `newRow`/`candidate` absent. */
function normalise(raw: unknown): StoredSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredSuggestion>;
  if (typeof s.sourceId !== 'string' || typeof s.targetId !== 'string') return null;
  const { a, b } = pairKey(s.sourceId, s.targetId);
  return {
    ...s,
    sourceId: s.sourceId,
    targetId: s.targetId,
    a,
    b,
    reason: typeof s.reason === 'string' ? s.reason : '',
    origin: s.origin === 'plan' ? 'plan' : 'dedup',
  };
}

/** Load the stored suggestions, one entry per unordered pair (the first one
    in the file wins, so a pair keeps its direction). Empty when absent or
    malformed. */
export async function loadStoredSuggestions(bookDir: string): Promise<StoredSuggestion[]> {
  const existing = await readJson<{ suggestions?: unknown }>(castMergeSuggestionsJsonPath(bookDir));
  if (!existing || !Array.isArray(existing.suggestions)) return [];
  const seen = new Set<string>();
  const out: StoredSuggestion[] = [];
  for (const raw of existing.suggestions) {
    const s = normalise(raw);
    if (!s || s.a === s.b) continue;
    const k = keyOf(s.a, s.b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Load the suggestions in the `MergeSuggestion` shape the GET route serves;
    `{ suggestions: [] }` when the file is absent or malformed. */
export async function loadSuggestions(bookDir: string): Promise<CastMergeSuggestionsFile> {
  const stored = await loadStoredSuggestions(bookDir);
  return {
    suggestions: stored.map((s) => ({ sourceId: s.sourceId, targetId: s.targetId, reason: s.reason })),
  };
}

async function writeStored(bookDir: string, suggestions: StoredSuggestion[]): Promise<void> {
  await writeJsonAtomic(castMergeSuggestionsJsonPath(bookDir), { suggestions });
}

/** Add this run's suggestions and prune the file. CALLER HOLDS THE CAST LOCK.
    A pair already stored keeps its entry (and so its direction). A suggestion
    is dropped once either side is not in `liveIds`, the two were merged
    (`supersededBy` names one by the other), or the pair is `declined`. */
export async function reconcileSuggestionsLocked(
  bookDir: string,
  a: {
    add: StoredSuggestion[];
    remove?: Array<[string, string]>;
    liveIds: ReadonlySet<string>;
    supersededBy: Readonly<Record<string, string>>;
    declined: (a: string, b: string) => boolean;
  },
): Promise<void> {
  const removed = new Set((a.remove ?? []).map(([x, y]) => pairKey(x, y)).map((p) => keyOf(p.a, p.b)));
  const byPair = new Map<string, StoredSuggestion>();
  for (const s of await loadStoredSuggestions(bookDir)) byPair.set(keyOf(s.a, s.b), s);
  for (const raw of a.add) {
    const s = normalise(raw);
    if (!s || s.a === s.b) continue;
    const k = keyOf(s.a, s.b);
    if (!byPair.has(k)) byPair.set(k, s);
  }
  const kept = [...byPair.entries()]
    .filter(([k, s]) => {
      if (removed.has(k)) return false;
      if (!a.liveIds.has(s.a) || !a.liveIds.has(s.b)) return false;
      if (a.supersededBy[s.a] === s.b || a.supersededBy[s.b] === s.a) return false;
      return !a.declined(s.a, s.b);
    })
    .map(([, s]) => s);
  await writeStored(bookDir, kept);
}

/** Drop the given pairs (either direction). CALLER HOLDS THE CAST LOCK. No-op
    when none is stored. */
export async function removeSuggestionPairsLocked(
  bookDir: string,
  pairs: Array<[string, string]>,
): Promise<void> {
  const drop = new Set(pairs.map(([x, y]) => pairKey(x, y)).map((p) => keyOf(p.a, p.b)));
  const stored = await loadStoredSuggestions(bookDir);
  const kept = stored.filter((s) => !drop.has(keyOf(s.a, s.b)));
  if (kept.length === stored.length) return;
  await writeStored(bookDir, kept);
}

/** Delete the suggestions file. No-op when absent. */
export async function clearSuggestions(bookDir: string): Promise<void> {
  await rm(castMergeSuggestionsJsonPath(bookDir), { force: true });
}


/** The dismiss action: a durable "not the same person" decision. Under the cast
    lock (then, inside it, the cast-id-history lock — cast -> cast-id-history):
      1. read cast.json and the history status;
      2. write the dismissal record, unless the history is degraded (it cannot
         be read, so nothing may be written over it) — skipped and logged;
      3. write the `notLinkedTo` edge on each row that exists;
      4. remove the pair. */
export async function dismissSuggestionDurably(
  bookDir: string,
  bookId: string,
  x: string,
  y: string,
  log: (m: string) => void,
): Promise<void> {
  await withCastLock(bookDir, async () => {
    const cast = await readJson<{ characters?: Array<{ id: string; notLinkedTo?: NotLinkedEntry[] }> }>(
      castJsonPath(bookDir),
    );
    const { status } = await loadCastIdHistoryWithStatus(bookDir);
    if (status === 'degraded') {
      log(
        `cast-id-history.json for this book could not be read — the dismissal record of ${x} / ${y} was not written (edges and suggestion removal still applied).`,
      );
    } else {
      await recordNotSamePerson(bookDir, x, y);
    }
    if (cast?.characters?.length) {
      let changed = false;
      const characters = cast.characters.map((c) => {
        const other = c.id === x ? y : c.id === y ? x : null;
        if (other === null) return c;
        const edges = c.notLinkedTo ?? [];
        if (edges.some((e) => typeof e === 'object' && e.bookId === bookId && e.characterId === other)) {
          return c;
        }
        changed = true;
        return { ...c, notLinkedTo: [...edges, { bookId, characterId: other }] };
      });
      if (changed) await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters });
    }
    await removeSuggestionPairsLocked(bookDir, [[x, y]]);
  });
}
