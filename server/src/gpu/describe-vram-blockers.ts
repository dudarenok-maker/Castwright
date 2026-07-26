/* Turns "the GPU is full" into "THIS is what's holding it, and here is the
   button that frees it" (#1839).

   Only lists models the USER controls and that admission deliberately will not
   auto-evict. A resident Qwen base is excluded on purpose: evict-idle-tts.ts
   already frees an idle one, so naming it here would be noise on top of an
   action already taken. The two remedies differ because the two models are
   controlled differently — Coqui has a Load/Stop pill, Kokoro does not. */

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
    out.push({ model: 'Coqui XTTS', remedy: 'Stop it in the Models panel.' });
  }
  if (health.kokoroLoaded) {
    out.push({ model: 'Kokoro', remedy: 'Turn off "Preload Kokoro" in settings.' });
  }
  return out;
}
