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
import { toUuidForm, needsUuidTranslation } from './gpu-uuid.js';
import { fetchSidecarDevices, type SidecarDevicesResponse } from '../gpu/fetch-sidecar-devices.js';
import { getLastKnownGpuDevices, setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

export const configRouter = Router();

/* resolveAll() -> resolveKnob() reconciles a stored 'cuda-uuid:<uuid>'
   override against getLastKnownGpuDevices()'s cache SYNCHRONOUSLY — it's
   only ever warmed by GET /api/gpu/devices's own handler (or toUuidForm,
   on a PUT). On a fresh server boot, AdvancedView's mount effect fires
   fetchConfig() and getGpuDevices() concurrently with no ordering; this
   route is a synchronous local computation and routinely resolves BEFORE
   the sidecar round-trip GET /api/gpu/devices needs. That race mislabels a
   perfectly valid uuid pin as staleReason:'uuid_unresolved' ("card no
   longer found") on the very first Advanced Settings load after a restart
   — reproduced and confirmed by the mandatory PR code-review. Warm the
   cache here too (a no-op once anything else has already warmed it) so
   resolveAll() never reconciles against a cache that's empty only because
   nothing has asked the sidecar yet. */
async function ensureGpuDeviceListWarm(): Promise<void> {
  if (getLastKnownGpuDevices().length > 0) return;
  const result = await fetchSidecarDevices();
  if (result) setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
}

configRouter.get('/', async (_req, res) => {
  await ensureGpuDeviceListWarm();
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
  res.json({
    groups: GROUPS,
    descriptors,
    values: resolveAll(),
    restartPending: false,
    cudaEnvShadow: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.CUDA_DEVICE_ORDER),
  });
});

configRouter.put('/', async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  const applied: string[] = [];
  /* Resolve the sidecar's device list at most once for the whole request,
     lazily — a PUT patching all three tts.*.device knobs in one body used
     to pay 3 sequential sidecar round-trips for an identical list (issue
     #1225). Fetched on first actual need (a bare 'cuda:N' value to
     translate) and reused for any later device key in the same patch;
     `undefined` means "not fetched yet", so a patch whose first key fails
     validation (unknown key, locked, bad value) still returns its error
     without ever touching the sidecar. */
  let sidecarDevices: SidecarDevicesResponse | null | undefined;
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
    if (knob.type === 'device' && typeof r.value === 'string' && needsUuidTranslation(r.value)) {
      if (sidecarDevices === undefined) sidecarDevices = await fetchSidecarDevices();
      r.value = await toUuidForm(r.value, sidecarDevices);
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
