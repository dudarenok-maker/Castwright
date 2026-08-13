/* Guards issue #2343's mock-dev-mode wiring: `.env.development` deliberately
   sets VITE_USE_MOCKS=false (since 6b4b2e51, the real local analysis server
   commit), which left no hand-runnable command that reaches mock mode. The
   fix adds `.env.mock` + `dev:mock` / `dev:frontend:mock` npm scripts. This
   test fails if any of the three pieces silently drift apart again:

     - `.env.mock` goes missing or stops setting VITE_USE_MOCKS=true,
     - `.env.development` stops setting VITE_USE_MOCKS=false (the invariant
       the whole issue is about — mocks must NOT be the `npm run dev` default),
     - the `dev:mock` / `dev:frontend:mock` package.json scripts go missing or
       stop passing `--mode mock` to vite (which is what makes Vite load
       `.env.mock` per its `.env.[mode]` precedence rule). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function readEnvFile(name) {
  return readFileSync(join(repoRoot, name), 'utf8');
}

test('.env.mock exists and sets VITE_USE_MOCKS=true', () => {
  const contents = readEnvFile('.env.mock');
  assert.match(
    contents,
    /^VITE_USE_MOCKS=true\s*$/m,
    '.env.mock must set VITE_USE_MOCKS=true so `vite --mode mock` boots the app in mock mode',
  );
});

test('.env.development still sets VITE_USE_MOCKS=false (the invariant #2343 is about)', () => {
  const contents = readEnvFile('.env.development');
  assert.match(
    contents,
    /^VITE_USE_MOCKS=false\s*$/m,
    '.env.development must keep VITE_USE_MOCKS=false — `npm run dev` drives the real backend, deliberately, since 6b4b2e51',
  );
});

test('package.json defines dev:mock and dev:frontend:mock scripts wired to --mode mock', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};

  assert.ok('dev:frontend:mock' in scripts, 'package.json is missing the "dev:frontend:mock" script');
  assert.match(
    scripts['dev:frontend:mock'],
    /--mode mock\b/,
    '"dev:frontend:mock" must invoke vite with --mode mock so it loads .env.mock',
  );

  assert.ok('dev:mock' in scripts, 'package.json is missing the "dev:mock" script');
  assert.match(
    scripts['dev:mock'],
    /npm:dev:frontend:mock/,
    '"dev:mock" must run the frontend via "npm:dev:frontend:mock" (mirrors "dev" running "npm:dev:frontend")',
  );
  assert.match(
    scripts['dev:mock'],
    /npm:dev:server\b/,
    '"dev:mock" must also run "npm:dev:server" — several components fetch(\'/api/...\') directly and 502 without a server (see #2344)',
  );
});
