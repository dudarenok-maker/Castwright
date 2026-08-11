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
   detectManuscriptLanguage), cacheSampleText (the analysis-cache sample
   builder), and main() (the I/O shell) against a temp workspace.

   #2246 round 2: the cross-source-agreement gate (round 1) is gone — single
   sample only, gated on `fallback === false` AND a prose-signal floor
   (PROSE_UNIT_FLOOR in the script). Fixtures below are sized accordingly:
   anything meant to actually backfill needs >= 20 sentence-terminal-
   punctuated units (post front-matter-strip, matching the script's own
   detectionSample() pipeline); anything meant to probe the floor from below
   deliberately stays short. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { planBookLanguage, cacheSampleText, main } from '../repair-missing-book-language.mts';
import { cachePath } from '../../server/src/store/analysis-cache.js';
import { detectManuscriptLanguage } from '../../server/src/tts/detect-language.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real, continuous English prose — 24 sentence-terminal-punctuated units,
// comfortably above the 20-unit floor. Used wherever a test needs a sample
// that genuinely backfills.
const REAL_ENGLISH_PROSE = [
  'The lighthouse keeper climbed the spiral staircase every evening before dusk.',
  'He counted each worn stone step the way his father had taught him decades ago.',
  'Below, the harbor lights flickered awake one by one as fishing boats returned home.',
  'Their captains called out familiar greetings across the darkening water while gulls wheeled overhead.',
  'A cold wind moved through the empty market square long after the vendors had packed up their stalls.',
  'It rattled the loose shutters of the old bakery and scattered a handful of dry leaves across the cobblestones.',
  'A stray cat watched from beneath a parked cart, waiting for the street to fall completely silent.',
  'Out past the breakwater, the storm that had been building all afternoon finally broke.',
  'Rain hammered the lighthouse windows in long, uneven gusts that rattled the old glass in its frame.',
  'The keeper lit the lamp early that night, well before the usual hour, and trimmed the wick twice.',
  'He had learned long ago that a storm like this one gave no warning before it turned dangerous.',
  'Somewhere out on the water a bell buoy clanged against the swell, its sound swallowed by the wind.',
  'He thought of the fishermen still out past the point and hoped they had turned for home in time.',
  'The lamp room smelled of oil and salt, a smell he had never once grown tired of in forty years.',
  'Down in the village, shutters closed one after another as the storm rolled in off the sea.',
  'A child pressed her face to a window, watching the lighthouse beam sweep across the black water.',
  'Her mother pulled her back from the glass and told her the keeper would see the boats home safely.',
  'By midnight the wind had eased, though the rain kept falling in a slow, steady rhythm.',
  'The keeper stayed at his post until the last boat rounded the point and slipped into the harbor.',
  'Only then did he bank the lamp for the night and make his way back down the spiral stair.',
  'He passed the same worn step his father had shown him, still counting out of old habit.',
  'Outside, the harbor had gone quiet again, the boats tied fast against their moorings.',
  'A thin line of grey showed along the horizon, the first hint of a calmer morning to come.',
  'The keeper closed the lighthouse door behind him and let the sound of the sea carry him to sleep.',
].join(' ');

// A short, single real English sentence — genuine prose, franc detects it
// confidently (fallback: false), but it is only ONE prose unit: below the
// floor. Also doubles as "a distinct present-but-ignored second sample" in
// the cache-vs-manuscript preference test, since its content never matters
// there (a book with a cache never has its manuscript sample inspected at
// all).
const SHORT_ENGLISH_SENTENCE =
  'A cold wind moved through the empty market square long after the vendors had gone home for the night.';

