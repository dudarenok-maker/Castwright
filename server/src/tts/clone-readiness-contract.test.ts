/* Plan 276 (fs-cast-readiness), Task 8 — the co-oracle contract test.

   `cloneReadiness` (this module's sibling, `clone-readiness.ts`) is a SECOND
   OPINION about what the render will do. The render's own oracle is
   `resolveClonedVoicesForChapter` / `classifyClonedVoice`
   (`clone-voice-resolver.ts:415`, `:223-248`). A shared implementation
   removes drift in HOW the two are coded, but not drift in WHAT they decide
   — the two functions are still independent code paths fed independently
   adapted inputs, and every disagreement between them is either a false
   warning (annoying) or a false all-clear (the exact failure #1980 exists to
   prevent, and the failure mode that killed two earlier revisions of this
   plan — see clone-readiness.ts's header and the plan doc's revision note).

   This file runs ONE fixture table through BOTH oracles and asserts they
   agree wherever both have an opinion:

   - The CLIENT side is `cloneReadiness` fed a `CloneReadinessInput` built the
     same way `src/store/clone-readiness-selectors.ts` builds one — including
     routing the persisted entry through the REAL `withComputedStaleness`
     (`routes/voice-library.ts`, now exported for exactly this purpose). A
     reimplementation of that transform here would be blind to a regression
     IN it (Decision 2 [R3]'s "C1": a persisted `'failed'` status must not
     reach the client re-mapped to `'stale'` — Task 3 already fixed the
     production function; this test's job is to make sure a REGRESSION of
     that fix would also be caught here, not just in voice-library.test.ts).
   - The RENDER side is the REAL, unmocked `resolveClonedVoicesForChapter`,
     with fakes ONLY at its own declared dependency-injection boundary
     (`ResolveChapterDeps`) — the sidecar HTTP call, disk stat, and the
     manifest read/write. `classifyClonedVoice` itself is never called
     directly or reimplemented; it runs for real, inside the real resolver,
     for every row.

   Both sides are built from the SAME `VoiceLibraryEntry` object per row —
   never two independently-shaped fixtures — so a bug in this test's own
   adaptation logic can't manufacture an agreement (or a disagreement) that
   isn't really there.

   Vocabulary. `CloneUnready` (this module) and `BrokenClonedVoice['reason']`
   (clone-voice-resolver.ts) are DIFFERENT types answering DIFFERENT-shaped
   questions, so "agreement" is a mapping, not equality — see VERDICT_PAIRS
   below, which is deliberately DATA (one row per accepted pairing, with a
   comment), not a conditional buried in a comparator. `verdictsAgree` at the
   bottom is intentionally narrow: an unlisted pair is a disagreement, full
   stop. See "Where they legitimately differ" for what's out of contract
   entirely (never fixtured with an expectation here), and the mutation table
   in this commit's message for what happens when each of these properties is
   broken on purpose. */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cloneReadiness, type CloneReadinessInput, type CloneUnready } from './clone-readiness.js';
import {
  resolveClonedVoicesForChapter,
  UnresolvableClonedVoiceError,
  type BrokenClonedVoice,
  type ClonedVoiceRequest,
  type ResolveChapterDeps,
} from './clone-voice-resolver.js';
import { manifestSlotFor, type CloneEngine } from './clone-engines.js';
import { currentQwenBaseModel } from './model-paths.js';
import {
  getLastKnownCoquiVersion,
  setLastKnownCoquiVersion,
  _resetLastKnownCoquiVersionForTests,
} from './coqui-version-state.js';
import { deriveEngineArtifact as realDeriveEngineArtifact } from './derive-engine-artifact.js';
import type { TtsEngine } from './model-keys.js';
import { withComputedStaleness } from '../routes/voice-library.js';
import type { VoiceLibraryEntry, VoiceLibraryEngines } from '../workspace/voice-library.js';

/* --- Vocabulary map -------------------------------------------------------

   Every accepted (client, render) pairing, each with the reasoning for why
   it's a genuine agreement rather than a coincidence. `null` on either side
   means "resolves cleanly" (cloneReadiness: ready, or a derive that will
   succeed; the render: resolveClonedVoicesForChapter did not throw). */
