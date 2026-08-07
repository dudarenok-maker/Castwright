import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #2223 — the /workspace static mount runs on an ALLOWLIST (see app.ts):
   only books/**, voices.json, voices/**, voice-library/** are served; the
   decision is made on the REQUESTED path's REAL, on-disk form
   (realpathSync when it exists), checked for containment in one of those
   roots (also resolved the same way). Two rounds of denylist name-matching
   were tried and both failed against a real request over a real socket —
   an exact-name+suffix check missed an NTFS alternate-data-stream form
   (device-tokens.json::$DATA); widening it to a prefix match still missed
   case-folding (DEVICE-TOKENS.JSON) and a deterministic 8.3 short-name
   alias (DEVICE~1.JSO) — both of which also bypassed the dot-segment rule
   and defeated the "it was never web-reachable" claim about
   .upgrade-backups (a plaintext geminiApiKey copy). The allowlist doesn't
   need to enumerate any of these: device-tokens.json (in any aliased form)
   is simply never under an allowed root.

   Route-level, against the REAL assembled app (real middleware order, real
   static mount) — not a config inspection. */

/** Fetch the raw response bytes (not superagent's `.text`, which is
 *  `undefined` for a non-text content-type like `audio/mpeg`, and can also
 *  be empty/undefined for a body Express never sent) so a marker-presence
 *  or marker-absence assertion is trustworthy either way. */
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

/** Send a raw GET whose request-target bypasses supertest/superagent's OWN
 *  client-side URL normalisation. superagent builds a WHATWG `URL`
 *  internally, which COLLAPSES `.`/`..` segments in the pathname before the
 *  request ever reaches the wire — so `request(app).get('/workspace/books/../.queue.json')`
 *  never actually exercises the SERVER's traversal handling; superagent
 *  silently sends the already-collapsed path, and the test "passes"
 *  regardless of whether the server-side guard does anything at all (a
 *  placebo, per the independent review of an earlier version of this
 *  file). This binds the real app to a REAL port and uses `http.request`'s
 *  raw `path` option, which Node sends verbatim on the wire — no URL-object
 *  normalisation — over an actual socket. */
