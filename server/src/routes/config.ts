/* GET /api/config — descriptors + current resolved values for the Advanced Settings UI.
   PUT /api/config — write one or more knob overrides (validated, env-locked keys rejected).
   POST /api/config/reset — clear overrides by key list, group id, or all.
   GET /api/config/prompts/:id — read a prompt (shipped default or user fork).
   PUT /api/config/prompts/:id — write a user-forked prompt text.
   POST /api/config/prompts/:id/reset — revert a prompt fork to the shipped default.

   Secrets (isPrompt knobs and any env-sourced secret) never appear in the values map.
   The GET response shape is stable so the frontend can reconstruct the UI from it. */

import { Router } from 'express';
import { GROUPS, allKnobs, getKnob, knobsInGroup } from '../config/registry.js';
import { resolveAll, resolveKnob, coerceAndValidate } from '../config/resolver.js';
import {
  writeConfigOverride,
  clearConfigOverride,
  clearAllConfigOverrides,
} from '../workspace/user-settings.js';
import { PROMPT_IDS, readPrompt, writeForkedPrompt, resetPrompt } from '../config/prompts.js';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  const descriptors = allKnobs().map((k) => ({
    key: k.key,
    group: k.group,
    label: k.label,
    help: k.help,
    type: k.type,
    min: k.min,
    max: k.max,
    step: k.step,
    options: k.options,
    apply: k.apply,
    risk: k.risk,
    isPrompt: k.isPrompt ?? false,
    default: k.default,
  }));
  res.json({ groups: GROUPS, descriptors, values: resolveAll(), restartPending: false });
});

configRouter.put('/', async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  const applied: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const knob = getKnob(key);
    if (!knob || knob.isPrompt) {
      res.status(400).json({
        error: knob?.isPrompt ? `${key} is a prompt knob (use the prompt endpoints)` : `unknown key ${key}`,
      });
      return;
    }
    if (resolveKnob(knob).locked) {
      res.status(409).json({ error: `${key} is set in environment` });
      return;
    }
    const r = coerceAndValidate(knob, raw);
    if (!r.ok) {
      res.status(400).json({ error: `${key}: ${r.error}` });
      return;
    }
    await writeConfigOverride(key, r.value!);
    applied.push(key);
  }
  res.json({ ok: true, applied, values: resolveAll() });
});

configRouter.post('/reset', async (req, res) => {
  const { keys, group, all } = (req.body ?? {}) as {
    keys?: string[];
    group?: string;
    all?: boolean;
  };
  if (all) {
    await clearAllConfigOverrides();
  } else if (group) {
    for (const k of knobsInGroup(group)) await clearConfigOverride(k.key);
  } else if (Array.isArray(keys) && keys.length > 0) {
    for (const k of keys) await clearConfigOverride(k);
  } else {
    res.status(400).json({ error: 'specify a non-empty keys array, a group, or all' });
    return;
  }
  res.json({ ok: true, values: resolveAll() });
});

// ── Prompt endpoints ─────────────────────────────────────────────────────────

configRouter.get('/prompts/:id', async (req, res) => {
  const { id } = req.params;
  if (!PROMPT_IDS.has(id)) {
    res.status(404).json({ error: `Unknown prompt id "${id}"` });
    return;
  }
  try {
    const state = await readPrompt(id);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

configRouter.put('/prompts/:id', async (req, res) => {
  const { id } = req.params;
  if (!PROMPT_IDS.has(id)) {
    res.status(404).json({ error: `Unknown prompt id "${id}"` });
    return;
  }
  const { text } = (req.body ?? {}) as { text?: unknown };
  if (typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ error: 'body.text must be a non-empty string' });
    return;
  }
  try {
    await writeForkedPrompt(id, text);
    const state = await readPrompt(id);
    res.json({ ok: true, ...state });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

configRouter.post('/prompts/:id/reset', async (req, res) => {
  const { id } = req.params;
  if (!PROMPT_IDS.has(id)) {
    res.status(404).json({ error: `Unknown prompt id "${id}"` });
    return;
  }
  try {
    await resetPrompt(id);
    const state = await readPrompt(id);
    res.json({ ok: true, ...state });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
