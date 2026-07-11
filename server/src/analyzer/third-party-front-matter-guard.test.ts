import { describe, it, expect, vi } from 'vitest';
import { stripThirdPartyFrontMatter, type ThirdPartyGuardChapter } from './third-party-front-matter-guard.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

const narrator: CharacterOutput = { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', gender: 'neutral', aliases: [] };
const char = (id: string, name: string, aliases: string[] = []): CharacterOutput =>
  ({ id, name, role: 'speaker', color: 'peach', gender: 'male', aliases });
const line = (id: number, chapterId: number, characterId: string): SentenceOutput =>
  ({ id, chapterId, characterId, text: 'x' });

// ch0 = essay (title classifies); ch1..ch5 = story chapters
const essayCh: ThirdPartyGuardChapter = { id: 0, title: 'Вступительная статья', body: 'Радий Погодин был писателем.' };
const storyCh = (id: number, body: string): ThirdPartyGuardChapter => ({ id, title: `Глава ${id}`, body });

describe('stripThirdPartyFrontMatter', () => {
  it('strips via Signal 1 (essay title), re-routes sentences to narrator', async () => {
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin'), line(2, 0, 'narrator')];
    const chapters = [essayCh, storyCh(1, 'Обычная проза без имени.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual(['Радий Погодин']);
    expect(r.characters.find((c) => c.id === 'pogodin')).toBeUndefined();
    expect(r.sentences.find((s) => s.id === 1)!.characterId).toBe('narrator');
  });

  it('strips via Signal 2 when title does not classify but chapter is front-region', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('x', 'Иван Эссеист')];
    const sents = [line(1, 2, 'x')];
    const chapters = [storyCh(0, 'a'), storyCh(1, 'b'), { id: 2, title: 'Предисловие редактора', body: 'Иван Эссеист.' }];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).toHaveBeenCalledTimes(1);
    expect(r.stripped).toEqual(['Иван Эссеист']);
  });

  it('does NOT consult Signal 2 when Signal 1 already classifies', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin')];
    const r = await stripThirdPartyFrontMatter(chars, sents, [essayCh, storyCh(1, 'проза')], { classifyNonStory });
    expect(classifyNonStory).not.toHaveBeenCalled();
    expect(r.stripped).toEqual(['Радий Погодин']);
  });

  it('does NOT consider a walk-on in a deep story chapter (Gate 0 blocks it)', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('barkeep', 'Bob')];
    // Bob speaks once in chapter index 9 (>= frontRegion 5), title not essay.
    const chapters = Array.from({ length: 10 }, (_, i) => storyCh(i, i === 9 ? 'Bob said hi.' : 'prose'));
    const sents = [line(1, 9, 'barkeep')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).not.toHaveBeenCalled();
    expect(r.characters.find((c) => c.id === 'barkeep')).toBeDefined();
    expect(r.stripped).toEqual([]);
  });

  it('keeps a front-region story character when Signal 2 says no (framed/walk-on safe)', async () => {
    const classifyNonStory = vi.fn(async () => false);
    const chars = [narrator, char('letter', 'Framed Voice')];
    const sents = [line(1, 1, 'letter')];
    const chapters = [storyCh(0, 'a'), { id: 1, title: 'Глава 1', body: 'Framed Voice speaks.' }];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).toHaveBeenCalledTimes(1);
    expect(r.stripped).toEqual([]);
    expect(r.sentences).toBe(sents); // no-op identity
  });

  it('keeps a character whose full name appears in another chapter body (condition b), Cyrillic', async () => {
    // Body must contain the FULL needle ('Радий Погодин') — the algorithm uses
    // whole-name substring, so a first-name-only mention would MISS (spec Risk #1).
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin')];
    const chapters = [essayCh, storyCh(1, 'Позже Радий Погодин вернулся домой.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual([]);
    expect(r.characters).toBe(chars); // no-op identity
  });

  it('keeps a character matched elsewhere via an alias needle (condition b)', async () => {
    // Alias 'Радий' lets a first-name-only mention elsewhere match and KEEP —
    // documents that alias completeness widens the (b) safety net.
    const chars = [narrator, char('pogodin', 'Радий Погодин', ['Радий'])];
    const sents = [line(1, 0, 'pogodin')];
    const chapters = [essayCh, storyCh(1, 'Позже Радий вернулся домой.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual([]);
  });

  it('keeps a third party quoted >= minLines in the essay (c ceiling)', async () => {
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin'), line(2, 0, 'pogodin'), line(3, 0, 'pogodin')];
    const r = await stripThirdPartyFrontMatter(chars, sents, [essayCh, storyCh(1, 'проза')], { minLines: 3 });
    expect(r.stripped).toEqual([]);
  });

  it('is a no-op (same references) when nothing qualifies and runs Signal-1-only with no classifier', async () => {
    const chars = [narrator, char('hero', 'Hero')];
    const sents = [line(1, 1, 'hero')];
    const chapters = [storyCh(0, 'a'), storyCh(1, 'Hero prose')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.characters).toBe(chars);
    expect(r.sentences).toBe(sents);
    expect(r.stripped).toEqual([]);
  });
});
