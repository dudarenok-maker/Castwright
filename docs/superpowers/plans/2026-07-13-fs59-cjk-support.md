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
- Produces: `interface AttributionScore { truePositive: number; falsePositive: number; falseNegative: number; precision: number; recall: number; perLine: Array<{ text: string; truth: string; predicted: string | null; correct: boolean }> }`; `function scoreAttribution(truth: LabelledChapter, predicted: Array<{ text: string; characterId: string }>, aliasMap?: Map<string,string>): AttributionScore`.

**Design notes (from spec §3.4):** align by `text` after the same normalisation `stage2-coverage.ts` `words()` uses (so smart quotes / spacing don't misalign). `aliasMap` collapses truth↔predicted id differences (alias-merge / id-stability): apply it to BOTH ids before comparing. A predicted line whose normalised text isn't in truth is an FP; a truth line with no matching prediction is an FN; a match with the wrong (alias-resolved) id is both an FP and an FN for that line.

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

- [ ] **Step 1: Hand-label** ~30 lines of `server/src/__fixtures__/the-coalfall-commission.md` Chapter One into the schema (spoken lines → character ids matching the canned roster; narration/beats → `narrator`). Include at least one interrupted-quote turn (spoken—tag—spoken) so the harness exercises the hard case (mirrors the W5 CJK requirement).
- [ ] **Step 2: Write the test** — load the fixture, feed it a **deliberately-wrong** predicted set (mis-attribute 3 lines), assert the scorer reports exactly those 3 as FP/FN; feed the correct set, assert precision=recall=1.0.
- [ ] **Step 3: Run** `cd server && npx vitest run src/analyzer/attribution-eval/harness.test.ts` → PASS.
- [ ] **Step 4: Commit** — `test(server): attribution-eval English proving fixture (fs-59 W1)`.
- [ ] **Step 5: Ship notes** — this PR closes W1; note in the PR body that the harness is language-agnostic and reusable for es/fr/de.

---

## Wave 2 — CJK analyze foundations (server · synthetic fixtures · `supported:false`)

### Task 2.1: Registry rows for zh + ja

**Files:**
- Modify: `server/src/tts/language-registry.ts` (`LanguageEntry` interface + `ENTRIES` array)
- Test: `server/src/tts/language-registry.test.ts`, `server/src/tts/detect-language.test.ts`

**Interfaces:**
- Modify `LanguageEntry`: widen `detect.script` to `'latin' | 'cyrillic' | 'cjk'`; add optional `promptExamples?: { roster: string; attribution: string }` (used in W3).
- Produces: `getLanguageEntry('zh')` / `('ja')` return entries with `supported: false`.

- [ ] **Step 1: Write the failing test** — zh/ja resolve, are `supported:false`, and detection now returns them with `supported:false` from the registry (not a hardcode).

```ts
import { describe, it, expect } from 'vitest';
import { getLanguageEntry, isSupportedLanguage } from './language-registry.js';

it('zh/ja are registered but not yet supported', () => {
  expect(getLanguageEntry('zh')?.sidecarName).toBe('Chinese');
  expect(getLanguageEntry('ja')?.sidecarName).toBe('Japanese');
  expect(isSupportedLanguage('zh')).toBe(false);
  expect(isSupportedLanguage('ja')).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — widen the `detect.script` union; add:
  ```ts
  { code: 'zh', sidecarName: 'Chinese',  supported: false, detect: { script: 'cjk', iso6393: 'cmn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '幕'], numberWords: [], standalone: ['序章', '終章', '序', '跋', 'プロローグ', 'エピローグ'] },
    frontMatterKeywords: ['目录', '版权', '致谢', '序言', '后记', '附录', '关于作者'] },
  { code: 'ja', sidecarName: 'Japanese', supported: false, detect: { script: 'cjk', iso6393: 'jpn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '話', '幕'], numberWords: [], standalone: ['序章', '終章', 'プロローグ', 'エピローグ', 'あとがき', '前書き'] },
    frontMatterKeywords: ['目次', '著作権', '献辞', '謝辞', 'まえがき', 'あとがき', '付録', '著者について'] },
  ```
  (Adjust the exact heading/front-matter terms with a native reviewer at W5 — these are the starting set.)
- [ ] **Step 4: Run to verify it passes.** Also confirm `detect-language.test.ts` still green (detection already routed zh/ja; now `supported` reads through).
- [ ] **Step 5: Commit** — `feat(server): register zh/ja (supported:false) (fs-59 W2)`.

### Task 2.2: CJK sentence split in `stage2-chunk`

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts` (`splitParagraphIntoSentences`, `:122`)
- Test: `server/src/analyzer/stage2-chunk.test.ts`

**Interfaces:**
- `splitParagraphIntoSentences(para, charBudget)` signature unchanged; behaviour gains a CJK branch (self-detecting).

**Design note:** keep the existing Latin path. Add: if the paragraph contains Han/Kana (`/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u`) and the Latin split yields ≤1 unit, split via `Intl.Segmenter(lang, { granularity: 'sentence' })` where `lang` is `'ja'` if any Kana present else `'zh'`. Reassemble under `charBudget` exactly as the Latin path does.

- [ ] **Step 1: Write the failing test** — a spaceless CJK paragraph with three `。` sentences splits into ≥3 chunks under a small budget (today it returns `[para]`).

```ts
it('splits a spaceless CJK paragraph on 。 boundaries', () => {
  const para = '彼は歩いた。彼女は走った。二人は止まった。';
  const chunks = splitParagraphIntoSentences(para, 6); // tiny budget forces splitting
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join('')).toBe(para); // lossless
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

- [ ] **Step 1: Write the failing test** — a real CJK narrative sentence is recognised as narrative (ends the front-matter region); a short CJK heading is not.

```ts
it('treats a CJK narrative line as narrative (not front-matter)', () => {
  const body = '献辞\n\n彼は古い石段の上で足を止め、霧に沈んだ谷を見下ろした。';
  const out = stripFrontMatterBoilerplate(body, {});
  expect(out).toContain('彼は古い石段'); // narrative kept
});
```

- [ ] **Step 2: Run to verify it fails** (`\p{Ll}` never matches → line treated as front-matter, potentially stripped).
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
  const cjk = '彼は歩いた'.repeat(200); // 1000 CJK chars ≈ ~830 tokens at 1.2
  const est = estimateInputTokens('', wrap(cjk));
  expect(est).toBeGreaterThan(600); // far above the Latin /4 = 250
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the CJK constant + fraction measurement.
- [ ] **Step 4: Run to verify it passes;** existing Latin/Cyrillic assertions stay green.
- [ ] **Step 5: Commit** — `feat(server): CJK token-estimate divisor (fs-59 W2)`.

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
- [ ] **Step 4: Add a `parser.test.ts` case** — a JA line `「気をつけて」と彼女は言った。` attributes the spoken span to the speaker and the tag to narrator (the §2.1 interrupted-quote defect target). Run; PASS.
- [ ] **Step 5: Commit** — `feat(server): CJK dialogue-structure conventions zh/ja (fs-59 W3)`.

### Task 3.2: CJK quote glyphs in audio-tags + roster-coverage

**Files:**
- Modify: `server/src/parsers/audio-tags.ts` (`QUOTE_OPENS`/`QUOTE_CLOSES`, `:22`)
- Modify: `server/src/analyzer/roster-coverage.ts` (`QUOTE_CHARS_WIDE`, `:171`)
- Test: the colocated `*.test.ts` for each

- [ ] **Step 1: Write failing tests** — an audio-tag inside `「…」` is detected; a roster tag scan recognises a `「」`-quoted line.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — add `「『` to opens, `」』` to closes; add the same to `QUOTE_CHARS_WIDE`.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — `feat(server): CJK quote glyphs in audio-tags + roster guard (fs-59 W3)`.

### Task 3.3: CJK prompt hints + in-language few-shot examples

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`languagePreamble`, `:207-234`; the `LATIN_CONVENTIONS` map / conventions string)
- Modify: `server/src/tts/language-registry.ts` (populate `promptExamples` on zh/ja — field added in 2.1)
- Test: `server/src/analyzer/language-preamble.test.ts`

**Design note:** add a CJK conventions clause (「」/`“”` quote marking, no dash-dialogue, tag-is-narrator note) and inject the registry's in-language `promptExamples` (a short roster + an attribution example written in ZH/JA) into the preamble. Target the §2.1 interrupted-quote error with an in-language few-shot showing the second spoken half attributed to the speaker.

- [ ] **Step 1: Write the failing test** — `languagePreamble('zh')` / `('ja')` contain the CJK convention text and the in-language example.

```ts
it('languagePreamble carries CJK conventions + in-language examples', () => {
  expect(languagePreamble('ja')).toMatch(/「」|Japanese/);
  expect(languagePreamble('zh')).toMatch(/“”|「」|Chinese/);
});
```

- [ ] **Step 2: Run to verify it fails.**
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

---

## Wave 4 — CJK synthesis, both engines (sidecar + server)

### Task 4a.1: Qwen CJK calibration ref-text

**Files:**
- Modify: `server/tts-sidecar/main.py` (`CALIBRATION_TEXTS` dict, `~:1888-1905`)
- Test: `server/tts-sidecar/tests/test_calibration_text.py` (create if absent)

**Design note:** add phonetically-rich `"Chinese"` and `"Japanese"` rows keyed by the sidecar language word (matching `sidecarName`). Today `_calibration_text()` falls back silently to the English pangram for any unmapped language — a CJK designed voice would fix the wrong phoneme set.

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
- [ ] **Step 4: Run to verify it passes;** confirm the fs-60 eligibility tests stay green.
- [ ] **Step 5: Commit** — `feat(server): Coqui XTTS eligible for zh/ja (fs-59 W4b)`.

### Task 4b.2: `zh`→`zh-cn` Coqui language-code map

**Files:**
- Create: a small helper `coquiLanguageCode(bcp47: string): string` (in `server/src/tts/voice-mapping.ts` or `language.ts`)
- Modify: `server/src/tts/synthesise-chapter.ts` — apply the map at the **Coqui provider call only** (NOT at the shared `langCode` resolution `:884`, which feeds `expandForSpeech` and must keep the registry code `zh`)
- Test: `server/src/tts/synthesise-chapter-coqui-fallback.test.ts`

- [ ] **Step 1: Write the failing test** — a Coqui zh synth call carries `language: 'zh-cn'` (use the verified 4b.0 string); `ja` stays `ja`; a non-CJK language is unchanged.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `coquiLanguageCode` (identity except `zh`→`zh-cn`) and apply it only where the Coqui provider receives its `language`.
- [ ] **Step 4: Run to verify it passes;** assert the Qwen/ASR paths still see `zh` (no leak).
- [ ] **Step 5: Commit** — `feat(server): zh→zh-cn Coqui language-code map (fs-59 W4b)`.

### Task 4b.3: Coqui CJK output validation (on-box, procedure)

- [ ] Render a short ZH and JA line through Coqui XTTS with an existing `COQUI_PROFILE_VOICES` speaker. Confirm audio is intelligible CJK (cross-lingual voice cloning). Only if quality is unacceptable, curate a CJK speaker subset — otherwise no code. Record the result for the W5 gate.

---

## Wave 5 — Validation + flip (operator tail · own PR)

Not desk-verifiable — needs the GPU box, real weights, the operator's ears, and a fluent ZH/JA labeler.

### Task 5.1: ZH + JA Coalfall fixtures

- [ ] Obtain ZH and JA translations of *The Coalfall Commission* Chapter One (dep: **fs-61** / fluent translator), added alongside `the-coalfall-commission-{es,fr,de,ru}` samples. These feed both the labelled eval chapter and the operator audio gate.

### Task 5.2: Labelled ZH + JA chapters (harness input)

- [ ] Hand-label (fluent speaker) a ZH and a JA chapter into the W1 schema. **Requirement:** each MUST include (a) interrupted-quote turns (spoken—tag—spoken across a fullwidth comma — the §2.1 defect) and (b) roster-false-positive constructions (a name-like token that is not a speaker tag — the case tag-grammar gate-off no longer guards). A clean easy-case chapter hides exactly the errors this validates.

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

- Registry rows / detection flip → 2.1 ✓
- Coverage guard (dup-key floor only; word-count ruled out) → 2.3 ✓
- Sentence split → 2.2 ✓; isNarrativeLine → 2.4 ✓; token divisor → 2.5 ✓
- Dialogue conventions zh/ja → 3.1 ✓; quote glyphs → 3.2 ✓; prompt few-shot + `promptExamples` field → 3.3 (field added 2.1) ✓; tag-grammar gate-off → 3.4 ✓
- Qwen calibration → 4a.1 ✓; emotion/nudge → 4a.2 ✓
- Coqui: zh-cn pre-check → 4b.0 ✓; eligibility → 4b.1 ✓; code map → 4b.2 ✓; output validation → 4b.3 ✓
- Attribution eval harness (W1, own PR) → 1.1–1.3 ✓
- Fixtures / labelling / harness run / audio gate / flip / fs-70 reconcile → 5.1–5.5 ✓
- Korean explicitly excluded (Global Constraints) ✓
- Independent per-language flip (D2) → 5.5 Step 1 ✓

## Notes for the implementer

- Read spec §2.1 before Task 2.3 — the coverage fix is the dup-key floor ONLY; do not add word-level counting (verified irrelevant: ratio is scale-invariant).
- The heading/front-matter/speech-verb/calibration term lists in W2–W4 are starting sets; a native ZH/JA reviewer refines them at W5.
- W4b.0 is a hard gate: verify XTTS's Chinese code before writing the map.
- W1 is a standalone PR; W2/W3 are server-only and can each be 1–2 PRs; W4/W5 are the operator-gated tail.
