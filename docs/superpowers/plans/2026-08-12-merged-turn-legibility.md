# Merged-turn legibility — implementation plan (#2267)

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Replace plan 247's broken structural acceptance criterion with a
worst-paragraph merged-turn count computed from the manuscript, emitted into
the analysis provenance report.

**Architecture:** One new pure module reads chapter text and returns the
maximum number of merged dialogue turns found in any single non-dialogue
paragraph. `analysis.ts` accumulates the per-chapter maximum and merges it into
the provenance report independently of `aggregateStructureReports`.

**Tech Stack:** TypeScript, Node, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-merged-turn-legibility-design.md`
— the design of record. Read it before Task 1; §2 defines the metric exactly
and §2.1 records which alternatives were tried and refuted.

## Global Constraints

- The metric is `Math.max` over paragraphs — **never a sum and never a rate**.
  Spec §2.1 records why; a rate was specified first and failed review.
- **No paragraph is excluded, including one that itself opens with a dash**
  (post-ship correction, #2275 C1 — an earlier revision skipped dash-opening
  paragraphs via `dialogueOpen`; under a maximum that hid real merges for
  free and was removed. `dialogueOpen` now gates only language applicability,
  spec §2.3). **Do not** exclude quote-opening paragraphs either — that was
  tried and it drops real narration paragraphs beginning with a quoted place
  name.
- `undefined`, never `0`, when `conventions.dialogueOpen` is null. A `0` would
  read as "this book is clean" for a language the probe cannot score.
- `BookStateJson.analysisProvenance.maxMergedTurnsInParagraph` is **optional
  and additive**. No `CURRENT_STATE_SCHEMA` bump. Absent ≠ zero; no reader may
  default it to 0. Post-ship correction (#2275 C3): lives as a **sibling** of
  `analysisProvenance.report`, not nested inside `AnalysisProvenanceReport` —
  folding it into `report` fabricated a zeroed report on a fully-cached run
  where the engine never ran at all.
- Do not extend `EngineReport`, and do not route the value through
  `aggregateStructureReports` (spec §4 — it returns `undefined` for a
  fully-cached book, which would defeat the metric's purpose).
- Threshold for docs: **≥ 10 merged turns in one paragraph = degraded.**

---

### Task 1: The `legibility` module

**Files:**
- Create: `server/src/analyzer/dialogue-structure/legibility.ts`
- Create: `server/src/analyzer/dialogue-structure/legibility.test.ts`

**Interfaces:**
- Consumes: `LanguageConventions` from `./types.js`.
- Produces: `measureChapterLegibility(body: string, conventions: LanguageConventions): number | undefined`

- [x] **Step 1: Write the failing tests.**

```ts
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
```

- [x] **Step 2: Run them and confirm they fail** with "does not provide an export named" / module not found.

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/legibility.test.ts`

- [x] **Step 3: Implement.**

> **The code block below is the AS-SPECIFIED version and is now STALE — do not
> copy it.** Its `dialogueOpen.test(paragraph)` skip was removed by #2275 C1
> (see Global Constraints above): under a maximum, skipping dash-opening
> paragraphs hid five real breaching paragraphs across the calibration corpus
> while suppressing zero false positives. The shipped module counts every
> non-blank paragraph. Kept unedited as the record of what was originally
> specified; `server/src/analyzer/dialogue-structure/legibility.ts` is the
> truth.

```ts
import type { LanguageConventions } from './types.js';

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;
/* A dialogue turn opening mid-paragraph: sentence-final punctuation (or a
   colon, which introduces speech) + dash + uppercase. The uppercase lookahead
   is what excludes intra-word hyphens (где-то) and punctuation dashes followed
   by lowercase. */
const TURN_IN_PARAGRAPH = new RegExp(String.raw`([.!?…:])\s+${DASH}\s+(?=\p{Lu})`, 'gu');

/** Worst-paragraph merged-turn count for one chapter — the largest number of
    dialogue turns found inside any single paragraph that is NOT itself a
    properly-formed dialogue paragraph. In a language that gives every turn its
    own paragraph, such a turn cannot occur in correctly-converted text, so
    this counts conversion damage (#2254) directly rather than inferring it
    from engine confidence.

    A MAXIMUM, deliberately: false positives are sparse (a legitimate
    narration-then-quoted-speech paragraph yields 1-2) while a genuine merge is
    dense (dozens), and a maximum separates those by an order of magnitude
    where any sum or rate cannot. See the design of record, §2.1.

    `undefined` — never 0 — when the language has no paragraph-dash convention:
    the probe cannot score it, and 0 would read as "clean". */
export function measureChapterLegibility(
  body: string,
  conventions: LanguageConventions,
): number | undefined {
  const { dialogueOpen } = conventions;
  if (!dialogueOpen) return undefined;
  let worst = 0;
  for (const paragraph of body.split('\n')) {
    if (!paragraph.trim() || dialogueOpen.test(paragraph)) continue;
    const n = (paragraph.match(TURN_IN_PARAGRAPH) ?? []).length;
    if (n > worst) worst = n;
  }
  return worst;
}
```

