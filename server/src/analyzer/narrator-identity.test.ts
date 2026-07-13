import { describe, it, expect } from 'vitest';
import type { CharacterOutput } from '../handoff/schemas.js';
import { applyNarratorIdentity, FOLKLORIC_NARRATOR } from './narrator-identity.js';

function narrator(over: Partial<CharacterOutput> = {}): CharacterOutput {
  return { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', ...over };
}
function hero(over: Partial<CharacterOutput> = {}): CharacterOutput {
  return { id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza', ...over };
}

describe('applyNarratorIdentity', () => {
  it('localizes the narrator name per language; en stays Narrator', () => {
    expect(applyNarratorIdentity([narrator()], 'de')[0].name).toBe('Erzähler');
    expect(applyNarratorIdentity([narrator()], 'ru')[0].name).toBe('Рассказчик');
    expect(applyNarratorIdentity([narrator()], 'es')[0].name).toBe('Narrador');
    expect(applyNarratorIdentity([narrator()], 'fr')[0].name).toBe('Narrateur');
    expect(applyNarratorIdentity([narrator()], 'en')[0].name).toBe('Narrator');
  });

  it('adds the "Narrator" alias exactly once', () => {
    const once = applyNarratorIdentity([narrator()], 'de')[0];
    expect(once.aliases).toEqual(['Narrator']);
    const twice = applyNarratorIdentity(applyNarratorIdentity([narrator()], 'de'), 'de')[0];
    expect(twice.aliases).toEqual(['Narrator']);
  });

  it('seeds the folkloric voice identity when there is no voiceStyle', () => {
    const n = applyNarratorIdentity([narrator()], 'de')[0];
    expect(n.voiceStyle).toBe(FOLKLORIC_NARRATOR.voiceStyle);
    expect(n.gender).toBe('neutral');
    expect(n.ageRange).toBe('adult');
    expect(n.tone).toEqual({ warmth: 40, pace: 50, authority: 60, emotion: 40 });
    expect(n.attributes).toEqual(['formal', 'observational', 'measured', 'rhythmic']);
  });

  it('preserves id, color, description, and other characters', () => {
    const out = applyNarratorIdentity([narrator({ description: 'forge-warm' }), hero()], 'de');
    expect(out[0].id).toBe('narrator');
    expect(out[0].color).toBe('narrator');
    expect(out[0].description).toBe('forge-warm');
    expect(out[1]).toEqual(hero());
  });

  it('does NOT clobber a user rename, but still adds the alias', () => {
    const out = applyNarratorIdentity([narrator({ name: 'The Bard' })], 'de')[0];
    expect(out.name).toBe('The Bard');
    expect(out.aliases).toEqual(['Narrator']);
  });

  it('does NOT clobber an existing voiceStyle or its companion fields', () => {
    const out = applyNarratorIdentity(
      [narrator({ voiceStyle: 'a crisp young herald', gender: 'male', attributes: ['bright'] })],
      'de',
    )[0];
    expect(out.voiceStyle).toBe('a crisp young herald');
    expect(out.gender).toBe('male');
    expect(out.attributes).toEqual(['bright']);
    expect(out.name).toBe('Erzähler'); // name localization still applies
  });

  it('is idempotent', () => {
    const once = applyNarratorIdentity([narrator()], 'de');
    const twice = applyNarratorIdentity(once, 'de');
    expect(twice).toEqual(once);
  });

  it('is a no-op with no narrator, and falls back to Narrator for unknown language', () => {
    expect(applyNarratorIdentity([hero()], 'de')).toEqual([hero()]);
    expect(applyNarratorIdentity([narrator()], 'zz')[0].name).toBe('Narrator');
  });

  it('never mutates the input array or its objects', () => {
    const input = [narrator()];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyNarratorIdentity(input, 'de');
    expect(input).toEqual(snapshot);
  });
});
