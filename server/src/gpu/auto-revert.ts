/* Task 16/16.5 (#1230 item 2) — the auto-revert route Wave 2's tripEvent()
   exists to feed. sidecar-supervisor.ts's onTrip fires this the instant a
   code-43 streak trips (Wave 2 §W2.5); this module decides what to do about
   it and remembers the outcome for GET /api/gpu/trip-status to report.

   Two branches, both named in #1230:
     - card-specific (trip.card is non-null, shaped {idx: number} — the
       sidecar's restart breadcrumb pinned the streak to one GPU) with at
       least one revertible (qwen/coqui/kokoro) engine resident on that
       card — the device assignment for those engine(s) looks structurally
       too small. Pick a DIFFERENT card with enough free VRAM (or 'cpu') for
       each and write that as its device override, then bring TTS back via
       resetAndRespawn(). An engine whose device knob is currently env-locked
       (resolveKnob(...).locked) cannot actually be moved — writing a config
       override for it is a silent no-op, per config/resolver.ts's env-wins
       precedence — so it is reported separately rather than folded into a
       false "reverted".
     - unrevertable: trip.card is null/undefined/malformed (a
       degraded/missing breadcrumb, a host-RAM ceiling, or a recycle-storm
       trip that isn't tied to any one card, per sidecar-supervisor.ts's
       RESTART43_STREAK_WINDOW_MS doc), OR the card IS known but nothing
       revertible was resident there (only asr/spk, or nothing at all —
       main.py's `_resident_engines_by_card` can report either). Either way
       there is no device pin this function can change, so respawning would
       just repeat whatever actually caused the crash loop — the exact
       failure mode the streak guard's terminal hold exists to prevent.
       Found in review 2026-09-09: an earlier version of this file treated
       the "known card, no revertible engine" case as a no-op success
       (`status: 'reverted'`, `engines: []`) and respawned anyway.

   Every path below reaches a `lastTripStatus` assignment, including a throw
   partway through the revert loop — an earlier version of this module only
   assigned it after every `await` succeeded, which round-2 review of the
   original 2026-07-02 Wave-2 plan (docs/superpowers/plans/
   2026-07-02-multi-gpu-wave2-plan2.md:2527) flagged as the same durably-wrong-
   forever bug this file re-introduced in review on 2026-09-09: a thrown
   `writeOverride`/`resetAndRespawn` left `lastTripStatus` however it was
   before the trip (`null` on a first-ever trip, or a stale prior outcome),
   never reflecting the failure. */
import { writeConfigOverride } from '../workspace/user-settings.js';
import { getKnob } from '../config/registry.js';
import { resolveKnob } from '../config/resolver.js';
import { ENGINE_DEVICE_KEY } from './engine-device.js';
import { fetchSidecarDevices } from './fetch-sidecar-devices.js';
import { selectRevertTarget } from './auto-revert-selection.js';

export type AutoRevertEngine = 'coqui' | 'kokoro' | 'qwen';

function isRevertibleEngine(e: string): e is AutoRevertEngine {
  return e === 'coqui' || e === 'kokoro' || e === 'qwen';
}

/** Approximate peak VRAM (MB) each engine needs resident, used only to pick
    a landing card with enough headroom — not a precise budget, and
    deliberately conservative (better to fall back to 'cpu' than land on a
    card that immediately re-trips). Sourced from the same figures the
    original Wave-2 plan's round-2/3 review settled on
    (2026-07-02-multi-gpu-wave2-plan2.md:2536) after this exact selection
    logic was adversarially reviewed. */
const ENGINE_PEAK_MB: Record<AutoRevertEngine, number> = {
  qwen: 6500,
  coqui: 3000,
  kokoro: 1000,
};

export interface AutoRevertTrip {
  card: unknown;
  residentEngines: string[];
}

/** A candidate landing card: an idx to write into a `cuda:N`/`cuda-uuid:`
    override, its uuid (when known, for the canonical override form — see
    `writeDeviceOverride` below), and its free VRAM. */
export interface RevertDevice {
  idx: number;
  uuid: string | null;
  freeMb: number;
}

/** True only when `card` is a shape `selectRevertTarget` can actually key
    off of. A malformed breadcrumb (e.g. `{}`, from a corrupted or
    partially-written restart-breadcrumb file) must NOT take the
    card-specific revert path — there is no card index to avoid landing back
    on. Found in review 2026-09-09: the original guard only rejected
    `null`/`undefined`, so `{card: {}}` fell through and called
    selectRevertTarget with `trippedCardIdx: undefined`, silently matching
    every candidate's `idx !== undefined` check. */
function isTrippedCardIdx(card: unknown): card is { idx: number } {
  return (
    typeof card === 'object' &&
    card !== null &&
    typeof (card as { idx?: unknown }).idx === 'number'
  );
}

