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
import { SidecarDesignError } from '../tts/design-voice-core.js';

/* Task 10 — the sample route calls selectTtsProvider(). Stub it the same way
   routes/voice-sample.test.ts does, so the encoder boundary (real ffmpeg) is
   the only system dependency for a synth call. vi.mock is hoisted, so it
   intercepts every dynamic `import('./voice-library.js')` below regardless of
   vi.resetModules() churn. */
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: vi.fn(() => ({ synthesize })),
  };
});

/* Task 6 — the clone-sample route ingests via ingestCloneSample, which in
   turn calls Whisper transcription (transcribe-client.js). Stub it the same
   hoisted way as the synth mock above, so the ingest path never needs a
   real Whisper model in this route-level test. */
const { transcribeSegment } = vi.hoisted(() => ({ transcribeSegment: vi.fn() }));
vi.mock('../tts/transcribe-client.js', () => ({ transcribeSegment }));

/* Task 5 — the /clone route calls deriveEngineArtifact (Node -> sidecar
   /qwen/clone-voice) and assessCloneFidelity (ECAPA embed + cosine). Stub
   both, plus the ffmpeg decode boundary, so no sidecar/ffmpeg is hit in this
   route-level test. */
const { deriveMock, decodeMock, assessFidelityMock } = vi.hoisted(() => ({
  deriveMock: vi.fn(),
  decodeMock: vi.fn(),
  assessFidelityMock: vi.fn(),
}));
vi.mock('../tts/derive-engine-artifact.js', () => ({ deriveEngineArtifact: deriveMock }));
vi.mock('../tts/clone-fidelity.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, assessCloneFidelity: assessFidelityMock };
});
vi.mock('../tts/mp3.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, decodeAudioToPcm: decodeMock };
});

/* Wave 3b2, Task 3 — revoke + delete both wire through purgeCloneArtifacts
   (workspace/purge-clone-artifacts.ts, Task 2), left UNMOCKED here so the
   revoke/delete tests below prove real Node-side erasure (not a stand-in).
   NOTE: a self-wrapping `vi.mock('../workspace/purge-clone-artifacts.js',
   (importOriginal) => ...)` spy was tried and rejected — Vitest's
   importOriginal() resolves purge-clone-artifacts.ts's OWN transitive
   import of workspace/voice-library.js through a second, parallel module
   graph, so `removeEntryDir` inside the real purge function silently
   erases a DIFFERENT `entryDir(voiceUuid)` instance than the one this
   test file's own `vl` binding reads/asserts against — a real, sneaky bug
   made assertions like existsSync(artifacts.entryDir) flake pathologically
   depending on test order. Asserting on real file-existence effects (as the
   rest of this DELETE describe already does) sidesteps it entirely. */

