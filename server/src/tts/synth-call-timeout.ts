/* Defensive per-call ceiling (plan 148). A single provider call that never
   returns — e.g. Qwen's open-ended decode running away on degenerate, non-prose
   input (a table-of-contents page, a copyright block) — would otherwise hang the
   chapter, and with it the whole generation queue, indefinitely (the 2026-05-31
   the Hollow Tide stall). Bounding each call turns that infinite hang into a single
   chapter failure the queue rides past. Generous default (10 min) — far above
   any legitimate single batch (~250 s for 32 sentences). `0` disables.

   Lives in its own leaf module (not synthesise-chapter.ts) so tts/gemini.ts can
   read it without closing an import cycle through tts/index.ts (#3724);
   synthesise-chapter.ts re-exports it for its existing importers. */
export const SYNTH_CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SIDECAR_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 600_000;
})();
