/* Server test bootstrap (vitest `setupFiles`). Runs before any test module
   imports — so it lands before user-settings.ts computes USER_SETTINGS_PATH
   at module-eval time.

   Plan 122 moved user settings to a shared ~/.audiobook-generator file. We
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
