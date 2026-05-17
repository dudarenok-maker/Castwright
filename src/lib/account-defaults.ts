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

export const FRONTEND_ACCOUNT_DEFAULTS: Pick<UserSettings,
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
> = {
  displayName:          'Mike Dudarenok',
  /* Gemini 3.1 Flash Lite over the Google API key is the new default
     for analysis — free tier (15 RPM, 250K TPM, 500/day) handles a
     full novel without saturating the local GPU. Local Ollama models
     stay one click away in the picker for users who want analysis to
     run on-device. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  defaultAnalysisModel: 'gemini-3.1-flash-lite',
  defaultTtsEngine:     'local',
  /* Kokoro v1 is the new default — quality-tuned, ~1 GB VRAM (vs ~3 GB
     for XTTS), eagerly loaded by the sidecar. XTTS stays available as
     an alternate in the picker for users who want its zero-shot voice
     cloning. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  defaultTtsModelKey:   'kokoro-v1',
  sidecarUrl:           'http://localhost:9000',
  /* Gemini matches the analysis-model default; Local stays an opt-in. */
  analysisEngine:       'gemini',
  ollamaUrl:            'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines:    3,
  /* Plan 40 — which CoverPicker tab opens first. `'search'` matches
     today's behaviour (OpenLibrary candidates first). Users who lean
     on local artwork can flip to `'upload'` in the Account view.
     Flip in lockstep with server/src/workspace/user-settings.ts
     DEFAULT_USER_SETTINGS. */
  coverPickerDefaultTab: 'search',
};