// Real, continuous Russian prose — 22 units, above the floor. Deterministic
// via detect-language.ts's Cyrillic-ratio SCRIPT PRE-PASS (not franc), same
// determinism rationale as NO_LETTERS_TEXT below — no dependency on franc's
// fuzzy Latin disambiguation (this text never reaches franc at all).
const REAL_RUSSIAN_PROSE = [
  'Смотритель маяка поднимался по винтовой лестнице каждый вечер перед закатом.',
  'Он пересчитывал каждую истёртую каменную ступень так же, как учил его отец много лет назад.',
  'Внизу постепенно загорались огни гавани, когда рыбацкие лодки одна за другой возвращались домой.',
  'Капитаны перекликались знакомыми приветствиями над потемневшей водой, пока чайки кружили в поисках объедков.',
  'Холодный ветер проносился по пустой рыночной площади задолго после того, как торговцы собрали свои прилавки.',
  'Он громыхал расшатанными ставнями старой пекарни и разносил горстку сухих листьев по булыжной мостовой.',
  'Бездомная кошка наблюдала из-под брошенной телеги, ожидая, когда улица наконец затихнет.',
  'За волноломом буря, копившаяся весь день, наконец разразилась в полную силу.',
  'Дождь бил в окна маяка долгими неровными порывами, дребезжа старым стеклом в раме.',
  'В ту ночь смотритель зажёг лампу раньше обычного и дважды подрезал фитиль.',
  'Он давно усвоил, что такая буря не предупреждает, прежде чем стать по-настоящему опасной.',
  'Где-то в море звенел буй на волнах, и его звук тонул в шуме ветра.',
  'Он думал о рыбаках, всё ещё находившихся за мысом, и надеялся, что они успели вернуться вовремя.',
  'Фонарная комната пахла маслом и солью — запахом, к которому он не уставал за сорок лет.',
  'Внизу в посёлке одно за другим закрывались ставни, пока буря накатывала с моря.',
  'Девочка прижалась лицом к окну, наблюдая, как луч маяка скользит по чёрной воде.',
  'Мать оттащила её от стекла и сказала, что смотритель приведёт лодки домой в целости.',
  'К полуночи ветер стих, хотя дождь продолжал идти медленным, ровным ритмом.',
  'Смотритель оставался на посту, пока последняя лодка не обогнула мыс и не вошла в гавань.',
  'Только тогда он притушил лампу на ночь и начал спускаться по винтовой лестнице.',
  'Он миновал ту самую истёртую ступень, которую показывал ему отец, всё ещё считая её по привычке.',
  'Снаружи в гавани снова стало тихо — лодки были надёжно привязаны у причала.',
].join(' ');

// Real, continuous Chinese prose — 24 units (。 terminated), above the
// floor. Proves the floor does NOT exclude a real-shaped CJK book (the
// residual this gate does NOT close is about a much narrower secondary
// signal — median prose-unit LENGTH — never added here; see the script's
// own header).
const REAL_CJK_PROSE = [
  '灯塔看守人每天傍晚都会爬上那座螺旋楼梯。',
  '他仔细数着每一级被磨损的石阶，就像多年前父亲教他的那样。',
  '港口的灯火渐渐亮起，渔船一艘接一艘地返回码头。',
  '船长们隔着渐暗的海水互相打着熟悉的招呼，海鸥在头顶盘旋。',
  '一阵冷风吹过空荡荡的集市广场，那时摊贩早已收摊回家。',
  '它摇晃着老面包店松动的百叶窗，把几片干枯的树叶吹过鹅卵石路面。',
  '一只流浪猫蹲在被遗弃的手推车下，等待街道彻底安静下来。',
  '防波堤外，整整酝酿了一天的风暴终于爆发了。',
  '雨点猛烈地打在灯塔的窗户上，震得老旧的玻璃在窗框里作响。',
  '那天夜里，看守人比往常更早点亮了灯，还修剪了两次灯芯。',
  '他早就明白，这样的风暴从不会在真正危险之前给出警告。',
  '海面上某处传来浮标的钟声，声音被风声吞没。',
  '他想起还在海角外的渔民，希望他们已经及时返航。',
  '灯室里弥漫着油和盐的气味，那是他四十年来从未厌倦的味道。',
  '山下的村子里，百叶窗一扇接一扇地关上，风暴正从海上席卷而来。',
  '一个女孩把脸贴在窗上，看着灯塔的光束扫过漆黑的海面。',
  '她的母亲把她从窗边拉开，说看守人会把船只安全带回家。',
  '到了午夜，风势渐渐平息，雨却仍以缓慢均匀的节奏下着。',
  '看守人一直守在岗位上，直到最后一艘船绕过海角驶入港湾。',
  '直到那时，他才把灯调暗，沿着螺旋楼梯往下走。',
  '他经过父亲曾指给他看的那级石阶，仍出于习惯数着它。',
  '外面的港湾又恢复了寂静，船只都牢牢地系在泊位上。',
  '天边露出一线灰色的光，预示着一个更平静的清晨即将到来。',
  '看守人关上灯塔的门，让海浪的声音伴他入睡。',
].join('');

