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
      'TTS synthesis timed out for this chapter — the local engine stalled (often the ' +
      'sidecar reclaiming memory mid-render). Skipped so the queue advances; click Retry to re-render.',
    remediation:
      'Click Retry on this chapter. If it times out repeatedly, restart the TTS sidecar to clear ' +
      'a wedged GPU state, then retry.',
  },
  'sidecar-unreachable': {
    userMessage: 'Local TTS sidecar not running — start it and resume.',
    remediation:
      'Start the TTS sidecar (npm start launches it automatically), wait for the sidecar pill to ' +
      'go green, then resume the run.',
  },
  'recycle-storm': {
    userMessage: 'The TTS engine kept restarting while rendering this chapter.',
    remediation:
      'The sidecar is likely thrashing — the host-memory leak (side-11) or too little ' +
      'VRAM/RAM headroom. Restart the TTS sidecar and/or lower generation concurrency, then Retry.',
  },
  'vram-spill': {
    userMessage:
      'The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once.',
    remediation:
      'Unload any models you are not generating with (the analyzer Ollama, or a second TTS engine) ' +
      'from the model pills, then retry. On an 8 GB card keep only one heavy TTS model loaded.',
  },
  oom: {
    userMessage:
      'The TTS sidecar was killed by the operating system — the machine ran out of host RAM.',
    remediation:
      'Close other memory-heavy apps and retry. If it recurs, the sidecar is leaking — restart it ' +
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
  auth: {
    userMessage: 'Gemini TTS authentication failed — check GEMINI_API_KEY.',
    remediation:
      'Verify GEMINI_API_KEY in server/.env is set and valid, restart the server, then retry.',
  },
  'xtts-speaker-desync': {
    userMessage:
      'Local TTS engine rejected a speaker — the voice catalog is out of sync with the loaded model. ' +
      'Stop the sidecar, re-run the speaker manifest audit, and regenerate.',
    remediation:
      'Stop the TTS sidecar, re-run the speaker-manifest audit, then restart the sidecar and ' +
      'regenerate this chapter.',
  },
  'cuda-poisoned': {
    userMessage:
      'Local TTS sidecar hit a CUDA error and is auto-restarting (the CUDA context is corrupted ' +
      'process-wide; only a fresh Python process recovers). Wait ~10 seconds for the sidecar pill ' +
      'to go green again, then click Retry on this chapter. The offending text is in the sidecar ' +
      'log (text_preview=) — usually a stray zero-width or control char in the manuscript.',
    remediation:
      'Wait ~10 seconds for the sidecar to respawn (the pill goes green), then click Retry. If it ' +
      'recurs on the same chapter, check the sidecar log text_preview= for a stray control char.',
  },
  'model-not-loaded': {
    userMessage:
      'The TTS model is not loaded in the sidecar yet — synthesis was requested before the model ' +
      'finished loading.',
    remediation:
      'Load the engine from its model pill (or wait for the auto-load to finish — the pill turns ' +
      'green), then retry the chapter.',
  },
  unknown: {
    /* Rendered by the Help view only — the live unknown path shows trimRaw(raw) instead. */
    userMessage:
      'Something failed in a way the app does not recognise — the raw error message is shown in place of this line.',
    remediation:
      'Click Retry on this chapter. If it keeps failing, check the server / sidecar logs for the full ' +
      'error and report it.',
  },
} as const satisfies Record<string, FailureRemediationCopy>;
