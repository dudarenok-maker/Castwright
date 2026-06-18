import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let app: import('express').Express;
let createPairingSession: typeof import('../workspace/pairing-sessions.js').createPairingSession;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-lan-int-'));
  process.env.WORKSPACE_DIR = dir;
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  process.env.LAN_HTTPS_PORT = '8443';
  vi.resetModules();
  ({ createPairingSession } = await import('../workspace/pairing-sessions.js'));
  ({ app } = await import('../app.js')); // the assembled Express app (real guard + csrf + redeem-browser)
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.LAN_AUTH_TOKEN;
  delete process.env.LAN_HTTPS;
  rmSync(dir, { recursive: true, force: true });
});

describe('LAN cookie integration', () => {
  it('a redeem-browser cookie authorizes a subsequent guarded GET from a LAN IP', async () => {
    const { code } = createPairingSession('Phone', undefined, 10);
    const redeem = await request(app).post('/api/pair/redeem-browser').send({ code });
    expect(redeem.status).toBe(201);
    const cookie = redeem.headers['set-cookie'];
    // From a NON-loopback IP the guard would 401 without the cookie; with it, it passes.
    const guarded = await request(app).get('/api/library')
      .set('Cookie', cookie).set('X-Forwarded-For', '10.0.0.9');
    expect(guarded.status).not.toBe(401);
  });

  it('a cookie-bearing write with a foreign Origin is 403 (CSRF)', async () => {
    const { code } = createPairingSession('Phone', undefined, 10);
    const cookie = (await request(app).post('/api/pair/redeem-browser').send({ code })).headers['set-cookie'];
    const res = await request(app).post('/api/devices') // a guarded state-changing route
      .set('Cookie', cookie).set('Origin', 'https://evil.example:8443').send({ label: 'x' });
    expect(res.status).toBe(403);
  });
});