export type TripStatus =
  | { status: 'reverted'; card: unknown; engines: AutoRevertEngine[]; toast: string; seq: number }
  | { status: 'unrevertable'; toast: string; seq: number }
  | { status: 'failed'; toast: string; seq: number };

/* Monotonic per-trip counter. Two genuinely DIFFERENT trips can produce a
   byte-identical toast string (same engine, same reason, twice) — the
   frontend's dedup (use-tts-lifecycle.ts) used to key off the toast text
   itself, so a dismissed notice for trip N never re-surfaced for an
   identical trip N+1. `seq` gives the frontend an identity to dedup on
   instead of the message content. */
let tripSeq = 0;

/* Module-level so GET /api/gpu/trip-status (a separate request, possibly a
   separate poll tick) can read the outcome of a trip that already happened —
   the same "registry, not a return value" idiom sidecar-supervisor.ts uses
   for _activeSupervisor. Cleared only by a fresh trip or a server restart;
   there is no explicit ack, matching tripEvent() itself staying set until
   resetAndRespawn(). */
let lastTripStatus: TripStatus | null = null;

/** The most recent trip's outcome, or null if nothing has tripped since boot. */
export function getTripStatus(): TripStatus | null {
  return lastTripStatus;
}

/** Test-only: clears the module-level memory between tests. Production code
    never calls this — a real trip is the only thing that should replace it. */
export function _resetTripStatusForTest(): void {
  lastTripStatus = null;
  tripSeq = 0;
}

/** Distributes Omit over the TripStatus union — plain `Omit<TripStatus,
    'seq'>` collapses to only the fields common to every variant (losing
    'reverted''s `card`/`engines`), since `keyof` of a union only returns
    shared keys. */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** Assigns the module-level outcome (with a fresh seq) and returns it — the
    one place every return path in runAutoRevert funnels through, so `seq`
    can never be forgotten on a new path added later. */
function record(status: WithoutSeq<TripStatus>): TripStatus {
  const withSeq = { ...status, seq: ++tripSeq } as TripStatus;
  lastTripStatus = withSeq;
  return withSeq;
}

/** Live per-card free VRAM, fetched fresh from the sidecar's own /devices
    endpoint. Deliberately NOT the passively-populated
    gpu-device-list-state.ts cache: that cache is warmed only by
    GET/PUT /api/config and GET /api/gpu/devices, none of which the 30s
    useTtsLifecycle poll (the actual trigger for most trips) ever calls —
    found in review 2026-09-09, the cache is empty on the common path, which
    silently forced every real revert through the no-data 'auto'/'cpu'
    fallback regardless of what cards were actually available. A live fetch
    at the moment of the trip is the only way to see real headroom on the
    OTHER (non-tripped) cards, which is exactly what this function needs. */
async function fetchLiveDevices(): Promise<RevertDevice[]> {
  const result = await fetchSidecarDevices();
  if (!result) return [];
  return result.devices.map((d) => ({ idx: d.idx, uuid: d.uuid, freeMb: d.free_mb }));
}

/** Writes `key`'s device override to `target` (an idx chosen by
    selectRevertTarget, or null for a 'cpu' choice). Prefers the canonical
    `cuda-uuid:<uuid>` form — every other device-knob writer in this codebase
    does (routes/config.ts's toUuidForm), specifically so the pin survives a
    card renumbering across a reboot; resolver.ts only reconciles that form
    against the live device cache, never a bare `cuda:N`. Falls back to
    `cuda:N` only when this run's device list didn't carry a uuid for the
    chosen idx (should not happen given fetchLiveDevices always asks for
    one, but degrades safely rather than throwing if a future device source
    ever omits it). */
async function writeDeviceOverride(
  writeOverride: (key: string, value: string) => Promise<void>,
  key: string,
  target: { idx: number; uuid: string | null } | null,
): Promise<void> {
  if (target === null) {
    await writeOverride(key, 'cpu');
    return;
  }
  await writeOverride(key, target.uuid ? `cuda-uuid:${target.uuid}` : `cuda:${target.idx}`);
}

