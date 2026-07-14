# fs-59 CJK (Chinese / Japanese) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end Chinese (`zh`) and Japanese (`ja`) support — analysis + synthesis on both Qwen and Coqui XTTS — reusing the shipped fs-50 language framework.

**Architecture:** CJK is a follow-on to fs-50 (registry + server-side detection + dual-gate rollout). Detection already routes Han→`zh` / Kana→`ja`; adding registry rows flips it on. The CJK-specific work is: a per-paragraph CJK sentence-split (`Intl.Segmenter`), a CJK-aware dup-key floor in the coverage guard, `dialogue-structure/lang/{zh,ja}` convention tables, per-language prompt examples, Qwen CJK calibration ref-text, and a Coqui `ENGINE_LANGUAGE_SUPPORT` extension + `zh`→`zh-cn` code map. A **language-agnostic attribution eval harness** lands first (Wave 1) as the gate every language needs. `supported` flips per language only after an on-box dual gate (Wave 5).

**Tech Stack:** TypeScript (server, Vitest + node env), Python (tts-sidecar, pytest), `Intl.Segmenter` (Node/ICU built-in, no new dep), Qwen + Coqui XTTS v2 sidecar engines.

**Design spec:** `docs/superpowers/specs/2026-07-13-fs59-cjk-support-design.md` — read §2.1 (empirical validation) before touching the coverage guard.

## Global Constraints

- **No new runtime dependency.** Segmentation uses `Intl.Segmenter` (Node/ICU built-in). Never add jieba/fugashi/nodejieba. (Confirmed: `node >=20.19.0`, `.nvmrc` 24, full-ICU default.)
- **Ship `supported:false` through W1–W4.** Only Wave 5 flips `zh`/`ja` to `supported:true`, per-language (independent — a JA miss does not hold ZH), and only after the on-box dual gate.
- **Every task lands paired automated tests** (project rule). New behaviour → new test; bug fix → a test that fails before / passes after.
- **Registry knob rule:** any `registry.ts` config knob added needs `npm run config:sync` in the same commit.
- **Scope: Chinese + Japanese only.** Korean (`ko`) is explicitly OUT (spaced Hangul, no shared foundations) → fs-70. Do not add `ko`.
- **Self-detecting, not language-threaded:** the coverage-guard and `isNarrativeLine` fixes key off per-text Han/Kana presence, NOT a threaded book-language param (those seams have none).
- **Reconcile, don't absorb:** Wave 5 reconciles fs-70 (#1303) by reference (marks its zh-cn/ja slice done-by-fs-59, narrows its charter). Do not silently delete fs-70.

---

## Wave 1 — Attribution eval harness (language-agnostic · own PR)

Net-new infra. Lives under a new `server/src/analyzer/attribution-eval/`. Proven on an English fixture so it needs no fluent CJK labeler. Consumed by the Wave-5 gate for every language.

### Task 1.1: Labelled-sample schema + loader

**Files:**
- Create: `server/src/analyzer/attribution-eval/schema.ts`
- Test: `server/src/analyzer/attribution-eval/schema.test.ts`

**Interfaces:**
- Produces: `interface LabelledChapter { chapterText: string; lines: Array<{ text: string; speakerId: string }> }`; `function parseLabelledChapter(json: unknown): LabelledChapter` (zod-validated; throws on malformed input).

- [ ] **Step 1: Write the failing test** — a valid object parses; a missing `speakerId` throws.

```ts
import { describe, it, expect } from 'vitest';
import { parseLabelledChapter } from './schema.js';

describe('parseLabelledChapter', () => {
  it('accepts a well-formed labelled chapter', () => {
    const ok = { chapterText: 'Hello. World.', lines: [{ text: 'Hello.', speakerId: 'narrator' }] };
    expect(parseLabelledChapter(ok).lines).toHaveLength(1);
  });
  it('rejects a line missing speakerId', () => {
    const bad = { chapterText: 'x', lines: [{ text: 'x' }] };
    expect(() => parseLabelledChapter(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd server && npx vitest run src/analyzer/attribution-eval/schema.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — a zod schema (`zod` is already a dep; see `gemini.ts`) with `chapterText: z.string()`, `lines: z.array(z.object({ text: z.string(), speakerId: z.string() }))`, and `parseLabelledChapter = (j) => LabelledChapterSchema.parse(j)`.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit** — `feat(server): attribution-eval labelled-chapter schema (fs-59 W1)`.

### Task 1.2: Scorer (id-alignment → FP/FN)

**Files:**
- Create: `server/src/analyzer/attribution-eval/scorer.ts`
- Test: `server/src/analyzer/attribution-eval/scorer.test.ts`

**Interfaces:**
- Consumes: `LabelledChapter` (Task 1.1); analyzer output shaped as `Array<{ text: string; characterId: string }>` (the stage-2 sentence shape).
- Produces: `interface AttributionScore { truePositive: number; falsePositive: number; falseNegative: number; segMismatch: number; precision: number; recall: number; perLine: Array<{ text: string; truth: string | null; predicted: string | null; correct: boolean }> }`; `function scoreAttribution(truth: LabelledChapter, predicted: Array<{ text: string; characterId: string }>, aliasMap?: Map<string,string>): AttributionScore`. (`segMismatch` = predicted lines whose normalised text has no truth match — a segmentation-drift signal, kept separate from attribution FP.)

**Design notes (from spec §3.4):** align by `text` after the same normalisation `stage2-coverage.ts` `words()` uses (so smart quotes / spacing don't misalign). `aliasMap` collapses truth↔predicted id differences (alias-merge / id-stability): apply it to BOTH ids before comparing. A predicted line whose normalised text isn't in truth is a **`segMismatch`** (segmentation drift — a separate metric, NOT an attribution FP); a truth line with no matching prediction is an FN; a match with the wrong (alias-resolved) id is both an FP and an FN for that line.

**Alignment must tolerate segmentation drift (stage-2 is stochastic) AND duplicate lines.** Do NOT align by index or assert `predicted.length === truth.length` — a fresh analyzer run can segment differently than when the fixture was labelled, so a hard length check would flake on exactly the non-determinism the coverage guard exists for. **Do NOT use a plain `Map<normalisedText, speakerId>` either** (independent-review finding): repeated dialogue with different speakers — `「はい」` by A then by B, common in the dialogue-heavy CJK chapters W5 mandates — collapses last-write-wins and mis-counts. Instead **align order-aware over occurrences**: group truth lines by normalised text into a queue per key (preserving order), and walk predicted lines in order, consuming the next unused truth occurrence of that text. For each predicted line — matched+right id = TP, matched+wrong id = FP&FN, **normalised text with no remaining truth occurrence = `segMismatch`** (a separate metric, not silently an FP); any truth occurrence never consumed = FN. Emit `segMismatch` so drift is visible without hard-failing. Best practice to keep drift low (Task 1.3 / 5.2): build labelled chapters ON the analyzer's own segmentation — run it once, correct only `speakerId`, never re-segment by hand — so segmentation matches and `segMismatch` stays near zero.

- [ ] **Step 1: Write the failing test** — perfect match scores precision=recall=1.0; a single mis-attribution produces FP=FN=1; an alias map rescues an id rename.

```ts
import { describe, it, expect } from 'vitest';
import { scoreAttribution } from './scorer.js';

