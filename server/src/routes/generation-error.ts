/* Synthesis-error classifier — extracted from generation.ts so it can be
   unit-tested in isolation without standing up an Express handler.

   `fatal: true` means "stop the run, the next chapter will fail the same
   way." `fatal: false` means "skip this chapter and try the next one."

   The XTTS `index out of range in self` pattern is the visible failure mode
   when the local Coqui sidecar's voice manifest falls out of sync with the
   model's loaded speaker embedding tensor — the substituted speaker passes
   manifest validation but the internal `torch.gather` lookup raises. There
   is no per-chapter recovery because every chapter routes through the same
   speaker_id resolution path; retrying just burns through the queue with
   the same error (see screenshot 2026-05-13 181647 for the cascade). */

export interface SynthesisErrorClassification {
  errorReason: string;
  fatal: boolean;
}

export function describeSynthesisError(err: unknown): SynthesisErrorClassification {
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;

  const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(raw);
  if (isSidecarDown) {
    return { errorReason: 'Local TTS sidecar not running — start it and resume.', fatal: true };
  }

  const isQuota = status === 429 || /429|quota|rate/i.test(raw);
  if (isQuota) {
    return { errorReason: 'Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.', fatal: true };
  }

  const isAuth = status === 401 || status === 403 || /invalid[_ ]?key|API key/i.test(raw);
  if (isAuth) {
    return { errorReason: 'Gemini TTS authentication failed — check GEMINI_API_KEY.', fatal: true };
  }

  const isXttsTensor = /index out of range in self|IndexError|out of range \(expected to be in range/i.test(raw);
  if (isXttsTensor) {
    return {
      errorReason: 'Local TTS engine rejected a speaker — the voice catalog is out of sync with the loaded model. Stop the sidecar, re-run the speaker manifest audit, and regenerate.',
      fatal: true,
    };
  }

  const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  return { errorReason: trimmed, fatal: false };
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
