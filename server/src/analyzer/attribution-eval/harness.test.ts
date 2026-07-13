/* fs-59 Wave 1, Task 1.3 — English proving fixture + end-to-end harness test.

   Loads the hand-labelled Chapter One fixture (Task 1.1's schema), feeds the
   scorer (Task 1.2) both a correct and a deliberately-wrong predicted set, and
   pins the interrupted-quote hard case (spoken—tag—spoken) explicitly. This
   harness is language-agnostic: it only exercises `parseLabelledChapter` +
   `scoreAttribution`, so the same shape is reusable for es/fr/de/zh/ja
   fixtures without any change to this file. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseLabelledChapter } from './schema.js';
import { scoreAttribution } from './scorer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'coalfall-ch1.en.labelled.json');

function loadFixture() {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return parseLabelledChapter(JSON.parse(raw));
}

describe('attribution-eval harness — coalfall-ch1.en.labelled.json', () => {
  it('parses cleanly via parseLabelledChapter (proves 1.1 + the fixture are valid)', () => {
    const truth = loadFixture();
    expect(truth.lines.length).toBeGreaterThan(50);
    expect(truth.chapterText.length).toBeGreaterThan(0);
  });

  it('the "If I douse the fire" interrupted quote (spoken—tag—spoken) is split into two lines, both attributed to oduvan', () => {
    const truth = loadFixture();
    const firstHalf = truth.lines.find((l) => l.text === '"If I douse the fire,"');
    const secondHalf = truth.lines.find((l) =>
      l.text.startsWith('"I lose the weld I\'ve been nursing since noon.'),
    );
    expect(firstHalf).toBeDefined();
    expect(secondHalf).toBeDefined();
    expect(firstHalf!.speakerId).toBe('oduvan');
    expect(secondHalf!.speakerId).toBe('oduvan');
    // The narration tag between the two spoken halves stays with the narrator,
    // not the speaker — this is the exact hard case the scorer must not conflate.
    const tag = truth.lines.find((l) => l.text === 'Oduvan said,');
    expect(tag).toBeDefined();
    expect(tag!.speakerId).toBe('narrator');
  });

  it('a correct predicted set scores precision=1, recall=1, zero FP/FN/segMismatch', () => {
    const truth = loadFixture();
    const predictedCorrect = truth.lines.map((l) => ({ text: l.text, characterId: l.speakerId }));

    const score = scoreAttribution(truth, predictedCorrect);

    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.falsePositive).toBe(0);
    expect(score.falseNegative).toBe(0);
    expect(score.segMismatch).toBe(0);
    expect(score.truePositive).toBe(truth.lines.length);
  });

  it('mis-attributing exactly 3 lines reports exactly 3 FP and 3 FN, with degraded precision/recall', () => {
    const truth = loadFixture();
    const predictedCorrect = truth.lines.map((l) => ({ text: l.text, characterId: l.speakerId }));

    // Flip 3 real speaker attributions to a DIFFERENT valid speaker each —
    // none of these three are part of the interrupted-quote pair above.
    const wrongIndex = {
      '"It might be a customer."': 'oduvan', // truth: wren
      '"A real one?"': 'maerin', // truth: wren
      '"Modesty, or a sales tactic?"': 'oduvan', // truth: dragon
    };
    let flipped = 0;
    const predictedWrong = predictedCorrect.map((line) => {
      const wrongId = wrongIndex[line.text as keyof typeof wrongIndex];
      if (wrongId) {
        flipped++;
        return { ...line, characterId: wrongId };
      }
      return line;
    });
    expect(flipped).toBe(3); // sanity: all 3 target lines were found in the fixture

    const score = scoreAttribution(truth, predictedWrong);

    expect(score.falsePositive).toBe(3);
    expect(score.falseNegative).toBe(3);
    expect(score.segMismatch).toBe(0);
    expect(score.truePositive).toBe(truth.lines.length - 3);
    expect(score.precision).toBeLessThan(1);
    expect(score.recall).toBeLessThan(1);
    expect(score.precision).toBeCloseTo((truth.lines.length - 3) / truth.lines.length, 5);
    expect(score.recall).toBeCloseTo((truth.lines.length - 3) / truth.lines.length, 5);
  });
});
