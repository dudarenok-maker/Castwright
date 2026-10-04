/* Per-endpoint runtime state that is never persisted (#3084 contract):
   - one concurrency semaphore per endpoint id (decision 5; same count-semaphore
     mechanism as acquireAnalyzerSlot), resized live when the saved
     concurrency changes;
   - every model whose request has been SENT to each endpoint since server
     start, for the `{model}` unload-URL substitution (P3: one unload POST per
     model). A run's call, a Test request and a call that then fails all count:
     the server may have loaded the model for any of them, and a 5xx after the
     load is exactly the case an unload has to clean up. Only a call aborted
     while still queued records nothing, because it never left. An unload URL
     with `{model}` and no recorded model is skipped, and PR 3d's give-up
     message names that endpoint (N2). */
import { CountSemaphore } from '../../gpu/count-semaphore.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

const semaphores = new Map<string, CountSemaphore>();
const served = new Map<string, Set<string>>();

export function endpointSemaphore(endpoint: AnalyzerEndpoint): CountSemaphore {
  const existing = semaphores.get(endpoint.id);
  if (existing) {
    existing.resize(endpoint.concurrency);
    return existing;
  }
  const created = new CountSemaphore(endpoint.concurrency);
  semaphores.set(endpoint.id, created);
  return created;
}

/** Record a model whose request was sent to this endpoint (P3, N2). */
export function noteEndpointModelUsed(endpointId: string, model: string): void {
  const set = served.get(endpointId) ?? new Set<string>();
  set.add(model);
  served.set(endpointId, set);
}

/** Every model that has served this endpoint since server start (a copy). */
export function servedModels(endpointId: string): readonly string[] {
  return [...(served.get(endpointId) ?? [])];
}

/** Remove a model from the endpoint's served set, or clear the whole set
    when `model` is `undefined` (the all-models unload URL, which has no
    `{model}`). An empty or unknown endpoint is a no-op. */
export function forgetEndpointModel(endpointId: string, model: string | undefined): void {
  if (model === undefined) {
    served.delete(endpointId);
    return;
  }
  served.get(endpointId)?.delete(model);
}

/** Test-only. */
export function _resetEndpointRuntimeForTest(): void {
  semaphores.clear();
  served.clear();
}