const truth = { chapterText: '', lines: [
  { text: '"Careful."', speakerId: 'mairin' },
  { text: 'She said.', speakerId: 'narrator' },
] };

describe('scoreAttribution', () => {
  it('perfect match → precision/recall 1.0', () => {
    const pred = [{ text: '"Careful."', characterId: 'mairin' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred);
    expect(s.precision).toBe(1); expect(s.recall).toBe(1); expect(s.falsePositive).toBe(0);
  });
  it('one mis-attribution → FP and FN each 1', () => {
    const pred = [{ text: '"Careful."', characterId: 'narrator' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred);
    expect(s.falsePositive).toBe(1); expect(s.falseNegative).toBe(1);
  });
  it('alias map rescues an id rename', () => {
    const pred = [{ text: '"Careful."', characterId: 'char_7' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred, new Map([['char_7', 'mairin']]));
    expect(s.precision).toBe(1);
  });
  it('repeated identical text with different speakers is not collapsed', () => {
    const dup = { chapterText: '', lines: [
      { text: '「はい」', speakerId: 'a' }, { text: '「はい」', speakerId: 'b' },
    ] };
    const pred = [{ text: '「はい」', characterId: 'a' }, { text: '「はい」', characterId: 'b' }];
    const s = scoreAttribution(dup, pred);
    expect(s.truePositive).toBe(2); // order-aware: each occurrence matched to its own truth
    expect(s.falsePositive).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement** the scorer per the design notes. Reuse a local copy of `words()`-normalisation (or import a shared normaliser if one exists) to key lines.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit** — `feat(server): attribution-eval scorer with FP/FN + alias map (fs-59 W1)`.

### Task 1.3: English proving fixture + end-to-end harness test

**Files:**
- Create: `server/src/analyzer/attribution-eval/__fixtures__/coalfall-ch1.en.labelled.json`
- Create: `server/src/analyzer/attribution-eval/harness.test.ts`

**Interfaces:**
- Consumes: `parseLabelledChapter` (1.1), `scoreAttribution` (1.2).

- [ ] **Step 1: Build the labelled fixture ON the analyzer's segmentation** — run stage-2 attribution over `server/src/__fixtures__/the-coalfall-commission.md` Chapter One, take its emitted `{text, characterId}` lines, and hand-correct ONLY the `speakerId` (never re-split the text) so truth and future predictions share segmentation (see Task 1.2 alignment assumption). Ensure the chapter contains ≥1 interrupted-quote turn (spoken—tag—spoken) so the harness exercises the hard case (mirrors the W5 CJK requirement).
- [ ] **Step 2: Write the test** — load the fixture, feed it a **deliberately-wrong** predicted set (mis-attribute 3 lines), assert the scorer reports exactly those 3 as FP/FN; feed the correct set, assert precision=recall=1.0.
- [ ] **Step 3: Run** `cd server && npx vitest run src/analyzer/attribution-eval/harness.test.ts` → PASS.
- [ ] **Step 4: Commit** — `test(server): attribution-eval English proving fixture (fs-59 W1)`.
- [ ] **Step 5: Ship notes** — this PR closes W1; note in the PR body that the harness is language-agnostic and reusable for es/fr/de.

---

## Wave 2 — CJK analyze foundations (server · synthetic fixtures · `supported:false`)

### Task 2.1: Registry rows for zh + ja

**Files:**
- Modify: `server/src/tts/language-registry.ts` (`LanguageEntry` interface + `ENTRIES` array)
- Modify: `server/src/tts/detect-language.ts` (`:49-52` — the CJK branch **hardcodes** `supported: false`)
- Test: `server/src/tts/language-registry.test.ts`, `server/src/tts/detect-language.test.ts`

**Interfaces:**
- Modify `LanguageEntry`: widen `detect.script` to `'latin' | 'cyrillic' | 'cjk'`; add optional `promptExamples?: { roster: string; attribution: string }` (used in W3).
- Produces: `getLanguageEntry('zh')` / `('ja')` return entries; `detectManuscriptLanguage` reports `supported` **read through from the registry**, so the W5 flip actually propagates.

> **CRITICAL (independent-review finding):** the spec's "adding registry rows flips detection automatically" is FALSE as written. `detect-language.ts:49-52` returns a **literal** `{ language, supported: false }` for CJK, bypassing the `result(code)` helper the ru/latin branches use. If left as-is, flipping `zh.supported = true` at W5 does nothing — `POST /api/import` keeps reporting `languageSupported: false`, the confirm gate keeps blocking, and the whole feature is a dead end despite every wave landing green. This task MUST change that branch to `return result(kana > han ? 'ja' : 'zh')`.

- [ ] **Step 1: Write the failing test** — zh/ja resolve in the registry, and (the load-bearing one) a **temporary** registry stub with `zh.supported = true` makes `detectManuscriptLanguage(cjkText)` report `supported: true` — proving detection reads through, not hardcodes. (Since zh ships `supported:false`, assert the read-through via the helper path: e.g. a unit test that spies the registry, or assert the CJK branch calls `result()`; do NOT rely on the false==false coincidence.)

```ts
import { describe, it, expect } from 'vitest';
import { getLanguageEntry, isSupportedLanguage } from './language-registry.js';
import { detectManuscriptLanguage } from './detect-language.js';

it('zh/ja are registered but not yet supported', () => {
  expect(getLanguageEntry('zh')?.sidecarName).toBe('Chinese');
  expect(getLanguageEntry('ja')?.sidecarName).toBe('Japanese');
  expect(isSupportedLanguage('zh')).toBe(false);
});
it('detection reads supported THROUGH the registry for CJK (not a hardcode)', () => {
  // a Japanese sample → ja, and supported mirrors the registry entry (false today)
  const r = detectManuscriptLanguage('彼は歩いた。彼女は走った。'.repeat(50));
  expect(r.language).toBe('ja');
  expect(r.supported).toBe(getLanguageEntry('ja')?.supported ?? false); // read-through, not literal
});
```

- [ ] **Step 2: Run to verify it fails** (the registry entries don't exist yet).
- [ ] **Step 3a: Fix the detection read-through** — in `detect-language.ts:49-52`, replace `return { language: kana > han ? 'ja' : 'zh', supported: false };` with `return result(kana > han ? 'ja' : 'zh');` (the `result` helper reads registry `supported`). Update `detect-language.test.ts:52-56` (which pins CJK→`supported:false`) to assert read-through instead of a literal — and note it will need to accept `true` once W5 flips the rows.
- [ ] **Step 3b: Implement the registry rows** — widen the `detect.script` union; add:
  ```ts
  { code: 'zh', sidecarName: 'Chinese',  supported: false, detect: { script: 'cjk', iso6393: 'cmn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '幕'], numberWords: [], standalone: ['序章', '終章', '序', '跋', 'プロローグ', 'エピローグ'] },
    frontMatterKeywords: ['目录', '版权', '致谢', '序言', '后记', '附录', '关于作者'] },
  { code: 'ja', sidecarName: 'Japanese', supported: false, detect: { script: 'cjk', iso6393: 'jpn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '話', '幕'], numberWords: [], standalone: ['序章', '終章', 'プロローグ', 'エピローグ', 'あとがき', '前書き'] },
    frontMatterKeywords: ['目次', '著作権', '献辞', '謝辞', 'まえがき', 'あとがき', '付録', '著者について'] },
  ```
  (Adjust the exact heading/front-matter terms with a native reviewer at W5 — these are the starting set.)
  **NOTE:** the `headingLexicon.keywords` alone do NOT split CJK chapters — the
  `parsers/text.ts` regex expects `keyword → whitespace → number` (Latin shape),
  but CJK is the circumfix `第<number>章` with no whitespace and kanji numerals.
  Chapter splitting is handled by **Task 2.6**, not by this lexicon. Keep the
  `frontMatterKeywords` here (those DO feed `FRONT_MATTER_RX` as substrings).
- [ ] **Step 4: Run to verify it passes.** Also confirm `detect-language.test.ts` still green (detection already routed zh/ja; now `supported` reads through).
- [ ] **Step 5: Commit** — `feat(server): register zh/ja (supported:false) (fs-59 W2)`.

### Task 2.2: CJK sentence split in `stage2-chunk`

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts` (`splitParagraphIntoSentences`, `:122`)
- Test: `server/src/analyzer/stage2-chunk.test.ts`

**Interfaces:**
- `splitParagraphIntoSentences(para, charBudget)` signature unchanged; behaviour gains a CJK branch (self-detecting).

**Design note:** keep the existing Latin path. Add: if the paragraph contains Han/Kana (`/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u`) and the Latin split yields ≤1 unit, split via `Intl.Segmenter(lang, { granularity: 'sentence' })` where `lang` is `'ja'` if any Kana present else `'zh'`. Reassemble under `charBudget` — but **join CJK segments with NO separator** (independent-review finding: the Latin reassembly joins packed sentences with a space at `stage2-chunk.ts:133`, `` `${cur} ${s}` ``; injecting ASCII spaces into CJK prose is lossy — `chunks.join('')` would no longer equal `para`). Use an empty joiner on the CJK branch.

- [ ] **Step 1: Write the failing test** — a spaceless CJK paragraph with three `。` sentences splits into ≥3 chunks under a small budget (today it returns `[para]`).

```ts
it('splits a spaceless CJK paragraph on 。 boundaries, lossless with no injected spaces', () => {
  const para = '彼は歩いた。彼女は走った。二人は止まった。';
  const chunks = splitParagraphIntoSentences(para, 14); // packs ~2 segments/chunk → exercises the joiner
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join('')).toBe(para);        // no ASCII space injected (would fail with the Latin space-join)
  expect(chunks.join('')).not.toContain(' '); // belt-and-suspenders
});
```

- [ ] **Step 2: Run to verify it fails** (current split returns `[para]`).
- [ ] **Step 3: Implement** the CJK branch with `Intl.Segmenter` sentence granularity, self-detecting the language.
- [ ] **Step 4: Run to verify it passes;** confirm existing Latin tests stay green.
- [ ] **Step 5: Commit** — `fix(server): CJK sentence-split fallback in stage2-chunk (fs-59 W2)`.

### Task 2.3: CJK-aware dup-key floor in coverage guard

**Files:**
- Modify: `server/src/analyzer/stage2-coverage.ts` (`findDuplicatedBlock`, the `key.length < 8` skip, `:117`)
- Test: `server/src/analyzer/stage2-coverage.test.ts`

**Design note (spec §2.1 — the ONE real CJK coverage bug):** the `<8`-char key skip blinds the dup-detector to short CJK dialogue lines (~80% of CJK dialogue keys are shorter), so a CJK repeat-loop of short quotes passes (measured ratio 1.15, dup=false). Fix: make the floor script-aware — for a key containing Han/Kana, use a **character-count floor of 2** (a 2-char CJK clause is meaningful) instead of 8. Do NOT change `words()` or the ratio band (verified irrelevant — ratio is scale-invariant; mild truncation passing at 0.70 is by-design and language-agnostic).

- [ ] **Step 1: Write the failing test** — a chapter of short CJK dialogue lines with a 4-run repeat is flagged as a duplicated block (today it isn't).

```ts
it('flags a CJK short-dialogue repeat-loop the <8 key floor used to miss', () => {
  const line = (t: string) => ({ text: t });
  const base = ['「そうだ」', '「本当に」', '「行こう」', '「まだだ」'].map(line);
  const sentences = [...base, ...base]; // a 4-run repeat at constant offset
  const v = validateStage2Coverage('', sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS);
  expect(v.duplicatedBlock).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** (short keys skipped → no dup).
- [ ] **Step 3: Implement** — in `findDuplicatedBlock`, replace `if (key.length < 8) return;` with a script-aware floor: compute `const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(key);` and `if (key.length < (hasCjk ? 2 : 8)) return;`.
- [ ] **Step 4: Run to verify it passes;** add a guard test that a *faithful* CJK attribution still scores `ok: true` (no new false positive).
- [ ] **Step 5: Commit** — `fix(server): CJK-aware dup-key floor in stage2 coverage guard (fs-59 W2)`.

### Task 2.4: `isNarrativeLine` CJK fix

**Files:**
- Modify: `server/src/analyzer/strip-front-matter.ts` (`isNarrativeLine`, `:32`)
- Test: `server/src/analyzer/strip-front-matter.test.ts`

**Design note:** two Latin assumptions break for CJK — `line.length < 60` (CJK is denser) and `/\p{Ll}/u` (never matches caseless Han/Kana). Self-detecting fix: if the line contains Han/Kana, treat it as narrative when it has a CJK sentence ender (`[。！？…]`) and length ≥ a lower CJK threshold (e.g. 15), bypassing the lowercase test.

- [ ] **Step 1: Write the failing test.** **NOTE (independent-review finding):** `isNarrativeLine` only controls WHEN the author/title-echo strip region ends; with `opts = {}` nothing is ever stripped, so a test with no author/title echo passes trivially and guards nothing. The failing test needs an author/title echo line placed AFTER a CJK narrative line — today the narrative line is mis-classified (never narrative → region stays open → the later echo is wrongly stripped); after the fix the narrative line closes the region and the echo survives.

```ts
it('a CJK narrative line closes the front-matter region so a later author echo is NOT stripped', () => {
  // 献辞 (dedication) → narrative line → then a line equal to the author name
  const body = '献辞\n\n彼は古い石段の上で足を止め、霧に沈んだ谷を見下ろした。\n\n田中太郎';
  const out = stripFrontMatterBoilerplate(body, { author: '田中太郎' });
  expect(out).toContain('彼は古い石段');   // narrative kept
  expect(out).toContain('田中太郎');        // author echo AFTER a real narrative line is NOT front-matter
});
```

- [ ] **Step 2: Run to verify it fails** (`\p{Ll}` never matches Han/Kana → the narrative line never closes the region → the trailing `田中太郎` is stripped as a byline echo).
- [ ] **Step 3: Implement** the self-detecting CJK branch in `isNarrativeLine`.
- [ ] **Step 4: Run to verify it passes;** English/Russian tests stay green.
- [ ] **Step 5: Commit** — `fix(server): CJK-aware isNarrativeLine (fs-59 W2)`.

### Task 2.5: CJK token-estimate divisor

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`estimateInputTokens`, `:862-899`)
- Test: `server/src/analyzer/gemini.test.ts`

**Design note:** add `HAN_KANA_CHARS_PER_TOKEN = 1.2` and a CJK-fraction measurement mirroring the existing `countCyrillic`; blend so a CJK-dense prompt uses ≈1.2 (vs Latin 4, Cyrillic 2.5).

- [ ] **Step 1: Write the failing test** — a CJK-dense string estimates ~2× the tokens the current Cyrillic/Latin interpolation gives it.

```ts
it('estimateInputTokens: CJK uses ~1.2 chars/token', async () => {
  const { estimateInputTokens } = await import('./gemini.js');
  const cjk = '彼は歩いた'.repeat(200); // 1000 CJK chars ≈ ~833 tokens at 1.2
  const est = estimateInputTokens('', wrap(cjk));
  // NOTE (independent-review): current code = ceil(1000/4) + 1000 flat margin (gemini.ts:898) = 1250,
  // so the bound MUST exceed 1250 to actually fail before the fix (post-fix ≈ 833 + 1000 = 1833).
  expect(est).toBeGreaterThan(1500);
});
```

- [ ] **Step 2: Run to verify it fails** (current: 1250 < 1500).
- [ ] **Step 3: Implement** the CJK constant + fraction measurement.
- [ ] **Step 4: Run to verify it passes;** existing Latin/Cyrillic assertions stay green.
- [ ] **Step 5: Commit** — `feat(server): CJK token-estimate divisor (fs-59 W2)`.

### Task 2.6: CJK chapter-heading split (acceptance-critical)

**Files:**
- Modify: `server/src/parsers/text.ts` (chapter-heading regex construction, `:20-52`)
- Test: `server/src/parsers/text.test.ts`

**Why this is its own task (adversarial finding):** "a CJK book splits into chapters" is a #1004 acceptance criterion. The existing `CHAPTER_HEADING_RE` is `^(?:…|(KEYWORD)\s+(NUMBER)\b|(STANDALONE)\b)` — it requires `keyword → whitespace → number` (verified `parsers/text.ts:48-52`). CJK headings are the **circumfix** `第<number>章` — keyword *after* the number, **no whitespace**, and **kanji numerals** (一二三…十百) that `NUMBER_PART` (`[ivxlcdm\d]+`) doesn't match. So the heading lexicon (Task 2.1) cannot split CJK chapters; a dedicated pattern is required, or CJK books collapse to one chapter.

**Entry point (verified):** the splitter is `parseText(text, { format })` (`parsers/text.ts:231`), which tests `normaliseHeading(line)` against `CHAPTER_HEADING_RE` (`:51`, applied `:271`) and flushes a chapter per match. `normaliseHeading` (`:127`) only strips edge non-`\p{L}\p{N}` chars, so `第一章`/`第2章` survive intact (all Han/digit); `MAX_HEADING_LEN` (120) is fine for short CJK headings. **So the ONLY change is `CHAPTER_HEADING_RE` — no `normaliseHeading` change needed.**

**Design note — must be WHOLE-LINE anchored (independent-review finding: a naive prefix regex deletes prose).** A prefix-only `^第[…]+[章話…]` misfires on line-initial body sentences — verified with `node`: `第三章で述べたように、…` ("As stated in chapter 3, …") and `第二部隊が丘を越えて進軍した。` (`第N部隊` compound) both MATCH, and in `parseText` a matched line is **consumed as the chapter title and removed from the body** → silent data loss per misfire. Requirements for the CJK alternative:
- **Anchor the whole line** (or allow only a trailing separator/subtitle): the number+ender must be followed by end-of-normalised-line or a separator (`：:—-　` / whitespace), NOT arbitrary prose. e.g. `^第[0-9０-９〇一二三四五六七八九十百千]+[章話回節部幕巻](?:\s|[：:—-]|$)` and reject if the line continues with kana/particles (`で`, `が`, `の`, `は`…).
- **Include fullwidth digits** `０-９` (U+FF10–FF19) — common in JA headings; verified the kanji-only class misses `第１章`.
- **CJK-appropriate length cap** — `MAX_HEADING_LEN` (120) is ~2 CJK sentences; a real CJK heading is short, so gate the CJK branch on a tighter length (e.g. ≤ 20 chars) to refuse `第三章で述べた…`.
- Make the STANDALONE match `\p{Script=Han}`/Katakana-aware for `序章`/`終章`/`プロローグ` (trailing `\b` unreliable after CJK — anchor on line end).
Self-detecting (fires only on CJK glyphs); no book-language threading.

- [ ] **Step 1: Write the failing test** — headings split; **the misfire cases do NOT** (this is the load-bearing guard).

```ts
import { parseText } from './text.js';

it('splits CJK headings but does not eat 第N-prefixed prose', () => {
  const body = [
    '第一章', '', '彼は歩いた。第三章で述べたように、彼は振り返らなかった。', '',
    '第２章', '', '第二部隊が丘を越えて進軍した。二人は止まった。', '',
    '第十二話', '', '終わり。',
  ].join('\n');
  const { chapters } = parseText(body, { format: 'plaintext' });
  expect(chapters.length).toBe(3);                       // 第一章 / 第２章 / 第十二話
  expect(chapters.map((c) => c.body).join('')).toContain('第三章で述べた'); // prose NOT deleted
  expect(chapters.map((c) => c.body).join('')).toContain('第二部隊が丘');   // compound NOT a title
});
```

- [ ] **Step 2: Run to verify it fails** (`cd server && npx vitest run src/parsers/text.test.ts` — today: 1 chapter; a naive regex would instead delete the two prose lines).
- [ ] **Step 3: Implement** the whole-line-anchored CJK alternative in `CHAPTER_HEADING_RE` + fullwidth+kanji numerals + the tighter CJK length gate + CJK-aware standalone.
- [ ] **Step 4: Run to verify it passes;** confirm English/ES/RU heading tests stay green (the new alternative only fires on CJK glyphs, whole-line anchored).
- [ ] **Step 5: Commit** — `fix(server): CJK 第N章 chapter-heading split (fs-59 W2)`.

**Follow-up (issue #1576, fixed before W5):** the shipped Step 3 only routed the
*full-form* CJK standalone terms (`序章`/`終章`/`プロローグ`/`エピローグ`) into the
whole-line-anchored alternative; the single-token terms also in the registry's
`headingLexicon.standalone` — `序`/`跋` (zh), `あとがき`/`前書き` (ja) — were still
falling through to the `\b`-bounded `ALL_STANDALONE` alternative, and `\b` never
borders a CJK codepoint, so those four terms silently never split. Fixed by
partitioning the registry's standalone-term union on `hasCjkChar` at module load
(new `server/src/util/cjk.ts`) rather than hardcoding a second list: the CJK
subset feeds the whole-line-anchored alternative (alongside the four full-form
terms above), the rest still feeds the `\b`-bounded one. Same fix also unified
the two divergent CJK char-class regexes flagged by the Wave 2 review
(`analyzer/gemini.ts` `countHanKana`, `analyzer/strip-front-matter.ts`
`CJK_CHAR`) onto the shared `\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}`
form. See `server/src/parsers/text.test.ts` (CJK chapter-splitting describe
block) and `server/src/util/cjk.test.ts`.

### Task 2.7: CJK word-count / front-matter miscount at import (independent-review finding)

**Files:**
- Modify: `server/src/routes/import.ts` (`countWords` `:73`; `isLikelyFrontMatter` `:161-163`)
- Test: `server/src/routes/import.test.ts`

**Why:** `countWords` (`:73`) splits on `\s+`; a spaceless CJK chapter yields ~1 "word" per paragraph, so a full CJK novel chapter counts ~30–60 "words" and trips `isLikelyFrontMatter: … || (wordCount > 0 && wordCount <= FRONT_MATTER_WORD_THRESHOLD /*150*/)` (`:161-163`). Result: **every chapter of a CJK book is pre-ticked for exclusion** on the confirm screen, and the book-level `wordCount` is nonsense — so "a CJK book splits into chapters" (issue acceptance) is hollow because the chapters are then auto-excluded.

**Design note:** make the word count script-aware — for CJK text, count Han/Kana characters as word-equivalents (or divide char-count by ~1.7) rather than whitespace tokens. Self-detecting on Han/Kana presence; keep the Latin path byte-identical.

- [ ] **Step 1: Write the failing test** — a spaceless CJK chapter of ~2000 characters is NOT flagged `isLikelyFrontMatter` and reports a plausible word count (hundreds, not ~40).
- [ ] **Step 2: Run to verify it fails** (CJK chapter counts ~40 "words" → flagged front-matter).
- [ ] **Step 3: Implement** the script-aware count.
- [ ] **Step 4: Run to verify it passes;** English/Latin import tests stay green.
- [ ] **Step 5: Commit** — `fix(server): CJK-aware import word count / front-matter flag (fs-59 W2)`.

---

## Wave 3 — CJK dialogue conventions + prompts (server)

### Task 3.1: `lang/zh.ts` + `lang/ja.ts` convention tables

**Files:**
- Create: `server/src/analyzer/dialogue-structure/lang/zh.ts`, `.../ja.ts`
- Modify: `server/src/analyzer/dialogue-structure/lang/index.ts` (`TABLES` map)
- Test: `server/src/analyzer/dialogue-structure/lang/index.test.ts` + `parser.test.ts`

**Interfaces:** each file exports a `LanguageConventions` (see `../types.ts`) named `zh` / `ja`, registered in `TABLES`.

**Design note:** `dialogueOpen: null` (no dash-dialogue); `quotePairs` — `ja`: `[['「','」'],['『','』']]`; `zh`: `[['「','」'],['『','』'],['“','”']]` (Simplified uses fullwidth `“”`). `nameStemmer: (t) => t` (identity, no inflection); `minStemLength: 1`. `speechVerbStems` (substring-matched): zh `['说','道','问','答','喊','叫','回答','说道','问道','喃喃','低语']`; ja `['言','話','答','尋','叫','呟','囁','続け','応え']`. `beatVerbStems`: zh `['点头','笑','皱眉','叹']`; ja `['頷','笑','頬','息']`. `pronouns`: zh `{ firstPerson: /我/u, male: /他/u, female: /她/u }`; ja `{ firstPerson: /(私|僕|俺)/u, male: /彼(?!女)/u, female: /彼女/u }`.

- [ ] **Step 1: Write the failing test** (`index.test.ts`) — `conventionsFor('zh')` and `('ja')` are non-null with the expected quote pairs.

```ts
it('registers zh/ja conventions', () => {
  expect(conventionsFor('ja')?.quotePairs).toContainEqual(['「', '」']);
  expect(conventionsFor('zh')?.quotePairs).toContainEqual(['“', '”']);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** both files + register in `TABLES`.
- [ ] **Step 4: Add a `parser.test.ts` case** — a JA line `「気をつけて」と彼女は言った。` attributes the spoken span to the speaker and the tag to narrator (the §2.1 interrupted-quote defect target). Run; PASS. **NOTE (independent-review):** `彼女` is a *pronoun* — it passes via the pronoun regex and masks the fact that NAME-tag anchoring is broken for CJK (Task 3.5). Add a SECOND case using a roster NAME tag (`「わかった」と田中は言った。` → 田中) which will FAIL until Task 3.5 lands — keep it (skipped/xfail) as the driver for 3.5, so this task doesn't falsely imply name-attribution works.
- [ ] **Step 5: Commit** — `feat(server): CJK dialogue-structure conventions zh/ja (fs-59 W3)`.

### Task 3.2: CJK quote glyphs in audio-tags (roster-coverage half is moot for CJK)

**Files:**
- Modify: `server/src/parsers/audio-tags.ts` (`QUOTE_OPENS`/`QUOTE_CLOSES`, `:22-23`)
- Test: `server/src/parsers/audio-tags.test.ts`

**Scope correction (independent-review finding):** do NOT add `「」` to `roster-coverage.ts` `QUOTE_CHARS_WIDE` — `validateRosterCoverage` early-returns `{ ok: true }` when `grammarFor(language)` is null (`roster-coverage.ts:189-190`), and Task 3.4 deliberately leaves zh/ja unmapped, so that half is **unreachable dead code** for CJK. Only the audio-tags half is real. Also: the audio-tag detectors trigger on ASCII cues (e.g. `!` at `audio-tags.ts:98`, `…`); adding corner-bracket *quote* glyphs alone does NOT make `[excited]` fire on a fullwidth `！`. Scope this task to: (a) add `「『` to `QUOTE_OPENS` / `」』` to `QUOTE_CLOSES` so a tag INSIDE corner brackets is found, and (b) decide per-detector whether to add fullwidth `！？。…` triggers or document the deferral (fullwidth-punctuation audio-tag detection is a nice-to-have, not an acceptance item).

- [ ] **Step 1: Write the failing test** — a bracketed audio tag like `「[whisper] 静かに」` (or the detector's real trigger form) is recognised inside `「…」` (name the concrete detector under test).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `「『`/`」』` to the quote sets; add fullwidth punctuation triggers only where a paired detector genuinely needs it.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(server): CJK quote glyphs in audio-tag detectors (fs-59 W3)`.

### Task 3.3: CJK prompt hints + in-language few-shot examples

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`languagePreamble`, `:207-234`; the `LATIN_CONVENTIONS` map / conventions string)
- Modify: `server/src/tts/language-registry.ts` (populate `promptExamples` on zh/ja — field added in 2.1)
- Test: `server/src/analyzer/language-preamble.test.ts`

**Design note:** add a CJK conventions clause (「」/`“”` quote marking, no dash-dialogue, tag-is-narrator note) and inject the registry's in-language `promptExamples` (a short roster + an attribution example written in ZH/JA) into the preamble. Target the §2.1 interrupted-quote error with an in-language few-shot showing the second spoken half attributed to the speaker. Also extend the script-annotation at `gemini.ts:213` (`… === 'cyrillic' ? ' (Cyrillic script)' : ''`) to name the CJK script (e.g. `' (Chinese/Japanese script)'`) so the model is told the writing system, mirroring the Cyrillic branch.

- [ ] **Step 1: Write the failing test** — `languagePreamble('zh')` / `('ja')` contain the CJK convention text and the in-language example.

```ts
it('languagePreamble carries CJK conventions + in-language examples', () => {
  // NOTE (independent-review): do NOT assert on the language NAME — after Task 2.1
  // registers the rows, `where` already contains "Japanese"/"Chinese" (gemini.ts:233),
  // so /Japanese/ passes before any W3 change. Assert on the CJK-specific convention
  // text + the in-language few-shot marker instead.
  const ja = languagePreamble('ja');
  expect(ja).toContain('「');                 // corner-bracket convention hint (new in W3)
  expect(ja).toMatch(/tag[^]*narrator|話者ではない/); // interrupted-quote/tag-is-narrator few-shot
  expect(languagePreamble('zh')).toContain('“'); // zh fullwidth-quote hint
});
```

- [ ] **Step 2: Run to verify it fails** (the registered `where` string has the language name but none of the CJK convention text yet).
- [ ] **Step 3: Implement** — add the zh/ja conventions strings + wire `promptExamples`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(server): CJK prompt conventions + in-language few-shot (fs-59 W3)`.

### Task 3.4: tag-grammar gate-OFF for CJK (documented)

**Files:**
- Modify: `server/src/analyzer/tag-grammar.ts` (add an explanatory comment; leave `zh`/`ja` OUT of `TAG_GRAMMARS`)
- Test: `server/src/analyzer/tag-grammar.test.ts`

**Design note:** `grammarFor('zh'|'ja')` must return `null` (caller stays gated — a no-op). Its `nameCapture` is `[A-Z]`/`\p{Lu}`; CJK has no case, so the roster-false-positive guard is structurally inapplicable. Document the lost-net in the comment.

- [ ] **Step 1: Write the test** — `grammarFor('zh')` and `('ja')` return `null`.
- [ ] **Step 2: Run** — likely already passes (they're unmapped); this locks the invariant against a future accidental mapping.
- [ ] **Step 3: Add the explanatory comment** naming the lost-net (dialogue-structure conventions + the W1 eval harness carry CJK attribution instead).
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit** — `docs(server): document tag-grammar gate-off for CJK (fs-59 W3)`.

### Task 3.5: CJK-aware roster-name tag anchoring (independent-review finding)

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/name-matcher.ts` (`findRosterName`, `:27-35`)
- Test: `server/src/analyzer/dialogue-structure/name-matcher.test.ts` + the 3.1 name-tag `parser.test.ts` case

**Why:** `findRosterName` tokenises the tag clause with `text.toLowerCase().split(/[^\p{L}]+/u)` (`:27`). A CJK tag clause like `と田中は言った` has **no non-letter separators → one token**; with the identity `nameStemmer` (Task 3.1) the "stem" is the whole clause, so the roster lookup keyed by `田中` never hits. Result: `tag-name` evidence — the **highest-precedence** attribution anchor (`parser.ts:53-55`) — **never fires for CJK**; only the pronoun regexes work. This substantially weakens CJK attribution (and the §2.1 interrupted-quote fix leans on it).

**Design note:** add a CJK branch to `findRosterName`: when the clause contains Han/Kana, match roster name stems by **substring containment** (does the clause contain any indexed Han name stem?) instead of whitespace tokenisation. Prefer the longest match; guard against 1-char stems causing false hits (require ≥2 Han chars, or the roster name's own length). Keep the Latin/Cyrillic tokenised path unchanged.

- [ ] **Step 1: Write the failing test** — `findRosterName('と田中は言った', index)` returns the `田中` roster id (today: null). Also un-skip the 3.1 name-tag `parser.test.ts` case (`「わかった」と田中は言った。` → 田中).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the substring-containment CJK branch.
- [ ] **Step 4: Run to verify it passes;** Latin/Russian name-matching tests stay green.
- [ ] **Step 5: Commit** — `fix(server): CJK substring roster-name tag anchoring (fs-59 W3)`.

---

## Wave 4 — CJK synthesis, both engines (sidecar + server)

### Task 4a.1: Qwen CJK calibration ref-text

**Files:**
- Modify: `server/tts-sidecar/main.py` (`CALIBRATION_TEXTS` dict, `~:1888-1905`)
- Test: `server/tts-sidecar/tests/test_calibration_text.py` (create if absent)

**Design note:** add phonetically-rich `"Chinese"` and `"Japanese"` rows keyed by the sidecar language word (matching `sidecarName`). Today `_calibration_text()` falls back silently to the English pangram for any unmapped language — a CJK designed voice would fix the wrong phoneme set.

**Wave-ordering note (independent-review finding — F9):** registering zh/ja in Task 2.1 makes `sidecarLanguageName('zh')` return `'Chinese'` instead of throwing, so the spec's "CJK can't reach the sidecar" fail-loud net is gone from W2 on, while calibration lands only here (W4a). The practical guard in the W2–W4a window is that zh/ja are `supported:false`, so the confirm gate blocks the book before design/synth — but to remove the latent wrong-phoneme-bake risk entirely, **land this task (4a.1) in the same PR wave as the registry rows (or immediately after), and do NOT attempt any on-box CJK voice design until it is merged.** If W2 and W4a must ship far apart, keep zh/ja out of the registry until calibration exists.

- [ ] **Step 1: Write the failing pytest** — `_calibration_text('Chinese')` and `('Japanese')` return CJK text (contain Han/Kana), not the English pangram.
- [ ] **Step 2: Run** `npm run test:sidecar` → FAIL (falls back to English).
- [ ] **Step 3: Implement** — add the two rows (a native reviewer refines the exact ref sentences at W5).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(sidecar): Qwen CJK calibration ref-text (fs-59 W4a)`.

### Task 4a.2: EMOTION_INSTRUCT / fill-tone for CJK (or documented deferral)

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`EMOTION_INSTRUCT`, `~:119`), `server/src/analyzer/fill-tone.ts` (`NUDGES`, `:8`)
- Test: colocated `*.test.ts`

- [ ] **Step 1:** Decide per the spec — either add ZH/JA emotion/nudge phrases OR document deferral (VoiceDesign persona-stays-English is a known won't-fix). If deferring, add a code comment + a test asserting the fallback is safe (no crash, neutral behaviour). If implementing, TDD a zh/ja emotion phrase lookup.
- [ ] **Step 2–5:** test-first, implement/decide, run, commit `feat(server): CJK emotion-instruct (or documented deferral) (fs-59 W4a)`.

### Task 4b.0: XTTS language-code pre-check (BLOCKS the rest of 4b)

**Files:**
- Investigate only (no code): the installed `TTS` package's accepted language set.

- [ ] **Step 1:** In the sidecar venv, confirm XTTS v2's exact Chinese code — `zh-cn` vs `zh` vs `zh_cn` — e.g. `python -c "from TTS.tts.models.xtts import Xtts; print(...)"` or inspect the model config's `languages` list. Record the verified string.
- [ ] **Step 2:** If it is not `zh-cn`, update Task 4b.2's map accordingly before writing it. **Do not proceed to 4b.1–4b.3 until this string is verified.**

### Task 4b.1: Coqui eligibility for zh/ja

**Files:**
- Modify: `server/src/tts/voice-mapping.ts` (`ENGINE_LANGUAGE_SUPPORT.coqui`, `:41`)
- Test: `server/src/tts/language.test.ts`

- [ ] **Step 1: Write the failing test** — `resolveEligibleEngines('zh', ALL_TTS_ENGINES)` returns `['qwen','coqui']` (today `['qwen']`).

```ts
it('zh/ja are eligible on qwen + coqui', () => {
  expect(resolveEligibleEngines('zh', ALL_TTS_ENGINES).sort()).toEqual(['coqui', 'qwen']);
  expect(resolveEligibleEngines('ja', ALL_TTS_ENGINES).sort()).toEqual(['coqui', 'qwen']);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `'zh','ja'` to the `coqui` array.
- [ ] **Step 4: Run to verify it passes.** **NOTE (independent-review):** this BREAKS a pinned fs-60 test — `language.test.ts:93-95` asserts `resolveEligibleEngines('zh', ALL_TTS_ENGINES)` `.toEqual(['qwen'])`. Update it in THIS commit to `['coqui','qwen']` (it exists precisely to pin zh as Qwen-only; that invariant is what this task changes). Confirm the OTHER fs-60 eligibility tests stay green.
- [ ] **Step 5: Commit** — `feat(server): Coqui XTTS eligible for zh/ja (fs-59 W4b)`.

### Task 4b.2: `zh`→`zh-cn` Coqui language-code map

**Files:**
- Create: a small helper `coquiLanguageCode(bcp47: string): string` (in `server/src/tts/voice-mapping.ts` or `language.ts`)
- Modify: `server/src/tts/sidecar.ts` — apply the map inside `SidecarTtsProvider.synthesize` (`:100-105`), which already knows `this.engine === 'coqui'`. **This is the single clean seam** (independent-review finding) — cleaner than branching on `route.engine` at the two generic `provider.synthesize` call sites in `synthesise-chapter.ts` (`:1068`, `:1273`), and it does NOT touch the shared `langCode` (which feeds `expandForSpeech` and must keep the registry code `zh`).
- Modify: `server/src/routes/voice-sample.ts` (`:145`) — **also thread `language` here** (see below).
- Test: `server/src/tts/sidecar.test.ts` + `server/src/routes/voice-sample.test.ts`

**Second gap (independent-review finding):** `voice-sample.ts:145` calls `provider.synthesize({ text, voiceName, modelKey })` with **no `language`**, so a CJK Coqui voice sample renders through the English phonemiser (`COQUI_LANGUAGE='en'` default, `main.py:915,1105`) even after the map lands — and the Task 4b.3 listen-gate would false-fail if driven through the sample button. Thread the book/character language into this call too.

- [ ] **Step 1: Write the failing tests** — (a) `SidecarTtsProvider('coqui').synthesize({..., language: 'zh'})` sends `zh-cn` (the verified 4b.0 string) in the request body; `ja` stays `ja`; Qwen/other engines pass language through unchanged. (b) `voice-sample.ts` forwards the language to `provider.synthesize`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** `coquiLanguageCode` (identity except `zh`→`zh-cn`), apply it in `SidecarTtsProvider.synthesize` for the coqui engine, and thread language through `voice-sample.ts`.
- [ ] **Step 4: Run to verify they pass;** assert the Qwen/ASR paths still see `zh` (no leak).
- [ ] **Step 5: Commit** — `feat(server): zh→zh-cn Coqui language-code map + voice-sample language (fs-59 W4b)`.

### Task 4b.3: Coqui CJK output validation (on-box, procedure)

- [ ] Render a short ZH and JA line through Coqui XTTS with an existing `COQUI_PROFILE_VOICES` speaker, **via a path that carries language** (a chapter render, or the sample button AFTER Task 4b.2 threads language — not before, or it renders English). Confirm audio is intelligible CJK (cross-lingual voice cloning). Only if quality is unacceptable, curate a CJK speaker subset — otherwise no code. Record the result for the W5 gate.

---

## Wave 5 — Validation + flip (operator tail · own PR)

Not desk-verifiable — needs the GPU box, real weights, the operator's ears, and a fluent ZH/JA labeler.

### Task 5.1: ZH + JA Coalfall fixtures

- [ ] Obtain ZH and JA translations of *The Coalfall Commission* Chapter One (dep: **fs-61** / fluent translator), added alongside `the-coalfall-commission-{es,fr,de,ru}` samples. These feed both the labelled eval chapter and the operator audio gate.

### Task 5.2: Labelled ZH + JA chapters (harness input)

- [ ] Hand-label (fluent speaker) a ZH and a JA chapter into the W1 schema, **built on the analyzer's own segmentation** (Task 1.2 assumption: run the analyzer, correct only `speakerId`, never re-split text). **Requirement:** each MUST include (a) interrupted-quote turns (spoken—tag—spoken across a fullwidth comma — the §2.1 defect) and (b) roster-false-positive constructions (a name-like token that is not a speaker tag — the case tag-grammar gate-off no longer guards). A clean easy-case chapter hides exactly the errors this validates.

### Task 5.3: Run the W1 harness → record attribution FP/FN

- [ ] Analyse the labelled chapters (Gemini or local), run `scoreAttribution`, record ZH and JA FP/FN/precision/recall. Attribution is engine-independent — one pass covers both engines. Gate: FP/FN within the operator's accepted bound.

### Task 5.4: Operator audio gate — both engines × both languages

- [ ] Design + render ZH and JA Coalfall samples on **Qwen** and on **Coqui XTTS**. Operator listens; confirm Qwen honours a CJK persona and XTTS `zh-cn`/`ja` quality. Record per (engine × language) verdict.

### Task 5.5: Flip `supported` (per language) + reconcile fs-70

**Files:**
- Modify: `server/src/tts/language-registry.ts` (`zh.supported` / `ja.supported` → `true`, per language that passed)
- Test: an e2e detect→confirm→cast path for a CJK book once `supported`.

- [ ] **Step 1:** Flip `zh.supported` and/or `ja.supported` to `true` — **independently** (D2: a JA miss does not hold ZH). Add a regression test asserting a CJK book forces Qwen-or-Coqui (never Kokoro) and the never-cross-language invariant holds.
- [ ] **Step 2:** Update **fs-70 (#1303)**: mark its `zh-cn`/`ja` bullets done-by-fs-59; narrow its charter to the remaining XTTS languages (ko/ar/hi/nl/pl/tr/cs/hu/it/pt). Note the reconciliation on #1004 and #1303.
- [ ] **Step 3:** Fill the spec's **Ship notes** (shipped date, per-wave SHAs, W5 operator verdict, ZH/JA FP/FN, audio-gate result per engine×language, fs-70 link). Create/finalise the `docs/features/NN-fs59-cjk-support.md` regression plan and move the spec if stable.
- [ ] **Step 4: Commit** — `feat(server): flip zh/ja supported after CJK dual gate (fs-59 W5)`.

---

## Self-Review — spec coverage

- Registry rows + **detection read-through fix** (`detect-language.ts:51` hardcode) → 2.1 ✓
- **CJK chapter splitting (第N章 circumfix, whole-line anchored) → 2.6 ✓ (acceptance-critical; NOT the heading lexicon)**
- **CJK import word-count / front-matter miscount → 2.7 ✓ (else every CJK chapter auto-excluded)**
- Coverage guard (dup-key floor only; word-count ruled out) → 2.3 ✓
- Sentence split (no-space CJK join) → 2.2 ✓; isNarrativeLine → 2.4 ✓; token divisor → 2.5 ✓
- Dialogue conventions zh/ja → 3.1 ✓; **CJK roster-name tag anchoring → 3.5 ✓ (else only pronouns attribute)**; quote glyphs (audio-tags only; roster half moot) → 3.2 ✓; prompt few-shot + `promptExamples` field → 3.3 (field added 2.1) ✓; tag-grammar gate-off → 3.4 ✓
- Qwen calibration (land with/near W2 registry rows — F9) → 4a.1 ✓; emotion/nudge → 4a.2 ✓
- Coqui: zh-cn pre-check → 4b.0 ✓; eligibility (+ update pinned test) → 4b.1 ✓; code map (SidecarTtsProvider seam + voice-sample) → 4b.2 ✓; output validation → 4b.3 ✓
- Attribution eval harness (W1, own PR; order-aware scorer) → 1.1–1.3 ✓
- Fixtures / labelling / harness run / audio gate / flip / fs-70 reconcile → 5.1–5.5 ✓
- Korean explicitly excluded (Global Constraints) ✓; independent per-language flip (D2) → 5.5 Step 1 ✓
- Spec Risk 5 (messy real-world fixture): a W2 fixture MUST include a chapter with mixed ASCII/fullwidth punctuation, U+3000 ideographic spaces, and a `第N章`-headed multi-chapter body — add it to the 2.2/2.6/2.7 fixtures.

## Notes for the implementer

_Findings from an independent adversarial review are folded into the tasks above. The highest-consequence ones:_
- **`detect-language.ts:49-52` hardcodes `supported:false` for CJK** — Task 2.1 MUST change it to read through the registry, or the W5 flip is a no-op and the whole feature is a dead end (Task 2.1 CRITICAL note).
- **Task 2.6 regex must be whole-line anchored** — a naive prefix `^第[…]+[章…]` matches `第三章で述べた…` and `第N部隊…` and `parseText` then DELETES that prose as a title. Include fullwidth `０-９` + kanji numerals; cap CJK heading length.
- **Task 2.7** — a spaceless CJK chapter counts ~40 whitespace "words" → pre-ticked front-matter → auto-excluded; the chapter-split win is hollow without this.
- **Task 3.5** — `findRosterName` splits on `[^\p{L}]+`, so a CJK name tag is one token and never matches the roster; without the substring fix, CJK attribution rides on pronouns + prompt only.
- **Three placebo tests fixed** (2.4 needs an author echo; 2.5 must exceed the +1000 flat margin, bound > 1500; 3.3 must not assert on the language name — it's already in `where`). Honour "verify it fails."
- Read spec §2.1 before Task 2.3 — the coverage fix is the dup-key floor ONLY; word-level counting is verified irrelevant (ratio scale-invariant).
- Scorer (1.2): order-aware occurrence matching, NOT a `Map` (duplicate lines with different speakers must not collapse); tolerate segmentation drift via `segMismatch`, never a hard length assertion.
- Term lists in W2–W4 are starting sets; a native ZH/JA reviewer refines them at W5.
- Known-accepted v1 limits (do not over-engineer): `ja` `/彼(?!女)/` still matches 彼ら/彼氏; a 1-char CJK dup key evades the floor-2 dup-detector. Pathological; leave them.
- W4b.0 is a hard gate: verify XTTS's Chinese code before writing the map.
- W1 is a standalone PR; W2/W3 are server-only and can each be 1–2 PRs; W4/W5 are the operator-gated tail.
