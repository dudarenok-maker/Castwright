/* #1826, Step 1 — the two interleaving regression tests, against the REAL
   per-uuid lock.

   #1826 (Castwright#2403) is the task that owns acceptance for the fs-38
   Wave-3c write-serialization fix. These two tests are written ON TOP of the
   production fix (which already shipped: `server/src/workspace/voice-library.ts`
   holds `withEntryLock` + `updateEntry`). A test that cannot be reddened by any
   mutation proves nothing, so these are judged by the mutation table at the
   bottom of this file, NOT by "goes green".

   Why we talk to the REAL lock and not a double: this repo's own
   `clone-voice-resolver.test.ts:434-456` defines a LOCKLESS `updateEntry`
   double inside `makeDeps` — it does read -> mutate -> write with no queueing.
   Every "review C-1" test is built on it and therefore proves the closure
   logic, never serialization. So this file does NOT use `makeDeps` and does
   NOT import from that file. `readEntry`/`writeEntry`/`updateEntry` here are
   the real workspace/voice-library functions, and `updateEntry` is handed to
   the resolver wrapped only so this file can OBSERVE that a call queued (it
   claims its queue slot synchronously); the queueing itself is the real
   promise-chain mutex. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnresolvableClonedVoiceError,
  resolveClonedVoicesForChapter,
  type ResolveChapterDeps,
} from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import { cloneStorageKey } from './clone-engines.js';

let dir: string;
let vl: typeof import('../workspace/voice-library.js');

const REVOKED_AT = '2026-03-01T00:00:00.000Z';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-revoke-race-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules(); // re-read WORKSPACE_ROOT at module load
  vl = await import('../workspace/voice-library.js');
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/* A structurally-complete revocable cloned voice: consent present (writeEntry
   throws ConsentRequiredError otherwise), master retained, and a stale qwen
   slot so `classifyClonedVoice` reads `repairable`. */
