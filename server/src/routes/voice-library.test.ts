/* fs-38 Wave 1, Task 4 — GET /api/voice-library (list, pinned-first then
   updatedAt desc, with at-list-time staleness) + PATCH /api/voice-library/:voiceUuid
   (name/tags/pinned/persona edit).

   Mirrors the tempdir-workspace integration pattern used by
   workspace/voice-library.test.ts and routes/voices.test.ts: mkdtempSync +
   WORKSPACE_DIR env + vi.resetModules() so paths.ts / model-paths.ts re-read
   their env-derived state fresh per test, then a real express app mounted
   with the gate + router exactly as app.ts does. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let dir: string;
let app: Express;
let vl: typeof import('../workspace/voice-library.js');
let modelPaths: typeof import('../tts/model-paths.js');
let writeConfigOverride: typeof import('../workspace/user-settings.js').writeConfigOverride;

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
  vi.resetModules();

  const [{ voiceLibraryRouter }, { requireVoiceLibraryEnabled }, voiceLibMod, modelPathsMod, userSettings] =
    await Promise.all([
      import('./voice-library.js'),
      import('./voice-library-gate.js'),
      import('../workspace/voice-library.js'),
      import('../tts/model-paths.js'),
      import('../workspace/user-settings.js'),
    ]);
  vl = voiceLibMod;
  modelPaths = modelPathsMod;
  writeConfigOverride = userSettings.writeConfigOverride;

  app = express();
  app.use(express.json());
  app.use('/api/voice-library', requireVoiceLibraryEnabled, voiceLibraryRouter);
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
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
