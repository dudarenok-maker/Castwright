/* Shared engine-list constant (srv-56) — the three local TTS engines whose
   runtime device the sidecar reports (side-14) and the server tracks.
   Centralized so engine-device-state.ts and sidecar-health.ts, which both
   need this exact list, can't drift out of sync with each other. */

export const TRACKED_ENGINES = ['kokoro', 'coqui', 'qwen'] as const;
export type TrackedEngine = (typeof TRACKED_ENGINES)[number];
