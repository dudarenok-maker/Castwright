/* OpenLibrary cover source. Free-text `q=` query (the strict
   title=/author= query missed catalogued-under-a-different-title books
   like Skulduggery Pleasant / "Scepter of the Ancients"). */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface OpenLibraryDoc {
  cover_i?: number;
  publisher?: string[];
  publish_date?: string[];
  first_publish_year?: number;
}

export async function searchOpenLibrary(title: string, author: string): Promise<CoverCandidate[]> {
  const q = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!q) return [];

  const params = new URLSearchParams({ q, limit: '20' });
  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  const json = await fetchSourceJson<{ docs?: OpenLibraryDoc[] }>(
    'openlibrary',
    url,
    SEARCH_TIMEOUT_MS,
  );

  const docs = Array.isArray(json.docs) ? json.docs : [];
  const seen = new Set<number>();
  const out: CoverCandidate[] = [];
  for (const d of docs) {
    if (typeof d.cover_i !== 'number' || !Number.isFinite(d.cover_i)) continue;
    if (seen.has(d.cover_i)) continue;
    seen.add(d.cover_i);
    out.push({
      id: `openlibrary:${d.cover_i}`,
      source: 'openlibrary',
      coverUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      edition: formatEdition(d.publisher?.[0], d.first_publish_year ?? parseYear(d.publish_date?.[0])),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
