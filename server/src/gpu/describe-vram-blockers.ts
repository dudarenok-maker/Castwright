/* Turns "the GPU is full" into "THIS is what's holding it, and here is the
   button that frees it" (#1839).

   Only lists models the USER controls and that admission deliberately will not
   auto-evict. A resident Qwen base is excluded on purpose: evict-idle-tts.ts
   already frees an idle one, so naming it here would be noise on top of an
   action already taken. Both Coqui and Kokoro have a Stop pill reachable
   wherever they're resident (the pill in the top bar / global TTS notice
   banner — see src/components/tts-notice-banner.tsx, Task 10), but the
   remedies still differ: stopping Coqui is a durable fix (nothing reloads
   it), while Kokoro is the eagerly-resident fallback gated by the "Preload
   Kokoro at startup" setting — stopping it only frees the VRAM until the
   sidecar next restarts, so the actionable fix names the setting instead. */

export interface VramBlocker {
  /** Display name, as the user sees it in the UI. */
  model: string;
  /** Imperative sentence naming the control that frees it. */
  remedy: string;
}

export interface VramBlockerHealth {
  coquiLoaded?: boolean;
  kokoroLoaded?: boolean;
  qwenLoaded?: boolean;
  qwenBase17Loaded?: boolean;
}

export function describeVramBlockers(health: VramBlockerHealth): VramBlocker[] {
  const out: VramBlocker[] = [];
  if (health.coquiLoaded) {
    out.push({ model: 'Coqui XTTS', remedy: 'Use its Stop button, at the top of the window.' });
  }
  if (health.kokoroLoaded) {
    out.push({ model: 'Kokoro', remedy: 'Turn off "Preload Kokoro at startup" in settings.' });
  }
  return out;
}
