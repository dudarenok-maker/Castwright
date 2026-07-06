/* fs-20 — per-run resource telemetry tests. Drives appendTelemetry /
   readTelemetry against a temp WORKSPACE_DIR (set before the dynamic import so
   paths.ts resolves the telemetry dir under it). Pins: JSONL round-trip,
   newest-first ordering + limit, cap rotation drops oldest, and a corrupt
   trailing line is skipped rather than thrown. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let workspaceRoot: string;
let mod: typeof import('./resource-telemetry.js');
let telemetryFilePath: () => string;

const rec = (over: Partial<Parameters<typeof mod.appendTelemetry>[0]> = {}) => ({
  at: new Date().toISOString(),
  bookId: 'book-a',
  bookTitle: 'Book A',
  chapterId: 1,
  title: 'Chapter 1',
  modelKey: 'qwen3-tts-0.6b',
  rtf: 1.2,
  rerecordRtf: null,
  audioSec: 600,
  wallSec: 720,
  vramReservedMb: 3200,
  vramTotalMb: 8192,
  committedHostMb: 4096,
  ...over,
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-telemetry-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  mod = await import('./resource-telemetry.js');
  telemetryFilePath = mod.telemetryFilePath;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  const p = telemetryFilePath();
  if (existsSync(p)) rmSync(p, { force: true });
});

describe('resource-telemetry', () => {
  it('telemetryFilePath resolves under <WORKSPACE_ROOT>/.telemetry', () => {
    expect(telemetryFilePath()).toContain(join(workspaceRoot, '.telemetry'));
    expect(telemetryFilePath()).toMatch(/resource-telemetry\.jsonl$/);
  });

  it('appends a record and reads it back (JSONL round-trip)', async () => {
    await mod.appendTelemetry(rec({ chapterId: 7, rtf: 0.9 }));
    const out = await mod.readTelemetry();
    expect(out).toHaveLength(1);
    expect(out[0].chapterId).toBe(7);
    expect(out[0].rtf).toBe(0.9);
    expect(out[0].vramTotalMb).toBe(8192);
    expect(out[0].bookTitle).toBe('Book A');
  });

  it('round-trips a non-null rerecordRtf (single-worker QA-cost split)', async () => {
    await mod.appendTelemetry(rec({ chapterId: 8, rerecordRtf: 0.3 }));
    const out = await mod.readTelemetry();
    expect(out[0].rerecordRtf).toBe(0.3);
  });

  it('round-trips a null rerecordRtf (multi-worker run)', async () => {
    await mod.appendTelemetry(rec({ chapterId: 9, rerecordRtf: null }));
    const out = await mod.readTelemetry();
    expect(out[0].rerecordRtf).toBeNull();
  });

  it('returns records newest-first and honours the limit', async () => {
    for (let i = 1; i <= 5; i++) await mod.appendTelemetry(rec({ chapterId: i }));
    const all = await mod.readTelemetry();
    expect(all.map((r) => r.chapterId)).toEqual([5, 4, 3, 2, 1]);
    const limited = await mod.readTelemetry(2);
    expect(limited.map((r) => r.chapterId)).toEqual([5, 4]);
  });

  it('rotates: trims oldest lines when the cap is exceeded', async () => {
    /* Only the newest CAP of CAP+3 lines should survive. Pre-seed CAP+2 lines
       directly (writeFileSync — trimIfNeeded only ever fires past the cap,
       so a direct pre-seed exercises no less real logic than getting there
       via CAP+2 individual appends) and make exactly ONE real appendTelemetry
       call — the CAP+3rd — to run the actual trim path. Driving all CAP+3
       appends through appendTelemetry (each doing a full read-trim-rewrite
       once past the cap, by design) turned this test into ~30s of real fs
       round-trips under full-suite pool contention (#1337): long enough to
       blow the default test timeout, and since Node can't cancel the
       abandoned in-flight loop on a vitest timeout, it kept appending in the
       background afterwards and corrupted the next two tests sharing this
       file's on-disk state. */
    const cap = mod.TELEMETRY_MAX_LINES;
    mkdirSync(dirname(telemetryFilePath()), { recursive: true });
    const seeded = Array.from({ length: cap + 2 }, (_, i) =>
      JSON.stringify(rec({ chapterId: i + 1 })),
    );
    writeFileSync(telemetryFilePath(), `${seeded.join('\n')}\n`);

    await mod.appendTelemetry(rec({ chapterId: cap + 3 }));

    const all = await mod.readTelemetry(cap + 10);
    expect(all.length).toBe(cap);
    /* Newest-first: the very first record (chapterId 1, 2, 3) should be gone. */
    expect(all[0].chapterId).toBe(cap + 3);
    expect(all.some((r) => r.chapterId === 1)).toBe(false);
    expect(all.some((r) => r.chapterId === 4)).toBe(true);
  });

  it('skips a corrupt trailing line rather than throwing', async () => {
    await mod.appendTelemetry(rec({ chapterId: 11 }));
    /* Simulate a half-written final line (crash mid-append). */
    appendFileSync(telemetryFilePath(), '{ this is not valid json');
    const out = await mod.readTelemetry();
    expect(out).toHaveLength(1);
    expect(out[0].chapterId).toBe(11);
  });

  it('readTelemetry returns [] when the file does not exist', async () => {
    const out = await mod.readTelemetry();
    expect(out).toEqual([]);
  });

  it('creates the telemetry dir on first append (no pre-existing dir)', async () => {
    /* Nuke the whole dir, then append — appendTelemetry must recreate it. */
    rmSync(join(workspaceRoot, '.telemetry'), { recursive: true, force: true });
    await mod.appendTelemetry(rec({ chapterId: 99 }));
    expect(existsSync(telemetryFilePath())).toBe(true);
    const out = await mod.readTelemetry();
    expect(out[0].chapterId).toBe(99);
  });

  it('tolerates a blank line in the file', async () => {
    writeFileSync(telemetryFilePath(), `${JSON.stringify(rec({ chapterId: 21 }))}\n\n`);
    const out = await mod.readTelemetry();
    expect(out).toHaveLength(1);
    expect(out[0].chapterId).toBe(21);
  });
});
