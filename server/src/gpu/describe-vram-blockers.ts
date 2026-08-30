/* Turns "the GPU is full" into "THIS is what's holding it, and here is the
   button that frees it" (#1839).

   Only lists models the USER controls and that admission deliberately will not
   auto-evict. A resident Qwen base is excluded on purpose: evict-idle-tts.ts
   already frees an idle one, so naming it here would be noise on top of an
   action already taken — and (since finding 5) that holds regardless of
   whether the blocked op is itself Qwen or a non-Qwen engine (Coqui/Kokoro):
   evictIdleQwenBase now reclaims BOTH idle Qwen tiers for a non-Qwen op, not
   just the one tier a Qwen op's own elevate-only rule would free. Coqui is
   excluded for the same reason since #1894 — the sidecar's admission path
   reclaims an idle XTTS before it ever reports noCapacity.

   Coqui's exclusion is a deliberate trade, not a clean win: when the evict
   DECLINES (Coqui mid-forward for a sibling chapter) the user loses the one
   actionable line this list would have given them. Accepted because pressing
   Stop at that moment would kill a live render — the honest remedy there is
   "wait", and an entry advising a destructive action is worse than no entry.

   Kokoro stays listed. It has a Stop pill reachable wherever it's resident
   (the top bar / global TTS notice banner —
   src/components/tts-notice-banner.tsx), but stopping it only frees the VRAM
   until the sidecar next restarts, because it's the eagerly-resident fallback
   gated by the "Preload Kokoro at startup" setting — so the actionable fix
   names the setting instead. */

export interface VramBlocker {
  /** Display name, as the user sees it in the UI. */
  model: string;
  /** Imperative sentence naming the control that frees it. */
  remedy: string;
}

export interface VramBlockerHealth {
  // Deliberately unread by `describeVramBlockers` below, since #1894: the
  // sidecar still reports Coqui residency here, but admission now auto-
  // evicts an idle XTTS itself, so naming it as a user-actionable blocker
  // would advise pressing a button the server already pressed. Kept on the
  // type (rather than dropped) so the "does not list Coqui" test in the
  // sibling .test.ts can pin that this is a deliberate omission, not an
  // oversight.
  coquiLoaded?: boolean;
  kokoroLoaded?: boolean;
  qwenLoaded?: boolean;
  qwenBase17Loaded?: boolean;
  /** Unlike the resident-model flags above, a VoiceDesign IS worth naming:
      there is no auto-evict for it (it frees itself once the design session
      goes idle, or the user finishes/cancels the review), so unlike Qwen
      base/Coqui/Kokoro this is the one blocker where "wait it out" is the
      whole remedy, not noise on top of an action already taken (#2678). */
  qwenDesignResident?: boolean;
}

export function describeVramBlockers(health: VramBlockerHealth): VramBlocker[] {
  const out: VramBlocker[] = [];
  if (health.kokoroLoaded) {
    out.push({ model: 'Kokoro', remedy: 'Turn off "Preload Kokoro at startup" in settings.' });
  }
  if (health.qwenDesignResident) {
    out.push({
      model: 'A voice design',
      remedy: 'Wait for the in-progress voice design to finish — it frees automatically once idle.',
    });
  }
  return out;
}