let dir: string;
let app: Express;
let vl: typeof import('../workspace/voice-library.js');
let modelPaths: typeof import('../tts/model-paths.js');
let writeConfigOverride: typeof import('../workspace/user-settings.js').writeConfigOverride;
let setUserSettingsCacheForTest: typeof import('../workspace/user-settings.js')._setUserSettingsCacheForTest;
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
  setUserSettingsCacheForTest = userSettings._setUserSettingsCacheForTest;
  paths = pathsMod;
  qwenVoice = qwenVoiceMod;
  sampleCache = sampleCacheMod;

  app = express();
  app.use(express.json());
  app.use('/api/voice-library', requireVoiceLibraryEnabled, voiceLibraryRouter);

  synthesize.mockReset();
  /* Default: 0.3 s of silence at 24 kHz mono int16 — matches the
     Task 9 sidecar stub's clip length, keeps ffmpeg encoding fast. */
  const pcm = Buffer.alloc(24_000 * 2 * 0.3, 0);
  synthesize.mockResolvedValue({ pcm, sampleRate: 24_000, mimeType: 'audio/L16' });

  transcribeSegment.mockResolvedValue({
    text: 'hello there',
    language: 'en',
    words: null,
    avgLogprob: null,
    noSpeechProb: null,
    compressionRatio: null,
  });

  deriveMock.mockReset();
  deriveMock.mockResolvedValue({ previewPcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000, baseModel: 'qwen3-0.6b' });
  assessFidelityMock.mockReset();
  assessFidelityMock.mockResolvedValue({ cosine: 0.72 });
  /* decodeMock defaults to the REAL ffmpeg decode (pass-through) — the
     clone-sample ingest route (Task 6) also calls decodeAudioToPcm and needs
     genuine decoding to run its quality gate against real uploaded audio.
     Individual "POST /clone" tests below override with mockResolvedValueOnce
     to stand in for the fake, non-decodable candidate WAV bytes they seed. */
  const mp3Actual = await vi.importActual<typeof import('../tts/mp3.js')>('../tts/mp3.js');
  decodeMock.mockReset();
  decodeMock.mockImplementation(mp3Actual.decodeAudioToPcm);
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
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'cloned-1',
        provenance: 'cloned',
        consent: {
          personName: 'Test',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'test',
        },
      }),
    );

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
      MP3 under the REAL `qwen-<uuid>` scope — the same scope Task 9's
      design/promote and Task 10's sample route actually cache under (see
      voice-sample-cache.ts's `purgeVoiceSamples` doc). Seeding under the bare
      `voiceUuid` scope here would make this a placebo: it'd match the
      DELETE route's (pre-fix) `purgeVoiceSamples(voiceUuid)` call by
      construction, without proving the purge matches a file the app would
      really create. */
  async function seedFullVoiceArtifacts(voiceUuid: string) {
    await vl.writeEntry(makeEntry({ voiceUuid, engines: { qwen: { status: 'ready' } } }));

    const qwenName = `qwen-${voiceUuid}`;
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(qwenVoice.qwenVoicePtPath(qwenName), 'fake-pt-bytes');
    writeFileSync(paths.qwenVoiceSidecarPath(qwenName), JSON.stringify({ instruct: 'x' }));

    mkdirSync(sampleCache.voiceSampleAudioDir(), { recursive: true });
    const sampleFileName = sampleCache.voiceSampleFileName({
      cacheScope: qwenName,
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

  /* Wave 3b2, Task 3 — DELETE now routes through purgeCloneArtifacts, which
     closes the `__1.7b.pt` gap the prior ad-hoc erasure missed. The fetch
     stub below is load-bearing (non-placebo requirement): the OLD
     `/qwen/evict-voice` sidecar call already erases a live sidecar's
     `__1.7b.pt` copy, so an unstubbed test here could pass against
     un-fixed Node-side code as long as a sidecar happened to be reachable.
     Rejecting the sidecar call proves the file is gone via the Node-side
     `rm`, not the sidecar. */
  it('erases the qwen-<uuid>__1.7b.pt clone variant on delete (Node-side, sidecar unreachable)', async () => {
    const artifacts = await seedFullVoiceArtifacts('unused-17b');
    const qwenName = `qwen-unused-17b`;
    const pt17bPath = qwenVoice.qwenVoicePtPath(`${qwenName}__1.7b`);
    writeFileSync(pt17bPath, 'fake-1.7b-pt-bytes');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sidecar unreachable'));
    try {
      const res = await request(app).delete('/api/voice-library/unused-17b');

      expect(res.status).toBe(200);
      expect(existsSync(pt17bPath)).toBe(false); // the 1.7B gap this closes
      expect(existsSync(artifacts.ptPath)).toBe(false);
      expect(existsSync(artifacts.entryDir)).toBe(false); // deleteEntryDir: true
    } finally {
      fetchSpy.mockRestore();
    }
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

/* Task 10 — POST /:voiceUuid/sample. Mirrors POST /api/voices/:voiceId/sample
   (routes/voice-sample.ts) but scoped to a library voice: cacheScope is the
   RECONCILED `qwen-<uuid>` storageKey (not the plan's original `lib-<uuid>`
   — see the module doc comment above the route), and contentToken folds in
   a hash of the entry's persona so a persona edit busts the cache even when
   the (scope, modelKey, text, voiceName) tuple is otherwise unchanged. */
describe('POST /api/voice-library/:voiceUuid/sample (Task 10)', () => {
  it('404s for an unknown voiceUuid', async () => {
    const res = await request(app).post('/api/voice-library/does-not-exist/sample').send({});
    expect(res.status).toBe(404);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('404s when the voice-library feature is off', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'gate-1' }));
    await writeConfigOverride('voices.library.enabled', false);
    const res = await request(app).post('/api/voice-library/gate-1/sample').send({});
    expect(res.status).toBe(404);
  });

  it('synthesises and caches a sample under the qwen-<uuid> scope; a repeat call is a cache hit', async () => {
    await vl.writeEntry(
      makeEntry({ voiceUuid: 'sample-1', name: 'Nova', provenance: 'designed', persona: 'a calm narrator' }),
    );

    const res1 = await request(app).post('/api/voice-library/sample-1/sample').send({});
    expect(res1.status).toBe(200);
    expect(res1.body.url).toMatch(/^\/audio\/voices\/qwen-sample-1-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const synthArgs = synthesize.mock.calls[0][0] as { voiceName: string; modelKey: string };
    expect(synthArgs.voiceName).toBe('qwen-sample-1');
    expect(synthArgs.modelKey).toBe('qwen3-tts-0.6b');

    const res2 = await request(app).post('/api/voice-library/sample-1/sample').send({});
    expect(res2.status).toBe(200);
    expect(res2.body.url).toBe(res1.body.url);
    expect(synthesize).toHaveBeenCalledTimes(1); // cache hit, no re-synth
  });

  it('a persona edit changes the returned sample url (content-hashed cache key)', async () => {
    await vl.writeEntry(
      makeEntry({ voiceUuid: 'sample-2', name: 'Nova', provenance: 'designed', persona: 'a calm narrator' }),
    );

    const before = await request(app).post('/api/voice-library/sample-2/sample').send({});
    expect(before.status).toBe(200);

    await request(app)
      .patch('/api/voice-library/sample-2')
      .send({ persona: 'a brighter, warmer read' });

    const after = await request(app).post('/api/voice-library/sample-2/sample').send({});
    expect(after.status).toBe(200);
    expect(after.body.url).not.toBe(before.body.url);
    expect(synthesize).toHaveBeenCalledTimes(2); // distinct content tokens, both cache misses
  });

  it('POST /:uuid/sample 403s a revoked cloned voice', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 's1', name: 'Gran', provenance: 'cloned', tags: [], pinned: false, engines: {},
      consent: { personName: 'Gran', relationship: 'family-with-permission', permittedUse: 'personal', attestedAt: 'x', attestedBy: 'me', revokedAt: 'yesterday' },
      createdAt: 'x', updatedAt: 'x',
    });
    const res = await request(app).post('/api/voice-library/s1/sample').send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /api/voice-library/:voiceUuid/assign', () => {
  function castPathFor(bookDir: string) {
    return join(bookDir, '.audiobook', 'cast.json');
  }

  it('404s for an unknown voiceUuid', async () => {
    const res = await request(app)
      .post('/api/voice-library/does-not-exist/assign')
      .send({ bookId: 'book-one', characterId: 'char-marlow' });
    expect(res.status).toBe(404);
  });

  it('404s when the voice-library feature is off', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'gate-1' }));
    await writeConfigOverride('voices.library.enabled', false);
    const res = await request(app)
      .post('/api/voice-library/gate-1/assign')
      .send({ bookId: 'book-one', characterId: 'char-marlow' });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown bookId', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'assign-1' }));
    const res = await request(app)
      .post('/api/voice-library/assign-1/assign')
      .send({ bookId: 'no-such-book', characterId: 'char-marlow' });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'assign-2' }));
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-two', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app)
      .post('/api/voice-library/assign-2/assign')
      .send({ bookId: 'book-two', characterId: 'no-such-char' });
    expect(res.status).toBe(404);
  });

  it('409s when the voice consent has been revoked', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'revoked-1',
        provenance: 'cloned',
        consent: {
          personName: 'Jamie',
          relationship: 'self',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'Jamie',
          revokedAt: '2026-01-02T00:00:00.000Z',
        },
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-three', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/revoked-1/assign')
      .send({ bookId: 'book-three', characterId: 'char-marlow' });

    expect(res.status).toBe(409);
    /* M-2 (review) — three separate guards on this route now produce 409
       for a cloned entry (revoked consent, not-ready-to-assign, wrong-engine).
       Assert the MESSAGE too so this test fails for the right reason if the
       revoked-consent check ever stops running first. */
    expect(res.body.error).toBe('Consent for this voice has been revoked.');
  });

  it('stamps the qwen slot with name/libraryUuid/provenance, merges with (not clobbers) a sibling kokoro slot, and never touches character.voiceUuid', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'assign-3',
        provenance: 'cloned',
        engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
        consent: {
          personName: 'Test',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'test',
        },
      }),
    );
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-four', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        // Task 6b — the character must route to Qwen for this assign to
        // succeed (a cloned voice on a non-Qwen route now 409s). Explicit
        // per-character override so this test doesn't depend on the
        // process-wide Qwen install-state default.
        ttsEngine: 'qwen',
        voiceUuid: 'original-marlow-voice-uuid',
        overrideTtsVoices: { kokoro: { name: 'af_heart' } },
      },
    ]);

    const res = await request(app)
      .post('/api/voice-library/assign-3/assign')
      .send({ bookId: 'book-four', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1 });

    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{
        voiceUuid?: string;
        overrideTtsVoices?: Record<string, unknown>;
      }>;
    };
    expect(cast.characters[0].voiceUuid).toBe('original-marlow-voice-uuid');
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-assign-3',
      libraryUuid: 'assign-3',
      provenance: 'cloned',
    });
    expect(cast.characters[0].overrideTtsVoices?.kokoro).toEqual({ name: 'af_heart' });
  });
});

