/* GET /api/config — descriptors + current resolved values for the Advanced Settings UI.
   PUT /api/config — write one or more knob overrides (validated, env-locked keys rejected).
   POST /api/config/reset — clear overrides by key list, group id, or all.
   GET /api/config/prompts/:id — read a prompt (shipped default or user fork).
   PUT /api/config/prompts/:id — write a user-forked prompt text.
   POST /api/config/prompts/:id/reset — revert a prompt fork to the shipped default.

   Secrets (isPrompt knobs and any env-sourced secret) never appear in the values map.
   The GET response shape is stable so the frontend can reconstruct the UI from it. */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GROUPS, allKnobs, getKnob, knobsInGroup } from '../config/registry.js';
import { allKnobDescriptors } from '../config/descriptors.js';
import { resolveAll, resolveKnob, resolveKnobIgnoringOverride, coerceAndValidate, envCleanupCandidateKeysFromFileContent } from '../config/resolver.js';
import { cleanEnvText } from '../config/env-cleanup.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { PAIR_RULES } from '../config/pair-rules.js';
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

/* Monotonic in-process counter so two env-cleanup calls that arrive
   in the same millisecond don't collide on temp-file names. */
let tmpSeq = 0;

/* Test-only: override the server .env path without exposing it over HTTP.
   Production code never sets this; only test code calls _setServerEnvPathForTest. */
let serverEnvPathOverride: string | null = null;

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

configRouter.get('/', async (req, res) => {
  await ensureGpuDeviceListWarm();
  const descriptors = allKnobDescriptors();

  // Determine env cleanup candidates from the actual .env file content,
  // not from process.env (which can be shadowed by the shell/OS).
  let envCleanupCandidates: string[] = [];
  const envPath = resolveServerEnvPath();
  if (existsSync(envPath)) {
    try {
      const fileContent = readFileSync(envPath, 'utf-8');
      envCleanupCandidates = envCleanupCandidateKeysFromFileContent(fileContent);
    } catch {
      // If we can't read the file, fall back to empty list
      // (the POST handler will report the error when it tries)
    }
  }

  res.json({
    groups: GROUPS,
    descriptors,
    values: resolveAll(),
    restartPending: false,
    cudaEnvShadow: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.CUDA_DEVICE_ORDER),
    envCleanupCandidates,
  });
});

configRouter.put('/', async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  /* Pass 1: coerce + per-key validate every entry in the patch, but don't
     write anything yet — cross-field validation (below) needs the WHOLE
     patch's coerced values before it can decide anything, and a rejected
     pair must not leave an earlier key in the same patch already written
     (#2180). */
  const coerced: Record<string, number | boolean | string> = {};
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
    coerced[key] = r.value!;
  }

  /* Pass 2: cross-field validation against the RESULTING EFFECTIVE config —
     the patch's own coerced value for a key it touches, otherwise whatever
     is already in effect for that key (env/override/default) — not just the
     incoming patch in isolation (#2180). A rule only runs when the patch
     actually touches at least one of its keys; an untouched pair that was
     already bad stays untouched (this is a save-time gate, not a repair). */
  for (const rule of PAIR_RULES) {
    if (!rule.keys.some((k) => Object.prototype.hasOwnProperty.call(coerced, k))) continue;
    const values: Record<string, number | boolean | string> = {};
    for (const k of rule.keys) {
      if (Object.prototype.hasOwnProperty.call(coerced, k)) {
        values[k] = coerced[k];
      } else {
        const knob = getKnob(k);
        if (knob) values[k] = resolveKnob(knob).effective;
      }
    }
    const error = rule.check(values);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(coerced)) {
    await writeConfigOverride(key, value);
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

  let toClear: string[];
  if (all) {
    toClear = allKnobs().filter((k) => !k.isPrompt).map((k) => k.key);
  } else if (group) {
    toClear = knobsInGroup(group).map((k) => k.key);
  } else if (Array.isArray(keys) && keys.length > 0) {
    toClear = keys;
  } else {
    res.status(400).json({ error: 'specify a non-empty keys array, a group, or all' });
    return;
  }

  /* Cross-field validation against the RESULTING EFFECTIVE config, mirroring
     the PUT handler's pass 2 above — a per-key reset is a first-class UI
     action (every Advanced Settings row's Revert button posts here with a
     single-element `keys`), and clearing just one half of a validated pair
     (e.g. reverting qa.asr.device back to its cpu default while
     qa.asr.computeType stays pinned to a cuda-only override) reproduces the
     exact save-time hazard #2180 closed for PUT — just through the other
     write path (independent review of PR #2205, finding F1). Reject rather
     than cascade: silently also-clearing a field the caller never touched
     would be worse than refusing with a clear reason. Nothing is cleared
     below until every rule that cares about a to-be-cleared key has passed.
     A group/all reset clears every key a rule depends on together (both
     `qa.asr.device` and `qa.asr.computeType` live in the same `qa-gates`
     group), so those stay valid. */
  const clearing = new Set(toClear);
  for (const rule of PAIR_RULES) {
    if (!rule.keys.some((k) => clearing.has(k))) continue;
    const values: Record<string, number | boolean | string> = {};
    for (const k of rule.keys) {
      const knob = getKnob(k);
      if (!knob) continue; // orphaned key with no matching knob — nothing to resolve
      values[k] = clearing.has(k) ? resolveKnobIgnoringOverride(knob) : resolveKnob(knob).effective;
    }
    const error = rule.check(values);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }

  if (all) {
    await clearAllConfigOverrides();
  } else if (group) {
    for (const k of knobsInGroup(group)) await clearConfigOverride(k.key);
  } else {
    for (const k of toClear) await clearConfigOverride(k);
  }
  res.json({ ok: true, values: resolveAll() });
});

