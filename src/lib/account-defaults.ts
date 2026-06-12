/* Single source of truth for the frontend's "no settings hydrated yet"
   defaults. Mirrors server/src/workspace/user-settings.ts
   DEFAULT_USER_SETTINGS — the boot-time `fetchAccountSettings` thunk
   overwrites these in the Redux slice within ms of page load, so the
   values only matter for the initial render. Centralising them here
   means there is exactly one place to flip a default and have every
   downstream (slice, mock, per-book pick fallback, tests) agree.

   These keys cover only the user-writable fields. Server-derived /
   read-only fields (apiKeyStatus, workspaceRoot, workspaceSource)
   live on the slice and the API response, never here. */

import type { UserSettings } from './types';

export const FRONTEND_ACCOUNT_DEFAULTS: Pick<
  UserSettings,
  | 'displayName'
  | 'defaultAnalysisModel'
  | 'defaultTtsEngine'
  | 'defaultTtsModelKey'
  | 'sidecarUrl'
  | 'analysisEngine'
  | 'ollamaUrl'
  | 'workspaceDirOverride'
  | 'minorCastMinLines'
  | 'coverPickerDefaultTab'
  | 'defaultThemePreference'
  | 'autoStartSidecar'
  | 'analyzerPhase0Model'
  | 'analyzerPhase1Model'
  | 'analyzerPhase1MinLagChapters'
  | 'dualModelEnabled'
  | 'eagerLoadKokoro'
  | 'eagerLoadQwen'
  | 'generationWorkers'
  | 'backupEnabled'
  | 'backupCadence'
  | 'backupRetention'
> = {
  displayName: 'Castwright',
  /* Gemini 3.1 Flash Lite over the Google API key is the new default
     for analysis — free tier (15 RPM, 250K TPM, 500/day) handles a
     full novel without saturating the local GPU. Local Ollama models
     stay one click away in the picker for users who want analysis to
     run on-device. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  defaultAnalysisModel: 'gemini-3.1-flash-lite',
  defaultTtsEngine: 'local',
  /* Kokoro v1 is the new default — quality-tuned, ~1 GB VRAM (vs ~3 GB
     for XTTS), eagerly loaded by the sidecar. XTTS stays available as
     an alternate in the picker for users who want its zero-shot voice
     cloning. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  defaultTtsModelKey: 'kokoro-v1',
  sidecarUrl: 'http://localhost:9000',
  /* Gemini matches the analysis-model default; Local stays an opt-in. */
  analysisEngine: 'gemini',
  ollamaUrl: 'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines: 3,
  /* Plan 40 — which CoverPicker tab opens first. `'search'` matches
     today's behaviour (OpenLibrary candidates first). Users who lean
     on local artwork can flip to `'upload'` in the Account view.
     Flip in lockstep with server/src/workspace/user-settings.ts
     DEFAULT_USER_SETTINGS. */
  coverPickerDefaultTab: 'search',
  /* Plan 41 — first-visit / account-default theme. `'system'` follows
     the OS's prefers-color-scheme at runtime; users can pin Light or
     Dark from the Account view or via the top-bar quick toggle.
     Flip in lockstep with server/src/workspace/user-settings.ts
     DEFAULT_USER_SETTINGS. */
  defaultThemePreference: 'system',
  /* Plan 43 — auto-start the TTS sidecar at server boot. On by default
     because Kokoro v1 (the engine default) is cheap to keep resident
     (~1 GB VRAM, ~1 s load). Users running Coqui or sharing VRAM with
     the analyzer can toggle off in the Account view. Flip in lockstep
     with server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  autoStartSidecar: true,
  /* Plan 88 phase-2 — Account-tab Analyzer card knobs. `null` means
     "fall through to env / hardcoded default" so an unhydrated render
     doesn't pin a value the user hasn't actually saved. Flip in
     lockstep with server/src/workspace/user-settings.ts
     DEFAULT_USER_SETTINGS. */
  analyzerPhase0Model: null,
  analyzerPhase1Model: null,
  analyzerPhase1MinLagChapters: null,
  /* Off by default — keeping two TTS engines resident in GPU memory at
     once is a deliberate VRAM commitment the user opts into in the
     Account view. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  dualModelEnabled: false,
  /* On by default — Kokoro v1 (the engine default) is cheap to eager-load
     (~1 GB VRAM, ~1 s). Qwen-primary users turn this off to reclaim that
     ~1 GB; Kokoro then warms on demand on first synth. Flip in lockstep
     with server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  eagerLoadKokoro: true,
  /* On by default — when Qwen is the default engine the sidecar eager-loads
     Qwen Base at startup. Qwen-primary users wanting a lazy warm turn this
     off; no effect under a Kokoro/Coqui default. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  eagerLoadQwen: true,
  /* Plan 111 — 1 concurrent generation worker by default. Queue/synthesis
     concurrency only; the GPU semaphore stays the VRAM guard. Flip in lockstep
     with server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  generationWorkers: 1,
  /* srv-2 — per-book state.json auto-backup. On by default with a daily
     cadence and a 14-snapshot retention window. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  backupEnabled: true,
  backupCadence: 'daily',
  backupRetention: 14,
};
