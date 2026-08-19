import type { ConfigKnob, KnobValueState } from './types.js';
import { allKnobs } from './registry.js';
import { readConfigOverrides } from '../workspace/user-settings.js';
import { getLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

function parseEnv(knob: ConfigKnob, raw: string): number | boolean | string | null {
  const r = coerceAndValidate(knob, raw);
  return r.ok ? r.value! : null;
}

// Warn at most once per (env, value) so an invalid env var silently falling
// through to override/default doesn't surprise a deployer who set it.
const warnedInvalidEnv = new Set<string>();

function resolveKnobInner(knob: ConfigKnob, reconcileDeviceUuid: boolean): KnobValueState {
  if (knob.env) {
    const raw = process.env[knob.env];
    if (raw != null && raw.trim() !== '') {
      const v = parseEnv(knob, raw);
      if (v != null) {
        return { key: knob.key, effective: v, source: 'env', locked: true, overridden: false };
      }
      const warnKey = `${knob.env}=${raw}`;
      if (!warnedInvalidEnv.has(warnKey)) {
        warnedInvalidEnv.add(warnKey);
        console.warn(
          `[config] ${knob.env}="${raw}" is not a valid ${knob.type} for ${knob.key} — ignoring env, falling through to override/default.`,
        );
      }
    }
  }
  const overrides = readConfigOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, knob.key)) {
    const raw = overrides[knob.key];
    if (
      reconcileDeviceUuid &&
      knob.type === 'device' &&
      typeof raw === 'string' &&
      raw.startsWith('cuda-uuid:')
    ) {
      const uuid = raw.slice('cuda-uuid:'.length);
      const card = getLastKnownGpuDevices().find((d) => d.uuid === uuid);
      if (card) {
        return { key: knob.key, effective: `cuda:${card.idx}`, source: 'override', locked: false, overridden: true };
      }
      return {
        key: knob.key,
        effective: raw,
        source: 'override',
        locked: false,
        overridden: true,
        staleReason: 'uuid_unresolved',
      };
    }
    return { key: knob.key, effective: raw, source: 'override', locked: false, overridden: true };
  }
  return { key: knob.key, effective: knob.default, source: 'default', locked: false, overridden: false };
}

/** True when `knob.env` is set in the ambient environment to a value
    `resolveKnobInner` will NOT use as the knob's env-sourced value — either
    it fails `coerceAndValidate` (rejected, with the one-shot warning already
    logged), or it's blank/whitespace-only, which `resolveKnobInner` treats
    identically to "no env var at all" (falls through to override/default
    WITHOUT validating or warning — see its `raw != null && raw.trim() !== ''`
    guard). Both cases mean the server did not resolve this knob from its
    ambient env text, so a consumer forwarding that raw text on regardless
    (`buildSidecarEnv`, #2207) would disagree with the server for the same
    reason either way (independent review of PR #2219, finding F3 — a blank
    `GPU_RESERVE_MB=` reaches `main.py`'s unguarded `int(os.environ.get(...))`
    and raises at capacity-admission time; verified in this repo, not merely
    reported by the review). Lets a consumer act on a decision the resolver
    already computes internally, without re-running validation itself and
    without widening `KnobValueState` with a field only one caller needs. */
export function isEnvValueRejected(knob: ConfigKnob): boolean {
  if (!knob.env) return false;
  const raw = process.env[knob.env];
  if (raw == null) return false;
  if (raw.trim() === '') return true;
  return parseEnv(knob, raw) == null;
}

/** Effective value for a READ SITE or the Advanced UI. Reconciles a stored
    'cuda-uuid:<uuid>' override against the last-known device list, so the UI can
    show a concrete card and flag a vanished one as staleReason:'uuid_unresolved'. */
export function resolveKnob(knob: ConfigKnob): KnobValueState {
  return resolveKnobInner(knob, true);
}

