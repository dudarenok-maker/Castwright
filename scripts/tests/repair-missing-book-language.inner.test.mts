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
   detectManuscriptLanguageFromChapters), cacheChaptersFor (the analysis-cache
   sample builder), and main() (the I/O shell) against a temp workspace.

   #2263 round: the script's sampling went from ONE flat string (front-matter
   stripped, sliced to 20k chars) to CHAPTER-AWARE — one ChapterSample per
   non-excluded chapter, voted the same way POST /api/import now votes.
   Fixtures below are sized to exercise BOTH selection layers
   (detectManuscriptLanguageFromChapters's own front-matter-title/word-count
   filter, and the script's own `excluded`-flag skip) and the vote/floor
   thresholds: anything meant to actually backfill via the multi-chapter vote
   needs >= 2 non-front-matter, >= FRONT_MATTER_WORD_THRESHOLD-word chapters
   that agree; anything meant to exercise the single-chapter floor is
   deliberately reduced to exactly one candidate chapter. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { planBookLanguage, cacheChaptersFor, main } from '../repair-missing-book-language.mts';
import { cachePath } from '../../server/src/store/analysis-cache.js';
import { detectManuscriptLanguage } from '../../server/src/tts/detect-language.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real, continuous English prose — 24 sentence-terminal-punctuated units,
// comfortably above the 20-unit floor, and ~380 words (above the 150-word
// front-matter floor). Used wherever a test needs a chapter that genuinely
// backfills.
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

// A second, distinct English passage — same shape (24 units, well above both
// floors) but different content, for tests that need TWO agreeing-but-not-
// identical English chapters (a vote needs independent-looking samples, not
// the same string copy-pasted).
const REAL_ENGLISH_PROSE_2 = [
  'The clockmaker set down his tools the instant the church bells began to toll.',
  'Every evening at the same hour he stopped, no matter how close the work sat to finished.',
  'His apprentice never understood why, and he had long since stopped trying to explain it.',
  'Outside, the square filled with the usual after-work crowd drifting toward the tavern.',
  'A cart wheel caught in the gutter and its owner swore at it in three different languages.',
  'The clockmaker latched his shutters and lit the single lamp that hung above his bench.',
  'By its light he could just make out the gears still waiting to be reassembled.',
  'He had promised the mayor the tower clock by the end of the month.',
  'Privately he doubted he would keep that promise, though he never said so aloud.',
  'His apprentice swept the metal shavings into a tin and carried it out back.',
  'The two of them ate a plain supper without much conversation, as was their habit.',
  'Afterward the boy asked, as he always did, whether he might see the tower mechanism.',
  'The clockmaker said what he always said — when the gears were ready, not before.',
  'Rain began against the shutters, light at first, then heavier as the night wore on.',
  'He thought about the broken escapement in the tower clock and how little time remained to fix it.',
  'The apprentice fell asleep at the bench, his cheek resting against a folded apron.',
  'The clockmaker covered him with his own coat and went back to the gears alone.',
  'Hours passed before he found the flaw — a single tooth worn smooth by decades of turning.',
  'He filed a new one by hand, checking it against the others a dozen times.',
  'When dawn came he had not slept, but the mechanism finally turned true.',
  'He woke the boy gently and told him the clock would be ready after all.',
  'Together they carried the finished piece up the tower stairs before the town had risen.',
  'The bells rang true that noon, and no one in the square knew how close it had come.',
  'The clockmaker never did explain why he stopped every evening when the bells tolled.',
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

// A second, distinct Russian passage — same shape, for the 2-vs-2 split test.
const REAL_RUSSIAN_PROSE_2 = [
  'Часовщик отложил инструменты, как только на башне зазвонили колокола.',
  'Каждый вечер в один и тот же час он останавливался, сколько бы работы ни оставалось.',
  'Его подмастерье так и не понял почему, и он давно перестал объяснять.',
  'На площади собиралась обычная толпа, спешащая после работы в трактир.',
  'Колесо телеги застряло в канаве, и хозяин ругал его на трёх языках сразу.',
  'Часовщик запер ставни и зажёг единственную лампу над своим верстаком.',
  'В её свете едва можно было различить шестерёнки, ещё не собранные заново.',
  'Он обещал мэру, что башенные часы будут готовы к концу месяца.',
  'Про себя он сомневался, что сдержит это обещание, но вслух не говорил.',
  'Подмастерье смёл металлическую стружку в жестяную банку и вынес её во двор.',
  'Они поужинали скромно и почти без разговоров, как обычно.',
  'Потом мальчик спросил, как всегда, можно ли ему увидеть башенный механизм.',
  'Часовщик ответил, как всегда: когда шестерёнки будут готовы, не раньше.',
  'В ставни забарабанил дождь — сначала тихо, потом всё сильнее к ночи.',
  'Он думал о сломанном спуске башенных часов и о том, как мало времени осталось.',
  'Подмастерье уснул за верстаком, прижавшись щекой к сложенному фартуку.',
  'Часовщик укрыл его собственным пальто и вернулся к шестерёнкам один.',
  'Прошли часы, прежде чем он нашёл изъян — один зуб, стёртый десятилетиями вращения.',
  'Он вручную выточил новый, сверяя его с остальными десятки раз.',
  'К рассвету он так и не поспал, но механизм наконец заработал верно.',
  'Он мягко разбудил мальчика и сказал, что часы всё-таки будут готовы.',
  'Вместе они внесли готовый механизм на башню ещё до того, как проснулся город.',
].join(' ');

// Real, continuous Chinese prose — 24 units (。 terminated), above the
// floor. Proves the floor does NOT exclude a real-shaped CJK book.
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

// A second, distinct Chinese passage — for tests that need two agreeing zh chapters.
const REAL_CJK_PROSE_2 = [
  '钟表匠放下工具，教堂的钟声正好响起。',
  '每天傍晚他都会在同一时刻停下，无论手上的活计离完成还有多远。',
  '他的学徒始终不明白为什么，也早已不再追问。',
  '广场上挤满了下班后照例涌向酒馆的人群。',
  '一只车轮卡在水沟里，车主用三种语言咒骂着它。',
  '钟表匠关上百叶窗，点亮了工作台上方唯一的那盏灯。',
  '借着灯光，他勉强能看清还未装回的齿轮。',
  '他向市长保证，月底之前塔钟一定修好。',
  '他心里其实并不确定能兑现这个承诺，却从未说出口。',
  '学徒把金属碎屑扫进铁罐，端到后院倒掉。',
  '两人照例简单地吃了顿晚饭，没什么交谈。',
  '之后男孩又照例问起，能不能去看看塔钟的机芯。',
  '钟表匠照例回答：齿轮修好了再说，现在不行。',
  '雨点开始打在百叶窗上，起初很轻，入夜后渐渐变大。',
  '他想着塔钟那损坏的擒纵机构，还有所剩无几的时间。',
  '学徒趴在工作台上睡着了，脸颊贴着叠好的围裙。',
  '钟表匠用自己的外套盖住他，独自回去继续修齿轮。',
  '过了好几个钟头，他才找到毛病——一颗被几十年转动磨平的齿。',
  '他手工锉出一颗新的，反复和其他齿轮比对了十几次。',
  '天亮时他还没合眼，但机芯终于转得准了。',
  '他轻轻叫醒男孩，告诉他钟终究还是能按时修好。',
  '两人趁全城还没醒来，一起把修好的机芯抬上了钟楼。',
].join('');

// Zero \p{L} letters — trips the detect-language.ts `letters === 0` surrender
// branch deterministically (no dependency on franc's fuzzy behaviour).
const NO_LETTERS_TEXT = '12345 000 --- !!! ??? 000000 111 222 333 444 555 666 777 888';

// #2246 C1 (confirmed review finding): a genuinely English table of contents
// that franc mis-disambiguates to 'es' with `fallback: false` — a fluent,
// WRONG, non-fallback result. Real repro, reproduced against the real
// detectManuscriptLanguage before writing this fixture. It also has ZERO
// sentence-terminal punctuation → 0 prose units — below the single-chapter
// floor.
const TOC_MISDETECTED_AS_SPANISH =
  'Prologue 1 Kaz 2 Inej 3 Kaz 4 Jesper 5 Nina 6 Matthias 7 Inej 8 Wylan 9 Kaz 10 Nina';

// #2263 — the 煤落的委托 shape: a real repro against the live book. Chapter 1
// is titled plainly ("Chapter 1", not a front-matter title match) but its
// body is just publisher-watermark boilerplate — a handful of words, well
// under FRONT_MATTER_WORD_THRESHOLD. Fed the whole document as ONE blob
// (the pre-#2263 behaviour), this chapter's `[emphatic] Castwright 原创作品。`
// text is long enough for franc to confidently (fallback:false) call it
// English, competing with — and, pre-fix, sometimes beating — the real
// Chinese body. The word-count selection filter drops it from the vote
// entirely; the two real Chinese chapters then agree unanimously.
const FRONT_MATTER_LOOKALIKE_CHAPTER = { id: 1, title: 'Chapter 1', body: '[emphatic] Castwright 原创作品。\n\n---' };

function makeCacheChapter(id: number, title: string, body: string) {
  return { id, title, body };
}

test('planBookLanguage: book already has a language key → untouched, reported as-is', () => {
  const plan = planBookLanguage({
    bookId: 'book-a',
    hasLanguageKey: true,
    existingLanguage: 'ru',
    cacheChapters: null,
    manuscriptChapters: null,
  });
  assert.deepEqual(plan, { bookId: 'book-a', action: 'has-language', existingLanguage: 'ru' });
});

test('planBookLanguage: no cache and no manuscript chapters → skipped, reported', () => {
  const plan = planBookLanguage({
    bookId: 'book-j',
    hasLanguageKey: false,
    cacheChapters: null,
    manuscriptChapters: null,
  });
  assert.deepEqual(plan, {
    bookId: 'book-j',
    action: 'skip-no-text',
    reason: 'no analysis-cache sentence text and no readable manuscript file',
  });
});

test('planBookLanguage: empty cache/manuscript chapter arrays count as no text', () => {
  const plan = planBookLanguage({
    bookId: 'book-k',
    hasLanguageKey: false,
    cacheChapters: [],
    manuscriptChapters: [],
  });
  assert.equal(plan.action, 'skip-no-text');
});

test('planBookLanguage: only cache chapters available, multi-chapter unanimous English → backfill from analysis-cache', () => {
  const plan = planBookLanguage({
    bookId: 'book-b',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, 'Chapter One', REAL_ENGLISH_PROSE),
      makeCacheChapter(2, 'Chapter Two', REAL_ENGLISH_PROSE_2),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
  assert.equal(plan.sampleSource, 'analysis-cache');
});

test('planBookLanguage: only manuscript chapters available (no cache), multi-chapter unanimous English → backfill from manuscript', () => {
  const plan = planBookLanguage({
    bookId: 'book-d',
    hasLanguageKey: false,
    cacheChapters: null,
    manuscriptChapters: [
      makeCacheChapter(1, 'Chapter One', REAL_ENGLISH_PROSE),
      makeCacheChapter(2, 'Chapter Two', REAL_ENGLISH_PROSE_2),
    ],
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
  assert.equal(plan.sampleSource, 'manuscript');
});

test('planBookLanguage: both cache and manuscript chapters present → analysis-cache is preferred, manuscript is never even inspected', () => {
  const plan = planBookLanguage({
    bookId: 'book-pref',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, 'Chapter One', REAL_ENGLISH_PROSE),
      makeCacheChapter(2, 'Chapter Two', REAL_ENGLISH_PROSE_2),
    ],
    // A single below-floor sample. If the manuscript sample were ever
    // inspected on its own, this would push it to a different plan (a
    // single below-floor chapter surrenders) — the point of this test is
    // the SOURCE, not the language.
    manuscriptChapters: [makeCacheChapter(1, 'Chapter One', SHORT_ENGLISH_SENTENCE)],
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.sampleSource, 'analysis-cache');
});

test('planBookLanguage: non-English sample (Russian), multi-chapter unanimous → backfill', () => {
  const plan = planBookLanguage({
    bookId: 'book-ru',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, 'Глава первая', REAL_RUSSIAN_PROSE),
      makeCacheChapter(2, 'Глава вторая', REAL_RUSSIAN_PROSE_2),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'ru');
});

test('planBookLanguage: real-shaped CJK sample, multi-chapter unanimous → backfill (the floor/vote must not exclude zh/ja)', () => {
  const plan = planBookLanguage({
    bookId: 'book-zh',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, '第一章', REAL_CJK_PROSE),
      makeCacheChapter(2, '第二章', REAL_CJK_PROSE_2),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'zh');
});

test('planBookLanguage: the only available sample surrenders (letter-less single chapter) → skip-fallback (a guess is never written)', () => {
  const plan = planBookLanguage({
    bookId: 'book-g',
    hasLanguageKey: false,
    cacheChapters: [makeCacheChapter(1, 'Chapter One', NO_LETTERS_TEXT)],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'skip-fallback');
  assert.match(plan.reason, /surrendered/);
});

test('planBookLanguage: single chapter, franc confidently wrong but 0 prose units → skip-fallback via the floor (#2246 C1 shape, folded into detectManuscriptLanguageFromChapters)', () => {
  // The exact C1 repro: an English TOC-shaped sample franc mis-disambiguates
  // to 'es' with fallback:false. It cannot corroborate itself (one
  // chapter), so the single-chapter prose-unit floor catches it.
  const plan = planBookLanguage({
    bookId: 'book-f',
    hasLanguageKey: false,
    cacheChapters: [makeCacheChapter(1, 'Chapter One', TOC_MISDETECTED_AS_SPANISH)],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'skip-fallback');
  assert.match(plan.reason, /surrendered/);
});

// ---------------------------------------------------------------------------
// #2263 — the required fixture classes from the task's Verification section.
// ---------------------------------------------------------------------------

test('planBookLanguage: a front-matter-titled chapter is excluded from the vote, not just outvoted', () => {
  // Without the front-matter TITLE filter, this would be a 1-en/1-ru split
  // (no majority) — WITH it, the Copyright chapter never enters the vote at
  // all, leaving a single English candidate that clears the floor on its
  // own. The two outcomes (surrender vs. backfill) make this test sensitive
  // to the filter actually running, not just present.
  const plan = planBookLanguage({
    bookId: 'book-fm',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, 'Copyright', REAL_RUSSIAN_PROSE),
      makeCacheChapter(2, 'Chapter One', REAL_ENGLISH_PROSE),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
});

test('planBookLanguage: word-count filter alone, 1-vs-1 head-to-head — only resolves once the short chapter is dropped', () => {
  // Isolates the word-count half of the selection filter from vote-majority
  // robustness: with only one other chapter, an unfiltered short chapter is
  // a 1-vs-1 split (no majority) — dropping it by word count is the only
  // way this resolves to a backfill.
  const plan = planBookLanguage({
    bookId: 'book-word-count-head-to-head',
    hasLanguageKey: false,
    cacheChapters: [FRONT_MATTER_LOOKALIKE_CHAPTER, makeCacheChapter(2, '第一章', REAL_CJK_PROSE)],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'zh');
});

test('planBookLanguage: 煤落的委托 shape — a short, non-front-matter-titled first chapter is dropped by the WORD-COUNT filter, body resolves the language', () => {
  // Chapter 1's title ("Chapter 1") does NOT match the front-matter title
  // regex — only its short body (well under FRONT_MATTER_WORD_THRESHOLD)
  // gets it dropped from the vote. Real repro against the live corpus book:
  // detectManuscriptLanguage on this exact chapter body alone returns
  // { language: 'en', fallback: false } — a confident, WRONG vote that
  // must never reach the tally.
  const wrongVote = detectManuscriptLanguage(FRONT_MATTER_LOOKALIKE_CHAPTER.body);
  assert.equal(wrongVote.fallback, false, 'fixture sanity: the lookalike chapter must be a confident (wrong) en vote on its own');
  assert.equal(wrongVote.language, 'en', 'fixture sanity: must reproduce the real 煤落的委托 chapter-1 mis-detection');

  const plan = planBookLanguage({
    bookId: 'book-first-ch-mismatch',
    hasLanguageKey: false,
    cacheChapters: [
      FRONT_MATTER_LOOKALIKE_CHAPTER,
      makeCacheChapter(2, '第一章', REAL_CJK_PROSE),
      makeCacheChapter(3, '第二章', REAL_CJK_PROSE_2),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'zh', 'must resolve to the BODY language, not chapter 1\'s mis-detected en');
});

test('planBookLanguage: 2-vs-2 split (en/ru, no strict majority) → surrenders, reason names the split', () => {
  const plan = planBookLanguage({
    bookId: 'book-split',
    hasLanguageKey: false,
    cacheChapters: [
      makeCacheChapter(1, 'Chapter One', REAL_ENGLISH_PROSE),
      makeCacheChapter(2, 'Chapter Two', REAL_ENGLISH_PROSE_2),
      makeCacheChapter(3, 'Глава первая', REAL_RUSSIAN_PROSE),
      makeCacheChapter(4, 'Глава вторая', REAL_RUSSIAN_PROSE_2),
    ],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'skip-fallback');
  assert.match(plan.reason, /no clear majority/);
  assert.match(plan.reason, /en 2 \/ ru 2/);
});

test('planBookLanguage: single body chapter ABOVE the floor → backfills (the floor is not a blanket single-chapter refusal)', () => {
  const plan = planBookLanguage({
    bookId: 'book-single-ok',
    hasLanguageKey: false,
    cacheChapters: [makeCacheChapter(1, 'Chapter One', REAL_ENGLISH_PROSE)],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'backfill');
  assert.equal(plan.language, 'en');
});

test('planBookLanguage: single body chapter BELOW the floor → skip-fallback (genuine, confidently-detected prose is still refused alone)', () => {
  // Unlike the TOC fixture above, this is real, grammatical, confidently-
  // detected English prose — proof the floor rejects on UNIT COUNT alone,
  // not just on obviously junk-shaped text.
  const detection = detectManuscriptLanguage(SHORT_ENGLISH_SENTENCE);
  assert.equal(detection.fallback, false, 'fixture sanity: must be a genuine, non-guessed detection');

  const plan = planBookLanguage({
    bookId: 'book-thin',
    hasLanguageKey: false,
    cacheChapters: [makeCacheChapter(1, 'Chapter One', SHORT_ENGLISH_SENTENCE)],
    manuscriptChapters: null,
  });
  assert.equal(plan.action, 'skip-fallback');
});

// ---------------------------------------------------------------------------
// cacheChaptersFor — #2263 (was cacheSampleText, a single flattened string).
// Writes directly to the REAL cache path (cachePath is deterministic on
// manuscriptId, same trick main()'s own tests below use), cleaned up after.
// ---------------------------------------------------------------------------

// A real e-library boilerplate line matching strip-front-matter.ts's
// unanchored `одобрен к распространению` global pattern.
const BOILERPLATE_LINE_RU = 'Настоящая книга одобрен к распространению.';

test('cacheChaptersFor: joins one chapter\'s sentences with a newline, not a space (#2246 C2 fix, preserved)', async () => {
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
    const chapters = await cacheChaptersFor(manuscriptId, []);
    assert.ok(chapters, 'cacheChaptersFor must return the chapter list');
    assert.equal(chapters.length, 1);
    assert.ok(chapters[0].body.includes('\n'), 'sentences must be newline-joined, not collapsed onto one line');

    // The actual regression this join fixes: stripFrontMatterBoilerplate is
    // LINE-based. Joined with '\n', only the boilerplate LINE is dropped —
    // the Russian prose line survives and still detects confidently.
    const detection = detectManuscriptLanguage(chapters[0].body);
    assert.equal(detection.fallback, false, 'boilerplate + prose must still detect confidently, not surrender');
    assert.equal(detection.language, 'ru');
  } finally {
    rmSync(path, { force: true });
  }
});

test('cacheChaptersFor: returns null when the book has no cache at all', async () => {
  const manuscriptId = `mns_${randomUUID()}`; // never written — no cache file exists
  const chapters = await cacheChaptersFor(manuscriptId, []);
  assert.equal(chapters, null);
});

test('cacheChaptersFor: skips chapters marked `excluded` in state.chapters[], matched by id (#2263)', async () => {
  const manuscriptId = `mns_${randomUUID()}`;
  const path = cachePath(manuscriptId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      chapters: {
        1: [{ text: 'Настоящая книга одобрен к распространению.', speakerId: 'narrator' }],
        2: [{ text: REAL_RUSSIAN_PROSE, speakerId: 'narrator' }],
      },
    }),
  );
  try {
    const stateChapters = [
      { id: 1, title: 'Copyright', slug: '01-copyright', excluded: true },
      { id: 2, title: 'Глава первая', slug: '02-chapter-one' },
    ];
    const chapters = await cacheChaptersFor(manuscriptId, stateChapters);
    assert.ok(chapters);
    assert.equal(chapters.length, 1, 'the excluded chapter id must never appear in the result');
    assert.equal(chapters[0].id, 2);
    assert.equal(chapters[0].title, 'Глава первая', 'title comes from the matching state.chapters[] entry by id');
  } finally {
    rmSync(path, { force: true });
  }
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

test('main: manuscript-only sample (no cache), single chapter above the floor → --apply backfills from the manuscript', async () => {
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

test('main: excluded cache chapter is skipped end-to-end — a wrong-language excluded chapter never spoils the vote (#2263)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-excluded-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Excluded Chapter Book'), {
      bookId: 'author__series__excluded-chapter-book',
      manuscriptId,
      title: 'Excluded Chapter Book',
      author: 'Author',
      chapters: [
        { id: 1, title: 'Front Matter', slug: '01-front-matter', excluded: true },
        { id: 2, title: 'Chapter One', slug: '02-chapter-one' },
      ],
    });
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({
        chapters: {
          // Excluded chapter's text is Russian — if it were NOT skipped, a
          // single English chapter would still win the vote in most vote
          // shapes, so make it a real single-vs-single competitor: only one
          // OTHER chapter exists, so an unskipped exclusion would produce a
          // 1-en/1-ru split (no majority) instead of a clean backfill.
          1: [{ text: REAL_RUSSIAN_PROSE, speakerId: 'narrator' }],
          2: [{ text: REAL_ENGLISH_PROSE, speakerId: 'narrator' }],
        },
      }),
    );

    await main(['--apply'], booksRoot);

    const written = readState(statePath);
    assert.equal(written.language, 'en', 'the excluded Russian chapter must never enter the vote');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
  }
});

test('main: single sample surrenders (letter-less manuscript, no cache) → --apply does NOT write, summary reports it as "skipped (detection surrendered)"', async () => {
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

test('main: single-chapter cache sample below the prose floor → --apply does NOT write, folded into "skipped (detection surrendered)" (#2263 — skip-thin-sample retired)', async () => {
  // The C1 TOC regression fixture, exercised through main() end to end —
  // proof the single-chapter floor path is wired all the way through, even
  // though it no longer has its own distinct action/summary bucket.
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
    const summary = lines.find((l) => /skipped \(detection surrendered\)/.test(l));
    assert.ok(summary, 'summary line must report the surrendered skip');
    assert.match(summary, /1 skipped \(detection surrendered\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(cacheFilePath)) rmSync(cacheFilePath, { force: true });
  }
});

test('main: 2-vs-2 split (no majority) → --apply does NOT write, reason names the split', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-split-'));
  const manuscriptId = `mns_${randomUUID()}`;
  const cacheFilePath = cachePath(manuscriptId);
  try {
    const booksRoot = join(tmp, 'books');
    const { statePath } = makeBook(booksRoot, join('Author', 'Series', 'Split Vote'), {
      bookId: 'author__series__split-vote',
      manuscriptId,
      title: 'Split Vote',
      author: 'Author',
    });
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({
        chapters: {
          1: [{ text: REAL_ENGLISH_PROSE, speakerId: 'narrator' }],
          2: [{ text: REAL_ENGLISH_PROSE_2, speakerId: 'narrator' }],
          3: [{ text: REAL_RUSSIAN_PROSE, speakerId: 'narrator' }],
          4: [{ text: REAL_RUSSIAN_PROSE_2, speakerId: 'narrator' }],
        },
      }),
    );

    const lines = await captureLog(() => main(['--apply'], booksRoot));

    const written = readState(statePath);
    assert.ok(!Object.prototype.hasOwnProperty.call(written, 'language'), 'a no-majority split must never be written');
    const bookLine = lines.find((l) => l.includes('Split Vote'));
    assert.ok(bookLine);
    assert.match(bookLine, /no clear majority/);
    assert.match(bookLine, /en 2 \/ ru 2/);
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
// #2246 C3 — one unreadable state.json must not abort the whole run, AND
// the printed diagnostic must distinguish genuine corruption (SyntaxError)
// from every other read-failure class (round 2 review finding).
// ---------------------------------------------------------------------------

test('main: a corrupt state.json (unparsable, no valid backup) is skipped as unreadable, labelled "corrupt JSON" — the run continues past it (#2246 C3)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-corrupt-'));
  try {
    const booksRoot = join(tmp, 'books');
    // The corrupt book: state.json is not valid JSON, and there's no
    // .bak.N to recover from, so readStateJsonWithRecovery re-throws a
    // SyntaxError.
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

    const lines = await captureLog(() => main(['--apply'], booksRoot));

    // The corrupt book's file is untouched (never even attempted) and the
    // run reached the healthy book after it.
    assert.equal(readFileSync(corruptStatePath, 'utf8'), '{ this is not valid json');
    const healthyWritten = readState(healthyStatePath);
    assert.equal(healthyWritten.language, 'ru');

    // The diagnostic names the failure class AND carries the original
    // message — not a bare "unreadable" with nothing to act on.
    const corruptLine = lines.find((l) => l.includes('Corrupt Book'));
    assert.ok(corruptLine, 'must print a line for the corrupt book');
    assert.match(corruptLine, /corrupt JSON/);
    assert.doesNotMatch(corruptLine, /read error/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main: a state.json that fails to read for a non-parse reason (EISDIR) is labelled "read error", distinct from corrupt JSON — the run continues past it (#2246 round 2 C3 fix)', async () => {
  // Simulates the class of failure the round-2 review named (a locked file —
  // Windows AV/OneDrive/the running server holding a read handle): the read
  // itself fails with something other than SyntaxError. Making the
  // state.json PATH a directory instead of a file reproduces that
  // deterministically — readFile() on a directory throws EISDIR, not
  // SyntaxError — without needing real OS-level file locking.
  const tmp = mkdtempSync(join(tmpdir(), 'repair-book-language-readerror-'));
  try {
    const booksRoot = join(tmp, 'books');
    const lockedBookDir = join(booksRoot, 'Author', 'Series', 'Locked Book');
    const lockedAudiobookDir = join(lockedBookDir, '.audiobook');
    const lockedStatePath = join(lockedAudiobookDir, 'state.json');
    // state.json is a DIRECTORY, not a file.
    mkdirSync(lockedStatePath, { recursive: true });

    const { statePath: healthyStatePath } = makeBook(booksRoot, join('Author', 'Series', 'Zebra Book'), {
      bookId: 'author__series__zebra-book',
      manuscriptId: `mns_${randomUUID()}`,
      title: 'Zebra Book',
      author: 'Author',
      language: 'ru',
    });

    const lines = await captureLog(() => main(['--apply'], booksRoot));

    // The run reached the healthy book after the unreadable one.
    const healthyWritten = readState(healthyStatePath);
    assert.equal(healthyWritten.language, 'ru');

    const lockedLine = lines.find((l) => l.includes('Locked Book'));
    assert.ok(lockedLine, 'must print a line for the unreadable book');
    assert.match(lockedLine, /read error/);
    assert.doesNotMatch(lockedLine, /corrupt JSON/);
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
