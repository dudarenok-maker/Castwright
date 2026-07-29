/* fs-38 Wave 3c Task 19 — last-known installed coqui-tts version, the
   clone-voice resolver's `currentArtifactVersion('coqui')` oracle
   (synthesise-chapter.ts / routes/voice-library.ts). Unlike Qwen's
   `currentQwenBaseModel()` (model-paths.ts), this can't be a static
   env-configured constant — the installed coqui-tts version is only
   knowable from the running sidecar process (`main.py`'s
   `_coqui_installed_version()`, forwarded as `coqui_version` on
   /health). Mirrors gpu/vram-state.ts's cache shape: only a REACHABLE
   health poll updates it (routes/sidecar-health.ts), so a transient
   sidecar hiccup can't downgrade a known-good reading — which matters here
   specifically because `isArtifactVersionStale` (tts/clone-engines.ts)
   treats an empty CURRENT version as "not stale" (the fail-safe Task 18
   shipped): downgrading a known version to '' on every blip would be
   harmless for staleness (still reads not-stale), but a spurious
   RE-EMPTYING would throw away a real signal for no reason.

   Starts '' so the boot window (before the first reachable poll) is
   indistinguishable from "no oracle yet" — exactly the constant-'' behaviour
   Task 18 shipped for production, now sourced from a real value once the
   sidecar has answered at least once. */

let lastKnownCoquiVersion = '';

/** Update from a health poll. Call ONLY on a reachable response — the
    unreachable/timeout branch must never call this (leaves the prior
    known-good version intact, same "no downgrade on timeout" rule as
    setLastKnownVram / setLastKnownEngineDevices). `null` covers both an
    older sidecar that omits `coqui_version` entirely and a sidecar that
    genuinely couldn't resolve it (see `_coqui_installed_version`'s own
    try/except → None) — both collapse to ''. */
export function setLastKnownCoquiVersion(version: string | null): void {
  lastKnownCoquiVersion = version ?? '';
}

export function getLastKnownCoquiVersion(): string {
  return lastKnownCoquiVersion;
}

export function _resetLastKnownCoquiVersionForTests(): void {
  lastKnownCoquiVersion = '';
}
