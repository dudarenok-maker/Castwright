import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* #4576 — the LAN-address suites must not depend on the host. The leak is the
   CWD's `.env`: importing the app runs load-env.ts (`process.loadEnvFile('.env')`),
   so a box whose server/.env sets LAN_HTTPS=1 + LAN_AUTH_TOKEN 401s every
   LAN-address request. Re-run the suite in a child vitest whose CWD holds such
   a .env AND whose parent env carries the same values; test-setup.ts must pin
   them. The child's output is read from a JSON report (colour-proof, and it lets
   us require the LAN block RAN rather than was skipped); on a host with no LAN
   IPv4 that block is skipped by design, so this test skips with it. */

const stripAnsi = (s: string) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
const hasLanIp = Object.values(networkInterfaces())
  .flat()
  .some((i) => i && i.family === 'IPv4' && !i.internal);

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

describe('LAN-address suites are hermetic against the host env (#4576)', () => {
  it('app.health-loopback passes with LAN_HTTPS=1 + LAN_AUTH_TOKEN in the env and in the CWD .env', (ctx) => {
    if (!hasLanIp) ctx.skip('no non-internal IPv4 on this host: the LAN block cannot run');
    const cwd = mkdtempSync(join(tmpdir(), 'cw-hermetic-cwd-'));
    try {
      writeFileSync(join(cwd, '.env'), 'LAN_HTTPS=1\nLAN_AUTH_TOKEN=host-leaked-token\n');
      const reportFile = join(cwd, 'report.json');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LAN_HTTPS: '1',
        LAN_AUTH_TOKEN: 'host-leaked-token',
        NO_COLOR: '1',
      };
      delete env.FORCE_COLOR;
      const res = spawnSync(
        process.execPath,
        [
          vitestBin,
          'run',
          '--root',
          serverRoot,
          '--reporter=json',
          `--outputFile=${reportFile}`,
          'src/app.health-loopback.test.ts',
        ],
        { cwd, env, encoding: 'utf8', timeout: 100_000, windowsHide: true },
      );
      const out = stripAnsi(res.stdout + res.stderr);
      expect(out).not.toMatch(/expected 401 to be 200/);
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
        testResults: { assertionResults: { ancestorTitles: string[]; status: string }[] }[];
      };
      const lan = report.testResults
        .flatMap((f) => f.assertionResults)
        .filter((a) => a.ancestorTitles.some((t) => t.startsWith('from a LAN address')));
      // the LAN block must have RAN and passed, not been skipped
      expect(lan.length).toBeGreaterThan(0);
      expect(lan.every((a) => a.status === 'passed')).toBe(true);
      expect(res.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 110_000);
});
