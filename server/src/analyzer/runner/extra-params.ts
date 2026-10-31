/* #3084 wave 5 (D9, spec §9) — custom request payload. No settings or I/O
   (the one log line is noted below). Its imports are types from errors.ts, reasoning.ts and model-id.ts, and redact.ts, so it
   stays a leaf for the workspace modules, capacity.ts and the transports that import it.
   Every structural parameter type is satisfied by UserSettings
   / AnalyzerEndpoint without importing them (workspace/analyzer-request-controls
   imports this module).

   Privacy contract (spec §9, plan Global Constraints): callers never log a
   payload and never write one to an analyzer file; the error text a transport
   builds for a request is redacted against THAT request's payload values
   (payloadSecretValues, P29) before it is logged, thrown or displayed.
   The one log line: mergeExtraParams logs the NAMES of stored keys it drops
   (P17), never their values. */
import type { TransportKind } from '../errors.js';
import type { ReasoningStyle } from '../reasoning.js';
import type { AnalysisEngine } from '../model-id.js';
import { redactKnownSecrets } from '../redact.js';

export { REDACTED } from '../redact.js';

type Json = Record<string, unknown>;

/** The one container per transport that is merged key by key (never replaced). */
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]> = {
  ollama: ['options'],
  gemini: ['config'],
  openai: ['chat_template_kwargs'],
};

export const PROTECTED_KEYS: Record<TransportKind, readonly string[]> = {
  openai: [
    'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'stop_token_ids', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
    'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'thinking_token_budget', 'include_reasoning',
    /* #3904 — vLLM's spellings of the structured-output controls Castwright owns through `response_format`. An endpoint does
       not record which server it is, so the union of llama.cpp's and vLLM's spellings, plus LiteLLM's `thinking`, is refused; a
       server that ignores one loses nothing. LiteLLM's `thinking` is refused only under a gated style (STYLE_GATED_KEYS), not
       always. Other servers' spellings (OpenRouter, LM Studio, ...) have not been checked. */
    'structured_outputs', 'guided_json', 'guided_regex', 'guided_choice', 'guided_grammar', 'guided_decoding_backend', 'guided_whitespace_pattern', 'structural_tag',
  ],
  ollama: ['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu', 'options.stop'],
  /* Gemini's top level holds only these two; its `config` is an ALLOWLIST (GEMINI_CONFIG_ALLOWLIST, P16). */
  gemini: ['model', 'contents'],
};

/** P16 — the only `config` keys a Gemini payload may set. Everything else is refused, including
    `httpOptions` (the installed SDK applies its baseUrl / headers / extraBody / retryOptions / timeout
    per request, so it could send the API key to another host or reinject any owned field) and
    `stopSequences` (the parser owns where an answer ends). */
export const GEMINI_CONFIG_ALLOWLIST = [
  'temperature', 'topP', 'topK', 'maxOutputTokens', 'presencePenalty', 'frequencyPenalty', 'seed', 'safetySettings',
] as const;
const STYLE_GATED_KEYS = ['chat_template_kwargs.enable_thinking', 'thinking'] as const;

function protectedKeySet(kind: TransportKind, ctx: { reasoningStyle?: ReasoningStyle }): Set<string> {
  const set = new Set<string>(PROTECTED_KEYS[kind]);
  /* #3904 — only `not_controllable` leaves these to the user: under the other two styles Castwright sends its own reasoning
     control and vLLM lets an explicit enable_thinking override reasoning_effort (LiteLLM's top-level `thinking` is the same
     control in its Anthropic-style spelling). An absent style fails closed. */
  if (kind === 'openai' && ctx.reasoningStyle !== 'not_controllable') for (const k of STYLE_GATED_KEYS) set.add(k);
  return set;
}

function geminiConfigAllows(key: string): boolean {
  return (GEMINI_CONFIG_ALLOWLIST as readonly string[]).includes(key);
}

/* N9 — llama.cpp's native `n_predict` is an endpoint output cap too: a payload that sets it disables Auto
   and feeds capacity, like `max_tokens` / `max_completion_tokens`. */
