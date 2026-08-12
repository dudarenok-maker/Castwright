# Quote-delimiter validity in `findQuoteRuns` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an apostrophe being read as a closing quote, which today truncates every single-quoted English dialogue turn at its first contraction.

**Architecture:** One change to one module-private function, `findQuoteRuns` (`server/src/analyzer/dialogue-structure/parser.ts:192`). Its regex candidate scan is replaced by an explicit scan that can reject a delimiter occurrence and keep looking, gated by a new predicate `isRealCloser`. The acceptance loop below it is untouched. No language table changes, no new config, no new exports.

**Tech Stack:** TypeScript (Node, ESM), Vitest. Server suite only.

**Design of record:** `docs/superpowers/specs/2026-08-12-quote-delimiter-validity-design.md` (revision 2, commit `9fedd158`). Read it before Task 2 — the "Rejected" section explains why two other clauses are deliberately absent, and the metric section explains why the never-delete invariant exists.

## Global Constraints

- **The acceptance loop does not change.** `candidates.sort(...)` and the `cursor` loop at `parser.ts:207-214` are copied through verbatim. Every rule that touched acceptance destroyed nesting.
- **A rule may move a run boundary; it may never delete a run.** If rejecting closers leaves an opener with no valid closer, fall back to the nearest closer of any kind — what the current implementation would have chosen. Without this, 90 real paragraphs lose speech and 74 lose all of it.
- **"Letter" means `\p{L}` minus `Han`, `Hiragana`, `Katakana`, `Hangul`, `Thai`.** This is FORWARD-COVER for #2286, which adds `['‘','’']` to `zh` and `ru`. On today's tables it is unreachable — only `en` pairs an apostrophe-shaped glyph as a closer — so no test in this plan can make it fail. Keep it; do not claim it is covered.
- **No table changes.** `server/src/analyzer/dialogue-structure/lang/*.ts` are not touched by this plan. #2286 stays blocked.
- **Commit convention:** `<type>(<scope>): <subject>`, subject ≤ 100 chars. Scope is `server` for code, `docs` for docs.
- **Branch:** cut a fresh worktree + branch `fix/server-2288-quote-delimiter-validity` off latest `origin/main` before Task 1, per CLAUDE.md's branching workflow. The design worktree (`wt-2288-quote-delimiter-design`) is docs-only and is NOT the implementation tree.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/analyzer/dialogue-structure/parser.ts` | run-boundary detection | Modify `findQuoteRuns` (:192-216); add two consts + `isRealCloser` above it; delete `escapeRegExp` (:168), orphaned by this change; rewrite the `findQuoteRuns` doc comment (:179-191), which this change falsifies |
| `server/src/analyzer/dialogue-structure/parser.test.ts` | engine-path regression tests | Add four `describe` blocks + the salvaged `de` cases |
| `server/src/analyzer/dialogue-structure/lang/index.test.ts` | table guards | Widen the duplicate-pair guard to `zh`/`ja` (salvaged from PR #2286) |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | release register | Append one entry each |

Everything lives in one function because the change *is* one function. Splitting the predicate into its own module would add an import cycle risk (`server/src/gpu/` rules) for no benefit — it has one caller and is not part of any contract.

---

### Task 1: Replace the regex candidate scan with an equivalent explicit scan

Behaviour-preserving refactor, isolated from the rule so that if Task 2's tests move something unexpectedly, you know it was the rule and not the rewrite.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.ts:168` (delete `escapeRegExp`), `:192-216` (`findQuoteRuns`)
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findQuoteRuns(line: string, pairs: Array<[string, string]>): QuoteRun[]` — same signature, same behaviour.

- [ ] **Step 1: Write a characterisation test pinning current behaviour**

Append to `server/src/analyzer/dialogue-structure/parser.test.ts`:

```ts
describe('parser — findQuoteRuns candidate scan (characterisation, #2288 Task 1)', () => {
  const enIdx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const deIdx = buildNameIndex([{ id: 'anna', name: 'Anna' }], conventionsFor('de')!);
  const zhIdx = buildNameIndex([{ id: 'li', name: '李' }], conventionsFor('zh')!);
  const speechOf = (body: string, idx: ReturnType<typeof buildNameIndex>) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('de: a `„` run ends at the NEAREST of its closers, per turn (#1601)', () => {
    expect(speechOf('„Hallo", rief sie. „Nein", sagte er.', deIdx)).toEqual(['Hallo', 'Nein']);
  });
  it('de: a differently-classed nested run stays inside its outer run', () => {
    expect(speechOf('„Er sagte »hallo« zu mir“, berichtete sie.', deIdx)).toEqual([
      'Er sagte »hallo« zu mir',
    ]);
  });
  it('en: nesting resolves to the OUTER run', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.', enIdx)).toEqual(['He said ‘hi’ to me,']);
  });
  it('en: a same-glyph pair still pairs', () => {
    expect(speechOf('He said "nothing at all" and left.', enIdx)).toEqual(['nothing at all']);
  });
  it('zh: nesting resolves to the OUTER run', () => {
    expect(speechOf('“他说‘你好’然后走了”', zhIdx)).toEqual(['他说‘你好’然后走了']);
  });
});
```

- [ ] **Step 2: Run it against the UNCHANGED parser to confirm it passes**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "characterisation"`
Expected: PASS, 5 tests. If any fails, stop — the characterisation is wrong and the refactor cannot be verified against it.

