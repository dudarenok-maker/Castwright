import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #2223 — device-tokens.json (and any device-tokens.json.* sibling) must
   never reach the /workspace static mount: it holds every paired device's
   tokenHash, and the whole point of a per-device token is that one
   compromised device shouldn't expose every other device's credential
   material. Route-level, against the REAL assembled app (real middleware
   order, real static mount) — not a config inspection. */

/** Fetch the raw response bytes (not superagent's `.text`, which can be
 *  empty/undefined for a body Express never sent, or miss content on a
 *  non-text content-type) so a marker-absence assertion is trustworthy
 *  either way. Used by the suffix-form tests below — one of them (an NTFS
 *  alternate-data-stream path) was empirically confirmed to return a real
 *  200 with the full file body under the pre-hardening guard, so "the
 *  marker isn't in `.text`" alone would not have been convincing evidence
 *  of anything. */
async function rawGet(app: import('express').Express, path: string): Promise<{ status: number; raw: Buffer }> {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((response, cb) => {
      const chunks: Buffer[] = [];
      response.on('data', (c: Buffer) => chunks.push(c));
      response.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, raw: res.body as Buffer };
}

let dir: string;
let app: import('express').Express;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-workspace-static-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  ({ app } = await import('./app.js'));
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('/workspace static mount — device-tokens.json guard (#2223)', () => {
  it('GET /workspace/device-tokens.json does not return the file', async () => {
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'deadbeef', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const res = await request(app).get('/workspace/device-tokens.json');
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain('deadbeef');
  });

  it('blocks a rotate-style sibling too (device-tokens.json.bak.1), by construction not by name', async () => {
    writeFileSync(join(dir, 'device-tokens.json.bak.1'), JSON.stringify({ schema: 2, devices: [] }), 'utf8');

    const res = await request(app).get('/workspace/device-tokens.json.bak.1');
    expect(res.status).toBe(404);
  });

  // Independent-review follow-up: the guard originally matched
  // `base === 'device-tokens.json' || base.startsWith('device-tokens.json.')`
  // (WITH a trailing dot). Empirically confirmed against the real assembled
  // app on this Windows box: `device-tokens.json::$DATA` (an NTFS
  // alternate-data-stream form addressing the SAME file's bytes) does NOT
  // start with `device-tokens.json.` — the character after the base name is
  // `:`, not `.` — so it sailed past that guard and `express.static`
  // resolved it anyway, returning 200 with the FULL device-tokens.json body.
  // A genuine Windows bypass, not a hypothetical. The guard now matches
  // `base.startsWith('device-tokens.json')` with NO trailing dot, which
  // subsumes every suffix form including this one.
  it('blocks an NTFS alternate-data-stream form (device-tokens.json::$DATA) — a confirmed bypass of the trailing-dot match', async () => {
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'ads-bypass-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/device-tokens.json::$DATA');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('ads-bypass-marker');
  });

  it('blocks a second ADS form too (device-tokens.json:somestream)', async () => {
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'ads-bypass-marker-2', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/device-tokens.json:somestream');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('ads-bypass-marker-2');
  });

  it('blocks a Win32 trailing-dot form (device-tokens.json.)', async () => {
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'trailing-dot-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/device-tokens.json.');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('trailing-dot-marker');
  });

  // Positive control — without this, a mutation that breaks the WHOLE
  // /workspace mount (not just the one file) would also make the test above
  // pass, since a 404 on everything looks identical to a 404 on one file.
  it('a normal workspace asset still serves correctly through the same mount', async () => {
    writeFileSync(join(dir, 'voices.json'), JSON.stringify({ pinned: [] }), 'utf8');

    const res = await request(app).get('/workspace/voices.json');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ pinned: [] });
  });
});

