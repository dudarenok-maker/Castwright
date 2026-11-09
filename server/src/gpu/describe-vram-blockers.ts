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

   Kokoro stays listed (but see the render-in-flight rule below). It has a Stop pill reachable wherever it's resident
   (the top bar / global TTS notice banner —
   src/components/tts-notice-banner.tsx). When the "Preload Kokoro at startup"
   setting is ON, stopping it only frees the VRAM until the sidecar next
   restarts, so the actionable fix names the setting. When the setting is OFF
   (the default) Kokoro was loaded on demand by a render that needed it, and
   the setting is not the cause — the remedy names the Stop control instead
   (#4066: the old copy said "Turn off Preload Kokoro" with preload already
   off). A Kokoro reported on the CPU holds no VRAM and is not listed.

   #4066 — a voice design or a Quality op now auto-frees the standard Qwen
   base and an on-GPU Kokoro (./evict-idle-tts.ts), EXCEPT while a render is
   in flight, where that model may be in use. In that one case the standard
   Qwen model IS the blocker and the honest remedy is to wait or pause, so it
   is named when `generationActive` is set. */

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
      while it's genuinely IN-FLIGHT (a design forward actively computing),
      there is no auto-evict for it at all — same as Kokoro/Coqui/Qwen base
      being mid-forward. Once it's merely RESIDENT-AND-IDLE, the sidecar's
      own admission ladder auto-evicts it immediately (ttl 0) as a side
      effect of the *next* admission attempt on that card
      (`_idle_evict_steps` in main.py) — but that's a side effect of a later
      retry, not of the request that has already been denied, so "wait it
      out" is still the whole correct remedy either way: either the
      in-flight design finishes, or the next retry's own admission ladder
      sweeps the idle one. So unlike Qwen base/Coqui/Kokoro this is the one
      blocker where "wait it out" is the whole remedy, not noise on top of
      an action already taken (#2678). */
  qwenDesignResident?: boolean;
  /** #4066 — the effective "Preload Kokoro at startup" setting. Only when it
      is on is the setting the remedy for a resident Kokoro. */
  kokoroPreload?: boolean;
  /** #4066 — Kokoro's device family from the sidecar's device map. 'cpu'
      means it holds no VRAM; absent/unknown is treated as possibly-GPU. */
  kokoroDevice?: string | null;
  /** #4066 — a chapter render is known to be in flight, so the auto-free
      declined and a resident standard Qwen model is in use by it. */
  generationActive?: boolean;
  /** #4066 — the blocked op is that render's own synth call, so the render is
      the one asking for capacity and is never named as what holds the Qwen
      model. Kokoro still gets the wait remedy during a render. */
  blockedOpIsRender?: boolean;
}

export function describeVramBlockers(health: VramBlockerHealth): VramBlocker[] {
  const out: VramBlocker[] = [];
  if (health.kokoroLoaded && health.kokoroDevice !== 'cpu') {
    out.push({
      model: 'Kokoro',
      /* During a render, Stop would kill a Kokoro fallback line in flight —
         the same "never advise a destructive action" rule as Coqui above. */
      remedy: health.generationActive
        ? 'A chapter render is in progress and may be using it — wait for the render to finish, or pause it, then try again.'
        : health.kokoroPreload
          ? 'Turn off "Preload Kokoro at startup" in settings.'
          : 'Press "Stop Kokoro" in the "Voice engines loaded" row under the top bar.',
    });
  }
  if (health.generationActive && !health.blockedOpIsRender && (health.qwenLoaded || health.qwenBase17Loaded)) {
    out.push({
      model: health.qwenLoaded ? 'The standard Qwen voice model' : 'The Quality Qwen voice model',
      remedy: 'It is in use by the chapter render in progress — wait for the render to finish, or pause it, then try again.',
    });
  }
  if (health.qwenDesignResident) {
    out.push({
      model: 'A voice design',
      remedy: 'Wait for the in-progress voice design to finish — it frees automatically once idle.',
    });
  }
  return out;
}
