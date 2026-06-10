/* Apple Books cover source via the keyless iTunes Search API.
   artworkUrl100 ends in a `100x100bb` size token we swap for a larger
   one to get a usable cover. */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface ItunesResult {
  trackId?: number;
  collectionId?: number;
  artworkUrl100?: string;
  releaseDate?: string;
}

export async function searchApple(title: string, author: string): Promise<CoverCandidate[]> {
  const term = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!term) return [];

  const params = new URLSearchParams({ term, media: 'ebook', limit: '10' });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  const json = await fetchSourceJson<{ results?: ItunesResult[] }>('apple', url, SEARCH_TIMEOUT_MS);

  const results = Array.isArray(json.results) ? json.results : [];
  const seen = new Set<number>();
  const out: CoverCandidate[] = [];
  for (const r of results) {
    const localId = r.trackId ?? r.collectionId;
    if (typeof localId !== 'number' || !Number.isFinite(localId)) continue;
    if (!r.artworkUrl100) continue;
    if (seen.has(localId)) continue;
    seen.add(localId);
    out.push({
      id: `apple:${localId}`,
      source: 'apple',
      coverUrl: r.artworkUrl100.replace(/100x100bb/g, '600x600bb'),
      edition: formatEdition(undefined, parseYear(r.releaseDate)),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
