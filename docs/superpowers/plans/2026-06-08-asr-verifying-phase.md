# ASR "Verifying speech" Generation Phase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During the ASR content-QA pass (srv-31), the Generate view's per-chapter row reads "Verifying speech…" instead of a frozen "Synthesising … · 99%", and the no-progress watchdog stays fed through a drift-free pass.

**Architecture:** Mirror the existing `chapter_assembling` phase end-to-end. A new `chapter_verifying` SSE tick (reusing existing tick fields) sets a UI-only `Chapter.phase = 'verifying'`, which the row maps to the note. The server fires the tick from a new `asr.onProgress` callback (per sampled group, including `ok` verdicts) and from the existing `asr.onRerecord`.

**Tech Stack:** TypeScript, Vite + React 18 + Redux Toolkit (frontend), Node/Express + Vitest (server), OpenAPI codegen (`openapi-typescript`).

**Spec:** `docs/superpowers/specs/2026-06-08-asr-verifying-phase-design.md` · **Plan/issue:** `docs/features/197-asr-verifying-phase.md`, fs-40 (#640) · **Branch:** `feat/asr-verifying-phase` (already cut).

> **Commit/hook note (this sandbox):** the husky hook can't spawn directly here (no `sh` on PATH, shebang-less hook). Commit through the husky wrapper so the real gate runs:
> `git -c core.hooksPath=.husky/_ commit -F <msgfile>` after prepending `C:\Program Files\Git\bin` to `$env:PATH`. Do **not** use `--no-verify`. For multi-line messages on PowerShell 5.1, write the message to a temp file and use `-F` (embedded `"` mangle native args).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `openapi.yaml` | API contract — `GenerationTick.type` enum | add `chapter_verifying` |
| `src/lib/api-types.ts` | generated types | regenerate (`npm run openapi:types`) |
| `src/lib/types.ts` | app `Chapter` type | widen `phase` union |
| `src/store/chapters-slice.ts` | SSE tick reducer | handle `chapter_verifying` |
| `src/views/generation.tsx` | per-chapter row | "Verifying speech…" label + caption |
| `server/src/tts/synthesise-chapter.ts` | ASR pass | `asr.onProgress` callback |
| `server/src/routes/generation.ts` | SSE route | emit `chapter_verifying` from onProgress/onRerecord |

Wording uses the ellipsis character `…` (U+2026) to match the existing `'Assembling…'`.

---

### Task 1: Wire the `chapter_verifying` tick into the contract

**Files:**
- Modify: `openapi.yaml` (the `GenerationTick.type` enum, ~line 3217 + its description block)
- Regenerate: `src/lib/api-types.ts`

- [ ] **Step 1: Add the enum value.** In `openapi.yaml`, change the `GenerationTick.type` enum line from:

```yaml
          enum: [progress, chapter_assembling, chapter_complete, chapter_failed, idle, resume_from, warning, chapter_awaiting_fallback_confirm]
```

to:

```yaml
          enum: [progress, chapter_assembling, chapter_verifying, chapter_complete, chapter_failed, idle, resume_from, warning, chapter_awaiting_fallback_confirm]
```

- [ ] **Step 2: Document it.** In the same `description:` block, immediately after the `chapter_assembling` sentence (the one ending "…so the UI doesn't look stalled at 99 %."), insert:

```yaml
            `chapter_verifying` is emitted while the ASR content-QA pass (srv-31)
            transcribes a chapter's sentences after synthesis and before
            assembly; it carries the same counters as `chapter_assembling` and
            surfaces a "Verifying speech…" phase so the row doesn't look frozen
            on "Synthesising …".
```

- [ ] **Step 3: Regenerate the types.**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates; `git diff --stat src/lib/api-types.ts` shows the `chapter_verifying` literal added to the `GenerationTick.type` union. No other unrelated churn.

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (the literal is additive; nothing else references it yet).

- [ ] **Step 5: Commit.**

Write the message to `.git/CMSG.txt`:

```
feat(openapi): add chapter_verifying GenerationTick for the ASR phase

Additive enum value reused by the Generate view to surface the srv-31
ASR content-QA pass as a "Verifying speech..." phase. Regenerates
src/lib/api-types.ts.

Refs #640
```

Run:
```
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
git add openapi.yaml src/lib/api-types.ts
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```
Expected: commit-msg validator passes; pre-commit runs scoped (frontend leg may run since `src/` changed) and is green.

---

### Task 2: Widen the `Chapter.phase` union

**Files:**
- Modify: `src/lib/types.ts:24`

- [ ] **Step 1: Edit the union.** Change:

```typescript
  phase?: 'assembling' | null;
```

to:

```typescript
  phase?: 'assembling' | 'verifying' | null;
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

Message file `.git/CMSG.txt`:
```
feat(frontend): add 'verifying' member to Chapter.phase

UI-only phase for the ASR content-QA pass, sibling of 'assembling'.

Refs #640
```
Run:
```
git add src/lib/types.ts
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

---

### Task 3: Slice handler for `chapter_verifying` (TDD)

**Files:**
- Test: `src/store/chapters-slice.test.ts` (add a `describe` block after the existing `describe('chapter_assembling', …)`, which ends ~line 360)
- Modify: `src/store/chapters-slice.ts` (add a handler after the `chapter_assembling` block, ~line 422)

- [ ] **Step 1: Write the failing tests.** Insert after the closing `})` of the `chapter_assembling` describe block:

```typescript
  describe('chapter_verifying', () => {
    it('sets phase=verifying, keeps the row in_progress, and carries progress', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.9 })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_verifying', chapterId: 3, progress: 0.99 }),
        ),
      );
      expect(next.chapters[0].phase).toBe('verifying');
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].progress).toBeCloseTo(0.99);
    });

    it('is cleared by a subsequent chapter_complete', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', phase: 'verifying' })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 10 }),
        ),
      );
      expect(next.chapters[0].phase).toBe(null);
      expect(next.chapters[0].state).toBe('done');
    });
  });
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- src/store/chapters-slice.test.ts -t "chapter_verifying"`
Expected: FAIL — first test gets `phase` undefined/null instead of `'verifying'` (no handler yet; the tick falls through to the `progress` branch which sets `phase = null`).

- [ ] **Step 3: Implement the handler.** In `src/store/chapters-slice.ts`, immediately after the `chapter_assembling` block's closing `}` (the `return;` at ~line 421-422) and before `if (ev.type === 'chapter_complete') {`, insert:

```typescript
      if (ev.type === 'chapter_verifying') {
        /* srv-31 ASR content-QA pass runs after synthesis, before assembly.
           Mirror chapter_assembling: hold the row in_progress with a distinct
           phase so the Generate view shows "Verifying speech…" instead of a
           frozen "Synthesising …" caption. */
        ch.phase = 'verifying';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? 0.99;
        if (ev.currentLine != null) ch.currentLine = ev.currentLine;
        if (ev.totalLines != null) ch.totalLines = ev.totalLines;
        return;
      }

```

- [ ] **Step 4: Run to verify pass.**

Run: `npm run test -- src/store/chapters-slice.test.ts -t "chapter_verifying"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit.**

Message file `.git/CMSG.txt`:
```
feat(frontend): handle chapter_verifying SSE tick in chapters slice

Sets phase='verifying' (mirrors chapter_assembling) so the Generate row
reflects the ASR content-QA pass; cleared by chapter_complete.

Refs #640
```
Run:
```
git add src/store/chapters-slice.ts src/store/chapters-slice.test.ts
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

---

### Task 4: Generate view shows "Verifying speech…" (TDD)

**Files:**
- Test: `src/views/generation.test.tsx` (add an `it(...)` inside an existing top-level `describe`, e.g. after the metadata describe block ~line 249)
- Modify: `src/views/generation.tsx` (the `assembling`/`inProgressLabel` block ~line 1240-1248 and the live caption ~line 1331-1338)

- [ ] **Step 1: Write the failing test.** Add this test (it builds its own store, mirroring the "counters exclude ignored chapters" test at ~line 257):

```typescript
  it('shows "Verifying speech…" on a chapter in the ASR verifying phase', () => {
    const verifying: Chapter = {
      ...chapter1,
      state: 'in_progress',
      phase: 'verifying',
      progress: 0.99,
    };
    const ch2Queued: Chapter = { ...chapter2 };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([verifying, ch2Queued]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [verifying, ch2Queued],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[verifying, ch2Queued]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    // Rendered in BOTH the row pill and the live caption.
    expect(screen.getAllByText('Verifying speech…').length).toBeGreaterThanOrEqual(2);
    // The frozen synthesising caption must NOT show for the verifying row.
    expect(screen.queryByText(/Synthesising/)).not.toBeInTheDocument();
  });
```

> If `configureStore`/the slice imports aren't already in scope at the chosen insertion point, place the test inside the same `describe` as the "counters exclude ignored chapters" test (line ~251), which already uses every import above.

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- src/views/generation.test.tsx -t "Verifying speech"`
Expected: FAIL — "Verifying speech…" not found; the row still renders the "Generating" pill and a "Synthesising …"/"line N of Y" caption.

- [ ] **Step 3: Implement — add the `verifying` flag + label.** In `src/views/generation.tsx`, find (~line 1240):

```typescript
  const assembling = chapter.phase === 'assembling';
  const rowStalled = stalled && chapter.state === 'in_progress';
  const inProgressLabel = rowStalled
    ? 'Stalled'
    : assembling
      ? 'Assembling…'
      : paused
        ? 'Paused'
        : 'Generating';
```

Replace with:

```typescript
  const assembling = chapter.phase === 'assembling';
  const verifying = chapter.phase === 'verifying';
  const rowStalled = stalled && chapter.state === 'in_progress';
  const inProgressLabel = rowStalled
    ? 'Stalled'
    : assembling
      ? 'Assembling…'
      : verifying
        ? 'Verifying speech…'
        : paused
          ? 'Paused'
          : 'Generating';
```

- [ ] **Step 4: Implement — caption branch.** Find the live-caption ternary (~line 1331):

```tsx
          {chapter.state === 'in_progress' && liveTotal > 0 ? (
            /* Live caption — swaps in once a tick has shipped totalLines so
               the user has a per-tick "moving" signal at eye level.
               Falls through to the static meta until then. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              {liveSpeaker ? `Synthesising ${liveSpeaker.name} · ` : ''}
              line {liveCurrent.toLocaleString()} of {liveTotal.toLocaleString()}
            </span>
          ) : chapter.state === 'done' && isMixedEngineChapter(chapter) ? (
```

Insert a new branch BEFORE the `liveTotal > 0` branch so verifying wins regardless of counters:

```tsx
          {chapter.state === 'in_progress' && verifying ? (
            /* srv-31 ASR content-QA pass: the synthesis groups are done and
               counters are frozen near 99 %, so show the QA step explicitly
               instead of a stuck "Synthesising …" line. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              Verifying speech…
            </span>
          ) : chapter.state === 'in_progress' && liveTotal > 0 ? (
            /* Live caption — swaps in once a tick has shipped totalLines so
               the user has a per-tick "moving" signal at eye level.
               Falls through to the static meta until then. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              {liveSpeaker ? `Synthesising ${liveSpeaker.name} · ` : ''}
              line {liveCurrent.toLocaleString()} of {liveTotal.toLocaleString()}
            </span>
          ) : chapter.state === 'done' && isMixedEngineChapter(chapter) ? (
```

- [ ] **Step 5: Run to verify pass.**

Run: `npm run test -- src/views/generation.test.tsx -t "Verifying speech"`
Expected: PASS.

- [ ] **Step 6: Commit.**

Message file `.git/CMSG.txt`:
```
feat(frontend): show "Verifying speech..." during the ASR phase

The Generate row pill + live caption reflect chapter.phase==='verifying'
so the srv-31 ASR content-QA pass no longer reads as a stuck
"Synthesising ..." at 99%.

Refs #640
```
Run:
```
git add src/views/generation.tsx src/views/generation.test.tsx
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

---

### Task 5: Server — `asr.onProgress` per sampled group (TDD)

**Files:**
- Test: `server/src/tts/synthesise-chapter-asr.test.ts` (add an `it(...)` inside the existing `describe('synthesiseChapter ASR content-QA pass', …)`)
- Modify: `server/src/tts/synthesise-chapter.ts` — `AsrPassOptions` (~line 508-536) and the ASR loop (~line 1227-1273)

- [ ] **Step 1: Write the failing test.** Add inside the ASR describe block:

```typescript
  it('fires onProgress once per sampled group, including ok verdicts', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]); // always clean → all ok, no re-record
    const calls: Array<{ verified: number; total: number }> = [];
    const res = await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 0, transcribeFn: fn, onProgress: (e) => calls.push(e) },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ verified: 0, total: 3 });
    expect(calls[2]).toEqual({ verified: 2, total: 3 });
    // All clean → no re-records → one pool synth per sentence.
    expect(provider.calls).toHaveLength(3);
    // Sanity: every body segment verified ok.
    for (const seg of res.segments.filter((s) => s.kind !== 'title')) {
      expect(seg.asr?.verdict).toBe('ok');
    }
  });

  it('strides onProgress with sampleEvery', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]);
    const calls: Array<{ verified: number; total: number }> = [];
    await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3), sentence(4)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 0, sampleEvery: 2, transcribeFn: fn, onProgress: (e) => calls.push(e) },
    });
    // 4 groups, stride 2 → groups 0 and 2 sampled → 2 onProgress calls.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.total)).toEqual([2, 2]);
    expect(calls.map((c) => c.verified)).toEqual([0, 1]);
  });
```

- [ ] **Step 2: Run to verify failure.**

Run: `cd server && npm run test -- src/tts/synthesise-chapter-asr.test.ts -t "onProgress"`
Expected: FAIL — `calls` is empty (no `onProgress` wired); the option isn't even on the type.

- [ ] **Step 3: Add the option to the type.** In `server/src/tts/synthesise-chapter.ts`, inside `AsrPassOptions` (after the `onRerecord?` member, before the closing `}` at ~line 536), add:

```typescript
  /** Fired at the START of each sampled group's ASR check — including `ok`
      verdicts — so the SSE route can surface a "verifying" phase and keep the
      no-progress watchdog fed through a drift-free pass (a clean chapter fires
      no `onRerecord` at all). `verified` is the 0-based index of this group
      among the sampled groups; `total` is how many groups will be checked. */
  onProgress?: (e: { verified: number; total: number }) => void;
```

- [ ] **Step 4: Fire it in the loop.** Find the ASR loop opener (~line 1245-1253):

```typescript
    let sampleCounter = 0;
    for (const group of groups) {
      const r = results[group.index];
      if (!r) continue;
      /* Stride sampling — default every sentence (sampleEvery=1). */
      if (sampleEvery > 1 && sampleCounter++ % sampleEvery !== 0) continue;
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      let best = r;
```

Replace with:

```typescript
    /* Count the groups we will actually transcribe (have a result + pass the
       stride) so onProgress can report verified/total. The stride below walks
       groups-with-results in order, so total mirrors that ordering. */
    const groupsWithResult = groups.filter((g) => results[g.index]);
    const totalToVerify = groupsWithResult.filter((_, i) => i % sampleEvery === 0).length;
    let verifiedCount = 0;
    let sampleCounter = 0;
    for (const group of groups) {
      const r = results[group.index];
      if (!r) continue;
      /* Stride sampling — default every sentence (sampleEvery=1). */
      if (sampleEvery > 1 && sampleCounter++ % sampleEvery !== 0) continue;
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      asr.onProgress?.({ verified: verifiedCount, total: totalToVerify });
      verifiedCount += 1;
      let best = r;
```

> Why `totalToVerify` matches the loop's stride: the loop only reaches the stride check for groups that pass `if (!r) continue`, and `sampleCounter` increments only there — so its `% sampleEvery` selection over groups-with-results is exactly `groupsWithResult.filter((_, i) => i % sampleEvery === 0)`. For `sampleEvery === 1`, `i % 1 === 0` is always true ⇒ `total === groupsWithResult.length`.

- [ ] **Step 5: Run to verify pass.**

Run: `cd server && npm run test -- src/tts/synthesise-chapter-asr.test.ts`
Expected: PASS (the two new tests plus the existing ASR tests stay green).

- [ ] **Step 6: Commit.**

Message file `.git/CMSG.txt`:
```
feat(server): add asr.onProgress per sampled group in synthesiseChapter

Fires once per sampled group incl. ok verdicts so the route can surface a
verifying phase and feed the no-progress watchdog through a drift-free
ASR pass (closes a latent false-stall).

Refs #640
```
Run:
```
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter-asr.test.ts
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

---

### Task 6: Route — emit `chapter_verifying` from onProgress + onRerecord

**Files:**
- Modify: `server/src/routes/generation.ts` (define a helper before the synth-recovery loop ~line 1127; rewrite the `asr` block ~line 1244-1258)

- [ ] **Step 1: Add the emit helper.** Find (~line 1126-1130):

```typescript
      let result: Awaited<ReturnType<typeof synthesiseChapter>>;
      for (let recovery = 0; ; recovery += 1) {
        try {
          result = await synthesiseChapter({
```

Insert the helper immediately ABOVE `let result:` (so it's defined once for both retries):

```typescript
      /* srv-31 — surface the ASR content-QA pass as a "verifying" phase. Fired
         per sampled group (onProgress) AND per drift re-record (onRerecord);
         both bump the no-progress watchdog and broadcast a chapter_verifying
         tick. Carrying counters at totalLines keeps the row near 99 % without
         resetting ch.phase (a `progress` tick would flip it back to null). */
      const emitVerifying = () => {
        bumpProgress();
        broadcast(job, {
          type: 'chapter_verifying',
          chapterId: chapter.id,
          characterId: null,
          progress: 0.99,
          currentLine: totalLines,
          totalLines,
        });
      };
      let result: Awaited<ReturnType<typeof synthesiseChapter>>;
```

- [ ] **Step 2: Wire both callbacks.** Find the `asr` block (~line 1244-1258):

```typescript
        ...(asrEnabled()
          ? {
              asr: {
                maxRerecords: resolveAsrRerecords(),
                sampleEvery: resolveAsrSampleEvery(),
                language: nonEnglishBook ? bookLanguage : undefined,
                nameAllowlist: buildCastNameAllowlist(cast.characters),
                onRerecord: () => {
                  bumpProgress();
                  if (job.lastProgressTick)
                    broadcast(job, { type: 'progress', ...job.lastProgressTick });
                },
              },
            }
          : {}),
```

Replace with:

```typescript
        ...(asrEnabled()
          ? {
              asr: {
                maxRerecords: resolveAsrRerecords(),
                sampleEvery: resolveAsrSampleEvery(),
                language: nonEnglishBook ? bookLanguage : undefined,
                nameAllowlist: buildCastNameAllowlist(cast.characters),
                onProgress: emitVerifying,
                onRerecord: emitVerifying,
              },
            }
          : {}),
```

- [ ] **Step 3: Typecheck the server.**

Run: `npm run typecheck`
Expected: PASS — `chapter_verifying` is a valid `GenerationTick.type` (Task 1), `emitVerifying` matches both callback shapes (a no-arg fn is assignable to `onRerecord`'s `(e) => void`).

- [ ] **Step 4: Run the generation route tests.**

Run: `cd server && npm run test -- src/routes/generation`
Expected: PASS — existing route/heartbeat/stall tests stay green (no behavioural change when ASR is off; the new broadcast only fires under `asrEnabled()`).

- [ ] **Step 5: Commit.**

Message file `.git/CMSG.txt`:
```
feat(server): broadcast chapter_verifying during the ASR pass

onProgress + onRerecord now emit a chapter_verifying tick (was: re-
broadcasting the stale progress tick, which reset the row's phase and
flickered the caption back to "Synthesising").

Refs #640
```
Run:
```
git add server/src/routes/generation.ts
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

---

### Task 7: Full verification + plan status

**Files:**
- Modify: `docs/features/197-asr-verifying-phase.md` (status `draft` → `active`)

- [ ] **Step 1: Run the full battery.**

Run (PowerShell, with Git bin on PATH so any hook-spawned tooling resolves):
```
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
npm run verify
```
Expected: typecheck + all tests + e2e + build green. If a leg flakes under the active GPU generation run, set `SKIP_CONTENTION_CHECK=1` and/or re-run the single failing leg in isolation per CLAUDE.md triage (do NOT `--no-verify`).

- [ ] **Step 2: Flip the plan status.** In `docs/features/197-asr-verifying-phase.md`, change the frontmatter `status: draft` → `status: active` and the `> Status: draft` line → `> Status: active`.

- [ ] **Step 3: Commit.**

Message file `.git/CMSG.txt`:
```
docs(docs): mark plan 197 active (ASR verifying phase implemented)

Refs #640
```
Run:
```
git add docs/features/197-asr-verifying-phase.md
git -c core.hooksPath=.husky/_ commit -F .git\CMSG.txt
```

- [ ] **Step 4: Open the PR (draft).**

Run:
```
git push -u origin feat/asr-verifying-phase
gh pr create --draft --base main --title 'feat(frontend,server): ASR "Verifying speech" generation phase' --body-file <(...)
```
PR body: `## Summary` (the spec problem + fix in 2-3 lines), `## Test plan` (the three unit suites + manual ASR-on walkthrough), and `Closes #640`. Keep it a **draft**; `gh pr ready` only once `npm run verify` is locally green.

---

## Manual acceptance (live, ASR on — `SEG_ASR_ENABLED=1` already set in `server/.env`)

1. Start generation on a multi-chapter book.
2. While a chapter renders groups → row reads "Synthesising {name} · line N of Y".
3. When that chapter's last group finishes and ASR begins → row flips to "Verifying speech…"; percent holds ~99%; row does NOT go "Stalled" even on a long all-`ok` chapter.
4. ASR done → "Assembling…" → "Done".
5. Top-bar pill reads "Generating" throughout (unchanged).

---

## Self-review notes

- **Spec coverage:** every spec change (wire / synthesise-chapter / generation.ts / types / slice / view) maps to Tasks 1-6; tests to Tasks 3-5; live acceptance above.
- **Type consistency:** callback is `onProgress({ verified, total })` everywhere; phase literal is `'verifying'` in `types.ts`, slice, view, and tests; tick type is `'chapter_verifying'` in openapi, slice, route, and tests.
- **e2e:** mock mode doesn't run ASR, so no Playwright spec is added (stated, not silently omitted); the slice + view units carry the UI behaviour, and `npm run verify`'s e2e leg guards against regressions in the unchanged paths.