describe('POST /:uuid/assign — cloned readiness gate (fs-38 Wave 3b1)', () => {
  it('409s assigning a cloned voice whose qwen engine is not ready', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 'clone-unready', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      engines: { qwen: { status: 'stale' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
    const res = await request(app).post('/api/voice-library/clone-unready/assign')
      .send({ bookId: 'ns', characterId: 'marcus' });
    expect(res.status).toBe(409);
  });

  it('allows assigning a ready cloned voice (200)', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 'clone-ready', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
    /* I1 — a REAL resolvable book + character, seeded exactly like this
       file's existing successful `/assign` test ("stamps the qwen slot…",
       ~line 562 of this file): `writeBookOnDisk(dir, author, series, title,
       bookId, characters)`, then post with that same bookId/characterId.
       Without this the route 404s on findBookByBookId before ever reaching
       the readiness gate, and this case would never actually prove 200.
       Task 6b — `ttsEngine: 'qwen'` so this character routes to Qwen (the
       wrong-engine guard added in this task would otherwise 409 it, since
       this test environment's process-wide Qwen default is not installed). */
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-four', [
      { id: 'char-marlow', name: 'Marlow', ttsEngine: 'qwen' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-ready/assign')
      .send({ bookId: 'book-four', characterId: 'char-marlow' });
    expect(res.status).toBe(200);
  });
});

describe('POST /:uuid/assign — wrong-engine guard (fs-38 Wave 3b2, Task 6b)', () => {
  it('409s assigning a ready cloned voice to a character that does not route to Qwen', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 'clone-wrong-engine', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
    // No per-character `ttsEngine` override, and this test environment's
    // process-wide Qwen default is "not installed" -> the book's effective
    // default engine resolves to kokoro, NOT qwen.
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-five', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-wrong-engine/assign')
      .send({ bookId: 'book-five', characterId: 'char-marlow' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/qwen/i);
  });

  it('allows assigning a ready cloned voice to a character that DOES route to Qwen (200, regression)', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 'clone-right-engine', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-six', [
      { id: 'char-marlow', name: 'Marlow', ttsEngine: 'qwen' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-right-engine/assign')
      .send({ bookId: 'book-six', characterId: 'char-marlow' });
    expect(res.status).toBe(200);
  });

  it('does not guard a non-cloned (designed) voice, even on a non-Qwen-routed character', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-1', provenance: 'designed' }));
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-seven', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/designed-1/assign')
      .send({ bookId: 'book-seven', characterId: 'char-marlow' });
    expect(res.status).toBe(200);
  });
});