export interface RunAutoRevertDeps {
  /** Writes a device override to a specific target (e.g. 'cuda-uuid:GPU-1',
      'cpu'). Defaults to the real workspace store; tests inject a spy
      instead of touching disk. */
  writeOverride?: (key: string, value: string) => Promise<void>;
  /** Live per-card free VRAM. Defaults to a real fetch against the
      sidecar's /devices endpoint (see fetchLiveDevices); tests inject fixed
      candidates. */
  getDevices?: () => Promise<RevertDevice[]>;
  /** Brings TTS back after a revert — the supervisor's own resetAndRespawn(),
      which also zeroes restart43Trip/restart43Timestamps so a fresh streak
      starts clean. */
  resetAndRespawn: () => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

/** Consumes one tripEvent() firing. Card-specific with at least one
    revertible resident engine → pick a different card (or cpu) for each and
    resetAndRespawn(); everything else → leave TTS held down. Either way,
    records + returns the outcome so GET /api/gpu/trip-status has something
    to report. Never throws — every path, including a dependency rejecting,
    resolves to a TripStatus. */
export async function runAutoRevert(trip: AutoRevertTrip, deps: RunAutoRevertDeps): Promise<TripStatus> {
  const { writeOverride = writeConfigOverride, getDevices = fetchLiveDevices, resetAndRespawn, warn = console.warn } =
    deps;

  if (!isTrippedCardIdx(trip.card)) {
    return record({
      status: 'unrevertable',
      toast:
        'Voice engine kept crash-looping, but not tied to a specific GPU card — manual investigation needed.',
    });
  }

  const engines = trip.residentEngines.filter(isRevertibleEngine);
  if (engines.length === 0) {
    // The card is known, but nothing revertible (qwen/coqui/kokoro) was
    // resident there — only asr/spk, or nothing at all. There is no device
    // pin this function can change; respawning would just repeat whatever
    // actually crashed the card (a host-level or ASR-side issue, say), which
    // is exactly the failure mode the streak guard's terminal hold exists
    // to prevent. Do NOT resetAndRespawn() here.
    return record({
      status: 'unrevertable',
      toast:
        'Voice engine kept crash-looping on a specific GPU card, but no TTS engine was resident there — manual investigation needed.',
    });
  }

  try {
    const trippedIdx = trip.card.idx;
    // A mutable running budget: two engines landing on the SAME card in one
    // revert (e.g. qwen + kokoro both need to move off the tripped card) must
    // not be sized independently against that card's ORIGINAL free VRAM —
    // found in review 2026-09-09, each engine passing its own bounds check
    // against the pre-revert reading could jointly overcommit a card neither
    // alone would have. Each successful placement decrements its target
    // card's remaining budget for the rest of this run.
    const budget = (await getDevices()).map((d) => ({ ...d }));
    const reverted: AutoRevertEngine[] = [];
    const envLocked: AutoRevertEngine[] = [];

    for (const engine of engines) {
      const knobKey = ENGINE_DEVICE_KEY[engine];
      const knob = getKnob(knobKey);
      if (knob && resolveKnob(knob).locked) {
        // An env var (e.g. QWEN_DEVICE) pins this engine — writing a config
        // override is a no-op per resolver.ts's env-wins precedence, so
        // there is nothing this function can change for it.
        envLocked.push(engine);
        continue;
      }
      const targetStr = selectRevertTarget({
        trippedCardIdx: trippedIdx,
        candidates: budget.map((d) => ({ idx: d.idx, freeMb: d.freeMb })),
        requiredMb: ENGINE_PEAK_MB[engine],
      });
      const match = /^cuda:(\d+)$/.exec(targetStr);
      const targetIdx = match ? Number(match[1]) : null;
      const targetDevice = targetIdx === null ? null : budget.find((d) => d.idx === targetIdx) ?? null;
      await writeDeviceOverride(writeOverride, knobKey, targetDevice);
      if (targetDevice) targetDevice.freeMb -= ENGINE_PEAK_MB[engine];
      reverted.push(engine);
    }

    if (reverted.length === 0) {
      // Every resident revertible engine was env-locked — nothing was
      // actually changed, so respawning would just re-trip identically.
      // Reporting 'reverted' here would be the exact false-positive this
      // review round exists to close.
      return record({
        status: 'failed',
        toast:
          `GPU pin for ${envLocked.join(', ')} is set via environment variable, not the app's ` +
          'settings — auto-revert cannot change it. Update the environment and restart the server.',
      });
    }

    warn(
      `[gpu] auto-revert: card-specific code-43 streak on card=${JSON.stringify(trip.card)} — ` +
        `reverted device pin for [${reverted.join(', ')}]${envLocked.length > 0 ? ` (env-locked, skipped: [${envLocked.join(', ')}])` : ''} and respawning.`,
    );
    await resetAndRespawn();

    const lockedSuffix =
      envLocked.length > 0
        ? ` (${envLocked.join(', ')} is env-locked and was left untouched — the streak may recur for it)`
        : '';
    return record({
      status: 'reverted',
      card: trip.card,
      engines: reverted,
      toast: `Auto-reverted: GPU pin for ${reverted.join(', ')} looked structurally too small and was moved${lockedSuffix}.`,
    });
  } catch (err) {
    warn(
      '[gpu] auto-revert: threw while attempting to revert a tripped, card-attributable device ' +
        'assignment — TTS remains held down. This requires MANUAL investigation.',
      err,
    );
    return record({
      status: 'failed',
      toast: 'Auto-revert failed while trying to recover the voice engine — manual investigation needed.',
    });
  }
}
