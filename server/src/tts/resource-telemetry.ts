/* fs-20 — per-run resource telemetry. After each chapter renders we append one
   JSONL line capturing the throughput (RTF, audio/wall seconds) alongside the
   GPU + host-RAM figures at that moment, so the admin console can chart how
   resource pressure trends across a long run (the symptom that precedes a VRAM
   spill / host-OOM is a slow climb that's invisible chapter-to-chapter).

   Storage is a single workspace-level JSONL file (one line per chapter),
   capped at TELEMETRY_MAX_LINES with read-trim-rewrite rotation. Everything is
   best-effort: a write failure (disk full, permission) must NEVER block the
   generation hot path, and a corrupt trailing line (crash mid-append) must not
   break the reader. */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { telemetryDir } from '../workspace/paths.js';
import { join } from 'node:path';

export interface ResourceTelemetryRecord {
  at: string;
  bookId: string | null;
  /** Human-readable book title at render time (state.json `title`). Null for
      legacy records written before this field, or when the title was unknown. */
  bookTitle: string | null;
  chapterId: number | string;
  title: string | null;
  modelKey: string | null;
  rtf: number | null;
  audioSec: number;
  /** Chapter synth wall time. Narrowed 2026-07-01 (PR-2,
      [[127-generation-rtf-telemetry]]) to exclude the post-synth loudnorm
      encode + disk write — records from before that change include them, so
      a trend chart spanning the deploy boundary shows a step-change drop
      that is NOT a real perf improvement. No version marker distinguishes
      old vs. new records (see the plan for why this was accepted rather than
      added). */
  wallSec: number;
  vramReservedMb: number | null;
  vramTotalMb: number | null;
  committedHostMb: number | null;
}

/* Cap on retained lines. ~2000 chapters is many full books; past that we drop
   the oldest so the file can't grow unbounded across a workspace's lifetime. */
export const TELEMETRY_MAX_LINES = 2000;

export function telemetryFilePath(): string {
  return join(telemetryDir(), 'resource-telemetry.jsonl');
}

/** Append one telemetry record as a JSONL line. Best-effort: creates the dir if
    missing, and swallows any IO error (never throws — the caller fires this
    fire-and-forget on the hot path). Trims to TELEMETRY_MAX_LINES via a
    read-trim-rewrite when the file grows past the cap. */
export async function appendTelemetry(rec: ResourceTelemetryRecord): Promise<void> {
  const path = telemetryFilePath();
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
    await trimIfNeeded(path);
  } catch {
    /* Telemetry is observability, not correctness — never let it break a run. */
  }
}

/* Read-trim-rewrite when the line count crosses the cap. Cheap enough at this
   scale (a few thousand short lines) and keeps the file bounded. */
async function trimIfNeeded(path: string): Promise<void> {
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= TELEMETRY_MAX_LINES) return;
    const kept = lines.slice(lines.length - TELEMETRY_MAX_LINES);
    await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
  } catch {
    /* Best-effort trim — a failure just leaves the file slightly over cap. */
  }
}

/** Read telemetry records NEWEST-FIRST, optionally capped at `limit`. A corrupt
    line (e.g. a half-written trailing line from a crash mid-append) is skipped
    rather than thrown; a missing file returns []. */
export async function readTelemetry(limit?: number): Promise<ResourceTelemetryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(telemetryFilePath(), 'utf8');
  } catch {
    return [];
  }
  const out: ResourceTelemetryRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as ResourceTelemetryRecord);
    } catch {
      /* Skip a corrupt / partial line — do not let it break the read. */
    }
  }
  out.reverse(); // newest-first
  return limit != null && limit >= 0 ? out.slice(0, limit) : out;
}
