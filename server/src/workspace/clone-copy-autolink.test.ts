/* #4952 — one-time auto-link of pre-#4954 "Save to my voices" copies of a
   cloned voice. A copy is a `designed` entry with `promotedFrom`, no `consent`,
   and `qwen-<uuid>.pt` bytes identical to a cloned entry's. The migration
   re-labels it `cloned` carrying the clone's consent + `clonedFrom`, so the
   clone's revoke (purgeCloneArtifacts cascade) reaches it. Nothing is deleted.
   Tempdir-workspace fixture, same shape as purge-clone-artifacts.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceLibraryEntry } from './voice-library.js';

const bookRoot = vi.hoisted(() => ({ dir: '' }));
// A real book folder needs a full state.json fixture; the migration only needs
// `withBookOp` to hand it a bookDir, so resolve that to a tempdir path.
vi.mock('./book-op-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./book-op-lock.js')>()),
  withBookOp: async (bookId: string, fn: (b: { bookDir: string }) => Promise<unknown>) =>
    fn({ bookDir: join(bookRoot.dir, 'bk', bookId) }),
}));

let dir: string;
let mig: typeof import('./clone-copy-autolink.js');
let purge: typeof import('./purge-clone-artifacts.js');
let paths: typeof import('./paths.js');
let vl: typeof import('./voice-library.js');

const NOW = '2026-01-01T00:00:00.000Z';
const consent = {
  personName: 'Ada',
  relationship: 'self' as const,
  permittedUse: 'personal' as const,
  attestedAt: NOW,
  attestedBy: 'Ada',
};

function entry(over: Partial<VoiceLibraryEntry> & { voiceUuid: string }): VoiceLibraryEntry {
  return {
    name: over.voiceUuid,
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: { qwen: { status: 'ready' } },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function seedPt(uuid: string, bytes: string): string {
  const p = join(paths.qwenVoicesDir(), `qwen-${uuid}.pt`);
  writeFileSync(p, bytes);
  return p;
}

const CLONE = 'clone-1';
const COPY = 'copy-1';
const promotedFrom = { bookId: 'b1', characterId: 'c1' };

async function seedCloneAndCopy(opts: { copyBytes?: string } = {}) {
  await vl.writeEntry(entry({ voiceUuid: CLONE, provenance: 'cloned', consent }));
  await vl.writeEntry(entry({ voiceUuid: COPY, promotedFrom }));
  seedPt(CLONE, 'clone-bytes');
  seedPt(COPY, opts.copyBytes ?? 'clone-bytes');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-clone-autolink-'));
  process.env.WORKSPACE_DIR = dir;
  bookRoot.dir = dir;
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vl = await import('./voice-library.js');
  purge = await import('./purge-clone-artifacts.js');
  mig = await import('./clone-copy-autolink.js');
  paths = await import('./paths.js');
  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
  mkdirSync(paths.xttsVoicesDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('autolinkCloneCopies', () => {
  it('re-labels a byte-identical consent-free copy as the clone, deleting nothing', async () => {
    await seedCloneAndCopy();
    const r = await mig.autolinkCloneCopies();
    expect(r.linked).toEqual([COPY]);
    const copy = await vl.readEntry(COPY);
    expect(copy?.provenance).toBe('cloned');
    expect(copy?.clonedFrom).toBe(CLONE);
    expect(copy?.consent).toEqual(consent);
    expect(copy?.promotedFrom).toEqual(promotedFrom);
    expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${COPY}.pt`))).toBe(true);
    expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${CLONE}.pt`))).toBe(true);
  });

  it('leaves a designed entry with different bytes untouched', async () => {
    await seedCloneAndCopy({ copyBytes: 'genuinely-designed' });
    const r = await mig.autolinkCloneCopies();
    expect(r.linked).toEqual([]);
    const copy = await vl.readEntry(COPY);
    expect(copy?.provenance).toBe('designed');
    expect(copy?.clonedFrom).toBeUndefined();
  });

  it('leaves a byte-identical designed entry with no promotedFrom untouched', async () => {
    await vl.writeEntry(entry({ voiceUuid: CLONE, provenance: 'cloned', consent }));
    await vl.writeEntry(entry({ voiceUuid: COPY }));
    seedPt(CLONE, 'same');
    seedPt(COPY, 'same');
    expect((await mig.autolinkCloneCopies()).linked).toEqual([]);
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('is a no-op on a second run', async () => {
    await seedCloneAndCopy();
    await mig.autolinkCloneCopies();
    const first = await vl.readEntry(COPY);
    const r = await mig.autolinkCloneCopies();
    expect(r.linked).toEqual([]);
    expect(await vl.readEntry(COPY)).toEqual(first);
  });

  it('revoking the clone afterwards revokes the copy and erases its artifacts', async () => {
    await seedCloneAndCopy();
    await mig.autolinkCloneCopies();
    await vl.updateEntry(CLONE, (e) =>
      e?.consent ? { ...e, consent: { ...e.consent, revokedAt: NOW } } : null,
    );
    const { failed } = await purge.purgeCloneArtifacts(CLONE, { deleteMasterClip: true });
    expect(failed).toEqual([]);
    expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${COPY}.pt`))).toBe(false);
    expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${CLONE}.pt`))).toBe(false);
    const copy = await vl.readEntry(COPY);
    expect(copy?.consent?.revokedAt).toBeTruthy();
    expect(vl.clonedVoiceLacksConsent(copy)).toBe(true);
  });

  it('a copy of an already-revoked clone whose bytes survive is linked revoked and purged', async () => {
    await vl.writeEntry(
      entry({ voiceUuid: CLONE, provenance: 'cloned', consent: { ...consent, revokedAt: NOW } }),
    );
    await vl.writeEntry(entry({ voiceUuid: COPY, promotedFrom }));
    seedPt(CLONE, 'left-behind');
    seedPt(COPY, 'left-behind');
    const r = await mig.autolinkCloneCopies();
    expect(r.linked).toEqual([COPY]);
    const copy = await vl.readEntry(COPY);
    expect(copy?.consent?.revokedAt).toBe(NOW);
    expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${COPY}.pt`))).toBe(false);
  });

  it('counts consent-free promoted copies it cannot match, without touching them', async () => {
    await vl.writeEntry(entry({ voiceUuid: COPY, promotedFrom }));
    seedPt(COPY, 'orphan');
    const r = await mig.autolinkCloneCopies();
    expect(r).toEqual({ linked: [], unmatched: 1 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  describe('by recorded origin (clone revoked before the migration ran)', () => {
    async function seedRevokedClone(opts: { slot?: unknown; clonePt?: boolean } = {}) {
      await vl.writeEntry(
        entry({ voiceUuid: CLONE, provenance: 'cloned', consent: { ...consent, revokedAt: NOW } }),
      );
      await vl.writeEntry(entry({ voiceUuid: COPY, promotedFrom, createdAt: '2026-02-01T00:00:00.000Z' }));
      seedPt(COPY, 'bytes-no-longer-comparable');
      if (opts.clonePt) seedPt(CLONE, 'different');
      const slot = 'slot' in opts ? opts.slot : { provenance: 'cloned', libraryUuid: CLONE };
      const bookDir = join(dir, 'bk', promotedFrom.bookId);
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      writeFileSync(
        paths.castJsonPath(bookDir),
        JSON.stringify({ characters: [{ id: promotedFrom.characterId, overrideTtsVoices: { qwen: slot } }] }),
      );
    }

    it('links a copy whose character slot names exactly one revoked clone, revoked and purged', async () => {
      await seedRevokedClone();
      const r = await mig.autolinkCloneCopies();
      expect(r).toEqual({ linked: [COPY], unmatched: 0 });
      const copy = await vl.readEntry(COPY);
      expect(copy?.clonedFrom).toBe(CLONE);
      expect(copy?.consent?.revokedAt).toBe(NOW);
      expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${COPY}.pt`))).toBe(false);
    });

    it('leaves it designed and counts it when the slot is not a cloned one', async () => {
      await seedRevokedClone({ slot: { provenance: 'designed', libraryUuid: CLONE } });
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
      expect(existsSync(join(paths.qwenVoicesDir(), `qwen-${COPY}.pt`))).toBe(true);
    });

    it('leaves it designed when the named clone is not revoked', async () => {
      await seedRevokedClone();
      await vl.updateEntry(CLONE, (e) => (e?.consent ? { ...e, consent: { ...consent } } : null));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });

    it('leaves it designed when the clone bytes still exist but differ', async () => {
      await seedRevokedClone({ clonePt: true });
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });
  });
});
