/* #3084 P22 — the ONE place that decides which headers reach an OpenAI-compatible
   endpoint, for every OpenAI client this app builds: the transport here, and PR 3c's
   catalog listing, preview and served-limits clients. A leaf, so any of them can
   import it without an import cycle.

   The SDK builds each request's headers from its own defaults (Accept, User-Agent,
   X-Stainless-*: openai client.mjs:1150-1168), the host's OPENAI_CUSTOM_HEADERS env
   (merged after its auth header: :240-249) and the placeholder key, then calls
   `fetch(url, { headers, … })` (fetchWithTimeout, :960-982). NONE of that is
   forwarded. The wire carries exactly FIXED_HEADERS, plus `Authorization: Bearer
   <key>` when the request URL is on the origin the key was resolved for. No
   `x-stainless-*` header is ever sent. undici drops `authorization` on a cross-origin
   redirect (lib/web/fetch/index.js:1352). */
import { fetch as undiciFetch } from 'undici';

export const ANALYZER_USER_AGENT = 'castwright-analyzer';

const FIXED_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': ANALYZER_USER_AGENT,
};

/* The comparison keyOriginMatches (Task 3b.5) makes — scheme, host and port — inlined
   so this leaf imports nothing from the workspace. */
function sameOrigin(keyOrigin: string, target: string): boolean {
  try {
    return new URL(target).origin === keyOrigin;
  } catch {
    return false;
  }
}

export function allowlistedFetch(apiKey: string | null, keyOrigin: string): typeof undiciFetch {
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = { ...FIXED_HEADERS };
    if (apiKey !== null && sameOrigin(keyOrigin, target)) headers.authorization = `Bearer ${apiKey}`;
    return undiciFetch(input, { ...init, headers });
  }) as typeof undiciFetch;
}
