/* Server test bootstrap (vitest `setupFiles`). Runs before any test module
   imports — so it lands before user-settings.ts computes USER_SETTINGS_PATH
   at module-eval time.

   Plan 122 moved user settings to a shared ~/.castwright file. We
   redirect that to a throwaway temp file for the whole test run so a suite
   never reads or MUTATES the developer's real settings — a round-trip test
   that crashes between its write and its restore must not be able to corrupt
   them. `??=` respects an explicit override a dev/CI may already have set. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.USER_SETTINGS_FILE ??= join(
  mkdtempSync(join(tmpdir(), 'audiobook-settings-')),
  'user-settings.json',
);

/* #4576 — pin the LAN auth switches. importing the app pulls in load-env.ts,
   which runs `process.loadEnvFile('.env')` against the CWD; on a box whose
   server/.env carries LAN_HTTPS=1 + LAN_AUTH_TOKEN every LAN-address request
   in the suites 401s, while CI (no .env) stays green. loadEnvFile never
   overrides a variable that is already set, so a pinned value beats the file —
   deleting would not (it would be re-populated). `0` is what an unset value
   means outside production; an empty token is "no token" (getLanAuthToken).
   A suite that wants LAN mode sets its own value. */
process.env.LAN_HTTPS = '0';
process.env.LAN_AUTH_TOKEN = '';
