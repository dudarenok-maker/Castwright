import { mergeCharacterFields } from './roster-merge-fields.js';
import type { CharacterOutput } from '../handoff/schemas.js';

const base = (over: Partial<CharacterOutput>): CharacterOutput => ({
  id: 'a',
  name: 'Anton',
  role: 'r',
  color: 'c',
  ...over,
} as CharacterOutput);

describe('mergeCharacterFields', () => {
  it('keeps the longer description and unions attributes', () => {
    const existing = base({ description: 'short', attributes: ['weary'] });
    mergeCharacterFields(existing, base({ description: 'a much longer description', attributes: ['weary', 'wry'] }));
    expect(existing.description).toBe('a much longer description');
    expect(existing.attributes).toEqual(['weary', 'wry']);
  });

  it('records a divergent incoming name as an alias, never the display name', () => {
    const existing = base({ name: 'Антон', aliases: [] });
    mergeCharacterFields(existing, base({ name: 'Антон Городецкий' }));
    expect(existing.name).toBe('Антон');
    expect(existing.aliases).toEqual(['Антон Городецкий']);
  });

  it('first detection wins for gender/ageRange; tone field-merges', () => {
    const existing = base({ gender: 'male', tone: { warmth: 30 } });
    mergeCharacterFields(existing, base({ gender: 'female', ageRange: 'adult', tone: { pace: 70 } }));
    expect(existing.gender).toBe('male');
    expect(existing.ageRange).toBe('adult');
    expect(existing.tone).toEqual({ warmth: 30, pace: 70 });
  });
});