/* Fix wave 2 (review) — the guard's first cut computed the effective engine
   purely from the PERSISTED account default (getResolvedTtsModelKey()), which
   is not what actually renders: the Voices-page engine picker (and the
   session ui.ttsModelKey it writes) is never persisted, and generation itself
   routes off the REQUEST's modelKey. These cases pin the fixed contract: the
   caller's OWN intended modelKey (body.modelKey) wins when sent, and the
   persisted default is only a fallback for a caller with no engine context. */
describe('POST /:uuid/assign — request modelKey guard accuracy (fs-38 Wave 3b2, fix wave 2)', () => {
  async function seedReadyClone(voiceUuid: string) {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid, name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
  }

  it('a request modelKey routing to Qwen wins over a non-Qwen persisted default (the false-409 case, now fixed)', async () => {
    await seedReadyClone('clone-req-qwen');
    setUserSettingsCacheForTest({ defaultTtsModelKey: 'kokoro-v1', defaultTtsModelKeyExplicit: true });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-1', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-req-qwen/assign')
      .send({ bookId: 'book-req-1', characterId: 'char-marlow', modelKey: 'qwen3-tts-0.6b' });
    expect(res.status).toBe(200);
  });

  it('a request modelKey routing to a non-Qwen engine still 409s, even against a Qwen persisted default (the false-200 case, now fixed)', async () => {
    await seedReadyClone('clone-req-kokoro');
    setUserSettingsCacheForTest({ defaultTtsModelKey: 'qwen3-tts-0.6b', defaultTtsModelKeyExplicit: true });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-2', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-req-kokoro/assign')
      .send({ bookId: 'book-req-2', characterId: 'char-marlow', modelKey: 'kokoro-v1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/qwen/i);
  });

  it('I-1: falls back to the persisted default when no modelKey is sent, and 200s when that default is Qwen', async () => {
    await seedReadyClone('clone-default-qwen');
    setUserSettingsCacheForTest({ defaultTtsModelKey: 'qwen3-tts-0.6b', defaultTtsModelKeyExplicit: true });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-3', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-default-qwen/assign')
      .send({ bookId: 'book-req-3', characterId: 'char-marlow' });
    expect(res.status).toBe(200);
  });

  it('falls back to the persisted default when no modelKey is sent, and 409s when that default is not Qwen', async () => {
    await seedReadyClone('clone-default-kokoro');
    setUserSettingsCacheForTest({ defaultTtsModelKey: 'kokoro-v1', defaultTtsModelKeyExplicit: true });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-4', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-default-kokoro/assign')
      .send({ bookId: 'book-req-4', characterId: 'char-marlow' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('this book is set to');
  });

  it('I-2: 409s with character-cause copy when the character has its own non-Qwen ttsEngine override, regardless of a Qwen book default', async () => {
    await seedReadyClone('clone-char-override');
    setUserSettingsCacheForTest({ defaultTtsModelKey: 'qwen3-tts-0.6b', defaultTtsModelKeyExplicit: true });
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-5', [
      { id: 'char-marlow', name: 'Marlow', ttsEngine: 'kokoro' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-char-override/assign')
      .send({ bookId: 'book-req-5', characterId: 'char-marlow' });
    expect(res.status).toBe(409);
    // Names the CHARACTER as the cause, not the book/session default — the
    // book default here is actually Qwen, so "this book is set to" would be
    // an outright misdiagnosis.
    expect(res.body.error).toContain('"Marlow" is cast on kokoro');
    expect(res.body.error).not.toContain('this book is set to');
  });

  it('does not guard a designed (non-cloned) voice, even with a request modelKey routing off Qwen', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-req', provenance: 'designed' }));
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-req-6', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app).post('/api/voice-library/designed-req/assign')
      .send({ bookId: 'book-req-6', characterId: 'char-marlow', modelKey: 'kokoro-v1' });
    expect(res.status).toBe(200);
  });
});

/* Task 9 — design / redesign / promote / discard. The sidecar (`global.fetch`)
   is stubbed with ~0.3s of silence so real ffmpeg encodes a valid MP3 into the
   audition cache, exactly like routes/qwen-voice.test.ts. `withCapacityRetry`
   runs for real (a single ok call needs no retry). */
