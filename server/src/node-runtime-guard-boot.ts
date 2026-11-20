/* #4443 — side-effect module: imported FIRST by index.ts so a known-bad Node
   on Windows is refused before anything else loads. A missing or unreadable
   package.json must never stop the app, so a load failure only warns and the
   server continues. No override switch (owner decision 2026-11-20). */

import { loadCrashRanges, nodeRuntimeRefusal } from './node-runtime-guard.js';

try {
  const message = nodeRuntimeRefusal(process.version, process.platform, loadCrashRanges());
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
} catch (err) {
  console.warn(
    `[node-runtime-guard] could not read the Node range list, continuing: ${err instanceof Error ? err.message : String(err)}`,
  );
}
