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

export function describeSynthesisError(
  err: unknown,
  engine?: string,
): SynthesisErrorClassification {
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;

  /* Per-call ceiling tripped (ChapterSynthTimeoutError, synthesise-chapter.ts).
     Its own message says "Skipping this chapter so the queue can advance" — it
     is MEANT to be non-fatal: drop this chapter, keep the queue moving. Classify
     it explicitly and FIRST so (a) a future regex tweak can't re-escalate it and
     (b) its "…runaway/degenerate input…" wording can never be read as a quota
     error. The substring "rate" inside "dege·nerate" used to match the old
     `/rate/i` quota regex and stop the whole run (2026-05-31, KOTLC Stellarlune
     CH24). */
  if (name === 'ChapterSynthTimeoutError') {
    return {
      errorReason:
        'TTS synthesis timed out for this chapter — the local engine stalled (often the ' +
        'sidecar reclaiming memory mid-render). Skipped so the queue advances; click Retry to re-render.',
      fatal: false,
    };
  }

  const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(raw);
  if (isSidecarDown) {
    return { errorReason: 'Local TTS sidecar not running — start it and resume.', fatal: true };
  }

  /* Upstream rate-limit / quota. Match STRICTLY: a real HTTP 429, or an
     unambiguous quota / rate-limit phrase. The bare token "rate" is NOT enough —
     it matches inside ordinary words like "degenerate"/"generated", which is
     exactly how a local Qwen timeout got mislabeled "Gemini TTS rate-limited". */
  const isHttp429 = status === 429;
  const looksRateLimited =
    isHttp429 ||
    /\b429\b|\btoo many requests\b|\bquota\b|rate[-\s]?limit|resource (?:has been )?exhausted/i.test(
      raw,
    );
  if (looksRateLimited) {
    /* Only the metered cloud engine (Gemini TTS) can actually rate-limit; the
       local sidecar engines (qwen/kokoro/coqui) never do. A genuine 429 is always
       upstream. But a rate-limit-SHAPED message on a local-engine run is NOT
       Gemini — don't pin the blame there; surface the raw reason as non-fatal. */
    const localEngine = engine != null && engine !== 'gemini';
    if (isHttp429 || !localEngine) {
      return {
        errorReason:
          'Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.',
        fatal: true,
      };
    }
    const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
    return { errorReason: trimmed, fatal: false };
  }

  const isAuth = status === 401 || status === 403 || /invalid[_ ]?key|API key/i.test(raw);
  if (isAuth) {
    return { errorReason: 'Gemini TTS authentication failed — check GEMINI_API_KEY.', fatal: true };
  }

  const isXttsTensor =
    /index out of range in self|IndexError|out of range \(expected to be in range/i.test(raw);
  if (isXttsTensor) {
    return {
      errorReason:
        'Local TTS engine rejected a speaker — the voice catalog is out of sync with the loaded model. Stop the sidecar, re-run the speaker manifest audit, and regenerate.',
      fatal: true,
    };
  }

  /* CUDA device-side assert — the XTTS GPT decoder hit an out-of-bounds
     embedding lookup (most commonly from a stray zero-width / bidi /
     control char in the manuscript that survived `normaliseForTts`).
     PyTorch's contract is unambiguous: once any CUDA kernel asserts, the
     context is corrupted for the rest of the process and every subsequent
     call re-raises the same error. The sidecar self-flags as poisoned,
     fast-fails subsequent /synthesize calls with 503, and exits with code
     42 — which start.ps1's supervisor loop catches to respawn uvicorn
     with a fresh CUDA context. From the user's POV this is fatal for the
     current chapter (we stop the run so the cascade detector doesn't burn
     queued chapters during the ~5–10 s restart window), but clicking
     Retry once /health comes back picks up cleanly. The offending text is
     in the sidecar log under `text_preview=` — usually a stray
     zero-width, bidi, or control char in the manuscript. */
  const isCudaPoisoned =
    /device-side assert|CUDA error|CUDA kernel errors|"poisoned":\s*true/i.test(raw);
  if (isCudaPoisoned) {
    return {
      errorReason:
        'Local TTS sidecar hit a CUDA error and is auto-restarting (the CUDA context is corrupted process-wide; only a fresh Python process recovers). Wait ~10 seconds for the sidecar pill to go green again, then click Retry on this chapter. The offending text is in the sidecar log (text_preview=) — usually a stray zero-width or control char in the manuscript.',
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
