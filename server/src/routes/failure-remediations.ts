/* fs-19 / fe-29 — canonical failure copy, shared by the server taxonomy
   (failure-taxonomy.ts pulls each signature's strings from here) and the
   frontend Help view (src/views/help.tsx imports this file across the package
   boundary; Vite bundles it statically so Help works offline).

   RULES:
   - Import NOTHING. This file must type-check identically under both the
     server (NodeNext) and frontend (bundler) tsconfigs and must never pull
     server-only code into the frontend bundle.
   - Keys must exactly equal the FailureCode union in failure-taxonomy.ts and
     the OpenAPI FailureCode enum — pinned by a test on the server side and a
     `satisfies` check on the frontend side.
   - `helpDetail` is OPTIONAL longer prose rendered only by the Help view. */

export interface FailureRemediationCopy {
  userMessage: string;
  remediation: string;
  helpDetail?: string;
}

export const FAILURE_REMEDIATIONS = {
  'synth-timeout': {
    userMessage:
      'Voice synthesis timed out for this chapter — the local engine stalled (often the ' +
      'voice engine reclaiming memory mid-render). Skipped so the queue advances; click Retry to re-render.',
    remediation:
      'Click Retry on this chapter. If it times out repeatedly, restart the voice engine to clear ' +
      'a wedged GPU state, then retry.',
  },
  'sidecar-unreachable': {
    userMessage: 'Local voice engine not running — start it and resume.',
    remediation:
      'Start the voice engine (npm start launches it automatically), wait for the voice engine pill to ' +
      'go green, then resume the run.',
  },
  'recycle-storm': {
    userMessage: 'The voice engine kept restarting while rendering this chapter.',
    remediation:
      'The voice engine is likely thrashing — the host-memory leak (side-11) or too little ' +
      'VRAM/RAM headroom. Restart the voice engine and/or lower generation concurrency, then Retry.',
  },
  'vram-spill': {
    userMessage:
      'The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once.',
    remediation:
      'Unload any models you are not generating with (the analyzer Ollama, or a second voice engine) ' +
      'from the model pills, then retry. On an 8 GB card keep only one heavy voice engine loaded.',
  },
  oom: {
    userMessage:
      'The voice engine was killed by the operating system — the machine ran out of host RAM.',
    remediation:
      'Close other memory-heavy apps and retry. If it recurs, the voice engine is leaking — restart it ' +
      'to reset its host memory, then resume.',
  },
  'disk-full': {
    userMessage: 'The workspace volume is out of disk space — the chapter audio could not be written.',
    remediation:
      'Free up disk space on the workspace volume (delete old exports, or move the workspace to a ' +
      'larger drive), then retry the chapter.',
  },
  'analyzer-rate-limit': {
    userMessage: 'Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.',
    remediation:
      'Wait for the quota window to reset (Gemini free-tier resets daily), or switch to a local ' +
      'engine (Kokoro / Qwen) in the engine picker, then resume.',
  },
  'analyzer-unreachable': {
    userMessage:
      'The analyzer could not be reached or stopped responding — the local Ollama daemon is down, ' +
      'or the analyzer service returned a server error.',
    remediation:
      'Check that Ollama is running (ollama serve), or switch the analyzer in server/.env ' +
      '(ANALYZER=gemini with a GEMINI_API_KEY). Then retry the chapter or resume the run.',
    helpDetail:
      'When GEMINI_API_KEY is set, an unreachable Ollama silently retries against Gemini, so this ' +
      'error usually means no fallback was configured — or both engines failed.',
  },
  'analyzer-content-blocked': {
    userMessage:
      "Gemini blocked this chapter — its recitation filter refused the source text. The gemini-* " +
      "models reject text they recognise as copyrighted, and a published book's opening chapter is " +
      'the classic trigger.',
    remediation:
      'Switch the analyzer to a gemma-* model (set GEMINI_MODEL=gemma-4-31b-it in server/.env — the ' +
      'gemma family is not subject to the recitation filter) or to the local Ollama analyzer ' +
      '(ANALYZER=local). Restart, then click Retry.',
    helpDetail:
      'The block is deterministic — retrying the same model on the same text fails identically, so ' +
      'it is not a transient error. gemma-* runs on a separate API bucket without recitation ' +
      'filtering; any local Ollama model (e.g. qwen3.5:4b) avoids the filter entirely and is the ' +
      'most robust choice for copyrighted manuscripts.',
  },
  'analyzer-truncated': {
    userMessage:
      'The analyzer model cut its reply short — a chapter section was too large for one ' +
      'attribution call, even after automatic re-splitting.',
    remediation:
      'Retry the chapter. If it recurs, lower STAGE2_CHUNK_CHAR_BUDGET in server/.env (or Advanced ' +
      'Settings) or switch to a stronger analyzer model.',
  },
  'analyzer-daily-quota': {
    userMessage: "The analyzer's free-tier daily quota is exhausted.",
    remediation:
      'Switch to a different analyzer model (GEMINI_MODEL in server/.env or Advanced Settings — ' +
      'each model has its own daily bucket), use the local Ollama analyzer, or wait for the quota ' +
      'reset shown in the error.',
  },
  'attribution-incomplete': {
    userMessage:
      "Some lines in this chapter may be unattributed — the analyzer's answer did not cover every " +
      'sentence, so the best take was kept and the chapter was flagged.',
    remediation:
      'Click Retry on this chapter to re-run attribution. Already-attributed lines are kept; a ' +
      'retry usually fills the gaps.',
  },
  'attribution-collapse': {
    /* #2342 item 2 — distinct from `attribution-incomplete`: every sentence
       WAS covered here, so "did not cover every sentence" / "retry usually
       fills the gaps" is false on every count. The cast was ignored (every
       spoken line handed to the narrator) or the dialogue markers themselves
       were lost, not dropped prose. */
    userMessage:
      "This chapter's cast was not used — every (or nearly every) spoken line was attributed to the " +
      'narrator instead of the character speaking it, or the dialogue markers were lost outright.',
    remediation:
      "Click Retry on this chapter to re-run attribution. If it repeats, check that the book's " +
      'language is set correctly on the confirm screen — a dash-convention language is what makes ' +
      'this check active at all.',
  },
  auth: {
    userMessage: 'Gemini TTS authentication failed — check GEMINI_API_KEY.',
    remediation:
      'Verify GEMINI_API_KEY in server/.env is set and valid, restart the server, then retry.',
  },
  'xtts-speaker-desync': {
    userMessage:
      'Local voice engine rejected a speaker — the voice catalog is out of sync with the loaded model. ' +
      'Stop the voice engine, re-run the speaker manifest audit, and regenerate.',
    remediation:
      'Stop the voice engine, re-run the speaker-manifest audit, then restart the voice engine and ' +
      'regenerate this chapter.',
  },
  'cuda-poisoned': {
    userMessage:
      'Local voice engine hit a CUDA error and is auto-restarting (the CUDA context is corrupted ' +
      'process-wide; only a fresh Python process recovers). Wait ~10 seconds for the voice engine pill ' +
      'to go green again, then click Retry on this chapter. The offending text is in the voice engine ' +
      'log (text_preview=) — usually a stray zero-width or control char in the manuscript.',
    remediation:
      'Wait ~10 seconds for the voice engine to respawn (the pill goes green), then click Retry. If it ' +
      'recurs on the same chapter, check the voice engine log text_preview= for a stray control char.',
  },
  'gpu-acceleration-unavailable': {
    userMessage:
      'GPU acceleration is unavailable, so the voice engine is running on the CPU (slower, ' +
      'but it still works). Common on AMD: the GPU driver is too old, the GPU model isn’t ' +
      'in the supported set, or a DirectML operation isn’t supported and Kokoro fell back ' +
      'to CPU.',
    remediation:
      'Update your GPU driver (AMD: the latest Adrenalin). Confirm your GPU is supported for ' +
      'ROCm/DirectML — some integrated/older cards are not. AMD support is an experimental ' +
      'preview; if it won’t accelerate, set the Accelerator to CPU in Advanced settings to ' +
      'silence this, or switch back to a supported NVIDIA/Apple machine for full speed.',
  },
  'model-not-loaded': {
    userMessage:
      'The voice engine is not loaded yet — synthesis was requested before the model ' +
      'finished loading.',
    remediation:
      'Load the engine from its model pill (or wait for the auto-load to finish — the pill turns ' +
      'green), then retry the chapter.',
  },
  'voice-not-designed': {
    userMessage:
      'A non-English chapter needs a designed voice for every speaking character — the English-only ' +
      'Kokoro fallback cannot stand in.',
    remediation: 'Design the missing voice(s) in the cast view, then retry the chapter.',
  },
  'cloned-voice-broken': {
    /* fs-38 Wave 3b2 (T7) — a cloned voice must never be silently substituted
       with another, so the resolver fails the chapter instead. This copy is
       deliberately reason-NEUTRAL (never names Qwen specifically, so a
       wrong-engine break — the character just doesn't route to Qwen this
       run, which Qwen itself may be perfectly healthy — can never misread as
       "Qwen is unavailable"). The reason-specific detail (which voice, and
       why: revoked / missing sample / wrong engine / re-derive failed) rides
       in the chapter's own errorReason line, sourced straight from
       UnresolvableClonedVoiceError's message (see generation.ts's short-
       circuit before describeSynthesisError, mirroring the isStall/
       isRecycleStorm precedent) — this static copy is the fallback shown by
       the offline Help view.

       #1979 — the `derive-failed` clause below is worded from
       UnresolvableClonedVoiceError.fromList's own live remedy ("re-run the
       clone for <engine> and check the sidecar log", clone-voice-resolver.ts)
       rather than a second, drifting phrasing — engine name dropped to keep
       this copy reason-neutral like the rest of it.

       #2023 — the `misattributed-substitution` reason (a healthy cloned
       narrator refusing to borrow an orphaned characterId's line) has no
       cast row to reassign and nothing wrong with the voice to repair, so
       its own remedy ("re-attribute … in the Manuscript view",
       clone-voice-resolver.ts's `fromList`) is added alongside the others
       here too, for the same reason-neutral, list-every-possible-fix
       precedent the `derive-failed` clause set. */
    userMessage:
      "A cloned voice in this chapter can't be used as itself — a real person's voice is never " +
      'substituted with another. See the reason above for which voice and why.',
    remediation:
      "Re-upload the voice's sample, restore consent, re-run the clone and check the sidecar log, " +
      'switch the book to the engine the voice was cloned for, re-attribute the affected sentence(s) ' +
      'in the Manuscript view, or reassign the character — then generate again.',
  },
  'lock-contention': {
    /* #2260 — one operation on a book waited too long for another to release
       that book's file lock. Nothing is broken; the work simply queued behind
       something else and gave up after ten seconds.

       `userMessage` here is the OFFLINE HELP prose. The live analysis path
       substitutes `LOCK_CONTENTION_REQUEST_ERROR` (workspace/file-lock.ts) —
       the same sentence the merge routes return — because this file may not
       import anything, so it cannot share that constant. Keep the two saying
       the same thing; deliberately neither names a file, a key or a path,
       which is the entire reason the curated copy exists. */
    userMessage:
      'Another operation on this book was still holding its file lock, so this one gave up waiting ' +
      '— that is contention, not a problem with the book or with what you asked for.',
    remediation:
      'Wait for the other operation to finish (a large library makes removing a voice from My voices ' +
      'the slowest one), then try again. Reload first to see whether the change landed anyway.',
    helpDetail:
      'Castwright takes a book aside while it changes anything about your cast, so two changes can ' +
      'never overwrite each other. A second change waits its turn and gives up after ten seconds ' +
      'rather than waiting forever. It is almost always over by the time you retry.',
  },
  'language-unset': {
    /* #2509 — a chapter was rendered without a book language, so the voice
       engine had no language mapping for the cast. The chapter is skipped
       rather than guessed. */
    userMessage:
      "This book doesn't have a language set yet, so the voice engine can't pick the right voice for " +
      'the cast. Set the language in the book settings and try again.',
    remediation:
      'Open the book settings, choose a language for the book, then retry the chapter.',
  },
  unknown: {
    /* Rendered by the Help view only — the live unknown path shows trimRaw(raw) instead. */
    userMessage:
      'Something failed in a way the app does not recognise — the raw error message is shown in place of this line.',
    remediation:
      'Click Retry on this chapter. If it keeps failing, check the server / voice engine logs for the full ' +
      'error and report it.',
  },
} as const satisfies Record<string, FailureRemediationCopy>;
