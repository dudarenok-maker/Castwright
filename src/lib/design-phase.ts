/* Shared vocabulary for the honest single-design progress bar. The design-path
   budgets (loading-model / designing / distilling / rendering) are seeded from
   an on-box COLD `qwen voice design:` run (#1092 — the first design, where the
   ETA matters most). freeing-vram (not emitted when there's nothing to evict)
   and the mint-only anchoring / performing phases stay estimates. The bar
   self-corrects when the next real phase event arrives early (AR8). */
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
  'freeing-vram': 1_500, // estimate — not emitted on a clean box (nothing to evict)
  'loading-model': 16_700, // on-box cold (#1092)
  designing: 19_900, // on-box cold (#1092)
  anchoring: 6_000, // estimate — mint-only, off the single-design path
  performing: 60_000, // estimate — mint-only, off the single-design path
  distilling: 300, // on-box cold (#1092)
  rendering: 20_300, // on-box cold (#1092)
};
