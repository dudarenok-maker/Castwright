/* srv-28 — pre-flight disk-space guard. Before a generation run or an export
   job, estimate how much disk the operation will write and compare it against
   the free space on the workspace volume. A deep run writes per-sentence PCM +
   per-chapter audio + (for export) a packed archive — easily multiple GB — so
   running the volume dry mid-run is a real failure mode worth catching early.

   Default mode is WARN (non-blocking): the run/export proceeds but the user is
   told. `DISK_GUARD_MODE=block` hard-stops before any work; `off` skips the
   check entirely. Reuses `probeDiskSpace` + the `DISK_FAIL_GB` headroom from
   the fs-18 diagnostics probe so the guard and the admin health board agree on
   what "free" means. */

import { probeDiskSpace, DISK_FAIL_GB } from '../diagnostics/disk.js';
import type { DiskProbe } from '../diagnostics/disk.js';

const BYTES_PER_GB = 1024 * 1024 * 1024;

/* Average rendered chapter size used to estimate a generation run's footprint.
   ~18 MB is a generous mid-book chapter at the audiobook MP3 bitrate (a 12–15
   minute chapter at ~128 kbps lands around 11–14 MB; the headroom covers the
   per-sentence PCM scratch that's written then concatenated). Tunable — bump it
   if real books routinely exceed the estimate. */
export const AVG_CHAPTER_BYTES = 18 * 1024 * 1024;

export type DiskGuardMode = 'warn' | 'block' | 'off';

export interface DiskEstimate {
  /** Total bytes the operation is expected to write. */
  estimatedBytes: number;
  /** What kind of operation produced this estimate. */
  basis: 'generation' | 'export';
  /** Chapter count behind a `generation` estimate (omitted for `export`). */
  chapters?: number;
}

export interface DiskGuardVerdict {
  status: 'ok' | 'warn' | 'block';
  freeGb: number;
  estimatedGb: number;
  path: string;
  /** Human-readable line naming the GB free + GB needed. Empty on `ok`. */
  message: string;
}

/** Resolve the configured guard mode. Defaults to `warn`; an unrecognised
    value also falls back to `warn` (fail-soft — never silently disable). */
export function diskGuardMode(): DiskGuardMode {
  const raw = process.env.DISK_GUARD_MODE?.trim().toLowerCase();
  if (raw === 'block' || raw === 'off' || raw === 'warn') return raw;
  return 'warn';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Evaluate the disk guard for an operation that will write `estimate` bytes
    to the volume backing `path`. `mode` chooses ok/warn/block behaviour; `probe`
    is injectable for tests (defaults to the real `probeDiskSpace`).

    The verdict trips when free space is below `estimatedBytes` PLUS the
    `DISK_FAIL_GB` headroom — i.e. we want enough room to finish the operation
    AND keep the volume off the failure floor the diagnostics board flags. In
    `warn` mode a trip is `warn`; in `block` mode it's `block`; `off` is handled
    by the caller (it shouldn't call this). */
export async function evaluateDiskGuard(
  path: string,
  estimate: DiskEstimate,
  opts: { mode: DiskGuardMode },
  probe: (p: string) => Promise<DiskProbe> = probeDiskSpace,
): Promise<DiskGuardVerdict> {
  const { freeGb } = await probe(path);
  const estimatedGb = round1(estimate.estimatedBytes / BYTES_PER_GB);
  const neededGb = round1(estimate.estimatedBytes / BYTES_PER_GB + DISK_FAIL_GB);
  const insufficient = freeGb < neededGb;

  if (!insufficient) {
    return { status: 'ok', freeGb, estimatedGb, path, message: '' };
  }

  /* The message is phrased so it can be classified as the fs-19 `disk-full`
     code by the failure taxonomy (it names "disk space"). */
  const message =
    `Low disk space — only ${freeGb} GB free on the workspace volume, but this ` +
    `${estimate.basis} needs about ${neededGb} GB ` +
    `(${estimatedGb} GB of output plus ${DISK_FAIL_GB} GB headroom). ` +
    `Free up space to avoid running out mid-${estimate.basis}.`;

  return {
    status: opts.mode === 'block' ? 'block' : 'warn',
    freeGb,
    estimatedGb,
    path,
    message,
  };
}