describe('POST /api/voice-library/design + redesign/promote/discard (Task 9)', () => {
  function okSidecarResponse(pcm = new Uint8Array(24_000 * 2 * 0.3)) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
      arrayBuffer: async () => pcm.buffer,
      json: async () => ({}),
    } as unknown as Response;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints a uuid, designs, and writes a ready designed manifest + previewUrl', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator' });

    expect(res.status).toBe(201);
    const entry = res.body.entry as import('../workspace/voice-library.js').VoiceLibraryEntry;
    expect(entry.provenance).toBe('designed');
    expect(entry.name).toBe('Nova');
    expect(entry.persona).toBe('a calm, measured narrator');
    expect(entry.engines.qwen?.status).toBe('ready');
    expect(entry.engines.qwen?.baseModel).toBe(modelPaths.currentQwenBaseModel());
    expect(res.body.previewUrl).toMatch(/^\/audio\/voices\/qwen-.+-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);

    // Persisted on disk under the minted uuid.
    const onDisk = await vl.readEntry(entry.voiceUuid);
    expect(onDisk?.provenance).toBe('designed');
    expect(onDisk?.engines.qwen?.status).toBe('ready');

    // The design POST addressed the minted storageKey.
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.voiceId).toBe(`qwen-${entry.voiceUuid}`);
    expect(sent.instruct).toBe('a calm, measured narrator');
  });

  it('400s when name or persona is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    const noName = await request(app).post('/api/voice-library/design').send({ persona: 'p' });
    expect(noName.status).toBe(400);
    const noPersona = await request(app).post('/api/voice-library/design').send({ name: 'X' });
    expect(noPersona.status).toBe(400);
  });

  it('returns 409 for a concurrent second design (single-flight lock)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return okSidecarResponse();
    });

    // `.then()` forces supertest to DISPATCH p1 now (it is otherwise lazy), so
    // p1 acquires the 'library:new' lock before p2 is sent.
    const p1 = request(app)
      .post('/api/voice-library/design')
      .send({ name: 'A', persona: 'p' })
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 60));

    const res2 = await request(app).post('/api/voice-library/design').send({ name: 'B', persona: 'p' });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/already running/i);

    release();
    const res1 = await p1;
    expect(res1.status).toBe(201);
  });

  it('redesign stages a preview under `<storageKey>-preview` and returns previewUrl', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    await vl.writeEntry(makeEntry({ voiceUuid: 're-1', name: 'Nova', provenance: 'designed' }));

    const res = await request(app)
      .post('/api/voice-library/re-1/redesign')
      .send({ persona: 'a brighter, warmer read' });

    expect(res.status).toBe(200);
    expect(res.body.previewUrl).toMatch(/^\/audio\/voices\/qwen-re-1-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.voiceId).toBe('qwen-re-1-preview');
    expect(sent.instruct).toBe('a brighter, warmer read');
  });

  it('redesign 404s for an unknown uuid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    const res = await request(app).post('/api/voice-library/nope/redesign').send({ persona: 'p' });
    expect(res.status).toBe(404);
  });

  it('redesign/promote swaps the live .pt with the preview and bumps updatedAt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    const { writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });

    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'promo-1',
        provenance: 'designed',
        persona: 'old persona',
        engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
      }),
    );
    const before = await vl.readEntry('promo-1');

    const liveP = qwenVoice.qwenVoicePtPath('qwen-promo-1');
    const previewP = qwenVoice.qwenVoicePtPath('qwen-promo-1-preview');
    wf(liveP, 'LIVE');
    wf(previewP, 'PREVIEW');
    wf(paths.qwenVoiceSidecarPath('qwen-promo-1'), JSON.stringify({ instruct: 'old' }));
    wf(paths.qwenVoiceSidecarPath('qwen-promo-1-preview'), JSON.stringify({ instruct: 'new' }));

    await new Promise((r) => setTimeout(r, 5)); // guarantee a distinct updatedAt
    const res = await request(app)
      .post('/api/voice-library/promo-1/redesign/promote')
      .send({ persona: 'new persona' });

    expect(res.status).toBe(200);
    expect(readFileSync(liveP, 'utf8')).toBe('PREVIEW'); // preview promoted onto live
    expect(existsSync(previewP)).toBe(false); // staged preview consumed
    const after = await vl.readEntry('promo-1');
    expect(after?.persona).toBe('new persona');
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
      new Date(before!.updatedAt).getTime(),
    );
  });

  it('redesign/discard removes the preview and leaves the live .pt untouched', async () => {
    const { writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });

    await vl.writeEntry(makeEntry({ voiceUuid: 'disc-1', provenance: 'designed' }));
    const liveP = qwenVoice.qwenVoicePtPath('qwen-disc-1');
    const previewP = qwenVoice.qwenVoicePtPath('qwen-disc-1-preview');
    wf(liveP, 'LIVE');
    wf(previewP, 'PREVIEW');

    const res = await request(app).post('/api/voice-library/disc-1/redesign/discard').send({});

    expect(res.status).toBe(200);
    expect(existsSync(previewP)).toBe(false); // preview dropped
    expect(readFileSync(liveP, 'utf8')).toBe('LIVE'); // live never touched
  });

  it('promote 409s when nothing was staged', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'nostage-1', provenance: 'designed' }));
    const res = await request(app).post('/api/voice-library/nostage-1/redesign/promote').send({});
    expect(res.status).toBe(409);
  });

  it('404s design-lifecycle routes for an unknown uuid', async () => {
    const r1 = await request(app).post('/api/voice-library/nope/redesign/promote').send({});
    expect(r1.status).toBe(404);
    const r2 = await request(app).post('/api/voice-library/nope/redesign/discard').send({});
    expect(r2.status).toBe(404);
  });
});

