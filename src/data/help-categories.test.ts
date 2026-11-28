import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES } from './help-categories';
import { HELP_FAILURE_ENTRIES, type CategoryId } from './help-failures';
import { HELP_TOPICS } from './help-topics';

const IDS = new Set<CategoryId>(HELP_CATEGORIES.map((c) => c.id));

describe('help categories', () => {
  it('every failure entry has a category in HELP_CATEGORIES', () => {
    for (const e of HELP_FAILURE_ENTRIES) {
      expect(IDS.has(e.category), `${e.code} -> ${e.category}`).toBe(true);
    }
  });
  it('every topic has a category in HELP_CATEGORIES', () => {
    for (const t of HELP_TOPICS) {
      expect(IDS.has(t.category), `${t.id} -> ${t.category}`).toBe(true);
    }
  });
  it('every category id is unique and non-empty', () => {
    expect(IDS.size).toBe(HELP_CATEGORIES.length);
    expect(HELP_CATEGORIES.every((c) => c.label.length > 0)).toBe(true);
  });
  it('has exactly 56 items (29 failures + 27 topics)', () => {
    expect(HELP_FAILURE_ENTRIES.length + HELP_TOPICS.length).toBe(56);
  });
  it('includes the clone-your-own-voice topic under Voices & languages', () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'clone-your-own-voice');
    expect(topic?.category).toBe('voices');
    expect(topic?.body).toContain('Clone a voice');
  });
  it('does not tell a working Coqui install to press Repair (#4868 review)', () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'clone-your-own-voice');
    expect(topic?.body).not.toContain('Repair');
  });
  it('names the two clone-capable engines and says Kokoro and Gemini cannot clone', () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'clone-your-own-voice');
    expect(topic?.body).not.toContain('Both voice engines');
    expect(topic?.body).not.toContain('three voice engines');
    expect(topic?.body).toContain('Kokoro and Gemini voices can’t');
  });
  it('does not promise Revoke erases chapters already made with the clone', () => {
    const topic = HELP_TOPICS.find((t) => t.id === 'clone-your-own-voice');
    expect(topic?.body).not.toContain('everything made from it');
    expect(topic?.body).toContain('stay in that voice until you re-cast');
  });
});
