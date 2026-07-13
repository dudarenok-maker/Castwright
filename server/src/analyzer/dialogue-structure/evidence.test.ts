import { describe, expect, it } from 'vitest';
import { buildStructureEvidence, type EvidenceRosterChar } from './evidence.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

/* srv-59 Task 10 — buildStructureEvidence recomputes the dialogue-structure
   engine fresh at script-review time and projects it to a per-sentence
   annotation map, rendered ONLY where structure disagrees with the model's
   current attribution or the line is unanchored speech. All fixture text
   below is original, invented for this test — not copied from any book. */

const mkSentence = (id: number, characterId: string, text: string): SentenceOutput => ({
  id,
  chapterId: 1,
  characterId,
  text,
});

const RU_ROSTER: EvidenceRosterChar[] = [
  { id: 'anton', name: 'Антон', gender: 'male' },
  { id: 'marina', name: 'Марина', gender: 'female' },
];

describe('buildStructureEvidence', () => {
  it('(unsupported language) returns an empty map', () => {
    const body = '"Hello," Marlow said.';
    const sentences = [mkSentence(1, 'marlow', 'Hello')];
    // 'ja' now has a conventions table (fs-59 W3) — use a genuinely unsupported code.
    const out = buildStructureEvidence(body, sentences, [{ id: 'marlow', name: 'Marlow' }], 'xx');
    expect(out.size).toBe(0);
  });

  it('(RU dash tag mis-attribution) flags the sentence with tag→<CorrectName>', () => {
    const body = '— Да, — сказал Антон.\n— Хорошо, — ответила Марина.';
    const sentences = [
      mkSentence(1, 'marina', 'Да'), // wrong — structure ties this to Anton via the tag
      mkSentence(2, 'marina', 'Хорошо'), // correct — agrees with structure
    ];
    const out = buildStructureEvidence(body, sentences, RU_ROSTER, 'ru');
    expect(out.get(1)).toBe('[structure: speech, tag→Антон]');
    expect(out.has(2)).toBe(false); // agreement — not in the map (test 5)
  });

  it('(unanchored speech) flags a dash-dialogue line with no derivable speaker', () => {
    const body = '— Тишина.';
    const sentences = [mkSentence(1, 'anton', 'Тишина')];
    const out = buildStructureEvidence(body, sentences, RU_ROSTER, 'ru');
    expect(out.get(1)).toBe('[structure: speech, speaker unproven]');
  });

  it('(pure narration) flags a sentence the model attributed to a character but which is narration', () => {
    const body = 'Дождь стучал по крыше.';
    const sentences = [mkSentence(1, 'anton', 'Дождь стучал по крыше')];
    const out = buildStructureEvidence(body, sentences, RU_ROSTER, 'ru');
    expect(out.get(1)).toBe('[structure: narration]');
  });

  it('(agreement) a correctly-attributed dialogue line is NOT in the map', () => {
    const body = '"Ready," Marlow said.';
    const roster: EvidenceRosterChar[] = [{ id: 'marlow', name: 'Marlow' }];
    const sentences = [mkSentence(1, 'marlow', 'Ready')];
    const out = buildStructureEvidence(body, sentences, roster, 'en');
    expect(out.size).toBe(0);
  });

  it('(below floor) an alignedPct under 80 returns an empty map even though one sentence would otherwise flag', () => {
    const body = '— Да, — сказал Антон.';
    const sentences = [
      mkSentence(1, 'marina', 'Да'), // would align + mismatch if alone
      mkSentence(2, 'marina', 'zzz-unaligned-one'),
      mkSentence(3, 'marina', 'zzz-unaligned-two'),
      mkSentence(4, 'marina', 'zzz-unaligned-three'),
      mkSentence(5, 'marina', 'zzz-unaligned-four'),
    ];
    const out = buildStructureEvidence(body, sentences, RU_ROSTER, 'ru');
    expect(out.size).toBe(0);
  });
});
