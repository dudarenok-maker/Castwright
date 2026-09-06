/* fs-38 Wave 1, Task 4 — GET /api/voice-library (list, pinned-first then
   updatedAt desc, with at-list-time staleness) + PATCH /api/voice-library/:voiceUuid
   (name/tags/pinned/persona edit).

   Mirrors the tempdir-workspace integration pattern used by
   workspace/voice-library.test.ts and routes/voices.test.ts: mkdtempSync +
   WORKSPACE_DIR env + vi.resetModules() so paths.ts / model-paths.ts re-read
   their env-derived state fresh per test, then a real express app mounting
   the router exactly as app.ts does. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { SidecarDesignError } from '../tts/design-voice-core.js';

/* runVoiceDesign's POST to /qwen/design-voice moved to undici's fetch (it needs
   DESIGN_DISPATCHER so its 600s ceiling isn't preempted by undici's hidden
   300s cap), so a `vi.spyOn(globalThis,'fetch')` alone no longer intercepts it
   — these tests were reaching the real sidecar and 502ing. Route undici at the
   same global stub each test installs, so one `spyOn` still covers both. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';

/* #1981 — minimal local shape for the cast.json read in the race test below.
   `CastJson` in ./voice-library.ts is not exported (route-file-local); this
   mirrors only the fields that test actually asserts on. */
interface CastJson {
  characters?: Array<{ id: string; overrideTtsVoices?: { qwen?: { libraryUuid?: string } } }>;
}

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
let setUserSettingsCacheForTest: typeof import('../workspace/user-settings.js')._setUserSettingsCacheForTest;
let paths: typeof import('../workspace/paths.js');
let qwenVoice: typeof import('./qwen-voice.js');
let sampleCache: typeof import('../tts/voice-sample-cache.js');
let coquiVersionState: typeof import('../tts/coqui-version-state.js');

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  /* `undefined` omits the key entirely; `null` writes the explicit
     "detection surrendered" state. Both mean unset and must behave
     identically (#1998) — passing null is how a test pins that. */
  language?: string | null,
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
      ...(language !== undefined ? { language } : {}),
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

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factories above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { voiceLibraryRouter } = await import('./voice-library.js');
  const voiceLibMod = await import('../workspace/voice-library.js');
  const modelPathsMod = await import('../tts/model-paths.js');
  const userSettings = await import('../workspace/user-settings.js');
  const pathsMod = await import('../workspace/paths.js');
  const qwenVoiceMod = await import('./qwen-voice.js');
  const sampleCacheMod = await import('../tts/voice-sample-cache.js');
  const coquiVersionStateMod = await import('../tts/coqui-version-state.js');
  vl = voiceLibMod;
  modelPaths = modelPathsMod;
  setUserSettingsCacheForTest = userSettings._setUserSettingsCacheForTest;
  paths = pathsMod;
  qwenVoice = qwenVoiceMod;
  sampleCache = sampleCacheMod;
  coquiVersionState = coquiVersionStateMod;

  app = express();
  app.use(express.json());
  app.use('/api/voice-library', voiceLibraryRouter);

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
  // Use the actual current base model so cloned entries are fresh, not stale
  const currentModel = modelPaths.currentQwenBaseModel();
  deriveMock.mockResolvedValue({ previewPcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000, baseModel: currentModel });
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

  /* fs-38 Wave 3c, Task 18 — withComputedStaleness now recomputes the xtts
     slot too (via the same isArtifactVersionStale comparand the resolver
     pre-pass uses). Task 19 gave coqui a live "current installed coqui-tts
     version" oracle (getLastKnownCoquiVersion(), fed by the sidecar's
     /health poll) — but BEFORE the first reachable poll (this test's own
     starting state: a fresh module import via beforeEach's resetModules,
     never seeded) it still reads '', which isArtifactVersionStale treats as
     "unknown, never stale". This test pins that DELIBERATE, documented
     boot-window behaviour (not a bug): a coqui-cloned voice with a real
     recorded coquiVersion never spontaneously reads 'stale' before the
     oracle has a real value, and — the sibling-preservation half —
     recomputing xtts must never disturb an independently-stale qwen slot on
     the SAME entry, or vice versa. See the NEXT test for the oracle
     actually firing once seeded. */
  it('recomputes the xtts slot alongside qwen: a real recorded coquiVersion never reads stale before the oracle has been seeded (boot window), and each engine slot is computed independently of the other', async () => {
    const current = modelPaths.currentQwenBaseModel();
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'mixed-1',
        engines: {
          qwen: { status: 'ready', baseModel: 'some/other-model' }, // stale
          xtts: { status: 'ready', coquiVersion: 'v2.0.3' }, // NOT stale — no oracle
        },
      }),
    );
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'mixed-2',
        engines: {
          qwen: { status: 'ready', baseModel: current }, // fresh
          xtts: { status: 'ready', coquiVersion: '' }, // older-sidecar fallback — never stale
        },
      }),
    );

    const res = await request(app).get('/api/voice-library');
    const byId = new Map(
      (
        res.body.voices as Array<{
          voiceUuid: string;
          engines: { qwen?: { status: string }; xtts?: { status: string } };
        }>
      ).map((v) => [v.voiceUuid, v]),
    );

    // qwen's own staleness is unaffected by adding the xtts recomputation.
    expect(byId.get('mixed-1')?.engines.qwen?.status).toBe('stale');
    expect(byId.get('mixed-2')?.engines.qwen?.status).toBe('ready');
    // xtts never reads 'stale' here — the oracle (getLastKnownCoquiVersion())
    // is a fresh, never-seeded module instance in this test (boot window),
    // so it reads '' regardless of whether the stored coquiVersion is real
    // or empty — and each entry's own computation doesn't leak the other's
    // qwen staleness onto xtts. See the NEXT test for the oracle actually
    // firing once seeded with a real value.
    expect(byId.get('mixed-1')?.engines.xtts?.status).toBe('ready');
    expect(byId.get('mixed-2')?.engines.xtts?.status).toBe('ready');

    // On-disk manifest is untouched for both slots.
    const onDisk = await vl.readEntry('mixed-1');
    expect(onDisk?.engines.qwen?.status).toBe('ready');
    expect(onDisk?.engines.xtts?.status).toBe('ready');
  });

  /* fs-38 Wave 3c, Task 19 — the coverage gap Task 18 explicitly could not
     close: a test that FAILS if the xtts staleness-recompute block is
     deleted. Task 18's own version could not, because production's coqui
     current-version was hardcoded '' — every case read 'ready' whether or
     not the block ran. Now that getLastKnownCoquiVersion() is a real,
     seedable oracle, a genuine mismatch must flip xtts to 'stale', and a
     genuine match must NOT — proving the block is load-bearing, not
     inert. */
  it('flips xtts to stale once the coqui-version oracle is seeded with a MISMATCHING version, and stays ready on a match', async () => {
    coquiVersionState.setLastKnownCoquiVersion('0.28.0');
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'live-oracle-mismatch',
        engines: { xtts: { status: 'ready', coquiVersion: '0.27.5' } }, // stale — mismatch
      }),
    );
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'live-oracle-match',
        engines: { xtts: { status: 'ready', coquiVersion: '0.28.0' } }, // fresh — matches
      }),
    );

    const res = await request(app).get('/api/voice-library');
    const byId = new Map(
      (
        res.body.voices as Array<{ voiceUuid: string; engines: { xtts?: { status: string } } }>
      ).map((v) => [v.voiceUuid, v]),
    );

    expect(byId.get('live-oracle-mismatch')?.engines.xtts?.status).toBe('stale');
    expect(byId.get('live-oracle-match')?.engines.xtts?.status).toBe('ready');

    // On-disk manifest is untouched — staleness is computed at list time only.
    const onDisk = await vl.readEntry('live-oracle-mismatch');
    expect(onDisk?.engines.xtts?.status).toBe('ready');
  });

  /* Plan 276, Task 3 (Decision 2 [R3]) — a persisted `failed` status must
     survive this list-time computation UNTOUCHED, even when its version
     stamp is outdated. Before the fix, `withComputedStaleness` rewrote a
     failed-but-outdated slot to 'stale', so the client (which only ever
     sees the post-transform value) could never observe `derive-failed`
     even though the render's own raw-status check hard-fails on exactly
     that class first (`clone-voice-resolver.ts:238`). Pinned on BOTH
     engine branches — #1933 shipped ten instances of engine-parameterised
     behaviour pinned in only one direction; mutation: drop either
     `!== 'failed'` guard -> its own test reddens (and only its own). */
  it('leaves a failed qwen slot as failed even when its baseModel is outdated', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'failed-qwen-1',
        engines: { qwen: { status: 'failed', baseModel: 'some/other-model' } },
      }),
    );

    const res = await request(app).get('/api/voice-library');
    const byId = new Map(
      (res.body.voices as Array<{ voiceUuid: string; engines: { qwen?: { status: string } } }>).map((v) => [
        v.voiceUuid,
        v,
      ]),
    );
    expect(byId.get('failed-qwen-1')?.engines.qwen?.status).toBe('failed');
  });

  it('leaves a failed xtts slot as failed even when its coquiVersion is outdated', async () => {
    coquiVersionState.setLastKnownCoquiVersion('0.28.0');
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'failed-xtts-1',
        engines: { xtts: { status: 'failed', coquiVersion: '0.27.5' } },
      }),
    );

    const res = await request(app).get('/api/voice-library');
    const byId = new Map(
      (res.body.voices as Array<{ voiceUuid: string; engines: { xtts?: { status: string } } }>).map((v) => [
        v.voiceUuid,
        v,
      ]),
    );
    expect(byId.get('failed-xtts-1')?.engines.xtts?.status).toBe('failed');
  });

  /* The complement of the two tests above: the new `!== 'failed'` guard
     must not accidentally narrow the override to only ONE other status
     (e.g. a wrong fix reading `status === 'ready'` instead of
     `!== 'failed'`) — 'deriving' and an already-'stale' persisted status
     must still recompute to 'stale' on an outdated stamp, on both engine
     branches. Mutation: narrow either guard to `=== 'ready'` -> the
     'deriving'/'stale' cases redden; narrow it to `=== 'deriving'` -> the
     'ready' case (covered by the pre-existing tests above) reddens too. */
  it.each(['ready', 'deriving', 'stale'] as const)(
    'still flips a %s qwen/xtts slot to stale when its version stamp is outdated',
    async (status) => {
      coquiVersionState.setLastKnownCoquiVersion('0.28.0');
      await vl.writeEntry(
        makeEntry({
          voiceUuid: `other-status-${status}`,
          engines: {
            qwen: { status, baseModel: 'some/other-model' },
            xtts: { status, coquiVersion: '0.27.5' },
          },
        }),
      );

      const res = await request(app).get('/api/voice-library');
      const entry = (
        res.body.voices as Array<{
          voiceUuid: string;
          engines: { qwen?: { status: string }; xtts?: { status: string } };
        }>
      ).find((v) => v.voiceUuid === `other-status-${status}`);

      expect(entry?.engines.qwen?.status).toBe('stale');
      expect(entry?.engines.xtts?.status).toBe('stale');
    },
  );
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

  /* Plan 276, Task 4 (Decision 6) — `transcript` becomes an editable field
     on a cloned voice, making the cast-time gate's "Add transcript" CTA
     real. */
  describe('transcript edit (plan 276, Decision 6)', () => {
    function makeClonedMasterEntry(
      voiceUuid: string,
      overrides: Partial<import('../workspace/voice-library.js').VoiceLibraryEntry> = {},
    ) {
      return makeEntry({
        voiceUuid,
        provenance: 'cloned',
        languageCode: 'en',
        consent: {
          personName: 'Dad',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'me',
        },
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 12,
          transcript: 'the original whisper transcript',
          transcriptSource: 'whisper',
          captureMethod: 'upload',
          languageCode: 'en',
        },
        sampleTranscript: 'the original whisper transcript',
        engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
        ...overrides,
      });
    }

    it('rejects `transcript` on a designed entry with 400', async () => {
      await vl.writeEntry(makeEntry({ voiceUuid: 'transcript-designed-1', provenance: 'designed' }));

      const res = await request(app)
        .patch('/api/voice-library/transcript-designed-1')
        .send({ transcript: 'a new transcript' });

      expect(res.status).toBe(400);
      const onDisk = await vl.readEntry('transcript-designed-1');
      expect(onDisk?.master).toBeUndefined();
    });

    it('rejects `transcript` on a cloned entry with no master clip with 400', async () => {
      await vl.writeEntry(
        makeEntry({
          voiceUuid: 'transcript-nomaster-1',
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

      const res = await request(app)
        .patch('/api/voice-library/transcript-nomaster-1')
        .send({ transcript: 'a new transcript' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`transcript` can only be set on a cloned voice with a master clip.');
    });

    /* #2068 item 3 (fs-38) — the race this fix exists for: `master` WAS
       present when `existing` was read pre-lock, but is gone by the time
       `fresh` is read inside `updateEntry`'s lock. The old code returned
       200 having written nothing (the write was guarded on `fresh.master`,
       which was absent); the fix returns 409 Conflict and performs no write.

       A `readEntry` spy alone cannot simulate this: `updateEntry` calls
       `readEntry` internally (same module scope), so `vi.spyOn` on the
       module namespace does not intercept that call. Instead this test
       spies on `updateEntry` itself (an external call from the route),
       and inside the spy strips `master` from disk before delegating to
       the real `updateEntry` — so the real internal `fresh` read sees no
       master while the route's pre-lock `existing` read (which already
       completed before the spy ran) saw one. */
    it('returns 409 when master disappears between the pre-lock read and the lock', async () => {
      const entryWithMaster = makeClonedMasterEntry('transcript-race-1');
      await vl.writeEntry(entryWithMaster);

      const realUpdateEntry = vl.updateEntry;
      const updateSpy = vi.spyOn(vl, 'updateEntry').mockImplementation(async (uuid, mutate) => {
        // Simulate master disappearing between the pre-lock read and the lock:
        // strip master from disk, then delegate to the real updateEntry whose
        // internal fresh read will now see no master.
        const current = await vl.readEntry(uuid);
        if (current?.master) {
          await vl.writeEntry({ ...current, master: undefined });
        }
        return realUpdateEntry(uuid, mutate);
      });

      const res = await request(app)
        .patch('/api/voice-library/transcript-race-1')
        .send({ transcript: 'the corrected transcript' });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty('error');
      updateSpy.mockRestore();
    });

    it('rejects a non-string `transcript` with 400', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-nonstring-1'));

      const res = await request(app)
        .patch('/api/voice-library/transcript-nonstring-1')
        .send({ transcript: 12345 });

      expect(res.status).toBe(400);
      const onDisk = await vl.readEntry('transcript-nonstring-1');
      expect(onDisk?.master?.transcript).toBe('the original whisper transcript');
    });

    it('rejects a `transcript` over MAX_CLONE_TRANSCRIPT_CHARS with 400', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-toolong-1'));
      const tooLong = 'x'.repeat(2001);

      const res = await request(app)
        .patch('/api/voice-library/transcript-toolong-1')
        .send({ transcript: tooLong });

      expect(res.status).toBe(400);
      const onDisk = await vl.readEntry('transcript-toolong-1');
      expect(onDisk?.master?.transcript).toBe('the original whisper transcript');
    });

    it('persists a transcript edit on a cloned entry with transcriptSource "user"', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-edit-1'));

      const res = await request(app)
        .patch('/api/voice-library/transcript-edit-1')
        .send({ transcript: 'the corrected transcript' });

      expect(res.status).toBe(200);
      expect(res.body.master.transcript).toBe('the corrected transcript');
      expect(res.body.master.transcriptSource).toBe('user');

      const onDisk = await vl.readEntry('transcript-edit-1');
      expect(onDisk?.master?.transcript).toBe('the corrected transcript');
      expect(onDisk?.master?.transcriptSource).toBe('user');
    });

    it('updates `sampleTranscript` in the SAME write as the transcript edit', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-sample-1'));

      const res = await request(app)
        .patch('/api/voice-library/transcript-sample-1')
        .send({ transcript: 'the corrected transcript' });

      expect(res.status).toBe(200);
      expect(res.body.sampleTranscript).toBe('the corrected transcript');
      const onDisk = await vl.readEntry('transcript-sample-1');
      expect(onDisk?.sampleTranscript).toBe('the corrected transcript');
    });

    it('clears both language stamps (master.languageCode and entry.languageCode) on a transcript edit, rather than leaving them contradicting the new text', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-lang-1'));

      const res = await request(app)
        .patch('/api/voice-library/transcript-lang-1')
        .send({ transcript: 'un texte corrigé en français' });

      expect(res.status).toBe(200);
      expect(res.body.languageCode).toBeUndefined();
      expect(res.body.master.languageCode).toBeUndefined();

      const onDisk = await vl.readEntry('transcript-lang-1');
      expect(onDisk?.languageCode).toBeUndefined();
      expect(onDisk?.master?.languageCode).toBeUndefined();
    });

    it('clears a `failed` qwen slot when the new transcript is non-empty', async () => {
      await vl.writeEntry(
        makeClonedMasterEntry('transcript-clearsfail-1', {
          engines: { qwen: { status: 'failed', baseModel: 'old' } },
        }),
      );

      const res = await request(app)
        .patch('/api/voice-library/transcript-clearsfail-1')
        .send({ transcript: 'the fix that unblocks a derive' });

      expect(res.status).toBe(200);
      expect(res.body.engines.qwen).toBeUndefined();
      const onDisk = await vl.readEntry('transcript-clearsfail-1');
      expect(onDisk?.engines.qwen).toBeUndefined();
    });

    it('does NOT clear a `failed` qwen slot when the new transcript is blank', async () => {
      await vl.writeEntry(
        makeClonedMasterEntry('transcript-blankfail-1', {
          engines: { qwen: { status: 'failed', baseModel: 'old' } },
        }),
      );

      const res = await request(app)
        .patch('/api/voice-library/transcript-blankfail-1')
        .send({ transcript: '' });

      expect(res.status).toBe(200);
      expect(res.body.engines.qwen).toEqual({ status: 'failed', baseModel: 'old' });
      const onDisk = await vl.readEntry('transcript-blankfail-1');
      expect(onDisk?.engines.qwen).toEqual({ status: 'failed', baseModel: 'old' });
    });

    it('leaves a HEALTHY (non-failed) qwen slot untouched by a transcript edit', async () => {
      await vl.writeEntry(
        makeClonedMasterEntry('transcript-healthyslot-1', {
          engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
        }),
      );

      const res = await request(app)
        .patch('/api/voice-library/transcript-healthyslot-1')
        .send({ transcript: 'a corrected transcript' });

      expect(res.status).toBe(200);
      expect(res.body.engines.qwen).toEqual({ status: 'ready', baseModel: modelPaths.currentQwenBaseModel() });
      const onDisk = await vl.readEntry('transcript-healthyslot-1');
      expect(onDisk?.engines.qwen).toEqual({ status: 'ready', baseModel: modelPaths.currentQwenBaseModel() });
    });

    /* The write must go through the shared, per-uuid-locked `updateEntry`
       RMW — spreading over a FRESH read taken UNDER the lock — never the
       route's own pre-lock `existing` read (see :569-577's comment; the
       same reasoning applies to this edit). Proven the same way
       workspace/voice-library.test.ts proves the lock itself: Caller A
       acquires the per-uuid lock FIRST (synchronously, before the PATCH
       request below is even dispatched) and holds it open on a manually
       released gate, so the PATCH handler's own unlocked `existing` read
       is forced to observe the PRE-A snapshot. If the handler's mutate
       based its write on that stale `existing` instead of the lock's own
       fresh read, A's concurrent xtts write would be silently erased. */
    it('writes the transcript edit through updateEntry, never a stale pre-lock snapshot', async () => {
      await vl.writeEntry(makeClonedMasterEntry('transcript-lock-1'));

      let releaseA: () => void = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const order: string[] = [];

      const pA = vl.updateEntry('transcript-lock-1', async (fresh) => {
        order.push('A-mutate-start');
        await gateA;
        order.push('A-write');
        return {
          ...fresh!,
          engines: { ...fresh!.engines, xtts: { status: 'ready', coquiVersion: 'v-set-by-A' } },
          /* A also touches `master`. Without this the two snapshots' `master`
             are byte-identical, so spreading `existing.master` instead of
             `fresh.master` inside the transcript edit is INVISIBLE — measured:
             that mutation left this test green while the `engines` assertion
             below still passed, because the root spread and the `master`
             sub-spread are two separate reads of two separate snapshots and
             only the first one was pinned. */
          master: { ...fresh!.master!, durationSeconds: 99 },
        };
      });

      const pPatch = request(app)
        .patch('/api/voice-library/transcript-lock-1')
        .send({ transcript: 'a corrected transcript' })
        .then((res) => {
          order.push('B-response');
          return res;
        });

      releaseA();
      const [, patchRes] = await Promise.all([pA, pPatch]);

      // B's response can only land after A's write completed — proof the
      // lock actually queued the PATCH's write, not just that both happened
      // to finish in some order.
      expect(order).toEqual(['A-mutate-start', 'A-write', 'B-response']);
      expect(patchRes.status).toBe(200);

      const final = await vl.readEntry('transcript-lock-1');
      // A's concurrent xtts write survives — the transcript edit's mutate
      // was based on the FRESH (post-A) entry, not the stale pre-lock read.
      expect(final?.engines.xtts).toEqual({ status: 'ready', coquiVersion: 'v-set-by-A' });
      expect(final?.master?.transcript).toBe('a corrected transcript');
      // ...and A's concurrent `master` write survives too — proof the
      // transcript edit spread `fresh.master`, not the pre-lock `existing`
      // one. The assertion above covers only the ROOT spread.
      expect(final?.master?.durationSeconds).toBe(99);
    });

    /* Plan 276 Decision 2 [R4]. `patchEntry.fulfilled`
       (src/store/voice-library-slice.ts:237-240) REPLACES the slice's entry
       with this response, so if PATCH returns the raw persisted status while
       GET returns the computed one, the client's copy silently downgrades
       after any edit — and `cloneReadiness`'s rules 6/7, gated on
       `slotStatus !== 'ready'`, stop firing. The plan's own "Add transcript"
       CTA triggers exactly this path.

       The fixture is the only shape where it shows: a slot that is `ready`
       on disk but version-stale, so the transform has something to change.
       A fixture stamped with the CURRENT baseModel passes either way. */
    it('returns the COMPUTED staleness, matching GET, not the raw persisted status', async () => {
      await vl.writeEntry(
        makeClonedMasterEntry('transcript-stale-1', {
          engines: { qwen: { status: 'ready', baseModel: 'an-old-base-model' } },
        }),
      );

      const listed = await request(app).get('/api/voice-library');
      const fromGet = listed.body.voices.find(
        (v: { voiceUuid: string }) => v.voiceUuid === 'transcript-stale-1',
      );
      expect(fromGet.engines.qwen.status).toBe('stale');

      const patched = await request(app)
        .patch('/api/voice-library/transcript-stale-1')
        .send({ name: 'a new name' });

      expect(patched.status).toBe(200);
      expect(patched.body.engines.qwen.status).toBe('stale');
      // The persisted value is untouched — this is a response transform, not a write.
      expect((await vl.readEntry('transcript-stale-1'))?.engines.qwen?.status).toBe('ready');
    });
  });
});