const OUTPUT_CAP: Record<TransportKind, { container: string | null; keys: readonly string[] }> = {
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens', 'n_predict'] },
  ollama: { container: 'options', keys: ['num_predict'] },
  gemini: { container: 'config', keys: ['maxOutputTokens'] },
};
const TEMPERATURE: Record<TransportKind, { container: string | null }> = {
  openai: { container: null },
  ollama: { container: 'options' },
  gemini: { container: 'config' },
};

/* Ollama (Go encoding/json) matches request keys case-insensitively and lets the last duplicate win, and an
   OpenAI-compatible endpoint may be Ollama's /v1. So for those two transports a key that differs only in
   case from a key Castwright owns, protects or reads (output cap, temperature) would override it on the wire
   while every exact-spelling check misses it. Such a key is refused at save and dropped at merge; Gemini's
   allowlist already holds against case. Canonical spellings keep their existing behaviour. */
function canonicalKeys(kind: TransportKind, container: string | null, protectedSet: Set<string>): string[] {
  const out: string[] = [];
  for (const p of protectedSet) {
    if (container === null ? !p.includes('.') : p.startsWith(`${container}.`)) out.push(container === null ? p : p.slice(container.length + 1));
  }
  const cap = OUTPUT_CAP[kind];
  if (cap.container === container) out.push(...cap.keys);
  if (TEMPERATURE[kind].container === container) out.push('temperature');
  if (container === null) out.push(...OWNED_CONTAINERS[kind]);
  return out;
}

/* Go's simple case folding also folds U+017F (long s) to s; toLowerCase leaves it alone. U+212A (Kelvin) already lowercases to k. */
const foldKey = (key: string): string => key.toLowerCase().replace(/ſ/g, 's');

function isCaseVariant(kind: TransportKind, key: string, canonical: string[]): boolean {
  if (kind === 'gemini' || canonical.includes(key)) return false;
  const folded = foldKey(key);
  return canonical.some((c) => foldKey(c) === folded);
}

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* N12 — keys that would reach an object's prototype instead of the object when assigned. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** N12 — an own data property, never a setter: `target['__proto__'] = v` would set the prototype instead. */
function setOwn(target: Json, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** N12 — a copy of a payload value with `__proto__` / `constructor` / `prototype` keys removed at every
    depth; each removed key path is appended to `dropped` (array items as `list[0]`). */
function withoutPrototypeKeys(value: unknown, path: string, dropped: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => withoutPrototypeKeys(item, `${path}[${i}]`, dropped));
  if (!isPlainObject(value)) return value;
  const out: Json = {};
  for (const [key, inner] of Object.entries(value)) {
    const innerPath = path === '' ? key : `${path}.${key}`;
    if (PROTOTYPE_KEYS.has(key)) {
      dropped.push(innerPath);
      continue;
    }
    setOwn(out, key, withoutPrototypeKeys(inner, innerPath, dropped));
  }
  return out;
}

const SAFETY_SETTINGS_REFUSAL =
  '"config.safetySettings" must be an array of objects with only a string "category" and a string "threshold".';

/** N11 — the SDK sends each safetySettings entry as given, and an unknown field (e.g. `method`) or a
    non-array makes every request fail. Only an array of { category, threshold } strings is accepted. */
function isSafetySettings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        Object.keys(entry).every((k) => k === 'category' || k === 'threshold') &&
        typeof entry.category === 'string' &&
        typeof entry.threshold === 'string',
    )
  );
}