/** Effective value for the SIDECAR ENV. Deliberately does NOT reconcile a
    'cuda-uuid:' override to an index (#1857).

    The sidecar resolves the uuid form itself, against LIVE torch enumeration, on
    every spawn — `_read_device_env` -> `_resolve_uuid_to_index`, main.py:1873.
    That code exists precisely because this cache is cold at the boot spawn.
    Handing the sidecar a pre-translated 'cuda:N' instead freezes whatever the
    Node cache believed at translation time, and the supervisor's buildOpts
    re-emits that frozen value on EVERY respawn: a card that then vanishes makes
    _validate_cuda_index raise and the engine load fail on every retry, and a
    card that renumbers silently lands on the wrong one. Passing the uuid through
    keeps the sidecar's live resolution in charge, which degrades a vanished pin
    to 'auto' with a warning instead.

    Node's mapping is DERIVED from the sidecar (the cache is only ever populated
    from its /devices response) and the child inherits CUDA_VISIBLE_DEVICES via
    buildSidecarEnv's process.env spread — so our copy can only be staler than
    the sidecar's live view, never better informed. Translating here is strictly
    a downgrade.

    It also makes the spawn env DETERMINISTIC. Before this split the emitted
    value depended on whether the device cache happened to be warm — i.e. on
    whether the user had opened Advanced Settings during this server session. */
export function resolveKnobForSidecarEnv(knob: ConfigKnob): KnobValueState {
  return resolveKnobInner(knob, false);
}

/** Effective value a knob WOULD resolve to if its persisted override were
    cleared: env (if set and valid) else the shipped default — the override
    step is skipped entirely, without needing a real override read. Used by
    POST /api/config/reset to validate the RESULTING EFFECTIVE config a
    requested clear would produce against PAIR_RULES, before committing
    anything (independent review of PR #2205, finding F1) — mirroring
    resolveKnobInner's env-then-default fallback the same way PUT's pass 2
    mirrors its override-then-env-then-default one. */
export function resolveKnobIgnoringOverride(knob: ConfigKnob): number | boolean | string {
  if (knob.env) {
    const raw = process.env[knob.env];
    if (raw != null && raw.trim() !== '') {
      const v = parseEnv(knob, raw);
      if (v != null) return v;
    }
  }
  return knob.default;
}

export function resolveAll(): Record<string, KnobValueState> {
  const out: Record<string, KnobValueState> = {};
  for (const k of allKnobs()) {
    if (k.isPrompt) continue; // prompts resolved separately (later unit)
    out[k.key] = resolveKnob(k);
  }
  return out;
}

/** Knob keys whose env-sourced value is INDISTINGUISHABLE from having no
    override at all — resolveKnobInner picked it up from process.env, but
    it equals the knob's own shipped default. On an install predating
    #2179's fix, ~110 of these can exist at once from a straight
    .env.example copy; see #2194's decision comment for why this is
    surfaced rather than auto-rewritten. */
export function envCleanupCandidateKeys(): string[] {
  const out: string[] = [];
  for (const k of allKnobs()) {
    if (k.isPrompt || !k.env) continue;
    const state = resolveKnob(k);
    if (state.source === 'env' && state.effective === k.default) out.push(k.key);
  }
  return out;
}

/** Effective scalar for a read-site. Throws on unknown key. */
export function configValue<T extends number | boolean | string>(key: string): T {
  const knob = allKnobs().find((k) => k.key === key);
  if (!knob) throw new Error(`unknown config key ${key}`);
  return resolveKnob(knob).effective as T;
}

export interface CoerceResult { ok: boolean; value?: number | boolean | string; error?: string; }
export function coerceAndValidate(knob: ConfigKnob, raw: unknown): CoerceResult {
  switch (knob.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return { ok: true, value: true };
      if (['0', 'false', 'no', 'off'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: 'not a boolean' };
    }
    case 'integer':
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, error: 'not a number' };
      if (knob.type === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'not an integer' };
      if (knob.min != null && n < knob.min) return { ok: false, error: `< ${knob.min}` };
      if (knob.max != null && n > knob.max) return { ok: false, error: `> ${knob.max}` };
      return { ok: true, value: n };
    }
    case 'enum': {
      const s = String(raw);
      if (!knob.options?.includes(s)) return { ok: false, error: 'not an allowed option' };
      return { ok: true, value: s };
    }
    case 'string':
    default: {
      /* A pattern is always matched against the TRIMMED form (an anchored
         ^...$ regex has no whitespace tolerance of its own) — so the value
         persisted on a match must be that same trimmed form, not the raw
         input. Untrimmed would round-trip '  CUDA:1  ' verbatim into the
         override store and the sidecar's spawn env (independent review of
         PR #2205, finding F4). A pattern-less string knob (e.g.
         qa.asr.model) keeps its historical no-trim behaviour. */
      const raw_s = String(raw);
      const s = knob.pattern ? raw_s.trim() : raw_s;
      if (knob.pattern && !knob.pattern.test(s)) {
        return { ok: false, error: `does not match the required shape (${knob.pattern.source})` };
      }
      return { ok: true, value: s };
    }
  }
}