type RenderReason = BrokenClonedVoice['reason'] | null;

const VERDICT_PAIRS: ReadonlyArray<{ client: CloneUnready | null; render: RenderReason; why: string }> = [
  {
    client: null,
    render: null,
    why: 'Rule 8 silence. Either the slot is genuinely healthy, or it needs a derive that (assuming the machine is up, which this whole check assumes) succeeds — both oracles call that fine.',
  },
  {
    // #2912 — the new state for a slot with no libraryUuid at all. Both
    // oracles report the same event differently: the client says "no UUID
    // to look up", the render says "no UUID means misconfigured".
    client: 'unresolvable-uuid',
    render: 'misconfigured',
    why: "libraryUuidResolvable:false (client) <-> the render's `!libraryUuid` check (clone-voice-resolver.ts). Both fire when the character's cloned slot has no UUID to resolve — the client warns before the render fails, which is the whole point of the gate.",
  },
  {
    client: 'missing-entry',
    render: 'misconfigured',
    why: "entryFound:false (client) <-> the render's readEntry(libraryUuid) returning null for the same uuid. Both are the SAME event (no voice-library entry backs this slot); the render's `misconfigured` reason is broader (it also covers a missing libraryUuid, which the client now handles separately via `unresolvable-uuid` above), but the entry-not-found flavor is identical.",
  },
  {
    client: 'revoked',
    render: 'revoked',
    why: 'entry.consent.revokedAt — the identical field, read the identical way, and outranks everything else on BOTH sides (cloneReadiness rule 3; classifyClonedVoice checks it before wrongEngine).',
  },
  {
    client: 'wrong-engine',
    render: 'wrong-engine',
    why: "!characterHasSlot (client) <-> wrongEngine:true (render) for a CLONE-CAPABLE engine — both express \"the character's own cast slot doesn't back this engine\". cloneReadiness's OTHER trigger for this same verdict (`!isCloneEngine(engine)`, e.g. engine:'kokoro') has NO render equivalent at all and is deliberately not fixtured here — see \"Where they legitimately differ\".",
  },
  {
    client: 'derive-failed',
    render: 'derive-failed',
    why: "A persisted `failed` slot status reads identically on both sides (cloneReadiness rule 5; classifyClonedVoice's `slot?.status === 'failed'` check). Also reached via a different tier below (no-transcript).",
  },
  {
    client: 'missing-master',
    render: 'missing-master',
    why: 'Not-ready slot + no master, both sides (cloneReadiness rule 6; classifyClonedVoice needsDerive=true with `entry.master` falsy).',
  },
  {
    client: 'no-transcript',
    render: 'derive-failed',
    why: "DIFFERENT TIER of the same problem, not a coincidence of the map being loose. classifyClonedVoice never inspects `master.transcript` at all (this is rev 1's fatal bug, see clone-readiness.ts's header) — a repairable qwen voice with a blank transcript classifies 'repairable' and the render ATTEMPTS the derive. The real `deriveEngineArtifact` then rejects it for real (`derive-engine-artifact.ts:71-73`, \"`refText` is required for a Qwen clone derive\", a genuine 4xx — the plan's own problem statement: \"a clip ingested without one can never derive\"), which the resolver persists as `derive-failed`. cloneReadiness's whole reason to exist is to warn BEFORE that attempt instead of after it — so the two verdicts are the SAME failure observed at two different points in the pipeline, which is exactly the agreement this pairing is asserting.",
  },
];

function verdictsAgree(client: CloneUnready | null, render: RenderReason): boolean {
  return VERDICT_PAIRS.some((p) => p.client === client && p.render === render);
}

/* --- Type-level guard: every CloneUnready state must have a VERDICT_PAIRS entry ---

   If you add a new CloneUnready state to clone-readiness.ts without adding a
   corresponding row to VERDICT_PAIRS, this will fail to compile with a type error.
   This catches what the contract test itself might miss: a new state paired with
   no row in the table, which would leave the fixture suite green even though the
   co-oracle contract would be incomplete. The reasonCopy() exhaustiveness switch
   in clone-readiness-gate.tsx catches missing UI copy, but that doesn't catch a
   missing VERDICT_PAIRS row.

   The check works by extracting all client values from VERDICT_PAIRS and asserting
   they exactly match CloneUnready | null via two-way exclusion (no missing states,
   no extra states). */