- [ ] **Step 3: Replace the scan**

In `server/src/analyzer/dialogue-structure/parser.ts`, replace the body of `findQuoteRuns` between `const candidates: QuoteRun[] = [];` and `candidates.sort(...)`:

```ts
  const candidates: QuoteRun[] = [];
  for (const [open, closers] of closersByOpener) {
    let pos = 0;
    for (;;) {
      const start = line.indexOf(open, pos);
      if (start < 0) break;
      /* Nearest closer POSITION across the opener's closer set; ties go to the
         earlier entry in `closers`, matching the old alternation's
         leftmost-alternative rule. */
      let end: { at: number; glyph: string } | null = null;
      for (const closer of closers) {
        const at = line.indexOf(closer, start + open.length);
        if (at >= 0 && (end === null || at < end.at)) end = { at, glyph: closer };
      }
      if (end === null) {
        /* No closer after this opener. The old regex failed to match here and
           `lastIndex` advanced by one, so the rest of the line was NOT
           consumed and the next opener of this class still got its chance. */
        pos = start + open.length;
        continue;
      }
      candidates.push({
        start,
        end: end.at + end.glyph.length,
        openLen: open.length,
        closeLen: end.glyph.length,
      });
      /* Scanning resumes at the END of the accepted run: a second opener of
         the same class INSIDE a run yields no candidate. (Task 2 may move that
         end LATER than the old regex would have — the resume point follows the
         run, not the regex.) */
      pos = end.at + end.glyph.length;
    }
  }
```

Then delete `escapeRegExp` at `:168` — this change was its only caller.

Finally, fix the doc comment on `findQuoteRuns` (`:179-191`), which this task
makes false. It currently explains the boundary rule in terms of a regex that
no longer exists — *"the per-pair `„…"` regex would lazily run the first `„`
past an intervening `“`…"* — and closes with *"NOTE: alternation matches the
leftmost alternative, not the longest — if a future language ever pairs
prefix-related multi-char closers with one opener, order them longest-first
here."* Keep both **conclusions** (a run ends at the nearest closer position;
ties go to the earlier entry in the opener's closer list, so order
prefix-related closers longest-first) and restate them for the explicit scan.
A stale comment your own change falsified is a chore owed in the same round,
not taste — see CLAUDE.md, Incidental findings.

- [ ] **Step 4: Run the characterisation test and the whole server dialogue suite**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/`
Expected: PASS, all pre-existing tests plus the 5 new ones. Any failure here is a semantics change in the refactor — fix the scan, do not adjust the test.

- [ ] **Step 5: Typecheck (the deleted helper is the risk)**

