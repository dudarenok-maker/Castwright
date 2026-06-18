/* Integration test for the user-settings route.

   Asserts:
     1. GET seeds defaults on first call (no file on disk).
     2. PUT persists a partial patch and the merged shape comes back.
     3. PUT drops secret-shaped fields (geminiApiKey, apiKey, etc.) —
        nothing reaches user-settings.json.
     4. GET reports apiKeyStatus='set' iff GEMINI_API_KEY is present.
     5. Read-only fields (apiKeyStatus, workspaceRoot, workspaceSource)
        submitted in PUT are ignored, not stored, not echoed verbatim. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

type SettingsModule = typeof import('../workspace/user-settings.js');

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;
let userSettingsSchema: SettingsModule['userSettingsSchema'];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-user-settings-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.GEMINI_API_KEY;

  const [{ userSettingsRouter }, settings] = await Promise.all([
    import('./user-settings.js'),
    import('../workspace/user-settings.js'),
  ]);

  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;
  userSettingsSchema = settings.userSettingsSchema;

  app = express();
  app.use(express.json());
  app.use('/api/user/settings', userSettingsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.GEMINI_API_KEY;
});

beforeEach(() => {
  /* Wipe the user-settings.json between tests so each starts fresh. The
     route's first GET will recreate it from defaults. */
  if (userSettingsPath && existsSync(userSettingsPath)) {
    rmSync(userSettingsPath, { force: true });
  }
  resetCache();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEN_WORKERS;
});

