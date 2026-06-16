/* Boot-time GPU total-VRAM probe. The analyzer keep-alive decision
   (analyzer/ollama.ts keepAliveFor) needs the device total synchronously,
   and the TTS sidecar — the other VRAM source — is typically DOWN during
   analysis (sequential phases). So we probe once at server start via
   nvidia-smi and cache the result. Non-NVIDIA / no nvidia-smi → null, which
   disables adaptive eviction (keep-alive falls back to the flat knob). */

import { execFile } from 'node:child_process';

let cachedTotalMb: number | null = null;

/** Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`.
    Output is the first GPU's total in MiB, optionally with a " MiB" suffix. */
export function parseNvidiaSmiTotalMb(raw: string): number | null {
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = first.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Test seam + the init path's setter. */
export function setDeviceTotalVramMb(mb: number | null): void {
  cachedTotalMb = mb;
}

/** Synchronous read for keepAliveFor(). Null until initDeviceTotalVram() runs
    (or on a box without nvidia-smi). */
export function getDeviceTotalVramMb(): number | null {
  return cachedTotalMb;
}

export function _resetDeviceTotalForTests(): void {
  cachedTotalMb = null;
}

/** Fire once at server boot. Best-effort: any failure leaves the cache null. */
export async function initDeviceTotalVram(): Promise<void> {
  await new Promise<void>((resolveP) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4_000, windowsHide: true },
      (err, stdout) => {
        if (!err && typeof stdout === 'string') {
          cachedTotalMb = parseNvidiaSmiTotalMb(stdout);
        }
        resolveP();
      },
    );
  });
}