Run: `npm run typecheck`
Expected: clean. A `'escapeRegExp' is declared but never used` or an unresolved reference means the deletion was wrong.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/dialogue-structure/parser.ts server/src/analyzer/dialogue-structure/parser.test.ts
git commit -m "refactor(server): scan quote-run candidates explicitly instead of by regex"
```

---

### Task 2: Reject apostrophe-shaped closers, with a never-delete fallback

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.ts` (add consts + `isRealCloser` above `findQuoteRuns`; extend the scan from Task 1)
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:**
- Consumes: Task 1's explicit scan.
- Produces: `isRealCloser(line: string, k: number, closer: string, openers: Set<string>): boolean` — module-private, not exported. Tested through `parseChapterStructure`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/dialogue-structure/parser.test.ts`:

```ts
describe('parser — #2288 an apostrophe is not a closing quote (en)', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // (1) a cased letter on BOTH sides — the contraction and the name
  it('a contraction does not end a single-quoted turn', () => {
    expect(speechOf('‘I don’t know,’ she said.')).toEqual(['I don’t know,']);
  });
  it('two single-quoted turns each survive their contraction', () => {
    expect(speechOf('‘We can’t go back,’ said Mary. ‘It isn’t safe.’')).toEqual([
      'We can’t go back,',
      'It isn’t safe.',
    ]);
  });
  it('an apostrophe inside a name does not end the turn', () => {
    expect(speechOf('‘Ask O’Brien,’ she said.')).toEqual(['Ask O’Brien,']);
  });

  // (2) whitespace-then-letter — elision that OPENS a word
  it('a leading-elision apostrophe does not end the turn', () => {
    expect(speechOf('‘Give ’em back,’ she said, ‘’cause they’re mine.’')).toEqual([
      'Give ’em back,',
      '’cause they’re mine.',
    ]);
  });

  // (3) opener-then-letter — turn-initial elision, which would otherwise
  //     close on an EMPTY interior and produce no speech span at all
  it('a turn-initial elision does not destroy the turn', () => {
    expect(speechOf('‘’Tis nothing,’ he said.')).toEqual(['’Tis nothing,']);
  });

  // controls — these already pass on main and must keep passing
  it('CONTROL: single-quoted turns with no apostrophe are unchanged', () => {
    expect(speechOf('‘Hello,’ he said. ‘Goodbye,’ she said.')).toEqual(['Hello,', 'Goodbye,']);
  });
  it('CONTROL: a double-quoted turn containing a contraction is unchanged', () => {
    expect(speechOf('“I don’t know,” she said.')).toEqual(['I don’t know,']);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "#2288 an apostrophe"`
Expected: 5 FAIL, 2 PASS. These are the **speech spans** the failures must
report — verified against the real parser, not derived from run boundaries (an
empty run interior produces a run but no span, which is why the last two rows
are shorter than the run count suggests):

```
‘I don’t know,’ she said.                         → ["I don"]
‘We can’t go back,’ said Mary. ‘It isn’t safe.’   → ["We can", "It isn"]
‘Ask O’Brien,’ she said.                          → ["Ask O"]
‘Give ’em back,’ she said, ‘’cause they’re mine.’ → ["Give "]
‘’Tis nothing,’ he said.                          → []          ← no speech at all
```

The last row is the strongest single piece of evidence for sub-clause (3): the
turn is not truncated, it is **erased** — the whole paragraph is narration
today.

If a test fails with a different actual value, re-run that one string through
`parseChapterStructure` before changing anything, and reconcile against this
table. Do not assume either side is right.

- [ ] **Step 3: Add the predicate**

Insert into `server/src/analyzer/dialogue-structure/parser.ts` immediately above `findQuoteRuns`:

```ts
/** Scripts with no inter-word spacing, where a delimiter with letters on both
    sides is ordinary text rather than a mis-read apostrophe.
    FORWARD-COVER, not live protection: `en` is the only shipped table pairing
    an apostrophe-shaped glyph as a closer, so today this branch is never
    reached and removing it leaves 725,066 corpus paragraphs byte-identical.
    It matters when #2286 adds ['‘','’'] to `zh` and `ru`, at which point the
    inner `’` of `“他说‘你好’然后走了”` becomes exactly the both-sides shape the
    first clause rejects. No test can make this fail yet; do not delete it as
    dead code. */
const UNSPACED_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}]/u;
/** Only `’` is reachable today: `en` is the sole table pairing an
    apostrophe-shaped glyph as a CLOSER. `'` and `‘` are carried because
    nothing stops a future table pairing them, and because this is the exact
    set the corpus and the sweep were measured against. Do not narrow it
    without re-measuring. */
const APOSTROPHE_SHAPED = new Set(['’', "'", '‘']);

function isSpacedLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch) && !UNSPACED_SCRIPT.test(ch);
}

/** Is `line[k]` really a closing delimiter, or an apostrophe? English writes
    both `’`, and `en`'s table carries ['‘','’'], so without this every
    contraction ends the run early: `‘I don’t know,’ she said.` yields the
    speech "I don" (#2288). Three shapes, all local to the glyph's neighbours:
      don’t / O’Brien   a letter on both sides
      ’em / ’cause      whitespace or a bracket, then a letter — a real closer
                        is never preceded by whitespace, it closes onto the
                        last character of the speech it terminates
      ‘’Tis             its own opener, then a letter — accepting it would
                        close on an empty interior and yield NO speech span,
                        destroying the turn rather than truncating it */
