import { describe, it, expect } from 'vitest';
import { isDescriptorName, descriptorGrammarFor } from './descriptor-grammar.js';

describe('isDescriptorName — English baseline (byte-identical, universal)', () => {
  it('folds the Unknown contract in any language', () => {
    expect(isDescriptorName('Unknown Jogger')).toBe(true);
    expect(isDescriptorName('Unknown Jogger', 'ru')).toBe(true);
    expect(isDescriptorName('Unknown Hombre', 'es')).toBe(true);
  });
  it('folds "The <1-2 words>" and trailing English role nouns (all langs)', () => {
    expect(isDescriptorName('The Jogger')).toBe(true);
    expect(isDescriptorName('The Council of Twelve')).toBe(false); // >2 words
    expect(isDescriptorName('Drooly Boy')).toBe(true);
    expect(isDescriptorName('The Jogger', 'de')).toBe(true); // English slip on a de book
  });
  it('does not fold a real proper name', () => {
    expect(isDescriptorName('Wren Sparrow')).toBe(false);
    expect(isDescriptorName('Theodore')).toBe(false);
  });
});

describe('isDescriptorName — ru extras (byte-identical to historical ru)', () => {
  it('folds a lone Russian generic noun', () => {
    expect(isDescriptorName('девушка', 'ru')).toBe(true);
    expect(isDescriptorName('оператор', 'ru')).toBe(true);
  });
  it('folds a Russian phrase carrying a function word', () => {
    expect(isDescriptorName('женщина с двумя овчарками', 'ru')).toBe(true);
  });
  it('does NOT fold a real Russian name or a 2-word noun phrase', () => {
    expect(isDescriptorName('Одуван', 'ru')).toBe(false);
    expect(isDescriptorName('Молодой парень', 'ru')).toBe(false); // bare rule needs 1 token
  });
});

describe('isDescriptorName — es/fr/de (new)', () => {
  it('folds article-led descriptors', () => {
    expect(isDescriptorName('El Hombre', 'es')).toBe(true);
    expect(isDescriptorName('Una Voz', 'es')).toBe(true);
    expect(isDescriptorName('Le Garçon', 'fr')).toBe(true);
    expect(isDescriptorName("L'Homme", 'fr')).toBe(true); // elision, single token
    expect(isDescriptorName('Der Mann', 'de')).toBe(true);
  });
  it('folds bare generic nouns', () => {
    expect(isDescriptorName('Desconocido', 'es')).toBe(true);
    expect(isDescriptorName('Mann', 'de')).toBe(true);
  });
  it('does NOT fold real names carrying nobiliary/patronymic particles (finding B)', () => {
    expect(isDescriptorName('María de la Cruz', 'es')).toBe(false);
    expect(isDescriptorName('Charles de Gaulle', 'fr')).toBe(false);
    expect(isDescriptorName('Otto von Bismarck', 'de')).toBe(false);
  });
});

describe('descriptorGrammarFor', () => {
  it('returns null for en and unmapped (baseline-only)', () => {
    expect(descriptorGrammarFor('en')).toBeNull();
    expect(descriptorGrammarFor('pt')).toBeNull();
    expect(descriptorGrammarFor(undefined)).toBeNull();
  });
  it('returns a row for es/ru/fr/de', () => {
    expect(descriptorGrammarFor('es')).not.toBeNull();
    expect(descriptorGrammarFor('ru-RU')).not.toBeNull(); // subtag-normalised
  });
});
