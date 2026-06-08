import type { ConfigKnob, KnobValueState } from './types.js';
import { allKnobs } from './registry.js';
import { readConfigOverrides } from '../workspace/user-settings.js';

function parseEnv(knob: ConfigKnob, raw: string): number | boolean | string | null {
  const r = coerceAndValidate(knob, raw);
  return r.ok ? r.value! : null;
}

// Warn at most once per (env, value) so an invalid env var silently falling
// through to override/default doesn't surprise a deployer who set it.
const warnedInvalidEnv = new Set<string>();

export function resolveKnob(knob: ConfigKnob): KnobValueState {
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
    return { key: knob.key, effective: overrides[knob.key], source: 'override', locked: false, overridden: true };
  }
  return { key: knob.key, effective: knob.default, source: 'default', locked: false, overridden: false };
}

export function resolveAll(): Record<string, KnobValueState> {
  const out: Record<string, KnobValueState> = {};
  for (const k of allKnobs()) {
    if (k.isPrompt) continue; // prompts resolved separately (later unit)
    out[k.key] = resolveKnob(k);
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
    default:
      return { ok: true, value: String(raw) };
  }
}
