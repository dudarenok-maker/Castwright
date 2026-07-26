/* Error types owned by the TTS provider layer. Split out from sidecar.ts so
   callers that only need to `instanceof` check don't have to import the
   whole sidecar module. */

import type { TtsEngine } from './model-keys.js';
import type { VramBlocker } from '../gpu/describe-vram-blockers.js';

/* Thrown by SidecarTtsProvider (vram-aware placement, Task 8b) when a synth
   op still can't fit on any compute device after the eviction nudge + a
   bounded poll window. Deliberately does NOT carry `{ transient: true }` —
   `withTtsRetry` (./retry.ts) treats an error as retryable ONLY via that
   flag, so this terminates the op and surfaces the message to the caller
   (chapter failure / user toast) instead of replaying the same doomed
   synth call. */
export class NoCapacityError extends Error {
  readonly engine: TtsEngine;
  readonly neededMb: number;
  readonly deviceKey: string;
  readonly blockers: VramBlocker[];

  constructor(engine: TtsEngine, neededMb: number, deviceKey: string, blockers: VramBlocker[] = []) {
    /* Name what is actually holding the memory (#1839). The generic "free VRAM"
       line is the fallback for when nothing user-controlled is resident — in
       that case the GPU is genuinely busy and there is no button to press. */
    const base = `Not enough GPU memory for ${engine} (${neededMb}MB)`;
    const message = blockers.length
      ? `${base}. ${blockers.map((b) => `${b.model} is loaded — ${b.remedy}`).join(' ')}`
      : `${base} — free VRAM or attach a second GPU.`;
    super(message);
    this.name = 'NoCapacityError';
    this.engine = engine;
    this.neededMb = neededMb;
    this.deviceKey = deviceKey;
    this.blockers = blockers;
  }
}
