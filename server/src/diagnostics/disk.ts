/* fs-18 — free-disk-space probe for the admin diagnostics board. A deep
   generation run writes per-sentence PCM + per-chapter MP3 + an M4B export,
   easily multiple GB across a 40-chapter book, so running the workspace volume
   dry mid-run is a real failure mode worth surfacing before it bites.

   Uses Node's core `fs.statfs` (stable since Node 18.15; this repo targets
   Node 20) — no third-party dependency, and it resolves the volume of the
   given path on Windows, macOS, and Linux alike. */

import { statfs } from 'node:fs/promises';

/* Thresholds chosen for audiobook-sized writes: warn while there's still room
   to finish a chapter or two, fail when a single export could run it dry. */
export const DISK_WARN_GB = 10;
export const DISK_FAIL_GB = 2;

const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface DiskProbe {
  status: 'ok' | 'warn' | 'fail';
  freeGb: number;
  /* The path whose volume was measured — handy in the detail line. */
  path: string;
}

/* Probe the free space available on the volume backing `path`. `bavail` is the
   blocks available to an unprivileged process (the figure that actually limits
   our writes), so free bytes = bavail * bsize. */
export async function probeDiskSpace(path: string): Promise<DiskProbe> {
  const stats = await statfs(path);
  const freeBytes = stats.bavail * stats.bsize;
  const freeGb = Math.round((freeBytes / BYTES_PER_GB) * 10) / 10;
  const status: DiskProbe['status'] =
    freeGb < DISK_FAIL_GB ? 'fail' : freeGb < DISK_WARN_GB ? 'warn' : 'ok';
  return { status, freeGb, path };
}
