/* CapacityProbe — the Node client for the sidecar's GET /capacity (vram-aware
   placement, Task 6). Tries the sidecar first (the live, cross-vendor,
   Ollama-aware source of truth); falls back to shelling nvidia-smi/rocm-smi
   directly when the sidecar is down (e.g. during the analysis phase, or an
   RSS recycle mid-restart); degrades to a CPU-only reading as the final
   floor. Never throws — every failure path degrades to the next fallback.
   A ~1500ms last-known-good cache means callers on the hot path (repeated
   admission checks in quick succession) don't re-probe on every call; pass
   `fresh: true` to force a re-probe (e.g. right before an admission retry). */

import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export interface ComputeDevice {
  kind: 'cuda' | 'rocm' | 'mps' | 'cpu';
  index: number;
  label: string;
  totalMb: number;
  freeMb: number;
}

export interface CapacityProbe {
  read(opts?: { fresh?: boolean }): Promise<ComputeDevice[]>;
}

const PROBE_TIMEOUT_MS = 2_000;
const EXEC_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 1_500;

let cache: { at: number; devices: ComputeDevice[] } | null = null;

/** GET `<sidecarUrl>/capacity` — same URL resolution as sidecar-health.ts.
    Returns null on any failure (timeout, unreachable, non-2xx, bad body). */
async function fetchSidecar(): Promise<ComputeDevice[] | null> {
  const url = getResolvedSidecarUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/capacity`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { devices?: ComputeDevice[] } | null;
    if (!body || !Array.isArray(body.devices)) return null;
    return body.devices;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Parse `nvidia-smi --query-gpu=index,memory.total,memory.free
    --format=csv,noheader,nounits` — one "index, total, free" line per card. */
function parseNvidiaSmiCsv(raw: string): ComputeDevice[] {
  const devices: ComputeDevice[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const index = Number(parts[0]);
    const totalMb = Number(parts[1]);
    const freeMb = Number(parts[2]);
    if (!Number.isFinite(index) || !Number.isFinite(totalMb) || !Number.isFinite(freeMb)) continue;
    devices.push({ kind: 'cuda', index, label: `cuda:${index}`, totalMb, freeMb });
  }
  return devices;
}

/** Parse `rocm-smi --showmeminfo vram --json` — `{"card0": {"VRAM Total
    Memory (B)": "...", "VRAM Total Used Memory (B)": "..."}, ...}`. */
function parseRocmSmiJson(raw: string): ComputeDevice[] {
  const devices: ComputeDevice[] = [];
  let parsed: Record<string, Record<string, string>>;
  try {
    parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  } catch {
    return devices;
  }
  let index = 0;
  for (const [label, info] of Object.entries(parsed)) {
    const totalB = Number(info['VRAM Total Memory (B)']);
    if (!Number.isFinite(totalB)) continue;
    const usedB = Number(info['VRAM Total Used Memory (B)']);
    const totalMb = Math.round(totalB / 1_048_576);
    const usedMb = Number.isFinite(usedB) ? Math.round(usedB / 1_048_576) : 0;
    devices.push({ kind: 'rocm', index, label, totalMb, freeMb: Math.max(0, totalMb - usedMb) });
    index += 1;
  }
  return devices;
}

/** Vendor-tool fallback for when the sidecar is unreachable. Tries nvidia-smi
    first, then rocm-smi. Returns null if neither is present/parseable. */
async function vendorProbe(): Promise<ComputeDevice[] | null> {
  try {
    const raw = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    const devices = parseNvidiaSmiCsv(raw);
    if (devices.length > 0) return devices;
  } catch {
    /* nvidia-smi not present or errored — try rocm-smi next */
  }
  try {
    const raw = await execFileAsync('rocm-smi', ['--showmeminfo', 'vram', '--json']);
    const devices = parseRocmSmiJson(raw);
    if (devices.length > 0) return devices;
  } catch {
    /* rocm-smi not present or errored either — CPU-only floor */
  }
  return null;
}

/** Final floor — always available, never throws. */
function cpuOnlyDevice(): ComputeDevice {
  return {
    kind: 'cpu',
    index: 0,
    label: 'cpu',
    totalMb: Math.round(totalmem() / 1_048_576),
    freeMb: Math.round(freemem() / 1_048_576),
  };
}

async function probe(): Promise<ComputeDevice[]> {
  const sidecarDevices = await fetchSidecar();
  if (sidecarDevices) return sidecarDevices;
  const vendorDevices = await vendorProbe();
  if (vendorDevices) return vendorDevices;
  return [cpuOnlyDevice()];
}

export const capacityProbe: CapacityProbe = {
  async read(opts?: { fresh?: boolean }): Promise<ComputeDevice[]> {
    const now = Date.now();
    if (!opts?.fresh && cache && now - cache.at < CACHE_TTL_MS) {
      return cache.devices;
    }
    const devices = await probe();
    cache = { at: now, devices };
    return devices;
  },
};
