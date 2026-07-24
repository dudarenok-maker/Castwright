import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './run-eval-cli.js';

/** Mirror of scorer.ts's private `words()` — the SAME normalisation the scorer
    uses to align a predicted sentence to a truth line. Kept as a local copy so
    this test can assert token-completeness without widening scorer.ts's API. */
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

const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

// The committed non-English gold guardrails added for srv-64 (#1759). Each one
// hand-labels Chapter One of the Castwright-owned Coalfall — the same chapter
// the EN guardrail labels — so the language-safe stage-2 rules block is measured
// on Russian (« » guillemets, em-dash internal attribution) and German („…"
// quotes, the #1598 U+201C-collision case), not just English.
const NON_EN = ['coalfall-ru-ch1.ru.labelled.json', 'coalfall-de-ch1.de.labelled.json'];

describe('committed non-English attribution-eval fixtures (srv-64)', () => {
  it('discovers both RU/DE fixtures as gold-tier with the right language', async () => {
    const items = await loadCorpus(FIXTURES_DIR);
    const byName = new Map(items.map((i) => [i.name, i]));
    for (const name of NON_EN) {
      const it = byName.get(name);
      expect(it, `${name} should be discovered`).toBeDefined();
      expect(it!.tier).toBe('gold');
      expect(it!.chapterId).toBe(1);
      expect(name).toContain(`.${it!.lang}.`);
    }
  });

  it('resolves every truth speakerId against the fixture roster', async () => {
    const items = await loadCorpus(FIXTURES_DIR);
    for (const name of NON_EN) {
      const item = items.find((i) => i.name === name)!;
      const rosterIds = new Set(item.roster.characters.map((c) => c.id));
      const unknown = item.truth.lines
        .map((l) => l.speakerId)
        .filter((id) => !rosterIds.has(id));
      expect(unknown, `${name} has off-roster speakerIds: ${unknown.join(', ')}`).toEqual([]);
    }
  });

  it('keeps the truth lines token-complete against chapterText (no dropped/added words)', async () => {
    const items = await loadCorpus(FIXTURES_DIR);
    for (const name of NON_EN) {
      const item = items.find((i) => i.name === name)!;
      const chapTokens = words(item.truth.chapterText);
      const lineTokens = item.truth.lines.flatMap((l) => words(l.text));
      expect(lineTokens, `${name} line tokens must equal chapterText tokens in order`).toEqual(
        chapTokens,
      );
    }
  });
});
