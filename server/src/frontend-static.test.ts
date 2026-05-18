/* Plan 49 — unit coverage for mountFrontendStatic().

   Asserts:
     1. With a real index.html on disk, GET / returns the file as text/html.
     2. With a real index.html, /api/health is NOT shadowed by the static
        middleware (the API still routes through).
     3. With NODE_ENV !== production AND no index.html on disk, the function
        is a no-op (mounted=false, reason names the dev-mode skip).
     4. With NODE_ENV=production but no index.html, the function still
        skips and the reason names the missing build artefact. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { mountFrontendStatic } from './frontend-static.js';

let tempRoot: string;
let distDir: string;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'frontend-static-test-'));
  distDir = resolve(tempRoot, 'dist');
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

function buildApp(): Express {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true, where: 'api' }));
  mountFrontendStatic(app, distDir);
  return app;
}

describe('mountFrontendStatic', () => {
  it('serves dist/index.html on GET / when the file exists', async () => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, 'index.html'), '<!doctype html><title>built</title>');

    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('built');
  });

  it('does NOT shadow /api/* routes even when dist is mounted', async () => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, 'index.html'), '<html />');

    const app = buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.where).toBe('api');
  });

  it('returns mounted=false in dev mode with no dist on disk', () => {
    delete process.env.NODE_ENV;
    const app = express();
    const result = mountFrontendStatic(app, distDir);
    expect(result.mounted).toBe(false);
    expect(result.reason).toMatch(/dev-mode/);
  });

  it('returns mounted=false in production mode when dist/index.html is missing', () => {
    process.env.NODE_ENV = 'production';
    const app = express();
    const result = mountFrontendStatic(app, distDir);
    expect(result.mounted).toBe(false);
    expect(result.reason).toMatch(/index\.html is missing/);
  });

  it('mounts in production mode even if index.html shows up later — semantics depend on disk at call time', () => {
    process.env.NODE_ENV = 'production';
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, 'index.html'), '<html />');
    const app = express();
    const result = mountFrontendStatic(app, distDir);
    expect(result.mounted).toBe(true);
    expect(result.reason).toMatch(/dist\/index\.html present/);
  });
});