export function validateExtraParams(
  kind: TransportKind,
  params: unknown,
  ctx: { reasoningStyle?: ReasoningStyle },
): { ok: true; value: Json } | { ok: false; errors: string[] } {
  if (!isPlainObject(params)) {
    return { ok: false, errors: ['Custom parameters must be a JSON object, for example {"top_k": 40}.'] };
  }
  const protectedSet = protectedKeySet(kind, ctx);
  const hits: string[] = [];
  const notAllowed: string[] = [];
  const variants: string[] = [];
  const topCanonical = canonicalKeys(kind, null, protectedSet);
  const errors: string[] = [];
  /* N12 — refused at save by path, at any depth; mergeExtraParams drops the same keys from a stored payload. */
  const prototypePaths: string[] = [];
  withoutPrototypeKeys(params, '', prototypePaths);
  for (const [key, value] of Object.entries(params)) {
    if (isCaseVariant(kind, key, topCanonical)) {
      variants.push(key);
      continue;
    }
    if (protectedSet.has(key)) {
      hits.push(key);
      continue;
    }
    if (OWNED_CONTAINERS[kind].includes(key)) {
      if (value === null) {
        errors.push(`"${key}" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.`);
        continue;
      }
      if (!isPlainObject(value)) {
        errors.push(`"${key}" must be a JSON object.`);
        continue;
      }
      const innerCanonical = canonicalKeys(kind, key, protectedSet);
      for (const inner of Object.keys(value)) {
        const path = `${key}.${inner}`;
        if (isCaseVariant(kind, inner, innerCanonical)) {
          variants.push(path);
        } else if (kind === 'gemini') {
          if (!geminiConfigAllows(inner)) notAllowed.push(path);
          else if (inner === 'safetySettings' && value[inner] !== null && !isSafetySettings(value[inner])) {
            errors.push(SAFETY_SETTINGS_REFUSAL); // N11
          }
        } else if (protectedSet.has(path)) {
          hits.push(path);
        }
      }
      continue;
    }
    if (kind === 'gemini' && !PROTOTYPE_KEYS.has(key)) {
      errors.push(`"${key}" is not a Gemini request field — put generation options inside "config".`);
    }
  }
  if (prototypePaths.length > 0) {
    errors.push(`Keys named __proto__, constructor or prototype are not allowed: ${prototypePaths.join(', ')}.`);
  }
  if (notAllowed.length > 0) {
    errors.unshift(`Gemini "config" accepts only ${GEMINI_CONFIG_ALLOWLIST.join(', ')}. Refused: ${notAllowed.join(', ')}.`);
  }
  if (variants.length > 0) {
    errors.unshift(`These keys differ only in capitalisation from a key Castwright controls or reads, and cannot be set here: ${variants.join(', ')}.`);
  }
  if (hits.length > 0) errors.unshift(`These keys are controlled by Castwright and cannot be set here: ${hits.join(', ')}.`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: params };
}

/** P17 — split a stored payload into what may reach the wire and the key paths that may not. Save-time
    validation refuses the same paths; this re-applies the rules to a payload stored before a rule
    existed, or written straight to user-settings.json. A non-object (e.g. a stored `null`) on an owned
    container is dropped, so it never removes the container. N11: a Gemini `config.safetySettings` that
    is not an array of { category, threshold } strings is dropped. N12: `__proto__`, `constructor` and
    `prototype` keys are dropped at any depth, and every kept key is defined as an own data property. */
export function filterStoredPayload(
  kind: TransportKind,
  params: Json | undefined,
  ctx: { reasoningStyle?: ReasoningStyle } = {},
): { value: Json | undefined; dropped: string[] } {
  if (!params) return { value: undefined, dropped: [] };
  const dropped: string[] = [];
  const clean = withoutPrototypeKeys(params, '', dropped) as Json;
  const protectedSet = protectedKeySet(kind, ctx);
  const value: Json = {};
  const topCanonical = canonicalKeys(kind, null, protectedSet);
  for (const [key, entry] of Object.entries(clean)) {
    if (isCaseVariant(kind, key, topCanonical)) {
      dropped.push(key);
      continue;
    }
    if (protectedSet.has(key)) {
      dropped.push(key);
      continue;
    }
    if (OWNED_CONTAINERS[kind].includes(key)) {
      if (!isPlainObject(entry)) {
        dropped.push(key);
        continue;
      }
      const inner: Json = {};
      const innerCanonical = canonicalKeys(kind, key, protectedSet);
      for (const [innerKey, innerValue] of Object.entries(entry)) {
        const path = `${key}.${innerKey}`;
        const allowed =
          isCaseVariant(kind, innerKey, innerCanonical)
            ? false
            : kind === 'gemini'
            ? geminiConfigAllows(innerKey) &&
              (innerKey !== 'safetySettings' || innerValue === null || isSafetySettings(innerValue))
            : !protectedSet.has(path);
        if (allowed) setOwn(inner, innerKey, innerValue);
        else dropped.push(path);
      }
      setOwn(value, key, inner);
      continue;
    }
    if (kind === 'gemini') {
      dropped.push(key);
      continue;
    }
    setOwn(value, key, entry);
  }
  return { value, dropped };
}

