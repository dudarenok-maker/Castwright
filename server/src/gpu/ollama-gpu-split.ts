/* Detects whether the resident Ollama analyzer model's VRAM is currently
   split across more than one physical GPU, and whether it would have fit on
   a single device. Ollama's own /api/ps reports one aggregate VRAM number
   per resident model (see analyzer/ollama-residency.ts) and cannot see
   per-device placement, so this shells out to nvidia-smi's
   --query-compute-apps view instead, which lists (GPU, process) pairs.
   Same never-throw, best-effort contract as gpu/capacity-probe.ts and
   gpu/device-total.ts: any missing binary, non-2xx/empty output, parse
   failure, or timeout degrades to reachable: false rather than throwing. */

import { execFile } from 'node:child_process';

const EXEC_TIMEOUT_MS = 4_000;

export interface OllamaGpuSplitResult {
  reachable: boolean;
  split: boolean;
  deviceIndices: number[];
  totalUsedMb: number;
  wouldFitSingleDevice: boolean;
  /** Ollama processes exist but their per-process used_memory was unreadable
      (e.g. [N/A] under WDDM driver model) — probe is inconclusive. Split between
      `false` (no split found) is crucial: dataUnavailable: true + deviceIndices: []
      means "can't determine", while split: false + dataUnavailable: false means
      "genuinely no split". */
  dataUnavailable: boolean;
}

interface ComputeAppRow {
  gpuUuid: string;
  pid: string;
  processName: string;
  usedMemoryMb: number;
}

interface GpuIndexUuidRow {
  index: number;
  uuid: string;
}

interface GpuFreeRow {
  index: number;
  freeMb: number;
}

function emptyResult(): OllamaGpuSplitResult {
  return {
    reachable: false,
    split: false,
    deviceIndices: [],
    totalUsedMb: 0,
    wouldFitSingleDevice: false,
    dataUnavailable: false,
  };
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

interface ParseComputeAppsResult {
  rows: ComputeAppRow[];
  /** True if at least one structurally-valid row (correct field count, non-empty fields)
      was skipped due to non-finite usedMemoryMb (e.g., [N/A] under WDDM driver). */
  hadUnparseableMemory: boolean;
}

/** Parse `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory
    --format=csv,noheader,nounits` — one row per (GPU, process) pair. */
export function parseComputeAppsCsv(raw: string): ParseComputeAppsResult {
  const rows: ComputeAppRow[] = [];
  let hadUnparseableMemory = false;
  for (const line of raw.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) continue;
    const [gpuUuid, pid, processName, usedMemoryRaw] = parts;
    const usedMemoryMb = Number(usedMemoryRaw);
    if (!gpuUuid || !pid || !processName) continue;
    // Row is structurally valid but memory parse failed
    if (!Number.isFinite(usedMemoryMb)) {
      hadUnparseableMemory = true;
      continue;
    }
    rows.push({ gpuUuid, pid, processName, usedMemoryMb });
  }
  return { rows, hadUnparseableMemory };
}

/** Parse `nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits` —
    maps each compute-app row's gpu_uuid back to a physical GPU index. */
export function parseGpuIndexUuidCsv(raw: string): GpuIndexUuidRow[] {
  const rows: GpuIndexUuidRow[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    const uuid = parts[1];
    if (!Number.isFinite(index) || !uuid) continue;
    rows.push({ index, uuid });
  }
  return rows;
}

/** Parse `nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits`
    — each device's free VRAM BEFORE subtracting anything, for the "would it
    have fit on one device" check. */
export function parseGpuFreeCsv(raw: string): GpuFreeRow[] {
  const rows: GpuFreeRow[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    const freeMb = Number(parts[1]);
    if (!Number.isFinite(index) || !Number.isFinite(freeMb)) continue;
    rows.push({ index, freeMb });
  }
  return rows;
}

/** Best-effort, never-throws probe for whether Ollama's resident model VRAM
    spans multiple physical GPUs, and whether it would have fit on one.
    Matches "Ollama" via a liberal /ollama/i substring on process_name — the
    daemon binary and its per-model runner subprocess names can differ across
    platforms/installs, so an exact-name match would miss real installs; the
    verify child confirms this against a real box. */
