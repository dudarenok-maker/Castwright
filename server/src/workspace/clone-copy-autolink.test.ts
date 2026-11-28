/* #4952 — auto-link of pre-#4954 "Save to my voices" copies of a cloned voice.
   A copy is a `designed` entry with `promotedFrom` and no `consent`. Manifests
   below are in the shapes the sidecar REALLY writes (`voiceUuid` is always null;
   `/qwen/clone-voice` passes none): a pre-494b9774 copy keeps `voiceId:
   qwen-<cloneUuid>` (the recorded origin); a v1.15.0 copy has `voiceId` restamped
   to its own key (clone signature, no origin); else the `.pt` bytes equal a clone's. The migration
   re-labels it `cloned` carrying the clone's consent + `clonedFrom`, so the
   clone's revoke (purgeCloneArtifacts cascade) reaches it. The entry is never
   removed. Tempdir-workspace fixture, same shape as purge-clone-artifacts.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceLibraryEntry } from './voice-library.js';

/* Hooks into the REAL voice-library: run `afterUpdate` once after the next
   successful updateEntry (race test), or fail `listEntries` once (cascade test). */
const hooks = vi.hoisted(() => ({
  afterUpdate: null as null | (() => Promise<void>),
  failListEntriesWhen: null as null | (() => boolean),
  failUpdateFor: null as null | string,
  bookRoot: '',
}));
// A real book folder needs a full state.json fixture; the slot read only needs
// `withBookOp` to hand it a bookDir, so resolve that to a tempdir path.
vi.mock('./book-op-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./book-op-lock.js')>()),
  withBookOp: async (bookId: string, fn: (b: { bookDir: string }) => Promise<unknown>) =>
    fn({ bookDir: join(hooks.bookRoot, 'bk', bookId) }),
}));
vi.mock('./voice-library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-library.js')>();
  return {
    ...actual,
    updateEntry: async (...args: Parameters<typeof actual.updateEntry>) => {
      if (hooks.failUpdateFor === args[0]) throw new Error('entry lock timeout');
      const r = await actual.updateEntry(...args);
      const h = hooks.afterUpdate;
      if (h) {
        hooks.afterUpdate = null;
        await h();
      }
      return r;
    },
    listEntries: async () => {
      if (hooks.failListEntriesWhen?.()) throw new Error('listing failed');
      return actual.listEntries();
    },
  };
});

let dir: string;
let mig: typeof import('./clone-copy-autolink.js');
let purge: typeof import('./purge-clone-artifacts.js');
let paths: typeof import('./paths.js');
let vl: typeof import('./voice-library.js');

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';
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

const pt = (uuid: string) => join(paths.qwenVoicesDir(), `qwen-${uuid}.pt`);
const seedPt = (uuid: string, bytes: string) => writeFileSync(pt(uuid), bytes);
const seedManifest = (uuid: string, m: Record<string, unknown>) =>
  writeFileSync(join(paths.qwenVoicesDir(), `qwen-${uuid}.json`), JSON.stringify(m));
/* What `/qwen/clone-voice` writes: voiceUuid is ALWAYS null (the route passes none). */
const realCloneManifest = (voiceId: string) => ({
  voiceId,
  voiceUuid: null,
  refText: 'x',
  language: 'English',
  baseModel: 'q',
  designModel: null,
  clone: true,
});
// Era 1 (before 494b9774): /promote copied the json verbatim, so voiceId still names the clone.
const pre494 = (clone: string) => realCloneManifest(`qwen-${clone}`);
// Era 2 (v1.15.0): /promote restamped voiceId to the copy's own key; no origin remains.
const v115 = (copy: string) => realCloneManifest(`qwen-${copy}`);

const CLONE = 'clone-1';
const COPY = 'copy-1';
const promotedFrom = { bookId: 'b1', characterId: 'c1' };

