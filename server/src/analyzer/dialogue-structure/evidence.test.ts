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

  it('(#1768/#1774 absent-character phantom) never NAMES a character absent from the chapter — junk-alias tokens do not index', () => {
    // The ch41 defect: `melissa-edgley` (name "Mrs Edgley", alias "her mother")
    // was NAMED as the speaker across a cluster she never spoke in — the token
    // "her", tokenized out of that relational-descriptor alias, name-matched a
    // beat-gap ("…hat to her … frowned"), anchoring a WEAK tag-name to an absent
    // character. #1768 downgraded that weak phantom at the evidence layer; #1774
    // removes it at the ROOT — `buildNameIndex` no longer indexes lowercase
    // tokens of a multi-word alias, so "her" is never a name and no phantom forms.
    // Invented text, same mechanism: `mrs-fenn`'s alias "her mother".
    const roster: EvidenceRosterChar[] = [
      { id: 'nora', name: 'Nora', gender: 'female' },
      { id: 'sam', name: 'Sam', gender: 'male' },
      { id: 'mrs-fenn', name: 'Mrs Fenn', gender: 'female', aliases: ['her mother'] },
    ];
    const body = ['“Is he there?” Nora asked.', '“He is,” Sam said.', '“He’s gone.” He tipped his hat to her and she frowned.'].join('\n');
    const sentences = [
      mkSentence(1, 'nora', 'Is he there?'), // agrees with structure (Nora) → no annotation
      mkSentence(2, 'nora', 'He is'), // model wrong → structure redirects to the STRONG-anchored Sam
      mkSentence(3, 'sam', 'He’s gone'), // no phantom now: the beat-gap "her" is not a name
    ];
    const out = buildStructureEvidence(body, sentences, roster, 'en');
    // no annotation ever NAMES the absent character
    expect([...out.values()].some((v) => v.includes('Fenn'))).toBe(false);
    // a genuine strong-tag redirect is unaffected
    expect(out.get(2)).toBe('[structure: speech, tag→Sam]');
    // the phantom is gone at the root: structure fabricates nothing for line 3
    expect(out.has(3)).toBe(false);
  });

  it('(#1774 strong-anchor phantom) surfaces the CORRECT resolution the phantom was masking', () => {
    // Facet 1 of #1774: #1768's guard only neutralized phantoms whose anchors
    // were all WEAK (beat-gap). Here the junk "her mother" alias's "her" sits
    // before a SPEECH verb ("…in her hand, she said") — findSubjectName's
    // unguarded before-verb branch returned a STRONG (non-weak) tag-name for the
    // absent Mrs Fenn, which #1768 could NOT downgrade → it NAMED Mrs Fenn.
    // With "her" no longer indexed, the tag falls through to "she", which
    // correctly resolves to the only present female (Nora) — so #1774 converts a
    // WRONG name (Mrs Fenn) into the RIGHT one (Nora) the phantom had hidden.
    const roster: EvidenceRosterChar[] = [
      { id: 'nora', name: 'Nora', gender: 'female' },
      { id: 'sam', name: 'Sam', gender: 'male' },
      { id: 'mrs-fenn', name: 'Mrs Fenn', gender: 'female', aliases: ['her mother'] },
    ];
    const body = ['“Is he there?” Nora asked.', '“He is,” Sam said.', '“He’s gone.” The letter still in her hand, she said.'].join('\n');
    const sentences = [
      mkSentence(1, 'nora', 'Is he there?'),
      mkSentence(2, 'nora', 'He is'), // structure redirects to the strong-anchored Sam
      mkSentence(3, 'sam', 'He’s gone'), // pre-fix NAMED the strong phantom Mrs Fenn; now → Nora
    ];
    const out = buildStructureEvidence(body, sentences, roster, 'en');
    expect([...out.values()].some((v) => v.includes('Fenn'))).toBe(false);
    expect(out.get(2)).toBe('[structure: speech, tag→Sam]'); // genuine redirect intact
    expect(out.get(3)).toBe('[structure: speech, tag→Nora]'); // "she" → the only present female
  });

  it('(#1774 Facet 2, accepted) the #1768 guard still downgrades a genuine weak-only name anchor to unproven', () => {
    // Facet 2 (documented, accepted): a real speaker anchored ONLY by a weak
    // beat-gap tag ("Sarah frowned" — beat verb, never a speech verb + name) is
    // not in the strong set, so #1768's guard downgrades tag→Sarah to
    // "speaker unproven" — conservative (never a wrong name) but a real loss of
    // corrective specificity. This locks that surviving guard behavior; #1774's
    // root gate does not touch it (Sarah is a real, capitalized single-word name,
    // never gated). Refining this tradeoff is tracked as future work in plan 265.
    const roster: EvidenceRosterChar[] = [
      { id: 'tom', name: 'Tom', gender: 'male' },
      { id: 'sarah', name: 'Sarah', gender: 'female' },
    ];
    const body = ['“No,” Tom said.', '“Fine.” Sarah frowned.'].join('\n');
    const sentences = [
      mkSentence(1, 'tom', 'No'), // agrees with structure (Tom)
      mkSentence(2, 'tom', 'Fine'), // model wrong; structure's only anchor is the WEAK "Sarah frowned"
    ];
    const out = buildStructureEvidence(body, sentences, roster, 'en');
    expect([...out.values()].some((v) => v.includes('Sarah'))).toBe(false); // name suppressed, not fabricated
    expect(out.get(2)).toBe('[structure: speech, speaker unproven]'); // downgraded, still flagged as speech
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
