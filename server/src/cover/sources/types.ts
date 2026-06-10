/* Shared contract + helpers for the per-source cover adapters. Each
   adapter (openlibrary/apple/google) is a pure search(title, author) →
   CoverCandidate[] that knows only its own API. Failures surface as a
   typed CoverSourceError so the aggregation layer can swallow a single
   source without losing the others. */

export type CoverSource = 'openlibrary' | 'apple' | 'google';

export interface CoverCandidate {
  /** Composite, source-agnostic id: `<source>:<localId>` — round-trips
      through POST /cover so the route re-locates the same candidate. */
  id: string;
  source: CoverSource;
  coverUrl: string;
  /** Best-effort `<publisher> · <year>` (or just one). Optional. */
  edition?: string;
}

export type CoverSourceErrorKind = 'timeout' | 'http' | 'invalid';

export class CoverSourceError extends Error {
  constructor(
    public source: CoverSource,
    public kind: CoverSourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CoverSourceError';
  }
}

export const SEARCH_TIMEOUT_MS = 6_000;
export const MAX_PER_SOURCE = 6;

const USER_AGENT = 'castwright/1.0 (https://github.com/dudarenok-maker/Castwright)';

/** Fetch JSON with a per-source AbortController timeout, mapping every
    failure mode to a CoverSourceError tagged with the source. */
export async function fetchSourceJson<T>(
  source: CoverSource,
  url: string,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new CoverSourceError(source, 'timeout', `${source} search timed out.`);
    }
    throw new CoverSourceError(source, 'http', `${source} search failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new CoverSourceError(source, 'http', `${source} search returned HTTP ${res.status}.`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new CoverSourceError(source, 'invalid', `${source} search returned malformed JSON.`);
  }
}

export function parseYear(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

export function formatEdition(
  publisher: string | undefined,
  year: number | undefined,
): string | undefined {
  const parts = [publisher?.trim(), year ? String(year) : undefined].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
