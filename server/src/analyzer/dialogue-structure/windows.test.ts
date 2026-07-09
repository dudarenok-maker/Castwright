import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { resolveWindows } from './windows.js';

const ru = conventionsFor('ru')!;
const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }], ru);
const speechOf = (paras: ReturnType<typeof parseChapterStructure>) =>
  paras.flatMap((p) => p.spans).filter((s) => s.kind === 'speech');

describe('resolveWindows — window grouping (rule a)', () => {
  it('a short narration paragraph does not break the window; a long one does', () => {
    const shortNarration = 'Она подождала.'; // < 200 chars
    const longNarration = 'x'.repeat(210); // >= 200 chars
    const body = [
      '— Раз, — сказал Антон.',
      shortNarration,
      '— Два, — сказала Ольга.',
      longNarration,
      '— Три, — сказал Антон.',
    ].join('\n');
    const paras = parseChapterStructure(body, idx);
    resolveWindows(paras, { anton: 'male', olga: 'female' }, null);
    const speech = speechOf(paras);
    expect(speech).toHaveLength(3);
    // short narration in between: same window, turnIndex keeps incrementing
    expect(speech[0].windowId).toBe(speech[1].windowId);
    expect(speech[0].turnIndex).toBe(0);
    expect(speech[1].turnIndex).toBe(1);
    // long narration: new window, turnIndex restarts
    expect(speech[2].windowId).not.toBe(speech[0].windowId);
    expect(speech[2].turnIndex).toBe(0);
  });
});

describe('resolveWindows — first-person pronoun (rule b)', () => {
  it('resolves a first-person pendingPronoun to firstPersonId; stays unanchored when firstPersonId is null', () => {
    const paras = parseChapterStructure('— Привет, — ответил я.', idx);
    resolveWindows(paras, {}, 'vasya');
    const speech = speechOf(paras);
    expect(speech[0].speaker).toEqual({ characterId: 'vasya', source: 'tag-pronoun' });

    const parasNoFirstPerson = parseChapterStructure('— Привет, — ответил я.', idx);
    resolveWindows(parasNoFirstPerson, {}, null);
    const speechNoFirstPerson = speechOf(parasNoFirstPerson);
    expect(speechNoFirstPerson[0].speaker).toBeUndefined();
  });
});

describe('resolveWindows — gendered pronoun (rule c)', () => {
  it('resolves a gendered pendingPronoun only when exactly one participant of that gender is in the window', () => {
    // unique female participant (Ольга) -> resolves, even with a male participant also present
    const uniqueBody = ['— Раз, — сказал Антон.', '— Два, — сказала Ольга.', '— Три, — ответила она.'].join('\n');
    const uniqueParas = parseChapterStructure(uniqueBody, idx);
    resolveWindows(uniqueParas, { anton: 'male', olga: 'female' }, null);
    const uniqueSpeech = speechOf(uniqueParas);
    expect(uniqueSpeech[2].speaker).toEqual({ characterId: 'olga', source: 'tag-pronoun' });

    // two female participants (Ольга, Мария) -> ambiguous, stays unanchored.
    // A third named speaker (Антон) is included so the window has 3 anchored
    // participants -- keeping alternation (rule d) out of scope, so this
    // isolates the gendered-pronoun ambiguity itself rather than incidentally
    // getting resolved by a two-party parity fill.
    const ambigIdx = buildNameIndex(
      [{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }, { id: 'maria', name: 'Мария' }],
      ru,
    );
    const ambigBody = [
      '— Раз, — сказал Антон.',
      '— Два, — сказала Ольга.',
      '— Три, — сказала Мария.',
      '— Четыре, — ответила она.',
    ].join('\n');
    const ambigParas = parseChapterStructure(ambigBody, ambigIdx);
    resolveWindows(ambigParas, { anton: 'male', olga: 'female', maria: 'female' }, null);
    const ambigSpeech = speechOf(ambigParas);
    expect(ambigSpeech[3].speaker).toBeUndefined();
  });
});

describe('resolveWindows — alternation fill (rule d)', () => {
  it('fills unanchored turns by parity in a clean two-party window', () => {
    const body = '— Раз, — сказал Антон.\n— Два.\n— Три.\n— Четыре, — сказала Ольга.';
    const paras = parseChapterStructure(body, idx);
    resolveWindows(paras, { anton: 'male', olga: 'female' }, null);
    const speech = speechOf(paras);
    expect(speech.map((s) => s.speaker?.characterId)).toEqual(['anton', 'olga', 'anton', 'olga']);
    expect(speech[1].speaker?.source).toBe('alternation');
    expect(speech[2].speaker?.source).toBe('alternation');
    // pre-existing tag-name anchors are never overwritten
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[3].speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
  });
});