describe('/workspace static mount — dot-prefixed internals guard (#2223, independent review)', () => {
  // THE finding: the boot-time upgrade coordinator (upgrade-coordinator.ts)
  // copies user-settings.json — which stores geminiApiKey in PLAINTEXT —
  // into <WORKSPACE_ROOT>/.upgrade-backups/from-<old>-to-<new>-<stamp>/
  // on every version bump. That directory sits inside WORKSPACE_ROOT and
  // was reachable through this same static mount, with no filename-list
  // entry for it: a live, directly-usable third-party API key, not a
  // one-way hash. This is the case the "internals are not served; content
  // is" rule exists for — it closes this AND whatever the next internal
  // file turns out to be, by construction rather than by someone adding
  // another name to a list.
  it('blocks .upgrade-backups (a plaintext geminiApiKey lives inside a real one)', async () => {
    const backupDir = join(dir, '.upgrade-backups', 'from-1.0.0-to-1.1.0-20260101-000000-000Z');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, 'user-settings.json'),
      JSON.stringify({ geminiApiKey: 'AIzaSy-FAKE-MARKER-KEY-DO-NOT-USE-000000000' }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/.upgrade-backups/from-1.0.0-to-1.1.0-20260101-000000-000Z/user-settings.json');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('AIzaSy-FAKE-MARKER-KEY-DO-NOT-USE-000000000');
  });

  it('blocks .backups (per-book state.json snapshot history)', async () => {
    const backupDir = join(dir, '.backups', 'some-book-id');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, '20260101-000000.json'), JSON.stringify({ marker: 'backups-marker' }), 'utf8');

    const res = await request(app).get('/workspace/.backups/some-book-id/20260101-000000.json');
    expect(res.status).toBe(404);
  });

  it('blocks .telemetry (resource-telemetry.jsonl)', async () => {
    mkdirSync(join(dir, '.telemetry'), { recursive: true });
    writeFileSync(join(dir, '.telemetry', 'resource-telemetry.jsonl'), '{"marker":"telemetry-marker"}\n', 'utf8');

    const res = await request(app).get('/workspace/.telemetry/resource-telemetry.jsonl');
    expect(res.status).toBe(404);
  });

  it('blocks .queue.json (the top-level file, not just a directory)', async () => {
    writeFileSync(join(dir, '.queue.json'), JSON.stringify({ marker: 'queue-marker' }), 'utf8');

    const res = await request(app).get('/workspace/.queue.json');
    expect(res.status).toBe(404);
  });

  // Traversal: a legitimate-looking prefix that resolves (after ../) into a
  // dot-prefixed root must be caught the same as hitting that root directly
  // — the guard normalises the path before checking the first segment.
  it('blocks a traversal path that resolves into a dot-prefixed root (books/../.queue.json)', async () => {
    mkdirSync(join(dir, 'books'), { recursive: true });
    writeFileSync(join(dir, '.queue.json'), JSON.stringify({ marker: 'traversal-marker' }), 'utf8');

    const res = await request(app).get('/workspace/books/../.queue.json');
    expect(res.status).toBe(404);
  });

  // Positive controls — these matter MORE than usual here: a guard that
  // broke the whole mount (not just its intended targets) would also pass
  // every block test above, since 404-on-everything looks identical to
  // 404-on-the-right-things from the outside.
  it('a normal books/<id>/… asset still serves correctly (the legitimate content this mount exists for)', async () => {
    const bookDir = join(dir, 'books', 'Some Author', 'Standalones', 'Some Book');
    mkdirSync(bookDir, { recursive: true });
    writeFileSync(join(bookDir, 'chapter-1.mp3'), 'not-really-audio-but-a-real-file', 'utf8');

    // Uses rawGet, not `.text` — the file is served as `audio/mpeg` (by
    // extension), and superagent only populates `.text` for text-parseable
    // content-types, leaving it `undefined` for anything else. That made
    // this positive control fail even though the guard was correctly
    // serving the file with the right bytes: a broken fixture, not an
    // over-blocking guard (confirmed via a temporary probe — status 200,
    // content-type audio/mpeg, and the raw body byte-for-byte correct).
    const { status, raw } = await rawGet(app, '/workspace/books/Some%20Author/Standalones/Some%20Book/chapter-1.mp3');
    expect(status).toBe(200);
    expect(raw.toString('utf8')).toBe('not-really-audio-but-a-real-file');
  });

  it('a filename with a dot inside it (not as a segment prefix) still serves — voices.json again, explicitly under this describe block', async () => {
    writeFileSync(join(dir, 'voices.json'), JSON.stringify({ pinned: ['x'] }), 'utf8');

    const res = await request(app).get('/workspace/voices.json');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ pinned: ['x'] });
  });
});