// Zero \p{L} letters — trips the detect-language.ts `letters === 0` surrender
// branch deterministically (no dependency on franc's fuzzy behaviour).
const NO_LETTERS_TEXT = '12345 000 --- !!! ??? 000000 111 222 333 444 555 666 777 888';

// #2246 C1 (confirmed review finding): a genuinely English table of contents
// that franc mis-disambiguates to 'es' with `fallback: false` — a fluent,
// WRONG, non-fallback result. Real repro, reproduced against the real
// detectManuscriptLanguage before writing this fixture:
//   detectManuscriptLanguage(TOC_MISDETECTED_AS_SPANISH) →
//     { language: 'es', supported: true, fallback: false }
// It also has ZERO sentence-terminal punctuation → 0 prose units. Round 1
// caught this with a second, disagreeing source; round 2 catches it with
// the prose floor instead — same fixture, different mechanism.
const TOC_MISDETECTED_AS_SPANISH =
  'Prologue 1 Kaz 2 Inej 3 Kaz 4 Jesper 5 Nina 6 Matthias 7 Inej 8 Wylan 9 Kaz 10 Nina';

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

test('planBookLanguage: no cache and no manuscript text → skipped, reported', () => {
  const plan = planBookLanguage({
    bookId: 'book-j',
    hasLanguageKey: false,
    cacheText: null,
    manuscriptText: null,
  });
  assert.deepEqual(plan, {
    bookId: 'book-j',
    action: 'skip-no-text',
    reason: 'no analysis-cache sentence text and no readable manuscript file',
  });
});

test('planBookLanguage: whitespace-only cache/manuscript text counts as no text', () => {
  const plan = planBookLanguage({
    bookId: 'book-k',
    hasLanguageKey: false,
    cacheText: '   \n  ',
    manuscriptText: '  ',
  });
  assert.equal(plan.action, 'skip-no-text');
});