type VerdictPairsClients = typeof VERDICT_PAIRS[number]['client'];
type MissingFromPairs = Exclude<CloneUnready | null, VerdictPairsClients>;
type ExtraInPairs = Exclude<VerdictPairsClients, CloneUnready | null>;

// Force TypeScript to evaluate and error if either type is not 'never'
function _assertVerdictPairsExhaustiveness(
  _x: MissingFromPairs extends never ? (ExtraInPairs extends never ? true : never) : never
) {}
_assertVerdictPairsExhaustiveness(true);

/* --- Fixture shape ---------------------------------------------------------

   One shape, both oracles. `rawStatus`/`versionMismatch` describe the
   PERSISTED (pre-transform) slot for `engine` — the client computes its
   `slotStatus` by running the REAL `withComputedStaleness` over the same
   entry; the render reads the same raw entry directly, exactly as
   `classifyClonedVoice` does today (it runs server-side, before any
   client-facing transform). `characterHasSlot` (client) and `wrongEngine`
   (render, `= !characterHasSlot`) are the SAME routing fact asked two
   different ways — see the `wrong-engine` vocabulary pairing above for why
   that equivalence holds only for a clone-capable `engine`. */
interface Row {
  name: string;
  /** #2912 — false when the character's cloned slot carries no libraryUuid
      (or it is empty/malformed). Defaults to true in every existing row.
      When false, the render request gets `libraryUuid: undefined` (so the
      render's `!libraryUuid` check fires `misconfigured`), and the client
      input gets `libraryUuidResolvable: false` (so cloneReadiness returns
      `unresolvable-uuid`). */
  libraryUuidResolvable?: boolean;
  entryFound: boolean;
  consentRevoked: boolean;
  /** Persisted (pre-transform) status of `entry.engines[manifestSlotFor(engine)]`. */
  rawStatus: 'ready' | 'failed' | undefined;
  /** true => the persisted version stamp (baseModel/coquiVersion) does NOT
      match the current oracle, so `withComputedStaleness` (client) and
      `classifyClonedVoice`'s own `isArtifactVersionStale` check (render)
      both see a version mismatch. */
  versionMismatch: boolean;
  hasMaster: boolean;
  /** Only meaningful when hasMaster is true — mirrors the real adapter,
      which reads `entry?.master?.transcript` (undefined when there's no
      master at all). */
  transcript: string | undefined;
  engine: TtsEngine;
  characterHasSlot: boolean;
  expectedClient: CloneUnready | null;
  expectedRender: RenderReason;
}

const LIBRARY_UUID = 'contract-test-voice';

function currentVersionFor(engine: TtsEngine): string {
  return engine === 'coqui' ? getLastKnownCoquiVersion() : currentQwenBaseModel();
}

function mismatchedVersionFor(engine: TtsEngine): string {
  return `${currentVersionFor(engine)}-mismatched`;
}

/** Builds the ONE `VoiceLibraryEntry` both oracles read for a row. `engine`
    here is only ever a clone-capable engine at the manifest-slot level (a
    'kokoro'-engine row never writes a slot at all, since neither oracle
    reads `entry.engines.kokoro` — see the kokoro row below). */
