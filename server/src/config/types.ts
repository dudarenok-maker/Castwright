// server/src/config/types.ts
export type KnobType = 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'device';
// 'device' is a string knob (validated identically — see resolver's coerceAndValidate
// default case) whose UI picks from the live GPU list (GET /api/gpu/devices) instead
// of a free-text box or a fixed enum.
// 'rebuild' is heavier than a restart: changing the value rebuilds the Python
// venv (a new accelerator profile = a different torch/ORT install), then restarts
// the sidecar. Actuated by the Wave-F profile-switch action.
export type ApplyMode = 'live' | 'restart-sidecar' | 'restart-server' | 'rebuild';
export type Risk = 'low' | 'medium' | 'high';

export interface ConfigKnob {
  /** Stable dotted key, e.g. 'analyzer.stage2.minCoverage'. Never reused. */
  key: string;
  /** The .env variable name this knob maps to, e.g. 'STAGE2_MIN_COVERAGE'. */
  env: string;
  /** Group id (see ConfigGroup.id). */
  group: string;
  label: string;
  help: string;
  type: KnobType;
  /** The shipped default — MUST equal the current code default. */
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** For type==='enum'. */
  options?: string[];
  /** For type==='string' (or 'device'). A closed VALUE SHAPE for an
      otherwise free-text knob — validated case-insensitively against the
      trimmed input in coerceAndValidate's string/default case. Small,
      general capability (#2180): a knob with no closed `options` set can
      still refuse a malformed value ("cuda1") at save time without being
      forced into an enum with an unbounded option list (e.g. every
      "cuda:<n>" card index). */
  pattern?: RegExp;
  apply: ApplyMode;
  risk: Risk;
  /** True for analyzer-prompt knobs (no env; value is a .md fork pointer). Added in Task 0.5. */
  isPrompt?: boolean;
}

export interface ConfigGroup {
  id: string;
  label: string;
  help: string;
  risk: Risk;
  /** Collapsed by default in the UI (high-risk groups). */
  collapsedByDefault: boolean;
}

export type ValueSource = 'env' | 'override' | 'default';

export interface KnobValueState {
  key: string;
  effective: number | boolean | string;
  source: ValueSource;
  /** True when an env var is set → UI renders read-only. */
  locked: boolean;
  /** True when an app override is present (and not locked by env). */
  overridden: boolean;
  /** Set when `effective` is degraded/unresolved and the UI should flag it.
      'cpu_fallback' is populated wherever an engine's actual resolved device
      is surfaced as CPU-fallen-back; 'uuid_unresolved' (this task) means a
      stored 'cuda-uuid:<uuid>' override matches no currently-visible card in
      the last-known device list. `env_shadow` (CUDA_VISIBLE_DEVICES/
      CUDA_DEVICE_ORDER shadowing every pin) is a GLOBAL fact, not a per-knob
      one — it's surfaced separately as the top-level `cudaEnvShadow` flag on
      `GET /api/config`, rendered as one Advanced Configuration banner rather
      than a duplicated per-row reason. */
  staleReason?: 'cpu_fallback' | 'uuid_unresolved';
}