export function payloadControlsOutputCap(kind: TransportKind, params: Json | undefined): boolean {
  if (!params) return false;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = container === null ? params : params[container];
  return isPlainObject(scope) && keys.some((k) => Object.hasOwn(scope, k));
}

/** P19 — the output cap a payload imposes: the smallest positive integer it sets; `null` when it
    controls the cap without one (it removes the key, or Ollama's -1); `undefined` when it does not
    control the cap. */
export function payloadOutputCap(kind: TransportKind, params: Json | undefined): number | null | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return undefined;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = (container === null ? params : params[container]) as Json;
  const caps = keys.map((k) => scope[k]).filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
  return caps.length > 0 ? Math.min(...caps) : null;
}

/** P19 — a request's maxOutputTokens: the payload's cap when the payload controls it (`null`, a removed key,
    becomes `undefined`, the transport default the merge then strips), else the engine's resolver. */
export function requestMaxOutputTokens(kind: TransportKind, extraParams: Json | undefined, resolve: () => number | undefined): number | undefined {
  const cap = payloadOutputCap(kind, extraParams);
  return cap === undefined ? resolve() : (cap ?? undefined);
}

/** N13 — the payload key that sets the output cap (`options.num_predict`, `config.maxOutputTokens`,
    `max_completion_tokens`, `n_predict`, …), for failure copy: the key whose value is the cap, else the
    first cap key present (a `null` that removes the cap). `undefined` when the payload controls no cap. */
export function payloadOutputCapKey(kind: TransportKind, params: Json | undefined): string | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return undefined;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = (container === null ? params : params[container]) as Json;
  const present = keys.filter((k) => Object.hasOwn(scope, k));
  const cap = payloadOutputCap(kind, params);
  const key = (cap === null ? undefined : present.find((k) => scope[k] === cap)) ?? present[0];
  return container === null ? key : `${container}.${key}`;
}

/** N13 (5b-D1, 5b-D3) — what a reasoning-overflow error records about the output cap of the payload the
    overflowing request sent: the key that set it, and whether that key's own value removes the cap. Only
    `null` and -1 remove it (5b-D3, narrowed 2026-10-30); 0, another negative, a fraction or a string does
    not, even though payloadOutputCap is `null` for them too. `{}` when the payload controls no cap. */
export function payloadOutputCapStamp(kind: TransportKind, params: Json | undefined): { payloadCapKey?: string; payloadCapRemoved?: boolean } {
  const payloadCapKey = payloadOutputCapKey(kind, params);
  if (payloadCapKey === undefined || !params) return {};
  const { container } = OUTPUT_CAP[kind];
  const scope = (container === null ? params : params[container]) as Json;
  const value = scope[container === null ? payloadCapKey : payloadCapKey.slice(container.length + 1)];
  return { payloadCapKey, payloadCapRemoved: value === null || value === -1 };
}

/** A4 — `params` without the keys that set the output cap (`payloadOutputCapKey`'s table): what a
    persona (free-text) request sends. The same object when the payload sets no cap; `undefined` for
    no payload. Never mutates `params`. */
export function withoutPayloadOutputCap(kind: TransportKind, params: Json | undefined): Json | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return params;
  const { container, keys } = OUTPUT_CAP[kind];
  if (container === null) return Object.fromEntries(Object.entries(params).filter(([key]) => !keys.includes(key))) as Json;
  const inner = params[container] as Json;
  return {
    ...params,
    [container]: Object.fromEntries(Object.entries(inner).filter(([key]) => !keys.includes(key))),
  };
}