async function seedClone(over: Partial<VoiceLibraryEntry> = {}, bytes: string | null = 'clone-bytes') {
  await vl.writeEntry(entry({ voiceUuid: CLONE, provenance: 'cloned', consent, ...over }));
  if (bytes !== null) seedPt(CLONE, bytes);
}
async function seedCopy(bytes: string, manifest: Record<string, unknown> | null, over: Partial<VoiceLibraryEntry> = {}) {
  await vl.writeEntry(entry({ voiceUuid: COPY, promotedFrom, createdAt: LATER, ...over }));
  seedPt(COPY, bytes);
  if (manifest) seedManifest(COPY, manifest);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-clone-autolink-'));
  process.env.WORKSPACE_DIR = dir;
  hooks.afterUpdate = null;
  hooks.failListEntriesWhen = null;
  hooks.failUpdateFor = null;
  hooks.bookRoot = dir;
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

function writeCast(slot: unknown) {
  const bookDir = join(dir, 'bk', promotedFrom.bookId);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    paths.castJsonPath(bookDir),
    JSON.stringify({ characters: [{ id: promotedFrom.characterId, overrideTtsVoices: { qwen: slot } }] }),
  );
}
const revokedClone = { ...consent, revokedAt: NOW };
const slotNaming = (uuid: string) => ({ provenance: 'cloned', libraryUuid: uuid });