/* Task 11 — POST /api/voice-library/promote. Promotes a confirmed-cast
   character's designed Qwen voice into the standalone library: mints a NEW
   library uuid, resolves the character's TRUE source storage key the same
   way pickVoiceForEngine/qwenStorageKey does (so a matched/reused character
   copies from the SOURCE voice's `.pt`, not a nonexistent character-keyed
   one), byte-copies the `.pt`/`.json` sidecar under the new uuid, and never
   touches the origin character. */
describe('POST /api/voice-library/promote (Task 11)', () => {
  function castPathFor(bookDir: string) {
    return join(bookDir, '.audiobook', 'cast.json');
  }

  it('404s for an unknown bookId', async () => {
    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'no-such-book', characterId: 'char-a', name: 'Nova' });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-promo-1', [
      { id: 'char-a', name: 'A' },
    ]);
    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-1', characterId: 'no-such-char', name: 'Nova' });
    expect(res.status).toBe(404);
  });

  it('mints a new uuid, byte-copies the .pt/.json under the resolved source key, and stamps ready + baseModel', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(qwenVoice.qwenVoicePtPath('qwen-char-a'), 'MARKER-PT-BYTES');
    writeFileSync(
      paths.qwenVoiceSidecarPath('qwen-char-a'),
      JSON.stringify({ instruct: 'a warm narrator' }),
    );

    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-promo-2', [
      { id: 'char-a', name: 'A', voiceUuid: 'char-a', voiceStyle: 'a warm narrator' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-2', characterId: 'char-a', name: 'Nova' });

    expect(res.status).toBe(201);
    const entry = res.body as import('../workspace/voice-library.js').VoiceLibraryEntry;
    expect(entry.provenance).toBe('designed');
    expect(entry.name).toBe('Nova');
    expect(entry.persona).toBe('a warm narrator');
    expect(entry.promotedFrom).toEqual({ bookId: 'book-promo-2', characterId: 'char-a' });
    expect(entry.engines.qwen?.status).toBe('ready');
    expect(entry.engines.qwen?.baseModel).toBe(modelPaths.currentQwenBaseModel());
    expect(entry.voiceUuid).not.toBe('char-a'); // NEW uuid, not the character's own id/voiceUuid

    const newPtPath = qwenVoice.qwenVoicePtPath(`qwen-${entry.voiceUuid}`);
    expect(readFileSync(newPtPath, 'utf8')).toBe('MARKER-PT-BYTES');
    const newJsonPath = paths.qwenVoiceSidecarPath(`qwen-${entry.voiceUuid}`);
    expect(JSON.parse(readFileSync(newJsonPath, 'utf8'))).toEqual({ instruct: 'a warm narrator' });

    const onDisk = await vl.readEntry(entry.voiceUuid);
    expect(onDisk?.engines.qwen?.status).toBe('ready');
  });

  it('never modifies the origin character or cast.json (byte-identical before/after)', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(qwenVoice.qwenVoicePtPath('qwen-char-b'), 'ORIGIN-BYTES');

    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-promo-3',
      [{ id: 'char-b', name: 'B', voiceUuid: 'char-b', voiceStyle: 'a hushed whisper' }],
    );
    const before = readFileSync(castPathFor(bookDir), 'utf8');

    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-3', characterId: 'char-b', name: 'Whisper' });

    expect(res.status).toBe(201);
    const after = readFileSync(castPathFor(bookDir), 'utf8');
    expect(after).toBe(before); // byte-identical — origin cast.json untouched
  });

  it('a matched/reused character resolves the SOURCE voice uuid, not a nonexistent character-keyed one', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    // The character's OWN id-derived storage key has nothing on disk — only
    // the matched SOURCE voice's key (its voiceUuid, from a different
    // character) does. Resolution must follow voiceUuid, not characterId.
    writeFileSync(qwenVoice.qwenVoicePtPath('qwen-shared-source-uuid'), 'SHARED-SOURCE-BYTES');

    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-promo-4', [
      {
        id: 'char-reused',
        name: 'Reused',
        voiceUuid: 'shared-source-uuid', // matched to another voice's uuid
        voiceStyle: 'a gravelly smuggler',
      },
    ]);

    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-4', characterId: 'char-reused', name: 'Smuggler' });

    expect(res.status).toBe(201);
    const entry = res.body as import('../workspace/voice-library.js').VoiceLibraryEntry;
    const newPtPath = qwenVoice.qwenVoicePtPath(`qwen-${entry.voiceUuid}`);
    expect(readFileSync(newPtPath, 'utf8')).toBe('SHARED-SOURCE-BYTES');
    expect(entry.engines.qwen?.status).toBe('ready');
  });

  it('a library-assigned character resolves via overrideTtsVoices.qwen.libraryUuid, not the character-keyed derivation', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    // The character's OWN id-derived storage key has nothing on disk — only
    // the library-assigned voice's key (qwen-libX, set by /assign, which
    // never touches character.voiceUuid) does. Resolution must follow
    // overrideTtsVoices.qwen.libraryUuid, mirroring pickVoiceForEngine.
    writeFileSync(qwenVoice.qwenVoicePtPath('qwen-libX'), 'LIBRARY-ASSIGNED-BYTES');

    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-promo-6', [
      {
        id: 'char-assigned',
        name: 'Assigned',
        // No own voiceUuid — assignment lives entirely in overrideTtsVoices.
        overrideTtsVoices: {
          qwen: { name: 'qwen-libX', libraryUuid: 'libX', provenance: 'designed' },
        },
      },
    ]);

    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-6', characterId: 'char-assigned', name: 'Assigned Voice' });

    expect(res.status).toBe(201);
    const entry = res.body as import('../workspace/voice-library.js').VoiceLibraryEntry;
    const newPtPath = qwenVoice.qwenVoicePtPath(`qwen-${entry.voiceUuid}`);
    expect(readFileSync(newPtPath, 'utf8')).toBe('LIBRARY-ASSIGNED-BYTES');
    expect(entry.engines.qwen?.status).toBe('ready');
  });

  it('missing source .pt → entry created with stale status, no throw (still 201)', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-promo-5', [
      { id: 'char-c', name: 'C', voiceStyle: 'a bright, chipper voice' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'book-promo-5', characterId: 'char-c', name: 'Chipper' });

    expect(res.status).toBe(201);
    const entry = res.body as import('../workspace/voice-library.js').VoiceLibraryEntry;
    expect(entry.engines.qwen?.status).toBe('stale');
    expect(entry.persona).toBe('a bright, chipper voice');
  });
});