describe('user-settings router', () => {
  it('GET returns built-in defaults when no file exists', async () => {
    const res = await request(app).get('/api/user/settings');
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Castwright');
    /* Default flipped to Gemini (was qwen3.5:4b). The analysis-model
       and analysis-engine defaults must travel together so a fresh
       install routes the first analysis through the Gemini API rather
       than asking the user to `ollama pull` something first. */
    expect(res.body.defaultAnalysisModel).toBe('gemini-3.1-flash-lite');
    expect(res.body.analysisEngine).toBe('gemini');
    expect(res.body.defaultTtsEngine).toBe('local');
    expect(res.body.defaultTtsModelKey).toBe('kokoro-v1');
    expect(res.body.sidecarUrl).toBe('http://localhost:9000');
    expect(res.body.workspaceDirOverride).toBeNull();
    /* Minor-cast fold default — see server/src/analyzer/fold-minor-cast.ts. */
    expect(res.body.minorCastMinLines).toBe(3);
  });

  it('GET reflects the GEN_WORKERS env override in generationWorkers (deploy knob reaches the client)', async () => {
    /* The client queue-dispatcher reads `account.generationWorkers` from this
       response to cap concurrency. Without the env overlay the GEN_WORKERS
       deploy knob never reached it. */
    const def = await request(app).get('/api/user/settings');
    expect(def.body.generationWorkers).toBe(1); // no env → on-disk/default

    process.env.GEN_WORKERS = '1';
    resetCache();
    const withEnv = await request(app).get('/api/user/settings');
    expect(withEnv.body.generationWorkers).toBe(1); // env wins → dispatcher caps at 1

    delete process.env.GEN_WORKERS;
  });

  it('PUT round-trips minorCastMinLines and rejects out-of-range values', async () => {
    /* Happy path — explicit override persists. */
    const ok = await request(app).put('/api/user/settings').send({ minorCastMinLines: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body.minorCastMinLines).toBe(5);
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.minorCastMinLines).toBe(5);

    /* 0 disables the line-count trigger entirely (still a valid setting). */
    const zero = await request(app).put('/api/user/settings').send({ minorCastMinLines: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.minorCastMinLines).toBe(0);

    /* Negative is out of schema range. */
    const neg = await request(app).put('/api/user/settings').send({ minorCastMinLines: -1 });
    expect(neg.status).toBe(400);

    /* > 50 cap. */
    const big = await request(app).put('/api/user/settings').send({ minorCastMinLines: 51 });
    expect(big.status).toBe(400);
  });

  it('PUT persists a partial patch and merges into the on-disk file', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ displayName: 'Test User', defaultAnalysisModel: 'gemini-2.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Test User');
    expect(res.body.defaultAnalysisModel).toBe('gemini-2.5-flash');
    // Untouched defaults survive the merge.
    expect(res.body.sidecarUrl).toBe('http://localhost:9000');

    // On disk
    expect(existsSync(userSettingsPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.displayName).toBe('Test User');
    expect(onDisk.defaultAnalysisModel).toBe('gemini-2.5-flash');
  });

  it('PUT drops secret-shaped fields — the API key never reaches disk', async () => {
    const res = await request(app).put('/api/user/settings').send({
      displayName: 'Phisher',
      geminiApiKey: 'leaked-key-12345',
      apiKey: 'another-leaked-key',
      GEMINI_API_KEY: 'shouted-leaked-key',
    });

    expect(res.status).toBe(200);
    // Echoed shape carries no api-key field
    expect((res.body as Record<string, unknown>).geminiApiKey).toBeUndefined();
    expect((res.body as Record<string, unknown>).apiKey).toBeUndefined();

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    /* The general PUT MUST NOT promote any of the secret-shaped payload
       fields to a saved value. The on-disk shape carries `geminiApiKey: null`
       by default (the dedicated /gemini-key endpoint owns that field), so
       we assert "still null", not "absent". The other two payload shapes
       (`apiKey`, `GEMINI_API_KEY`) aren't in the schema at all and must
       NEVER appear on disk. */
    expect(onDisk.geminiApiKey).toBeNull();
    expect(onDisk.apiKey).toBeUndefined();
    expect(onDisk.GEMINI_API_KEY).toBeUndefined();
  });

  it('GET reports apiKeyStatus=set when GEMINI_API_KEY is present, unset otherwise', async () => {
    const unset = await request(app).get('/api/user/settings');
    expect(unset.body.apiKeyStatus).toBe('unset');

    process.env.GEMINI_API_KEY = 'fake-but-non-empty';
    const set = await request(app).get('/api/user/settings');
    expect(set.body.apiKeyStatus).toBe('set');
  });

  it('GET exposes workspaceRoot + workspaceSource for the UI to display', async () => {
    const res = await request(app).get('/api/user/settings');
    expect(typeof res.body.workspaceRoot).toBe('string');
    expect(res.body.workspaceRoot.length).toBeGreaterThan(0);
    expect(['env', 'default', 'override']).toContain(res.body.workspaceSource);
  });

  it('PUT ignores read-only fields submitted in the body', async () => {
    const res = await request(app).put('/api/user/settings').send({
      displayName: 'Adversary',
      apiKeyStatus: 'set', // can't be promoted by the client
      workspaceRoot: '/etc/secret', // can't be retargeted by the client
      workspaceSource: 'env',
    });

    expect(res.status).toBe(200);
    // Echoed values come from the env-derived layer, not the body.
    expect(res.body.apiKeyStatus).toBe('unset');
    expect(res.body.workspaceRoot).not.toBe('/etc/secret');

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.apiKeyStatus).toBeUndefined();
    expect(onDisk.workspaceRoot).toBeUndefined();
    expect(onDisk.workspaceSource).toBeUndefined();
  });

  it('PUT rejects an out-of-range enum with 400', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ defaultTtsEngine: 'definitely-not-an-engine' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  /* Regression — Qwen3-TTS (plan 108) is a valid default TTS model key. The
     PUT allow-list (TTS_MODEL_KEY_VALUES) was the one model-key surface that
     wasn't updated when the engine landed, so selecting it in Account
     settings 400'd. Round-trips through the body AND onto disk. */
  it('PUT accepts qwen3-tts-0.6b as defaultTtsModelKey and round-trips it', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ defaultTtsModelKey: 'qwen3-tts-0.6b' });
    expect(res.status).toBe(200);
    expect(res.body.defaultTtsModelKey).toBe('qwen3-tts-0.6b');

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.defaultTtsModelKey).toBe('qwen3-tts-0.6b');
  });

  /* Regression — EVERY writable setting must survive PUT → GET → disk.
     The qwen bug above shipped because a new model key was added to the
     schema but missed from the PUT allow-list, so its save silently 400'd
     and the value "reverted" on the next load (the user-reported symptom,
     also seen with eagerLoadKokoro). This locks the whole object: one
     non-default sample per writable field, asserted in the PUT echo AND on
     disk. The key list is derived from the schema, so a future field added
     without a sample value fails the guard below — forcing it to be
     covered. geminiApiKey is excluded: it's intentionally stripped from the
     general PUT (see the secret-stripping test) and has its own endpoint. The
     fs-1 upgrade-bookkeeping fields (schemaVersion / lastSeenAppVersion /
     showWhatsNew) are likewise non-writable — stripped from the general PUT and
     set only by writeUpgradeMeta / the /api/info dismiss endpoint. */
  it('PUT round-trips every writable field onto disk and back (no silent drops)', async () => {
    const SAMPLE_VALUES: Record<string, unknown> = {
      displayName: 'Round Trip User',
      defaultAnalysisModel: 'gemini-2.5-flash',
      defaultTtsEngine: 'gemini',
      /* The user's exact TTS-model choice. The server stores engine +
         modelKey independently (no cross-field coherence check), so this is
         a valid persistence probe even though the UI pairs Qwen with the
         `local` engine. */
      defaultTtsModelKey: 'qwen3-tts-0.6b',
      /* true matches the auto-latch: changing defaultTtsModelKey from the
         factory default marks it explicit server-side, so the echo + disk
         both carry true regardless of what we send. */
      defaultTtsModelKeyExplicit: true,
      sidecarUrl: 'http://localhost:9100',
      analysisEngine: 'local',
      ollamaUrl: 'http://localhost:11500',
      workspaceDirOverride: 'D:/audiobooks-ws',
      exportSyncFolder: '/tmp/export-sync',
      minorCastMinLines: 7,
      coverPickerDefaultTab: 'upload',
      defaultThemePreference: 'dark',
      autoStartSidecar: false,
      analyzerPhase0Model: 'gemma-4-31b-it',
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
      analyzerPhase1MinLagChapters: 5,
      dualModelEnabled: true,
      /* The user's other reported field — eager-load off for a Qwen-primary
         setup. */
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
      generationWorkers: 4,
      backupEnabled: false,
      backupCadence: 'weekly',
      backupRetention: 30,
      configOverrides: { 'analyzer.stage2.minCoverage': 0.7 },
    };

    /* Guard: every writable schema field has a sample value here. A field
       added to userSettingsSchema without one trips this assertion. */
    const NON_WRITABLE = new Set([
      'geminiApiKey',
      'schemaVersion',
      'lastSeenAppVersion',
      'showWhatsNew',
      'setupCompletedAt',
      'tourCompletedAt',
    ]);
    const writableKeys = Object.keys(userSettingsSchema.shape).filter((k) => !NON_WRITABLE.has(k));
    for (const key of writableKeys) {
      expect(SAMPLE_VALUES, `add a SAMPLE_VALUES entry for new field "${key}"`).toHaveProperty(key);
    }

    const res = await request(app).put('/api/user/settings').send(SAMPLE_VALUES);
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    for (const key of writableKeys) {
      expect(res.body[key], `GET echo for "${key}"`).toEqual(SAMPLE_VALUES[key]);
      expect(onDisk[key], `on-disk value for "${key}"`).toEqual(SAMPLE_VALUES[key]);
    }
  });

  /* Plan 49 — dedicated Gemini-key PUT endpoint. The general PUT still
     strips secret-shaped fields (asserted above); this endpoint is the
     only sanctioned write path for the API key. */
  describe('PUT /gemini-key', () => {
    it('persists the key, flips apiKeyStatus to set, and never leaks the plaintext', async () => {
      const before = await request(app).get('/api/user/settings');
      expect(before.body.apiKeyStatus).toBe('unset');

      const save = await request(app)
        .put('/api/user/settings/gemini-key')
        .send({ key: 'my-real-key-12345' });
      expect(save.status).toBe(200);
      expect(save.body.apiKeyStatus).toBe('set');
      expect((save.body as Record<string, unknown>).geminiApiKey).toBeUndefined();

      /* Subsequent GET still reports `set` and still does NOT echo the key. */
      const after = await request(app).get('/api/user/settings');
      expect(after.body.apiKeyStatus).toBe('set');
      expect((after.body as Record<string, unknown>).geminiApiKey).toBeUndefined();

      /* On disk, the key IS stored (plaintext, same trust model as .env). */
      const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
      expect(onDisk.geminiApiKey).toBe('my-real-key-12345');
    });

    it('clears the key when the body sends null', async () => {
      /* Seed a saved key first. */
      await request(app)
        .put('/api/user/settings/gemini-key')
        .send({ key: 'temporary-key' });
      const set = await request(app).get('/api/user/settings');
      expect(set.body.apiKeyStatus).toBe('set');

      /* Clear it. */
      const cleared = await request(app)
        .put('/api/user/settings/gemini-key')
        .send({ key: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.apiKeyStatus).toBe('unset');

      const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
      expect(onDisk.geminiApiKey).toBeNull();
    });

    it('env GEMINI_API_KEY wins over the UI-saved value (apiKeyStatus stays set)', async () => {
      /* Save a UI key, then set env to a DIFFERENT value. The status pill
         must reflect env first — that's the documented precedence. */
      await request(app)
        .put('/api/user/settings/gemini-key')
        .send({ key: 'ui-saved-key' });
      process.env.GEMINI_API_KEY = 'env-key-wins';

      const res = await request(app).get('/api/user/settings');
      expect(res.body.apiKeyStatus).toBe('set');
    });

    it('empty / whitespace-only strings coerce to null on save', async () => {
      const res = await request(app)
        .put('/api/user/settings/gemini-key')
        .send({ key: '   ' });
      expect(res.status).toBe(200);
      expect(res.body.apiKeyStatus).toBe('unset');

      const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
      expect(onDisk.geminiApiKey).toBeNull();
    });

    it('rejects a payload missing the key field with 400', async () => {
      const res = await request(app).put('/api/user/settings/gemini-key').send({});
      expect(res.status).toBe(400);
    });
  });

  /* Plan 79 — write-probe behind the export modal's "Test" button. The
     endpoint does mkdir + writeFile + unlink; success means "Node can
     write here right now", failure carries the underlying errno so the
     modal can show a Drive-specific hint. */
  describe('POST /sync-folder/test', () => {
    it('returns { ok: true } for an existing writable dir (no probe straggler)', async () => {
      /* srv-22: the probe requires an existing directory (it no longer
         mkdir-creates the path). Create one, then probe it. */
      const probeDir = mkdtempSync(join(tmpdir(), 'probe-ok-'));
      const res = await request(app)
        .post('/api/user/settings/sync-folder/test')
        .send({ path: probeDir });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const stragglers = readdirSync(probeDir).filter((n) => n.includes('write-probe'));
      expect(stragglers).toEqual([]);
      rmSync(probeDir, { recursive: true, force: true });
    });

    it('returns { ok: false, code: ENOENT } for a non-existent / non-dir path (no auto-create)', async () => {
      /* srv-22: a path whose parent is a file (or that simply does not
         exist) is reported ENOENT without creating anything — the old
         mkdir({recursive:true}) arbitrary-directory-creation primitive
         is gone. */
      const blocking = join(workspaceRoot, 'blocking-file');
      writeFileSync(blocking, 'not a directory');
      const res = await request(app)
        .post('/api/user/settings/sync-folder/test')
        .send({ path: join(blocking, 'cannot-mkdir-here') });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, code: 'ENOENT' });
    });

    it('rejects with 400 when the body is missing the path field', async () => {
      const res = await request(app).post('/api/user/settings/sync-folder/test').send({});
      expect(res.status).toBe(400);
    });

    it('rejects with 400 when the path is an empty string', async () => {
      const res = await request(app)
        .post('/api/user/settings/sync-folder/test')
        .send({ path: '' });
      expect(res.status).toBe(400);
    });
  });

});
