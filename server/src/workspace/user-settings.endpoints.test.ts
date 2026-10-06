import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  USER_SETTINGS_PATH,
  _resetUserSettingsCache,
  knownAnalyzerSecrets,
  loadKnownAnalyzerSecrets,
  mutateUserSettings,
  readUserSettings,
  writeGeminiApiKey,
  writeSetupCompletedAt,
  writeTourCompletedAt,
  writeUpgradeMeta,
  writeUserSettings,
} from './user-settings.js';
import { loadKnownAnalyzerSecrets as loadKnownAnalyzerSecretsViaGate } from '../analyzer/known-secrets-gate.js';

/* #3084 P25 — beside the settings file, whatever test-setup.ts redirected it to.
   A test that needs every append to fail puts a DIRECTORY at this path: appendFile
   on a directory rejects on every OS, with no module mock. */
const ARCHIVE = join(dirname(USER_SETTINGS_PATH), 'user-settings.invalid-endpoints.json');

const ep = (id: string) => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema' as const,
  reasoningStyle: 'not_controllable' as const,
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32768,
});

beforeEach(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  _resetUserSettingsCache();
});
afterAll(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  _resetUserSettingsCache();
});

/* Silences the drop warnings and the append-failure error for one test body. */
async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await body();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe('mutateUserSettings (#3084 PR 3b)', () => {
  it('serialises concurrent decisions so neither change is lost', async () => {
    await Promise.all([
      mutateUserSettings((cur) => ({ analyzerEndpoints: [...cur.analyzerEndpoints, ep('a')] })),
      mutateUserSettings((cur) => ({ analyzerEndpoints: [...cur.analyzerEndpoints, ep('b')] })),
    ]);
    _resetUserSettingsCache();
    const ids = (await readUserSettings()).analyzerEndpoints.map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('a throwing decision writes nothing and propagates', async () => {
    await mutateUserSettings(() => ({ analyzerEndpoints: [ep('a')] }));
    await expect(
      mutateUserSettings(() => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    _resetUserSettingsCache();
    expect((await readUserSettings()).analyzerEndpoints.map((e) => e.id)).toEqual(['a']);
  });

  it('knownAnalyzerSecrets includes every saved endpoint key', async () => {
    await mutateUserSettings(() => ({
      analyzerEndpoints: [ep('a')],
      analyzerEndpointKeys: { a: { origin: 'http://127.0.0.1:8080', key: 'sk-endpoint-secret-1' } },
    }));
    expect(knownAnalyzerSecrets()).toContain('sk-endpoint-secret-1');
  });

  it('knownAnalyzerSecrets includes an env-only GEMINI_API_KEY, with no key saved in settings (#3525 review)', async () => {
    const prior = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '  AIza-env-only-secret-1  ';
    try {
      await readUserSettings(); // no saved Gemini key: the env value is the only source
      expect(knownAnalyzerSecrets()).toContain('AIza-env-only-secret-1');
    } finally {
      if (prior === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prior;
    }
  });

  it('loadKnownAnalyzerSecrets reads settings when the cache is cold (the boot read is not awaited)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [ep('a')],
        analyzerEndpointKeys: { a: { origin: 'http://127.0.0.1:8080', key: 'sk-cold-cache-secret-1' } },
      }),
    );
    _resetUserSettingsCache();
    expect(knownAnalyzerSecrets()).not.toContain('sk-cold-cache-secret-1');
    expect(await loadKnownAnalyzerSecrets()).toContain('sk-cold-cache-secret-1');
    /* A9 — the gate's load reaches the same provider, cold cache included. */
    _resetUserSettingsCache();
    expect(await loadKnownAnalyzerSecretsViaGate()).toContain('sk-cold-cache-secret-1');
  });
});

describe('readUserSettings — endpoint entries parse one by one (#3084 P25)', () => {
  it('drops one malformed endpoint and one malformed key entry with a warning, and keeps everything else, the Gemini key included', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        displayName: 'Kept',
        geminiApiKey: 'AIzaSy-kept-across-a-bad-entry',
        analyzerEndpoints: [
          { id: 'Bad_Id', name: 'Bad', baseUrl: 'not a url' },
          { id: 'good', name: 'Good', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 },
        ],
        analyzerEndpointKeys: {
          good: { origin: 'http://127.0.0.1:8080', key: 'sk-good-1234' },
          broken: { origin: 42 },
        },
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.displayName).toBe('Kept');
      expect(s.geminiApiKey).toBe('AIzaSy-kept-across-a-bad-entry');
      expect(s.analyzerEndpoints.map((e) => e.id)).toEqual(['good']);
      expect(s.analyzerEndpointKeys).toEqual({ good: { origin: 'http://127.0.0.1:8080', key: 'sk-good-1234' } });
      const lines = warn.mock.calls.map((c) => c.join(' '));
      expect(lines).toContainEqual(expect.stringContaining('dropping invalid analyzer endpoint #0 (id "Bad_Id")'));
      expect(lines).toContainEqual(expect.stringContaining('dropping invalid key entry for analyzer endpoint "broken"'));
      expect(lines.join('\n')).not.toContain('sk-good-1234');
    } finally {
      warn.mockRestore();
    }
  });

  it('a non-list analyzerEndpoints value is ignored, never resetting the file', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ displayName: 'Kept', analyzerEndpoints: 'garbage' }));
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.displayName).toBe('Kept');
      expect(s.analyzerEndpoints).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('appends every dropped entry to user-settings.invalid-endpoints.json beside the settings file, never overwriting it, and each warning names that file (P25)', async () => {
    writeFileSync(ARCHIVE, '{"earlier":"line kept"}\n');
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        displayName: 'Kept',
        analyzerEndpoints: [{ id: 'Archive_Bad', name: 'Bad', baseUrl: 'not a url' }],
        analyzerEndpointKeys: { 'archive-broken': { origin: 7 } },
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await readUserSettings();
      const lines = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n');
      expect(lines[0]).toBe('{"earlier":"line kept"}');
      const records = lines.slice(1).map((l) => JSON.parse(l) as { droppedAt: string; issues: string[] });
      expect(records).toEqual([
        expect.objectContaining({
          field: 'analyzerEndpoints',
          position: 0,
          id: 'Archive_Bad',
          entry: { id: 'Archive_Bad', name: 'Bad', baseUrl: 'not a url' },
        }),
        expect.objectContaining({ field: 'analyzerEndpointKeys', position: 'archive-broken', entry: { origin: 7 } }),
      ]);
      for (const r of records) {
        expect(Number.isNaN(Date.parse(r.droppedAt))).toBe(false);
        expect(r.issues.length).toBeGreaterThan(0);
      }
      const drops = warn.mock.calls.map((c) => c.join(' ')).filter((w) => w.includes('dropping invalid'));
      expect(drops).toHaveLength(2);
      for (const w of drops) expect(w).toContain(ARCHIVE);
    } finally {
      warn.mockRestore();
    }
  });

  it('the drop is archived before a write can persist it (P25)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Persist_Bad', name: 'Bad', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mutateUserSettings(() => ({ displayName: 'After' }));
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Persist_Bad');
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Persist_Bad"');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the first of two endpoints sharing an id and archives the later one (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'dup', name: 'First', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 },
          { id: 'dup', name: 'Second', baseUrl: 'http://127.0.0.1:9090/v1', gpu: 'any', contextTokens: 16384 },
        ],
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.analyzerEndpoints.map((e) => e.name)).toEqual(['First']);
      const records = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { issues: string[] });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ field: 'analyzerEndpoints', position: 1, id: 'dup', entry: { name: 'Second' } });
      expect(records[0].issues.join(' ')).toContain('repeats the id of an earlier endpoint');
    } finally {
      warn.mockRestore();
    }
  });

  it('two concurrent cold reads and a write share one read: the drop is appended once, before the write persists it (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ displayName: 'Before', analyzerEndpoints: [{ id: 'Race_Bad', name: 'Bad', baseUrl: 'nope' }] }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await Promise.all([readUserSettings(), readUserSettings(), mutateUserSettings(() => ({ displayName: 'After' }))]);
      const records = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n');
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('"id":"Race_Bad"');
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Race_Bad');
    });
  });

  it('when the append fails, two concurrent cold reads and a write all succeed, and the file keeps the unarchived entry raw (P25)', async () => {
    const bad = { id: 'Blocked_Bad', name: 'Bad', baseUrl: 'nope' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ displayName: 'Before', analyzerEndpoints: [bad] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      const [a, b, write] = await Promise.allSettled([
        readUserSettings(),
        readUserSettings(),
        mutateUserSettings(() => ({ displayName: 'After' })),
      ]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      expect(write.status).toBe('fulfilled');
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
      expect(onDisk.displayName).toBe('After');
      expect(onDisk.analyzerEndpoints).toEqual([bad]);
      /* The loaded settings still drop it; only the file keeps it until the append lands. */
      expect((await readUserSettings()).analyzerEndpoints).toEqual([]);
    });
  });

  it('a failed append is retried on the next read; once it lands, a write no longer keeps the entry (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ displayName: 'Kept', analyzerEndpoints: [{ id: 'Retry_Bad', name: 'Bad', baseUrl: 'nope' }] }),
    );
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      expect((await readUserSettings()).displayName).toBe('Kept');
      expect(statSync(ARCHIVE).isDirectory()).toBe(true);
      rmSync(ARCHIVE, { recursive: true, force: true });
      await readUserSettings();
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Retry_Bad"');
      await mutateUserSettings(() => ({ displayName: 'After' }));
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Retry_Bad');
    });
  });

  it.each([
    ['writeUserSettings', () => writeUserSettings({ displayName: 'x' })],
    ['writeGeminiApiKey', () => writeGeminiApiKey(null)],
    ['writeUpgradeMeta', () => writeUpgradeMeta({ showWhatsNew: false })],
    ['writeSetupCompletedAt', () => writeSetupCompletedAt(null)],
    ['writeTourCompletedAt', () => writeTourCompletedAt(null)],
    ['mutateUserSettings', () => mutateUserSettings(() => ({ displayName: 'x' }))],
  ] as const)('%s saves while a dropped entry is unarchived, and writes the entry back raw and unchanged (P25)', async (_name, write) => {
    const bad = { id: 'Kept_Bad', name: 'Bad', baseUrl: 'nope' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [bad] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      await write(); // never refuses because the append failed
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as { analyzerEndpoints: unknown };
      expect(onDisk.analyzerEndpoints).toEqual([bad]);
    });
  });

  it('a key entry whose append failed is written back raw beside a key saved for another endpoint, and only its origin is archived once the retry lands (P25)', async () => {
    const rawKey = { origin: 99, key: 'sk-pending-key-secret-1' };
    const other = { origin: 'http://127.0.0.1:9090', key: 'sk-other' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: rawKey } }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      await mutateUserSettings(() => ({ analyzerEndpointKeys: { other } }));
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as { analyzerEndpointKeys: Record<string, unknown> };
      expect(onDisk.analyzerEndpointKeys).toEqual({ other, lab: rawKey });
      rmSync(ARCHIVE, { recursive: true, force: true });
      await readUserSettings(); // the retry lands
      const archived = readFileSync(ARCHIVE, 'utf8');
      expect(archived).toContain('"position":"lab"');
      expect(archived).not.toContain('sk-pending-key-secret-1');
    });
  });

  it('a dropped key entry is archived with its origin only, never the key (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: 'sk-archived-key-secret-1' } } }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      expect((await readUserSettings()).analyzerEndpointKeys).toEqual({});
      const text = readFileSync(ARCHIVE, 'utf8');
      expect(text).not.toContain('sk-archived-key-secret-1');
      const record = JSON.parse(text.trimEnd()) as { entry: Record<string, unknown> };
      expect(record).toMatchObject({ field: 'analyzerEndpointKeys', position: 'lab', entry: { origin: 99 } });
      expect(record.entry).not.toHaveProperty('key');
    });
  });

  it('_resetUserSettingsCache forgets archived entries, so a later read archives the same entry again (P25)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Reset_Bad', name: 'Bad', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      rmSync(ARCHIVE, { force: true });
      _resetUserSettingsCache();
      await readUserSettings();
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Reset_Bad"');
    });
  });

});