// ── POST /env-cleanup ────────────────────────────────────────────────────────

/** Resolve the server .env path the same way load-env.ts does: relative to
    the server process's cwd. */
export function resolveServerEnvPath(): string {
  if (serverEnvPathOverride !== null) {
    return serverEnvPathOverride;
  }
  return resolve(process.cwd(), '.env');
}

/** Test-only: override the .env path resolver so tests can point at a temp
    file without touching the real server/.env. Production code never calls
    this; it only exists for test dependency injection. */
export function _setServerEnvPathForTest(path: string | null): void {
  serverEnvPathOverride = path;
}

configRouter.post('/env-cleanup', async (req, res) => {
  const envPath = resolveServerEnvPath();

  if (!existsSync(envPath)) {
    res.status(404).json({ error: `server .env not found at ${envPath}` });
    return;
  }

  let original: string;
  try {
    original = readFileSync(envPath, 'utf-8');
  } catch (err) {
    res.status(500).json({ error: `failed to read ${envPath}: ${(err as Error).message}` });
    return;
  }

  // Re-derive the candidate set AT WRITE TIME — never trust a cached GET response.
  // Determine candidacy from the actual .env FILE's content, not process.env,
  // to avoid the ambient-shadowing bug where the shell exports a variable with
  // the default value, masking a deliberately-pinned .env value (#2194 finding 5).
  const candidateKeys = envCleanupCandidateKeysFromFileContent(original);
  const candidateSet = new Set(
    candidateKeys
      .map((key) => {
        const knob = getKnob(key);
        return knob?.env ?? null;
      })
      .filter((env): env is string => env != null),
  );

  const result = cleanEnvText(original, (varName) => candidateSet.has(varName));

  // If nothing to clean, return early without modifying .env or .env.bak.
  // This prevents overwriting the backup on a no-op cleanup run.
  if (result.cleaned.length === 0) {
    res.json({ cleaned: [] });
    return;
  }

  // Backup: copy the pre-cleanup content to server/.env.bak (snapshot, not
  // version history — each cleanup overwrites the previous backup).
  const bakPath = `${envPath}.bak`;
  try {
    writeFileSync(bakPath, original, 'utf-8');
  } catch (err) {
    res.status(500).json({ error: `failed to write backup ${bakPath}: ${(err as Error).message}` });
    return;
  }

  // Atomic write: write cleaned text to a temp file in the same directory
  // as the target, then rename over the target. This keeps the rename on
  // one filesystem (no EXDEV cross-device errors) and avoids leaking temp
  // directories to os.tmpdir(). Same rename helper as state-io's atomic
  // JSON writes — cloud-sync-safe on Windows.
  //
  // Preserve the original file's mode (e.g., 0o600 for a secrets file) to
  // avoid widening permissions when the temp file defaults to 0o644.
  let originalMode: number | undefined;
  try {
    originalMode = statSync(envPath).mode;
  } catch {
    // If we can't read the original mode, we'll skip chmod below.
    // (This shouldn't happen since existsSync already passed above.)
  }

  try {
    const seq = (tmpSeq = (tmpSeq + 1) >>> 0);
    const rnd = randomBytes(4).toString('hex');
    const tmp = `${envPath}.tmp-${process.pid}-${Date.now()}-${seq}-${rnd}`;
    writeFileSync(tmp, result.text, 'utf-8');
    // Restore the original file's permissions to the temp file before renaming.
    if (originalMode !== undefined) {
      chmodSync(tmp, originalMode);
    }
    try {
      await renameWithRetry(tmp, envPath);
    } catch (renameErr) {
      /* Cleanup the temp file on terminal failure so we don't leak
         .tmp-<pid>-<ts>-<seq>-<rnd> droppings into the workspace. */
      await unlink(tmp).catch(() => {});
      throw renameErr;
    }
  } catch (err) {
    res.status(500).json({ error: `failed to write cleaned .env: ${(err as Error).message}` });
    return;
  }

  res.json({ cleaned: result.cleaned });
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
