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

type Json = Record<string, unknown>;

/** The one container per transport that is merged key by key (never replaced). */
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]> = {
  ollama: ['options'],
  gemini: ['config'],
  openai: ['chat_template_kwargs'],
};

export const PROTECTED_KEYS: Record<TransportKind, readonly string[]> = {
  openai: [
    'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
    'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'include_reasoning',
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
const ENABLE_THINKING_KEY = 'chat_template_kwargs.enable_thinking';

function protectedKeySet(kind: TransportKind, ctx: { reasoningStyle?: ReasoningStyle }): Set<string> {
  const set = new Set<string>(PROTECTED_KEYS[kind]);
  if (kind === 'openai' && ctx.reasoningStyle === 'enable_thinking') set.add(ENABLE_THINKING_KEY);
  return set;
}

function geminiConfigAllows(key: string): boolean {
  return (GEMINI_CONFIG_ALLOWLIST as readonly string[]).includes(key);
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
  const errors: string[] = [];
  /* N12 — refused at save by path, at any depth; mergeExtraParams drops the same keys from a stored payload. */
  const prototypePaths: string[] = [];
  withoutPrototypeKeys(params, '', prototypePaths);
  for (const [key, value] of Object.entries(params)) {
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
      for (const inner of Object.keys(value)) {
        const path = `${key}.${inner}`;
        if (kind === 'gemini') {
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
  for (const [key, entry] of Object.entries(clean)) {
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
      for (const [innerKey, innerValue] of Object.entries(entry)) {
        const path = `${key}.${innerKey}`;
        const allowed =
          kind === 'gemini'
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