- [x] **Step 4: Run the tests and confirm they pass.**
- [x] **Step 5: Commit** — `feat(server): measure worst-paragraph merged turns (#2267)`

---

### Task 2: Emit it into the provenance report

**Files:**
- Modify: `server/src/workspace/scan.ts` — add the optional field.
- Modify: `server/src/routes/analysis.ts` — accumulate + merge + operator log.
- Modify: `server/src/routes/analysis.test.ts` (or the nearest existing suite).

**Interfaces:**
- Consumes: `measureChapterLegibility` from Task 1.
- Produces: `AnalysisProvenanceReport.maxMergedTurnsInParagraph?: number`

- [x] **Step 1: Add the field**, mirroring how `unresolved` is declared, with a
  doc comment stating **absent ≠ zero** and that `undefined` means the language
  has no dash convention.

```ts
  /** #2267 — worst-paragraph merged dialogue-turn count across the book
      (max, not sum). ABSENT means not measured: either an older analysis, or
      a language with no paragraph-dash convention. Never default it to 0 —
      0 means "measured clean", absent means "not measured". */
  maxMergedTurnsInParagraph?: number;
```

- [x] **Step 2: Write the failing tests.** Two cases matter:
  1. a book whose chapters yield 3 and 11 reports **11**, not 14;
  2. the value is emitted **even when no `EngineReport` exists at all** (the
     fully-cached-book case, spec §4) — i.e. it does not vanish when
     `aggregateStructureReports` returns `undefined`.

- [x] **Step 3: Run them and confirm they fail.**

- [x] **Step 4: Implement.** Where `analysis.ts` already has each chapter's
  `body` and resolved `conventions` (the same place `parseChapterStructure` is
  called, near the `crossExamine` call at ~`:2224`), call
  `measureChapterLegibility` and keep a running `Math.max`. After
  `aggregateStructureReports(...)` returns, merge the value in — constructing a
  report carrying only this field if the aggregate returned `undefined`. Add
  `merged=` to the per-chapter operator log line beside `unresolved=`.

- [x] **Step 5: Run the tests and confirm they pass.**
- [x] **Step 6: Run** `npm run typecheck` **and** `cd server && npx vitest run src/routes/analysis` **and confirm green.**
- [x] **Step 7: Commit** — `feat(server): report worst-paragraph merged turns in analysis provenance (#2267)`

---

### Task 3: Move the documents off the disowned 44% bar

**Files (all listed in spec §7):**
- Modify: `docs/features/247-dialogue-structure-attribution.md`
- Modify: `docs/testing/night-watch-reanalysis-onbox-acceptance.md` (:239, :250)
- Modify: `docs/superpowers/plans/2026-08-11-dialogue-convention-invariant.md` (~:1636)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [x] **Step 1:** In plan 247, restructure target 1 per spec §3 — 1a renamed to
  **Review burden** with no bar and no structural claim, 1b unchanged, **1c**
  added with the §2.2 calibration table and the `< 10` bar. **Rewrite** the
  "What a 1a breach means" paragraph under 1c rather than moving it (spec §3
  says exactly what survives and what cannot).
- [x] **Step 2:** In the run sheet, replace the 1a row and the **C2 passes**
  criterion. C2 must grade on 1c, not on `≤ 44%`.
- [x] **Step 3:** In the 2026-08-11 plan, annotate the 38.9%→44% derivation as
  superseded with a dated pointer. Do **not** rewrite history — annotate.
- [x] **Step 4:** Append the release-notes entries (technical + brand-voice).
- [x] **Step 5: Commit** — `docs(docs): re-specify plan 247 target 1 around merged-turn legibility (#2267)`