describe('autolinkCloneCopies', () => {
  describe('era 1 — copy made before 494b9774 (voiceId still names the clone)', () => {
    it('links by voiceId, keeping both entries and files', async () => {
      await seedClone();
      await seedCopy('clone-bytes', pre494(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [COPY], unmatched: 0 });
      const copy = await vl.readEntry(COPY);
      expect(copy?.provenance).toBe('cloned');
      expect(copy?.clonedFrom).toBe(CLONE);
      expect(copy?.consent).toEqual(consent);
      expect(copy?.promotedFrom).toEqual(promotedFrom);
      expect(existsSync(pt(COPY))).toBe(true);
      expect(existsSync(pt(CLONE))).toBe(true);
    });

    it('links by voiceId when the clone was re-derived since (bytes differ)', async () => {
      await seedClone({}, 're-derived-bytes');
      await seedCopy('original-copy-bytes', pre494(CLONE));
      expect((await mig.autolinkCloneCopies()).linked).toEqual([COPY]);
    });

    it('links a copy of an already-revoked clone (bytes erased) as revoked and erases its voice files, no cast read needed', async () => {
      await seedClone({ consent: revokedClone }, null);
      await seedCopy('person-voice', pre494(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [COPY], unmatched: 0 });
      const copy = await vl.readEntry(COPY);
      expect(copy?.clonedFrom).toBe(CLONE);
      expect(copy?.consent?.revokedAt).toBe(NOW);
      expect(existsSync(pt(COPY))).toBe(false);
    });
  });

  describe('era 2 — v1.15.0 copy (voiceId restamped, no recorded origin)', () => {
    it('links by identical bytes when the clone is live', async () => {
      await seedClone();
      await seedCopy('clone-bytes', v115(COPY));
      expect((await mig.autolinkCloneCopies()).linked).toEqual([COPY]);
    });

    it('revoked clone: links revoked + erases ONLY when the cast slot at promotedFrom names it', async () => {
      await seedClone({ consent: revokedClone }, null);
      await seedCopy('person-voice', v115(COPY));
      writeCast(slotNaming(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [COPY], unmatched: 0 });
      const copy = await vl.readEntry(COPY);
      expect(copy?.clonedFrom).toBe(CLONE);
      expect(copy?.consent?.revokedAt).toBe(NOW);
      expect(existsSync(pt(COPY))).toBe(false);
    });

    it.each([
      ['a non-cloned slot', { provenance: 'designed', libraryUuid: CLONE }],
      ['a slot naming a clone that is not in the library', slotNaming('ghost')],
      ['no slot at all', undefined],
    ])('revoked clone: %s leaves the copy designed and counts it', async (_l, slot) => {
      await seedClone({ consent: revokedClone }, null);
      await seedCopy('person-voice', v115(COPY));
      writeCast(slot);
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
      expect(existsSync(pt(COPY))).toBe(true);
    });

    it('a slot naming a LIVE clone is not enough, even when another revoked clone exists', async () => {
      await seedClone({ consent: revokedClone }, null);
      await vl.writeEntry(entry({ voiceUuid: 'live-2', provenance: 'cloned', consent }));
      await seedCopy('older-bytes', v115(COPY));
      writeCast(slotNaming('live-2'));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
    });

    it('a slot naming a revoked clone whose .pt survives with other bytes is not enough', async () => {
      await seedClone({ consent: revokedClone }, 'still-here');
      await seedCopy('different', v115(COPY));
      writeCast(slotNaming(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });
  });

  describe('the manifest predicate — every conjunct has a red test', () => {
    // A pre-494 voiceId naming a LIVE, usable clone: if the guard under test were
    // dropped, the voice would link. Each variant must stay designed and uncounted.
    const withoutClone = (): Record<string, unknown> => {
      const m: Record<string, unknown> = { ...pre494(CLONE) };
      delete m.clone;
      return m;
    };
    it.each([
      ['clone is not true', { ...pre494(CLONE), clone: false }],
      ['clone is absent', withoutClone()],
      ['designModel is set', { ...pre494(CLONE), designModel: 'Qwen3-TTS-VoiceDesign-1.7B' }],
      ['instruct is set', { ...pre494(CLONE), instruct: 'gravelly old sailor' }],
    ])('%s -> not a copy: untouched and uncounted', async (_l, manifest) => {
      await seedClone();
      await seedCopy('different-bytes', manifest as Record<string, unknown>);
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
      expect(existsSync(pt(COPY))).toBe(true);
    });

    it('a voiceId without the qwen- prefix carries no origin: counted, not linked', async () => {
      await seedClone();
      await seedCopy('different-bytes', realCloneManifest(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
    });

    it('a voiceId naming the candidate itself carries no origin (era-2 shape): counted, not linked', async () => {
      await seedClone();
      await seedCopy('different-bytes', v115(COPY));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });

    it('FALSE POSITIVE: a VoiceDesign voice stays designed even when its character now names a revoked clone', async () => {
      await seedClone({ consent: revokedClone }, null);
      await vl.writeEntry(entry({ voiceUuid: 'D1', persona: 'gravelly old sailor', promotedFrom, createdAt: LATER }));
      seedPt('D1', 'voicedesign-bytes');
      seedManifest('D1', {
        voiceId: 'qwen-D1',
        instruct: 'gravelly old sailor',
        designModel: 'Qwen3-TTS-VoiceDesign-1.7B',
      });
      writeCast(slotNaming(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
      const d = await vl.readEntry('D1');
      expect(d?.provenance).toBe('designed');
      expect(existsSync(pt('D1'))).toBe(true);
    });
  });

  describe('guards and no-ops', () => {
    it('links by bytes alone when the copy has no sidecar manifest', async () => {
      await seedClone();
      await seedCopy('clone-bytes', null);
      expect((await mig.autolinkCloneCopies()).linked).toEqual([COPY]);
    });

    it('leaves a designed entry with different bytes and no manifest untouched, uncounted', async () => {
      await seedClone();
      await seedCopy('genuinely-designed', null);
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
    });

    it('leaves a byte-identical designed entry with no promotedFrom untouched', async () => {
      await seedClone();
      await seedCopy('clone-bytes', pre494(CLONE), { promotedFrom: undefined });
      expect((await mig.autolinkCloneCopies()).linked).toEqual([]);
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
    });

    it('counts, and does not link, a voiceId naming a clone that is not in the library', async () => {
      await seedCopy('b', pre494('ghost'));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
      expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
    });

    it('does not link when the manifest and the bytes name different clones', async () => {
      await seedClone();
      await vl.writeEntry(entry({ voiceUuid: 'clone-2', provenance: 'cloned', consent }));
      seedPt('clone-2', 'other-clone-bytes');
      await seedCopy('other-clone-bytes', pre494(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });

    it('does not link a copy that predates the clone it names (createdAt guard)', async () => {
      await seedClone({ createdAt: '2026-03-01T00:00:00.000Z' });
      await seedCopy('clone-bytes', pre494(CLONE), { createdAt: LATER });
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });

    it('does not link to an entry that is itself a linked copy (clonedFrom guard)', async () => {
      await seedClone({ clonedFrom: 'someone' });
      await seedCopy('clone-bytes', pre494(CLONE));
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    });

    it('is a no-op on a second run', async () => {
      await seedClone();
      await seedCopy('clone-bytes', pre494(CLONE));
      await mig.autolinkCloneCopies();
      const first = await vl.readEntry(COPY);
      expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
      expect(await vl.readEntry(COPY)).toEqual(first);
    });

    it('closes the boot-time race: a revoke landing after the clone read still revokes and purges the copy', async () => {
      await seedClone();
      await seedCopy('clone-bytes', pre494(CLONE));
      hooks.afterUpdate = async () => {
        await vl.updateEntry(CLONE, (e) =>
          e?.consent ? { ...e, consent: { ...e.consent, revokedAt: NOW } } : null,
        );
      };
      await mig.autolinkCloneCopies();
      expect((await vl.readEntry(COPY))?.consent?.revokedAt).toBeTruthy();
      expect(existsSync(pt(COPY))).toBe(false);
    });
  });
});

describe('purgeCloneArtifacts cascade and boot retry', () => {
  async function linkedPair() {
    await seedClone();
    await seedCopy('clone-bytes', pre494(CLONE));
    await mig.autolinkCloneCopies();
  }
  const revokeClone = () =>
    vl.updateEntry(CLONE, (e) => (e?.consent ? { ...e, consent: { ...e.consent, revokedAt: NOW } } : null));

  it('revoking the clone afterwards revokes the copy and erases its artifacts', async () => {
    await linkedPair();
    await revokeClone();
    const { failed } = await purge.purgeCloneArtifacts(CLONE, { deleteMasterClip: true });
    expect(failed).toEqual([]);
    expect(existsSync(pt(COPY))).toBe(false);
    expect(existsSync(pt(CLONE))).toBe(false);
    const copy = await vl.readEntry(COPY);
    expect(copy?.consent?.revokedAt).toBeTruthy();
    expect(vl.clonedVoiceLacksConsent(copy)).toBe(true);
  });

  it('never throws when listing copies fails: records a cascade marker and still erases the clone', async () => {
    await linkedPair();
    hooks.failListEntriesWhen = () => true;
    const { failed } = await purge.purgeCloneArtifacts(CLONE, {});
    expect(failed).toEqual([`cascade:${CLONE}`]);
    expect(existsSync(pt(CLONE))).toBe(false);
    expect(purge.toClientPurgePaths(failed)).toEqual([`cascade:${CLONE}`]);
  });

  it('a failed per-copy stamp is recorded, does not throw, and the next boot finishes it (retry keyed on the clone)', async () => {
    await linkedPair();
    await revokeClone();
    hooks.failUpdateFor = COPY;
    const { failed } = await purge.purgeCloneArtifacts(CLONE, {});
    expect(failed).toContain(`cascade:${COPY}`);
    expect(existsSync(pt(CLONE))).toBe(false);
    const stuck = await vl.readEntry(COPY);
    expect(stuck?.consent?.revokedAt).toBeUndefined(); // live consent, playable
    expect(existsSync(pt(COPY))).toBe(true);

    hooks.failUpdateFor = null;
    await mig.autolinkCloneCopies();
    expect((await vl.readEntry(COPY))?.consent?.revokedAt).toBeTruthy();
    expect(existsSync(pt(COPY))).toBe(false);
  });

  it('boot also finishes a copy whose clone was deleted outright', async () => {
    await linkedPair();
    await vl.removeEntryDir(CLONE);
    await mig.autolinkCloneCopies();
    expect((await vl.readEntry(COPY))?.consent?.revokedAt).toBeTruthy();
    expect(existsSync(pt(COPY))).toBe(false);
  });
});
