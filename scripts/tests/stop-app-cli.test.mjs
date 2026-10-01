// scripts/tests/stop-app-cli.test.mjs — PR #3404 review pass 4, yellow A.
//
// stop-app.mjs's main() is injectable (kill/log/probe/runDirPath/exit), so
// every other main() test supplies all of them and the SHIPPED defaults —
// the real taskkill/SIGTERM kill, the real stdout log, the real TCP probe,
// the module-level runDir — were pinned by nothing. This spawns the real CLI
// (`node scripts/stop-app.mjs`, no injection) against:
//   - APP_RUN_DIR holding `server.pid` = a live child's pid  -> real kill + real log
//   - a `tts.owner.<port>.json` note + a listening socket on that port
//     -> real probe, and the still-listening [WARN] + OK suppression.
// The owner note (not PORT/server/.env) keeps this deterministic on a CI
// checkout with no server/.env.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidIsAlive } from '../lib/pid-alive.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('stop-app.mjs CLI defaults: really kills the recorded pid, logs it, and probes the owner-note port', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((r) => child.once('exit', r));
  const listener = net.createServer((s) => s.destroy());
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  const runDir = mkdtempSync(join(tmpdir(), 'stop-app-cli-'));
  writeFileSync(join(runDir, 'server.pid'), String(child.pid), 'utf8');
  writeFileSync(join(runDir, `tts.owner.${port}.json`), JSON.stringify({ port }), 'utf8');
  try {
    // Async spawn: the listener lives in THIS process, so a sync spawn would
    // block the event loop that has to accept the CLI's probe connection.
    const cli = spawn(process.execPath, ['scripts/stop-app.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, APP_RUN_DIR: runDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    cli.stdout.on('data', (d) => (stdout += d));
    const status = await new Promise((r) => cli.once('exit', r));
    assert.equal(status, 0);

    assert.match(stdout, new RegExp(`\\[STOP\\] server pid=${child.pid}\\b`), `real kill + real log: ${stdout}`);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    assert.equal(pidIsAlive(child.pid), false, 'the default kill must really kill the recorded pid');
    assert.equal(existsSync(join(runDir, 'server.pid')), false, 'runDirPath default: the pidfile in APP_RUN_DIR was consumed');
    assert.match(stdout, new RegExp(`\\[WARN\\] still listening on :${port}\\b`), `real probe + still-listening push: ${stdout}`);
    assert.doesNotMatch(stdout, /\[OK\]/, 'a still-listening port must suppress the OK summary');
  } finally {
    if (pidIsAlive(child.pid)) spawnSync(process.execPath, ['-e', `process.kill(${child.pid})`], { windowsHide: true });
    listener.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});
