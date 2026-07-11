/* #1447 — strip a real third-party person named/quoted only in a non-story
   front-matter chapter (e.g. a critical-essay subject) from the roster, before
   foldMinorCast so the proseTagged carve-out (#537) never protects the bogus
   entry. Pure except for the injected `classifyNonStory` (Signal 2) escalation.

   A character is stripped only if ALL hold:
     (c) attributed in exactly one chapter, < minLines lines;
     Gate 0: that chapter is front-matter-suspicious — Signal-1 essay title OR
             positional front-region (index < frontRegion);
     (b) name + aliases appear in NO other chapter body (case-folded substring);
     (a) non-story confirmed — Signal 1 title, else Signal 2 classifier.
   Stripped characters' sentences re-route to narrator. */
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';
import { isNonStoryEssayTitle } from './non-story-essay-title.js';

const NARRATOR_ID = 'narrator';
const DEFAULT_MIN_LINES = 3;
const DEFAULT_FRONT_REGION = 5;
const MIN_NEEDLE_LEN = 3;

export interface ThirdPartyGuardChapter {
  id: number;
  title?: string;
  body: string;
}

export interface ThirdPartyGuardOptions {
  minLines?: number;
  frontRegion?: number;
  /** Signal 2. Injected so the core stays testable. Consulted at most once per
      chapter, only when Signal 1 did not classify it and Gate 0 + (b) + (c)
      held. Omitted → Signal-1-only (fully deterministic). */
  classifyNonStory?: (chapter: ThirdPartyGuardChapter) => Promise<boolean>;
}

export interface ThirdPartyGuardResult {
  characters: CharacterOutput[];
  sentences: SentenceOutput[];
  stripped: string[];
}

export async function stripThirdPartyFrontMatter(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  chapters: ThirdPartyGuardChapter[],
  opts: ThirdPartyGuardOptions = {},
): Promise<ThirdPartyGuardResult> {
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const frontRegion = opts.frontRegion ?? DEFAULT_FRONT_REGION;
  const classify = opts.classifyNonStory;

  const indexById = new Map<number, number>();
  const chapterById = new Map<number, ThirdPartyGuardChapter>();
  const foldedBodyById = new Map<number, string>();
  chapters.forEach((ch, i) => {
    indexById.set(ch.id, i);
    chapterById.set(ch.id, ch);
    foldedBodyById.set(ch.id, ch.body.toLocaleLowerCase());
  });

  const chaptersByChar = new Map<string, Set<number>>();
  const linesByChar = new Map<string, number>();
  for (const s of sentences) {
    linesByChar.set(s.characterId, (linesByChar.get(s.characterId) ?? 0) + 1);
    let set = chaptersByChar.get(s.characterId);
    if (!set) {
      set = new Set();
      chaptersByChar.set(s.characterId, set);
    }
    set.add(s.chapterId);
  }

  const nonStoryCache = new Map<number, boolean>();
  const strippedIds = new Set<string>();
  const strippedNames: string[] = [];

  for (const c of characters) {
    if (c.id === NARRATOR_ID) continue;

    // (c) single-chapter, low presence.
    const charChapters = chaptersByChar.get(c.id);
    if (!charChapters || charChapters.size !== 1) continue;
    if ((linesByChar.get(c.id) ?? 0) >= minLines) continue;
    const chapterId = [...charChapters][0];
    const index = indexById.get(chapterId);
    const chapter = chapterById.get(chapterId);
    if (index === undefined || !chapter) continue;

    // Gate 0: front-matter-suspicious chapter.
    const titleClassifies = isNonStoryEssayTitle(chapter.title);
    if (!titleClassifies && index >= frontRegion) continue;

    // (b) name + aliases absent from every OTHER chapter body.
    const needles = [c.name, ...(c.aliases ?? [])]
      .map((n) => n.trim().toLocaleLowerCase())
      .filter((n) => n.length >= MIN_NEEDLE_LEN);
    if (needles.length === 0) continue; // can't verify (b) for an unusable name → keep
    let foundElsewhere = false;
    for (const [chId, foldedBody] of foldedBodyById) {
      if (chId === chapterId) continue;
      if (needles.some((needle) => foldedBody.includes(needle))) {
        foundElsewhere = true;
        break;
      }
    }
    if (foundElsewhere) continue;

    // (a) confirm non-story: Signal 1, else Signal 2 (cached per chapter).
    let nonStory = titleClassifies;
    if (!nonStory && classify) {
      if (nonStoryCache.has(chapterId)) {
        nonStory = nonStoryCache.get(chapterId)!;
      } else {
        nonStory = await classify(chapter);
        nonStoryCache.set(chapterId, nonStory);
      }
    }
    if (!nonStory) continue;

    strippedIds.add(c.id);
    strippedNames.push(c.name);
  }

  if (strippedIds.size === 0) {
    return { characters, sentences, stripped: [] };
  }
  const keptCharacters = characters.filter((c) => !strippedIds.has(c.id));
  const reroutedSentences = sentences.map((s) =>
    strippedIds.has(s.characterId) ? { ...s, characterId: NARRATOR_ID } : s,
  );
  return { characters: keptCharacters, sentences: reroutedSentences, stripped: strippedNames };
}
