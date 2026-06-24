/* Shared vocabulary for the honest single-design progress bar. Budgets are
   placeholder estimates until the on-box `qwen voice design:` numbers seed them
   (spec Open items); the bar self-corrects when the next real phase event
   arrives early (AR8). */
export type DesignPhase =
  | 'freeing-vram'
  | 'loading-model'
  | 'designing'
  | 'anchoring'
  | 'performing'
  | 'distilling'
  | 'rendering';

export const DESIGN_PHASE_ORDER: DesignPhase[] = [
  'freeing-vram', 'loading-model', 'designing', 'anchoring', 'performing', 'distilling', 'rendering',
];

export function phaseRank(p: DesignPhase): number {
  return DESIGN_PHASE_ORDER.indexOf(p);
}

/* The phases a single BASE-voice design (the cast-drawer flow that drives
   DesignProgress) actually emits — `design_voice`, never `mint_variant`. The
   progress bar's fill/ETA math sums budgets over THIS subset, not all 7, or it
   over-counts the mint-only phases (anchoring/performing) that never arrive
   (plan review PR-A). Mint phases stay in the vocab for the relay/SSE + any
   future bulk opt-in. */
export const DESIGN_PATH_PHASES: DesignPhase[] = [
  'freeing-vram', 'loading-model', 'designing', 'distilling', 'rendering',
];

export const DESIGN_PHASE_LABELS: Record<DesignPhase, string> = {
  'freeing-vram': 'Freeing GPU memory…',
  'loading-model': 'Loading the design model…',
  designing: 'Designing the voice…',
  anchoring: 'Anchoring to the base voice…',
  performing: 'Performing the emotion…',
  distilling: 'Distilling the voice…',
  rendering: 'Rendering the 12s audition…',
};

export const DESIGN_PHASE_BUDGETS_MS: Record<DesignPhase, number> = {
  'freeing-vram': 1_500,
  'loading-model': 12_000,
  designing: 55_000,
  anchoring: 6_000,
  performing: 60_000,
  distilling: 6_000,
  rendering: 12_000,
};