async function rawSocketGet(expressApp: import('express').Express, rawPath: string): Promise<{ status: number; raw: Buffer }> {
  const server = expressApp.listen(0);
  try {
    if (!server.listening) {
      await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    }
    const port = (server.address() as AddressInfo).port;
    return await new Promise((resolvePromise, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
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

    const { status, raw } = await rawGet(app, '/workspace/device-tokens.json');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('deadbeef');
  });

  it('blocks a rotate-style sibling too (device-tokens.json.bak.1)', async () => {
    writeFileSync(join(dir, 'device-tokens.json.bak.1'), JSON.stringify({ schema: 2, devices: [] }), 'utf8');

    const res = await request(app).get('/workspace/device-tokens.json.bak.1');
    expect(res.status).toBe(404);
  });

  it('blocks an NTFS alternate-data-stream form (device-tokens.json::$DATA) — a confirmed bypass of the first two denylist attempts', async () => {
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'ads-bypass-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/device-tokens.json::$DATA');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('ads-bypass-marker');
  });

  // Independent review, round 2 — CASE. On a case-insensitive filesystem
  // (Windows), a case-sensitive `startsWith` denylist match let this
  // through with a real 200. The literal file is created with THIS EXACT
  // uppercase name (not lowercase) so the test is meaningful on a
  // case-SENSITIVE filesystem too: on Linux, `device-tokens.json` and
  // `DEVICE-TOKENS.JSON` are two different possible files, and only
  // creating the lowercase one would make an uppercase-path test 404 for a
  // reason that has nothing to do with the guard (the file just wouldn't
  // exist) — a placebo that passes on CI and proves nothing about Windows.
  it('blocks an upper-case request against a literally upper-case file (DEVICE-TOKENS.JSON)', async () => {
    writeFileSync(
      join(dir, 'DEVICE-TOKENS.JSON'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'case-bypass-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/DEVICE-TOKENS.JSON');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('case-bypass-marker');
  });

  it('blocks a mixed-case request against a literally mixed-case file (Device-Tokens.json)', async () => {
    writeFileSync(
      join(dir, 'Device-Tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'mixedcase-bypass-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/Device-Tokens.json');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('mixedcase-bypass-marker');
  });

  // Independent review, round 2 — 8.3 SHORT NAMES. On this box's C: volume,
  // 8.3 generation is live and deterministic (DEVICE~1.JSO), and it has NO
  // leading dot, so it bypassed both the case-sensitive denylist AND the
  // dot-segment rule. The fixture is a LITERAL file named `DEVICE~1.JSO`
  // (not a real OS-generated short-name alias of device-tokens.json) — this
  // repo's test box may or may not have 8.3 generation enabled on every
  // volume, and deriving the real alias needs a Windows-specific syscall
  // this test shouldn't depend on. A literal fixture proves the guard
  // denies ANY file living directly at the workspace root regardless of its
  // name shape, which is the actual property that needs to hold, on every
  // platform this suite runs on.
  it('blocks a literal 8.3-shaped name at the workspace root (DEVICE~1.JSO)', async () => {
    writeFileSync(join(dir, 'DEVICE~1.JSO'), JSON.stringify({ marker: '8dot3-bypass-marker' }), 'utf8');

    const { status, raw } = await rawGet(app, '/workspace/DEVICE~1.JSO');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('8dot3-bypass-marker');
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

describe('/workspace static mount — allowlist covers workspace internals (#2223, independent review)', () => {
  // THE finding: the boot-time upgrade coordinator (upgrade-coordinator.ts)
  // copies user-settings.json — which stores geminiApiKey in PLAINTEXT —
  // into <WORKSPACE_ROOT>/.upgrade-backups/from-<old>-to-<new>-<stamp>/ on
  // every version bump. A live, directly-usable third-party API key, not a
  // one-way hash.
  it('blocks .upgrade-backups, long form (a plaintext geminiApiKey lives inside a real one)', async () => {
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

  // The exact mechanism that reversed the "never web-reachable" claim: an
  // 8.3-shaped path has no leading dot at all, so a dot-segment rule (and
  // send's own dotfiles:'ignore' default) never sees anything to object to.
  // Literal fixture, same reasoning as the device-tokens.json 8.3 test above.
  it('blocks .upgrade-backups, 8.3-shaped literal short form (no leading dot — the actual bypass mechanism)', async () => {
    const shortBackupDir = join(dir, 'UPGRAD~1', 'FROM-1~1.0-2');
    mkdirSync(shortBackupDir, { recursive: true });
    writeFileSync(
      join(shortBackupDir, 'USER-S~1.JSO'),
      JSON.stringify({ geminiApiKey: 'AIzaSy-FAKE-MARKER-KEY-SHORTFORM-000000000' }),
      'utf8',
    );

    const { status, raw } = await rawGet(app, '/workspace/UPGRAD~1/FROM-1~1.0-2/USER-S~1.JSO');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('AIzaSy-FAKE-MARKER-KEY-SHORTFORM-000000000');
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

  // Traversal, over a REAL raw socket — see rawSocketGet's own doc comment
  // for why a supertest-based version of this test is a placebo (superagent
  // collapses `..` client-side before the request is ever sent).
  it('blocks a raw-socket traversal path that resolves into a dot-prefixed root (books/../.queue.json)', async () => {
    mkdirSync(join(dir, 'books'), { recursive: true });
    writeFileSync(join(dir, '.queue.json'), JSON.stringify({ marker: 'traversal-marker' }), 'utf8');

    const { status, raw } = await rawSocketGet(app, '/workspace/books/../.queue.json');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('traversal-marker');
  });

  // Traversal into device-tokens.json specifically, over a raw socket —
  // proves the allowlist (not the dot-segment pre-filter) is what closes
  // this, since device-tokens.json is not dot-prefixed at all.
  it('blocks a raw-socket traversal path into device-tokens.json (voices/../device-tokens.json)', async () => {
    mkdirSync(join(dir, 'voices'), { recursive: true });
    writeFileSync(
      join(dir, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [{ id: 'd1', label: 'Phone', tokenHash: 'traversal-devicetoken-marker', createdAt: new Date().toISOString() }] }),
      'utf8',
    );

    const { status, raw } = await rawSocketGet(app, '/workspace/voices/../device-tokens.json');
    expect(status).toBe(404);
    expect(raw?.toString('utf8') ?? '').not.toContain('traversal-devicetoken-marker');
  });

  // Positive controls — these matter MORE than usual here: a guard that
  // broke the whole mount (not just its intended targets) would also pass
  // every block test above, since 404-on-everything looks identical to
  // 404-on-the-right-things from the outside. Uses rawGet, not `.text`:
  // superagent leaves `.text` undefined for a binary content-type like
  // audio/mpeg.
  it('a normal books/<id>/… asset still serves correctly (the legitimate content this mount exists for)', async () => {
    const bookDir = join(dir, 'books', 'Some Author', 'Standalones', 'Some Book');
    mkdirSync(bookDir, { recursive: true });
    writeFileSync(join(bookDir, 'chapter-1.mp3'), 'not-really-audio-but-a-real-file', 'utf8');

    const { status, raw } = await rawGet(app, '/workspace/books/Some%20Author/Standalones/Some%20Book/chapter-1.mp3');
    expect(status).toBe(200);
    expect(raw?.toString('utf8')).toBe('not-really-audio-but-a-real-file');
  });

  it('voices.json still serves', async () => {
    writeFileSync(join(dir, 'voices.json'), JSON.stringify({ pinned: ['x'] }), 'utf8');

    const res = await request(app).get('/workspace/voices.json');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ pinned: ['x'] });
  });

  it('voice-library/<uuid>/voice.json still serves', async () => {
    const entryDir = join(dir, 'voice-library', 'abc-123-uuid');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'voice.json'), JSON.stringify({ voiceUuid: 'abc-123-uuid', provenance: 'designed' }), 'utf8');

    const res = await request(app).get('/workspace/voice-library/abc-123-uuid/voice.json');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ voiceUuid: 'abc-123-uuid', provenance: 'designed' });
  });
});