export async function detectOllamaGpuSplit(): Promise<OllamaGpuSplitResult> {
  let computeAppsRaw: string;
  let indexUuidRaw: string;
  let freeRaw: string;
  try {
    [computeAppsRaw, indexUuidRaw, freeRaw] = await Promise.all([
      execFileAsync('nvidia-smi', [
        '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
        '--format=csv,noheader,nounits',
      ]),
      execFileAsync('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader,nounits']),
      execFileAsync('nvidia-smi', ['--query-gpu=index,memory.free', '--format=csv,noheader,nounits']),
    ]);
  } catch {
    return emptyResult();
  }

  const uuidToIndex = new Map(parseGpuIndexUuidCsv(indexUuidRaw).map((r) => [r.uuid, r.index]));
  if (uuidToIndex.size === 0) return emptyResult();
  const freeByIndex = new Map(parseGpuFreeCsv(freeRaw).map((r) => [r.index, r.freeMb]));

  const parsed = parseComputeAppsCsv(computeAppsRaw);
  const ollamaRows = parsed.rows.filter((r) => /ollama/i.test(r.processName));

  // If we saw unparseable VRAM data and Ollama processes in the raw output,
  // the data is inconclusive (driver doesn't expose per-process VRAM).
  const hadOllamaProcessInRaw = /ollama/i.test(computeAppsRaw);
  const dataUnavailable = parsed.hadUnparseableMemory && hadOllamaProcessInRaw;

  if (ollamaRows.length === 0) {
    return {
      reachable: true,
      split: false,
      deviceIndices: [],
      totalUsedMb: 0,
      wouldFitSingleDevice: false,
      dataUnavailable,
    };
  }

  // Group rows by PID to detect whether any single Ollama model's VRAM is split
  // across multiple GPUs. Two different PIDs on different GPUs represent
  // two distinct models and should NOT be reported as a split.
  interface PidInfo {
    indices: Set<number>;
    totalMb: number;
    mbByIndex: Map<number, number>;
  }
  const byPid = new Map<string, PidInfo>();
  for (const row of ollamaRows) {
    const index = uuidToIndex.get(row.gpuUuid);
    if (index === undefined) continue;
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, { indices: new Set(), totalMb: 0, mbByIndex: new Map() });
    }
    const entry = byPid.get(row.pid)!;
    entry.indices.add(index);
    entry.totalMb += row.usedMemoryMb;
    entry.mbByIndex.set(index, (entry.mbByIndex.get(index) ?? 0) + row.usedMemoryMb);
  }

  // Collect all GPUs and VRAM from split PIDs (PIDs that span 2+ GPUs)
  const splitPids = Array.from(byPid.entries()).filter(([, entry]) => entry.indices.size >= 2);
  if (splitPids.length === 0) {
    return {
      reachable: true,
      split: false,
      deviceIndices: [],
      totalUsedMb: 0,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    };
  }

  // Aggregate all device indices and VRAM from split PIDs
  const allIndicesSet = new Set<number>();
  let totalUsedMb = 0;
  const totalMbByIndex = new Map<number, number>();
  for (const [, entry] of splitPids) {
    for (const idx of entry.indices) {
      allIndicesSet.add(idx);
      const mb = entry.mbByIndex.get(idx) ?? 0;
      totalMbByIndex.set(idx, (totalMbByIndex.get(idx) ?? 0) + mb);
    }
    totalUsedMb += entry.totalMb;
  }

  const deviceIndices = [...allIndicesSet].sort((a, b) => a - b);
  const split = true; // We only reach here if splitPids.length > 0

  const wouldFitSingleDevice = deviceIndices.some((index) => {
    const freeMb = freeByIndex.get(index) ?? 0;
    const ownShareMb = totalMbByIndex.get(index) ?? 0;
    return freeMb + ownShareMb >= totalUsedMb;
  });

  return { reachable: true, split, deviceIndices, totalUsedMb, wouldFitSingleDevice, dataUnavailable: false };
}
