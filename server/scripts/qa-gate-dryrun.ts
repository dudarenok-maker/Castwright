/* One-off, read-only measurement (PR-1 validation). Re-derives the PR-1 gate
   verdicts over a rendered book's *.segments.json and reports how many of the
   original false-positive flags the fixes clear.

     npx tsx server/scripts/qa-gate-dryrun.ts "<audio dir with *.segments.json>"

   SCHEMA NOTE: the rendered segments.json does NOT store the manuscript `text`
   (the book ships as an EPUB; sentence text is not joined into the sidecar), and
   does NOT store the Whisper signals (compressionRatio/avgLogprob). It DOES store
   the per-segment `qa` (durationSec/expectedSec/...) and `asr`
   (verdict/wer/sub/del/ins/longestDeletionRun/transcript/reasons) computed at
   render time with the OLD gate. So we re-derive from those stored fields:

     - A1 (duration runaway): EXACT — recompute ratio = durationSec/expectedSec and
       apply the new absolute floor (durationSec >= 3.0).
     - A2b (short-ref single-sub backstop): EXACT on the sub-only class — recover
       expectedLen = round((sub+del+ins)/wer) and apply the rule (len 2, del 0,
       ins 0, sub 1 → inconclusive). A2a never touches a pure-substitution segment
       (no pair concatenates), so the stored counts are valid for A2b here.
     - A2a (word-split bridge): INDICATIVE — counts WER-drifts with an insertion
       (the word-split shape, e.g. "Skull Duggery"); the precise post-A2a count
       needs the manuscript join and is confirmed by the owed on-box re-render.

   The DEFINITIVE before/after RTF is a per-chapter re-render on the box (spec Ship
   notes, L3) — this static pass is supporting evidence that the FP classes clear
   and that real defects (compression loops, truncation runs, multi-error garble)
   survive. No writes. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SEGMENT_QA_THRESHOLDS } from '../src/tts/segment-qa.js';
import { DEFAULT_ASR_THRESHOLDS } from '../src/tts/segment-asr-qa.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: qa-gate-dryrun.ts <audio-dir>');
  process.exit(1);
}

const qt = DEFAULT_SEGMENT_QA_THRESHOLDS;
const at = DEFAULT_ASR_THRESHOLDS;

let total = 0;
// A1 duration.
let durLongOld = 0;
let durLongNew = 0;
// A2 ASR.
let asrDrift = 0;
let compressionDrift = 0; // reasons mention loop/repeat — real, stays drift
let truncationDrift = 0; // reasons mention truncation/drop (deletion run) — real, stays
let a2bFlip = 0; // sub-only on a 2-word ref → inconclusive (EXACT)
let a2aSplitCandidate = 0; // WER-drift with an insertion (word-split shape) — indicative
let residualDrift = 0; // still drift after A1/A2a/A2b — should be real defects
const residualSamples: string[] = [];

const reasonsOf = (s: any): string => ((s.asr?.reasons ?? []) as string[]).join(' ').toLowerCase();

for (const f of readdirSync(dir).filter((n) => n.endsWith('.segments.json'))) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const segs: any[] = Array.isArray(j) ? j : (j.segments ?? []);
  for (const s of segs) {
    total += 1;

    // A1 — duration runaway, exact re-derivation.
    const dur = s.qa?.durationSec;
    const exp = s.qa?.expectedSec;
    if (dur != null && exp != null && exp > 0) {
      const ratio = dur / exp;
      if (ratio > qt.maxDurationRatio) {
        durLongOld += 1;
        if (dur >= qt.minRunawaySec) durLongNew += 1;
      }
    }

    // A2 — only the drift verdicts (the re-records the fix targets).
    const asr = s.asr;
    if (!asr || asr.verdict !== 'drift') continue;
    asrDrift += 1;
    const reasons = reasonsOf(s);
    const { sub = 0, del = 0, ins = 0, wer = 0, longestDeletionRun = 0 } = asr;

    if (reasons.includes('loop/repeat') || reasons.includes('compression')) {
      compressionDrift += 1;
      continue; // real loop — survives
    }
    if (reasons.includes('truncation') || longestDeletionRun > at.maxDeletionRun) {
      truncationDrift += 1;
      continue; // real truncation — survives
    }
    // WER-only drift from here.
    const expectedLen = wer > 0 ? Math.round((sub + del + ins) / wer) : 0;
    if (expectedLen === 2 && del === 0 && ins === 0 && sub === 1) {
      a2bFlip += 1; // backstop → inconclusive
    } else if (ins >= 1 && del === 0) {
      a2aSplitCandidate += 1; // word-split shape → A2a likely clears
    } else {
      residualDrift += 1;
      if (residualSamples.length < 25) {
        residualSamples.push(
          `wer=${Number(wer).toFixed(2)} sub=${sub} del=${del} ins=${ins} len~${expectedLen} | "${String(
            asr.transcript ?? '',
          ).slice(0, 60)}"`,
        );
      }
    }
  }
}

console.log(`segments scanned:               ${total}`);
console.log('');
console.log('A1 duration "runaway" flags:');
console.log(`  old (ratio > ${qt.maxDurationRatio}):          ${durLongOld}`);
console.log(`  new (+ floor >= ${qt.minRunawaySec}s):        ${durLongNew}`);
console.log('');
console.log(`A2 ASR drift flags (total):     ${asrDrift}`);
console.log(`  compression/loop (real):      ${compressionDrift}`);
console.log(`  truncation/drop (real):       ${truncationDrift}`);
console.log(`  A2b single-sub 2-word → incon:${a2bFlip}`);
console.log(`  A2a word-split candidate:     ${a2aSplitCandidate}`);
console.log(`  residual drift (inspect):     ${residualDrift}`);
console.log('');
console.log('residual drift samples (should be real garble / name-split-1to3 / multi-error):');
for (const r of residualSamples) console.log('  ' + r);
