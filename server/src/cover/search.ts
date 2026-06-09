/* Aggregation over the per-source adapters.
   - aggregateCovers: parallel fan-out (allSettled) → round-robin
     interleave for the picker grid; a slow/failed source never blocks
     the others.
   - firstAvailableCover: sequential priority order for the silent
     import auto-fetch; returns the first source's top hit.
   - findCandidateById: re-derives a single candidate's URL on POST,
     querying ONLY that candidate's own source (cheaper + isolates POST
     from unrelated-source outages). Never trusts a client-supplied URL. */

import { type CoverCandidate, type CoverSource } from './sources/types.js';
import { searchOpenLibrary } from './sources/openlibrary.js';
import { searchApple } from './sources/apple.js';
import { searchGoogle } from './sources/google.js';

const MAX_TOTAL = 12;

type Adapter = (title: string, author: string) => Promise<CoverCandidate[]>;

/** Source order = picker fan-out order = auto-fetch priority/fallback order. */
const SOURCES: { source: CoverSource; search: Adapter }[] = [
  { source: 'openlibrary', search: searchOpenLibrary },
  { source: 'apple', search: searchApple },
  { source: 'google', search: searchGoogle },
];

export async function aggregateCovers(title: string, author: string): Promise<CoverCandidate[]> {
  const settled = await Promise.allSettled(SOURCES.map((s) => s.search(title, author)));
  const lists = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[cover] ${SOURCES[i].source} search failed: ${(r.reason as Error)?.message}`);
    return [];
  });
  return interleave(lists, MAX_TOTAL);
}

function interleave(lists: CoverCandidate[][], cap: number): CoverCandidate[] {
  const out: CoverCandidate[] = [];
  for (let rank = 0; out.length < cap; rank++) {
    let added = false;
    for (const list of lists) {
      const c = list[rank];
      if (c) {
        out.push(c);
        added = true;
        if (out.length >= cap) break;
      }
    }
    if (!added) break;
  }
  return out;
}

export async function firstAvailableCover(
  title: string,
  author: string,
): Promise<CoverCandidate | null> {
  for (const { source, search } of SOURCES) {
    try {
      const list = await search(title, author);
      if (list.length > 0) return list[0];
    } catch (e) {
      console.warn(`[cover] ${source} search failed: ${(e as Error).message}`);
    }
  }
  return null;
}

export async function findCandidateById(
  title: string,
  author: string,
  candidateId: string,
): Promise<CoverCandidate | null> {
  const sep = candidateId.indexOf(':');
  if (sep <= 0) return null;
  const source = candidateId.slice(0, sep) as CoverSource;
  const entry = SOURCES.find((s) => s.source === source);
  if (!entry) return null;
  const list = await entry.search(title, author);
  return list.find((c) => c.id === candidateId) ?? null;
}