function seedEntry(uuid: string): VoiceLibraryEntry {
  return {
    voiceUuid: uuid,
    name: 'Marlow',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    consent: {
      personName: 'x',
      relationship: 'self',
      permittedUse: 'personal',
      attestedAt: '2026-01-01T00:00:00.000Z',
      attestedBy: 'x',
    },
    master: {
      clipFile: 'master.wav',
      sampleRate: 24000,
      durationSeconds: 5,
      transcript: 'hi',
      transcriptSource: 'user',
      captureMethod: 'upload',
    },
    engines: { qwen: { status: 'stale', baseModel: 'old' } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function req(characterName: string, characterId: string, libraryUuid: string) {
  return {
    characterName,
    characterId,
    libraryUuid,
    engine: 'qwen' as const,
    wrongEngine: false,
    engineUnavailable: false,
  };
}
/* Builds a deps object that routes read/write/updateEntry through the REAL
   voice-library. The fake bits are limited to what the resolver injects:
   - `deriveEngineArtifact` parks on a per-call gate and, when released, models
     the sidecar writing a fresh artifact by adding its storage key to `pts`.
   - `ptExists` / `purgeCloneArtifacts` share that fake `.pt` store (Test 2).
   - `updateEntry` is the real lock, wrapped ONLY to fire `onQueued` — the
     wrapper signals synchronously right after calling, because `withEntryLock`
     claims its queue slot without an await in between. That signal is the
     exact "the repair has queued behind the revoke" point Test 1 needs. */
function makeRaceDeps(
  opts: { onDeriveReached?: () => void; onQueued?: () => void } = {},
) {
  const deriveGates: (() => void)[] = [];
  const pts = new Set<string>();
  const purgeMock = vi.fn(
    async (
      voiceUuid: string,
      _opts: { deleteEntryDir?: boolean; deleteMasterClip?: boolean } = {},
    ): Promise<{ failed: string[] }> => {
      pts.delete(cloneStorageKey('qwen', voiceUuid));
      return { failed: [] };
    },
  );
  const deps: ResolveChapterDeps = {
    readEntry: (uuid) => vl.readEntry(uuid),
    writeEntry: (entry) => vl.writeEntry(entry),
    updateEntry: (uuid, mutate) => {
      const p = vl.updateEntry(uuid, mutate);
      opts.onQueued?.();
      return p;
    },
    ptExists: async (key) => pts.has(key),
    deriveEngineArtifact: async (voiceUuid, engine) => {
      const gate = new Promise<void>((r) => deriveGates.push(r));
      opts.onDeriveReached?.();
      await gate;
      pts.add(cloneStorageKey(engine, voiceUuid));
      return { previewPcm: Buffer.alloc(0), sampleRate: 24000 };
    },
    readMasterPcm: async () => ({ pcm: Buffer.alloc(0), sampleRate: 24000, refText: 'x' }),
    currentArtifactVersion: () => 'qwen3-new',
    purgeCloneArtifacts: purgeMock,
  };
  return { deps, pts, purgeMock, deriveGates };
}

describe('#1826 Step 1 — cloned-voice repair races against the real per-uuid lock', () => {
  it('Test 1 — a revoke in flight, the repair\'s post-derive write queued behind it', async () => {
    const UUID = 'race-test-1';
    await vl.writeEntry(seedEntry(UUID));

    /* (i) A gated holder that has provably entered its critical section.
       `updateEntry` runs its mutate on a microtask, so merely calling it does
       not mean the lock is held — signal from inside the mutate instead. */
    let revokeEntered!: () => void;
    const revokeEnteredP = new Promise<void>((r) => (revokeEntered = r));
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((r) => (releaseRevoke = r));

    const revokeP = vl.updateEntry(UUID, async (fresh) => {
      revokeEntered(); // first statement: we are inside the lock
      await revokeGate;
      return { ...fresh!, consent: { ...fresh!.consent!, revokedAt: REVOKED_AT } };
    });
    await revokeEnteredP; // the revoke now HOLDS the per-uuid lock

    /* (ii) A signal that the repair has QUEUED behind it, from the synchronous
       queue-slot claim in `withEntryLock`. */
    let repairQueued!: () => void;
    const repairQueuedP = new Promise<void>((r) => (repairQueued = r));
    let noteDeriveReached!: () => void;
    const deriveReachedP = new Promise<void>((r) => (noteDeriveReached = r));
    let settledResolve!: () => void;
    const settledP = new Promise<void>((r) => (settledResolve = r));
    const { deps, purgeMock, deriveGates } = makeRaceDeps({
      onDeriveReached: () => noteDeriveReached(),
      onQueued: () => repairQueued(),
    });

    let thrown: unknown;
    void resolveClonedVoicesForChapter([req('Marlow', 'marlow', UUID)], deps)
      .catch((e) => {
        thrown = e;
      })
      .finally(() => settledResolve());

    await deriveReachedP; // the repair holds a stale snapshot, mid-derive
    deriveGates[0](); // release the derive -> resolver proceeds to updateEntry
    // The resolver either queued behind the revoke (real/M3) or finished
    // without ever calling updateEntry (M1). Whichever structural event comes
    // first releases the revoke; racing two events, not timing.
    await Promise.race([repairQueuedP, settledP]);
    releaseRevoke(); // the revoke's mutate returns: revokedAt is written
    await revokeP;
    // Mirror routes/voice-library.ts:2047 — the revoke route's purge runs
    // OUTSIDE the unlock, after updateEntry has resolved.
    await deps.purgeCloneArtifacts(UUID, { deleteMasterClip: true });
    await settledP;

    // The resolver re-opened the race under the lock: its fresh post-derive
    // write saw the revoke, so it reported the voice broken and declined to write.
    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect((thrown as UnresolvableClonedVoiceError).broken).toEqual([
      { name: 'Marlow', reason: 'revoked' },
    ]);

    // On disk: revokedAt survives — compared against the EXACT constant, not
    // truthiness, so a clobber-then-restamp cannot sneak past it.
    const final = await vl.readEntry(UUID);
    expect(final?.consent?.revokedAt).toBe(REVOKED_AT);
    // And no ready stamp landed: the post-derive write used the fresh revoked
    // read, not the stale pre-derive snapshot.
    expect(final?.engines.qwen).toEqual({ status: 'stale', baseModel: 'old' });
    // The resolver's own mutate re-ran the purge (the mechanism that removes a
    // `.pt` the derive produced after an in-flight revoke's purge).
    expect(purgeMock).toHaveBeenCalledWith(UUID, {});
  });

  it('Test 2 — corner (b): two repairs and a revoke leave no `.pt`', async () => {
    /* Honest about what this pins: the RE-PURGE, not the lock. Test 1 is what
       pins the lock (M3 is its instrument mutation). A reader who confuses the
       two will trust this test past its reach. */
    const UUID = 'race-test-2';
    await vl.writeEntry(seedEntry(UUID));

    let reached = 0;
    let bothResolve!: () => void;
    const bothReachedP = new Promise<void>((r) => (bothResolve = r));
    const { deps, pts, purgeMock, deriveGates } = makeRaceDeps({
      onDeriveReached: () => {
        reached += 1;
        if (reached === 2) bothResolve();
      },
    });

    // Fake `.pt` store: a present stale artifact so the voice classifies repairable.
    const storageKey = cloneStorageKey('qwen', UUID);
    pts.add(storageKey);

    // Worker A and Worker B are both in-flight repairs of the SAME voice; both
    // classify from the still-stale entry (their classify reads happen before
    // either writes), then both park mid-derive.
    const pA = resolveClonedVoicesForChapter([req('Marlow', 'marlow', UUID)], deps);
    const pB = resolveClonedVoicesForChapter([req('Reeve', 'reeve', UUID)], deps);
    await bothReachedP; // both are mid-derive, holding a stale snapshot

    // Worker A runs to completion normally: derive -> updateEntry -> ready stamp.
    deriveGates[0]();
    await pA;
    // A normal repair leaves the `.pt` in place (no success-path purge).
    expect(pts.has(storageKey)).toBe(true);

    // The revoke lands: stamp revokedAt through the real lock, then — outside
    // the lock, per routes/voice-library.ts:2047 — purge empties `pts`.
    await vl.updateEntry(UUID, (fresh) =>
      fresh?.consent ? { ...fresh, consent: { ...fresh.consent, revokedAt: REVOKED_AT } } : null,
    );
    await deps.purgeCloneArtifacts(UUID, { deleteMasterClip: true });
    expect(pts.size).toBe(0);

    // Worker B's derive completes AFTER the revoke's purge, re-adding a fresh
    // `.pt` — corner (b)'s precondition, and the reason the bug was possible.
    deriveGates[1]();
    let thrownB: unknown;
    try {
      await pB;
    } catch (e) {
      thrownB = e;
    }

    expect(pts.size).toBe(0); // no artifact may outlive the revoke
    const final = await vl.readEntry(UUID);
    expect(final?.consent?.revokedAt).toBe(REVOKED_AT);
    expect(thrownB).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect((thrownB as UnresolvableClonedVoiceError).broken).toEqual([
      { name: 'Reeve', reason: 'revoked' },
    ]);
    // And the resolver's own re-purge is the one that removed B's fresh `.pt`.
    expect(purgeMock).toHaveBeenCalledWith(UUID, {});
  });
});

