/* #3084 wave 5 — WRITE-time validation for analyzer request controls. Kept off
   userSettingsSchema on purpose: a SCHEMA failure on read resets every setting to
   defaults (user-settings.ts readUserSettings), so rules that depend on
   tables that change (Gemini levels, protected keys)
   run only when a client writes. */
import { z } from 'zod';
import { REASONING_LEVELS, offeredReasoningLevels, testableReasoningLevels } from '../analyzer/reasoning.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';
import { entryForModelTag, normalizeModelTag } from '../analyzer/ollama-tag.js';
import { validateExtraParams } from '../analyzer/runner/extra-params.js';
import { isDeepStrictEqual } from 'node:util';

const OLLAMA_WRITABLE = testableReasoningLevels({ engine: 'local', model: '' });

/** What the write check needs from saved Test records. Structural: this module imports no
    capabilities or user-settings code (either would close a cycle through user-settings.ts). */
export interface RequestControlsContext {
  /** The Ollama model's Test record for the CURRENT Ollama URL (W3c's capabilityRecordFor), or undefined. */
  ollamaRecord(model: string): { reasoning?: Partial<Record<string, 'accepted' | 'rejected'>> } | undefined;
}

const reasoningByEngineInput = z
  .object({
    ollama: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
    gemini: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
  })
  .optional();

export function analyzerRequestControlsPatchSchemaFor(records: RequestControlsContext) {
  return z
    .object({
      analyzerReasoningByEngine: reasoningByEngineInput,
      analyzerExtraParamsByEngine: z.object({ ollama: z.unknown().optional(), gemini: z.unknown().optional() }).optional(),
    })
    .superRefine((patch, ctx) => {
      const r = patch.analyzerReasoningByEngine;
      if (r) {
        /* P18: one level per Ollama model. model-default/off/on are always writable; low/medium/high
           only for a model whose own Test record accepted that level. */
        for (const [model, level] of Object.entries(r.ollama ?? {})) {
          const path = ['analyzerReasoningByEngine', 'ollama', model];
          if (inferEngineFromModelId(model) === 'openai') {
            ctx.addIssue({ code: 'custom', path, message: `Ollama reasoning map key "${model}" is an endpoint model id; endpoints carry their own Reasoning setting.` });
            continue;
          }
          if (!OLLAMA_WRITABLE.includes(level)) {
            ctx.addIssue({ code: 'custom', path, message: `Ollama reasoning "${level}" for ${model} is not an Ollama level (${OLLAMA_WRITABLE.join(', ')}).` });
            continue;
          }
          const offered = offeredReasoningLevels({ engine: 'local', model, record: records.ollamaRecord(model) });
          if (!offered.includes(level)) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `Ollama reasoning "${level}" for ${model} needs a Test of that model that accepted it (offered now: ${offered.join(', ')}).`,
            });
          }
        }
        for (const [model, level] of Object.entries(r.gemini ?? {})) {
          if (inferEngineFromModelId(model) !== 'gemini') {
            ctx.addIssue({ code: 'custom', path: ['analyzerReasoningByEngine', 'gemini', model], message: `Gemini reasoning map key "${model}" is not a Gemini model id.` });
            continue;
          }
          const offered = offeredReasoningLevels({ engine: 'gemini', model });
          if (!offered.includes(level)) {
            ctx.addIssue({
              code: 'custom',
              path: ['analyzerReasoningByEngine', 'gemini', model],
              message: `Gemini reasoning "${level}" is not available for ${model} (offered: ${offered.join(', ')}).`,
            });
          }
        }
      }
      const payloads = patch.analyzerExtraParamsByEngine;
      for (const [engineKey, label] of [['ollama', 'Ollama'], ['gemini', 'Gemini']] as const) {
        const value = payloads?.[engineKey];
        if (value === undefined) continue;
        const result = validateExtraParams(engineKey, value, {});
        if (!result.ok) {
          for (const error of result.errors) {
            ctx.addIssue({ code: 'custom', path: ['analyzerExtraParamsByEngine', engineKey], message: `${label} custom parameters: ${error}` });
          }
        }
      }
    });
}

/** The same rules with no Test records: every named Ollama level is refused. */
export const analyzerRequestControlsPatchSchema = analyzerRequestControlsPatchSchemaFor({ ollamaRecord: () => undefined });

/** What changedRequestControls reads from the stored settings. Structural: no user-settings import. */
export interface StoredRequestControls {
  analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> };
  analyzerExtraParamsByEngine?: { ollama?: Record<string, unknown>; gemini?: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** N6 — the part of a PUT body the rules judge: only reasoning entries whose value differs from the
    stored settings, and only engine payloads that differ from the stored payload (key order ignored,
    5b-D14). The UI sends whole maps and both payloads, and Test records are bound to their server URL, so
    re-judging an unchanged stored value would let one stale entry (an Ollama URL change, a Gemini table
    change, an unknown stored value, a payload a newer rule refuses) block every later save. Ollama keys
    compare through normalizeModelTag (N7). A patch with neither map is returned as the same object. */
export function changedRequestControls(patch: unknown, stored: StoredRequestControls): unknown {
  if (!isRecord(patch)) return patch;
  let judged: Record<string, unknown> = patch;
  if (isRecord(patch.analyzerReasoningByEngine)) {
    const sent = patch.analyzerReasoningByEngine;
    const reasoning: Record<string, unknown> = { ...sent };
    for (const engine of ['ollama', 'gemini'] as const) {
      const entries = sent[engine];
      if (!isRecord(entries)) continue;
      const before = stored.analyzerReasoningByEngine?.[engine];
      reasoning[engine] = Object.fromEntries(
        Object.entries(entries).filter(
          ([model, level]) => (engine === 'ollama' ? entryForModelTag(before, model) : before?.[model]) !== level,
        ),
      );
    }
    judged = { ...judged, analyzerReasoningByEngine: reasoning };
  }
  if (isRecord(patch.analyzerExtraParamsByEngine)) {
    const payloads: Record<string, unknown> = { ...patch.analyzerExtraParamsByEngine };
    for (const engine of ['ollama', 'gemini'] as const) {
      /* 5b-D14 — key order is not a change: a payload re-sent with its keys reordered is the stored one. */
      if (engine in payloads && isDeepStrictEqual(payloads[engine], stored.analyzerExtraParamsByEngine?.[engine])) {
        delete payloads[engine];
      }
    }
    judged = { ...judged, analyzerExtraParamsByEngine: payloads };
  }
  return judged;
}

/** N7 — the body the route writes: Ollama reasoning keys through normalizeModelTag, so one model has one
    stored key (a later sent key wins when two normalise alike). Everything else is as sent; a body with
    no Ollama reasoning map is returned as the same object. */
export function withNormalizedOllamaReasoningKeys(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.analyzerReasoningByEngine) || !isRecord(body.analyzerReasoningByEngine.ollama)) {
    return body;
  }
  const ollama = Object.fromEntries(
    Object.entries(body.analyzerReasoningByEngine.ollama).map(([model, level]) => [normalizeModelTag(model), level]),
  );
  return { ...body, analyzerReasoningByEngine: { ...body.analyzerReasoningByEngine, ollama } };
}
