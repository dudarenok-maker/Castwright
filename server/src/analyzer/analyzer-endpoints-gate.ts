/* #3084 P23, A9 — leaf gate: the saved analyzer endpoints, readable from any
   route (failure-taxonomy.ts) without importing workspace/user-settings.ts
   (which would add an import edge that can close a cycle). Mirrors
   analyzer/known-secrets-gate.ts exactly: user-settings.ts registers the
   provider at module load; server/src/index.ts imports user-settings.ts before
   any route runs. Unregistered → [] (nothing to name): a module graph that never
   loaded user-settings.ts has no saved endpoint to resolve, so a fix's label
   falls back to the endpoint id. The gate itself is a leaf: it holds no state
   beyond the registered callback, and the only import below is type-only (erased
   at runtime), so it adds no runtime edge. */
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

export interface AnalyzerEndpointsProvider {
  /** synchronous view of the cached settings' endpoints */
  list: () => AnalyzerEndpoint[];
}

let provider: AnalyzerEndpointsProvider | null = null;

export function registerAnalyzerEndpointsProvider(next: AnalyzerEndpointsProvider): void {
  provider = next;
}

/** The cached endpoints (empty when the cache has not warmed). Used by
    `reasoningOverflowFixes`'s `openai` branch to name an endpoint by its saved
    name, falling back to the id when the endpoint is missing. */
export function listAnalyzerEndpoints(): AnalyzerEndpoint[] {
  return provider ? provider.list() : [];
}
