/* #4443 — the guard logic is shared with the launchers (scripts/start-app-prod.mjs
   makes its own 127.0.0.1 connect before the server exists), so it lives in
   scripts/lib/node-runtime-guard.mjs. This file re-exports it for the server.
   The `../../scripts/lib` depth holds from server/src and from server/dist. */

export {
  enforceNodeRuntime,
  findCrashRange,
  isCondaEnvNode,
  loadCrashRanges,
  loadNodeMinimum,
  nodeRuntimeRefusal,
  parseNodeVersion,
} from '../../scripts/lib/node-runtime-guard.mjs';
export type { NodeCrashRange } from '../../scripts/lib/node-runtime-guard.mjs';
