/* fs-45 v1 — TTS engine VRAM sampler. Records the ABSOLUTE sidecar
   `vram_reserved_mb` at an op's peak (NOT a delta). Reserved is a sticky,
   process-wide high-water mark → over-estimates (the OOM-SAFE direction).
   qwen:design is sampled while VoiceDesign is resident (correct peak).
   qwen:synth/coqui are sampled ONLY from a clean process (design never loaded),
   so the sticky pool reflects that engine's own peak, not a stale design peak.

   #2052 — `maybeSampleSidecarEngine` used to reach `routes/sidecar-health.ts`
   by a dynamic `import()`, violating CLAUDE.md's "gpu/ reaches a route module
   through a leaf gate, never an import" convention (a static import, a
   dynamic `import()`, and even `import type` all close a cycle through
   `tts/index.ts`). It now goes through `sidecar-health-gate.ts`'s registered
   accessor instead, matching `active-generation-gate.ts` /
   `qwen-tier-reconcile-gate.ts` / the rest of `gpu/`'s route-module readers.
   Fails closed the same way the gate itself does: nothing registered yet
   (module load order, a test importing this module in isolation) → no
   sample recorded, not a crash. */
import { recordVramSample } from '../analyzer/model-vram-stats.js';
import { probeSidecarHealthIfRegistered } from './sidecar-health-gate.js';

type SidecarVramKey = 'qwen:synth' | 'qwen:design' | 'coqui';
const SANE_MAX_MB = 200_000;

export async function recordSidecarEngineVram(
  key: SidecarVramKey,
  reservedMb: number | null | undefined,
): Promise<void> {
  if (reservedMb == null || !Number.isFinite(reservedMb)) return;
  if (reservedMb <= 0 || reservedMb > SANE_MAX_MB) return;
  await recordVramSample({ at: new Date().toISOString(), key, vramMb: reservedMb });
}

/** Record from an already-probed health snapshot, applying the clean-process gate. */
export async function sampleSidecarEngineVram(
  key: SidecarVramKey,
  health: { vramReservedMb?: number | null; qwenLoaded?: boolean; qwenDesignEverLoaded?: boolean },
): Promise<void> {
  if (key === 'qwen:design') {
    if (health.qwenLoaded !== true) return; // sanity: qwen must be resident
  } else {
    // qwen:synth / coqui — only from a process uncontaminated by a prior design.
    if (health.qwenDesignEverLoaded !== false) return;
  }
  await recordSidecarEngineVram(key, health.vramReservedMb);
}

/** One-liner for the wired call sites: env-gated (so fetch-count tests opt out
    via CASTWRIGHT_VRAM_SAMPLE=0) + probes /health (via the leaf gate) + applies
    the gate. The env check is FIRST so a disabled sample issues no /health
    fetch at all. Best-effort: a failed probe, or nothing registered yet
    (`probeSidecarHealthIfRegistered` returns null — fail closed), records
    nothing rather than throwing. */
export async function maybeSampleSidecarEngine(key: SidecarVramKey): Promise<void> {
  if (process.env.CASTWRIGHT_VRAM_SAMPLE === '0') return;
  try {
    const health = await probeSidecarHealthIfRegistered();
    if (!health) return;
    await sampleSidecarEngineVram(key, health);
  } catch {
    /* best-effort */
  }
}
