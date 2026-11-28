/* #4952 — auto-link of pre-#4954 "Save to my voices" copies of a cloned voice.
   A copy is a `designed` entry with `promotedFrom` and no `consent` whose OWN
   sidecar manifest still names the clone (`clone: true`, `voiceUuid`), or
   (no usable manifest) whose `.pt` bytes equal a clone's. The migration
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
}));
vi.mock('./voice-library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-library.js')>();
  return {
    ...actual,
    updateEntry: async (...args: Parameters<typeof actual.updateEntry>) => {
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
/* What the sidecar's clone_voice writes (main.py) and /promote copies unchanged
   apart from `voiceId`. */
const cloneManifest = (ofClone: string, asKey: string) => ({
  voiceId: asKey,
  voiceUuid: ofClone,
  refText: 'x',
  language: 'English',
  baseModel: 'q',
  designModel: null,
  clone: true,
});

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
  it('links a copy by its own sidecar manifest, keeping both entries and files', async () => {
    await seedClone();
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    const r = await mig.autolinkCloneCopies();
    expect(r).toEqual({ linked: [COPY], unmatched: 0 });
    const copy = await vl.readEntry(COPY);
    expect(copy?.provenance).toBe('cloned');
    expect(copy?.clonedFrom).toBe(CLONE);
    expect(copy?.consent).toEqual(consent);
    expect(copy?.promotedFrom).toEqual(promotedFrom);
    expect(existsSync(pt(COPY))).toBe(true);
    expect(existsSync(pt(CLONE))).toBe(true);
  });

  it('links by manifest when the clone was re-derived since (bytes differ)', async () => {
    await seedClone({}, 're-derived-bytes');
    await seedCopy('original-copy-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    expect((await mig.autolinkCloneCopies()).linked).toEqual([COPY]);
  });

  it('links by bytes alone when the copy has no sidecar manifest', async () => {
    await seedClone();
    await seedCopy('clone-bytes', null);
    expect((await mig.autolinkCloneCopies()).linked).toEqual([COPY]);
  });

  it('links a copy of an already-revoked clone (bytes erased) as revoked and erases its voice files', async () => {
    await seedClone({ consent: { ...consent, revokedAt: NOW } }, null);
    await seedCopy('person-voice', cloneManifest(CLONE, `qwen-${COPY}`));
    const r = await mig.autolinkCloneCopies();
    expect(r).toEqual({ linked: [COPY], unmatched: 0 });
    const copy = await vl.readEntry(COPY);
    expect(copy?.clonedFrom).toBe(CLONE);
    expect(copy?.consent?.revokedAt).toBe(NOW);
    expect(existsSync(pt(COPY))).toBe(false);
  });

  it('FALSE POSITIVE (review repro): a VoiceDesign voice stays designed even if its character now names a revoked clone', async () => {
    await seedClone({ consent: { ...consent, revokedAt: NOW } }, null);
    await vl.writeEntry(entry({ voiceUuid: 'D1', persona: 'gravelly old sailor', promotedFrom, createdAt: LATER }));
    seedPt('D1', 'voicedesign-bytes');
    seedManifest('D1', {
      voiceId: 'qwen-D1',
      instruct: 'gravelly old sailor',
      designModel: 'Qwen3-TTS-VoiceDesign-1.7B',
    });
    const r = await mig.autolinkCloneCopies();
    expect(r).toEqual({ linked: [], unmatched: 0 });
    const d = await vl.readEntry('D1');
    expect(d?.provenance).toBe('designed');
    expect(d?.clonedFrom).toBeUndefined();
    expect(existsSync(pt('D1'))).toBe(true);
  });

  it('a designed voice that self-healed (clone:true but designModel set / own uuid) is not a copy', async () => {
    await seedClone({ consent: { ...consent, revokedAt: NOW } }, null);
    await seedCopy('b', { ...cloneManifest(CLONE, `qwen-${COPY}`), designModel: 'VoiceDesign' });
    expect((await mig.autolinkCloneCopies()).linked).toEqual([]);
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');

    await seedCopy('b', cloneManifest(COPY, `qwen-${COPY}`));
    expect((await mig.autolinkCloneCopies()).linked).toEqual([]);
    expect(existsSync(pt(COPY))).toBe(true);
  });

  it('leaves a designed entry with different bytes and no manifest untouched, uncounted', async () => {
    await seedClone();
    await seedCopy('genuinely-designed', null);
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('leaves a byte-identical designed entry with no promotedFrom untouched', async () => {
    await seedClone();
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`), { promotedFrom: undefined });
    expect((await mig.autolinkCloneCopies()).linked).toEqual([]);
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('counts, and does not link, a manifest naming a clone that is not in the library', async () => {
    await seedCopy('b', cloneManifest('ghost', `qwen-${COPY}`));
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('does not link when the manifest and the bytes name different clones', async () => {
    await seedClone();
    await vl.writeEntry(entry({ voiceUuid: 'clone-2', provenance: 'cloned', consent }));
    seedPt('clone-2', 'other-clone-bytes');
    await seedCopy('other-clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('does not link a copy that predates the clone it names (createdAt guard)', async () => {
    await seedClone({ createdAt: '2026-03-01T00:00:00.000Z' });
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`), { createdAt: LATER });
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('does not link to an entry that is itself a linked copy (clonedFrom guard)', async () => {
    await seedClone({ clonedFrom: 'someone' });
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 1 });
    expect((await vl.readEntry(COPY))?.provenance).toBe('designed');
  });

  it('is a no-op on a second run', async () => {
    await seedClone();
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    await mig.autolinkCloneCopies();
    const first = await vl.readEntry(COPY);
    expect(await mig.autolinkCloneCopies()).toEqual({ linked: [], unmatched: 0 });
    expect(await vl.readEntry(COPY)).toEqual(first);
  });

  it('retries a linked, revoked copy whose files survived a failed purge', async () => {
    await seedClone({ consent: { ...consent, revokedAt: NOW } }, null);
    await vl.writeEntry(
      entry({
        voiceUuid: COPY,
        provenance: 'cloned',
        clonedFrom: CLONE,
        consent: { ...consent, revokedAt: NOW },
        createdAt: LATER,
      }),
    );
    seedPt(COPY, 'survivor');
    await mig.autolinkCloneCopies();
    expect(existsSync(pt(COPY))).toBe(false);
  });

  it('closes the boot-time race: a revoke landing after the clone read still revokes and purges the copy', async () => {
    await seedClone();
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    hooks.afterUpdate = async () => {
      // the revoke's stamp + cascade ran in the gap, before the copy was visible to it
      await vl.updateEntry(CLONE, (e) =>
        e?.consent ? { ...e, consent: { ...e.consent, revokedAt: NOW } } : null,
      );
    };
    await mig.autolinkCloneCopies();
    const copy = await vl.readEntry(COPY);
    expect(copy?.consent?.revokedAt).toBeTruthy();
    expect(existsSync(pt(COPY))).toBe(false);
  });
});

describe('purgeCloneArtifacts cascade', () => {
  async function linkedPair() {
    await seedClone();
    await seedCopy('clone-bytes', cloneManifest(CLONE, `qwen-${COPY}`));
    await mig.autolinkCloneCopies();
  }

  it('revoking the clone afterwards revokes the copy and erases its artifacts', async () => {
    await linkedPair();
    await vl.updateEntry(CLONE, (e) =>
      e?.consent ? { ...e, consent: { ...e.consent, revokedAt: NOW } } : null,
    );
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
});
