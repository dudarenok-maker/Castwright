/* #3084 W3 — TTS capacity eviction for OpenAI-compatible analyzer endpoints. When the
   sidecar denies admission on a card, endpoints assigned to that card (or to 'any') are
   asked to unload through their saved Unload URL: one POST per model that has served the
   endpoint (P3), each re-checked against the endpoint's run/call busy state immediately
   before it is sent (P1). No VRAM figure exists for endpoints, so the caller does not gate
   this on analyzerEvictWouldHelp; it re-probes capacity after. */
import { fetch as undiciFetch } from 'undici';
import { getCachedUserSettings, type UserSettings } from '../workspace/user-settings.js';
/* Known secrets through 3b's leaf gate, never from user-settings.ts (A9). */
import { knownAnalyzerSecrets } from '../analyzer/known-secrets-gate.js';
import { keyOriginMatches, resolveUnloadUrl, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import { forgetEndpointModel, servedModels as defaultServedModels } from '../analyzer/transports/endpoint-runtime.js';
import { isEndpointBusy as defaultIsEndpointBusy } from '../analyzer/analyzer-concurrency.js';

/** Test-only-visible-by-name; production always uses this. Matches SERVED_LIMITS_WARMUP_TIMEOUT_MS's
    shape (a named, exported per-call bound), not its value — this is a POST, not a listing.
    Was 30_000: a slow/hanging unload endpoint could be re-POSTed on every poll of one admission
    at up to 30 s each (found in review). The per-(endpoint, model) attempt slot below is what stops
    the re-POSTing; this bound only shortens each one. */
export const ENDPOINT_UNLOAD_TIMEOUT_MS = 10_000;

/** What one admission learned about one endpoint, read by endpointUnloadNotes (A6). */
export interface EndpointUnloadOutcome {
  /** POSTs answered 2xx or 404 — the server no longer holds that model. */
  freed: number;
  /** POSTs answered with any other status, or thrown (a timeout included). */
  failed: number;
  /** Skipped as busy at least once in this admission. */
  busy: boolean;
}

/** One attempt slot per (endpoint, model) per admission. `model` is undefined for an all-models URL. */
function attemptKey(endpointId: string, model: string | undefined): string {
  return `${endpointId}::${model ?? ''}`;
}

function outcomeFor(outcomes: Map<string, EndpointUnloadOutcome> | undefined, endpointId: string): EndpointUnloadOutcome | undefined {
  if (!outcomes) return undefined;
  let outcome = outcomes.get(endpointId);
  if (!outcome) {
    outcome = { freed: 0, failed: 0, busy: false };
    outcomes.set(endpointId, outcome);
  }
  return outcome;
}

export function endpointsSharingDevice(endpoints: AnalyzerEndpoint[], deviceKey: string): AnalyzerEndpoint[] {
  return endpoints.filter((e) => e.gpu === 'any' || e.gpu === deviceKey);
}

export async function evictEndpointsOnDevice(
  deviceKey: string,
  deps: {
    fetch?: typeof undiciFetch;
    settings?: () => UserSettings;
    servedModels?: (endpointId: string) => readonly string[];
    isEndpointBusy?: (endpointId: string) => boolean;
    /** Endpoints already logged as busy in THIS admission (one set per withCapacityRetry
        call, Task 3d.3): a 30-poll wait behind a busy endpoint logs one line, not thirty. */
    loggedBusy?: Set<string>;
    /** Attempt slots already spent in THIS admission, keyed by attemptKey(endpoint, model)
        (one set per withCapacityRetry call, Task 3d.3). The sole bound on the lever: at most
        one POST per (endpoint, model) per admission. There is no latch (A1). */
    attemptedEndpoints?: Set<string>;
    /** Per-endpoint outcomes for the give-up notes (one map per withCapacityRetry call, A6). */
    endpointOutcomes?: Map<string, EndpointUnloadOutcome>;
    /** "The server no longer holds this model" — defaults to endpoint-runtime's
        forgetEndpointModel (w3ab). `model` undefined clears the endpoint's whole set. */
    forgetServedModel?: (endpointId: string, model: string | undefined) => void;
  } = {},
): Promise<{ attempted: number; unloaded: number }> {
  const doFetch = deps.fetch ?? undiciFetch;
  const settings = (deps.settings ?? getCachedUserSettings)();
  const served = deps.servedModels ?? defaultServedModels;
  const isBusy = deps.isEndpointBusy ?? defaultIsEndpointBusy;
  const forgetServed = deps.forgetServedModel ?? forgetEndpointModel;
  const { loggedBusy, attemptedEndpoints, endpointOutcomes } = deps;
  /* P22: an unload server may echo the Authorization header. Redact against every analyzer
     credential this process holds AND every key in the settings this call read (an injected
     settings object is never in the cache). */
  const secrets = [...knownAnalyzerSecrets(), ...Object.values(settings.analyzerEndpointKeys).map((k) => k.key)];
  const safe = (text: string): string => redactKnownSecrets(text, secrets);
  let attempted = 0;
  /* N1: only a 2xx freed memory, so only a 2xx makes the capacity loop retry admission at once. */
  let unloaded = 0;
  for (const endpoint of endpointsSharingDevice(settings.analyzerEndpoints, deviceKey)) {
    if (!endpoint.unloadUrl) continue;
    /* P3: `{model}` → one POST per served model; a URL without it unloads everything, once.
       servedModels returns a copy (w3ab), so forgetServed below cannot change what this loop walks. */
    const models: ReadonlyArray<string | undefined> = endpoint.unloadUrl.includes('{model}') ? served(endpoint.id) : [undefined];
    const stored = settings.analyzerEndpointKeys[endpoint.id];
    for (const model of models) {
      /* A1: the slot is per (endpoint, model), and both the read and the write are INSIDE this
         loop. A per-endpoint skip abandoned models 2..N of a {model} URL; a whole-admission
         latch abandoned every other endpoint on the card. */
      const key = attemptKey(endpoint.id, model);
      if (attemptedEndpoints?.has(key)) continue;
      const url = resolveUnloadUrl(endpoint, model);
      if (!url) continue;
      if (stored && !keyOriginMatches(stored, url)) continue;
      const outcome = outcomeFor(endpointOutcomes, endpoint.id);
      /* P1: re-checked immediately before EACH POST — a run or call may have started while
         the previous POST was blocked on the server stopping a model. */
      if (isBusy(endpoint.id)) {
        if (outcome) outcome.busy = true;
        if (!loggedBusy?.has(endpoint.id)) {
          console.info(`[gpu] analyzer endpoint "${endpoint.name}" is busy; not unloading it`);
          loggedBusy?.add(endpoint.id);
        }
        break; // no slot spent: this endpoint's remaining models stay eligible on a later poll
      }
      attempted++;
      /* Marked BEFORE the fetch: a POST that hangs past the timeout must still spend its slot. */
      attemptedEndpoints?.add(key);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: stored ? { Authorization: `Bearer ${stored.key}` } : {},
          signal: AbortSignal.timeout(ENDPOINT_UNLOAD_TIMEOUT_MS),
        });
        if (res.ok || res.status === 404) {
          /* 404: llama-swap is not running that model. Either way the server no longer holds it,
             so it leaves the served set and later admissions stop POSTing it. */
          forgetServed(endpoint.id, model);
          if (outcome) outcome.freed += 1;
          if (res.ok) unloaded++;
          console.info(`[gpu] analyzer endpoint "${endpoint.name}" no longer holds ${model ?? 'any model'} (HTTP ${res.status})`);
        } else {
          if (outcome) outcome.failed += 1;
          const body = await res.text().catch(() => '');
          /* Redact BEFORE truncating, so a key the cut would halve cannot survive. */
          console.warn(`[gpu] unload request for analyzer endpoint "${endpoint.name}" returned ${res.status}: ${safe(body).slice(0, 300)}`);
        }
      } catch (err) {
        /* Only the unload fetch runs here: no stage call, so no stop-the-run error (P20) can reach it. */
        if (outcome) outcome.failed += 1;
        console.warn(safe(`[gpu] unload request for analyzer endpoint "${endpoint.name}" failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }
  return { attempted, unloaded };
}

/** Give-up notes for NoCapacityError (A6): every sharing endpoint still holding the card, with its
    cause, first match wins. The `{model}`-with-nothing-served case (N2 — the shape a restart
    produces) is checked LAST, because a successful unload also empties the served set. */
export function endpointUnloadNotes(
  deviceKey: string,
  settings: UserSettings = getCachedUserSettings(),
  served: (endpointId: string) => readonly string[] = defaultServedModels,
  outcomes?: ReadonlyMap<string, EndpointUnloadOutcome>,
): string[] {
  return endpointsSharingDevice(settings.analyzerEndpoints, deviceKey).flatMap((e) => {
    const outcome = outcomes?.get(e.id);
    if (!e.unloadUrl) {
      return [
        `Analyzer endpoint "${e.name}" shares this card but has no Unload URL, so Castwright could not free it — set "Unload URL" for it in Model Manager → Analyzer endpoints.`,
      ];
    }
    if (outcome && outcome.busy && outcome.freed === 0 && outcome.failed === 0) {
      return [
        `Analyzer endpoint "${e.name}" shares this card but was busy for the whole wait — an analysis, script review or Test was using it — so Castwright did not unload it. Let that finish, or move the endpoint to another card.`,
      ];
    }
    if (outcome && outcome.failed > 0 && outcome.freed === 0) {
      return [
        `Analyzer endpoint "${e.name}" shares this card, but every unload request Castwright sent it failed — check its Unload URL and that the server is answering.`,
      ];
    }
    if (outcome && outcome.freed > 0) {
      return [
        `Analyzer endpoint "${e.name}" shares this card; Castwright unloaded ${outcome.freed} model(s) on it and the card was still short of memory — free VRAM elsewhere or move the endpoint to another card.`,
      ];
    }
    if (e.unloadUrl.includes('{model}') && served(e.id).length === 0) {
      return [
        `Analyzer endpoint "${e.name}" shares this card, but no model has run on it since Castwright started, so its Unload URL had no model name to use — unload it on the server, or use an Unload URL without "{model}" if that server unloads everything at once.`,
      ];
    }
    return [];
  });
}
