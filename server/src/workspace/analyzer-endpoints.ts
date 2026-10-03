/* Named OpenAI-compatible analyzer endpoints (#3084 decision 3, spec §3).
   Stored in user-settings.json (`analyzerEndpoints`, `analyzerEndpointKeys`).
   This module is the PURE half: the schema, defaults, the key-origin rule, the
   reference lookup, and the create/update/delete/key decisions that
   routes/analyzer-endpoints.ts applies inside ONE serialised settings write
   (mutateUserSettings). No I/O. It must not import user-settings.ts, which
   imports it. */

import { z } from 'zod';
import { parseEndpointModelId } from '../analyzer/model-id.js';
import { AnalyzerKeyOriginError } from '../analyzer/errors.js';

export const REASONING_STYLES = ['reasoning_effort', 'enable_thinking', 'not_controllable'] as const;

export const analyzerEndpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  gpu: z.string().regex(/^(none|any|[a-z]+:\d+)$/),
  unloadUrl: z.string().url().optional(),
  concurrency: z.number().int().min(1).max(16).default(1),
  requestCeilingMs: z.number().int().min(60_000).max(14_400_000).default(1_800_000),
  structuredOutput: z.enum(['schema', 'json', 'off']).default('schema'),
  reasoningStyle: z.enum(REASONING_STYLES).default('not_controllable'),
  reasoning: z.string().default('model-default'),
  maxOutputTokens: z.number().int().min(0).default(0),
  contextTokens: z.number().int().min(512),
  maxInputTokensPerRequest: z.number().int().min(256).optional(),
  extraParams: z.record(z.string(), z.unknown()).optional(),
});
export type AnalyzerEndpoint = z.infer<typeof analyzerEndpointSchema>;

export interface EndpointKeyEntry {
  origin: string;
  key: string;
}
export type EndpointKeyStatus = 'set' | 'unset' | 'origin-mismatch';
export interface EndpointState {
  analyzerEndpoints: AnalyzerEndpoint[];
  analyzerEndpointKeys: Record<string, EndpointKeyEntry>;
}

/** The saved-settings slice findEndpointReferences reads. UserSettings is assignable.
    #3084 divergence A5 (re-pin to 80be2f1d) — `analyzerPhase0Model` / `analyzerPhase1Model`
    are GONE from the schema on `main`: `migrateLegacyAnalyzerModelFields`
    (`user-settings.ts:115-171` at 80be2f1d) moves any saved phase model into
    `configOverrides['analyzer.phase{0,1}.model']` at read time, and the schema
    never re-adds the two fields. An earlier draft of this task (written
    against 46e62a34, before #3192) still carried them here; they are removed. */
export interface EndpointReferenceSource {
  defaultAnalysisModel: string;
  configOverrides: Record<string, number | boolean | string>;
}

/** User-settings fields that hold a selectable model id, at 80be2f1d.
    analyzer-endpoints.test.ts fails until any new model-id field is
    classified here or excluded there. Phase-model ids are no longer here —
    they live only in `configOverrides` (MODEL_ID_CONFIG_KNOBS, below) since
    #3192's migration; A5 removed `analyzerPhase0Model`/`analyzerPhase1Model`,
    which no longer exist as settings fields at all. */
export const MODEL_ID_SETTING_FIELDS = ['defaultAnalysisModel'] as const;

/** Registry knobs (config overrides) that hold a selectable model id. The persona
    engine is listed now: wave 4 makes it a model-id-style selection. */
export const MODEL_ID_CONFIG_KNOBS = [
  'analyzer.phase0.model',
  'analyzer.phase1.model',
  'analyzer.personaGeneration.engine',
] as const;

export class AnalyzerEndpointRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly refusal: 'invalid' | 'duplicate-id' | 'unload-off-origin' | 'not-found' | 'referenced',
    message: string,
    /* #3084 F5 — {path, message} pairs the route echoes verbatim as the response's
       `issues`. Never a field or key value: a route renders these inline next to
       the named field, so a value here would leak it into a save-time error body.
       path is [] for a refusal that names no single field (duplicate-id,
       not-found, referenced). */
    readonly issues: { path: string[]; message: string }[] = [],
  ) {
    super(message);
    this.name = 'AnalyzerEndpointRefusal';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none' {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase()) ? 'any' : 'none';
  } catch {
    return 'none';
  }
}

