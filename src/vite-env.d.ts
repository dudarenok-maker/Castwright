/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Plan 124 — build-version footer. Injected by vite.config.ts `define` at
// build/dev-start. Under Vitest (no `define`) these are undefined, so
// src/lib/build-info.ts reads each behind a `typeof` guard.
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __GIT_BRANCH__: string;
declare const __GIT_DIRTY__: boolean;
declare const __BUILD_TIME__: string;
