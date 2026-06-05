#!/usr/bin/env -S npx tsx
/* Audit every rendered chapter for ASR content drift — "fluent but wrong words"
   segments the signal-based segment QA can't see (srv-31). Read-only: it
   transcribes and word-error-rates each segment against its manuscript text and
   REPORTS the drift; it never re-records or writes. This is how the srv-31 fix
   reaches the BACK-CATALOG (live generation + the repair route cover new work).

   Requires a RUNNING TTS sidecar with the Whisper model available
   (ASR_DEVICE/ASR_MODEL as configured) — it calls POST {sidecar}/transcribe.

   Usage (from repo root):
     npx tsx scripts/audit-audio-asr-drift.mts
     npx tsx scripts/audit-audio-asr-drift.mts --book=<bookId>
     WORKSPACE_DIR=C:/AudiobookWorkspace npx tsx scripts/audit-audio-asr-drift.mts

   Env overrides:
     WORKSPACE_DIR  workspace root containing books/ (default: ../audiobook-workspace)
     ASR_DEVICE     cpu (default) | cuda — where the sidecar runs Whisper
     SEG_ASR_*      the same WER thresholds the live gate reads (segment-asr-qa.ts) */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAudioToPcm } from '../server/src/tts/mp3.js';
import { secToByteOffset } from '../server/src/audio/splice-chapter.js';
import {
  verifySegmentTranscript,
  buildCastNameAllowlist,
} from '../server/src/tts/segment-asr-qa.js';
import { isRerecordableSegment } from '../server/src/audio/build-synth-replacement.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const WORKSPACE_DIR = resolve(
  process.env.WORKSPACE_DIR || join(repoRoot, '..', 'audiobook-workspace'),
);
const bookFilter = process.argv.find((a) => a.startsWith('--book='))?.slice('--book='.length);

interface SegmentLike {
  characterId: string;
  sentenceIds: number[];
  startSec: number;
  endSec: number;
  kind?: string;
}
interface SegmentsFile {
  bookId?: string;
  sampleRate: number;
  segments: SegmentLike[];
  modelKey?: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Find every `.audiobook/state.json` under the workspace. */
function findStateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (e.name === 'state.json' && p.replace(/\\/g, '/').includes('/.audiobook/')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

interface ChapterState {
  id: number;
  slug: string;
  title?: string;
}
interface BookState {
  bookId: string;
  manuscriptId: string;
  title?: string;
  language?: string;
  chapters?: ChapterState[];
}

async function main() {
  if (!existsSync(WORKSPACE_DIR)) {
    console.error(`Workspace not found: ${WORKSPACE_DIR} (set WORKSPACE_DIR).`);
    process.exit(1);
  }
  console.log(`ASR drift audit — workspace ${WORKSPACE_DIR}\n`);

  const states = findStateFiles(WORKSPACE_DIR);
  let totalSegments = 0;
  let totalDrift = 0;
  let totalInconclusive = 0;
  const perEngineDrift = new Map<string, number>();

  for (const statePath of states) {
    const state = readJson<BookState>(statePath);
    if (!state?.bookId) continue;
    if (bookFilter && state.bookId !== bookFilter) continue;
    const bookDir = dirname(dirname(statePath)); // …/<book>/.audiobook/state.json → <book>
    const audioRoot = join(bookDir, 'audio');
    if (!existsSync(audioRoot)) continue;

    // Sentence text per id, from the analysis cache file under the book.
    const idToText = new Map<number, string>();
    const cachePath = join(bookDir, '.audiobook', 'analysis-cache.json');
    const cache = readJson<{ chapters?: Record<string, { id: number; text: string }[]> }>(cachePath);
    if (cache?.chapters) {
      for (const arr of Object.values(cache.chapters)) for (const s of arr) idToText.set(s.id, s.text);
    }

    const castNames = readJson<{ characters?: { name?: string; aliases?: string[] }[] }>(
      join(bookDir, '.audiobook', 'cast.json'),
    );
    const allowlist = buildCastNameAllowlist(castNames?.characters ?? []);
    const language =
      state.language && !/^en\b/i.test(state.language) ? state.language : undefined;

    let bookDrift = 0;
    for (const ch of state.chapters ?? []) {
      const segPath = join(audioRoot, `${ch.slug}.segments.json`);
      const mp3Path = join(audioRoot, `${ch.slug}.mp3`);
      const segFile = readJson<SegmentsFile>(segPath);
      if (!segFile?.segments?.length || !existsSync(mp3Path)) continue;

      let decoded: Buffer;
      try {
        decoded = await decodeAudioToPcm(readFileSync(mp3Path), segFile.sampleRate);
      } catch (e) {
        console.warn(`  [skip] ${state.title} ch${ch.id}: decode failed (${(e as Error).message})`);
        continue;
      }

      for (const seg of segFile.segments) {
        if (!isRerecordableSegment(seg as never)) continue;
        const text = seg.sentenceIds.map((id) => idToText.get(id) ?? '').join(' ').trim();
        if (!text) continue;
        const start = secToByteOffset(seg.startSec, segFile.sampleRate, decoded.length);
        const end = secToByteOffset(seg.endSec, segFile.sampleRate, decoded.length);
        totalSegments += 1;
        let cls;
        try {
          cls = await verifySegmentTranscript(decoded.subarray(start, end), segFile.sampleRate, text, {
            language,
            nameAllowlist: allowlist,
          });
        } catch (e) {
          console.error(`  /transcribe failed (${(e as Error).message}). Is the sidecar up?`);
          process.exit(2);
        }
        if (cls.verdict === 'inconclusive') totalInconclusive += 1;
        if (cls.verdict === 'drift') {
          totalDrift += 1;
          bookDrift += 1;
          const eng = segFile.modelKey ?? 'unknown';
          perEngineDrift.set(eng, (perEngineDrift.get(eng) ?? 0) + 1);
          console.log(
            `  DRIFT ${state.title} ch${ch.id} [${seg.characterId}] wer=${cls.wer.toFixed(2)} ` +
              `(${cls.sub}s/${cls.del}d/${cls.ins}i): "${cls.transcript.slice(0, 80)}"`,
          );
        }
      }
    }
    if (bookDrift > 0) console.log(`  → ${state.title}: ${bookDrift} drifting segment(s)\n`);
  }

  console.log('\n── Summary ──');
  console.log(`segments scanned:   ${totalSegments}`);
  console.log(`content drift:      ${totalDrift}`);
  console.log(`inconclusive:       ${totalInconclusive}`);
  for (const [eng, n] of perEngineDrift) console.log(`  drift via ${eng}: ${n}`);
  if (totalDrift > 0) {
    console.log(
      `\nRe-record drifting chapters via POST /api/books/{id}/chapters/{ch}/audio-qa-repair ` +
        `(SEG_ASR_ENABLED=1).`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