test('planBookLanguage: only cache text available, confident + above the floor → backfill from analysis-cache (#2246 round 2 revert)', () => {
  // Before round 1 this backfilled. Round 1 made it a skip
  // (skip-single-source). Round 2 reverts to a single sample, so this is a
  // backfill again — the exact behaviour the round-1 gate had removed.
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

test('planBookLanguage: only manuscript text available (no cache), confident + above the floor → backfill from manuscript (#2246 round 2 revert)', () => {
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

test('planBookLanguage: both cache and manuscript text present → analysis-cache is preferred, manuscript is never even inspected', () => {
  const plan = planBookLanguage({
    bookId: 'book-pref',
    hasLanguageKey: false,
    cacheText: REAL_ENGLISH_PROSE,
    // A short, below-floor sample. If the manuscript sample were ever
    // detected on its own, this would still be 'en' (it's English), but a
    // real single-source design must not even reach it — the point of this
    // test is the SOURCE, not the language.
    manuscriptText: SHORT_ENGLISH_SENTENCE,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.sampleSource, 'analysis-cache');
});

test('planBookLanguage: non-English sample (Russian), confident + above the floor → backfill (round 2, single-source, non-English fixture)', () => {
  const plan = planBookLanguage({
    bookId: 'book-ru',
    hasLanguageKey: false,
    cacheText: REAL_RUSSIAN_PROSE,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'ru');
});

test('planBookLanguage: real-shaped CJK sample, confident + above the floor → backfill (the floor must not exclude zh/ja)', () => {
  const plan = planBookLanguage({
    bookId: 'book-zh',
    hasLanguageKey: false,
    cacheText: REAL_CJK_PROSE,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'zh');
});

test('planBookLanguage: the only available sample surrenders (letter-less) → skip-fallback (a guess is never written)', () => {
  const plan = planBookLanguage({
    bookId: 'book-g',
    hasLanguageKey: false,
    cacheText: NO_LETTERS_TEXT,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'skip-fallback');
  assert.match(plan.reason, /surrendered/);
});

test('planBookLanguage: sample below the prose floor (0 units) but franc did not surrender → skip-thin-sample, not backfill (#2246 C1, round 2 mechanism)', () => {
  // The exact C1 repro: an English TOC-shaped sample franc mis-disambiguates
  // to 'es' with fallback:false — a fluent, WRONG, non-fallback result. Round
  // 1 caught this via a disagreeing second source; round 2 catches it
  // because the sample has 0 prose units, far under the floor.
  const plan = planBookLanguage({
    bookId: 'book-f',
    hasLanguageKey: false,
    cacheText: TOC_MISDETECTED_AS_SPANISH,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'skip-thin-sample');
  assert.equal(plan.proseUnits, 0);
  assert.match(plan.reason, /below the 20-unit floor/);
});

test('planBookLanguage: genuine, confident single-sentence sample (1 unit) is still below the floor → skip-thin-sample', () => {
  // Unlike the TOC fixture above, this is real, grammatical, confidently-
  // detected English prose — proof the floor rejects on UNIT COUNT alone,
  // not just on obviously junk-shaped text.
  const detection = detectManuscriptLanguage(SHORT_ENGLISH_SENTENCE);
  assert.equal(detection.fallback, false, 'fixture sanity: must be a genuine, non-guessed detection');

  const plan = planBookLanguage({
    bookId: 'book-thin',
    hasLanguageKey: false,
    cacheText: SHORT_ENGLISH_SENTENCE,
    manuscriptText: null,
  });
  assert.equal(plan.action, 'skip-thin-sample');
  assert.equal(plan.proseUnits, 1);
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
// touching (or needing to clean up) the real cache directory, EXCEPT for the
// tests below that deliberately populate a cache file to exercise the
// analysis-cache sample-source path.
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

/** Capture console.log output for the duration of `fn`, restoring the real
 *  console.log afterwards even on throw. Used by the Task 3 tests below to
 *  assert on the printed diagnostic, not just on file-level side effects. */
async function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
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

test('main: manuscript-only sample (no cache), confident + above the floor → --apply backfills from the manuscript (#2246 round 2 revert)', async () => {
  // Before round 1 this backfilled. Round 1 made it a skip
  // (skip-single-source, per the #2246 C1 gate that has since been removed).
  // Round 2 reverts to a single sample: this is the manuscript-only branch
  // of main() actually reaching a write again.
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-manuscript-only-'));
  try {
    const booksRoot = join(tmp, 'books');
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'No Cache'), {
      bookId: 'author__series__no-cache',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'No Cache',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
      narratorCredit: 'Castwright',
    });
    writeFileSync(join(bookDir, 'manuscript.md'), `# No Cache\n\n${REAL_ENGLISH_PROSE}\n`);

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'en');
    // Every other field still preserved (spread, never reconstructed).
    assert.equal(written.narratorCredit, 'Castwright');
    assert.equal(written.title, 'No Cache');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: cache present → --apply backfills using the analysis-cache sample (non-English fixture, analysis-cache branch coverage)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-ru-cache-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    const { bookDir, statePath } = makeBook(booksRoot, join('Author', 'Series', 'Russian Book'), {
      bookId: 'author__series__russian-book',
      manuscriptId,
      title: 'Russian Book',
      author: 'Author',
      manuscriptFile: 'manuscript.md',
    });
    // Manuscript deliberately holds DIFFERENT (English) text — proof the
    // cache sample is the one actually used, never merged or cross-checked.
    writeFileSync(join(bookDir, 'manuscript.md'), `# Russian Book\n\n${REAL_ENGLISH_PROSE}\n`);
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({ chapters: { 0: [{ text: REAL_RUSSIAN_PROSE, speakerId: 'narrator' }] } }),
    );

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'ru');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
  }
});

test('main: single sample surrenders (letter-less manuscript, no cache) → --apply does NOT write, summary reports it as "skipped (detection surrendered)" (#2246 C1, re-fixtured for round 2 — single source is now reachable)', async () => {
  // Before round 1's cross-source gate this fixture (a random, cache-less
  // manuscriptId) would have exercised skip-fallback directly. Round 1
  // widened the test's title to "on both sources" without changing the
  // fixture, so it silently stopped reaching the fallback branch at all (it
  // returned at the single-source check first) — reported by round 2 review.
  // With the single-source design restored, this fixture reaches
  // skip-fallback again; retitled to say what it actually now exercises, and
  // the summary-line assertion below is genuinely new coverage (the "N
  // skipped (detection surrendered)" segment had none before this).
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

    const lines = await captureLog(() => main(['--apply'], booksRoot));

    const written = readState(statePath);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(written, 'language'),
      'a surrendered (guessed) detection must NEVER be written',
    );
    const summary = lines.find((l) => /skipped \(detection surrendered\)/.test(l));
    assert.ok(summary, 'summary line must report the surrendered skip');
    assert.match(summary, /1 skipped \(detection surrendered\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: single cache sample below the prose floor → --apply does NOT write, summary reports it as "skipped (thin sample)"', async () => {
  // The C1 TOC regression fixture, exercised through main() end to end —
  // proof the thin-sample summary segment (brand-new action, zero coverage
  // before this change) is wired all the way through.
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-thin-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Thin Sample'), {
      bookId: 'author__series__thin-sample',
      manuscriptId,
      title: 'Thin Sample',
      author: 'Author',
    });
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({ chapters: { 0: [{ text: TOC_MISDETECTED_AS_SPANISH, speakerId: 'narrator' }] } }),
    );

    const lines = await captureLog(() => main(['--apply'], booksRoot));

    const written = readState(statePath);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(written, 'language'),
      'a below-floor sample must never be written, even when franc looked confident',
    );
    const summary = lines.find((l) => /skipped \(thin sample\)/.test(l));
    assert.ok(summary, 'summary line must report the thin-sample skip');
    assert.match(summary, /1 skipped \(thin sample\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
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

test('main: dry-run (no --apply) writes nothing at all, even for a book that WOULD backfill', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-dry-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Dry Run'), {
      bookId: 'author__series__dry-run',
      manuscriptId,
      title: 'Dry Run',
      author: 'Author',
    });
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({ chapters: { 0: [{ text: REAL_ENGLISH_PROSE, speakerId: 'narrator' }] } }),
    );
    const before = readFileSync(statePath, 'utf8');

    await main([], booksRoot); // no --apply → dry-run default

    const after = readFileSync(statePath, 'utf8');
    assert.equal(after, before, 'dry-run must not touch state.json byte-for-byte');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
  }
});

test('main: skips .upgrade-backups entirely, even if it holds a bare state.json', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-upgrade-backups-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    // A real book that WOULD backfill, to prove the walk still finds it.
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Real Book'), {
      bookId: 'author__series__real-book',
      manuscriptId,
      title: 'Real Book',
      author: 'Author',
    });
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({ chapters: { 0: [{ text: REAL_ENGLISH_PROSE, speakerId: 'narrator' }] } }),
    );

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
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
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
