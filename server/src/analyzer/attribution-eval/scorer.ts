import type { LabelledChapter } from './schema.js';

export interface AttributionScore {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  segMismatch: number;
  precision: number;
  recall: number;
  perLine: Array<{ text: string; truth: string | null; predicted: string | null; correct: boolean }>;
}

/** Same normalisation `stage2-coverage.ts`'s `words()` uses, so smart quotes /
    spacing differences between the labelled fixture and a fresh analyzer run
    don't misalign the comparison. */
function words(text: string): string[] {
  return (text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalise(text: string): string {
  return words(text).join(' ');
}

function resolveId(id: string, aliasMap?: Map<string, string>): string {
  return aliasMap?.get(id) ?? id;
}

export function scoreAttribution(
  truth: LabelledChapter,
  predicted: Array<{ text: string; characterId: string }>,
  aliasMap?: Map<string, string>
): AttributionScore {
  // Group truth lines by normalised text into per-key FIFO queues, preserving
  // order — NOT a plain Map<normalisedText, speakerId>, which would collapse
  // repeated identical lines spoken by different speakers (last-write-wins).
  // Each occurrence carries its resolved id AND original text so the trailing
  // pure-miss reconciliation can emit a perLine row.
  const truthQueues = new Map<string, Array<{ id: string; text: string }>>();
  for (const line of truth.lines) {
    const key = normalise(line.text);
    const queue = truthQueues.get(key) ?? [];
    queue.push({ id: resolveId(line.speakerId, aliasMap), text: line.text });
    truthQueues.set(key, queue);
  }

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let segMismatch = 0;
  const perLine: AttributionScore['perLine'] = [];

  for (const line of predicted) {
    const key = normalise(line.text);
    const queue = truthQueues.get(key);
    const predictedId = resolveId(line.characterId, aliasMap);

    if (!queue || queue.length === 0) {
      // No remaining truth occurrence of this normalised text — segmentation
      // drift, not an attribution failure. Kept as a separate metric.
      segMismatch++;
      perLine.push({ text: line.text, truth: null, predicted: predictedId, correct: false });
      continue;
    }

    const truthId = queue.shift()!.id;
    if (truthId === predictedId) {
      truePositive++;
      perLine.push({ text: line.text, truth: truthId, predicted: predictedId, correct: true });
    } else {
      falsePositive++;
      falseNegative++;
      perLine.push({ text: line.text, truth: truthId, predicted: predictedId, correct: false });
    }
  }

  // Any truth occurrence never consumed by a predicted line is a pure miss —
  // the analyzer dropped the line entirely. Count it as an FN AND surface it in
  // perLine (predicted: null) so Task 1.3's report shows dropped CJK quotes.
  for (const queue of truthQueues.values()) {
    for (const occurrence of queue) {
      falseNegative++;
      perLine.push({ text: occurrence.text, truth: occurrence.id, predicted: null, correct: false });
    }
  }

  const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 1;
  const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 1;

  return { truePositive, falsePositive, falseNegative, segMismatch, precision, recall, perLine };
}
