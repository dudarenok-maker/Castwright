// server/src/config/types.ts
export type KnobType = 'number' | 'integer' | 'boolean' | 'string' | 'enum';
export type ApplyMode = 'live' | 'restart-sidecar' | 'restart-server';
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
}
