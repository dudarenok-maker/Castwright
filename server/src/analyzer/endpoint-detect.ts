/* On-demand served-context detection for a user-run llama.cpp / llama-swap
   server (#3084 decision 3b). Called ONLY when the user clicks Detect — nothing
   probes an endpoint automatically. Reads `default_generation_settings.n_ctx`
   (llama.cpp per-slot served context), never `n_ctx_train`. A local-machine
   surface: no mock counterpart (CLAUDE.md "Mocks behind VITE_USE_MOCKS"). */

import { Agent, fetch as undiciFetch } from 'undici';
import { redactKnownSecrets } from './redact.js';

/* headers/body timeouts off: llama-swap's /props?model= blocks while it loads
   the model. The absolute bound is the per-flavor AbortSignal.timeout below. */
const DETECT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

export const DETECT_TIMEOUT_MS = { 'llama.cpp': 15_000, 'llama-swap': 300_000 } as const;

export type DetectResult =
  | { ok: true; contextTokens: number; source: 'llama.cpp /props' | 'llama-swap /props' }
  | { ok: false; error: string; upstreamStatus?: number };

/** #3084 P25 — `/props` sits at the server's root, which behind a reverse proxy is
    the base URL's own path prefix: `https://host/llm/v1` → `https://host/llm/props`.
    A trailing `/v1` is removed and any prefix is kept; `new URL('/props', base)`
    would drop the prefix and ask the proxy's own root. */
export function propsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.pathname = `${prefix}/props`;
  url.search = '';
  url.hash = '';
  return url;
}

export async function detectServedContext(input: {
  baseUrl: string;
  flavor: 'llama.cpp' | 'llama-swap';
  model?: string;
  apiKey: string | null;
  /** #3084 P22 — every saved analyzer secret; the typed or stored `apiKey` is always redacted too. */
  secrets?: readonly string[];
  timeoutMs?: number;
  dispatcher?: Agent;
}): Promise<DetectResult> {
  /* #3084 P22 — redacted where the error text is built. An invalid header value
     (a key with a line break) makes undici throw an error embedding the whole
     `Bearer <key>` value, and that message is what `why` reads. */
  const redact = (text: string) => redactKnownSecrets(text, [input.apiKey, ...(input.secrets ?? [])]);
  const url = propsUrl(input.baseUrl);
  if (input.flavor === 'llama-swap' && input.model) url.searchParams.set('model', input.model);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, {
      method: 'GET',
      headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
      dispatcher: input.dispatcher ?? DETECT_DISPATCHER,
      signal: AbortSignal.timeout(input.timeoutMs ?? DETECT_TIMEOUT_MS[input.flavor]),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message ?? 'unknown error');
    return { ok: false, error: redact(`Could not reach ${url.origin} (${why}).`) };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: redact(`${url.origin}${url.pathname} returned ${response.status}.`), upstreamStatus: response.status };
  }
  const body = (await response.json().catch(() => null)) as {
    default_generation_settings?: { n_ctx?: unknown };
  } | null;
  const nCtx = body?.default_generation_settings?.n_ctx;
  if (typeof nCtx !== 'number' || !Number.isInteger(nCtx) || nCtx <= 0) {
    return { ok: false, error: `${url.origin}${url.pathname} did not report default_generation_settings.n_ctx.` };
  }
  return { ok: true, contextTokens: nCtx, source: input.flavor === 'llama-swap' ? 'llama-swap /props' : 'llama.cpp /props' };
}
