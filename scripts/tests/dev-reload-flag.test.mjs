/* #4054 — the sidecar's parent watcher is OFF under `npm run dev` so a `tsx
   watch` reload keeps the sidecar and its models. The signal is explicit:
   the root dev scripts set CASTWRIGHT_DEV_RELOAD=1 (see buildSidecarEnv).
   `dev:server` — what `npm start` runs on Windows, where the silent server
   deaths happened — must NOT set it, or that path loses the watcher. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = JSON.parse(readFileSync(join(resolve(here, '..', '..'), 'package.json'), 'utf8')).scripts;

for (const name of ['dev', 'dev:mock', 'dev:lan']) {
  test(`${name} sets CASTWRIGHT_DEV_RELOAD=1`, () => {
    assert.match(scripts[name], /cross-env\b[^"]*\bCASTWRIGHT_DEV_RELOAD=1\b/);
  });
}

test('dev:server and server dev do not set CASTWRIGHT_DEV_RELOAD (npm start stays covered)', () => {
  assert.doesNotMatch(scripts['dev:server'], /CASTWRIGHT_DEV_RELOAD/);
  const serverScripts = JSON.parse(
    readFileSync(join(resolve(here, '..', '..'), 'server', 'package.json'), 'utf8'),
  ).scripts;
  assert.doesNotMatch(serverScripts.dev, /CASTWRIGHT_DEV_RELOAD/);
});
