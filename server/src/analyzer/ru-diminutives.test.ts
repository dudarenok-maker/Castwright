import { describe, expect, it } from 'vitest';
import { diminutiveCanonical } from './ru-diminutives.js';

describe('diminutiveCanonical', () => {
  it('maps a diminutive and its canonical to the same base', () => {
    expect(diminutiveCanonical('Оля')?.base).toBe(diminutiveCanonical('Ольга')?.base);
  });
  it('flags multi-gender diminutives', () => {
    expect(diminutiveCanonical('Саша')?.multiGender).toBe(true);
    expect(diminutiveCanonical('Оля')?.multiGender).toBe(false);
  });
  it('returns null for an unknown name', () => {
    expect(diminutiveCanonical('Завулон')).toBeNull();
  });
});
