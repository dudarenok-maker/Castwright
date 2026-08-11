import { describe, expect, it } from 'vitest';
import { measureChapterLegibility } from './legibility.js';
import { conventionsFor } from './lang/index.js';

const ru = conventionsFor('ru')!;
const en = conventionsFor('en')!;

describe('measureChapterLegibility', () => {
  it('returns undefined for a language with no paragraph-dash convention', () => {
    expect(measureChapterLegibility('"Hi," he said. "Bye," she said.', en)).toBeUndefined();
  });

  it('skips a properly-formed dialogue paragraph', () => {
    expect(measureChapterLegibility('- Привет. - Как дела? - Хорошо.', ru)).toBe(0);
  });

  it('counts merged turns inside a narration paragraph', () => {
    expect(measureChapterLegibility('Он кивнул. - Привет. - Как дела?', ru)).toBe(2);
  });

  it('counts a colon-introduced turn', () => {
    expect(measureChapterLegibility('Честно предупредил: - Водка не очень.', ru)).toBe(1);
  });

  it('does not count intra-word hyphens', () => {
    expect(measureChapterLegibility('Он был где-то рядом, серо-стальной и злой.', ru)).toBe(0);
  });

  it('does not count a dash followed by lowercase', () => {
    expect(measureChapterLegibility('Всё изменилось. - сказал он тихо.', ru)).toBe(0);
  });

  it('returns the MAXIMUM over paragraphs, never the sum', () => {
    const body = ['Он кивнул. - Привет.', 'Она встала. - Пока.', 'Он ушёл. - Ага.'].join('\n');
    expect(measureChapterLegibility(body, ru)).toBe(1);
  });

  it('keeps the narration-then-quoted-speech false positive far under the bar', () => {
    // Correct Russian typography, and it DOES match the pattern. The design
    // depends on it staying sparse (1-2), not on it being absent.
    const body = 'Они разгорелись. «Мне не нужен меч, — сказал он. — Все хотят моей смерти».';
    expect(measureChapterLegibility(body, ru)).toBeLessThanOrEqual(2);
  });

  it('finds the worst paragraph in a mixed chapter', () => {
    const body = ['Тихо было.', 'Он кивнул. - Раз. - Два. - Три.', '- Обычный диалог.'].join('\n');
    expect(measureChapterLegibility(body, ru)).toBe(3);
  });
});
