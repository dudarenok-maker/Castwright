// scripts/tests/playwright-port.test.mjs — pins scripts/lib/playwright-port.mjs
// (#4207): playwright.config.ts must honour the PLAYWRIGHT_PORT that
// scripts/wt-new.mjs writes into a worktree's .env.local, with an explicit env
// var still winning and 5174 as the no-file default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePlaywrightPort } from '../lib/playwright-port.mjs';

function withDir(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-port-'));
  try {
    if (body !== null) writeFileSync(join(dir, '.env.local'), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reads PLAYWRIGHT_PORT from .env.local', () => {
  withDir('# c\nVITE_PORT=5363\nPLAYWRIGHT_PORT=5364\n', (dir) => {
    assert.equal(resolvePlaywrightPort(dir, {}), 5364);
  });
});

test('an explicit env var wins over .env.local', () => {
  withDir('PLAYWRIGHT_PORT=5364\n', (dir) => {
    assert.equal(resolvePlaywrightPort(dir, { PLAYWRIGHT_PORT: '6000' }), 6000);
  });
});

test('no .env.local falls back to 5174', () => {
  withDir(null, (dir) => {
    assert.equal(resolvePlaywrightPort(dir, {}), 5174);
  });
});

test('.env.local without PLAYWRIGHT_PORT falls back to 5174', () => {
  withDir('VITE_PORT=5363\n', (dir) => {
    assert.equal(resolvePlaywrightPort(dir, {}), 5174);
  });
});

for (const bad of ['', '  ', 'abc', '0', '70000']) {
  test(`an invalid env value ${JSON.stringify(bad)} throws naming the source`, () => {
    assert.throws(
      () => resolvePlaywrightPort(tmpdir(), { PLAYWRIGHT_PORT: bad }),
      (e) => /environment variable/.test(e.message) && e.message.includes(JSON.stringify(bad)),
    );
  });
}

test('an invalid .env.local value throws naming the file', () => {
  withDir('PLAYWRIGHT_PORT=\n', (dir) => {
    assert.throws(
      () => resolvePlaywrightPort(dir, {}),
      (e) => e.message.includes(join(dir, '.env.local')) && e.message.includes('""'),
    );
  });
});

// The config itself, not just the helper: load a COPY of playwright.config.ts
// from dir A while running Playwright from dir B (each with its own
// .env.local) and assert the webServer carries A's port. Red if the config
// reads process.cwd() (B) or ignores .env.local altogether (5174).
test('playwright.config.ts resolves the port from its own directory, not the cwd', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const a = mkdtempSync(join(tmpdir(), 'pw-cfg-a-'));
  const b = mkdtempSync(join(tmpdir(), 'pw-cfg-b-'));
  try {
    mkdirSync(join(a, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(a, 'e2e'));
    copyFileSync(join(repo, 'playwright.config.ts'), join(a, 'playwright.config.ts'));
    copyFileSync(
      join(repo, 'scripts', 'lib', 'playwright-port.mjs'),
      join(a, 'scripts', 'lib', 'playwright-port.mjs'),
    );
    writeFileSync(join(a, 'e2e', 'global-teardown.ts'), 'export default async () => {};\n');
    // Pin the copy to CommonJS: with no package.json of its own it inherits
    // the nearest one above os.tmpdir(), and a {"type":"module"} there loads
    // it as ESM, which ignores NODE_PATH.
    writeFileSync(join(a, 'package.json'), '{"type":"commonjs"}\n');
    writeFileSync(join(a, '.env.local'), 'PLAYWRIGHT_PORT=5391\n');
    writeFileSync(join(b, '.env.local'), 'PLAYWRIGHT_PORT=5392\n');
    const env = { ...process.env, NODE_PATH: join(repo, 'node_modules') };
    delete env.PLAYWRIGHT_PORT;
    const r = spawnSync(
      process.execPath,
      [
        join(repo, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--list',
        '--reporter=json',
        '-c',
        join(a, 'playwright.config.ts'),
      ],
      { cwd: b, env, encoding: 'utf8', windowsHide: true },
    );
    let config;
    try {
      config = JSON.parse(r.stdout).config;
    } catch (e) {
      assert.fail(
        `playwright --list output was not JSON (${e.message})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }
    assert.match(config.webServer.url, /:5391$/);
    assert.match(config.webServer.command, /--port 5391\b/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
