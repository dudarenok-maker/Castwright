/* Synthesis-error classifier — extracted from generation.ts so it can be
   unit-tested in isolation without standing up an Express handler.

   `fatal: true` means "stop the run, the next chapter will fail the same
   way." `fatal: false` means "skip this chapter and try the next one."

   The incident-tuned classification (XTTS `index out of range in self`, the
   CUDA poison-fence, the "degenerate"→/rate/ guard) now lives in the shared
   `classifyFailure` taxonomy (fs-19, ./failure-taxonomy.ts). This module is the
   thin legacy adapter: it delegates to `classifyFailure` and maps the result
   back to the `{ errorReason, fatal }` shape its callers already consume, and
   ALSO re-exports the richer classified object (code + remediation) for the
   new persistence + broadcast path. */

import { classifyFailure, type ClassifiedFailure, type FailureCode } from './failure-taxonomy.js';

export interface SynthesisErrorClassification {
  errorReason: string;
  fatal: boolean;
  /** fs-19 — stable machine code for the failure class (drives the frontend's
      remediation rendering). */
  code: FailureCode;
  /** fs-19 — concrete "what to do about it" copy. */
  remediation: string;
}

export function describeSynthesisError(
  err: unknown,
  engine?: string,
): SynthesisErrorClassification {
  const classified: ClassifiedFailure = classifyFailure(err, engine);
  return {
    errorReason: classified.userMessage,
    fatal: classified.fatal,
    code: classified.code,
    remediation: classified.remediation,
  };
}

/* Cascade detector — when the same non-fatal reason fires repeatedly across
   chapters, the underlying cause is deterministic and the queue is going to
   run dry without producing anything. Escalate to fatal so the user gets a
   single banner instead of a long string of identical chapter_failed ticks.

   Trips on the SECOND identical reason (counter >= 2) — i.e. one transient
   hiccup is allowed, but a second of the same kind stops the run. */
export interface CascadeState {
  lastReason: string | null;
  repeatCount: number;
}

export function newCascadeState(): CascadeState {
  return { lastReason: null, repeatCount: 0 };
}

export function recordNonFatal(state: CascadeState, reason: string): { fatal: boolean } {
  if (state.lastReason === reason) {
    state.repeatCount += 1;
  } else {
    state.lastReason = reason;
    state.repeatCount = 1;
  }
  return { fatal: state.repeatCount >= 2 };
}
