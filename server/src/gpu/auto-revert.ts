/* Task 16/16.5 (#1230 item 2) — the auto-revert route Wave 2's tripEvent()
   exists to feed. sidecar-supervisor.ts's onTrip fires this the instant a
   code-43 streak trips (Wave 2 §W2.5); this module decides what to do about
   it and remembers the outcome for GET /api/gpu/trip-status to report.

   Two branches, both named in #1230:
     - card-specific (trip.card is non-null, shaped {idx: number} — the
       sidecar's restart breadcrumb pinned the streak to one GPU) — the
       device assignment for whichever engine(s) were resident on that card
       looks structurally too small. Pick a DIFFERENT card with enough free
       VRAM (or 'cpu') for each resident engine and write that as its device
       override, then bring TTS back via resetAndRespawn(). An engine whose
       device knob is currently env-locked (resolveKnob(...).locked) cannot
       actually be moved — writing a config override for it is a silent
       no-op, per config/resolver.ts's env-wins precedence — so it is
       reported separately rather than folded into a false "reverted".
     - non-card-specific (trip.card is null/undefined/malformed — a
       degraded/missing breadcrumb, a host-RAM ceiling, or a recycle-storm
       trip that isn't tied to any one card, per sidecar-supervisor.ts's
       RESTART43_STREAK_WINDOW_MS doc) — no pin caused this, so there's
       nothing to revert. Leave TTS held down and report
       `status:'unrevertable'` for a human to investigate.

   Every path below reaches a `lastTripStatus` assignment, including a throw
   partway through the revert loop — an earlier version of this module only
   assigned it after every `await` succeeded, which round-2 review of the
   original 2026-07-02 Wave-2 plan (docs/superpowers/plans/
   2026-07-02-multi-gpu-wave2-plan2.md:2527) flagged as the same durably-wrong-
   forever bug this file re-introduced in review on 2026-09-09: a thrown
   `writeOverride`/`resetAndRespawn` left `lastTripStatus` however it was
   before the trip (`null` on a first-ever trip, or a stale prior outcome),
   never reflecting the failure. */
import { clearConfigOverride, writeConfigOverride } from '../workspace/user-settings.js';
import { getKnob } from '../config/registry.js';
import { resolveKnob } from '../config/resolver.js';
import { ENGINE_DEVICE_KEY } from './engine-device.js';
import { getLastKnownGpuDevices, type GpuDeviceInfo } from './gpu-device-list-state.js';
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

export interface RunAutoRevertDeps {
  /** Writes a device override to a specific target (e.g. 'cuda:1', 'cpu').
      Defaults to the real workspace store; tests inject a spy instead of
      touching disk. */
  writeOverride?: (key: string, value: string) => Promise<void>;
  /** Clears a device override back to its default ('auto'). Only used for
      the legacy no-candidate-data fallback path (see below) — kept as its
      own dependency so a test can distinguish "wrote a specific target"
      from "cleared to auto" without inspecting call arguments. */
  clearOverride?: (key: string) => Promise<void>;
  /** Last-known per-card free VRAM, keyed by idx. Defaults to the real
      cache (gpu-device-list-state.ts); tests inject fixed candidates. */
  getDevices?: () => GpuDeviceInfo[];
  /** Brings TTS back after a revert — the supervisor's own resetAndRespawn(),
      which also zeroes restart43Trip/restart43Timestamps so a fresh streak
      starts clean. */
  resetAndRespawn: () => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

/** Consumes one tripEvent() firing. Card-specific → pick a different card
    (or cpu) for each revertible resident engine and resetAndRespawn();
    non-card-specific → leave TTS held down. Either way, records + returns
    the outcome so GET /api/gpu/trip-status has something to report. Never
    throws — every path, including a dependency rejecting, resolves to a
    TripStatus. */
export async function runAutoRevert(trip: AutoRevertTrip, deps: RunAutoRevertDeps): Promise<TripStatus> {
  const {
    writeOverride = writeConfigOverride,
    clearOverride = clearConfigOverride,
    getDevices = getLastKnownGpuDevices,
    resetAndRespawn,
    warn = console.warn,
  } = deps;

  if (!isTrippedCardIdx(trip.card)) {
    return record({
      status: 'unrevertable',
      toast:
        'Voice engine kept crash-looping, but not tied to a specific GPU card — manual investigation needed.',
    });
  }

  try {
    const trippedIdx = trip.card.idx;
    const engines = trip.residentEngines.filter(isRevertibleEngine);
    const devices = getDevices();
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
      if (devices.length > 0) {
        const target = selectRevertTarget({
          trippedCardIdx: trippedIdx,
          candidates: devices.map((d) => ({ idx: d.idx, freeMb: d.freeMb })),
          requiredMb: ENGINE_PEAK_MB[engine],
        });
        await writeOverride(knobKey, target);
      } else {
        // No device-list data cached yet (e.g. the sidecar has never
        // reported /devices this boot) — selectRevertTarget has nothing to
        // choose between, so fall back to clearing to 'auto' rather than
        // guessing a card. Worse than a real choice, but strictly no worse
        // than the pre-fix behaviour for this one degraded case.
        await clearOverride(knobKey);
      }
      reverted.push(engine);
    }

    if (engines.length > 0 && reverted.length === 0) {
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

    const engineLabel = reverted.length > 0 ? reverted.join(', ') : 'the voice engine';
    const lockedSuffix =
      envLocked.length > 0
        ? ` (${envLocked.join(', ')} is env-locked and was left untouched — the streak may recur for it)`
        : '';
    return record({
      status: 'reverted',
      card: trip.card,
      engines: reverted,
      toast: `Auto-reverted: GPU pin for ${engineLabel} looked structurally too small and was moved${lockedSuffix}.`,
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
