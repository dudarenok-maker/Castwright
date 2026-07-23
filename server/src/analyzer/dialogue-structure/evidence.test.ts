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

  it('(#1768 absent-character phantom) downgrades a tag→X hint to unproven when X has no strong name anchor, but keeps a genuine strong redirect', () => {
    // Reproduces the ch41 defect: `melissa-edgley` (name "Mrs Edgley", alias
    // "her mother") was NAMED as the speaker across a cluster she never spoke
    // in — the pronoun token "her" tokenized out of that alias name-matched a
    // beat-gap ("…hat to her … frowned"), anchoring a WEAK tag-name to a
    // character absent from the chapter. Invented text, same mechanism:
    // `mrs-fenn`'s alias "her mother" makes "her" a name stem.
    const roster: EvidenceRosterChar[] = [
      { id: 'nora', name: 'Nora', gender: 'female' },
      { id: 'sam', name: 'Sam', gender: 'male' },
      { id: 'mrs-fenn', name: 'Mrs Fenn', gender: 'female', aliases: ['her mother'] },
    ];
    const body = ['“Is he there?” Nora asked.', '“He is,” Sam said.', '“He’s gone.” He tipped his hat to her and she frowned.'].join('\n');
    const sentences = [
      mkSentence(1, 'nora', 'Is he there?'), // agrees with structure (Nora) → no annotation
      mkSentence(2, 'nora', 'He is'), // model wrong → structure redirects to the STRONG-anchored Sam
      mkSentence(3, 'sam', 'He’s gone'), // structure's only speaker here is the phantom Mrs Fenn (weak beat-gap "her")
    ];
    const out = buildStructureEvidence(body, sentences, roster, 'en');
    // no annotation ever NAMES the absent character
    expect([...out.values()].some((v) => v.includes('Fenn'))).toBe(false);
    // the phantom line is downgraded, not suppressed — still flags as speech
    expect(out.get(3)).toBe('[structure: speech, speaker unproven]');
    // a genuine strong-tag redirect is untouched by the guard
    expect(out.get(2)).toBe('[structure: speech, tag→Sam]');
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
