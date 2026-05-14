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
> = {
  displayName:          'Mike Dudarenok',
  /* 4B is small enough (~3 GB) to stay resident across the analysis
     loop without crowding XTTS — see RESIDENT_MODELS in
     server/src/analyzer/ollama.ts. Bigger models work but reload
     between chapters by design. Flip in lockstep with
     server/src/workspace/user-settings.ts DEFAULT_USER_SETTINGS. */
  defaultAnalysisModel: 'qwen3.5:4b',
  defaultTtsEngine:     'local',
  defaultTtsModelKey:   'coqui-xtts-v2',
  sidecarUrl:           'http://localhost:9000',
  analysisEngine:       'local',
  ollamaUrl:            'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines:    3,
};
