# Chunk-safe stage-2 attribution rules (#1758 / srv-63) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the stage-2 attribution rules block into the *chunk* prompt builder — with a boundary-safe rewrite of rule #3 and a deterministic last-speaker seed — so large chunked chapters (ch44) get the same attribution rules the single-call chapters already do, without re-introducing the cross-boundary parity regression Target C hit.

**Architecture:** Add a second rules constant `STAGE2_ATTRIBUTION_RULES_CHUNK` (rules 1/2/4/5 byte-identical to the shipped chapter block, only rule #3 rewritten to scope continuation/alternation *within the section*). Render it plus a "Speaker at section start" seed inside `buildStage2ChunkInbox`. Thread a `lastSpeakerId: string | null` through the sequential chunk driver (`runStage2ChapterChunked`), computed after each chunk as the last non-`narrator` `characterId` in that chunk's returned attributions (falling back to the incoming value on an all-narration chunk). The whole-chapter builder path is untouched.

**Tech Stack:** TypeScript, Node, Vitest (server harness, `cd server && npm run test`). No new deps.

## Global Constraints

- **Every changed line traces to #1758.** The whole-chapter builder (`buildStage2ChapterInbox`) and its shipped `STAGE2_ATTRIBUTION_RULES` block MUST stay byte-identical — no reordering, no rewording. (Surgical-changes rule, CLAUDE.md.)
- **No new env var / knob** in this work — pure prompt + driver plumbing. (If one were needed it would have to be a registry knob + `.env.example`; it isn't.)
- **Deciding metric for acceptance is `raw` recall** (pre-crossExamine), local target `qwen36-cw-iq4-32k`, `--runs 3`. On-box eval only — NOT a CI gate.
- **Seed source is the RAW model output**, i.e. the `SentenceOutput[]` returned by `attributeSpan` *before* crossExamine runs (crossExamine runs later, on the stitched result, in `analysis.ts`). So the only non-speaker id that appears is the literal `'narrator'` — unknown gender buckets are added by a later pass and never seen here.
- **Never `--no-verify`.** Pre-commit runs scope-filtered `verify:fast:scoped`; a server-src change runs the server suite. Keep each task green.
- Commit subjects: `<type>(<scope>): <subject>`, ≤100 chars. Scope is `server`.

## File Structure

- **`server/src/routes/analysis.ts`** — `export` the existing `STAGE2_ATTRIBUTION_RULES`; add `STAGE2_ATTRIBUTION_RULES_CHUNK`; add the seed block + `lastSpeakerId` param to `buildStage2ChunkInbox`; forward `lastSpeakerId` from the `callForBody` closure in `attributeChapterStage2`.
- **`server/src/analyzer/stage2-chunk.ts`** — widen `Stage2ChunkRunOptions.callForBody` to a 3-arg signature; compute + thread `lastSpeakerId` through `runChunks` and the `attributeSpan` adaptive-re-split recursion; add a module-private `lastSpokenSpeaker` helper.
- **`server/src/routes/analysis.test.ts`** — flip the existing "chunk builder omits the rules block" test to assert the chunk-variant block IS present + seed rendering + ordering; add the drift-guard test.
- **`server/src/analyzer/stage2-chunk.test.ts`** — add the driver test that `lastSpeakerId` is computed and threaded (incl. all-narration carry-through and adaptive re-split).

---

### Task 1: Chunk-variant rules constant + drift-guard test

Adds the second rules constant with only rule #3 rewritten, exports both constants, and locks rules 1/2/4/5 identical between them with a test. No behaviour wiring yet — this task is self-contained and compiles on its own.

**Files:**
- Modify: `server/src/routes/analysis.ts:1532` (export existing constant; add new one after it, ~line 1553)
- Test: `server/src/routes/analysis.test.ts` (new `describe` block, append near the existing "stage-2 attribution rules block (Target C)" suite ~line 3535)

**Interfaces:**
- Produces: `export const STAGE2_ATTRIBUTION_RULES: string` (now exported), `export const STAGE2_ATTRIBUTION_RULES_CHUNK: string` — both begin with the `## Attribution rules` header; rules 1, 2, 4, 5 are textually identical; rule 3 differs.

- [ ] **Step 1: Write the failing drift-guard + shape test**

Append to `server/src/routes/analysis.test.ts`. `buildStage2ChapterInbox` / `buildStage2ChunkInbox` are already named-imported from `./analysis.js` (~lines 34-36) — **fold** `STAGE2_ATTRIBUTION_RULES` and `STAGE2_ATTRIBUTION_RULES_CHUNK` into that existing import block; do NOT add a second `import … from './analysis.js'` statement. Then append the suite:

```ts
describe('chunk-variant attribution rules (#1758)', () => {
  // Extract the numbered rule bodies "N. …" up to the next "\nN. " boundary.
  function rule(block: string, n: number): string {
    const m = block.match(new RegExp(`\\n${n}\\. [\\s\\S]*?(?=\\n\\d\\. |$)`));
    return (m?.[0] ?? '').trim();
  }

  it('shares rules 1, 2, 4, 5 byte-for-byte with the chapter block', () => {
    for (const n of [1, 2, 4, 5]) {
      expect(rule(STAGE2_ATTRIBUTION_RULES_CHUNK, n)).toBe(rule(STAGE2_ATTRIBUTION_RULES, n));
      expect(rule(STAGE2_ATTRIBUTION_RULES_CHUNK, n)).not.toBe(''); // guard: regex actually matched
    }
  });

  it('rewrites rule 3 to scope continuation/alternation within the section', () => {
    const chunk3 = rule(STAGE2_ATTRIBUTION_RULES_CHUNK, 3);
    expect(chunk3).not.toBe(rule(STAGE2_ATTRIBUTION_RULES, 3));
    expect(chunk3).toContain('within this section');
    // No unqualified claim that alternation carries in from before the section.
    expect(chunk3).toContain('Do NOT assume');
  });

  it('both blocks start with the same header', () => {
    expect(STAGE2_ATTRIBUTION_RULES_CHUNK.startsWith('## Attribution rules')).toBe(true);
    expect(STAGE2_ATTRIBUTION_RULES.startsWith('## Attribution rules')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect a compile/failing test**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "chunk-variant attribution rules"`
Expected: FAIL — `STAGE2_ATTRIBUTION_RULES_CHUNK` is not exported (and `STAGE2_ATTRIBUTION_RULES` isn't either yet), so the import errors.

- [ ] **Step 3: Export the existing constant and add the chunk variant**

In `server/src/routes/analysis.ts`, change the declaration at line 1532 from `const STAGE2_ATTRIBUTION_RULES = ` to `export const STAGE2_ATTRIBUTION_RULES = ` (leave the block body and the preceding comment untouched).

Immediately after the closing `` `; `` of `STAGE2_ATTRIBUTION_RULES` (currently ~line 1553), insert:

```ts
/* #1758 — the chunk-path variant of the attribution rules. Rules 1, 2, 4, 5 are
   byte-identical to STAGE2_ATTRIBUTION_RULES (all boundary-safe: explicit tag,
   same-paragraph action beat, narration, addressee). Only rule 3 is rewritten to
   scope continuation/alternation WITHIN the section — a chunk that opens
   mid-conversation has no in-band anchor for two-hander alternation parity, so
   telling the model to alternate across the seam flipped the whole run (the ch44
   both-builders regression). The "Speaker at section start" seed (buildStage2ChunkInbox)
   powers only rule 3's continuation clause; alternation is disclaimed across the seam.
   A drift-guard unit test pins rules 1/2/4/5 identical between the two constants. */
export const STAGE2_ATTRIBUTION_RULES_CHUNK = `## Attribution rules

Apply these when assigning each sentence's speaker. They hold whatever
quotation marks the text uses — \`"…"\`, \`«…»\`, \`„…"\`, \`“…”\` — and in any
language:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   \`"…," said X\` / \`"…," X asked\` / \`"…," whispered X\` — the speaker is X,
   whatever the surrounding lines suggest.
2. An action beat names the speaker. A quote sharing a paragraph with a
   character's action belongs to that character: \`X folded her arms. "Get
   out."\` and \`"Get out." X turned away.\` are both spoken by X.
3. Untagged quotes continue, and two-handers alternate — within this section. An
   untagged quote keeps the last speaker established here (or the "Speaker at
   section start" named below, for the first quote). Do NOT assume a two-hander's
   alternation carries in from before this section's start; near the start, rely
   on dialogue tags and action beats rather than alternation parity.
4. Narration is the narrator. Non-dialogue prose — description, action,
   scene-setting — is \`narrator\`, even between two characters' lines. Only words
   inside quote marks belong to a character (unless the whole chapter is a
   first-person document).
5. The addressee is not the speaker. A name spoken to someone ("Careful,
   Anton.") marks who is addressed, not who speaks — never attribute the line to
   the person being addressed.`;
```

Copy rules 1, 2, 4, 5 (and the lead-in paragraph + header) **verbatim** from `STAGE2_ATTRIBUTION_RULES` — the drift-guard test enforces this. Only rule 3's text differs.

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "chunk-variant attribution rules"`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): add chunk-variant STAGE2_ATTRIBUTION_RULES_CHUNK + drift guard (#1758)"
```

---

### Task 2: Render the chunk rules block + last-speaker seed in `buildStage2ChunkInbox`

Adds a `lastSpeakerId: string | null` parameter to the chunk builder, renders the chunk-variant rules block (Task 1) and the "Speaker at section start" seed, and flips the existing test that asserted the chunk builder omits the rules block. The one existing caller (`callForBody` in `analysis.ts`) is updated to pass `null` here — the real value arrives in Task 3.

**Files:**
- Modify: `server/src/routes/analysis.ts:1620-1685` (`buildStage2ChunkInbox` signature + body), and `analysis.ts:1806-1814` (the `buildStage2ChunkInbox` call inside `callForBody` — pass `null` for now)
- Test: `server/src/routes/analysis.test.ts:3507` (flip the "does NOT render" case) + the ordering/seed assertions

**Interfaces:**
- Consumes: `STAGE2_ATTRIBUTION_RULES_CHUNK` (Task 1).
- Produces: `buildStage2ChunkInbox(manuscriptId, title, stage1, chapter, subBody, precedingContext, firstPersonId, lastSpeakerId)` — the new 8th positional param `lastSpeakerId: string | null`. Prompt section order: roster → `## Attribution rules` → preceding-context → `## Speaker at section start` (only when `lastSpeakerId` non-null) → first-person → section body.

- [ ] **Step 1: Flip / extend the builder test**

In `server/src/routes/analysis.test.ts`, replace the existing case at line 3507 ("does NOT render the rules block in the chunk builder…") with the following, and note the `buildStage2ChunkInbox` call now passes an 8th arg:

```ts
  it('renders the chunk-variant rules block in the chunk builder (#1758)', () => {
    const prompt = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, null,
    );
    expect(prompt).toContain('## Attribution rules');
    expect(prompt).toContain('within this section'); // the rule-3 rewrite marker
    // Order: roster → rules → preceding-context → section.
    const characters = prompt.indexOf('## Characters (from stage 1)');
    const rules = prompt.indexOf('## Attribution rules');
    const context = prompt.indexOf('## Preceding context');
    const section = prompt.indexOf('## Section to attribute');
    expect(rules).toBeGreaterThan(characters);
    expect(context).toBeGreaterThan(rules);
    expect(section).toBeGreaterThan(context);
  });

  it('renders the last-speaker seed only when lastSpeakerId is provided (#1758)', () => {
    const seeded = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, 'egor',
    );
    expect(seeded).toContain('## Speaker at section start');
    expect(seeded).toContain('`egor`');
    // Seed sits after preceding-context and before the section body.
    expect(seeded.indexOf('## Speaker at section start')).toBeGreaterThan(
      seeded.indexOf('## Preceding context'),
    );
    expect(seeded.indexOf('## Section to attribute')).toBeGreaterThan(
      seeded.indexOf('## Speaker at section start'),
    );

    const unseeded = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, null,
    );
    expect(unseeded).not.toContain('## Speaker at section start');
  });

  it('renders the first-person block after the seed when both apply (#1758)', () => {
    const prompt = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', 'anton', 'egor',
    );
    const seed = prompt.indexOf('## Speaker at section start');
    const firstPerson = prompt.indexOf('## First-person narrator');
    expect(seed).toBeGreaterThan(0);
    expect(firstPerson).toBeGreaterThan(seed);
  });
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "chunk"`
Expected: FAIL — `buildStage2ChunkInbox` takes 7 args (TS arity error on the 8th) and renders neither the rules block nor the seed.

- [ ] **Step 3: Add the param + render the block and seed**

In `server/src/routes/analysis.ts`, change the `buildStage2ChunkInbox` signature (line 1620-1628) to append the new param:

```ts
export function buildStage2ChunkInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
  subBody: string,
  precedingContext: string | null,
  firstPersonId: string | null,
  lastSpeakerId: string | null,
): string {
```

Immediately after the `contextBlock` const (ends line 1639), add the seed block:

```ts
  const seedBlock = lastSpeakerId
    ? `## Speaker at section start

The last character to speak before this section was \`${lastSpeakerId}\`. Treat the
first untagged quote in this section as continuing \`${lastSpeakerId}\`, unless a
dialogue tag or action beat names a different speaker.

`
    : '';
```

Update the `## Characters` json block's trailing region and the return template so the rules block renders after the roster and the seed renders between preceding-context and first-person. The tail of the template (currently line 1680-1683) becomes:

```ts
\`\`\`

${STAGE2_ATTRIBUTION_RULES_CHUNK}

${contextBlock}${seedBlock}${firstPersonBlock}## Section to attribute (Chapter ${chapter.id} — ${chapter.title})

${subBody}
`;
```

(The `` ``` `` closing the characters json is already there — insert `${STAGE2_ATTRIBUTION_RULES_CHUNK}` on its own paragraph after it, mirroring how `buildStage2ChapterInbox` places `${STAGE2_ATTRIBUTION_RULES}` at line 1605.)

Also update the stale comment above the function (line 1613-1619): it currently says "but NOT the attribution rules block — chapter-only". Change that clause to note the chunk builder now renders `STAGE2_ATTRIBUTION_RULES_CHUNK` + the last-speaker seed (#1758).

- [ ] **Step 4: Update the one existing caller to pass `null`**

In `attributeChapterStage2`'s `callForBody` closure (`analysis.ts:1806-1814`), the `buildStage2ChunkInbox(...)` call currently ends `..., preceding, firstPersonId)`. Append `, null` as the 8th arg for now (Task 3 replaces it with the real `lastSpeakerId`):

```ts
        : buildStage2ChunkInbox(
            opts.manuscriptId,
            opts.title,
            stage1,
            opts.chapter,
            subBody,
            preceding,
            firstPersonId,
            null,
          );
```

- [ ] **Step 5: Run the builder tests + the drift guard — expect PASS**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "chunk"`
Expected: PASS. Then confirm the untouched chapter-builder cases still pass:
Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "attribution rules block (Target C)"`
Expected: PASS (chapter-builder order/content unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): render chunk rules block + last-speaker seed in chunk inbox (#1758)"
```

---

### Task 3: Thread `lastSpeakerId` through the chunk driver

Widens the `callForBody` contract to a 3-arg signature, computes the last-established speaker after each chunk (last non-`narrator` id in that chunk's returned attributions, falling back to the incoming value on an all-narration chunk), threads it through both the top-level chunk loop and the adaptive re-split recursion, and forwards it from `analysis.ts`'s `callForBody` into `buildStage2ChunkInbox`. This is the task that makes the seed live.

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts:264-267` (`callForBody` type), `:303-338` (`attributeSpan` recursion), `:345-358` (`runChunks` loop); add a `lastSpokenSpeaker` helper near `tailParagraphs` (~line 241)
- Modify: `server/src/routes/analysis.ts:1802-1821` (`callForBody` closure signature + forward)
- Test: `server/src/analyzer/stage2-chunk.test.ts` (new driver cases)

**Interfaces:**
- Consumes: `buildStage2ChunkInbox(..., lastSpeakerId)` (Task 2).
- Produces: `Stage2ChunkRunOptions.callForBody: (subBody: string, precedingContext: string | null, lastSpeakerId: string | null) => Promise<{ sentences: SentenceOutput[] }>`. Helper `lastSpokenSpeaker(sentences: SentenceOutput[], incoming: string | null): string | null` — last `characterId !== 'narrator'`, else `incoming`.

- [ ] **Step 1: Write the failing driver test**

Append to `server/src/analyzer/stage2-chunk.test.ts`. Use a fake whose attribution depends on `subBody` so chunks yield distinct speakers, and capture the 3rd arg:

```ts
describe('lastSpeakerId threading (#1758)', () => {
  /* Fake model: each paragraph "SPK:<id> …" is attributed to <id>; a paragraph
     with no SPK prefix is narrator. Lets a test script who "spoke last" per chunk. */
  function speakerAttribute(subBody: string): { sentences: SentenceOutput[] } {
    const paras = subBody.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return {
      sentences: paras.map((text, i) => ({
        id: i + 1,
        chapterId: 1,
        characterId: text.startsWith('SPK:') ? text.slice(4).split(' ')[0] : 'narrator',
        text,
      })),
    };
  }

  it('seeds chunk 2 with the last non-narrator speaker of chunk 1', async () => {
    // Two paragraphs per chunk, budget forces a 2-chunk split.
    const body = ['SPK:egor line one here', 'narration here between', 'SPK:anton line two here', 'more narration text']
      .join('\n\n');
    const seen: Array<string | null> = [];
    const call = vi.fn(async (subBody: string, _p: string | null, seed: string | null) => {
      seen.push(seed);
      return speakerAttribute(subBody);
    });
    await runStage2ChapterChunked({ body, charBudget: 40, coverageRetries: 1, callForBody: call });
    expect(seen[0]).toBeNull();          // first chunk: no seed
    expect(seen[1]).toBe('egor');        // chunk 1's last spoken id
  });

  it('carries the prior speaker through an all-narration chunk', async () => {
    const body = ['SPK:egor first spoken line', 'pure narration paragraph one', 'pure narration paragraph two']
      .join('\n\n');
    const seen: Array<string | null> = [];
    const call = vi.fn(async (subBody: string, _p: string | null, seed: string | null) => {
      seen.push(seed);
      return speakerAttribute(subBody);
    });
    await runStage2ChapterChunked({ body, charBudget: 30, coverageRetries: 1, callForBody: call });
    // Whatever chunk boundaries fall out, once egor has spoken every later chunk is seeded egor.
    const afterEgor = seen.slice(1);
    expect(afterEgor.every((s) => s === 'egor')).toBe(true);
  });
});
```

Extend the existing `import` from `./stage2-chunk.js` if `runStage2ChapterChunked` isn't already imported (it is, per the file head).

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts -t "lastSpeakerId threading"`
Expected: FAIL — `call` receives only 2 args, so `seed` is `undefined` and `seen[1]` is `undefined`, not `'egor'`.

- [ ] **Step 3: Add the helper and widen the `callForBody` type**

In `server/src/analyzer/stage2-chunk.ts`, after `tailParagraphs` (line 241), add:

```ts
/** #1758 — the last non-`narrator` speaker in a chunk's returned attributions,
    used to seed the next chunk's first untagged quote. Falls back to `incoming`
    when the chunk added no spoken line, so a speaker established earlier carries
    across an all-narration chunk. Reads the RAW model output (pre-crossExamine),
    where the only non-speaker id is the literal 'narrator'. */
export function lastSpokenSpeaker(
  sentences: SentenceOutput[],
  incoming: string | null,
): string | null {
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    if (sentences[i].characterId !== 'narrator') return sentences[i].characterId;
  }
  return incoming;
}
```

Widen the `callForBody` type (line 264-267):

```ts
  callForBody: (
    subBody: string,
    precedingContext: string | null,
    lastSpeakerId: string | null,
  ) => Promise<{ sentences: SentenceOutput[] }>;
```

- [ ] **Step 4: Thread the seed through `attributeSpan` and `runChunks`**

`attributeSpan` (line 303) gains a `lastSpeakerId` param and forwards it; the recursion updates it from the sub-call's **returned** sentences (NOT from `tailParagraphs` — that derives from input text; the seed derives from output attributions):

```ts
  const attributeSpan = async (
    span: string,
    depth: number,
    preceding: string | null,
    lastSpeakerId: string | null,
  ): Promise<SentenceOutput[]> => {
    if (!hasAttributableContent(span)) return [];
    try {
      const { result } = await runStage2WithCoverageGuard({
        body: span,
        maxRetries: opts.coverageRetries,
        call: () => opts.callForBody(span, preceding, lastSpeakerId),
        thresholds: opts.coverageThresholds,
        onRetry: opts.onRetry,
      });
      return result.sentences;
    } catch (err) {
      if (err instanceof AnalyzerTruncatedError && depth < maxSplitDepth) {
        const sub = splitSpanForRetry(span);
        if (sub.length > 1) {
          const out: SentenceOutput[] = [];
          let prev = preceding;
          let seed = lastSpeakerId;
          for (const s of sub) {
            const part = await attributeSpan(s, depth + 1, prev, seed);
            out.push(...part);
            prev = tailParagraphs(s, contextParagraphs);
            seed = lastSpokenSpeaker(part, seed);
          }
          return out;
        }
      }
      throw err;
    }
  };
```

`runChunks` (line 345-358) threads the seed across chunks:

```ts
  const runChunks = async (chunks: string[]): Promise<Stage2ChunkRunResult> => {
    const all: SentenceOutput[] = [];
    let preceding: string | null = null;
    let lastSpeakerId: string | null = null;
    for (let i = 0; i < chunks.length; i += 1) {
      opts.onChunk?.({ index: i, total: chunks.length, chars: chunks[i].length });
      const sectionSentences = await attributeSpan(chunks[i], 0, preceding, lastSpeakerId);
      opts.onSectionDone?.(i, sectionSentences.length);
      all.push(...sectionSentences);
      preceding = tailParagraphs(chunks[i], contextParagraphs);
      lastSpeakerId = lastSpokenSpeaker(sectionSentences, lastSpeakerId);
    }
    const sentences = all.map((s, i) => ({ ...s, id: i + 1 }));
    const coverage = validateStage2Coverage(opts.body, sentences, opts.coverageThresholds);
    return { sentences, coverage, chunkCount: chunks.length };
  };
```

The two single-call sites that pass `null` preceding also pass `null` seed:
- Line 318 inside `attributeSpan` is already updated above.
- The under-budget single-call path (line 377): `call: () => opts.callForBody(opts.body, null, null),`.

- [ ] **Step 5: Forward the real seed from `analysis.ts`**

In `attributeChapterStage2`'s `callForBody` closure (`analysis.ts:1802`), widen the closure signature and forward the seed to the chunk builder (replacing the `null` placeholder from Task 2):

```ts
  const callForBody = (subBody: string, preceding: string | null, lastSpeakerId: string | null) => {
    const prompt =
      preceding === null && subBody === opts.chapter.body
        ? buildStage2ChapterInbox(opts.manuscriptId, opts.title, stage1, opts.chapter, firstPersonId)
        : buildStage2ChunkInbox(
            opts.manuscriptId,
            opts.title,
            stage1,
            opts.chapter,
            subBody,
            preceding,
            firstPersonId,
            lastSpeakerId,
          );
    return opts.analyzer.runStage2Chapter(
      opts.manuscriptId,
      opts.chapter.id,
      prompt,
      opts.stageCall,
    );
  };
```

(The chapter-builder branch ignores `lastSpeakerId` — it only fires on the single-call path where the seed is `null` anyway.)

- [ ] **Step 6: Run the driver tests + the full stage2-chunk + analysis suites**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts src/routes/analysis.test.ts`
Expected: PASS — the new threading cases plus all existing chunk/coverage/re-split cases (the added `callForBody` arg is optional-at-call for the existing 2-arg fakes because TS allows calling a 3-param function type only when the fakes match; the existing test fakes declare `(subBody, _preceding)` — verify they still satisfy the widened type, which they do since extra params are contravariantly ignorable for a value assigned to the wider type). If any existing fake is rejected by TS, add a `_seed?: string | null` param to it.

- [ ] **Step 7: Typecheck the whole server**

Run: `cd server && npm run typecheck` (or root `npm run typecheck`)
Expected: clean — the `callForBody` signature change is internally consistent across `stage2-chunk.ts` and `analysis.ts`.

- [ ] **Step 8: Commit**

```bash
git add server/src/analyzer/stage2-chunk.ts server/src/analyzer/stage2-chunk.test.ts server/src/routes/analysis.ts
git commit -m "feat(server): thread last-speaker seed through the stage-2 chunk driver (#1758)"
```

---

### Task 4: On-box ch44 eval acceptance + docs

Not a code task — the empirical gate the whole design turns on. Runs the attribution eval on the corpus box (corpus is local-only, absent on the general dev box) and records the numbers, then updates the regression plan + release notes. Per the spec's Measurement plan.

**Files:**
- Modify: `docs/features/265-attribution-eval-tuning.md` (append the #1758 cycle + captured ch44 numbers)
- Modify: `docs/release-notes-next.md` + `RELEASE_NOTES.md` (gated on a measurable ch44 raw lift — append only if the win materialises)

- [ ] **Step 1: Confirm the fixture set (spec step 0)**

On the corpus-present box, confirm **ch44 is the sole chunked fixture** and note ch43's margin under the 9000-char budget (spec §Measurement caveat). If a second fixture now chunks, widen the gate to cover it before trusting "flat by construction".

- [ ] **Step 2: Re-baseline on `main`**

From a checkout on `main` (post-#1761) with the corpus present and Ollama up, run the eval `--runs 3` against `qwen36-cw-iq4-32k`; record per-fixture + ch44 `raw.byFamily`.

- [ ] **Step 3: Run the treatment (this branch)**

Same command on `feat/server-chunk-safe-attribution-rules`. Compare per the gate:
- **ch44:** treatment mean `raw` ≥ baseline min (floor, no regression); ≥ baseline max = the win. Collapsed speaker-inference families hold at/above baseline min.
- **Every other fixture:** flat within run-to-run noise (any real movement = an accidental chapter-builder change → bug, blocks ship).
- **Secondary:** ch44 `det`/`final` do not regress vs post-#1761 baseline.

- [ ] **Step 4: Bisect ONLY on failure**

If hybrid-C does **not** recover ch44, run the one diagnostic config — **rules 1/2/4/5 in chunks, no rule #3, no seed** — to isolate whether the residual is rule-#3 parity (seed/wording needs work) or another rule misfiring on fragments (different fix). Do NOT run this up front.

- [ ] **Step 5: Record + docs**

Record the numbers in `docs/features/265-attribution-eval-tuning.md` (the #1758 cycle). If ch44 raw lifted measurably, append the user-facing release-notes line (large chunked chapters now get the same attribution rules as single-call ones) to `docs/release-notes-next.md` + `RELEASE_NOTES.md`. If the result is floor-only (no regression, no lift), say so and skip the release-notes entry (no user-visible delta).

- [ ] **Step 6: Commit docs**

```bash
git add docs/features/265-attribution-eval-tuning.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(server): record #1758 chunk-safe rules ch44 eval + release note"
```

---

## Self-Review

**Spec coverage:**
- §1 chunk-variant rules block → Task 1. ✓
- §2 last-speaker seed → Task 2 (render) + Task 3 (compute). ✓
- §3 plumbing (callForBody 3-arg, runChunks loop, re-split recursion nuance = derive from returned sentences not input text) → Task 3, Step 4 (explicit `lastSpokenSpeaker(part, seed)` in the recursion, distinct from `prev = tailParagraphs(...)`). ✓
- §4 rules structure (separate constant + drift guard) → Task 1. ✓
- Testing: builder test flip → Task 2 Step 1; drift guard → Task 1; driver test (incl. all-narration carry + re-split) → Task 3; chapter-builder regression guard → Task 2 Step 5 (existing Target C cases re-run). ✓
- Measurement plan + isolation bisect → Task 4. ✓
- Export requirement for drift guard → Task 1 Step 3 (both constants exported). ✓
- Positional-arg shift caveat → Task 2 (append as 8th arg; test call sites updated). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual code. Task 4 is intentionally an on-box acceptance (live model) — its "numbers" are recorded at run time, which is the nature of the eval gate, not a placeholder.

**Type consistency:** `lastSpeakerId: string | null` used identically in `buildStage2ChunkInbox`, the `callForBody` closure, the `Stage2ChunkRunOptions.callForBody` type, `attributeSpan`, and `runChunks`. Helper `lastSpokenSpeaker(sentences, incoming)` name matches across its definition (Task 3 Step 3) and both call sites (Step 4). `STAGE2_ATTRIBUTION_RULES_CHUNK` spelled identically in Task 1 (def) and Task 2 (render).

**One risk to watch during execution (Task 3 Step 6):** the existing chunk-runner test fakes are typed `(subBody, _preceding)`. Assigning a 2-param function to a 3-param function *type* is legal in TS (fewer params is assignable), so they should compile unchanged; the note in Step 6 covers the fallback if not.
