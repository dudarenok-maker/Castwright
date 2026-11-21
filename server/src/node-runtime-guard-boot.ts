/* #4443 — side-effect module: imported FIRST by index.ts so a known-bad Node
   on Windows is refused before anything else loads. A missing or unreadable
   package.json must never stop the app (enforceNodeRuntime only warns). No
   override switch (owner decision 2026-11-20). */

import { enforceNodeRuntime } from './node-runtime-guard.js';

enforceNodeRuntime();
