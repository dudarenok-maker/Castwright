import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBookByBookId, bookStateLanguage } from '../../workspace/scan.js';
import { getOrHydrateManuscript } from '../../store/manuscripts.js';
import { stripFrontMatterBoilerplate } from '../strip-front-matter.js';
import { manuscriptEditsJsonPath, castJsonPath } from '../../workspace/paths.js';
import { priorChapterIdFor } from '../../routes/script-review.js';
import { buildLabelledChapter, buildRosterSnapshot, buildSilverSkeleton } from './capture.js';

const DEFAULT_CORPUS_DIR = fileURLToPath(new URL('./corpus/', import.meta.url));

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function captureCorpus(opts: {
  bookId: string;
  chapters: number[];
  corpusDir?: string;
}): Promise<{ writtenFixtures: string[]; rosterPath: string }> {
  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS_DIR;
  await mkdir(corpusDir, { recursive: true });

  const book = await findBookByBookId(opts.bookId);
  if (!book) throw new Error(`No book found for bookId ${opts.bookId}`);
  const { bookDir, state } = book;
  const author = state.author;
  const title = state.title;
  const bookSlug = slug(title);
  const lang = bookStateLanguage(state); // e.g. 'en' / 'ru' — stamped into the fixture filename

  const edits = JSON.parse(await readFile(manuscriptEditsJsonPath(bookDir), 'utf8')) as {
    sentences: Array<{ id: number; chapterId: number; characterId: string; text: string }>;
  };
  const cast = JSON.parse(await readFile(castJsonPath(bookDir), 'utf8')) as {
    characters: Array<{ id: string; name?: string; gender?: 'male' | 'female' | 'neutral'; aliases?: string[] }>;
  };

  const record = await getOrHydrateManuscript(state.manuscriptId);
  if (!record) throw new Error(`Could not hydrate manuscript ${state.manuscriptId}`);

  const writtenFixtures: string[] = [];
  for (const chapterId of opts.chapters) {
    const hint = record.chapterHints.find((c) => c.id === chapterId);
    if (!hint) throw new Error(`Chapter ${chapterId} not found in manuscript ${state.manuscriptId}`);
    const chapterText = stripFrontMatterBoilerplate(hint.body, { author, title });
    const labelled = buildLabelledChapter(chapterText, edits.sentences, chapterId);
    const num = String(chapterId).padStart(2, '0');
    const path = join(corpusDir, `${bookSlug}-ch${num}.${lang}.labelled.json`);
    await writeFile(path, JSON.stringify(labelled, null, 2));
    writtenFixtures.push(path);
  }

  const rosterPath = join(corpusDir, `${bookSlug}.roster.json`);
  await writeFile(rosterPath, JSON.stringify(buildRosterSnapshot(cast.characters), null, 2));

  return { writtenFixtures, rosterPath };
}

/* Task 8 — silver capture: an untuned chapter's skeleton (current
   attribution seeded, not yet human-labelled) plus the prior chapter's
   captured boundary exchange, mirroring captureCorpus except for the
   `.silver.` filename infix and the extra prior-exchange lookup. Label
   corrections are authored afterwards by a human labelling pass — this
   never invents them. */
export async function captureSilverCorpus(opts: {
  bookId: string;
  chapters: number[];
  corpusDir?: string;
}): Promise<{ writtenFixtures: string[]; rosterPath: string }> {
  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS_DIR;
  await mkdir(corpusDir, { recursive: true });

  const book = await findBookByBookId(opts.bookId);
  if (!book) throw new Error(`No book found for bookId ${opts.bookId}`);
  const { bookDir, state } = book;
  const author = state.author;
  const title = state.title;
  const bookSlug = slug(title);
  const lang = bookStateLanguage(state);

  const edits = JSON.parse(await readFile(manuscriptEditsJsonPath(bookDir), 'utf8')) as {
    sentences: Array<{
      id: number;
      chapterId: number;
      characterId: string;
      text: string;
      excludeFromSynthesis?: boolean;
    }>;
  };
  const cast = JSON.parse(await readFile(castJsonPath(bookDir), 'utf8')) as {
    characters: Array<{ id: string; name?: string; gender?: 'male' | 'female' | 'neutral'; aliases?: string[] }>;
  };
  const roster = cast.characters.map((c) => ({ id: c.id, name: c.name ?? c.id }));

  const record = await getOrHydrateManuscript(state.manuscriptId);
  if (!record) throw new Error(`Could not hydrate manuscript ${state.manuscriptId}`);
  const allChapterIds = record.chapterHints.map((c) => c.id);

  const writtenFixtures: string[] = [];
  for (const chapterId of opts.chapters) {
    const hint = record.chapterHints.find((c) => c.id === chapterId);
    if (!hint) throw new Error(`Chapter ${chapterId} not found in manuscript ${state.manuscriptId}`);
    const chapterText = stripFrontMatterBoilerplate(hint.body, { author, title });
    const chapterSentences = edits.sentences
      .filter((sen) => sen.chapterId === chapterId)
      .sort((a, b) => a.id - b.id);

    // No exclusion tracking at capture time — the eval harness isn't wired to
    // the script-review ledger's excludeFromSynthesis-chapter bookkeeping, so
    // an empty excluded set just walks back to the immediately preceding
    // chapter id.
    const priorId = priorChapterIdFor(chapterId, allChapterIds, new Set());
    const priorChapterSentences =
      priorId !== null
        ? edits.sentences.filter((sen) => sen.chapterId === priorId).sort((a, b) => a.id - b.id)
        : undefined;

    const silver = buildSilverSkeleton(chapterText, chapterSentences, roster, priorChapterSentences);
    const num = String(chapterId).padStart(2, '0');
    const path = join(corpusDir, `${bookSlug}-ch${num}.${lang}.silver.labelled.json`);
    await writeFile(path, JSON.stringify(silver, null, 2));
    writtenFixtures.push(path);
  }

  const rosterPath = join(corpusDir, `${bookSlug}.roster.json`);
  await writeFile(rosterPath, JSON.stringify(buildRosterSnapshot(cast.characters), null, 2));

  return { writtenFixtures, rosterPath };
}

function parseArgs(argv: string[]): { bookId: string; chapters: number[]; silver: boolean } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bookId = get('--book');
  const chaptersRaw = get('--chapters');
  if (!bookId || !chaptersRaw) {
    throw new Error('Usage: capture-cli --book <bookId> --chapters 43,44,45,46 [--silver]');
  }
  const chapters = chaptersRaw.split(',').map((n) => Number(n.trim()));
  const silver = argv.includes('--silver');
  return { bookId, chapters, silver };
}

// Run only when invoked directly (not when imported by tests). Normalise both
// sides with resolve() — a bare string compare is Windows-brittle (drive-letter
// casing / slash direction), matching the repo precedent (build-companion-apk.mjs).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { bookId, chapters, silver } = parseArgs(process.argv.slice(2));
  const run = silver ? captureSilverCorpus({ bookId, chapters }) : captureCorpus({ bookId, chapters });
  run
    .then((r) => {
      console.log(`Wrote ${r.writtenFixtures.length} fixture(s) + roster:`);
      for (const f of r.writtenFixtures) console.log(`  ${f}`);
      console.log(`  ${r.rosterPath}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