describe('resolveWindows — parity conflict (rule e)', () => {
  it('leaves unanchored turns unanchored when an anchored turn disagrees with the alternation parity', () => {
    // turn0=anton(even), turn2=olga(even, conflicts with turn0's even=anton),
    // turn3=anton(odd, conflicts with the even/odd split too) -> never guess turn1
    const body = [
      '— Раз, — сказал Антон.',
      '— Два.',
      '— Три, — сказала Ольга.',
      '— Четыре, — сказал Антон.',
    ].join('\n');
    const paras = parseChapterStructure(body, idx);
    resolveWindows(paras, { anton: 'male', olga: 'female' }, null);
    const speech = speechOf(paras);
    expect(speech[1].speaker).toBeUndefined();
    // originally-anchored turns are untouched
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[2].speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
    expect(speech[3].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
  });
});

describe('resolveWindows — third-voice pronoun evidence aborts alternation (rule g)', () => {
  it('an unresolved pronoun incompatible with both anchored participants signals a hidden third voice: aborts the whole window fill (CRITICAL regression)', () => {
    // anton + viktor are both male; the "она" (female) pronoun on turn1 can't
    // be either of them, so it's evidence of a hidden third (female) voice.
    // The window must NOT be treated as clean two-party: turn1 stays
    // unanchored (ambiguous pronoun, as before) AND turn2 must ALSO stay
    // unanchored, because alternation fill is aborted for the whole window
    // rather than fabricating a gender-incompatible speaker for turn1/turn2.
    const twoMaleIdx = buildNameIndex(
      [{ id: 'anton', name: 'Антон' }, { id: 'viktor', name: 'Виктор' }],
      ru,
    );
    const body = [
      '— Раз, — сказал Антон.',
      '— Два, — ответила она.',
      '— Три.',
      '— Четыре, — сказал Виктор.',
    ].join('\n');
    const paras = parseChapterStructure(body, twoMaleIdx);
    resolveWindows(paras, { anton: 'male', viktor: 'male' }, null);
    const speech = speechOf(paras);
    expect(speech[1].speaker).toBeUndefined();
    expect(speech[2].speaker).toBeUndefined();
    // originally-anchored turns are untouched
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[3].speaker).toEqual({ characterId: 'viktor', source: 'tag-name' });
  });

  it('an unresolved pronoun compatible with (matching) both anchored participants is NOT third-voice evidence: alternation still fills it', () => {
    // "он" (male) is ambiguous between anton and viktor (both male) so the
    // gendered-pronoun pass (rule c) leaves it unresolved -- but because it's
    // COMPATIBLE with the anchored participants (not contradicting either),
    // it is not evidence of a hidden third voice, so alternation (rule d)
    // still fills it by parity. This locks the chosen behavior: "matches
    // both" (ambiguous-but-compatible) is treated differently from "matches
    // neither" (incompatible/third-voice) in the third-voice check.
    const twoMaleIdx = buildNameIndex(
      [{ id: 'anton', name: 'Антон' }, { id: 'viktor', name: 'Виктор' }],
      ru,
    );
    const body = [
      '— Раз, — сказал Антон.',
      '— Два, — ответил он.',
      '— Три.',
      '— Четыре, — сказал Виктор.',
    ].join('\n');
    const paras = parseChapterStructure(body, twoMaleIdx);
    resolveWindows(paras, { anton: 'male', viktor: 'male' }, null);
    const speech = speechOf(paras);
    expect(speech.map((s) => s.speaker?.characterId)).toEqual(['anton', 'viktor', 'anton', 'viktor']);
    expect(speech[1].speaker?.source).toBe('alternation');
    expect(speech[2].speaker?.source).toBe('alternation');
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[3].speaker).toEqual({ characterId: 'viktor', source: 'tag-name' });
  });
});

describe('resolveWindows — three+ participants (rule f)', () => {
  it('never fills by alternation once a window has three or more distinct anchored speakers', () => {
    const triIdx = buildNameIndex(
      [{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }, { id: 'viktor', name: 'Виктор' }],
      ru,
    );
    const body = [
      '— Раз, — сказал Антон.',
      '— Два.',
      '— Три, — сказала Ольга.',
      '— Четыре, — сказал Виктор.',
    ].join('\n');
    const paras = parseChapterStructure(body, triIdx);
    resolveWindows(paras, { anton: 'male', olga: 'female', viktor: 'male' }, null);
    const speech = speechOf(paras);
    expect(speech[1].speaker).toBeUndefined();
  });
});
