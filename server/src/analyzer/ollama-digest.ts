/* #3084 A3 — the installed digest of one Ollama model, stamped on a Test record (Task 3c.4) and
   compared before a run (Task 3c.10) and in the catalog (Task 3c.5). Never throws and is bounded
   at 2 s: an unknown digest keeps a record (capabilityRecordFor fails open), it never discards one. */
export const OLLAMA_DIGEST_TIMEOUT_MS = 2_000;

export async function ollamaModelDigest(
  url: string,
  model: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> {
  try {
    const resp = await fetchImpl(`${url.replace(/\/+$/, '')}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(OLLAMA_DIGEST_TIMEOUT_MS) });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
    /* Exact tag match; 5a widens this through normalizeModelTag. */
    const hit = (body.models ?? []).find((m) => m.name === model || m.model === model);
    return typeof hit?.digest === 'string' && hit.digest.length > 0 ? hit.digest : undefined;
  } catch {
    return undefined;
  }
}