describe('POST /api/voice-library/:voiceUuid/engines/:engine/retry (plan 276, Decision 7)', () => {
  function makeClonedEntry(
    voiceUuid: string,
    overrides: Partial<import('../workspace/voice-library.js').VoiceLibraryEntry> = {},
  ) {
    return makeEntry({
      voiceUuid,
      provenance: 'cloned',
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
      master: {
        clipFile: 'master.wav',
        sampleRate: 24_000,
        durationSeconds: 12,
        transcript: 'the original whisper transcript',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      ...overrides,
    });
  }

  it('deletes the slot key for a `failed` qwen slot', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-qwen-failed-1', {
        engines: { qwen: { status: 'failed', baseModel: 'old' } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-qwen-failed-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.qwen).toBeUndefined();
    const onDisk = await vl.readEntry('retry-qwen-failed-1');
    expect(onDisk?.engines.qwen).toBeUndefined();
    expect('qwen' in (onDisk?.engines ?? {})).toBe(false);
  });

  /* Invariant 2 (plan 276) — library slots are keyed `qwen` / `xtts`, but the
     ENGINE name for Coqui is `coqui`. The route must map `coqui` -> `xtts`
     via `manifestSlotFor`, never index `entry.engines.coqui` (which doesn't
     exist on the type at all). Reached via the engine name, not the slot
     key, so a wrong-slot mapping bug is exactly what this catches. */
  it('deletes the slot key for a `failed` xtts slot, reached via engine name `coqui`', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-xtts-failed-1', {
        engines: { xtts: { status: 'failed', coquiVersion: 'old' } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-xtts-failed-1/engines/coqui/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.xtts).toBeUndefined();
    const onDisk = await vl.readEntry('retry-xtts-failed-1');
    expect(onDisk?.engines.xtts).toBeUndefined();
    expect('xtts' in (onDisk?.engines ?? {})).toBe(false);
  });

  it('is a no-op on a `ready` slot', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-ready-1', {
        engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-ready-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.qwen).toEqual({ status: 'ready', baseModel: modelPaths.currentQwenBaseModel() });
    const onDisk = await vl.readEntry('retry-ready-1');
    expect(onDisk?.engines.qwen).toEqual({ status: 'ready', baseModel: modelPaths.currentQwenBaseModel() });
  });

  it('is a no-op on an absent slot', async () => {
    await vl.writeEntry(makeClonedEntry('retry-absent-1', { engines: {} }));

    const res = await request(app).post('/api/voice-library/retry-absent-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines).toEqual({});
    const onDisk = await vl.readEntry('retry-absent-1');
    expect(onDisk?.engines).toEqual({});
  });

  it('rejects a non-clone-capable engine with 400', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-badengine-1', {
        engines: { qwen: { status: 'failed', baseModel: 'old' } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-badengine-1/engines/kokoro/retry');

    expect(res.status).toBe(400);
    const onDisk = await vl.readEntry('retry-badengine-1');
    expect(onDisk?.engines.qwen).toEqual({ status: 'failed', baseModel: 'old' });
  });

  it('404s on an unknown uuid', async () => {
    const res = await request(app).post('/api/voice-library/does-not-exist/engines/qwen/retry');

    expect(res.status).toBe(404);
  });

  it('leaves `master`, the clip and the OTHER engine slot untouched', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-survives-1', {
        engines: {
          qwen: { status: 'failed', baseModel: 'old' },
          xtts: { status: 'ready', coquiVersion: 'v1' },
        },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-survives-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.xtts).toEqual({ status: 'ready', coquiVersion: 'v1' });
    expect(res.body.master.clipFile).toBe('master.wav');
    expect(res.body.master.transcript).toBe('the original whisper transcript');

    const onDisk = await vl.readEntry('retry-survives-1');
    expect(onDisk?.engines.xtts).toEqual({ status: 'ready', coquiVersion: 'v1' });
    expect(onDisk?.master?.clipFile).toBe('master.wav');
    expect(onDisk?.master?.transcript).toBe('the original whisper transcript');
  });

  /* Modeled on the transcript-edit lock fixture above (PATCH describe,
     `writes the transcript edit through updateEntry, never a stale
     pre-lock snapshot`) — that fixture's concurrent writer (A) mutates BOTH
     `engines` and `master` so pinning only one of a handler's reads of the
     fresh snapshot can't hide behind the other still passing. A holds the
     per-uuid lock first and blocks inside it on a manually-released gate,
     forcing this route's own write to queue behind A's if (and only if) it
     goes through the same lock. If the route were reimplemented as an
     unlocked `readEntry` + `writeEntry` pair, its read would land on the
     PRE-A snapshot and its write would silently erase A's concurrent
     `xtts`/`master` changes. */
  it('goes through updateEntry, never a stale pre-lock snapshot', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-lock-1', {
        engines: { qwen: { status: 'failed', baseModel: 'old' } },
      }),
    );

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const order: string[] = [];

    const pA = vl.updateEntry('retry-lock-1', async (fresh) => {
      order.push('A-mutate-start');
      await gateA;
      order.push('A-write');
      return {
        ...fresh!,
        engines: { ...fresh!.engines, xtts: { status: 'ready', coquiVersion: 'v-set-by-A' } },
        master: { ...fresh!.master!, durationSeconds: 99 },
      };
    });

    const pRetry = request(app)
      .post('/api/voice-library/retry-lock-1/engines/qwen/retry')
      .then((res) => {
        order.push('B-response');
        return res;
      });

    releaseA();
    const [, retryRes] = await Promise.all([pA, pRetry]);

    expect(order).toEqual(['A-mutate-start', 'A-write', 'B-response']);
    expect(retryRes.status).toBe(200);

    const final = await vl.readEntry('retry-lock-1');
    // A's concurrent xtts + master writes survive — B's deletion was based
    // on the FRESH (post-A) entry, not a stale pre-lock read.
    expect(final?.engines.xtts).toEqual({ status: 'ready', coquiVersion: 'v-set-by-A' });
    expect(final?.master?.durationSeconds).toBe(99);
    // ...and B's own deletion of the failed qwen slot also landed.
    expect(final?.engines.qwen).toBeUndefined();
  });

  /* Plan 276 Decision 2 [R4] — the NO-OP path, which is where this matters
     most for the retry route. A `ready`-but-version-stale slot is both the
     case that no-ops here (nothing to clear) AND the case the transform
     rewrites, so it is the one shape where returning the entry raw changes
     the client's answer. The route's other paths delete the slot entirely,
     leaving nothing for the transform to touch. */
  it('no-op response carries the COMPUTED staleness, matching GET', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-stale-noop-1', {
        engines: { qwen: { status: 'ready', baseModel: 'an-old-base-model' } },
      }),
    );

    const listed = await request(app).get('/api/voice-library');
    const fromGet = listed.body.voices.find(
      (v: { voiceUuid: string }) => v.voiceUuid === 'retry-stale-noop-1',
    );
    expect(fromGet.engines.qwen.status).toBe('stale');

    const res = await request(app).post('/api/voice-library/retry-stale-noop-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.qwen.status).toBe('stale');
    // Still a no-op on disk — a response transform, not a write.
    expect((await vl.readEntry('retry-stale-noop-1'))?.engines.qwen).toEqual({
      status: 'ready',
      baseModel: 'an-old-base-model',
    });
  });

  /* #2068 item 4 (fs-38) — pinning an intentional ASYMMETRY, not an oversight.
     The sibling PATCH handler above ("rejects `transcript` on a cloned entry
     with no master clip with 400") guards on `provenance === 'cloned'` before
     it will touch `master`/`sampleTranscript`. This route has NO equivalent
     guard: it deletes a `failed` engine slot for `provenance === 'cloned'`
     exactly the same way it would for a `designed` entry (see the other
     tests in this block, none of which check provenance at all). Plan 276's
     Decision 7 (docs/features/archive/276-cast-time-derivability-warning.md)
     never conditions slot deletion on provenance — it reasons purely from
     slot status and the `classifyClonedVoice` precedence, and #2068's own
     resolution keeps it that way: a designed voice's failed slot may be
     cleared too, since that just lets the voice re-derive. Do NOT add a
     provenance guard here to "match" the PATCH route — that would contradict
     the decision this test pins.

     [regression test] The two tests below verify the SAME behavior for
     `provenance: cloned` and `provenance: designed` — if a future guard
     special-cases either, one test will go red. */
  it('deletes a `failed` slot on a `provenance: cloned` entry with no provenance guard (plan 276 Decision 7)', async () => {
    await vl.writeEntry(
      makeClonedEntry('retry-cloned-no-guard-1', {
        engines: { qwen: { status: 'failed', baseModel: 'old' } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-cloned-no-guard-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.qwen).toBeUndefined();
    const onDisk = await vl.readEntry('retry-cloned-no-guard-1');
    expect(onDisk?.provenance).toBe('cloned');
    expect('qwen' in (onDisk?.engines ?? {})).toBe(false);
  });

  it('deletes a `failed` slot on a `provenance: designed` entry, same as cloned (no guard)', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'retry-designed-no-guard-1',
        provenance: 'designed',
        engines: { qwen: { status: 'failed', baseModel: 'old' } },
      }),
    );

    const res = await request(app).post('/api/voice-library/retry-designed-no-guard-1/engines/qwen/retry');

    expect(res.status).toBe(200);
    expect(res.body.engines.qwen).toBeUndefined();
    const onDisk = await vl.readEntry('retry-designed-no-guard-1');
    expect(onDisk?.provenance).toBe('designed');
    expect('qwen' in (onDisk?.engines ?? {})).toBe(false);
  });
});