export function keyOriginMatches(stored: { origin: string } | undefined, url: string): boolean {
  if (!stored) return false;
  try {
    return new URL(url).origin === stored.origin;
  } catch {
    return false;
  }
}

/** The unload URL for ONE model (P3). A URL with `{model}` is resolved once per
    entry of endpoint-runtime's servedModels(endpoint.id) by the caller (PR 3d's
    evictEndpointsOnDevice); `model` undefined means "no served model", which
    skips a `{model}` URL. A URL without `{model}` unloads everything, once. */
export function resolveUnloadUrl(endpoint: AnalyzerEndpoint, model: string | undefined): string | null {
  if (!endpoint.unloadUrl) return null;
  if (!endpoint.unloadUrl.includes('{model}')) return endpoint.unloadUrl;
  if (!model) return null;
  return endpoint.unloadUrl.split('{model}').join(encodeURIComponent(model));
}

/* #3084 F4 (not this PR) — PR 3d extends this to also count the
   `analyzer.fallback.target` knob (`resolveAnalyzerFallbackTarget`'s saved
   override, a bare `openai:<endpointId>::<model>` string) as a reference, so
   deleting an endpoint the fallback names is refused like any other
   reference. The fallback knob itself is not introduced in 3b (F4: it lands
   in PR 3d alongside the `'analyzer-engine'` knob type). */