/** Merged LAST into the native request, after filterStoredPayload (P17). Top-level keys replace;
    the owned container merges key by key; `null` removes a key inside it. Never mutates `native`. */
export function mergeExtraParams(
  kind: TransportKind,
  native: Json,
  params: Json | undefined,
  ctx: { reasoningStyle?: ReasoningStyle } = {},
): Json {
  if (!params) return native;
  const { value: allowed = {}, dropped } = filterStoredPayload(kind, params, ctx);
  if (dropped.length > 0) {
    /* P17: names only — a payload value never reaches a log. */
    console.warn(`[extra-params] ${kind}: ignored stored custom parameters Castwright controls or does not allow: ${dropped.join(', ')}`);
  }
  const out: Json = { ...native };
  if (kind === 'openai' && payloadControlsOutputCap(kind, allowed)) {
    delete out.max_tokens;
    delete out.max_completion_tokens;
  }
  for (const [key, value] of Object.entries(allowed)) {
    if (OWNED_CONTAINERS[kind].includes(key)) {
      const base: Json = isPlainObject(out[key]) ? { ...(out[key] as Json) } : {};
      for (const [innerKey, innerValue] of Object.entries(value as Json)) {
        if (innerValue === null) delete base[innerKey];
        else setOwn(base, innerKey, innerValue); // N12: never a prototype setter
      }
      setOwn(out, key, base);
      continue;
    }
    if (value === null) delete out[key];
    else setOwn(out, key, value);
  }
  return out;
}

/** The validation retry's request: the payload minus its temperature key, so
    the retry policy's temperature (the transport's native value) applies. */
export function stripPayloadTemperature(kind: TransportKind, params: Json | undefined): Json | undefined {
  if (!params) return params;
  const { container } = TEMPERATURE[kind];
  if (container === null) {
    if (!Object.hasOwn(params, 'temperature')) return params;
    const { temperature: _dropped, ...rest } = params;
    return rest;
  }
  const inner = params[container];
  if (!isPlainObject(inner) || !Object.hasOwn(inner, 'temperature')) return params;
  const { temperature: _dropped, ...restInner } = inner;
  return { ...params, [container]: restInner };
}

export function requestControlsLabelParts(kind: TransportKind, params: Json | undefined): string[] {
  if (!params || Object.keys(params).length === 0) return [];
  return payloadControlsOutputCap(kind, params) ? ['+ custom params', 'max output set by custom params'] : ['+ custom params'];
}

function collectRedactable(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    /* W3b's redactKnownSecrets applies the 8-character floor and derives the JSON-escaped spelling of each
       value that clears it, so a value under 8 raw characters is never redacted. */
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRedactable(v, out);
    return;
  }
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) collectRedactable(v, out);
  }
}

/** Every string value in a payload, nested values included. Each transport adds the values of the payload
    ITS OWN request carried to the secrets W3b redacts that request's errors against (P22, scoped per request
    by P29, Task 5.11); the floor and the escaped spelling are redactKnownSecrets'. They never join the global
    knownAnalyzerSecrets() list. */
export function payloadSecretValues(params: unknown): string[] {
  const values: string[] = [];
  collectRedactable(params, values);
  return [...new Set(values)];
}

export function redactPayloadValues(text: string, params: unknown): string {
  if (!text || params === undefined || params === null) return text;
  return redactKnownSecrets(text, payloadSecretValues(params));
}

export function resolveExtraParamsSetting(
  settings: { analyzerExtraParamsByEngine?: { ollama?: Json; gemini?: Json } },
  sel: { engine: AnalysisEngine; endpoint?: { extraParams?: Json } },
): Json | undefined {
  switch (sel.engine) {
    case 'local':
      return settings.analyzerExtraParamsByEngine?.ollama;
    case 'gemini':
      return settings.analyzerExtraParamsByEngine?.gemini;
    case 'openai':
      return sel.endpoint?.extraParams;
  }
}