describe('DELETE /api/voice-library/:voiceUuid', () => {
  /* GATE 1 fix (C3) — the purge's `failed` array now DECIDES whether the
     manifest dir comes off and whether the route answers `deleted: true`, so
     the sidecar-evict outcome is load-bearing in this describe where it
     previously was not. Left unstubbed, these tests would depend on whatever
     happens to be listening on the dev box's sidecar port. Pin it to the
     honest default for a test environment — nothing listening, which Node's
     fetch surfaces as ECONNREFUSED and `isSidecarNotRunning` (Task 14a
     MEDIUM-1) correctly treats as "no cache to lose", i.e. a clean purge.
     Individual tests below re-stub it where the evict outcome IS the
     subject. */
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
     `rm`, not the sidecar.

     GATE 1 fix (C3) — the rejection is now an ECONNREFUSED one rather than a
     generic `Error('sidecar unreachable')`. That is what "unreachable" (this
     test's own stated scenario) actually looks like from Node's fetch, and
     it is the only rejection shape that still counts as a CLEAN purge — a
     generic error now means "cache state unknown", which deliberately
     retains the entry dir. The test's real subject (the `__1.7b.pt` unlink
     happening Node-side with no sidecar involved) is unchanged: fetch still
     rejects on every evict. */
  it('erases the qwen-<uuid>__1.7b.pt clone variant on delete (Node-side, sidecar unreachable)', async () => {
    const artifacts = await seedFullVoiceArtifacts('unused-17b');
    const qwenName = `qwen-unused-17b`;
    const pt17bPath = qwenVoice.qwenVoicePtPath(`${qwenName}__1.7b`);
    writeFileSync(pt17bPath, 'fake-1.7b-pt-bytes');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
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

  /* GATE 1 fix (C3). The bypass under test is NOT "does the response mention
     the failure" — it is that a DELETE whose purge left an artifact behind
     used to remove `voice.json`, the manifest BOTH consent gates read
     (`clonedVoiceLacksConsent` returns false for a null entry), leaving the
     survivor LESS gated after the delete than before it and with nothing left
     to revoke. So the test asserts the survivor is still gateable: it drives
     a real revoke through the retained entry afterwards and proves the
     /sample gate then 403s.

     The unlink is failed WITHOUT mocking `rm`: the `.pt` path is replaced by
     a directory, which `rm(path, { force: true })` (no `recursive`) rejects
     on — the same throw-from-rm path a Windows EBUSY takes into
     `unlinkTracked`'s catch, with no stub that could drift from real fs
     behaviour. */
  it('GATE 1 C3: a purge that leaves an artifact keeps the entry, reports deleted:false, and stays gateable', async () => {
    const voiceUuid = 'cloned-partial-1';
    await vl.writeEntry(
      makeEntry({
        voiceUuid,
        provenance: 'cloned',
        engines: { qwen: { status: 'ready' } },
        consent: {
          personName: 'Dad',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'me',
        },
      }),
    );
    const qwenName = `qwen-${voiceUuid}`;
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    const ptPath = qwenVoice.qwenVoicePtPath(qwenName);
    // A directory where the `.pt` should be — `rm` without `recursive` can't
    // remove it, so this artifact genuinely survives the purge.
    mkdirSync(ptPath, { recursive: true });
    writeFileSync(join(ptPath, 'holds-it-open'), 'x');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).delete(`/api/voice-library/${voiceUuid}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false); // never claims more than happened
    expect(res.body.artifactPurgeIncomplete).toBe(true);
    expect(res.body.artifactPurgeFailedPaths).toContain(ptPath);
    expect(existsSync(ptPath)).toBe(true); // the artifact really did survive

    // CodeQL #210/#224: console.warn fix — voiceUuid and failed.length are now
    // %s/%d placeholder arguments, not interpolated into the format string.
    // The format string must NOT contain the voiceUuid, and the voiceUuid must
    // be passed as a SEPARATE argument. Pre-fix (interpolated into format string),
    // reverting this assertion would require breaking the format string.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining(voiceUuid),
      voiceUuid,
      1, // purgeResult.failed.length
      expect.any(Array),
    );

    warnSpy.mockRestore();

    // The manifest — the ONLY thing the consent gates can read — is retained.
    const retained = await vl.readEntry(voiceUuid);
    expect(retained).not.toBeNull();
    expect(retained?.provenance).toBe('cloned');

    // ...and it is still revocable, so the survivor can still be gated.
    const revoke = await request(app).post(`/api/voice-library/${voiceUuid}/revoke`);
    expect(revoke.status).toBe(200);
    expect((await vl.readEntry(voiceUuid))?.consent?.revokedAt).toBeTruthy();

    // The gate now actually fires on the voice whose artifact is still there.
    const sample = await request(app)
      .post(`/api/voice-library/${voiceUuid}/sample`)
      .send({ text: 'Hello.' });
    expect(sample.status).toBe(403);
  });

  /* #1981 — the filed defect: the usage scan can pass a book, an assign can
     then plant a reference in that book, and the artifacts are erased
     afterwards — leaving a character pointing at a libraryUuid whose files
     are gone. `alice` starts unassigned so the assign has something to plant
     mid-delete; the delete is unconditionally confirmed since the race is
     about ordering, not the pre-flight 409. */
  it('does not leave a dangling reference when an assign races a voice delete', async () => {
    const uuid = 'race-erase-assign';
    const artifacts = await seedFullVoiceArtifacts(uuid);
    const bookId = 'book-erase-assign-race';
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', bookId, [
      { id: 'alice', name: 'Alice' },
    ]);

    await Promise.all([
      request(app).delete(`/api/voice-library/${uuid}?confirm=1`),
      request(app).post(`/api/voice-library/${uuid}/assign`)
        .send({ bookId, characterId: 'alice' }),
    ]);

    const cast = await readJson<CastJson>(castJsonPath(bookDir));
    const alice = cast?.characters?.find((c) => c.id === 'alice');
    const stillReferenced = alice?.overrideTtsVoices?.qwen?.libraryUuid === uuid;
    const artifactsGone = !existsSync(artifacts.ptPath);
    /* Either the assign lost (no reference) or it won (artifacts still there).
       Never both. */
    expect(stillReferenced && artifactsGone).toBe(false);
  });

  /* #1981 finding 2 (Task 4 review) — nothing exercised the `library-voice`
     lock itself, or the global `library-voice -> cast` order across the two
     routes that both take it (POST /assign and this DELETE). Both sides take
     the SAME order, so this can't AB/BA today — but if a future edit ever
     inverted either side, the two would deadlock on cast-lock.ts's
     no-timeout mutex with no diagnostic (see its header, rule 4). Race
     against a timeout sentinel, mirroring cast-lock.test.ts's own AB/BA
     test, so a regression fails fast in CI instead of hanging the run.

     Review round 2 (#1981) — `alice` MUST already reference `uuid` (same
     `overrideTtsVoices.qwen.libraryUuid` shape the 409 test above uses), not
     start unassigned. `library-voice` fully serialises the two requests, so
     with an unassigned `alice` the DELETE-first interleaving finds
     `scanLibraryVoiceUsage` empty and never calls
     `clearLibraryVoiceReferences` — meaning the DELETE never takes a cast
     lock at all, and this test would still pass even with `/assign`'s
     acquisition order inverted (proven: see the mutation-verification in
     task-5-report.md). Seeding an existing reference forces
     `usage.length > 0` on every interleaving, so `clearLibraryVoiceReferences`
     — and its nested `withCastLock` — always actually runs, which is what
     makes this test capable of catching an inverted order at all. */
  it('#1981 — a DELETE and an assign contending on the same uuid never deadlock', async () => {
    const uuid = 'race-lock-order';
    await seedFullVoiceArtifacts(uuid);
    const bookId = 'book-lock-order';
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', bookId, [
      {
        id: 'alice',
        name: 'Alice',
        overrideTtsVoices: { qwen: { name: `qwen-${uuid}`, libraryUuid: uuid } },
      },
    ]);

    const result = await Promise.race([
      Promise.all([
        request(app).delete(`/api/voice-library/${uuid}?confirm=1`),
        request(app).post(`/api/voice-library/${uuid}/assign`)
          .send({ bookId, characterId: 'alice' }),
      ]).then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000)),
    ]);
    expect(result).toBe('settled');
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

  it('POST /:uuid/sample 403s a cloned voice with no consent record at all (#1808 — a fully-absent consent block can only exist as legacy/corrupted on-disk state now that writeEntry() guards it, so seed the manifest directly)', async () => {
    mkdirSync(vl.entryDir('s-noconsent'), { recursive: true });
    writeFileSync(
      join(vl.entryDir('s-noconsent'), 'voice.json'),
      JSON.stringify({
        voiceUuid: 's-noconsent',
        name: 'Legacy',
        provenance: 'cloned',
        tags: [],
        pinned: false,
        engines: {},
        createdAt: 'x',
        updatedAt: 'x',
      }),
    );
    const res = await request(app).post('/api/voice-library/s-noconsent/sample').send({});
    expect(res.status).toBe(403);
  });

  /* #1801 — the sample route's failures arrive from a DIFFERENT layer than
     design/redesign's: `SidecarTtsProvider` throws a plain Error annotated
     `{ transient, status, poisoned }` (tts/sidecar.ts `throwForResponse`), or
     a `NoCapacityError` that carries no `.status` at all. Both used to flatten
     to 502, losing the retryable/"free VRAM" signal. */
  it('POST /:uuid/sample surfaces the sidecar status instead of flattening to 502', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-503', name: 'Nova', provenance: 'designed' }));
    synthesize.mockRejectedValueOnce(
      Object.assign(new Error('Local voice engine returned 503: model loading'), {
        transient: true,
        status: 503,
        poisoned: false,
      }),
    );
    const res = await request(app).post('/api/voice-library/sample-503/sample').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/model loading/);
  });

  it('POST /:uuid/sample maps a NoCapacityError (no .status) to 503, not 502', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-cap', name: 'Nova', provenance: 'designed' }));
    const { NoCapacityError } = await import('../tts/tts-errors.js');
    synthesize.mockRejectedValueOnce(new NoCapacityError('qwen', 4096, 'cuda:0'));
    const res = await request(app).post('/api/voice-library/sample-cap/sample').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/free VRAM/i);
  });

  it('POST /:uuid/sample still 502s a status-less failure (sidecar unreachable)', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-down', name: 'Nova', provenance: 'designed' }));
    synthesize.mockRejectedValueOnce(
      Object.assign(new Error('Local TTS sidecar not reachable at http://127.0.0.1:9000.'), {
        transient: true,
        cause: 'network',
      }),
    );
    const res = await request(app).post('/api/voice-library/sample-down/sample').send({});
    expect(res.status).toBe(502);
  });

  /* #1842 — the library card's preview follows the caller's Qwen tier
     (mirrors Task 3's cast-row fix, one level over: this route and
     design-voice-core.ts's library design/redesign path share the
     `qwen-<uuid>` cache scope, so they must land on the same filename for
     the same tier). Omitted modelKey keeps older callers on 0.6B; a
     non-Qwen modelKey is rejected outright since this route only ever
     synthesises `qwen-<uuid>`. */
  it('renders a library sample at the requested Qwen tier', async () => {
    await vl.writeEntry(makeEntry());

    const res = await request(app)
      .post('/api/voice-library/uuid-1/sample')
      .send({ modelKey: 'qwen3-tts-1.7b' });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('qwen3-tts-1.7b');
  });

  it('defaults to 0.6B when the caller sends no modelKey', async () => {
    await vl.writeEntry(makeEntry());

    const res = await request(app).post('/api/voice-library/uuid-1/sample').send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('qwen3-tts-0.6b');
  });

  it('rejects a modelKey that does not route to a clone-capable engine', async () => {
    await vl.writeEntry(makeEntry());

    const res = await request(app)
      .post('/api/voice-library/uuid-1/sample')
      .send({ modelKey: 'kokoro-v1' });

    expect(res.status).toBe(400);
  });

  /* fs-38 Wave 3c, Task 27 — before this task the route hardcoded
     `voiceName='qwen-<uuid>'`/`cacheScope='qwen-<uuid>'` regardless of the
     requested modelKey, so a `coqui-xtts-v2` request still auditioned the
     QWEN artifact. `engine` (the resolved TtsEngine) is asserted via the
     synth call's `voiceName` AND the returned url's cache scope — both
     must equal `cloneStorageKey('coqui', uuid)` == `xtts-<uuid>`, derived,
     not just shaped like it. */
  it('auditions the requested engine — a coqui-xtts-v2 request synthesises the xtts-<uuid> artifact', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-coqui', name: 'Nova' }));

    const res = await request(app)
      .post('/api/voice-library/sample-coqui/sample')
      .send({ modelKey: 'coqui-xtts-v2' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/audio\/voices\/xtts-sample-coqui-coqui-xtts-v2-[a-z0-9]+\.mp3$/);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const synthArgs = synthesize.mock.calls[0][0] as { voiceName: string; modelKey: string };
    expect(synthArgs.voiceName).toBe('xtts-sample-coqui');
    expect(synthArgs.modelKey).toBe('coqui-xtts-v2');
  });

  /* Proves the qwen and coqui auditions of the SAME library voice land on
     DISTINCT cache scopes (and so never collide/share a file), which is
     also what makes Task 13's per-engine storageKey purge able to reach
     each independently. */
  it('a qwen and a coqui audition of the same voice cache under distinct storageKey scopes', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-both', name: 'Nova' }));

    const qwenRes = await request(app)
      .post('/api/voice-library/sample-both/sample')
      .send({ modelKey: 'qwen3-tts-0.6b' });
    const coquiRes = await request(app)
      .post('/api/voice-library/sample-both/sample')
      .send({ modelKey: 'coqui-xtts-v2' });

    expect(qwenRes.status).toBe(200);
    expect(coquiRes.status).toBe(200);
    expect(qwenRes.body.url).not.toBe(coquiRes.body.url);
    expect(qwenRes.body.url).toContain('qwen-sample-both');
    expect(coquiRes.body.url).toContain('xtts-sample-both');
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  /* fs-38 Wave 3c, Task 27 — an engine whose artifact has never been
     derived (the sidecar's generic /synthesize handler 409s
     `voice_not_designed` for EVERY engine, per server/tts-sidecar/main.py)
     used to reach the caller as an opaque 502 (httpStatusForSidecarError
     only passes through 5xx) carrying the sidecar's raw JSON body as the
     message. It must now surface as a clean 409 naming the ENGINE that
     isn't ready — not a generic/qwen-flavoured message reused verbatim
     for coqui. */
  it('an un-derived engine returns a clear "not prepared yet" 409, not an opaque 502', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-undeer', name: 'Nova' }));
    synthesize.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Local voice engine returned 409: {"detail":"Voice \'xtts-sample-undeer\' has not been designed yet.","code":"voice_not_designed"}',
        ),
        { transient: false, status: 409, poisoned: false },
      ),
    );

    const res = await request(app)
      .post('/api/voice-library/sample-undeer/sample')
      .send({ modelKey: 'coqui-xtts-v2' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('voice_not_designed');
    expect(res.body.message).toMatch(/coqui/i);
    expect(res.body.message).not.toMatch(/\{"detail"/); // not the raw sidecar body
  });

  /* GATE 1 — the sidecar gained a DISTINCT `voice_language_unsupported` 409
     (a subclass of VoiceNotDesignedError carrying its own code, main.py's
     /synthesize handler). Its detail matches neither token in the arm above,
     so this route fell through to `httpStatusForSidecarError`, which
     deliberately never forwards a 4xx — the caller got an opaque 502 with the
     sidecar's raw JSON as the message. The rejection below is the real
     sidecar body verbatim, wrapped as sidecar.ts wraps it. */
  it('a language the loaded model cannot speak returns a 409 voice_language_unsupported, not an opaque 502', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'sample-badlang', name: 'Nova' }));
    synthesize.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Local voice engine returned 409: {"detail":"Voice \'xtts-sample-badlang\' cannot render in language \'cs\' — not supported by the loaded XTTS model (supported: [\'en\', \'es\', \'de\']).","code":"voice_language_unsupported"}',
        ),
        { transient: false, status: 409, poisoned: false },
      ),
    );

    const res = await request(app)
      .post('/api/voice-library/sample-badlang/sample')
      .send({ modelKey: 'coqui-xtts-v2' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('voice_language_unsupported');
    // Must not tell the user to prepare/re-derive the voice — that cannot help.
    expect(res.body.message).not.toMatch(/hasn't been prepared/i);
    expect(res.body.message).not.toMatch(/\{"detail"/); // not the raw sidecar body
  });
});

/* Finding 1 (#1842 review) — /design computed its cached audition's filename
   without the persona contentToken /:voiceUuid/sample folds in, so the two
   never actually agreed on a filename despite the module comments claiming
   they did: a card's first Play after designing always missed cache and
   re-synthesised. Proven behaviourally (a /sample call resolves the SAME
   cache entry /design just warmed — `cached: true`, no `synthesize` call),
   not by asserting on filename internals directly. */
describe('design → sample cache pairing (#1842 finding 1)', () => {
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

  it('a /sample call right after /design hits the SAME cached file design already warmed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const designRes = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator' });
    expect(designRes.status).toBe(201);
    const { voiceUuid } = designRes.body.entry as { voiceUuid: string };
    const previewUrl = designRes.body.previewUrl as string;

    const sampleRes = await request(app).post(`/api/voice-library/${voiceUuid}/sample`).send({});

    expect(sampleRes.status).toBe(200);
    expect(sampleRes.body.cached).toBe(true);
    expect(sampleRes.body.url).toBe(previewUrl);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('the pairing holds at the 1.7B tier too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const designRes = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator', modelKey: 'qwen3-tts-1.7b' });
    expect(designRes.status).toBe(201);
    const { voiceUuid } = designRes.body.entry as { voiceUuid: string };
    const previewUrl = designRes.body.previewUrl as string;
    expect(previewUrl).toContain('qwen3-tts-1.7b');

    const sampleRes = await request(app)
      .post(`/api/voice-library/${voiceUuid}/sample`)
      .send({ modelKey: 'qwen3-tts-1.7b' });

    expect(sampleRes.status).toBe(200);
    expect(sampleRes.body.cached).toBe(true);
    expect(sampleRes.body.url).toBe(previewUrl);
    expect(synthesize).not.toHaveBeenCalled();
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
        // #1933 — a realistic cloned entry always carries `master` (the
        // `/clone` route writes it unconditionally); without it, the new
        // per-engine readiness gate correctly finds the OTHER (coqui) slot
        // undeliverable — no `master` to derive from — and attaches the
        // #1933 advisory to this 200, which this test doesn't exercise.
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
        consent: {
          personName: 'Test',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'test',
        },
      }),
    );
    writeFileSync(join(vl.entryDir('assign-3'), 'master.wav'), 'fake-wav-bytes');
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
    /* GATE 1 [F1] - `assign-3` is CLONED, so both clone-capable slots are
       written and the response names both. */
    expect(res.body).toEqual({ updated: 1, written: ['qwen', 'coqui'] });

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

  /* Review I-4 — a character who previously had a DESIGNED voice with minted
     emotion `variants` keeps them after assign merges the qwen slot
     (`...character.overrideTtsVoices?.qwen` spreads the OLD slot's fields
     first). Those variants are keyed off the OLD base (`qwen-<old-uuid>
     __<emotion>`); after assign, `pickEmotionVariantVoice` derives the
     variant key from the NEW base (`qwen-<voiceUuid>__<emotion>`), a `.pt`
     that never existed for this voice. The pre-render pre-pass only
     validates the BASE `.pt`, so an emotion-tagged sentence would die
     mid-GPU-work on the sidecar's own VoiceNotDesignedError — breaking the
     fail-fast promise this whole readiness gate exists for. This test fails
     before the fix (`variants` survives the assign). */
  it('review I-4: assigning a library voice CLEARS a carried-over emotion `variants` map — it is anchored to the previous base identity', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'assign-variants-1',
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
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-variants', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        ttsEngine: 'qwen',
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-old-designed-uuid',
            provenance: 'designed',
            // Minted against the OLD base — must not survive onto the new one.
            variants: { angry: { name: 'qwen-old-designed-uuid__angry' } },
          },
        },
      },
    ]);

    const res = await request(app)
      .post('/api/voice-library/assign-variants-1/assign')
      .send({ bookId: 'book-variants', characterId: 'char-marlow' });

    expect(res.status).toBe(200);

    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: { qwen?: Record<string, unknown> } }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-assign-variants-1',
      libraryUuid: 'assign-variants-1',
      provenance: 'cloned',
    });
    expect(cast.characters[0].overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  /* fs-38 Wave 3c, Task 24 [D-B] — a DESIGNED entry that still has its
     retained reference clip on disk (`qwen-<uuid>__master.wav`, written by
     the sidecar's design_voice) is clone-capable on coqui too, so the
     both-slots write applies to it exactly like a `cloned` entry. A
     still-broken implementation that tests `entry.master` instead of
     stat-ing the disk file [DELTA-C1] would find `entry.master` undefined
     (no designed entry ever sets it) and fail this test the same way as the
     no-clip case below — the two tests only diverge once the disk check is
     actually wired in. */
  it('D-B: a designed entry WITH a retained reference clip on disk also writes the coqui slot (both slots, engine-correct names)', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-clip-1', provenance: 'designed' }));
    writeFileSync(paths.qwenVoiceWavPath('qwen-designed-clip-1__master'), 'REF-CLIP');

    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-designed-clip', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/designed-clip-1/assign')
      .send({ bookId: 'book-designed-clip', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-designed-clip-1',
      libraryUuid: 'designed-clip-1',
      provenance: 'designed',
    });
    expect(cast.characters[0].overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-designed-clip-1',
      libraryUuid: 'designed-clip-1',
      provenance: 'designed',
    });
    /* GATE 1 [F1] — the response must NAME both slots it just wrote. Asserted
       against the same disk state the block above reads, so the two can't
       drift: a `written` derived independently of `shouldWriteCoquiSlot`
       would show up here as a report that contradicts cast.json. */
    expect(res.body.written).toEqual(['qwen', 'coqui']);
  });

  /* fs-38 Wave 3c, Task 24 [D-E/D-F] — legacy behaviour, byte-for-byte: a
     designed entry with NO retained clip on disk writes ONLY the qwen slot,
     exactly as it did before this task. A regression that always writes
     both slots for a designed entry (ignoring the clip check entirely)
     would fail this test by producing a `coqui` slot here. */
  it('D-E/D-F: a designed entry with NO retained reference clip writes ONLY the qwen slot (legacy behaviour, unchanged)', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-noclip-1', provenance: 'designed' }));
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-designed-noclip', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/designed-noclip-1/assign')
      .send({ bookId: 'book-designed-noclip', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-designed-noclip-1',
      libraryUuid: 'designed-noclip-1',
      provenance: 'designed',
    });
    expect(cast.characters[0].overrideTtsVoices?.coqui).toBeUndefined();
    /* GATE 1 [F1] — THE case the finding is about: the caller asked to assign
       on a coqui-routed character, the route declined the coqui slot, and the
       response has to say so or the UI shows an assignment that isn't there. */
    expect(res.body.written).toEqual(['qwen']);
  });

  /* fs-38 Wave 3c, Task 24 — an `imported` entry never qualifies for the
     both-slots write (neither `cloned` nor `designed`); legacy behaviour,
     byte-for-byte. A regression that widens the gate to any provenance
     would fail this test by producing a `coqui` slot here. */
  it('an imported entry writes ONLY the qwen slot (legacy behaviour, unchanged)', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'imported-1', provenance: 'imported' }));
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-imported', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/imported-1/assign')
      .send({ bookId: 'book-imported', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-imported-1',
      libraryUuid: 'imported-1',
      provenance: 'imported',
    });
    expect(cast.characters[0].overrideTtsVoices?.coqui).toBeUndefined();
    expect(res.body.written).toEqual(['qwen']);
  });

  /* #1981 — the filed defect: two /assign calls for DIFFERENT characters in
     the SAME book race on that book's cast.json. Unlocked, both requests'
     `readJson` resolve before either `writeJsonAtomic` lands, so the later
     write replays a `characters` snapshot taken before the earlier write
     happened and silently drops it — one of the two assertions below fails
     with `undefined`. This test does NOT call `vi.resetModules()` between
     the two requests (only the file's own `beforeEach` does, once, before
     the test body runs) so the race is free to happen within one test. */
  it('keeps both assignments when two /assign calls for one book overlap', async () => {
    const uuidA = 'race-a';
    const uuidB = 'race-b';
    await vl.writeEntry(makeEntry({ voiceUuid: uuidA }));
    await vl.writeEntry(makeEntry({ voiceUuid: uuidB }));
    const bookId = 'book-race';
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', bookId, [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ]);

    /* Two different characters, one book. Unlocked, the later write replays a
       snapshot taken before the earlier one landed and drops it. */
    await Promise.all([
      request(app).post(`/api/voice-library/${uuidA}/assign`)
        .send({ bookId, characterId: 'alice' }),
      request(app).post(`/api/voice-library/${uuidB}/assign`)
        .send({ bookId, characterId: 'bob' }),
    ]);

    const cast = await readJson<CastJson>(castJsonPath(bookDir));
    const byId = Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c]));
    expect(byId.alice.overrideTtsVoices?.qwen?.libraryUuid).toBe(uuidA);
    expect(byId.bob.overrideTtsVoices?.qwen?.libraryUuid).toBe(uuidB);
  });
});

/* fs-38 Wave 3c GATE 1, owner-decided [DELTA-I5] — the unassign affordance.

   Before this route there was NO way to take a library voice off a
   character: `PUT /api/voices/:voiceId/override` 409s a clear when a cloned
   slot is present (Task 4) and preserves cloned provenance on a SET, so an
   explicit stock-voice pick over a clone left the character still RENDERING
   the clone. Both refusals are correct on their own; what was missing was a
   deliberate, character-targeted removal. */
describe('DELETE /api/voice-library/:voiceUuid/assign — unassign (GATE 1, DELTA-I5)', () => {
  function castPathFor(bookDir: string) {
    return join(bookDir, '.audiobook', 'cast.json');
  }
  function slotsOf(bookDir: string) {
    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    return cast.characters[0].overrideTtsVoices ?? {};
  }

  it('400s without bookId/characterId', async () => {
    const res = await request(app).delete('/api/voice-library/lib-1/assign');
    expect(res.status).toBe(400);
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'nope', characterId: 'char-marlow' });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-unassign-404', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);
    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'book-unassign-404', characterId: 'char-nobody' });
    expect(res.status).toBe(404);
  });

  /* The headline case. A CLONED coqui slot is exactly what every other
     write path in this wave is built to preserve — this route is the one
     deliberate exception, and it must actually remove the slot rather than
     half-clearing it (dropping the markers but keeping `name` would strand
     the character on a raw `xtts-<uuid>` key no resolver recognises). */
  it('removes a cloned library slot outright, markers and name together', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-1',
      [
        {
          id: 'char-marlow',
          name: 'Marlow',
          ttsEngine: 'coqui',
          overrideTtsVoices: {
            coqui: { name: 'xtts-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
          },
        },
      ],
    );

    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'book-unassign-1', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: ['coqui'] });
    expect(slotsOf(bookDir).coqui).toBeUndefined();
  });

  /* Scoped by libraryUuid, not by engine. A route that cleared every
     clone-capable slot would take the OTHER library voice with it — the
     "erased a marker for an unrelated voice" shape Phase 0 of this wave
     spent seven fixes on. */
  it('clears only the slots pointing at THIS voice, leaving another library voice and a plain override alone', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-2',
      [
        {
          id: 'char-marlow',
          name: 'Marlow',
          overrideTtsVoices: {
            coqui: { name: 'xtts-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
            qwen: { name: 'qwen-lib-other', libraryUuid: 'lib-other', provenance: 'designed' },
            kokoro: { name: 'af_heart' },
          },
        },
      ],
    );

    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'book-unassign-2', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: ['coqui'] });
    const slots = slotsOf(bookDir);
    expect(slots.coqui).toBeUndefined();
    expect(slots.qwen).toEqual({
      name: 'qwen-lib-other',
      libraryUuid: 'lib-other',
      provenance: 'designed',
    });
    expect(slots.kokoro).toEqual({ name: 'af_heart' });
  });

  it('clears BOTH engine slots when the character carries this voice on each', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-3',
      [
        {
          id: 'char-marlow',
          name: 'Marlow',
          overrideTtsVoices: {
            qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
            coqui: { name: 'xtts-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
          },
        },
      ],
    );

    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'book-unassign-3', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: ['qwen', 'coqui'] });
    expect(slotsOf(bookDir)).toEqual({});
  });

  /* The escape hatch must not be refusable. A revoked entry — or one already
     deleted, so `readEntry` finds nothing at all — is exactly when a
     character is stuck holding an assignment it cannot render. Both the
     `/assign` route above and `/sample` gate on consent; this one must not.
     Note NO library entry is written here at all. */
  it('works for a library entry that no longer exists (revoked or deleted) — never gated on the entry', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-4',
      [
        {
          id: 'char-marlow',
          name: 'Marlow',
          overrideTtsVoices: {
            coqui: { name: 'xtts-lib-gone', libraryUuid: 'lib-gone', provenance: 'cloned' },
          },
        },
      ],
    );

    const res = await request(app)
      .delete('/api/voice-library/lib-gone/assign')
      .query({ bookId: 'book-unassign-4', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: ['coqui'] });
    expect(slotsOf(bookDir).coqui).toBeUndefined();
  });

  /* A no-op is a 200 with an empty list — the requested end state already
     holds — and must not rewrite the character. Asserted on the untouched
     slot, not just the status code. */
  it('reports cleared: [] and leaves the character untouched when it was not carrying this voice', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-5',
      [
        {
          id: 'char-marlow',
          name: 'Marlow',
          overrideTtsVoices: {
            coqui: { name: 'xtts-lib-other', libraryUuid: 'lib-other', provenance: 'cloned' },
          },
        },
      ],
    );

    const res = await request(app)
      .delete('/api/voice-library/lib-1/assign')
      .query({ bookId: 'book-unassign-5', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: [] });
    expect(slotsOf(bookDir).coqui).toEqual({
      name: 'xtts-lib-other',
      libraryUuid: 'lib-other',
      provenance: 'cloned',
    });
  });

  /* Round-trips against the real assign, so the pair can't drift: whatever
     `/assign` writes, the unassign must be able to take back off. */
  it('round-trips a real /assign — every slot the assign reported written is cleared', async () => {
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    await vl.writeEntry(makeEntry({ voiceUuid: 'roundtrip-1', provenance: 'designed' }));
    writeFileSync(paths.qwenVoiceWavPath('qwen-roundtrip-1__master'), 'REF-CLIP');
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-6',
      [{ id: 'char-marlow', name: 'Marlow' }],
    );

    const assignRes = await request(app)
      .post('/api/voice-library/roundtrip-1/assign')
      .send({ bookId: 'book-unassign-6', characterId: 'char-marlow' });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.written).toEqual(['qwen', 'coqui']);

    const unassignRes = await request(app)
      .delete('/api/voice-library/roundtrip-1/assign')
      .query({ bookId: 'book-unassign-6', characterId: 'char-marlow' });

    expect(unassignRes.status).toBe(200);
    expect(unassignRes.body.cleared).toEqual(assignRes.body.written);
    expect(slotsOf(bookDir)).toEqual({});
  });

  /* #1981 — two concurrent DELETE /assign calls for DIFFERENT characters in
     the SAME book race that book's cast.json. Unlocked, both requests'
     readJson resolve before either writeJsonAtomic lands, so the later
     write replays a `characters` snapshot taken before the earlier write
     happened and silently un-clears the earlier one's slot. */
  it('#1981 — keeps both unassigns when two DELETE /assign calls for one book overlap', async () => {
    const bookDir = writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Book One',
      'book-unassign-race',
      [
        {
          id: 'char-alice',
          name: 'Alice',
          overrideTtsVoices: {
            coqui: { name: 'xtts-race-a', libraryUuid: 'race-a', provenance: 'cloned' },
          },
        },
        {
          id: 'char-bob',
          name: 'Bob',
          overrideTtsVoices: {
            coqui: { name: 'xtts-race-b', libraryUuid: 'race-b', provenance: 'cloned' },
          },
        },
      ],
    );

    const [resAlice, resBob] = await Promise.all([
      request(app)
        .delete('/api/voice-library/race-a/assign')
        .query({ bookId: 'book-unassign-race', characterId: 'char-alice' }),
      request(app)
        .delete('/api/voice-library/race-b/assign')
        .query({ bookId: 'book-unassign-race', characterId: 'char-bob' }),
    ]);
    expect(resAlice.status).toBe(200);
    expect(resAlice.body).toEqual({ cleared: ['coqui'] });
    expect(resBob.status).toBe(200);
    expect(resBob.body).toEqual({ cleared: ['coqui'] });

    const cast = JSON.parse(readFileSync(castPathFor(bookDir), 'utf8')) as {
      characters: Array<{ id: string; overrideTtsVoices?: Record<string, unknown> }>;
    };
    const alice = cast.characters.find((c) => c.id === 'char-alice')!;
    const bob = cast.characters.find((c) => c.id === 'char-bob')!;
    expect(alice.overrideTtsVoices?.coqui).toBeUndefined();
    expect(bob.overrideTtsVoices?.coqui).toBeUndefined();
  });
});

describe('POST /:uuid/assign — cloned readiness gate (#1933, formerly the fs-38 Wave 3b1 Qwen-only gate)', () => {
  it('409s a stale-qwen cloned entry with no retained reference clip (stale status alone would NOT block under #1933 — see T5)', async () => {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid: 'clone-unready', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal',
                 attestedAt: '2026-07-25T00:00:00Z', attestedBy: 'Mum' },
      // #1933 — no `master`, so under rule 3 (nothing derivable) this still
      // 409s, but for a DIFFERENT reason than the retired "not ready to
      // assign yet" gate: there's nothing to derive from.
      engines: { qwen: { status: 'stale' } },
      createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
    });
    // #1933 — the gate moved BELOW the cast read (findBookByBookId/readJson),
    // so this now needs a real, resolvable book + character — a nonexistent
    // book 404s before the gate ever runs.
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-unready', [
      { id: 'char-marcus', name: 'Marcus', ttsEngine: 'qwen' },
    ]);
    const res = await request(app).post('/api/voice-library/clone-unready/assign')
      .send({ bookId: 'book-clone-unready', characterId: 'char-marcus' });
    expect(res.status).toBe(409);
    // #1933 — tighten past a bare status check: without this, the assertion
    // passes on both the old (retired-string) and new gate and stops proving
    // anything.
    expect(res.body.error).toMatch(/no retained reference clip/);
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
    /* fs-38 Wave 3c, Task 24 — the guard now accepts Coqui too, so the 409
       must name BOTH clone-capable engines, not just Qwen — a caller who
       only sees "render on Qwen" would be misdirected into switching the
       book to Qwen when switching to Coqui is an equally valid fix. */
    expect(res.body.error).toMatch(/coqui/i);
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

  /* fs-38 Wave 3c, Task 24 — the reachability gap this task closes: this is
     the FIRST route that can ever write a coqui `libraryUuid`, so a
     coqui-routed character assigning a ready cloned voice must 200 (the
     guard now accepts Coqui, not just Qwen) AND get BOTH slots, each with
     its own engine-correct storage-key prefix (`qwen-<uuid>` /
     `xtts-<uuid>`, via the shared `cloneStorageKey` helper — never
     re-derived locally). Also proves the emotion-`variants` clear (review
     I-4) now applies to BOTH slots, not just qwen — the fixture seeds a
     stale `variants` map on each. A still-unwidened guard would 409 this
     case; a slot-write that only ever touches `qwen` would leave
     `overrideTtsVoices.coqui` at its OLD (stale-variants) value instead of
     the new cloned identity. */
  it('fs-38 Wave 3c: allows assigning a ready cloned voice to a Coqui-routed character (200) — writes BOTH engine-correct slots and clears variants on both', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'clone-coqui-route',
        provenance: 'cloned',
        engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
        // #1933 — a realistic cloned entry always carries `master` (the
        // `/clone` route writes it unconditionally); without it, the new
        // per-engine readiness gate correctly finds the ROUTED (coqui) slot
        // has nothing to derive from and 409s, which this test doesn't
        // exercise (it proves the both-slots WRITE, not the readiness gate).
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
        consent: {
          personName: 'Test',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'test',
        },
      }),
    );
    writeFileSync(join(vl.entryDir('clone-coqui-route'), 'master.wav'), 'fake-wav-bytes');
    const bookDir = writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-coqui-route', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        ttsEngine: 'coqui',
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-old-designed',
            provenance: 'designed',
            variants: { angry: { name: 'qwen-old-designed__angry' } },
          },
          coqui: {
            name: 'xtts-old-designed',
            provenance: 'designed',
            variants: { angry: { name: 'xtts-old-designed__angry' } },
          },
        },
      },
    ]);

    const res = await request(app)
      .post('/api/voice-library/clone-coqui-route/assign')
      .send({ bookId: 'book-coqui-route', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    const cast = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-clone-coqui-route',
      libraryUuid: 'clone-coqui-route',
      provenance: 'cloned',
    });
    expect(cast.characters[0].overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-clone-coqui-route',
      libraryUuid: 'clone-coqui-route',
      provenance: 'cloned',
    });
  });
});

/* #1933 — the per-engine assign readiness gate. See the implementation
   brief on GitHub issue #1933 for the full rule table and rationale; this
   suite is T1-T10 from that brief's §4, each pinned to the EXACT mutation
   that must turn it red (watched red under each mutation before landing —
   see the PR/commit description for the observed failure per mutation). */
describe('POST /:uuid/assign — per-engine readiness gate (#1933)', () => {
  const baseConsent = {
    personName: 'Test',
    relationship: 'family-with-permission' as const,
    permittedUse: 'personal' as const,
    attestedAt: '2026-01-01T00:00:00Z',
    attestedBy: 'test',
  };

  /* A realistic cloned entry always carries `master` (the `/clone` route
     writes it unconditionally) — mirrors every other fixture in this file
     that exercises the readiness gate. */
  function masterWith(transcript: string) {
    return {
      clipFile: 'master.wav',
      sampleRate: 24_000,
      durationSeconds: 5,
      transcript,
      transcriptSource: 'whisper' as const,
      captureMethod: 'record' as const,
    };
  }

  function writeMasterClip(voiceUuid: string) {
    writeFileSync(join(vl.entryDir(voiceUuid), 'master.wav'), 'fake-wav-bytes');
  }

  it('T1 — 200s a coqui-routed assign despite a terminally failed qwen slot, with a Qwen advisory', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't1-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: { qwen: { status: 'failed' } },
        consent: baseConsent,
      }),
    );
    writeMasterClip('t1-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t1', [
      { id: 'char-t1', name: 'CharT1', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t1-voice/assign')
      .send({ bookId: 'book-t1', characterId: 'char-t1' });

    expect(res.status).toBe(200);
    expect(res.body.written).toEqual(['qwen', 'coqui']);
    expect(res.body.warning).toMatch(/Qwen/);
    expect(res.body.warning).toMatch(/failed to derive/);
  });

  it('T2 — 409s a qwen-routed assign of the SAME terminally failed qwen slot', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't2-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: { qwen: { status: 'failed' } },
        consent: baseConsent,
      }),
    );
    writeMasterClip('t2-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t2', [
      { id: 'char-t2', name: 'CharT2', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t2-voice/assign')
      .send({ bookId: 'book-t2', characterId: 'char-t2' });

    expect(res.status).toBe(409);
    /* Anchored to surrounding prose, not bare engine names. This is the
       ONLY arm naming both engines, so a presence-only `/Qwen/` +
       `/Coqui XTTS v2/` pair survives a MISPLACEMENT — e.g. the first
       `${label}` swapped for the other engine's label — that still leaves
       both substrings present somewhere in the string, just bound to the
       wrong clause (naming the wrong engine as broken, or recommending a
       switch to the broken one). Binding each label to its own clause is
       what actually pins the message; T3 below pins the reverse
       direction, together closing both the label-hardcoding AND the
       label-misplacement variants of this defect. */
    expect(res.body.error).toMatch(/Qwen voice failed to derive/);
    expect(res.body.error).toMatch(/cast "CharT2" on Coqui XTTS v2 instead/);
  });

  it('T3 — 409s a coqui-routed assign of a failed xtts slot even though qwen is ready (load-bearing: engine-blind slot read must fail this)', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't3-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: { qwen: { status: 'ready', baseModel: 'x' }, xtts: { status: 'failed' } },
        consent: baseConsent,
      }),
    );
    writeMasterClip('t3-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t3', [
      { id: 'char-t3', name: 'CharT3', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t3-voice/assign')
      .send({ bookId: 'book-t3', characterId: 'char-t3' });

    expect(res.status).toBe(409);
    // Anchored to surrounding prose — see T2's comment for why bare
    // `/Qwen/` / `/Coqui XTTS v2/` substrings cannot distinguish a correct
    // message from one with the labels swapped between clauses.
    expect(res.body.error).toMatch(/Coqui XTTS v2 voice failed to derive/);
    expect(res.body.error).toMatch(/cast "CharT3" on Qwen instead/);
  });

  it('T4 — 409s with "no retained reference clip" for a cloned entry with no master at all', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't4-voice',
        provenance: 'cloned',
        engines: {},
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t4', [
      { id: 'char-t4', name: 'CharT4', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t4-voice/assign')
      .send({ bookId: 'book-t4', characterId: 'char-t4' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no retained reference clip/);
    // Also pin the ROUTED engine's own label here — T11 proves the same
    // 'no-clip' blockMessage arm names Coqui correctly, but nothing before
    // this proved it names QWEN correctly; the two labels are independent
    // interpolations of the same template.
    expect(res.body.error).toMatch(/Qwen/);
  });

  it('T5 — 200s a qwen-routed assign of a merely stale (repairable) qwen slot — the deliberate Qwen loosening', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't5-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: { qwen: { status: 'stale' } },
        consent: baseConsent,
      }),
    );
    writeMasterClip('t5-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t5', [
      { id: 'char-t5', name: 'CharT5', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t5-voice/assign')
      .send({ bookId: 'book-t5', characterId: 'char-t5' });

    expect(res.status).toBe(200);
  });

  /* T6a/T6b — the ONLY pair that can distinguish a genuinely per-engine rule
     from a symmetric one: one identical entry (an empty-transcript clip, no
     qwen slot at all), differing only in which engine the character routes
     to. Kept adjacent, fixture literally shared. */
  const t6Entry = {
    voiceUuid: 't6-voice',
    provenance: 'cloned' as const,
    master: masterWith(''),
    engines: {},
    consent: baseConsent,
  };

  it('T6a — 409s a qwen-routed assign of a clip with no transcript', async () => {
    await vl.writeEntry(makeEntry(t6Entry));
    writeMasterClip('t6-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t6a', [
      { id: 'char-t6a', name: 'CharT6a', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t6-voice/assign')
      .send({ bookId: 'book-t6a', characterId: 'char-t6a' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/transcript/);
  });

  it('T6b — 200s a coqui-routed assign of the SAME transcript-less clip, with a Qwen transcript advisory', async () => {
    await vl.writeEntry(makeEntry(t6Entry));
    writeMasterClip('t6-voice');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t6b', [
      { id: 'char-t6b', name: 'CharT6b', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t6-voice/assign')
      .send({ bookId: 'book-t6b', characterId: 'char-t6b' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Qwen/);
    expect(res.body.warning).toMatch(/transcript/);
  });

  it('T7 — the wrong-engine 409 wins over readiness when the character routes to neither clone engine', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't7-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: { qwen: { status: 'failed' } },
        consent: baseConsent,
      }),
    );
    writeMasterClip('t7-voice');
    // No `ttsEngine` override, and this test environment's process-wide
    // Qwen install-state default is "not installed" -> routes to kokoro.
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t7', [
      { id: 'char-t7', name: 'CharT7' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t7-voice/assign')
      .send({ bookId: 'book-t7', characterId: 'char-t7' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cloned voices render on Qwen or Coqui XTTS v2/);
    expect(res.body.error).not.toMatch(/failed to derive/);
  });

  it('T8 — a DESIGNED entry is untouched by the cloned-only readiness gate, even with a failed qwen slot and no master', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't8-voice',
        provenance: 'designed',
        engines: { qwen: { status: 'failed' } },
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t8', [
      { id: 'char-t8', name: 'CharT8', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t8-voice/assign')
      .send({ bookId: 'book-t8', characterId: 'char-t8' });

    expect(res.status).toBe(200);
  });

  it('T9 — closes the engine-blind hole T1-T8 leave open: a coqui-routed assign is ALLOWED (200) on its own ready xtts slot, even with no master and an irrelevantly-failed qwen slot', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't9-voice',
        provenance: 'cloned',
        engines: { qwen: { status: 'failed' }, xtts: { status: 'ready', coquiVersion: 'x' } },
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t9', [
      { id: 'char-t9', name: 'CharT9', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t9-voice/assign')
      .send({ bookId: 'book-t9', characterId: 'char-t9' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Qwen/);
  });

  it('T10 — 409s "no retained reference clip" when `master` is declared but its clip file was never written to disk', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't10-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: {},
        consent: baseConsent,
      }),
    );
    // Deliberately do NOT write master.wav to disk.
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t10', [
      { id: 'char-t10', name: 'CharT10', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t10-voice/assign')
      .send({ bookId: 'book-t10', characterId: 'char-t10' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no retained reference clip/);
  });

  /* T11 — closes a hole T4/T10 leave open: both of THOSE cases route to
     Qwen, so an implementation that scoped the "no master / clip gone"
     check to `engine === 'qwen'` (mirroring the transcript clause's own
     qwen-only scoping one line down) would pass both while silently
     letting a master-less cloned entry through on a COQUI-routed
     character — exactly the missing-master hazard this gate exists to
     catch, just reachable from the other engine. */
  it('T11 — 409s "no retained reference clip" for a coqui-routed assign of a cloned entry with no master at all', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't11-voice',
        provenance: 'cloned',
        engines: {},
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t11', [
      { id: 'char-t11', name: 'CharT11', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t11-voice/assign')
      .send({ bookId: 'book-t11', characterId: 'char-t11' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no retained reference clip/);
    expect(res.body.error).toMatch(/Coqui XTTS v2/);
  });

  /* T12 — pins `advisoryMessage`'s `'no-clip'` arm, which none of T1-T11
     reach: T9 (the other case with an irrelevant qwen problem) sets
     `qwen: { status: 'failed' }`, so its OTHER-engine evaluation takes the
     `'failed'` arm, not `'no-clip'`. Here the routed (qwen) slot is
     healthy — the assign succeeds — and the OTHER (coqui) slot is simply
     absent with no master to derive from, so the advisory must name the
     'no-clip' reason specifically. */
  it('T12 — pins the no-clip advisory string when a qwen-routed assign\'s OTHER (coqui) slot has no master to derive from', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't12-voice',
        provenance: 'cloned',
        engines: { qwen: { status: 'ready', baseModel: 'x' } },
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t12', [
      { id: 'char-t12', name: 'CharT12', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t12-voice/assign')
      .send({ bookId: 'book-t12', characterId: 'char-t12' });

    expect(res.status).toBe(200);
    expect(res.body.written).toEqual(['qwen', 'coqui']);
    expect(res.body.warning).toMatch(/Coqui XTTS v2/);
    expect(res.body.warning).toMatch(/has no retained reference clip/);
    expect(res.body.warning).toMatch(/can never be derived/);
  });

  /* T13 — pins `advisoryMessage`'s `'failed'` arm for the OTHER-COQUI
     case, the mirror image of T1 (which only ever exercises this arm with
     the OTHER engine being Qwen). Every 'failed'-reason advisory test up
     to T12 has `otherEngine === 'qwen'`; this is the first to have
     `otherEngine === 'coqui'`, so a `${label}` substitution hardcoded to
     "Qwen" in this arm would pass T1/T9/T12 undetected. */
  it('T13 — pins the failed advisory string naming Coqui when a qwen-routed assign\'s OTHER (coqui) slot is terminally failed', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't13-voice',
        provenance: 'cloned',
        engines: { qwen: { status: 'ready', baseModel: 'x' }, xtts: { status: 'failed' } },
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t13', [
      { id: 'char-t13', name: 'CharT13', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t13-voice/assign')
      .send({ bookId: 'book-t13', characterId: 'char-t13' });

    expect(res.status).toBe(200);
    expect(res.body.written).toEqual(['qwen', 'coqui']);
    expect(res.body.warning).toMatch(/Coqui XTTS v2/);
    expect(res.body.warning).toMatch(/failed to derive/);
  });

  /* T14 — pins `advisoryMessage`'s `'no-clip'` arm for the OTHER-QWEN
     case, the mirror image of T12 (which only ever exercises this arm
     with the OTHER engine being Coqui). A `${label}` substitution
     hardcoded to "Coqui XTTS v2" in this arm would pass T12 undetected. */
  it('T14 — pins the no-clip advisory string naming Qwen when a coqui-routed assign\'s OTHER (qwen) slot has no master to derive from', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't14-voice',
        provenance: 'cloned',
        engines: { xtts: { status: 'ready', coquiVersion: 'x' } },
        consent: baseConsent,
      }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t14', [
      { id: 'char-t14', name: 'CharT14', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t14-voice/assign')
      .send({ bookId: 'book-t14', characterId: 'char-t14' });

    expect(res.status).toBe(200);
    expect(res.body.written).toEqual(['qwen', 'coqui']);
    expect(res.body.warning).toMatch(/Qwen/);
    expect(res.body.warning).toMatch(/has no retained reference clip/);
    expect(res.body.warning).toMatch(/can never be derived/);
  });

  /* T15 — the coqui-routed twin of T10, closing the predicate-level hole
     T11 leaves open: T11's `master` is entirely absent, so it reaches
     `'no-clip'` via the `!entry.master` half of the predicate regardless
     of engine — it never exercises the `clipOnDisk` half at all. An
     implementation that scoped ONLY the disk-check half to
     `engine === 'qwen'` (`if (!entry.master || (engine === 'qwen' &&
     !clipOnDisk)) return 'no-clip';`) would pass T10 (qwen-routed,
     catches it), T11 (coqui-routed, but master absent so the disk check
     is never reached), AND T4 (qwen-routed, also `!entry.master`) while
     silently letting a coqui-routed assign through when `master` is
     DECLARED but its clip file is gone — the same missing-master hazard
     T10 exists to catch, reachable from the untested engine on the
     untested half of the predicate. Mock mode is exempt here:
     `_mockClonedAssignBlock` has no filesystem stat at all (documented
     approximation), so there is no `clipOnDisk` half to scope. */
  it('T15 — 409s "no retained reference clip" for a coqui-routed assign when `master` is declared but its clip file was never written to disk', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 't15-voice',
        provenance: 'cloned',
        master: masterWith('hello there'),
        engines: {},
        consent: baseConsent,
      }),
    );
    // Deliberately do NOT write master.wav to disk.
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-t15', [
      { id: 'char-t15', name: 'CharT15', ttsEngine: 'coqui' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/t15-voice/assign')
      .send({ bookId: 'book-t15', characterId: 'char-t15' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no retained reference clip/);
    expect(res.body.error).toMatch(/Coqui XTTS v2/);
  });
});

describe('POST /:uuid/assign — designed-voice language mismatch warning (#1953)', () => {
  it('warns (200, not 409) when a designed voice baked in Russian is assigned on an ENGLISH book — the gap nothing covered before this fix', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-ru-1', provenance: 'designed' }));
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(
      paths.qwenVoiceSidecarPath('qwen-designed-ru-1'),
      JSON.stringify({ language: 'Russian', instruct: 'x' }),
    );
    // No `language` field on state.json -> normalises to 'en' / sidecar "English".
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-en-mismatch', [
      { id: 'char-ada', name: 'Ada' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/designed-ru-1/assign')
      .send({ bookId: 'book-en-mismatch', characterId: 'char-ada' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Ada/);
    expect(res.body.warning).toMatch(/Russian/);
    expect(res.body.warning).toMatch(/English/);
  });

  it('also warns when a designed voice baked in English is assigned on a non-English (Russian) book', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-en-2', provenance: 'designed' }));
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(
      paths.qwenVoiceSidecarPath('qwen-designed-en-2'),
      JSON.stringify({ language: 'English', instruct: 'x' }),
    );
    const bookDir = join(dir, 'books', 'Della Renwick', 'The Hollow Tide', 'Book Two');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'book-ru-mismatch',
        manuscriptId: 'm_book-ru-mismatch',
        title: 'Book Two',
        author: 'Della Renwick',
        series: 'The Hollow Tide',
        seriesPosition: null,
        isStandalone: false,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        language: 'ru',
      }),
    );
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [{ id: 'char-oduvan', name: 'Oduvan' }] }),
    );

    const res = await request(app)
      .post('/api/voice-library/designed-en-2/assign')
      .send({ bookId: 'book-ru-mismatch', characterId: 'char-oduvan' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Oduvan/);
    expect(res.body.warning).toMatch(/English/);
    expect(res.body.warning).toMatch(/Russian/);
  });

  it('does not warn when the designed voice language matches the book language', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-en-1', provenance: 'designed' }));
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(
      paths.qwenVoiceSidecarPath('qwen-designed-en-1'),
      JSON.stringify({ language: 'English', instruct: 'x' }),
    );
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-en-match', [
      { id: 'char-ada', name: 'Ada' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/designed-en-1/assign')
      .send({ bookId: 'book-en-match', characterId: 'char-ada' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  /* Review round 2 — `sidecarLanguageName` throws for any book language
     outside the registry (language.ts's fail-loud safety net), and the
     confirm-screen gate that's supposed to keep an unsupported language from
     reaching this far is client-side only: `routes/import.ts` persists an
     unchecked language (see #1955), so a pre-existing book with e.g.
     `language: 'pt'` can already be on disk. Assign must not 500 on a route
     that worked fine for such a book before this warning existed — with no
     registry entry there's no sidecar word to compare against, so the
     correct behaviour is to skip the warning silently, not throw. */
  it('does not 500 (and does not warn) when the book language is unregistered — skips the comparison instead of throwing', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'designed-pt-1', provenance: 'designed' }));
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(
      paths.qwenVoiceSidecarPath('qwen-designed-pt-1'),
      JSON.stringify({ language: 'English', instruct: 'x' }),
    );
    const bookDir = join(dir, 'books', 'Della Renwick', 'The Hollow Tide', 'Book Three');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'book-pt-unregistered',
        manuscriptId: 'm_book-pt-unregistered',
        title: 'Book Three',
        author: 'Della Renwick',
        series: 'The Hollow Tide',
        seriesPosition: null,
        isStandalone: false,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Not in language-registry.ts's ENTRIES — mirrors a pre-existing book
        // imported before #1955's import-time gate landed.
        language: 'pt',
      }),
    );
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [{ id: 'char-ines', name: 'Ines' }] }),
    );

    const res = await request(app)
      .post('/api/voice-library/designed-pt-1/assign')
      .send({ bookId: 'book-pt-unregistered', characterId: 'char-ines' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  it('never warns for a CLONED voice (no baked design language) — the existing 409 guard is untouched', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'clone-lang-1',
        provenance: 'cloned',
        engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
        // #1933 — same fixture-realism fix as the "stamps the qwen slot…"
        // test above: without a `master`, the new gate correctly flags the
        // OTHER (coqui) slot as undeliverable and attaches the #1933
        // advisory, which is a DIFFERENT warning than the one (#1953,
        // design-language) this test exists to rule out.
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
        consent: {
          personName: 'Test',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'test',
        },
      }),
    );
    writeFileSync(join(vl.entryDir('clone-lang-1'), 'master.wav'), 'fake-wav-bytes');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-lang', [
      { id: 'char-marlow', name: 'Marlow', ttsEngine: 'qwen' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/clone-lang-1/assign')
      .send({ bookId: 'book-clone-lang', characterId: 'char-marlow' });

    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  it('still 409s a cloned voice routed to a non-clone-capable engine — unaffected by the new warning branch', async () => {
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'clone-lang-409',
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
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-409', [
      { id: 'char-marlow', name: 'Marlow' },
    ]);

    const res = await request(app)
      .post('/api/voice-library/clone-lang-409/assign')
      .send({ bookId: 'book-clone-409', characterId: 'char-marlow' });

    expect(res.status).toBe(409);
    expect(res.body.warning).toBeUndefined();
  });
});

/* #1998 — cloned-voice language mismatch warning. Sibling of the designed-
   voice warning (#1953) above: when a cloned voice's `languageCode` (the
   BCP-47 code the clone pipeline validated and persisted) differs from the
   book's language, the assign succeeds with a 200 but attaches a warning
   naming the character, the clone's language, and the book's. The comparison
   is CODE-vs-CODE (`entry.languageCode` against `bookLanguage`), never
   code-vs-sidecar-word — mutation 2 below pins that trap. */
describe('POST /:uuid/assign — cloned-voice language mismatch warning (#1998)', () => {
  async function seedClonedWithLang(voiceUuid: string, languageCode?: string) {
    const { writeEntry } = await import('../workspace/voice-library.js');
    await writeEntry({
      voiceUuid, name: 'Clone Voice', provenance: 'cloned',
      tags: [], pinned: false, languageCode,
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } },
      master: {
        clipFile: 'master.wav', sampleRate: 24_000, durationSeconds: 5,
        transcript: 'hello there', transcriptSource: 'whisper',
        captureMethod: 'record', languageCode,
      },
      consent: {
        personName: 'Test', relationship: 'family-with-permission',
        permittedUse: 'personal', attestedAt: '2026-01-01T00:00:00Z',
        attestedBy: 'test',
      },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(vl.entryDir(voiceUuid), 'master.wav'), 'fake-wav-bytes');
  }

  it('warns (200) when a cloned voice in Russian is assigned to an English book', async () => {
    await seedClonedWithLang('clone-ru-en', 'ru');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-ru-en', [
      { id: 'char-nik', name: 'Nikolai', ttsEngine: 'qwen' },
    ], 'en');
    const res = await request(app)
      .post('/api/voice-library/clone-ru-en/assign')
      .send({ bookId: 'book-clone-ru-en', characterId: 'char-nik' });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Nikolai/);
    expect(res.body.warning).toMatch(/Russian/);
    expect(res.body.warning).toMatch(/English/);
    expect(res.body.warning).toMatch(/cloned in/);
    expect(res.body.warning).not.toMatch(/unintelligible/);
    expect(res.body.warning).toMatch(/less like the person/);
  });

  it('does not warn when the cloned voice language matches the book language', async () => {
    await seedClonedWithLang('clone-en-en', 'en');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-en-en', [
      { id: 'char-ada', name: 'Ada', ttsEngine: 'qwen' },
    ], 'en');
    const res = await request(app)
      .post('/api/voice-library/clone-en-en/assign')
      .send({ bookId: 'book-clone-en-en', characterId: 'char-ada' });
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  it('does not warn when the cloned voice has no languageCode (unknown language)', async () => {
    await seedClonedWithLang('clone-undef');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-undef', [
      { id: 'char-ada', name: 'Ada', ttsEngine: 'qwen' },
    ]);
    const res = await request(app)
      .post('/api/voice-library/clone-undef/assign')
      .send({ bookId: 'book-clone-undef', characterId: 'char-ada' });
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  /* #1998 regression test — a cloned voice whose languageCode differs from
     an UNSET book language must not emit a warning. Absence (missing language
     key, null, empty, or whitespace) is not English — it's the surrendered-
     detection state. Comparing against the 'en' default would falsely claim
     a book is English when it has never set a language, and advice to
     "Re-clone in English" would be destructive. Pins the fix to use
     bookStateLanguageOrNull (returns null when unset) instead of
     bookStateLanguage (defaults to 'en'). */
  it('does not warn when the cloned voice language differs but the book has no language set', async () => {
    await seedClonedWithLang('clone-ru-unset', 'ru');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-ru-unset', [
      { id: 'char-nik', name: 'Nikolai', ttsEngine: 'qwen' },
    ]); // no language parameter — book's language is unset (missing key)
    const res = await request(app)
      .post('/api/voice-library/clone-ru-unset/assign')
      .send({ bookId: 'book-clone-ru-unset', characterId: 'char-nik' });
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  /* #1998 regression test — same as above, but with book language explicitly
     set to null (the "detection surrendered" state). Null and missing key
     must be treated identically. */
  it('does not warn when the cloned voice language differs but the book language is explicitly null', async () => {
    await seedClonedWithLang('clone-ru-null', 'ru');
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-clone-ru-null', [
      { id: 'char-nik', name: 'Nikolai', ttsEngine: 'qwen' },
    ], null); // explicit null, not a missing key
    const res = await request(app)
      .post('/api/voice-library/clone-ru-null/assign')
      .send({ bookId: 'book-clone-ru-null', characterId: 'char-nik' });
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
  });

  /* Mutation 1 — invert the comparison so it fires on a MATCH instead of a
     mismatch. The match-case test ("does not warn when…matches") must go
     red. Pins that the guard tests inequality, not just presence.
     To verify: change `entry.languageCode !== bookLanguageForClonedCheck` to
     `entry.languageCode === bookLanguageForClonedCheck`, re-run the match
     test — fails. */

  /* Mutation 2 — change the comparand from `bookLanguageForClonedCheck`
     (BCP-47 code, null when unset) back to `bookLanguage` (defaulting to
     'en'). The regression tests above must go red: a Russian cloned voice
     against an unset book language would fire the mismatch and emit a false
     warning. Pins that the code uses the honest reader to avoid defaulting
     absence to English.
     To verify: change `entry.languageCode !== bookLanguageForClonedCheck` to
     `entry.languageCode !== bookLanguage`, re-run the regression tests. */
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

  /* #1842 — the create modal's previewUrl must follow the caller's session
     tier the same way POST /:uuid/sample already does (see the sibling
     describe above): design and play share the `qwen-<uuid>` cache scope,
     so a tier mismatch between them silently costs a second synthesis on
     first Play. Asserting on previewUrl (which embeds modelKey via
     voiceSampleFileName) proves the tier actually reached the sidecar
     request/cache path, not just that the route accepted the field. */
  it('designs at the requested Qwen tier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator', modelKey: 'qwen3-tts-1.7b' });

    expect(res.status).toBe(201);
    expect(res.body.previewUrl).toContain('qwen3-tts-1.7b');
  });

  it('defaults design to 0.6B when the caller sends no modelKey', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator' });

    expect(res.status).toBe(201);
    expect(res.body.previewUrl).toContain('qwen3-tts-0.6b');
  });

  it('rejects a design modelKey that does not route to Qwen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());

    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm, measured narrator', modelKey: 'kokoro-v1' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
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

  /* #1842 — same reasoning as the design tests above: the A/B compare
     modal's previewUrl must land at the caller's session tier, and it
     shares the same `qwen-<uuid>` cache scope as /design and /sample. */
  it('redesigns at the requested Qwen tier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    await vl.writeEntry(makeEntry({ voiceUuid: 're-tier-1', name: 'Nova', provenance: 'designed' }));

    const res = await request(app)
      .post('/api/voice-library/re-tier-1/redesign')
      .send({ persona: 'a brighter, warmer read', modelKey: 'qwen3-tts-1.7b' });

    expect(res.status).toBe(200);
    expect(res.body.previewUrl).toContain('qwen3-tts-1.7b');
  });

  it('defaults redesign to 0.6B when the caller sends no modelKey', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    await vl.writeEntry(makeEntry({ voiceUuid: 're-tier-2', name: 'Nova', provenance: 'designed' }));

    const res = await request(app)
      .post('/api/voice-library/re-tier-2/redesign')
      .send({ persona: 'a brighter, warmer read' });

    expect(res.status).toBe(200);
    expect(res.body.previewUrl).toContain('qwen3-tts-0.6b');
  });

  it('rejects a redesign modelKey that does not route to Qwen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    await vl.writeEntry(makeEntry({ voiceUuid: 're-tier-3', name: 'Nova', provenance: 'designed' }));

    const res = await request(app)
      .post('/api/voice-library/re-tier-3/redesign')
      .send({ persona: 'a brighter, warmer read', modelKey: 'kokoro-v1' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
  });

  /* #1801 — a 503 from the sidecar is the "no GPU capacity, free VRAM and
     retry" signal; flattening it to 502 tells the UI "the gateway is broken"
     instead. A real `Response` (not the plain okSidecarResponse stub) because
     withCapacityRetry calls `.clone()` on a non-ok body to check for
     `{ noCapacity: true }` — this body lacks it, so the response is returned
     untouched and design-voice-core throws SidecarDesignError(503). No retry
     loop, so the test can't hang. */
  it('design surfaces a sidecar 503 instead of flattening it to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'GPU is saturated' }), { status: 503 }),
    );
    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm narrator' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/GPU is saturated/);
  });

  it('redesign surfaces a sidecar 503 instead of flattening it to 502', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 're-503', name: 'Nova', provenance: 'designed' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'GPU is saturated' }), { status: 503 }),
    );
    const res = await request(app)
      .post('/api/voice-library/re-503/redesign')
      .send({ persona: 'a brighter read' });
    expect(res.status).toBe(503);
  });

  /* The unreachable/cancelled branches of design-voice-core carry status 0.
     `res.status(0)` is a RangeError that would blow up as an HTML 500 — the
     mapping must clamp anything outside 400–599 back to 502. */
  it('design clamps a status-0 (sidecar unreachable) error to 502, not a RangeError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app)
      .post('/api/voice-library/design')
      .send({ name: 'Nova', persona: 'a calm narrator' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
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

  it('redesign/promote carries the preview’s retained reference clip onto the live key (fix wave, §2.3 consent gap)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    const { writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });

    await vl.writeEntry(makeEntry({ voiceUuid: 'promo-wav-1', provenance: 'designed' }));
    wf(qwenVoice.qwenVoicePtPath('qwen-promo-wav-1'), 'LIVE');
    wf(qwenVoice.qwenVoicePtPath('qwen-promo-wav-1-preview'), 'PREVIEW');
    const liveWav = paths.qwenVoiceWavPath('qwen-promo-wav-1__master');
    const previewWav = paths.qwenVoiceWavPath('qwen-promo-wav-1-preview__master');
    wf(previewWav, 'REF-CLIP');

    const res = await request(app)
      .post('/api/voice-library/promo-wav-1/redesign/promote')
      .send({ persona: 'new persona' });

    expect(res.status).toBe(200);
    expect(existsSync(liveWav)).toBe(true);
    expect(existsSync(previewWav)).toBe(false);
  });

  it('redesign/promote still succeeds when the preview has no retained reference clip (pre-fix design, best-effort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    const { writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });

    await vl.writeEntry(makeEntry({ voiceUuid: 'promo-wav-2', provenance: 'designed' }));
    wf(qwenVoice.qwenVoicePtPath('qwen-promo-wav-2'), 'LIVE');
    wf(qwenVoice.qwenVoicePtPath('qwen-promo-wav-2-preview'), 'PREVIEW');
    /* No `-preview__master.wav` seeded at all. */

    const res = await request(app)
      .post('/api/voice-library/promo-wav-2/redesign/promote')
      .send({ persona: 'new persona' });

    expect(res.status).toBe(200);
    expect(existsSync(paths.qwenVoiceWavPath('qwen-promo-wav-2__master'))).toBe(false);
  });

  it('redesign/discard also erases the preview’s retained reference clip (fix wave, §2.3 consent gap)', async () => {
    const { writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });

    await vl.writeEntry(makeEntry({ voiceUuid: 'disc-wav-1', provenance: 'designed' }));
    wf(qwenVoice.qwenVoicePtPath('qwen-disc-wav-1-preview'), 'PREVIEW');
    const previewWav = paths.qwenVoiceWavPath('qwen-disc-wav-1-preview__master');
    wf(previewWav, 'REF-CLIP');

    const res = await request(app).post('/api/voice-library/disc-wav-1/redesign/discard').send({});

    expect(res.status).toBe(200);
    expect(existsSync(previewWav)).toBe(false);
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

  it('promote 409s WITHOUT deleting the live .pt on a double-promote (#1804 data-loss guard)', async () => {
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });
    await vl.writeEntry(makeEntry({ voiceUuid: 'doublepromo-1', provenance: 'designed' }));
    const liveP = qwenVoice.qwenVoicePtPath('qwen-doublepromo-1');
    writeFileSync(liveP, 'LIVE');
    // No preview `.pt` staged — mirrors a double-promote (second click after
    // the first already consumed the preview).

    const res = await request(app)
      .post('/api/voice-library/doublepromo-1/redesign/promote')
      .send({});

    expect(res.status).toBe(409);
    expect(existsSync(liveP)).toBe(true); // live artifact must survive
    expect(readFileSync(liveP, 'utf8')).toBe('LIVE');
  });

  it('404s design-lifecycle routes for an unknown uuid', async () => {
    const r1 = await request(app).post('/api/voice-library/nope/redesign/promote').send({});
    expect(r1.status).toBe(404);
    const r2 = await request(app).post('/api/voice-library/nope/redesign/discard').send({});
    expect(r2.status).toBe(404);
  });

  /* GATE 1 fix (C1). Asserting "a 403 comes back" would be a placebo — the
     property that matters is that the cloned voice's LIVE `.pt` is still the
     cloned one afterwards, i.e. no stranger's voice can render under the
     clone's name. So both tests stage a real preview `.pt` on disk and assert
     the live artifact's BYTES are unchanged. `promote` is exercised with a
     preview already staged, which is the state that actually performs the
     destructive `rm`+`rename`. */
  function makeClonedEntry(voiceUuid: string) {
    return makeEntry({
      voiceUuid,
      provenance: 'cloned',
      engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
    });
  }

  it('GATE 1 C1: refuses to STAGE a redesign of a cloned voice (403), leaving the clone intact', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });
    await vl.writeEntry(makeClonedEntry('cloned-redesign-1'));
    const liveP = qwenVoice.qwenVoicePtPath('qwen-cloned-redesign-1');
    writeFileSync(liveP, 'CLONED-LATENTS');

    const res = await request(app)
      .post('/api/voice-library/cloned-redesign-1/redesign')
      .send({ persona: 'a wry, steady woman' });

    expect(res.status).toBe(403);
    // No design was even attempted — the sidecar was never asked to synthesise.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The person's own artifact is untouched.
    expect(readFileSync(liveP, 'utf8')).toBe('CLONED-LATENTS');
    // Provenance is not quietly rewritten either.
    expect((await vl.readEntry('cloned-redesign-1'))?.provenance).toBe('cloned');
  });

  it('GATE 1 C1: refuses to PROMOTE a staged redesign onto a cloned voice (403), so the clone is never overwritten', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });
    await vl.writeEntry(makeClonedEntry('cloned-promo-1'));

    const liveP = qwenVoice.qwenVoicePtPath('qwen-cloned-promo-1');
    const previewP = qwenVoice.qwenVoicePtPath('qwen-cloned-promo-1-preview');
    writeFileSync(liveP, 'CLONED-LATENTS');
    // A preview IS staged — the state in which promote does its rm+rename.
    // Guarded independently of /redesign so a preview staged before this fix
    // (or by any other route) still cannot land on a cloned voice.
    writeFileSync(previewP, 'STRANGER-DESIGN');

    const res = await request(app)
      .post('/api/voice-library/cloned-promo-1/redesign/promote')
      .send({ persona: 'a wry, steady woman' });

    expect(res.status).toBe(403);
    expect(readFileSync(liveP, 'utf8')).toBe('CLONED-LATENTS'); // NOT overwritten
    expect(existsSync(previewP)).toBe(true); // and nothing was consumed
    expect((await vl.readEntry('cloned-promo-1'))?.provenance).toBe('cloned');
  });

  it('GATE 1 C1: a DESIGNED voice can still be redesigned and promoted (the fix is provenance-scoped)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okSidecarResponse());
    mkdirSync(join(dir, 'voices', 'qwen'), { recursive: true });
    await vl.writeEntry(
      makeEntry({
        voiceUuid: 'designed-redesign-1',
        provenance: 'designed',
        engines: { qwen: { status: 'ready', baseModel: modelPaths.currentQwenBaseModel() } },
      }),
    );

    const staged = await request(app)
      .post('/api/voice-library/designed-redesign-1/redesign')
      .send({ persona: 'a calm, measured narrator' });
    expect(staged.status).toBe(200);

    const liveP = qwenVoice.qwenVoicePtPath('qwen-designed-redesign-1');
    writeFileSync(liveP, 'OLD-DESIGN');
    writeFileSync(qwenVoice.qwenVoicePtPath('qwen-designed-redesign-1-preview'), 'NEW-DESIGN');

    const promoted = await request(app)
      .post('/api/voice-library/designed-redesign-1/redesign/promote')
      .send({ persona: 'a calm, measured narrator' });
    expect(promoted.status).toBe(200);
    expect(readFileSync(liveP, 'utf8')).toBe('NEW-DESIGN');
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
        /* #1959 — family-with-permission now requires attestedBy up front
           (falling back to personName is only for `self`). */
        consent: {
          personName: 'Mum',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedBy: 'Mum',
        },
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

  /* #1943 — a guardian-of-minor record must name the GUARDIAN as the
     attester, not the child being cloned. Before the fix, attestedBy was
     hardcoded to consentDraft.personName, so this persisted 'Ana' (the
     child) instead of 'Dana' (the parent who actually attested). */
  it('persists a caller-supplied attestedBy distinct from personName', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-guardian',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-guardian',
        consent: {
          personName: 'Ana',
          relationship: 'guardian-of-minor',
          attestedBy: 'Dana',
          permittedUse: 'personal',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.consent.personName).toBe('Ana');
    expect(res.body.consent.attestedBy).toBe('Dana');
  });

  /* #1959 — a guardian-of-minor clone can no longer fall back to
     personName: that would persist a record asserting the minor attested
     to their own voice being cloned, the exact defect #1943 fixed. Checked
     before any candidate/GPU work (no writeCandidate needed — this never
     reaches the candidate lookup). */
  it('rejects a guardian-of-minor clone with attestedBy omitted (400)', async () => {
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-no-attester',
        consent: { personName: 'Ana', relationship: 'guardian-of-minor', permittedUse: 'personal' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/attestedBy/);
  });

  /* Same rule for the other non-self relationship. */
  it('rejects a family-with-permission clone with attestedBy omitted (400)', async () => {
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-no-attester-2',
        consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/attestedBy/);
  });

  /* `self` is unaffected: personName IS the attester there, and the wizard
     deliberately omits attestedBy for that relationship. Must keep
     succeeding and persisting personName as the fallback. */
  it('self clone with attestedBy omitted still succeeds and persists personName', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-self-no-attester',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-self-no-attester',
        consent: { personName: 'Ana', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.consent.attestedBy).toBe('Ana');
  });

  /* Pins the TRIM itself, which nothing else does: the blank and omitted
     cases below both expect 'Ana', which is exactly what the pre-fix
     hardcode produced, so dropping .trim() from the STORED value (while
     keeping the blank check) would survive them and persist '  Dana  '.
     The wizard trims client-side, so this is the non-UI caller's guard. */
  it('trims a supplied attestedBy before persisting it', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-padded-attester',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-padded-attester',
        consent: {
          personName: 'Ana',
          relationship: 'guardian-of-minor',
          attestedBy: '  Dana  ',
          permittedUse: 'personal',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.consent.attestedBy).toBe('Dana');
  });

  /* #1959 — a blank/whitespace attestedBy must be treated the same as
     omitted: for a non-self relationship that means REJECTED (400), not a
     fallback to personName — otherwise whitespace would be a bypass for
     the omitted-field rule above. */
  it('rejects a guardian-of-minor clone with a blank/whitespace attestedBy (treated as absent)', async () => {
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-blank-attester',
        consent: {
          personName: 'Ana',
          relationship: 'guardian-of-minor',
          attestedBy: '   ',
          permittedUse: 'personal',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/attestedBy/);
  });

  /* #1836 — the wizard's transcript box is editable, so a correction must
     reach the derive as `ref_text` AND be persisted. Persisting to
     `master.transcript` (not just `sampleTranscript`) is load-bearing: the
     Wave 3b2 repair path re-derives from `entry.master.transcript`
     (tts/synthesise-chapter.ts readMasterPcmDefault), so storing the
     correction only in `sampleTranscript` would let a later repair silently
     revert to the Whisper text. */
  it('distils an edited transcript and persists it as master.transcript with transcriptSource=user', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-edit',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sandwich',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFFfake-wav-bytes'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-edit',
        transcript: 'my own voice sample',
        /* #1959 — relationship is incidental to this test; `self` needs no
           attestedBy. */
        consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    // the corrected text is what the clone was distilled against
    expect(deriveMock).toHaveBeenCalledWith(
      expect.any(String),
      'qwen',
      expect.objectContaining({ refText: 'my own voice sample' }),
    );
    // …and what survives on the entry, for both display and any later re-derive
    expect(res.body.sampleTranscript).toBe('my own voice sample');
    expect(res.body.master.transcript).toBe('my own voice sample');
    expect(res.body.master.transcriptSource).toBe('user');
  });

  /* #1951 — the clone's OWN manifest language, from the reference clip that
     Whisper classified at ingest. Governs the wizard's completion audition and
     the language the Voice Library displays; it does NOT govern book synth
     (there the book's language wins and overrides the manifest). Before this,
     no X-Language was ever sent, so every clone's manifest read "English". */
  it('promotes the clip language onto languageCode and sends the sidecar word to the derive', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-de',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'der alte leuchtturm',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
        languageCode: 'de',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-de',
        /* #1959 — relationship is incidental to this test; `self` needs no
           attestedBy. */
        consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.languageCode).toBe('de');
    /* The sidecar takes the language WORD, not the BCP-47 code. */
    expect(deriveMock).toHaveBeenCalledWith(
      expect.any(String),
      'qwen',
      expect.objectContaining({ language: 'German' }),
    );
  });

  /* An unsupported clip language must NOT fail the clone — the voice is
     perfectly usable, we just cannot label it. `sidecarLanguageName` throws for
     anything the registry does not know, so the route gates on
     `isSupportedLanguage` rather than catching. Unknown => no languageCode, no
     X-Language, and the sidecar keeps its own default. Never guess English. */
  it('leaves languageCode unset for an unsupported clip language without failing the clone', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-kl',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'unrecognised speech',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
        languageCode: 'kl',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-kl',
        /* #1959 — relationship is incidental to this test; `self` needs no
           attestedBy. */
        consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.provenance).toBe('cloned');
    expect(res.body.languageCode).toBeUndefined();
    const lastDerive = deriveMock.mock.calls[deriveMock.mock.calls.length - 1];
    expect(lastDerive[2]).not.toHaveProperty('language');
    /* #1951 review fix (M3) — and `master` KEEPS the raw `kl`. The two fields
       are deliberately different things: `entry.languageCode` is the VALIDATED
       language (gated on `isSupportedLanguage`, safe to render or hand to
       `sidecarLanguageName`), `entry.master.languageCode` is the RAW Whisper
       detection for the clip. Keeping the raw code is the only record of what
       Whisper actually heard — the difference between "Greenlandic, which we
       don't support" and "Whisper detected nothing". Nothing consumes it, so it
       cannot leak into a synth call. If a future change strips it, this
       assertion is the one that should stop it. */
    expect(res.body.master.languageCode).toBe('kl');
  });

  it('keeps transcriptSource=whisper when the transcript comes back unedited', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-unedited',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-unedited',
        transcript: 'my own voice sample',
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.master.transcriptSource).toBe('whisper');
    expect(res.body.master.transcript).toBe('my own voice sample');
  });

  /* Whisper can legitimately return an empty transcript for a non-speech
     clip (tts/clone-ingest.ts trims `.text`), so a blank edit falls back to
     the stored text rather than deriving against nothing. */
  it('falls back to the Whisper transcript when the supplied one is blank', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-blank',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-blank',
        transcript: '   ',
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(deriveMock).toHaveBeenCalledWith(
      expect.any(String),
      'qwen',
      expect.objectContaining({ refText: 'my own voice sample' }),
    );
    expect(res.body.master.transcript).toBe('my own voice sample');
    expect(res.body.master.transcriptSource).toBe('whisper');
  });

  /* The transcript is the first CLIENT-controlled value to reach the derive's
     refText, which travels to the sidecar as a base64 X-Ref-Text header — so
     it is bounded, and rejected rather than truncated. */
  it('400s an over-length transcript instead of truncating it', async () => {
    const { writeCandidate, readCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-long',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );

    const { MAX_CLONE_TRANSCRIPT_CHARS } = await import('./voice-library.js');
    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-long',
        transcript: 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS + 1),
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(400);
    expect(deriveMock).not.toHaveBeenCalled(); // rejected before any GPU work
    expect(await readCandidate('cand-long')).not.toBeNull(); // candidate intact
  });

  /* The cap is expressed in CHARACTERS but the constraint it protects is a
     BYTE budget: refText travels to the sidecar as a base64 X-Ref-Text header,
     and base64 applies to UTF-8 bytes. This pins the arithmetic that makes a
     character cap sufficient — worst case is a 3-byte BMP character per UTF-16
     unit — so that raising the cap without redoing the sums fails here rather
     than silently producing an oversized header for ja/zh/ru text (fs-59). */
  it('the character cap bounds the base64 X-Ref-Text header for multi-byte text', async () => {
    const { MAX_CLONE_TRANSCRIPT_CHARS } = await import('./voice-library.js');
    /* Worst case per UTF-16 unit is a 3-byte BMP character (astral chars cost
       4 bytes but 2 units; lone surrogates encode as 3-byte U+FFFD), so a
       cap-length CJK string is the byte-heaviest input the route accepts. */
    const atCap = '漢'.repeat(MAX_CLONE_TRANSCRIPT_CHARS);
    const base64Bytes = Buffer.from(atCap, 'utf8').toString('base64').length;
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_CLONE_TRANSCRIPT_CHARS * 3);
    /* h11's fallback budget is 16 KiB for the WHOLE request line + header
       block, and the 3b2 repair path re-sends this text plus a short
       X-Audition-Text. Derived from the constant, so RAISING THE CAP WITHOUT
       REDOING THE SUMS FAILS HERE — which is the entire justification for the
       route carrying no separate byte check. */
    expect(base64Bytes).toBeLessThan(16_384 - 2_048);
  });

  /* The cap lives in two places — MAX_CLONE_TRANSCRIPT_CHARS and the
     contract's CloneVoiceRequest.transcript.maxLength — tied together only by
     prose. Nothing else fails if one drifts, so pin them against each other
     (not against a second hardcoded literal, which pins nothing). */
  it('the route cap and openapi.yaml maxLength agree', async () => {
    const { MAX_CLONE_TRANSCRIPT_CHARS } = await import('./voice-library.js');
    const { readFile } = await import('node:fs/promises');
    const yaml = await readFile(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
    const anchor = yaml.indexOf('    CloneVoiceRequest:');
    expect(anchor).toBeGreaterThan(-1); // fail closed if the schema is renamed
    const transcriptBlock = yaml.slice(yaml.indexOf('        transcript:', anchor));
    const maxLength = /maxLength:\s*(\d+)/.exec(transcriptBlock)?.[1];
    expect(maxLength).toBe(String(MAX_CLONE_TRANSCRIPT_CHARS));
  });

  it('ignores a non-string transcript and falls back to the Whisper text', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-nonstring',
      {
        sampleRate: 24000,
        durationSeconds: 12,
        transcript: 'my own voice sample',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-nonstring',
        transcript: { nope: true },
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(deriveMock).toHaveBeenCalledWith(
      expect.any(String),
      'qwen',
      expect.objectContaining({ refText: 'my own voice sample' }),
    );
    expect(res.body.master.transcriptSource).toBe('whisper');
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

  /* Review follow-up on Task 10 — embed-client.ts rethrows NoCapacityError
     BARE (not tagged `transient: true`), so a GPU-contention failure of the
     advisory /embed call must ALSO be swallowed here, exactly like a
     transport failure — otherwise it reproduces the orphaned-.pt +
     leaked-candidate bug Task 10 exists to eliminate. */
  it('persists without a cosine when the ECAPA embed fails on GPU capacity contention — candidate still removed', async () => {
    const { writeCandidate, readCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-nocapacity',
      { sampleRate: 24000, durationSeconds: 12, transcript: 't', transcriptSource: 'whisper', captureMethod: 'upload' },
      Buffer.from('RIFF'),
    );
    decodeMock.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0]));
    // A REAL NoCapacityError instance — this is what embedSegment actually
    // throws on GPU contention (see embed-client.ts:73); it deliberately
    // does NOT carry `{ transient: true }`. Imported dynamically (post
    // beforeEach's vi.resetModules()) so this is the SAME class instance
    // the freshly re-imported route module's `instanceof` check sees —
    // a static top-level import here would be a stale pre-reset instance,
    // exactly the module-boundary trap #1801 warns about elsewhere in
    // this route file.
    const { NoCapacityError } = await import('../tts/tts-errors.js');
    assessFidelityMock.mockRejectedValueOnce(new NoCapacityError('coqui', 512, 'cuda:0'));

    const res = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-nocapacity',
        consent: { personName: 'X', relationship: 'self', permittedUse: 'personal' },
      });

    expect(res.status).toBe(200);
    expect(res.body.sampleMeta.qualityChecks.cloneFidelityUnavailable).toBe(true);
    expect(res.body.sampleMeta.qualityChecks.cloneCosine).toBeUndefined();

    expect(await readCandidate('cand-nocapacity')).toBeNull(); // candidate consumed, same as the transient path
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

  /* Plan 276 Decision 2 [R4] — the /clone response must apply
     `withComputedStaleness` before returning, not hand the raw entry to the
     client. This is load-bearing: a baseModel recorded at clone time can go
     stale relative to currentQwenBaseModel(), so a raw 'ready' slot can
     incorrectly read as ready when the computed status would say stale.
     Before the fix, the /clone endpoint returned the entry without applying
     this transform, while GET / did apply it, causing a mismatch: the clone
     response could show 'ready' for a slot the list would show as 'stale'.

     The fixture stubs an OUTDATED baseModel, so a raw (untransformed) /clone
     response would read 'ready' while the computed status must read 'stale'.
     The test asserts the /clone response itself shows 'stale' directly —
     not merely that it agrees with a second GET /, which stays green
     regardless of whether the transform runs if both sides share the same
     stub (the earlier, vacuous version of this test) — then cross-checks
     GET / reports the same 'stale' status for good measure. */
  it('applies withComputedStaleness to /clone response, same as GET / does', async () => {
    const { writeCandidate } = await import('../workspace/clone-candidate.js');
    await writeCandidate(
      'cand-transform-test',
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

    // Override deriveMock for this test to return an OUTDATED baseModel
    // so the cloned entry will compute as stale, proving withComputedStaleness
    // is applied. The test fixture uses an old model string that never matches
    // the current one, ensuring staleness detection is exercised.
    const oldModel = 'some/outdated-base-model';
    deriveMock.mockResolvedValueOnce({
      previewPcm: Buffer.from([1, 2, 3, 4]),
      sampleRate: 24_000,
      baseModel: oldModel,
    });

    // Call /clone and capture the response
    const cloneRes = await request(app)
      .post('/api/voice-library/clone')
      .send({
        candidateId: 'cand-transform-test',
        consent: { personName: 'Test', relationship: 'self', permittedUse: 'personal' },
      });

    expect(cloneRes.status).toBe(200);
    expect(cloneRes.body.engines.qwen.baseModel).toBe(oldModel);
    // The /clone response must show 'stale' because withComputedStaleness
    // compares the recorded baseModel against currentQwenBaseModel()
    expect(cloneRes.body.engines.qwen.status).toBe('stale');
    const clonedUuid = cloneRes.body.voiceUuid;

    // Now fetch the library via GET / which also applies withComputedStaleness
    const getRes = await request(app).get('/api/voice-library');
    expect(getRes.status).toBe(200);

    const voiceInList = (getRes.body.voices as Array<{ voiceUuid: string; engines: any }>).find(
      (v) => v.voiceUuid === clonedUuid
    );

    expect(voiceInList).toBeDefined();
    // Both responses must show 'stale', proving the transform is consistently applied
    expect(voiceInList!.engines.qwen.status).toBe('stale');
    expect(voiceInList!.engines.qwen.status).toBe(cloneRes.body.engines.qwen.status);
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

  /* Wave 3b2, Task 3 — revoke purges resynthesis-capable clone artifacts via
     purgeCloneArtifacts, WITHOUT deleting the entry dir: the manifest
     (voice.json) stays readable so the revoked entry is still
     visible/inspectable in the library. Proven via real erasure effects (not
     a spy) — see the file-header note above the hoisted mocks for why a
     self-mocked spy on purgeCloneArtifacts was rejected.

     Task 14a — this test used to mock the sidecar as unreachable and assert
     ONLY a clean 200, i.e. it pinned the OLD swallowing contract: a failed
     sidecar evict (3 calls here — qwen base, qwen -preview, xtts — all
     rejecting) never surfaced anywhere in the response. That is exactly the
     Property-2 residual Task 14a closes, so this test now asserts the NEW
     contract instead: `artifactPurgeIncomplete` is true and
     `artifactPurgeFailedPaths` names all three failed sidecar evicts. The
     revoke still succeeds (200, revokedAt set, files gone) — only the
     "silent total success" claim is what's fixed. */
  it('purges clone artifacts (no deleteEntryDir) and leaves voice.json readable', async () => {
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
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app).post(`/api/voice-library/${voiceUuid}/revoke`);

      expect(res.status).toBe(200);
      expect(res.body.consent.revokedAt).toBeTruthy();

      // The engine artifacts (resynthesis-capable) are purged...
      expect(existsSync(qwenVoice.qwenVoicePtPath(qwenName))).toBe(false);
      expect(existsSync(pt17bPath)).toBe(false);
      // ...but the manifest dir survives (no deleteEntryDir).
      const onDisk = await vl.readEntry(voiceUuid);
      expect(onDisk?.consent?.revokedAt).toBeTruthy();

      // Task 14a — the sidecar is unreachable (a non-ECONNREFUSED rejection
      // — "sidecar unreachable" carries no proof the sidecar is actually
      // DOWN, so it's the genuine-failure case, not the ECONNREFUSED
      // fail-open carve-out) for every evict call in this test, so the
      // revoke response must say so rather than claiming clean erasure it
      // didn't achieve. Fix round 1, LOW-2 — all three markers pinned
      // exactly (was `stringContaining` on the xtts one, which would still
      // pass with a wrong or empty key).
      expect(res.body.artifactPurgeIncomplete).toBe(true);
      expect(res.body.artifactPurgeFailedPaths).toEqual([
        `sidecar:qwen:${qwenName}`,
        `sidecar:qwen:${qwenName}-preview`,
        `sidecar:xtts:xtts-${voiceUuid}`,
      ]);

      // CodeQL #210/#224: console.warn fix — voiceUuid and failed.length are now
      // %s/%d placeholder arguments, not interpolated into the format string.
      // The format string must NOT contain the voiceUuid.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.not.stringContaining(voiceUuid),
        voiceUuid,
        3, // purgeResult.failed.length (3 sidecar evict failures)
        expect.any(Array),
      );
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  /* User-directed fix — revoke must ALSO erase the person's original
     recording (the entry-dir clip), behind the two-step frontend confirm.
     Node-side: the file itself is unlinked AND the manifest's `master`
     field is cleared (a manifest pointing at a deleted file would be a
     lie — and the resolver/card already treat an absent `master` as
     Broken, which a revoked voice already is via the revoked rule). This
     test would have failed before the fix (the prior behaviour retained
     `master.wav` on disk — see the "leaves voice.json readable" test above,
     which asserted survival until this same change flipped it). */
  it('also erases the entry-dir recording (master.wav) and clears the manifest master field', async () => {
    const voiceUuid = 'r-erase-master';
    await vl.writeEntry(
      makeEntry({
        voiceUuid,
        name: 'Mum',
        provenance: 'cloned',
        consent: {
          personName: 'Mum',
          relationship: 'family-with-permission',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00.000Z',
          attestedBy: 'me',
        },
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
      }),
    );
    const masterPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(masterPath, 'fake-wav-bytes');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sidecar unreachable'));
    try {
      const res = await request(app).post(`/api/voice-library/${voiceUuid}/revoke`);

      expect(res.status).toBe(200);
      expect(res.body.consent.revokedAt).toBeTruthy();
      expect(res.body.master).toBeUndefined(); // response reflects the post-purge state

      // The actual recording is gone...
      expect(existsSync(masterPath)).toBe(false);
      // ...and the manifest no longer points at it, but is still intact/readable.
      const onDisk = await vl.readEntry(voiceUuid);
      expect(onDisk).not.toBeNull();
      expect(onDisk?.master).toBeUndefined();
      expect(onDisk?.consent?.revokedAt).toBeTruthy();
      expect(onDisk?.name).toBe('Mum');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
