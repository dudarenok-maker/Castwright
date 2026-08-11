/* Tests for scripts/repair-missing-book-language.mts

   Run directly with: server/node_modules/.bin/tsx --test scripts/tests/repair-missing-book-language.inner.test.mts
   (picked up transitively by scripts/tests/repair-missing-book-language.test.mjs,
   which node --test / npm run test:hooks actually runs — see that file for why
   this one is split out: it imports the REAL server/src/tts/detect-language.ts
   and server/src/workspace/state-migrate.ts, whose module graph uses `.js`
   specifiers for sibling `.ts` files. Plain `node --test` can't resolve that
   without a TS-aware loader; tsx can. Node's built-in type-stripping isn't
   enough either — it strips the file you name directly, but doesn't remap a
   `.js` import specifier to a sibling `.ts` file, so a transitive import inside
   detect-language.ts still 404s under plain node.)

   Covers planBookLanguage (the pure decision function — no I/O, calls the REAL
   detectManuscriptLanguage) and main() (the I/O shell) against a temp
   workspace. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { planBookLanguage, cacheSampleText, main } from '../repair-missing-book-language.mts';
import { cachePath } from '../../server/src/store/analysis-cache.js';
import { detectManuscriptLanguage } from '../../server/src/tts/detect-language.js';

// ---------------------------------------------------------------------------
// planBookLanguage — pure function tests. Real prose so the REAL
// detectManuscriptLanguage genuinely decides (not a stub).
// ---------------------------------------------------------------------------

const REAL_ENGLISH_PROSE =
  'The lighthouse keeper climbed the spiral staircase every evening before dusk, ' +
  'counting each worn stone step the way his father had taught him decades ago. ' +
  'Below, the harbor lights flickered awake one by one as fishing boats returned ' +
  'home ahead of the coming storm, their captains calling out familiar greetings ' +
  'across the darkening water while gulls wheeled overhead in search of scraps.';

// Real Russian prose. Deterministic via detect-language.ts's Cyrillic-ratio
// SCRIPT PRE-PASS (not franc), same determinism rationale as NO_LETTERS_TEXT
// below — no dependency on franc's fuzzy Latin disambiguation.
const REAL_RUSSIAN_PROSE =
  'Смотритель маяка поднимался по винтовой лестнице каждый вечер перед закатом, ' +
  'пересчитывая каждую истёртую каменную ступень так же, как учил его отец много ' +
  'лет назад. Внизу постепенно загорались огни гавани, а рыбацкие лодки одна за ' +
  'другой возвращались домой перед надвигающимся штормом, и капитаны перекликались ' +
  'знакомыми приветствиями над потемневшей водой, пока чайки кружили в поисках ' +
  'объедков.';

// Zero \p{L} letters — trips the detect-language.ts `letters === 0` surrender
// branch deterministically (no dependency on franc's fuzzy behaviour).
const NO_LETTERS_TEXT = '12345 000 --- !!! ??? 000000 111 222 333 444 555 666 777 888';

test('planBookLanguage: book already has a language key → untouched, reported as-is', () => {
  const plan = planBookLanguage({
    bookId: 'book-a',
    hasLanguageKey: true,
    existingLanguage: 'ru',
    cacheText: null,
    manuscriptText: null,
  });
  assert.deepEqual(plan, { bookId: 'book-a', action: 'has-language', existingLanguage: 'ru' });
});

test('planBookLanguage: no language key, confident detection → backfill', () => {
  const plan = planBookLanguage({
    bookId: 'book-b',
    hasLanguageKey: false,
    cacheText: REAL_ENGLISH_PROSE,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
  assert.equal(plan.sampleSource, 'analysis-cache');
});

test('planBookLanguage: no language key, detection surrenders → NOT backfilled, reported', () => {
  const plan = planBookLanguage({
    bookId: 'book-c',
    hasLanguageKey: false,
    cacheText: NO_LETTERS_TEXT,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'skip-fallback');
  assert.match(plan.reason, /surrendered/);
});

test('planBookLanguage: no cache, falls back to manuscript text, confident detection → backfill', () => {
  const plan = planBookLanguage({
    bookId: 'book-d',
    hasLanguageKey: false,
    cacheText: null,
    manuscriptText: REAL_ENGLISH_PROSE,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
  assert.equal(plan.sampleSource, 'manuscript');
});

test('planBookLanguage: cache preferred over manuscript text when both present', () => {
  const plan = planBookLanguage({
    bookId: 'book-e',
    hasLanguageKey: false,
    cacheText: REAL_ENGLISH_PROSE,
    manuscriptText: NO_LETTERS_TEXT,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.sampleSource, 'analysis-cache');
});

test('planBookLanguage: no cache and no manuscript text → skipped, reported', () => {
  const plan = planBookLanguage({
    bookId: 'book-f',
    hasLanguageKey: false,
    cacheText: null,
    manuscriptText: null,
  });
  assert.deepEqual(plan, {
    bookId: 'book-f',
    action: 'skip-no-text',
    reason: 'no analysis-cache sentence text and no readable manuscript file',
  });
});

test('planBookLanguage: whitespace-only cache/manuscript text counts as no text', () => {
  const plan = planBookLanguage({
    bookId: 'book-g',
    hasLanguageKey: false,
    cacheText: '   \n  ',
    manuscriptText: '  ',
  });
  assert.equal(plan.action, 'skip-no-text');
});

// ---------------------------------------------------------------------------
// cacheSampleText — #2246 C2. Previously ZERO test coverage (every main()
// fixture used a random manuscriptId, so cacheText was always null). Writes
// directly to the REAL cache path (cachePath is deterministic on
// manuscriptId, same trick main()'s own tests below use), cleaned up after.
// ---------------------------------------------------------------------------

// A real e-library boilerplate line matching strip-front-matter.ts's
// unanchored `одобрен к распространению` global pattern.
const BOILERPLATE_LINE_RU = 'Настоящая книга одобрен к распространению.';

test('cacheSampleText: joins sentences with a newline, not a space (#2246 C2 fix)', async () => {
  const manuscriptId = `mns_${randomUUID()}`;
  const path = cachePath(manuscriptId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      chapters: {
        0: [
          { text: BOILERPLATE_LINE_RU, speakerId: 'narrator' },
          { text: REAL_RUSSIAN_PROSE, speakerId: 'narrator' },
        ],
      },
    }),
  );
  try {
    const sample = await cacheSampleText(manuscriptId);
    assert.ok(sample, 'cacheSampleText must return the joined text');
    assert.ok(sample.includes('\n'), 'sentences must be newline-joined, not collapsed onto one line');

    // The actual regression this join fixes: stripFrontMatterBoilerplate is
    // LINE-based. Joined with '\n', only the boilerplate LINE is dropped —
    // the Russian prose line survives and still detects confidently. Before
    // the fix (join(' ')), the whole sample collapses onto one line, that
    // one line matches the boilerplate pattern, and the ENTIRE sample —
    // prose included — is dropped, leaving nothing to detect from.
    const detection = detectManuscriptLanguage(sample);
    assert.equal(detection.fallback, false, 'boilerplate + prose must still detect confidently, not surrender');
    assert.equal(detection.language, 'ru');
  } finally {
    rmSync(path, { force: true });
  }
});

test('cacheSampleText: returns null when the book has no cache at all', async () => {
  const manuscriptId = `mns_${randomUUID()}`; // never written — no cache file exists
  const sample = await cacheSampleText(manuscriptId);
  assert.equal(sample, null);
});

// ---------------------------------------------------------------------------
// main() — integration against a temp workspace. Every fixture book gets a
// fresh random manuscriptId so it can never collide with a real entry in
// server/handoff/cache/ — that keeps "no cache" naturally true without
// touching (or needing to clean up) the real cache directory.
// ---------------------------------------------------------------------------

function makeBook(booksRoot, relPath, state) {
  const bookDir = join(booksRoot, relPath);
  const audiobookDir = join(bookDir, '.audiobook');
  mkdirSync(audiobookDir, { recursive: true });
  writeFileSync(join(audiobookDir, 'state.json'), JSON.stringify(state, null, 2));
  return { bookDir, statePath: join(audiobookDir, 'state.json') };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

test('main: book with an explicit language is left untouched', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-has-lang-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Has Language'), {
      bookId: 'author__series__has-language',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Has Language',
      author: 'Author',
      language: 'ru',
    });

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'ru', 'explicit language must never be overwritten');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: no language key + readable manuscript file + confident detection → --apply backfills', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-backfill-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'No Language'), {
      bookId: 'author__series__no-language',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'No Language',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
      narratorCredit: 'Castwright',
    });
    writeFileSync(join(bookDir, 'manuscript.md'), `# No Language\n\n${REAL_ENGLISH_PROSE}\n`);

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'en');
    // Every other field is preserved (spread, never reconstructed).
    assert.equal(written.narratorCredit, 'Castwright');
    assert.equal(written.title, 'No Language');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: detection surrenders → --apply does NOT write, book stays without a language key', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-surrender-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'Surrenders'), {
      bookId: 'author__series__surrenders',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Surrenders',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
    });
    writeFileSync(join(bookDir, 'manuscript.md'), `# Surrenders\n\n${NO_LETTERS_TEXT}\n`);

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(written, 'language'),
      'a surrendered (guessed) detection must NEVER be written',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: no manuscript file and no cache → skipped, book stays without a language key', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-no-text-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'No Text'), {
      bookId: 'author__series__no-text',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'No Text',
      author: 'Author',
      manuscriptFile: 'manuscript.md', // never written to disk — unreadable
    });

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.ok(!Object.prototype.hasOwnProperty.call(written, 'language'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #2246 C3 — one corrupt state.json must not abort the whole run.
// ---------------------------------------------------------------------------

test('main: a corrupt state.json (unparsable, no valid backup) is skipped as unreadable — the run continues past it (#2246 C3)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-corrupt-'));
  try {
    const booksRoot = join(tmp, 'books');
    // The corrupt book: state.json is not valid JSON, and there's no
    // .bak.N to recover from, so readStateJsonWithRecovery re-throws.
    const corruptBookDir = join(booksRoot, 'Author', 'Series', 'Corrupt Book');
    const corruptAudiobookDir = join(corruptBookDir, '.audiobook');
    mkdirSync(corruptAudiobookDir, { recursive: true });
    const corruptStatePath = join(corruptAudiobookDir, 'state.json');
    writeFileSync(corruptStatePath, '{ this is not valid json');

    // A second, healthy book alphabetically AFTER the corrupt one, so the
    // only way this test can pass is if the run actually continues past
    // the corrupt book rather than aborting on its throw.
    const { statePath: healthyStatePath } = makeBook(booksRoot, join('Author', 'Series', 'Zebra Book'), {
      bookId: 'author__series__zebra-book',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Zebra Book',
      author: 'Author',
      language: 'ru', // already has a language — simplest possible "did the run reach it" probe
    });

    await main(['--apply'], booksRoot);

    // The corrupt book's file is untouched (never even attempted) and the
    // run reached the healthy book after it.
    assert.equal(readFileSync(corruptStatePath, 'utf8'), '{ this is not valid json');
    const healthyWritten = readState(healthyStatePath);
    assert.equal(healthyWritten.language, 'ru');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: dry-run (no --apply) writes nothing at all', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-dry-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'Dry Run'), {
      bookId: 'author__series__dry-run',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Dry Run',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
    });
    writeFileSync(join(bookDir, 'manuscript.md'), `# Dry Run\n\n${REAL_ENGLISH_PROSE}\n`);
    const before = readFileSync(statePath, 'utf8');

    await main([], booksRoot); // no --apply → dry-run default

    const after = readFileSync(statePath, 'utf8');
    assert.equal(after, before, 'dry-run must not touch state.json byte-for-byte');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: skips .upgrade-backups entirely, even if it holds a bare state.json', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-upgrade-backups-'));
  try {
    const booksRoot = join(tmp, 'books');
    // A real book that WOULD backfill, to prove the walk still finds it...
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'Real Book'), {
      bookId: 'author__series__real-book',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Real Book',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
    });
    writeFileSync(join(bookDir, 'manuscript.md'), `# Real Book\n\n${REAL_ENGLISH_PROSE}\n`);

    // ...alongside an .upgrade-backups snapshot NESTED INSIDE booksRoot (worst
    // case for the walk — it must still be skipped even when it sits directly
    // in the subtree being walked, not just as a WORKSPACE_ROOT sibling). Give
    // it a manuscript that WOULD confidently backfill if the skip ever broke,
    // so the assertion below is a real proof, not a vacuous one.
    const backupDir = join(booksRoot, '.upgrade-backups', 'from-1-to-2', 'Author', 'Series', 'Real Book');
    const backupAudiobookDir = join(backupDir, '.audiobook');
    mkdirSync(backupAudiobookDir, { recursive: true });
    writeFileSync(
      join(backupAudiobookDir, 'state.json'),
      JSON.stringify({
        bookId: 'stale-backup-copy',
        manuscriptId: `mns_${randomUUID()}`,
        title: 'Stale',
        author: 'Author',
        manuscriptFile: 'manuscript.md',
      }),
    );
    writeFileSync(join(backupDir, 'manuscript.md'), `# Stale\n\n${REAL_ENGLISH_PROSE}\n`);
    const backupStatePath = join(backupAudiobookDir, 'state.json');
    const backupBefore = readFileSync(backupStatePath, 'utf8');

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'en');
    const backupAfter = readFileSync(backupStatePath, 'utf8');
    assert.equal(backupAfter, backupBefore, '.upgrade-backups must never be walked, let alone written to');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #2246 C5 — a missing books root must exit non-zero, not read as a clean run.
// ---------------------------------------------------------------------------

test('main: missing books root sets a non-zero exit code (#2246 C5)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-missing-root-'));
  const missingRoot = join(tmp, 'does-not-exist');
  const before = process.exitCode;
  try {
    process.exitCode = 0;
    await main([], missingRoot);
    assert.notEqual(process.exitCode, 0, 'a missing books root must not read as a clean (exit 0) run');
  } finally {
    process.exitCode = before;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: an EXISTING books root leaves the exit code untouched', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-existing-root-'));
  const before = process.exitCode;
  try {
    process.exitCode = 0;
    const booksRoot = join(tmp, 'books');
    mkdirSync(booksRoot, { recursive: true }); // exists, but empty — zero books, still a clean run
    await main([], booksRoot);
    assert.equal(process.exitCode, 0, 'an existing (even empty) books root is a normal run, not an error');
  } finally {
    process.exitCode = before;
    rmSync(tmp, { recursive: true, force: true });
  }
});
