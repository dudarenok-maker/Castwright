/* Google Books cover source — keyless, best-effort. Lowest-resolution
   of the three; the aggregation layer simply drops it when it errors or
   returns nothing. Thumbnails come back http with an `edge=curl` page-curl
   overlay and a small zoom; normalise to a clean https image. */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    publisher?: string;
    publishedDate?: string;
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
}

function normaliseImage(u: string): string {
  return u
    .replace(/^http:/, 'https:')
    .replace(/[?&]edge=curl/, '')
    .replace(/zoom=\d/, 'zoom=1');
}

export async function searchGoogle(title: string, author: string): Promise<CoverCandidate[]> {
  const q = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!q) return [];

  const params = new URLSearchParams({ q, country: 'US', maxResults: '10' });
  const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
  const json = await fetchSourceJson<{ items?: GoogleVolume[] }>('google', url, SEARCH_TIMEOUT_MS);

  const items = Array.isArray(json.items) ? json.items : [];
  const seen = new Set<string>();
  const out: CoverCandidate[] = [];
  for (const v of items) {
    const id = v.id;
    const thumb = v.volumeInfo?.imageLinks?.thumbnail ?? v.volumeInfo?.imageLinks?.smallThumbnail;
    if (!id || !thumb) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: `google:${id}`,
      source: 'google',
      coverUrl: normaliseImage(thumb),
      edition: formatEdition(v.volumeInfo?.publisher, parseYear(v.volumeInfo?.publishedDate)),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