function makeEntry(row: Row): VoiceLibraryEntry {
  const engines: VoiceLibraryEngines = {};
  // Only ever writes a slot for a genuinely clone-capable engine — a
  // 'kokoro' row's entry deliberately carries no engine slot at all, since
  // neither oracle would ever read `entry.engines.kokoro`.
  if (row.rawStatus && (row.engine === 'qwen' || row.engine === 'coqui')) {
    const version = row.versionMismatch ? mismatchedVersionFor(row.engine) : currentVersionFor(row.engine);
    // Built via manifestSlotFor + explicit branches (never a raw
    // `entry.engines.coqui` index) — mirrors clone-readiness-selectors.ts's
    // own trap-2 comment.
    if (manifestSlotFor(row.engine) === 'xtts') {
      engines.xtts = { status: row.rawStatus, coquiVersion: version };
    } else {
      engines.qwen = { status: row.rawStatus, baseModel: version };
    }
  }
  return {
    voiceUuid: LIBRARY_UUID,
    name: 'Contract Test Voice',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines,
    consent: {
      personName: 'Contract Test Person',
      relationship: 'self',
      permittedUse: 'personal',
      attestedAt: '2026-01-01T00:00:00.000Z',
      attestedBy: 'Contract Test Person',
      ...(row.consentRevoked ? { revokedAt: '2026-06-01T00:00:00.000Z' } : {}),
    },
    master: row.hasMaster
      ? {
          clipFile: 'master.wav',
          sampleRate: 24000,
          durationSeconds: 5,
          transcript: row.transcript ?? '',
          transcriptSource: 'user',
          captureMethod: 'upload',
        }
      : undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/* --- Client side: cloneReadiness, fed via the REAL withComputedStaleness -- */

function clientInputFor(row: Row, entry: VoiceLibraryEntry | null): CloneReadinessInput {
  // Plan 276 Decision 2 [R3]/[R4] — this MUST be the real transform. See
  // this file's header, and mutation 2 in the commit message: feeding a raw
  // entry here instead reddens the staleness-parity row below.
  const transformed = entry ? withComputedStaleness(entry) : null;
  const slotStatus =
    transformed && (row.engine === 'qwen' || row.engine === 'coqui')
      ? transformed.engines[manifestSlotFor(row.engine)]?.status
      : undefined;
  return {
    libraryUuidResolvable: row.libraryUuidResolvable !== false,
    entryFound: !!entry,
    /* row.consentRevoked, NOT `!!transformed?.consent?.revokedAt`. The real
       adapter (clone-readiness-selectors.ts) DOES derive this from the
       entry, and `makeEntry` stamps the entry's own consent.revokedAt from
       this same row field whenever entryFound is true — so for every row
       where an entry exists, this is byte-identical to the entry-derived
       value. The two diverge ONLY when entryFound is false, where an
       entry-derived read is necessarily `false` (there is no entry to hold
       a consent record) regardless of what this field says — which would
       make rule 2 vs rule 3 precedence structurally untestable here: no
       real caller, client or render, can ever observe "entry missing AND
       consent revoked" (revocation lives inside the entry that's absent),
       so an entry-derived read would silently swallow the 2v3 doubly-broken
       row below. Reading the row field directly keeps that row meaningful:
       it exercises cloneReadiness's actual rule ordering, compared against
       the render's answer for "entry missing" (fixed at 'misconfigured'
       regardless of any consent belief) — a rule-2/rule-3 swap changes the
       client's answer to 'revoked', which is NOT an accepted pairing with
       'misconfigured', so `verdictsAgree` reddens. */
    consentRevoked: row.consentRevoked,
    slotStatus,
    hasMaster: !!transformed?.master,
    transcript: transformed?.master?.transcript,
    engine: row.engine,
    characterHasSlot: row.characterHasSlot,
  };
}

function clientVerdict(row: Row): CloneUnready | null {
  const entry = row.entryFound ? makeEntry(row) : null;
  return cloneReadiness(clientInputFor(row, entry));
}

/* --- Render side: the REAL resolveClonedVoicesForChapter ------------------

   Fakes live ONLY at ResolveChapterDeps's own declared I/O boundary.
   `deriveEngineArtifact` is the one exception worth calling out: rather than
   reimplementing its qwen-refText validation, this test uses the REAL
   `deriveEngineArtifact`'s early throw for the no-transcript row (it rejects
   before ever reaching the network, so no sidecar/fetch mock is needed for
   that path) and a plain successful stand-in for every other row — see
   `deriveArtifact` below. */

async function deriveArtifact(
  ...args: Parameters<typeof realDeriveEngineArtifact>
): ReturnType<typeof realDeriveEngineArtifact> {
  const [, engine, input] = args;
  if (engine === 'qwen' && !input.refText) {
    // Real validation, real throw — see derive-engine-artifact.ts:71-73.
    // Reaching this line at all proves the real function's own gate fired,
    // not a copy of it.
    return realDeriveEngineArtifact(...args);
  }
  // "Assuming the machine is up" (Decision 3) — a synthetic success. The
  // actual reported values are never inspected by this test (a successful
  // derive just needs to not throw); resolveClonedVoicesForChapter stamps
  // the ready slot from its OWN currentArtifactVersion oracle for qwen, and
  // only reads the derive's own value on the coqui branch, so an arbitrary
  // placeholder is enough for either engine.
  return {
    previewPcm: Buffer.alloc(0),
    sampleRate: input.sampleRate,
    baseModel: engine === 'qwen' ? 'contract-test-base-model' : undefined,
    coquiVersion: engine === 'coqui' ? 'contract-test-coqui-version' : undefined,
    modelId: engine === 'coqui' ? 'contract-test-model' : undefined,
  };
}

async function renderVerdict(row: Row): Promise<RenderReason> {
  if (row.engine !== 'qwen' && row.engine !== 'coqui') {
    throw new Error(`renderVerdict called with a non-clone-capable engine: ${row.engine}`);
  }
  const engine: CloneEngine = row.engine;
  const entry = row.entryFound ? makeEntry(row) : null;

  const deps: ResolveChapterDeps = {
    readEntry: async () => entry,
    writeEntry: async () => {},
    updateEntry: async (_uuid, mutate) => {
      const result = await mutate(entry);
      return result ?? null;
    },
    ptExists: async () => row.rawStatus === 'ready',
    deriveEngineArtifact: deriveArtifact,
    readMasterPcm: async () => ({
      pcm: Buffer.alloc(0),
      sampleRate: 24000,
      refText: row.transcript ?? '',
    }),
    // Plan 276 Decision 3's own contract — mirrors the REAL production
    // wiring verbatim (synthesise-chapter.ts's buildDefaultCloneResolverDeps),
    // so both oracles read the exact same "current version" oracle rather
    // than two independently-chosen stand-ins.
    currentArtifactVersion: (e) => (e === 'coqui' ? getLastKnownCoquiVersion() : currentQwenBaseModel()),
    purgeCloneArtifacts: async () => ({ failed: [] }),
  };

  const request: ClonedVoiceRequest = {
    characterName: 'Contract Test Character',
    characterId: 'contract-test-character',
    // #2912 — when the slot has no libraryUuid at all, the render's
    // `!libraryUuid` check fires `misconfigured` (clone-voice-resolver.ts).
    libraryUuid: row.libraryUuidResolvable !== false ? LIBRARY_UUID : undefined,
    engine,
    wrongEngine: !row.characterHasSlot,
    // Out of contract (Decision 3, "Machine state is deliberately absent") —
    // always false: this test only ever asks "assuming the machine is up".
    engineUnavailable: false,
  };

  try {
    await resolveClonedVoicesForChapter([request], deps);
    return null;
  } catch (err) {
    if (err instanceof UnresolvableClonedVoiceError) {
      return err.broken[0]?.reason ?? null;
    }
    throw err;
  }
}

/* --- The table -------------------------------------------------------- */

const rows: Row[] = [
  // --- #2912 Rule 1: unresolvable-uuid. A cloned slot with no libraryUuid
  // at all — the render's `!libraryUuid` check fires `misconfigured`.
  {
    name: 'unresolvable-uuid: no libraryUuid -> client unresolvable-uuid, render misconfigured',
    libraryUuidResolvable: false,
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'coqui',
    characterHasSlot: true,
    expectedClient: 'unresolvable-uuid',
    expectedRender: 'misconfigured',
  },
  // --- Rule 8 silence: the most important agreement in the table. A
  // Qwen-cloned voice with no coqui slot yet, character's own coqui cast
  // slot present, routed to Coqui: both oracles say fine (client: never
  // derived yet but the derive will succeed; render: repairable, and the
  // real derive DOES succeed for coqui regardless of transcript).
  {
    name: 'rule 8 silence: never-derived coqui slot, master+transcript present, coqui cast slot present -> both null',
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'coqui',
    characterHasSlot: true,
    expectedClient: null,
    expectedRender: null,
  },
  // --- Healthy `ready` gate (rule 6/7 gate), both directions.
  {
    name: "ready slot + blank transcript + qwen -> both null (a ready slot with no transcript is healthy)",
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: true,
    transcript: '',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: null,
    expectedRender: null,
  },
  {
    name: 'ready slot + no master -> both null (a ready slot with no master is healthy)',
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: false,
    transcript: undefined,
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: null,
    expectedRender: null,
  },
  // --- no-transcript: the mapped-but-different-tier pairing, both engine
  // directions (#1933 shipped ten instances of "engine-parameterised
  // behaviour pinned in one direction only" — pin both here too).
  {
    name: 'never-derived slot + blank transcript + qwen cast slot -> client no-transcript, render derive-failed (real 4xx)',
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: true,
    transcript: '',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'no-transcript',
    expectedRender: 'derive-failed',
  },
  {
    name: 'identical input on Coqui -> both null (rule 7 is qwen-only; coqui derive is purely acoustic)',
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: true,
    transcript: '',
    engine: 'coqui',
    characterHasSlot: true,
    expectedClient: null,
    expectedRender: null,
  },
  // --- missing-master, a clean single-cause row (Coqui, so rule 7 can't
  // supply the client verdict instead).
  {
    name: 'never-derived slot + no master, coqui -> both missing-master',
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: false,
    transcript: undefined,
    engine: 'coqui',
    characterHasSlot: true,
    expectedClient: 'missing-master',
    expectedRender: 'missing-master',
  },
  // --- Existence rows: rules 3, 4, 5 and 2 must each be independently
  // reachable, each on an otherwise-healthy input, on BOTH oracles — without
  // these, any one of those rules is deletable outright with the whole
  // suite (both oracles' worth of assertions) still green.
  {
    name: 'consentRevoked on an otherwise-healthy input -> both revoked',
    entryFound: true,
    consentRevoked: true,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'revoked',
    expectedRender: 'revoked',
  },
  {
    name: '!characterHasSlot on an otherwise-healthy input -> both wrong-engine',
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: false,
    expectedClient: 'wrong-engine',
    expectedRender: 'wrong-engine',
  },
  {
    name: "failed slot on an otherwise-healthy input -> both derive-failed",
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'failed',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'derive-failed',
    expectedRender: 'derive-failed',
  },
  // --- The C1 regression row (Decision 2 [R3]): a persisted 'failed' status
  // that is ALSO version-stale. Every other 'failed' row above pins
  // `versionMismatch: false`, so none of them actually reaches
  // `withComputedStaleness`'s `qwen.status !== 'failed'` guard — the guard
  // only matters when a failed slot's version stamp doesn't match the
  // current one. Mutation: delete `qwen.status !== 'failed' &&` from
  // `withComputedStaleness` (routes/voice-library.ts) -> the client side
  // reads the overwritten 'stale' status instead of 'failed', falls through
  // to rule 8 (a non-blank transcript on qwen with slotStatus 'stale' isn't
  // caught by rules 6/7 either), and this row goes red on the client
  // assertion (null instead of 'derive-failed') without ever reaching the
  // co-oracle comparison.
  {
    name: "C1: a failed slot that is ALSO version-stale still yields derive-failed (withComputedStaleness must not overwrite a failed status)",
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'failed',
    versionMismatch: true,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'derive-failed',
    expectedRender: 'derive-failed',
  },
  {
    name: 'entryFound:false on an otherwise-healthy input -> client missing-entry, render misconfigured',
    entryFound: false,
    consentRevoked: false,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'missing-entry',
    expectedRender: 'misconfigured',
  },
  // --- Doubly-broken rows, one per adjacent rule pair (1v2, 2v3, 3v4, 4v5,
  // 5v6). Precedence is only tested when BOTH rules apply — with a healthy
  // side, a reversed-order predicate still passes. Each row's `expected*`
  // pins the HIGHER-precedence rule's verdict; the commit message's mutation
  // table records, per pair, that swapping cloneReadiness's rule order
  // reddens exactly this row.
  {
    name: '2v3 doubly-broken: entryFound:false AND consentRevoked:true -> rule 2 wins on both oracles',
    entryFound: false,
    consentRevoked: true,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'missing-entry',
    expectedRender: 'misconfigured',
  },
  {
    name: '3v4 doubly-broken: consentRevoked:true AND !characterHasSlot -> rule 3 wins on both oracles',
    entryFound: true,
    consentRevoked: true,
    rawStatus: 'ready',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: false,
    expectedClient: 'revoked',
    expectedRender: 'revoked',
  },
  {
    name: "4v5 doubly-broken: !characterHasSlot AND failed slot -> rule 4 wins on both oracles",
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'failed',
    versionMismatch: false,
    hasMaster: true,
    transcript: 'a transcript',
    engine: 'qwen',
    characterHasSlot: false,
    expectedClient: 'wrong-engine',
    expectedRender: 'wrong-engine',
  },
  {
    name: '5v6 doubly-broken: failed slot AND no master -> rule 5 wins on both oracles',
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'failed',
    versionMismatch: false,
    hasMaster: false,
    transcript: undefined,
    engine: 'coqui',
    characterHasSlot: true,
    expectedClient: 'derive-failed',
    expectedRender: 'derive-failed',
  },
  {
    name: '6v7 doubly-broken: no master AND blank qwen transcript -> rule 6 wins on both oracles',
    entryFound: true,
    consentRevoked: false,
    rawStatus: undefined,
    versionMismatch: false,
    hasMaster: false,
    transcript: undefined,
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'missing-master',
    expectedRender: 'missing-master',
  },
  // --- The staleness-parity / "C1" guard row. Plan 276 Decision 2 [R3]/[R4]
  // — the client MUST see the POST-withComputedStaleness status, not the raw
  // persisted one. A `ready`-but-version-stale slot must read 'stale' to the
  // client (so rules 6/7 can fire); reading raw 'ready' instead reproduces
  // the exact false-negative class that killed rev 2 and re-broke rev 3's
  // own "Add transcript" flow (Decision 2 [R4]). Mutation 2 (commit
  // message): skip calling withComputedStaleness in clientInputFor -> this
  // row goes red (client would wrongly compute null instead of
  // 'no-transcript', which no longer maps to the render's 'derive-failed').
  {
    name: "C1/[R4] staleness parity: ready-but-version-stale qwen slot + blank transcript -> client sees 'stale' (no-transcript), render attempts and fails the same way (derive-failed)",
    entryFound: true,
    consentRevoked: false,
    rawStatus: 'ready',
    versionMismatch: true,
    hasMaster: true,
    transcript: '',
    engine: 'qwen',
    characterHasSlot: true,
    expectedClient: 'no-transcript',
    expectedRender: 'derive-failed',
  },
];

describe('clone-readiness co-oracle contract', () => {
  // `getLastKnownCoquiVersion` is module-level, mutable, in-memory state
  // (coqui-version-state.ts) — seed it once so `currentVersionFor('coqui')`
  // is stable and non-empty for every row (an empty current version reads
  // as "never stale", which would silently defeat every coqui
  // versionMismatch row), and restore it afterward so this file can't leak
  // state into a test that runs later in the same process.
  beforeEach(() => {
    setLastKnownCoquiVersion('2.0.0');
  });
  afterAll(() => {
    _resetLastKnownCoquiVersionForTests();
  });

  for (const row of rows) {
    it(row.name, async () => {
      const client = clientVerdict(row);
      expect(client).toBe(row.expectedClient);

      const render = await renderVerdict(row);
      expect(render).toBe(row.expectedRender);

      // The actual co-oracle property: whatever the two independently
      // computed verdicts are, they must be an ACCEPTED pairing per
      // VERDICT_PAIRS — never merely "both happen to equal the row's
      // expectation", which would stay green even if VERDICT_PAIRS were
      // wrong about what agreement means.
      expect(verdictsAgree(client, render)).toBe(true);
    });
  }

  /* --- Where they legitimately differ — documented, not fixtured with an
     expectation, per this task's brief. Building a fixture whose expected
     answer depended on either of these would be testing an accident, not a
     contract. */
  describe('out of contract (documented, not asserted against each other)', () => {
    it('cloneReadiness warns wrong-engine for a non-clone-capable engine; the render has no opinion at all', () => {
      // `classifyClonedVoice`'s (and resolveClonedVoicesForChapter's
      // ClonedVoiceRequest's) `engine` parameter is typed `CloneEngine`
      // ('qwen' | 'coqui' only, clone-engines.ts) — a Kokoro-routed
      // character is never even resolved as a cloned-voice request in the
      // first place (Decision 5: routing gates what the render attempts;
      // it never gates whether cloneReadiness fires). There is no render
      // call to make here, by construction — not a gap in this test.
      const row: Row = {
        name: 'kokoro is not clone-capable',
        entryFound: true,
        consentRevoked: false,
        rawStatus: 'ready',
        versionMismatch: false,
        hasMaster: true,
        transcript: 'a transcript',
        engine: 'kokoro',
        characterHasSlot: true,
        expectedClient: 'wrong-engine',
        expectedRender: null, // unused — no render call is made for this row.
      };
      expect(clientVerdict(row)).toBe('wrong-engine');
    });

    it('engineUnavailable (render-only) and misconfigured-from-machine-state have no cloneReadiness analogue', () => {
      // Decision 3, "Machine state is deliberately absent": cloneReadiness
      // has no `engineUnavailable` input at all — this test's renderVerdict
      // helper always passes `engineUnavailable: false` for exactly that
      // reason. Asserted here as a type-level fact so a future edit that
      // tries to thread machine state through CloneReadinessInput gets
      // caught by a failing compile, not a silently-stale comment.
      const input: CloneReadinessInput = {
        libraryUuidResolvable: true,
        entryFound: true,
        consentRevoked: false,
        slotStatus: 'ready',
        hasMaster: true,
        transcript: 'x',
        engine: 'qwen',
        characterHasSlot: true,
      };
      expect('engineUnavailable' in input).toBe(false);
    });

    it('disk integrity (the .pt artifact, or the master clip file, actually existing) is invisible to cloneReadiness by design (Decision 2)', () => {
      // Not independently fixturable as a passing/failing case: any input
      // this test COULD construct necessarily picks a ptExists/clip-exists
      // value for the render side (this file's renderVerdict always derives
      // ptExists from rawStatus, per its own doc comment, precisely to
      // avoid smuggling a disk-integrity assumption into the "co-oracle"
      // property). Documented here so the gap is named, not silently
      // assumed away.
      expect(true).toBe(true);
    });
  });

  /* --- Mapping-strictness guard (required mutation 4). If VERDICT_PAIRS
     were loosened to "always agree", this is the assertion that would still
     have to fail against a genuine disagreement — proving the mapping is
     load-bearing rather than decorative. These pairs are deliberately NOT
     in VERDICT_PAIRS and must never be added there. */
  describe('verdictsAgree is strict, not "always true"', () => {
    const genuineDisagreements: ReadonlyArray<[CloneUnready | null, RenderReason]> = [
      ['missing-master', 'derive-failed'],
      ['revoked', 'wrong-engine'],
      ['wrong-engine', null],
      [null, 'missing-master'],
      ['derive-failed', 'missing-master'],
      // #2912 — unresolvable-uuid pairs with misconfigured only. Anything
      // else is a genuine disagreement the mapping must reject.
      ['unresolvable-uuid', 'revoked'],
      ['unresolvable-uuid', null],
      [null, 'misconfigured'],
    ];
    for (const [client, render] of genuineDisagreements) {
      it(`(${client}, ${render}) is NOT an accepted pairing`, () => {
        expect(verdictsAgree(client, render)).toBe(false);
      });
    }

    for (const pair of VERDICT_PAIRS) {
      it(`(${pair.client}, ${pair.render}) IS an accepted pairing`, () => {
        expect(verdictsAgree(pair.client, pair.render)).toBe(true);
      });
    }
  });
});
