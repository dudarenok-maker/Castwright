import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* #4576 — the LAN-address suites must not depend on the host. The leak is the
   CWD's `.env`: importing the app runs load-env.ts (`process.loadEnvFile('.env')`),
   so a box whose server/.env sets LAN_HTTPS=1 + LAN_AUTH_TOKEN 401s every
   LAN-address request. Re-run the suite in a child vitest whose CWD holds such
   a .env AND whose parent env carries the same values; test-setup.ts must pin
   them. */

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

describe('LAN-address suites are hermetic against the host env (#4576)', () => {
  it('app.health-loopback passes with LAN_HTTPS=1 + LAN_AUTH_TOKEN in the env and in the CWD .env', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cw-hermetic-cwd-'));
    try {
      writeFileSync(join(cwd, '.env'), 'LAN_HTTPS=1\nLAN_AUTH_TOKEN=host-leaked-token\n');
      const res = spawnSync(
        process.execPath,
        [vitestBin, 'run', '--root', serverRoot, 'src/app.health-loopback.test.ts'],
        {
          cwd,
          env: { ...process.env, LAN_HTTPS: '1', LAN_AUTH_TOKEN: 'host-leaked-token' },
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      const out = res.stdout + res.stderr;
      expect(out).not.toMatch(/expected 401 to be 200/);
      expect(out).toMatch(/Tests\s+\d+ passed/);
      expect(res.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 150_000);
});
