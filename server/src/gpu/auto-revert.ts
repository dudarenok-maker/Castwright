/* Task 16/16.5 (#1230 item 2) — the auto-revert route Wave 2's tripEvent()
   exists to feed. sidecar-supervisor.ts's onTrip fires this the instant a
   code-43 streak trips (Wave 2 §W2.5); this module decides what to do about
   it and remembers the outcome for GET /api/gpu/trip-status to report.

   Two branches, both named in #1230:
     - card-specific (trip.card is non-null — the sidecar's restart
       breadcrumb pinned the streak to one GPU) — the device assignment for
       whichever engine(s) were resident on that card looks structurally too
       small. Revert those engines' device overrides back to "auto" and bring
       TTS back via resetAndRespawn().
     - non-card-specific (trip.card is null — a degraded/missing breadcrumb,
       a host-RAM ceiling, or a recycle-storm trip that isn't tied to any one
       card, per sidecar-supervisor.ts's RESTART43_STREAK_WINDOW_MS doc) — no
       pin caused this, so there's nothing to revert. Leave TTS held down and
       report `status:'unrevertable'` for a human to investigate. */
import { clearConfigOverride } from '../workspace/user-settings.js';

export type AutoRevertEngine = 'coqui' | 'kokoro' | 'qwen';

/** The only engines with a per-engine device knob a bad pin could name.
    `asr`/`spk` (ASR/speaker-embedding singletons) can appear in
    residentEngines too but have no device override to revert here. */
const DEVICE_KNOB_BY_ENGINE: Record<AutoRevertEngine, string> = {
  coqui: 'tts.coqui.device',
  kokoro: 'tts.kokoro.device',
  qwen: 'tts.qwen.device',
};

function isRevertibleEngine(e: string): e is AutoRevertEngine {
  return e === 'coqui' || e === 'kokoro' || e === 'qwen';
}

export interface AutoRevertTrip {
  card: unknown;
  residentEngines: string[];
}

export type TripStatus =
  | { status: 'reverted'; card: unknown; engines: AutoRevertEngine[]; toast: string }
  | { status: 'unrevertable'; toast: string };

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
}

export interface RunAutoRevertDeps {
  /** Clears one config-override key back to its default. Defaults to the
      real workspace store; tests inject a spy instead of touching disk. */
  clearOverride?: (key: string) => Promise<void>;
  /** Brings TTS back after a revert — the supervisor's own resetAndRespawn(),
      which also zeroes restart43Trip/restart43Timestamps so a fresh streak
      starts clean. */
  resetAndRespawn: () => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

/** Consumes one tripEvent() firing. Card-specific → revert the offending
    engines' device pins to auto and resetAndRespawn(); non-card-specific →
    leave TTS held down. Either way, records + returns the outcome so
    GET /api/gpu/trip-status has something to report. */
export async function runAutoRevert(trip: AutoRevertTrip, deps: RunAutoRevertDeps): Promise<TripStatus> {
  const { clearOverride = clearConfigOverride, resetAndRespawn, warn = console.warn } = deps;

  if (trip.card === null || trip.card === undefined) {
    const status: TripStatus = {
      status: 'unrevertable',
      toast:
        'Voice engine kept crash-looping, but not tied to a specific GPU card — manual investigation needed.',
    };
    lastTripStatus = status;
    return status;
  }

  const engines = trip.residentEngines.filter(isRevertibleEngine);
  for (const engine of engines) {
    await clearOverride(DEVICE_KNOB_BY_ENGINE[engine]);
  }
  warn(
    `[gpu] auto-revert: card-specific code-43 streak on card=${JSON.stringify(trip.card)} — ` +
      `reverted device pin for [${engines.join(', ')}] to auto and respawning.`,
  );
  await resetAndRespawn();

  const engineLabel = engines.length > 0 ? engines.join(', ') : 'the voice engine';
  const status: TripStatus = {
    status: 'reverted',
    card: trip.card,
    engines,
    toast: `Auto-reverted: GPU pin for ${engineLabel} looked structurally too small and was reset to auto.`,
  };
  lastTripStatus = status;
  return status;
}
