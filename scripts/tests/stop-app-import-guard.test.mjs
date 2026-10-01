// scripts/tests/stop-app-import-guard.test.mjs — PR #3404 review pass 3, yellow A.
//
// Importing stop-app.mjs must NOT stop or sweep anything: main() is guarded
// behind an invoked-directly check (mirrors start-app-prod.mjs). This lives in
// its OWN file, and never statically imports stop-app.mjs, on purpose: when it
// sat inside stop-app.test.mjs, the guard's mutant (a bare `main();`) ran
// main() inside the test runner's own import of that file — with no
// server/.env (every CI checkout) main() reached process.exit(0)
// synchronously, so `node --test` reported the file as one passing test and
// the guard test never even registered.
//
// A POSITIVE control is required, not just "no stdout" — an empty .run/ dir
// would print nothing from a correctly-guarded import AND from an unguarded
// one that ran main() and found nothing to do. Instead: plant a `server.pid`
// holding the pid of a child that has just exited (really dead — a made-up
// large pid can alias a live one, Windows ignores a pid's low two bits).
// With the guard intact, importing touches nothing: no stdout, and the pidfile
// survives (main() always rmSync's the pidfile it processes). Without it,
// main() reads the pidfile, deletes it, classifies the pid 'gone' and prints
// `[GONE] server pid=<pid> (already exited)`.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('importing stop-app.mjs does not invoke main() (positive control: a dead-pid pidfile stays untouched)', () => {
  const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const runDir = mkdtempSync(join(tmpdir(), 'stop-app-guard-'));
  writeFileSync(join(runDir, 'server.pid'), String(deadPid), 'utf8');
  try {
    const moduleUrl = pathToFileURL(resolve(__dirname, '..', 'stop-app.mjs')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)});`],
      {
        cwd: resolve(__dirname, '..', '..'),
        env: { ...process.env, APP_RUN_DIR: runDir },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, `import should not throw/exit nonzero: ${result.stderr}`);
    assert.equal(result.stdout, '', 'importing the module must not run main() or print anything');
    assert.ok(
      existsSync(join(runDir, 'server.pid')),
      'main() removes the pidfile it processes — it surviving proves main() never ran',
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