function isRealCloser(line: string, k: number, closer: string, openers: Set<string>): boolean {
  if (!APOSTROPHE_SHAPED.has(closer)) return true;
  const before = line[k - 1];
  const after = line[k + 1];
  if (isSpacedLetter(before) && isSpacedLetter(after)) return false;
  if ((before === undefined || /[\s([{]/u.test(before)) && isSpacedLetter(after)) return false;
  if (before !== undefined && openers.has(before) && isSpacedLetter(after)) return false;
  return true;
}
```

- [ ] **Step 4: Wire it into the scan, with the fallback**

In `findQuoteRuns`, add the opener set after `closersByOpener` is built:

```ts
  const openers = new Set(closersByOpener.keys());
```

and replace Task 1's inner closer search with:

```ts
      let end: { at: number; glyph: string } | null = null;
      let nearestAny: { at: number; glyph: string } | null = null;
      for (const closer of closers) {
        let from = start + open.length;
        let firstOfGlyph = true;
        for (;;) {
          const at = line.indexOf(closer, from);
          if (at < 0) break;
          if (firstOfGlyph) {
            if (nearestAny === null || at < nearestAny.at) nearestAny = { at, glyph: closer };
            firstOfGlyph = false;
          }
          if (isRealCloser(line, at, closer, openers)) {
            if (end === null || at < end.at) end = { at, glyph: closer };
            break;
          }
          from = at + closer.length;
        }
      }
      /* NEVER DELETE A RUN. If every closer after this opener is an
         apostrophe, fall back to the nearest one — i.e. exactly what this
         function chose before #2288. Truncating a turn is bad; deleting it
         turns dialogue into narration, which is worse and is the same harm
         class this change exists to fix. Measured: without this fallback the
         change loses speech in 90 real paragraphs, 74 of them entirely. */
      if (end === null) end = nearestAny;
```

The rest of the loop body from Task 1 (the `if (end === null) { pos = ...; continue; }` guard, the `candidates.push`, the `pos =` advance) is unchanged and still follows.

- [ ] **Step 5: Run the new tests**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "#2288 an apostrophe"`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole dialogue-structure suite**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/`
Expected: PASS, including Task 1's characterisation block. A regression in the `#1601` or nesting tests means the fallback is not wired correctly.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/dialogue-structure/parser.ts server/src/analyzer/dialogue-structure/parser.test.ts
git commit -m "fix(server): an apostrophe is no longer read as a closing quote"
```

---

### Task 3: Pin the never-delete invariant and the nesting-promotion cases

These are the tests that fail if a future change reintroduces candidate deletion. They pass after Task 2 — their value is as a tripwire, so they must be written to fail against a deletion, not merely to describe today's output.

**Files:**
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:** consumes Task 2's behaviour; produces nothing.

- [ ] **Step 1: Write the tests**

```ts
describe('parser — #2288 a rule may move a run boundary, never delete a run', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // All three bodies below are REAL corpus paragraphs from
  // se/anne-parrish_the-perennial-bachelor.epub. Each is an inner quotation
  // whose ONLY `’` is a contraction, so every closer is rejected and the run
  // vanishes unless the fallback restores it. Verified: each returns [] under
  // the Step 3 mutation.
  it('a quotation whose only closer is a contraction keeps its (truncated) turn', () => {
    expect(speechOf('“ ‘Shoo fly! Don’t bother me!')).toEqual(['Shoo fly! Don']);
  });

  it('the same, for a possessive', () => {
    expect(speechOf('“ ‘Ping Wing, the Pieman’s son,')).toEqual(['Ping Wing, the Pieman']);
  });

  it('the same, for a dialect elision', () => {
    expect(speechOf('“ ‘The strife is o’er, the battle done;')).toEqual(['The strife is o']);
  });

  it('a turn whose only closer is an apostrophe is truncated, never dropped', () => {
    // `’` in O’Brien is the sole `’`; the fallback restores it as the closer.
    // Without the fallback the outer run vanishes and the NESTED “hi” is
    // promoted to a top-level turn — a silent, wrong speaker change.
    expect(speechOf('‘He said “hi” to O’Brien.')).toEqual(['He said “hi” to O']);
  });

  it('the same, for a leading-elision-only paragraph', () => {
    expect(speechOf('‘He said “hi” ’cause he was late.')).toEqual(['He said “hi” ']);
  });

  it('every paragraph with at least one run keeps at least one run', () => {
    const bodies = [
      '‘I don’t know,’ she said.',
      '‘’Tis nothing,’ he said.',
      '‘Give ’em back,’ she said.',
      '‘He said “hi” to O’Brien.',
      '“ ‘Ping Wing, the Pieman’s son,',
    ];
    for (const body of bodies) expect(speechOf(body).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "never delete a run"`
Expected: PASS, 6 tests.

- [ ] **Step 3: Prove the tripwire actually trips (mutation check)**

Temporarily change the fallback line in `parser.ts` from `if (end === null) end = nearestAny;` to `if (end === null && false) end = nearestAny;`.

(Written this way, not as `if (false)`, so ESLint's `no-constant-condition` stays quiet if anyone runs `npm run lint` mid-mutation — it is `--max-warnings 0`.)

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "never delete a run"`
Expected: **FAIL, all 6.** Every body in this block was chosen because it returns `[]` under the mutation.

**This bar is the point of the task, not a formality.** An earlier draft of this block led with `“ ‘In my youth,’ said the Hermit, ‘I was a shoemaker, and fastidious.’` — which reads like a turn-loss case and is not one: both inner runs close on punctuation (`,’` and `.’`), so no closer is ever rejected and the fallback is never reached. It passed identically with and without the mutation. If any test here survives the mutation, replace its body with one that does not; do not lower the bar.

Then revert the mutation and re-run to confirm PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/analyzer/dialogue-structure/parser.test.ts
git commit -m "test(server): pin the never-delete-a-run invariant for quote runs"
```

---

### Task 4: Pin the shapes this deliberately does NOT fix

A known limit with no failing test is indistinguishable from an unknown one. These assert *today's wrong output* so a future fix has a test to flip.

**Files:**
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the tests**

```ts
describe('parser — #2288 known limits (asserted at CURRENT behaviour, not desired)', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('NOT FIXED: a possessive-plural apostrophe still ends the turn early', () => {
    // `boys’` has a letter before and a SPACE after, so none of the three
    // shapes in isRealCloser fires. Locally indistinguishable from a real
    // closer. Desired output is ['It was the boys’ fault,']; flip this test
    // when that is fixed.
    expect(speechOf('‘It was the boys’ fault,’ she said.')).toEqual(['It was the boys']);
  });

  it('NOT FIXED: German »…« emphasis glued to a word still forms a run', () => {
    const deIdx = buildNameIndex([{ id: 'anna', name: 'Anna' }], conventionsFor('de')!);
    const body = 'Woher aber der Name »Frühstücks«schiff?';
    const speech = parseChapterStructure(body, deIdx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));
    expect(speech).toEqual(['Frühstücks']);
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "known limits"`
Expected: PASS, 2 tests. If the German one fails, run the body through the parser and assert whatever it actually produces — the point is to pin it, not to predict it.

- [ ] **Step 3: Commit**

```bash
git add server/src/analyzer/dialogue-structure/parser.test.ts
git commit -m "test(server): pin the two quote-run shapes #2288 does not fix"
```

---

### Task 5: Land the #2286 salvage and the deep-nesting case

The spec's test plan calls for salvaging coverage from the blocked PR #2286.
Its `lang/index.test.ts` duplicate-pair guard and four of its `parser.test.ts`
cases assert against the **shipped** tables, so they apply with no table change
and would otherwise be owned by neither PR.

**Files:**
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`, `server/src/analyzer/dialogue-structure/lang/index.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Read the source commit**

Run: `git show b5e7a365 -- server/src/analyzer/dialogue-structure/lang/index.test.ts server/src/analyzer/dialogue-structure/parser.test.ts`

Take only the cases that pass against the shipped tables: the duplicate-pair
guard widened to `zh`/`ja`, and the `de`-table cases (`de carries no opener
beyond „ and »`, and the `#2288: de + …` counter-examples). **Do not** take
anything that asserts a widened table — those belong to #2286.

- [ ] **Step 2: Add the deep-nesting case the spec asks for**

```ts
it('an outer turn containing THREE inner quotes stays one turn', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const body = '“He said ‘hi’ and ‘bye’ and ‘hi’ to me,” she reported.';
  const speech = parseChapterStructure(body, idx)
    .flatMap((p) => p.spans)
    .filter((s) => s.kind === 'speech')
    .map((s) => body.slice(s.start, s.end));
  expect(speech).toEqual(['He said ‘hi’ and ‘bye’ and ‘hi’ to me,']);
});
```

This is the shape that killed the convention-election rule (it collapsed into
four fragments). Nothing in this design can regress it, which is exactly why it
is worth pinning before the next attempt at M2.

- [ ] **Step 3: Run both files**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/analyzer/dialogue-structure/parser.test.ts server/src/analyzer/dialogue-structure/lang/index.test.ts
git commit -m "test(server): salvage the table-independent guards from PR #2286"
```

---

### Task 6: Release notes, and ship

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:** none.

- [ ] **Step 1: Append the technical entry**

To `docs/release-notes-next.md`, at the end of the **`## 🗣️ Analyzer, script
review & manuscript`** section (line ~248). That file has no `Fixed` heading —
its section anatomy is fixed by its own header comment and `bump-version.mjs`
feeds it verbatim as the GitHub release body, so inventing a heading ships a
malformed release. Append there, do not create a section:

```markdown
- **Dialogue in single quotes is no longer cut short at the first apostrophe.**
  `findQuoteRuns` treated `’` as a closing quote wherever it appeared, so
  `‘I don’t know,’ she said.` produced the speech `I don`. An apostrophe with
  a letter on both sides, or opening a word (`’em`, `’cause`), or immediately
  after its own opening quote (`‘’Tis`) is no longer a closer. Where an opener
  has no valid closer at all the previous boundary is kept, so a turn can
  never be deleted. Measured over 331 public-domain books: 949 paragraphs
  repaired, none regressed. (#2288)
```

- [ ] **Step 2: Append the user-facing line**

To the in-progress version section at the top of `RELEASE_NOTES.md`:

```markdown
- **Dialogue written with single quotes is no longer cut off mid-sentence.** If your book puts speech in single quotes — as most British publishers do — Castwright was ending every line of dialogue at the first apostrophe, so "I don't know," she said became just *I don*, and the rest of the line was read as narration in the narrator's voice. Contractions, names like O'Brien, and dialect spellings such as 'em and 'cause are now understood as part of the speech rather than the end of it.
```

- [ ] **Step 3: Verify the branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: PASS. Server tests are in scope; the frontend legs will skip.

- [ ] **Step 4: Commit and push**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): release notes for the #2288 quote-delimiter fix"
git push -u origin fix/server-2288-quote-delimiter-validity
```

- [ ] **Step 5: Open the PR**

Title: `fix(server): an apostrophe is no longer read as a closing quote`

Body must contain `Closes #2288`, link the design spec, and state the measured result (949 repaired / 0 regressed over 331 books; +161/−0 over 2,170 generated shapes) plus the two known limits from Task 4.

- [ ] **Step 6: Run the mandatory PR review gate**

Single-scope `fix(server)` → **medium** effort, per the model-routing ladder. Findings only, never auto-applied.

---

## Self-review

**Spec coverage.** Rule clause (1) → Task 2 Step 1 tests 1–3; clause (2) → test 4; clause (3) → test 5; the never-delete invariant → Task 2 Step 4 plus Task 3 in full, gated by a mutation check every body in that block is verified to fail. "Acceptance untouched" → Task 1 copies the loop verbatim and its characterisation block pins nesting and #1601 *before* the rule lands. Test plan's "run count is asserted" → every test asserts a full array; Task 3's last test asserts count directly. Known limits → Task 4. #2286 salvage and the three-inner-quote nesting case → Task 5. Rejected clauses `G` and `H` are correctly absent — no task adds an opener rule or a shared-closer rule.

**Not covered, and why:**
- **The script exclusion has no test, and cannot have one.** Only `en` pairs an apostrophe-shaped glyph as a closer today, so the branch is unreachable until #2286 widens `zh`/`ru`. Task 1's zh test is a *nesting characterisation*; it passes with the exclusion removed. Do not read it as coverage.
- **The widened table set is not exercised in unit tests.** `findQuoteRuns` is module-private and takes its pairs from `conv.quotePairs`, so with no table changes there is no route to drive the wide set through `parseChapterStructure`. That evidence lives in the generated sweep and moves into unit tests with #2286.
- **The `british` sweep family is not ported wholesale.** Task 2 carries five of its twelve cases, Task 4 the possessive-plural one; the remaining six are permutations of the same three sub-clauses.

**Placeholders:** none — every step has the literal code or the literal command.

**Type consistency:** `isRealCloser(line, k, closer, openers)` is defined in Task 2 Step 3 and called in Task 2 Step 4 with those four arguments in that order. `end` and `nearestAny` share the shape `{ at: number; glyph: string }` across Tasks 1 and 2. `speechOf` is redeclared inside each `describe` rather than shared, matching the existing file's style, so tasks stay independently applicable.
