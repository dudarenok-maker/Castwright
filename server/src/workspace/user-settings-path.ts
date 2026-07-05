/* Pure path-resolution for the user-settings file location — no other module
   dependencies. Shared by user-settings.ts (the settings store) and
   paths.ts (the boot-time workspace-override read) so paths.ts never needs
   to import the full user-settings.js module. That module already carries a
   wide mocked surface across many existing test files (`vi.mock('.../
   user-settings.js', ...)` with a partial shape), and paths.ts's
   WORKSPACE_ROOT resolution runs unconditionally at module-eval time — any
   dependency it pulls in must resolve even under those tests' partial
   mocks, which a leaf module with nothing to mock never risks. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');

/* Account defaults are USER-scoped, not checkout-scoped — so they live in
   one per-user file OUTSIDE any git checkout. Before plan 122 the file lived
   at `<SERVER_ROOT>/user-settings.json`, which meant every git worktree
   carried its own copy: a save in one tree silently "reverted" when the app
   was next launched from another tree (or the same setting was changed in
   N trees independently). Resolving to a shared `~/.castwright/`
   path makes main, every worktree, and the packaged app read ONE file.

   `USER_SETTINGS_FILE` overrides the location: the server test bootstrap
   points it at a throwaway temp file (so tests never touch real settings),
   and ops can pin a custom path. Exported as a pure function so the
   resolution is unit-testable without re-importing the module. */
export function resolveUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.USER_SETTINGS_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.castwright', 'user-settings.json');
}

export const USER_SETTINGS_PATH = resolveUserSettingsPath();

/* Pre-plan-122 per-checkout location — kept ONLY as the one-time migration
   source so an upgrade carries the user's existing settings forward. */
export const LEGACY_USER_SETTINGS_PATH = join(SERVER_ROOT, 'user-settings.json');
