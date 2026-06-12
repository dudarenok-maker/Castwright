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
    userMessage:
      'Something failed in a way the app does not recognise — the raw error message is shown in place of this line.',
    remediation:
      'Click Retry on this chapter. If it keeps failing, check the server / sidecar logs for the full ' +
      'error and report it.',
  },
} as const satisfies Record<string, FailureRemediationCopy>;
