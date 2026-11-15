// scripts/tests/playwright-port.test.mjs — pins scripts/lib/playwright-port.mjs
// (#4207): playwright.config.ts must honour the PLAYWRIGHT_PORT that
// scripts/wt-new.mjs writes into a worktree's .env.local, with an explicit env
// var still winning and 5174 as the no-file default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
