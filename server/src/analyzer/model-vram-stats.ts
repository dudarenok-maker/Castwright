/* Measured per-model VRAM store. Each analysis call samples the resident
   model's actual GPU footprint from Ollama /api/ps (size_vram) and appends a
   JSONL line. Append-only (mirrors resource-telemetry.ts) because a
   read-modify-write JSON object loses concurrent updates.
   fs-45 v1 is RECORD-ONLY: nothing reads this store for a decision (the
   analyzer's keepAliveFor() uses the flat RESIDENT_MODELS logic, unchanged).
   The EMA read below — computed at read time by folding the log in
   chronological (file) order — is the DEFERRED v2 consumer: an adaptive
   keepAliveFor() that would evict a model too big to stay resident. Dormant. */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';

export interface VramSampleRecord {
  at: string;
  key: string; // canonicalVramKey(model, numCtx)
  vramMb: number;
}

const EMA_ALPHA = 0.3;
const MAX_PER_KEY = 50;

export function vramStatsFilePath(): string {
  return join(telemetryDir(), 'model-vram-stats.jsonl');
}

/** Canonical store key. Ollama canonicalises a bare family name to ':latest'
    (qwen3.5 ⇄ qwen3.5:latest are the same model); two explicit tags that only
    share a root (qwen3.5:4b vs :9b) are NOT. num_ctx is part of the key because
    KV-cache VRAM scales with it. */
export function canonicalVramKey(model: string, numCtx: number): string {
  const norm = model.includes(':') ? model : `${model}:latest`;
  return `${norm}@${numCtx}`;
}

/** EMA over an ordered list of samples (oldest → newest). */
export function foldEma(values: number[]): number | null {
  if (values.length === 0) return null;
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = EMA_ALPHA * values[i] + (1 - EMA_ALPHA) * ema;
  return ema;
}

export function _emaFromRecords(records: VramSampleRecord[], key: string): number | null {
  return foldEma(records.filter((r) => r.key === key).map((r) => r.vramMb));
}

function parseRecords(raw: string): VramSampleRecord[] {
  const out: VramSampleRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as VramSampleRecord); } catch { /* skip corrupt line */ }
  }
  return out;
}

async function readRecords(): Promise<VramSampleRecord[]> {
  try { return parseRecords(await readFile(vramStatsFilePath(), 'utf8')); }
  catch { return []; }
}

/** Read every persisted sample in chronological (file) order. */
export async function readAllVramRecords(): Promise<VramSampleRecord[]> {
  return readRecords();
}

/** Append one sample. Best-effort — never throws (fire-and-forget on the
    analysis path). Trims to MAX_PER_KEY per key via read-trim-rewrite past the cap. */
export async function recordVramSample(rec: VramSampleRecord): Promise<void> {
  const path = vramStatsFilePath();
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
    const recs = parseRecords(await readFile(path, 'utf8'));
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    if ([...counts.values()].some((n) => n > MAX_PER_KEY)) {
      const kept = new Map<string, number>();
      const out: VramSampleRecord[] = [];
      for (let i = recs.length - 1; i >= 0; i--) {        // newest-first
        const r = recs[i];
        const used = kept.get(r.key) ?? 0;
        if (used >= MAX_PER_KEY) continue;
        kept.set(r.key, used + 1);
        out.push(r);
      }
      out.reverse();                                      // restore chronological
      await writeFile(path, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    }
  } catch {
    /* observability, not correctness */
  }
}

/** Async EMA read (used by tooling / tests that read the file). The deferred-v2
    keepAliveFor() path would use the synchronous in-memory cache primed below. */
export async function emaForModelAsync(model: string, numCtx: number): Promise<number | null> {
  return _emaFromRecords(await readRecords(), canonicalVramKey(model, numCtx));
}

/* Synchronous EMA cache for the deferred-v2 keepAliveFor(). Keyed by
   canonicalVramKey. Updated on every sample and primed from disk at boot;
   no v1 consumer reads it. */
const emaCache = new Map<string, number>();

export function emaForModelSync(model: string, numCtx: number): number | null {
  const v = emaCache.get(canonicalVramKey(model, numCtx));
  return v ?? null;
}

function updateEmaCache(key: string, vramMb: number): void {
  const prev = emaCache.get(key);
  emaCache.set(key, prev == null ? vramMb : EMA_ALPHA * vramMb + (1 - EMA_ALPHA) * prev);
}

/** Prime the sync cache from a record list (called at boot with readRecords()). */
export function primeVramCache(records: VramSampleRecord[]): void {
  emaCache.clear();
  const byKey = new Map<string, number[]>();
  for (const r of records) {
    const arr = byKey.get(r.key) ?? [];
    arr.push(r.vramMb);
    byKey.set(r.key, arr);
  }
  for (const [key, vals] of byKey) {
    const ema = foldEma(vals);
    if (ema != null) emaCache.set(key, ema);
  }
}

export function _resetVramCacheForTests(): void {
  emaCache.clear();
}

/** Boot init: read the persisted log and prime the sync cache. */
export async function initVramStats(): Promise<void> {
  primeVramCache(await readRecords());
}

type MinimalFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Default fetch with a 1s abort budget — the sampler is awaited inside the
    analyzer's GPU lock (ollama.ts), so a hung /api/ps must not pin the GPU. */
const timedFetch: MinimalFetch = (u) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_000);
  return (fetch(u, { signal: ctrl.signal }) as unknown as ReturnType<MinimalFetch>).finally(
    () => clearTimeout(timer),
  );
};

/** Fraction of total bytes that must be resident in VRAM to count as a clean,
    fully-on-GPU sample. A partial CPU/GPU split under-reports the true need —
    recording it would teach keepAliveFor a model "fits" when it actually
    spilled, the precise wrong call. */
const GPU_RESIDENT_FRACTION = 0.95;

/** Read /api/ps once, find `model`, and record its size_vram (MB) IF the model
    is ~100% resident on GPU. Best-effort; never throws. */
export async function sampleAndRecordVram(
  url: string,
  model: string,
  numCtx: number,
  fetchFn: MinimalFetch = timedFetch,
): Promise<void> {
  try {
    const resp = await fetchFn(`${url.replace(/\/+$/, '')}/api/ps`);
    if (!resp.ok) return;
    const body = (await resp.json()) as {
      models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }>;
    };
    const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);
    const want = norm(model);
    const hit = (body.models ?? []).find((m) => norm(m.name ?? m.model ?? '') === want);
    if (!hit) return;
    const size = hit.size ?? 0;
    const vram = hit.size_vram ?? 0;
    if (size <= 0 || vram < size * GPU_RESIDENT_FRACTION) return; // not fully on GPU → skip
    const vramMb = vram / 1024 / 1024;
    const key = canonicalVramKey(model, numCtx);
    updateEmaCache(key, vramMb);
    await recordVramSample({ at: new Date().toISOString(), key, vramMb });
  } catch {
    /* best-effort */
  }
}