describe('POST /api/voice-library/clone-sample (Task 6)', () => {
  it('POST /clone-sample ingests an uploaded clip → 202 candidate', async () => {
    const { encodePcmToWav } = await import('../tts/wav.js');
    const n = 6 * 24_000;
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? -8000 : 8000, i * 2);
    const wav = encodePcmToWav(pcm, 24_000);
    const res = await request(app)
      .post('/api/voice-library/clone-sample')
      .field('captureMethod', 'upload')
      .attach('audio', wav, 'sample.wav');
    expect(res.status).toBe(202);
    expect(res.body.candidateId).toBeTruthy();
    expect(res.body.transcript).toBe('hello there');
  });

  it('POST /clone-sample rejects a too-short clip → 400', async () => {
    const { encodePcmToWav } = await import('../tts/wav.js');
    const n = 2 * 24_000;
    const wav = encodePcmToWav(Buffer.alloc(n * 2, 40), 24_000);
    const res = await request(app).post('/api/voice-library/clone-sample').attach('audio', wav, 's.wav');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/voice-library/clone (fs-38 Wave 3b1)', () => {
  it('derives, previews, scores, and persists a ready cloned entry — removing the candidate', async () => {
    // Arrange: seed a candidate on disk via the 3a candidate store.
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-1',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFFfake-wav-bytes'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-1',
        consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.provenance).toBe('cloned');
    expect(res.body.engines.qwen.status).toBe('ready');
    expect(res.body.consent.attestedBy).toBe('Mum');
    expect(res.body.master.clipFile).toBe('master.wav');
    expect(res.body.sampleMeta.qualityChecks.cloneCosine).toBeTypeOf('number');

    const { readCandidate } = await import('../workspace/clone-candidate.js');
    expect(await readCandidate('cand-1')).toBeNull(); // candidate consumed
  });

  it('404s a missing candidate', async () => {
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({ candidateId: 'nope', consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' } });
    expect(res.status).toBe(404);
  });

  it('422s absent/invalid consent', async () => {
    const res = await request(app).post('/api/voice-library/clone').send({ candidateId: 'cand-x' });
    expect(res.status).toBe(422);
  });

  it('preserves a sidecar 503 (does not flatten to 502)', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-503',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    /* A REAL SidecarDesignError instance (not a plain Object.assign fake) —
       this is what actually crosses the deriveEngineArtifact module boundary
       in production, so it pins the route's duck-typed catch (C1) against a
       genuine cross-module instance, not just a structurally-equal double. */
    deriveMock.mockRejectedValueOnce(new SidecarDesignError('no capacity', 503));
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({ candidateId: 'cand-503', consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' } });
    expect(res.status).toBe(503);
  });

  it('clamps a sidecar status-0 (unreachable) to 502, not a RangeError 500', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-0',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    /* deriveEngineArtifact throws SidecarDesignError(..., 0) on the
       sidecar-unreachable branch — res.status(0) is an invalid Express/Node
       status code (RangeError) that would otherwise flatten to a generic
       HTML 500, defeating the status-preservation invariant this suite
       pins. The route clamps any out-of-range status to 502. */
    deriveMock.mockRejectedValueOnce(new SidecarDesignError('unreachable', 0));
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({ candidateId: 'cand-0', consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' } });
    expect(res.status).toBe(502);
  });

  it('atomicity: a derive throw leaves NO entry and keeps the candidate', async () => {
    const { writeCandidate, readCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-fail',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    deriveMock.mockRejectedValueOnce(new SidecarDesignError('boom', 502));
    await request(app)
      .post('/api/voice-library/clone')
      .send({ candidateId: 'cand-fail', consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' } });
    const { listEntries } = await import('../workspace/voice-library.js');
    expect((await listEntries()).filter((e) => e.provenance === 'cloned')).toHaveLength(0);
    expect(await readCandidate('cand-fail')).not.toBeNull(); // candidate intact
  });

  /* Task 10 follow-up — a TRANSPORT failure of the advisory ECAPA fidelity
     check must not orphan an otherwise-successful clone. By this point the
     sidecar has already written the .pt artifact (deriveEngineArtifact
     succeeded); only the /embed cosine check is unreachable. */
  it('persists without a cosine when the ECAPA embed is unreachable (transient) — candidate still removed', async () => {
    const { writeCandidate, readCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-transient',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    assessFidelityMock.mockRejectedValueOnce(Object.assign(new Error('embed down'), { transient: true }));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-transient',
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.sampleMeta.qualityChecks.cloneFidelityUnavailable).toBe(true);
    expect(res.body.sampleMeta.qualityChecks.cloneCosine).toBeUndefined();

    expect(await readCandidate('cand-transient')).toBeNull(); // candidate consumed, same as the happy path
  });

  it('still aborts (and persists nothing) on a genuine SidecarDesignError from the fidelity check', async () => {
    const { writeCandidate, readCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-fidelity-sde',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    // A REAL SidecarDesignError instance — not merely `{ transient: true }` —
    // proving the catch doesn't over-broaden past the transient duck-type.
    assessFidelityMock.mockRejectedValueOnce(new SidecarDesignError('sidecar overloaded', 503));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-fidelity-sde',
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(503);
    const { listEntries } = await import('../workspace/voice-library.js');
    expect((await listEntries()).filter((e) => e.provenance === 'cloned')).toHaveLength(0);
    expect(await readCandidate('cand-fidelity-sde')).not.toBeNull(); // candidate intact, nothing persisted
  });
});

describe('POST /api/voice-library/:voiceUuid/revoke (Task 8)', () => {
  it('stamps revokedAt on a cloned entry with a valid consent record', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'r1',
        name: 'Dad',
        provenance: 'cloned',
        consent: {
          personName: 'Dad',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'me',
        },
      }),
    );

    const res = await request(app).post('/api/voice-library/r1/revoke');

    expect(res.status).toBe(200);
    expect(res.body.consent.revokedAt).toBeTruthy();
  });

  it('404s an unknown entry', async () => {
    const res = await request(app).post('/api/voice-library/nope/revoke');
    expect(res.status).toBe(404);
  });

  /* Wave 3b2, Task 3 — revoke now purges resynthesis-capable clone
     artifacts via purgeCloneArtifacts, WITHOUT deleting the entry dir: the
     manifest (voice.json) + retained clip (master.wav) stay readable so the
     revoked entry is still visible/inspectable in the library, just no
     longer resynthesisable. Proven via real erasure effects (not a spy) —
     see the file-header note above the hoisted mocks for why a self-mocked
     spy on purgeCloneArtifacts was rejected. */
  it('purges clone artifacts (no deleteEntryDir) and leaves voice.json + master.wav readable', async () => {
    const voiceUuid = 'r-purge-1';
    await vl.writeEntry(
      makeEntry({
        voiceUuid,
        name: 'Dad',
        provenance: 'cloned',
        consent: {
          personName: 'Dad',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'me',
        },
      }),
    );
    const masterPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(masterPath, 'fake-wav-bytes');

    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    const qwenName = `qwen-${voiceUuid}`;
    writeFileSync(qwenVoice.qwenVoicePtPath(qwenName), 'fake-pt-bytes');
    const pt17bPath = qwenVoice.qwenVoicePtPath(`${qwenName}__1.7b`);
    writeFileSync(pt17bPath, 'fake-1.7b-pt-bytes');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sidecar unreachable'));
    try {
      const res = await request(app).post(`/api/voice-library/${voiceUuid}/revoke`);

      expect(res.status).toBe(200);
      expect(res.body.consent.revokedAt).toBeTruthy();

      // The engine artifacts (resynthesis-capable) are purged...
      expect(existsSync(qwenVoice.qwenVoicePtPath(qwenName))).toBe(false);
      expect(existsSync(pt17bPath)).toBe(false);
      // ...but the manifest dir + retained clip survive (no deleteEntryDir).
      expect(existsSync(masterPath)).toBe(true);
      const onDisk = await vl.readEntry(voiceUuid);
      expect(onDisk?.consent?.revokedAt).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
