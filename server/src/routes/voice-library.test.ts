/* fs-38 Wave 1, Task 4 — GET /api/voice-library (list, pinned-first then
   updatedAt desc, with at-list-time staleness) + PATCH /api/voice-library/:voiceUuid
   (name/tags/pinned/persona edit).

   Mirrors the tempdir-workspace integration pattern used by
   workspace/voice-library.test.ts and routes/voices.test.ts: mkdtempSync +
   WORKSPACE_DIR env + vi.resetModules() so paths.ts / model-paths.ts re-read
   their env-derived state fresh per test, then a real express app mounted
   with the gate + router exactly as app.ts does. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let dir: string;
let app: Express;
let vl: typeof import('../workspace/voice-library.js');
let modelPaths: typeof import('../tts/model-paths.js');
let writeConfigOverride: typeof import('../workspace/user-settings.js').writeConfigOverride;
let paths: typeof import('../workspace/paths.js');
let qwenVoice: typeof import('./qwen-voice.js');
let sampleCache: typeof import('../tts/voice-sample-cache.js');

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

function makeEntry(
  overrides: Partial<import('../workspace/voice-library.js').VoiceLibraryEntry> = {},
): import('../workspace/voice-library.js').VoiceLibraryEntry {
  return {
    voiceUuid: 'uuid-1',
    name: 'Test Voice',
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-voicelib-routes-'));
  process.env.WORKSPACE_DIR = dir;
  process.env.VOICE_SAMPLE_AUDIO_DIR = join(dir, 'audio-voices');
  vi.resetModules();

  const [
    { voiceLibraryRouter },
    { requireVoiceLibraryEnabled },
    voiceLibMod,
    modelPathsMod,
    userSettings,
    pathsMod,
    qwenVoiceMod,
    sampleCacheMod,
  ] = await Promise.all([
    import('./voice-library.js'),
    import('./voice-library-gate.js'),
    import('../workspace/voice-library.js'),
    import('../tts/model-paths.js'),
    import('../workspace/user-settings.js'),
    import('../workspace/paths.js'),
    import('./qwen-voice.js'),
    import('../tts/voice-sample-cache.js'),
  ]);
  vl = voiceLibMod;
  modelPaths = modelPathsMod;
  writeConfigOverride = userSettings.writeConfigOverride;
  paths = pathsMod;
  qwenVoice = qwenVoiceMod;
  sampleCache = sampleCacheMod;

  app = express();
  app.use(express.json());
  app.use('/api/voice-library', requireVoiceLibraryEnabled, voiceLibraryRouter);
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/voice-library', () => {
  it('404s when the voice-library feature is off', async () => {
    await writeConfigOverride('voices.library.enabled', false);
    const res = await request(app).get('/api/voice-library');
    expect(res.status).toBe(404);
  });

  it('lists entries sorted pinned-first, then updatedAt desc', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'a', name: 'A', pinned: false, updatedAt: '2026-01-03T00:00:00.000Z' }));
    await vl.writeEntry(makeEntry({ voiceUuid: 'b', name: 'B', pinned: true, updatedAt: '2026-01-01T00:00:00.000Z' }));
    await vl.writeEntry(makeEntry({ voiceUuid: 'c', name: 'C', pinned: false, updatedAt: '2026-01-05T00:00:00.000Z' }));
    await vl.writeEntry(makeEntry({ voiceUuid: 'd', name: 'D', pinned: true, updatedAt: '2026-01-02T00:00:00.000Z' }));

    const res = await request(app).get('/api/voice-library');
    expect(res.status).toBe(200);
    // writeEntry stamps its own fresh updatedAt (ignoring the one passed in),
    // so assert only on the invariant the route itself is responsible for:
    // every pinned entry sorts before every unpinned entry.
    const uuids = (res.body.voices as Array<{ voiceUuid: string; pinned: boolean }>).map((v) => v.voiceUuid);
    expect(uuids).toHaveLength(4);
    const pinnedIdx = uuids.map((id) => (id === 'b' || id === 'd' ? 1 : 0));
    const firstUnpinned = pinnedIdx.indexOf(0);
    const lastPinned = pinnedIdx.lastIndexOf(1);
    expect(lastPinned).toBeLessThan(firstUnpinned === -1 ? Infinity : firstUnpinned);
  });

  it('orders unpinned entries by updatedAt desc', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'old', name: 'Old' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vl.writeEntry(makeEntry({ voiceUuid: 'new', name: 'New' }));

    const res = await request(app).get('/api/voice-library');
    const uuids = (res.body.voices as Array<{ voiceUuid: string }>).map((v) => v.voiceUuid);
    expect(uuids.indexOf('new')).toBeLessThan(uuids.indexOf('old'));
  });

  it('reads qwen.status as stale when the manifest baseModel differs from the current base model, without mutating the manifest on disk', async () => {
    const current = modelPaths.currentQwenBaseModel();
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'stale-1',
        engines: { qwen: { status: 'ready', baseModel: 'some/other-model' } },
      }),
    );
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'fresh-1',
        engines: { qwen: { status: 'ready', baseModel: current } },
      }),
    );

    const res = await request(app).get('/api/voice-library');
    const byId = new Map(
      (res.body.voices as Array<{ voiceUuid: string; engines: { qwen?: { status: string } } }>).map((v) => [
        v.voiceUuid,
        v,
      ]),
    );
    expect(byId.get('stale-1')?.engines.qwen?.status).toBe('stale');
    expect(byId.get('fresh-1')?.engines.qwen?.status).toBe('ready');

    // On-disk manifest is untouched — staleness is computed at list time only.
    const onDisk = await vl.readEntry('stale-1');
    expect(onDisk?.engines.qwen?.status).toBe('ready');
  });
});

describe('PATCH /api/voice-library/:voiceUuid', () => {
  it('404s for an unknown uuid', async () => {
    const res = await request(app).patch('/api/voice-library/does-not-exist').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('updates name, tags, and pinned', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'edit-1', name: 'Old Name', tags: ['a'], pinned: false }));

    const res = await request(app)
      .patch('/api/voice-library/edit-1')
      .send({ name: 'New Name', tags: ['a', 'b'], pinned: true });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.tags).toEqual(['a', 'b']);
    expect(res.body.pinned).toBe(true);

    const onDisk = await vl.readEntry('edit-1');
    expect(onDisk?.name).toBe('New Name');
    expect(onDisk?.tags).toEqual(['a', 'b']);
    expect(onDisk?.pinned).toBe(true);
  });

  it('accepts a persona edit on a designed entry', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-1', provenance: 'designed' }));

    const res = await request(app)
      .patch('/api/voice-library/designed-1')
      .send({ persona: 'a warm, gravelly narrator' });

    expect(res.status).toBe(200);
    expect(res.body.persona).toBe('a warm, gravelly narrator');
  });

  it('rejects a persona edit on a non-designed (cloned) entry with 400', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'cloned-1', provenance: 'cloned' }));

    const res = await request(app)
      .patch('/api/voice-library/cloned-1')
      .send({ persona: 'a warm, gravelly narrator' });

    expect(res.status).toBe(400);
    const onDisk = await vl.readEntry('cloned-1');
    expect(onDisk?.persona).toBeUndefined();
  });

  it('rejects an attempt to change provenance with 400', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'prov-1', provenance: 'designed' }));

    const res = await request(app)
      .patch('/api/voice-library/prov-1')
      .send({ provenance: 'cloned' });

    expect(res.status).toBe(400);
    const onDisk = await vl.readEntry('prov-1');
    expect(onDisk?.provenance).toBe('designed');
  });

  it('404s when the voice-library feature is off', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'gate-1' }));
    await writeConfigOverride('voices.library.enabled', false);
    const res = await request(app).patch('/api/voice-library/gate-1').send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/voice-library/:voiceUuid', () => {
  /** Seeds every artifact a real designed library voice would have on disk:
      the manifest dir (Task 3), the global qwen `.pt` + sidecar `.json`
      (mirrors `qwen-voice.ts`'s design-route output), and a cached sample
      MP3 under the voiceUuid scope (mirrors a future library sample route). */
  async function seedFullVoiceArtifacts(voiceUuid: string) {
    await vl.writeEntry(makeEntry({ voiceUuid, engines: { qwen: { status: 'ready' } } }));

    const qwenName = `qwen-${voiceUuid}`;
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(qwenVoice.qwenVoicePtPath(qwenName), 'fake-pt-bytes');
    writeFileSync(paths.qwenVoiceSidecarPath(qwenName), JSON.stringify({ instruct: 'x' }));

    mkdirSync(sampleCache.voiceSampleAudioDir(), { recursive: true });
    const sampleFileName = sampleCache.voiceSampleFileName({
      cacheScope: voiceUuid,
      modelKey: 'qwen3-tts-0.6b',
      text: 'Hello.',
      voiceName: qwenName,
    });
    writeFileSync(sampleCache.voiceSampleFilePath(sampleFileName), 'fake-mp3-bytes');

    return {
      entryDir: vl.entryDir(voiceUuid),
      ptPath: qwenVoice.qwenVoicePtPath(qwenName),
      jsonPath: paths.qwenVoiceSidecarPath(qwenName),
      samplePath: sampleCache.voiceSampleFilePath(sampleFileName),
    };
  }

  it('404s for an unknown uuid', async () => {
    const res = await request(app).delete('/api/voice-library/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('404s when the voice-library feature is off', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'gate-1' }));
    await writeConfigOverride('voices.library.enabled', false);
    const res = await request(app).delete('/api/voice-library/gate-1');
    expect(res.status).toBe(404);
  });

  it('returns 409 with a usage report when the voice is referenced and confirm is absent', async () => {
    const artifacts = await seedFullVoiceArtifacts('used-1');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: { qwen: { name: 'qwen-used-1', libraryUuid: 'used-1' } },
      },
    ]);

    const res = await request(app).delete('/api/voice-library/used-1');

    expect(res.status).toBe(409);
    expect(res.body.usage).toEqual([
      { bookId: 'book-one', bookTitle: 'Book One', characterId: 'char-marlow', characterName: 'Marlow' },
    ]);
    // Nothing erased pre-confirm.
    expect(existsSync(artifacts.entryDir)).toBe(true);
    expect(existsSync(artifacts.ptPath)).toBe(true);
  });

  it('deletes an unused voice (no confirm needed) and erases every artifact', async () => {
    const artifacts = await seedFullVoiceArtifacts('unused-1');

    const res = await request(app).delete('/api/voice-library/unused-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(existsSync(artifacts.entryDir)).toBe(false);
    expect(existsSync(artifacts.ptPath)).toBe(false);
    expect(existsSync(artifacts.jsonPath)).toBe(false);
    expect(existsSync(artifacts.samplePath)).toBe(false);
  });

  it('with confirm=1: clears the referencing override slot, then erases every artifact (erasure completeness)', async () => {
    const artifacts = await seedFullVoiceArtifacts('used-2');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: {
          qwen: { name: 'qwen-used-2', libraryUuid: 'used-2' },
          coqui: { name: 'preset-voice' },
        },
      },
    ]);

    const res = await request(app).delete('/api/voice-library/used-2?confirm=1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    // Erasure completeness — every artifact path gone.
    expect(existsSync(artifacts.entryDir)).toBe(false);
    expect(existsSync(artifacts.ptPath)).toBe(false);
    expect(existsSync(artifacts.jsonPath)).toBe(false);
    expect(existsSync(artifacts.samplePath)).toBe(false);

    // Referencing slot cleared (character left voiceless on that engine);
    // sibling slot untouched.
    const castPath = join(
      dir,
      'books',
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toBeUndefined();
    expect(cast.characters[0].overrideTtsVoices?.coqui).toEqual({ name: 'preset-voice' });
  });
});
