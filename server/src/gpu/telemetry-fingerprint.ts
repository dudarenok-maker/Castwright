/* Per-machine staleness guard for the VRAM telemetry. If the device total
   changes (card swap / different box / moved install), numbers from the old
   card must not persist. On change we rename the stats file to `.stale` (kept
   for forensics, never read) and stamp the new fingerprint. A null total
   (non-NVIDIA / no nvidia-smi) is a no-op — can't fingerprint, never rotate. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';
import { vramStatsFilePath } from '../analyzer/model-vram-stats.js';

const markerPath = () => join(telemetryDir(), 'vram-fingerprint.json');

export async function rotateStatsIfDeviceChanged(
  currentTotalMb: number | null,
): Promise<'kept' | 'rotated' | 'first-run'> {
  if (currentTotalMb == null) return 'kept';
  await mkdir(telemetryDir(), { recursive: true });
  let prev: number | null = null;
  try { prev = (JSON.parse(await readFile(markerPath(), 'utf8')) as { totalMb?: number }).totalMb ?? null; }
  catch { prev = null; }
  if (prev == null) {
    await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
    return 'first-run';
  }
  if (prev === currentTotalMb) return 'kept';
  try { await rename(vramStatsFilePath(), `${vramStatsFilePath()}.stale`); }
  catch { /* no stats file yet */ }
  await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
  return 'rotated';
}