export function findEndpointReferences(settings: EndpointReferenceSource, endpointId: string): string[] {
  const names = (value: unknown): boolean =>
    typeof value === 'string' && parseEndpointModelId(value.trim())?.endpointId === endpointId;
  const refs: string[] = [];
  for (const field of MODEL_ID_SETTING_FIELDS) {
    if (names(settings[field])) refs.push(`Account setting "${field}"`);
  }
  for (const knob of MODEL_ID_CONFIG_KNOBS) {
    if (names(settings.configOverrides?.[knob])) refs.push(`Advanced setting "${knob}"`);
  }
  return refs;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** #3084 F5 review, item 4 — a raw zod message is implementation detail, not
    something to show next to a form field: zod 4.4.3 ships "Invalid URL" for
    a bad `baseUrl`, "Too big: expected number to be <=14400000" for an
    over-ceiling `requestCeilingMs` (verified against the installed
    `server/node_modules/zod` — `server/package.json` pins `"zod": "^4.0.0"`,
    resolved to 4.4.3; a `.url()`/`.regex()` failure's `issue.code` is
    `invalid_format`, not zod 3's `invalid_string`). This is a template map
    per endpoint field; any path/code this map does not cover falls back to
    the raw zod message — still never a value, since zod's own message never
    echoes the input for these issue types (verified above). Exported so PR
    3d's UI test can assert against the real server string instead of
    re-deriving it by hand. */
export function friendlyEndpointIssueMessage(path: string, issue: z.ZodIssue): string {
  if (path === 'baseUrl' && issue.code === 'invalid_format') {
    return 'Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.';
  }
  if (path === 'unloadUrl' && issue.code === 'invalid_format') {
    /* #3084 F5 review pass 2, item 5 — a bare (no {model}) unload URL unloads
       EVERY model on the server, which is exactly the P12 warning case;
       showing that form as the example would steer a user straight into it.
       Use llama-swap's per-model form instead (planning-facts doc,
       docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md
       line 83: "Endpoint unload for llama-swap: POST {origin}/api/models/unload/{model}
       with the key"). */
    return 'Unload URL must be a valid URL, e.g. http://127.0.0.1:8080/api/models/unload/{model}.';
  }
  if (path === 'id' && issue.code === 'invalid_format') {
    return 'Endpoint id must be lowercase letters, digits and hyphens, 1–40 characters.';
  }
  if (path === 'name' && issue.code === 'too_big') {
    return 'Name must be 80 characters or fewer.';
  }
  if (path === 'contextTokens' && issue.code === 'invalid_type') {
    return 'Context size is required.';
  }
  if (path === 'contextTokens' && issue.code === 'too_small') {
    return 'Context size must be at least 512 tokens.';
  }
  if (path === 'gpu' && (issue.code === 'invalid_type' || issue.code === 'invalid_format')) {
    return 'GPU card must be "none", "any", or a device key such as cuda:0.';
  }
  if (path === 'concurrency' && issue.code === 'too_big') {
    return `Concurrency must be at most ${'maximum' in issue ? issue.maximum : 16}.`;
  }
  if (path === 'concurrency' && issue.code === 'too_small') {
    return 'Concurrency must be at least 1.';
  }
  if (path === 'requestCeilingMs' && issue.code === 'too_big') {
    const maxMs = 'maximum' in issue && typeof issue.maximum === 'number' ? issue.maximum : 14_400_000;
    return `Request ceiling must be at most ${Math.round(maxMs / 60_000)} minutes.`;
  }
  if (path === 'requestCeilingMs' && issue.code === 'too_small') {
    const minMs = 'minimum' in issue && typeof issue.minimum === 'number' ? issue.minimum : 60_000;
    return `Request ceiling must be at least ${Math.round(minMs / 1000)} seconds.`;
  }
  if (path === 'maxInputTokensPerRequest' && issue.code === 'too_small') {
    return 'Max input tokens per request must be at least 256.';
  }
  return issue.message; // fallback — still never a value, per the no-echo rule
}

export function parseEndpointInput(input: unknown): AnalyzerEndpoint {
  const withGpu =
    isRecord(input) && typeof input.baseUrl === 'string' && input.gpu === undefined
      ? { ...input, gpu: defaultGpuForBaseUrl(input.baseUrl) }
      : input;
  const parsed = analyzerEndpointSchema.safeParse(withGpu);
  if (!parsed.success) {
    throw new AnalyzerEndpointRefusal(
      400,
      'invalid',
      'Invalid analyzer endpoint.',
      /* #3084 F5 — structured {path, message}, never the rejected value: a
         field-aware template (friendlyEndpointIssueMessage) replaces zod's own
         wording, which is implementation detail, not user-facing copy. */
      parsed.error.issues.map((i) => {
        const path = i.path.map(String);
        return { path, message: friendlyEndpointIssueMessage(path.join('.'), i) };
      }),
    );
  }
  const ep = parsed.data;
  /* #3084 P23 — until wave 5 exists, nothing validates a reasoning level or a
     custom payload, and a value saved now would bypass wave 5's checks for good
     (settings load leniently). PR 5a deletes the `reasoning` refusal; PR 5b
     deletes the `extraParams` refusal. */
  const notYet: { path: string[]; message: string }[] = [];
  if (ep.reasoning !== 'model-default') {
    notYet.push({ path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' });
  }
  if (ep.extraParams !== undefined && Object.keys(ep.extraParams).length > 0) {
    notYet.push({ path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' });
  }
  if (notYet.length > 0) {
    throw new AnalyzerEndpointRefusal(400, 'invalid', 'Invalid analyzer endpoint.', notYet);
  }
  if (ep.unloadUrl) {
    const unloadOrigin = new URL(ep.unloadUrl).origin;
    const baseOrigin = new URL(ep.baseUrl).origin;
    if (unloadOrigin !== baseOrigin) {
      /* #3084 F5 — names the mismatched field without echoing either URL. */
      throw new AnalyzerEndpointRefusal(
        400,
        'unload-off-origin',
        'The unload URL must be on the same scheme, host and port as the base URL.',
        [{ path: ['unloadUrl'], message: 'must be on the same scheme, host and port as baseUrl' }],
      );
    }
  }
  return ep;
}

function indexOrRefuse(state: EndpointState, endpointId: string): number {
  const idx = state.analyzerEndpoints.findIndex((e) => e.id === endpointId);
  if (idx < 0) throw new AnalyzerEndpointRefusal(404, 'not-found', `No analyzer endpoint with id "${endpointId}".`);
  return idx;
}

export function applyCreate(state: EndpointState, input: unknown): EndpointState {
  const ep = parseEndpointInput(input);
  if (state.analyzerEndpoints.some((e) => e.id === ep.id)) {
    throw new AnalyzerEndpointRefusal(409, 'duplicate-id', `An analyzer endpoint with id "${ep.id}" already exists.`);
  }
  return { ...state, analyzerEndpoints: [...state.analyzerEndpoints, ep] };
}

export function applyUpdate(state: EndpointState, endpointId: string, input: unknown): EndpointState {
  const idx = indexOrRefuse(state, endpointId);
  if (isRecord(input) && input.id !== undefined && input.id !== endpointId) {
    throw new AnalyzerEndpointRefusal(
      400,
      'invalid',
      'An endpoint id cannot be changed — delete the endpoint and add it again.',
    );
  }
  const ep = parseEndpointInput(isRecord(input) ? { ...input, id: endpointId } : input);
  const next = [...state.analyzerEndpoints];
  next[idx] = ep;
  return { ...state, analyzerEndpoints: next };
}

export function applyDelete(
  state: EndpointState,
  references: EndpointReferenceSource,
  endpointId: string,
): EndpointState {
  indexOrRefuse(state, endpointId);
  const refs = findEndpointReferences(references, endpointId);
  if (refs.length > 0) {
    throw new AnalyzerEndpointRefusal(
      409,
      'referenced',
      `Analyzer endpoint "${endpointId}" is still used by ${refs.length} saved setting(s).`,
      refs.map((r) => ({ path: [], message: r })),
    );
  }
  const keys = { ...state.analyzerEndpointKeys };
  delete keys[endpointId];
  return {
    analyzerEndpoints: state.analyzerEndpoints.filter((e) => e.id !== endpointId),
    analyzerEndpointKeys: keys,
  };
}

/** #3084 P22 — a key containing any control character is refused when written:
    C0 (U+0000–U+001F, CR, LF, NUL and tab included), DEL and C1 (U+007F–U+009F).
    undici echoes a whole invalid header value in its error
    (`Headers.append: "Bearer <key>" is an invalid header value.`), so such a key
    could surface in error text. Checked BEFORE trimming: a pasted trailing newline
    is refused, never silently stripped. A code-point loop, not a regex, because
    ESLint's no-control-regex rejects a control-character class. */
export function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

export const ENDPOINT_KEY_CONTROL_CHARACTER_RULE =
  'An API key cannot contain control characters (such as a line break, tab or NUL). Paste the key again without them.';

export function applyKey(state: EndpointState, endpointId: string, key: string | null): EndpointState {
  const ep = state.analyzerEndpoints[indexOrRefuse(state, endpointId)];
  if (typeof key === 'string' && hasControlCharacter(key)) {
    /* The rule only — never the key — in the message and issues (F5 no-echo). */
    throw new AnalyzerEndpointRefusal(400, 'invalid', ENDPOINT_KEY_CONTROL_CHARACTER_RULE, [
      { path: ['key'], message: ENDPOINT_KEY_CONTROL_CHARACTER_RULE },
    ]);
  }
  const normalised = typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
  const keys = { ...state.analyzerEndpointKeys };
  if (normalised === null) delete keys[endpointId];
  else keys[endpointId] = { origin: new URL(ep.baseUrl).origin, key: normalised };
  return { ...state, analyzerEndpointKeys: keys };
}

export function endpointKeyStatus(state: EndpointState): Record<string, EndpointKeyStatus> {
  return Object.fromEntries(
    state.analyzerEndpoints.map((e) => {
      const entry = state.analyzerEndpointKeys[e.id];
      const status: EndpointKeyStatus = !entry ? 'unset' : keyOriginMatches(entry, e.baseUrl) ? 'set' : 'origin-mismatch';
      return [e.id, status];
    }),
  );
}

/** The key to send to `targetUrl` (the base URL, an unload URL, a Detect URL…), or null
    when none is saved. Throws AnalyzerKeyOriginError (→ FailureCode `auth`) when the saved
    key was bound to another origin than `targetUrl`'s. No request may be sent in that case.
    `state` is structural (UserSettings satisfies it) so this leaf never imports user-settings. */
export function resolveEndpointApiKey(
  state: Pick<EndpointState, 'analyzerEndpointKeys'>,
  endpoint: AnalyzerEndpoint,
  targetUrl: string,
): string | null {
  const entry = state.analyzerEndpointKeys[endpoint.id];
  if (!entry) return null;
  if (!keyOriginMatches(entry, targetUrl)) throw new AnalyzerKeyOriginError(endpoint.id, endpoint.name);
  return entry.key;
}
