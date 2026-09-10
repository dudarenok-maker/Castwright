/* Task 16/16.5 (#1230 item 2, #2974) — pure target-selection for a code-43
   auto-revert. Pulled out of auto-revert.ts so it can be unit-tested against
   plain data, no supervisor/config-store mocking needed.

   The original shipped auto-revert.ts cleared a tripped device pin back to
   'auto' — but `tts.<engine>.device`'s own registry help
   (config/registry.ts:712) says 'auto' "picks cuda:0 → mps → cpu",
   unconditionally, with no free-VRAM check at all. A pin that trips because
   cuda:0 is genuinely too small for that engine reverts to 'auto', which
   picks cuda:0 again, trips again — an unbounded revert loop instead of the
   terminal hold the supervisor's code-43 streak guard exists to provide.
   This module picks an actual different card with enough headroom (or
   'cpu') instead. */

export interface RevertCandidate {
  idx: number;
  freeMb: number;
}

/** Choose a device string for a config override to land a tripped engine on,
    given the card that just tripped (`trippedCardIdx`), the last-known
    device list, and that engine's approximate peak VRAM need. Never returns
    the tripped card itself — prefers the OTHER candidate with the most free
    VRAM (the safest landing spot), and falls back to 'cpu' when no other
    candidate has enough room (including the single-GPU case, where
    `candidates` has nothing left once the tripped card is excluded). */
export function selectRevertTarget(args: {
  trippedCardIdx: number;
  candidates: RevertCandidate[];
  requiredMb: number;
}): string {
  const other = args.candidates.filter(
    (c) => c.idx !== args.trippedCardIdx && c.freeMb >= args.requiredMb,
  );
  if (other.length > 0) {
    const best = other.reduce((a, b) => (b.freeMb > a.freeMb ? b : a));
    return `cuda:${best.idx}`;
  }
  return 'cpu';
}
