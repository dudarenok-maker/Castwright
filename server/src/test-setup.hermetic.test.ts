import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
      const tail = (s: string | null) => (s ?? '').slice(-1500);
      // a spawn failure / timeout must say so, not surface as a missing report
      expect(
        res.error,
        `child vitest did not finish (${res.error?.message}; signal ${res.signal}); stdout: ${tail(res.stdout)} stderr: ${tail(res.stderr)}`,
      ).toBeUndefined();
      if (!existsSync(reportFile)) {
        expect.fail(
          `child vitest wrote no report (status ${res.status}); stdout: ${tail(res.stdout)} stderr: ${tail(res.stderr)}`,
        );
      }
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
        testResults: {
          message?: string;
          assertionResults: { title: string; ancestorTitles: string[]; status: string; failureMessages: string[] }[];
        }[];
      };
      const lan = report.testResults
        .flatMap((f) => f.assertionResults)
        .filter((a) => a.ancestorTitles.some((t) => t.startsWith('from a LAN address')));
      // the LAN block must have RAN and passed, not been skipped
      expect(
        lan.length,
        `no LAN-address test ran; file-level: ${report.testResults.map((f) => f.message).join('|')}`,
      ).toBeGreaterThan(0);
      const failing = lan
        .filter((a) => a.status !== 'passed')
        .map((a) => `${a.title} [${a.status}]: ${a.failureMessages[0] ?? ''}`);
      expect(failing).toEqual([]);
      expect(res.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 110_000);
});
