# fs-10 — Chapter-title segment on the Listen timeline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the synthetic chapter-title audio segment on the `ChapterAudio` wire contract, paint it as a labelled band at the head of the Listen mini-player scrubber, and fix the segment-index off-by-one that filtering it has been causing in "Fix this line".

**Architecture:** The title beat already exists on disk (`kind: 'title'`, empty `sentenceIds[]`) but is filtered out at the API boundary. Removing that filter re-aligns the published `segments[]` index with the on-disk index — which is the index the splice route addresses — so the same change that surfaces the band also fixes a live mis-targeting bug. The frontend consumes `kind` in two places: a decorative band on the mini-player scrubber, and a neutral fill in the Generation view's existing "Narrative order" strip.

**Tech Stack:** TypeScript, Express (server), React 18 + Redux Toolkit (frontend), Vitest (unit/integration), Playwright (e2e), OpenAPI → `openapi-typescript` codegen.

**Spec:** [`docs/superpowers/specs/2026-07-24-fs10-listen-title-segment-design.md`](../specs/2026-07-24-fs10-listen-title-segment-design.md) — read §5 and §6.1 before starting; both encode decisions that a reasonable engineer would otherwise get wrong.

## Global Constraints

- **Worktree:** all work happens in `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\fs10-title-segment` on branch `feat/frontend-fs10-title-segment`. Every task's first action is `cd` to that path and `git branch --show-current` to confirm. Do **not** edit files under the main checkout.
- **`kind` is `'title'` only** — never emit or type `kind: 'sentence'`. Absence means sentence.
- **The title band is decorative.** No `<button>`, no `onClick`, no `stopPropagation`. Clicks bubble to the existing scrubber handler. This is a deliberate deviation from issue #412's "clicking it seeks to t=0" acceptance line — see spec §6.1. Do not "fix" it back.
- **Skip, don't renumber.** In `resolveSegmentForSec`, title rows are skipped with `continue` inside the existing index loop. Never `.filter()` the array or recompute indices — the returned index must remain a position in the array exactly as handed in.
- **No hex literals in component code** (`CLAUDE.md` conventions) — use Tailwind token classes (`bg-ink/25`, `bg-peach/60`).
- **OpenAPI is the type source of truth.** Never hand-edit `src/lib/api-types.ts`; regenerate with `npm run openapi:types`.
- **Commit convention:** `<type>(<scope>): <subject>`, scopes from `frontend | server | sidecar | app | scripts | e2e | mocks | openapi | docs | deps | ci | ops`, multi-scope as `fix(frontend,openapi): …`.

---

### Task 1: Publish `kind` and stop filtering the title row (server + contract)

**Files:**
- Modify: `openapi.yaml:4684-4700` (ChapterAudio segments item properties)
- Modify: `src/lib/api-types.ts` (regenerated — do not hand-edit)
- Modify: `server/src/routes/chapter-audio.ts:107-114, 137-159, 233-241, 276-278`
- Test: `server/src/routes/chapter-audio.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: wire field `kind?: 'title'` on `components['schemas']['ChapterAudio']['segments'][number]`, surfaced through `src/lib/types.ts`'s re-export as `ChapterAudio`. Tasks 2–5 all read `seg.kind`.

- [ ] **Step 1: Refactor the test fixture so segments are writable per-test**

In `server/src/routes/chapter-audio.test.ts`, hoist the segment payload out of `beforeAll`. Add near the other helpers (after `writePreviousSegments`, ~line 198).

> **Name collision — do not use `writeSegments`.** A different `writeSegments(segments: unknown[])` already exists at `:587`, function-scoped inside the `describe('meta endpoint — per-segment QA issues (issue-waveform)')` block. A module-scope one would legally shadow it (no `no-shadow` rule is configured, so nothing would warn) and leave the file with two same-named helpers with incompatible signatures. Use `writeChapterSegments`.

```ts
/* Default two-segment payload the bulk of this suite asserts against.
   Hoisted so fs-10's title-led cases can swap the file and restore it. */
const DEFAULT_SEGMENTS = [
  { groupIndex: 0, characterId: 'marlow', sentenceIds: [101, 102], startSec: 0, endSec: 6.2 },
  { groupIndex: 1, characterId: 'oduvan', sentenceIds: [103], startSec: 6.2, endSec: 12.5 },
];

function writeChapterSegments(segments: unknown[], name = `${SLUG}.segments.json`) {
  writeFileSync(
    join(audioRoot, name),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 12.5,
      sampleRate: 24_000,
      modelKey: 'xtts_v2',
      synthesizedAt: new Date().toISOString(),
      segments,
    }),
  );
}
```

Then replace the inline `writeFileSync(join(audioRoot, `${SLUG}.segments.json`), JSON.stringify({...}))` block at lines 72-87 with a single call. Because `writeChapterSegments` is a function declaration it hoists, so calling it from `beforeAll` is fine even though it is defined lower in the file:

```ts
  /* Segments JSON powers the JSON endpoint's metadata response. */
  writeChapterSegments(DEFAULT_SEGMENTS);
```

- [ ] **Step 2: Write the failing tests**

**This block MUST be appended after the file's final top-level `describe`** — currently `describe('workspace nested under a dot-prefixed directory (bug #1290)')`, which ends at `:703`. The reason is not style: every suite in this file shares one on-disk `${SLUG}.segments.json`, written once by the root `beforeAll`, and `resetAudio()` (`:118-131`) deliberately does **not** delete it. Vitest runs sibling top-level suites in declaration order, so a block placed earlier would leave the title-led payload in place for `describe('mp3 chapter')`'s `expect(res.body.segments).toHaveLength(2)` (`:214`) and for the QA suite at `:586`, turning both red with a failure that reads like a product bug.

Append to `server/src/routes/chapter-audio.test.ts`:

```ts
/* fs-10 (#412) — the synthetic narrator-voiced chapter-title beat is published
   rather than filtered. The published index must line up 1:1 with the on-disk
   index, because that is the index chapter-splice.ts resolves segmentIndices
   against (see the spec's §5). */
describe('fs-10 — title segment pass-through', () => {
  const TITLE_LED = [
    {
      groupIndex: -1,
      characterId: 'narrator',
      sentenceIds: [] as number[],
      startSec: 1.5,
      endSec: 3.5,
      kind: 'title',
    },
    { groupIndex: 0, characterId: 'marlow', sentenceIds: [101, 102], startSec: 5, endSec: 8.2 },
    { groupIndex: 1, characterId: 'oduvan', sentenceIds: [103], startSec: 8.2, endSec: 12.5 },
  ];

  beforeAll(() => {
    resetAudio();
    writeMp3();
    writePreviousMp3();
    writeChapterSegments(TITLE_LED);
    writeChapterSegments(TITLE_LED, `${SLUG}.previous.segments.json`);
  });

  afterAll(() => {
    resetAudio();
    writeChapterSegments(DEFAULT_SEGMENTS);
  });

  it('publishes the title row with kind: "title" and no sentenceId', async () => {
    const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`).expect(200);
    expect(res.body.segments[0]).toMatchObject({
      kind: 'title',
      characterId: 'narrator',
      start: 1.5,
      end: 3.5,
    });
    expect(res.body.segments[0].sentenceId).toBeUndefined();
  });

  it('keeps the published index aligned 1:1 with the on-disk index', async () => {
    const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`).expect(200);
    expect(res.body.segments).toHaveLength(TITLE_LED.length);
    /* Match by sentenceId, not by position alone — a positional-only check
       would still pass if someone re-added a filter AND a compensating shift.
       The title row's sentenceIds[0] is undefined, which is the assertion for k=0. */
    TITLE_LED.forEach((disk, k) => {
      expect(res.body.segments[k].sentenceId).toBe(disk.sentenceIds[0]);
      expect(res.body.segments[k].characterId).toBe(disk.characterId);
    });
  });

  it('omits kind on ordinary sentence-backed segments', async () => {
    const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`).expect(200);
    expect(res.body.segments[1].kind).toBeUndefined();
    expect(res.body.segments[2].kind).toBeUndefined();
  });

  it('applies the same pass-through on the preserved /audio/previous variant', async () => {
    const res = await request(app)
      .get(`/api/books/${bookId}/chapters/1/audio/previous`)
      .expect(200);
    expect(res.body.segments).toHaveLength(TITLE_LED.length);
    expect(res.body.segments[0]).toMatchObject({ kind: 'title' });
    expect(res.body.segments[0].sentenceId).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/chapter-audio.test.ts -t "fs-10"`
Expected: FAIL — 4 failures. The title row is filtered out, so `segments` has length 2 and `segments[0]` is `marlow`.

- [ ] **Step 4: Add `kind` to the OpenAPI contract**

In `openapi.yaml`, inside `ChapterAudio.segments.items.properties` (properties are indented 14 spaces), insert immediately after the `sentenceId: { type: integer }` line:

```yaml
              kind:
                type: string
                enum: [title]
                description: >-
                  fs-10 — present only on the synthetic narrator-voiced
                  chapter-title beat (empty sentenceIds[] on disk, see
                  synthesise-chapter.ts). Absent on every ordinary
                  sentence-backed segment and on every pre-fs-10 render, so
                  consumers MUST treat absence as "sentence".
```

- [ ] **Step 5: Regenerate the types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` gains `kind?: "title";` inside the `ChapterAudio.segments` item (near line 3613, after `sentenceId?: number;`). Confirm with:

Run: `git diff --stat src/lib/api-types.ts`
Expected: exactly one file changed, a small diff. If the regen rewrites unrelated parts of the file, stop and report — it means the generator version drifted.

- [ ] **Step 6: Pass `kind` through and drop both filters**

In `server/src/routes/chapter-audio.ts`, in `publishSegment` (~line 151), add the conditional spread — placed before `suspect` to match the wire field order in the contract:

```ts
  return {
    start: s.startSec,
    end: s.endSec,
    characterId: s.characterId,
    sentenceId: s.sentenceIds[0],
    ...(s.kind === 'title' ? { kind: 'title' as const } : {}),
    ...(suspect ? { suspect: true } : {}),
    ...(reasons && reasons.length ? { reasons } : {}),
  };
```

In the `/audio` handler (~line 239), replace the filtered map:

```ts
    const segments = (meta?.segments ?? []).map(publishSegment);
```

In the `/audio/previous` handler (~line 276), make the identical replacement:

```ts
    const segments = (meta?.segments ?? []).map(publishSegment);
```

- [ ] **Step 7: Rewrite the two now-false comments**

Replace the `kind?: 'title'` field comment in `ChapterSegmentsFile` (lines 107-114) with:

```ts
    /** `'title'` on the synthetic narrator-voiced chapter-title segment
        (see `synthesise-chapter.ts`). Published verbatim to the
        `ChapterAudio` API segments[] since fs-10 (#412) — the Listen
        mini-player paints it as a band and the Generation "Narrative
        order" strip fills it neutrally. Carries an empty sentenceIds[],
        so its published `sentenceId` is undefined. */
    kind?: 'title';
```

Replace the mapping comment above the `/audio` handler's `segments` line (lines 233-238) with:

```ts
    /* On-disk segments use `startSec/endSec/sentenceIds[]` (per-group). The
     ChapterAudio contract publishes `start/end/sentenceId` (singular) — map
     each group to one outward segment, using the group's first sentence id
     as the representative. fs-10 (#412): this map is deliberately UNFILTERED,
     so `segments[k]` on the wire is `segments[k]` on disk for every k. The
     splice route resolves `segmentIndices` against the on-disk array, and the
     Listen-view resolver derives those indices from this one — filtering here
     silently shifts them apart. */
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/chapter-audio.test.ts`
Expected: PASS — the whole file, including the 4 new fs-10 cases and every pre-existing case (the `DEFAULT_SEGMENTS` refactor must not have changed behaviour).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean. This is the gate that catches a mistyped `kind` spread.

- [ ] **Step 10: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts server/src/routes/chapter-audio.ts server/src/routes/chapter-audio.test.ts
git commit -m "feat(server,openapi): publish the chapter-title segment on ChapterAudio"
```

---

### Task 2: Skip title rows in the playhead resolver without renumbering

**Files:**
- Modify: `src/lib/resolve-segment-for-sec.ts:1-45`
- Test: `src/lib/resolve-segment-for-sec.test.ts`

**Interfaces:**
- Consumes: `kind?: 'title'` on `ChapterSegment` (Task 1). `ChapterSegment` is already exported from this module as `NonNullable<ChapterAudio['segments']>[number]`, so it picks the field up automatically once the types are regenerated.
- Produces: no signature change. `resolveSegmentForSec(sec, segments)` still returns `{ characterId: string; segmentIndex: number } | null`; `segmentIndex` is now genuinely the on-disk index.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/resolve-segment-for-sec.test.ts`:

```ts
/* fs-10 (#412) — the published segments array now includes the synthetic
   chapter-title beat at index 0. It must never be RETURNED (it has no
   sentences, so the splice route rejects it) but must still OCCUPY its index,
   because the returned index addresses the on-disk array. */
describe('resolveSegmentForSec — chapter-title segments (fs-10)', () => {
  const TITLE_LED: ChapterSegment[] = [
    { start: 1.5, end: 3.5, characterId: 'narrator', kind: 'title' },
    { start: 5, end: 15, characterId: 'narrator', sentenceId: 1 },
    { start: 15, end: 25, characterId: 'halloran', sentenceId: 2 },
  ];

  it('does not return the title row for a marker dropped in the lead silence', () => {
    /* sec=1.0 sits before the title beat. Without the kind guard the title wins
       the nearest-edge fallback (it carries the narrator's characterId, so the
       existing !characterId guard waves it through) and this returns index 0. */
    expect(resolveSegmentForSec(1.0, TITLE_LED)).toEqual({
      characterId: 'narrator',
      segmentIndex: 1,
    });
  });

  it('clamps a marker dropped ON the title to the first body segment', () => {
    expect(resolveSegmentForSec(2.5, TITLE_LED)).toEqual({
      characterId: 'narrator',
      segmentIndex: 1,
    });
  });

  it('returns disk-aligned indices for body segments in a title-led chapter', () => {
    expect(resolveSegmentForSec(10, TITLE_LED)).toEqual({
      characterId: 'narrator',
      segmentIndex: 1,
    });
    expect(resolveSegmentForSec(20, TITLE_LED)).toEqual({
      characterId: 'halloran',
      segmentIndex: 2,
    });
  });

  it('skips a title row WITHOUT renumbering the rows after it', () => {
    /* The guard must `continue` inside the index loop, never filter the array.
       A filtering implementation would return 1 here instead of 2. */
    const midTitle: ChapterSegment[] = [
      { start: 0, end: 10, characterId: 'narrator', sentenceId: 1 },
      { start: 10, end: 12, characterId: 'narrator', kind: 'title' },
      { start: 12, end: 22, characterId: 'halloran', sentenceId: 2 },
    ];
    expect(resolveSegmentForSec(15, midTitle)).toEqual({
      characterId: 'halloran',
      segmentIndex: 2,
    });
    expect(resolveSegmentForSec(11, midTitle)).toEqual({
      characterId: 'narrator',
      segmentIndex: 0,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/resolve-segment-for-sec.test.ts -t "fs-10"`
Expected: FAIL — **three of the four cases**, for two different reasons:

1. `'does not return the title row for a marker dropped in the lead silence'` — returns `segmentIndex: 0`; the title wins the nearest-edge fallback (`resolve-segment-for-sec.ts:37-40`).
2. `'clamps a marker dropped ON the title to the first body segment'` — returns `segmentIndex: 0` via the direct-hit branch (`:33-35`).
3. `'skips a title row WITHOUT renumbering the rows after it'` — its **second** assertion, `resolveSegmentForSec(11, midTitle)`, direct-hits the mid-array title at `[10, 12)` and returns `segmentIndex: 1` where the test expects `0`. Its first assertion already passes.

`'returns disk-aligned indices for body segments in a title-led chapter'` passes both before and after — it is a guard rail against a filtering implementation, not a fails-before assertion.

- [ ] **Step 3: Add the guard**

In `src/lib/resolve-segment-for-sec.ts`, inside the loop, add the title guard directly after the existing `characterId` guard (line 29):

```ts
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.characterId) continue;
    /* fs-10 (#412) — the synthetic chapter-title beat carries the narrator's
       characterId but no sentences, so the splice route rejects it outright
       (`isRerecordableSegment`). Skip it as a CANDIDATE while leaving `i`
       untouched: the returned index addresses the on-disk array, and that
       array contains the title. Never filter — that would renumber. */
    if (seg.kind === 'title') continue;
    const start = seg.start ?? 0;
```

- [ ] **Step 4: Update the module doc comment**

The header (lines 1-5) claims the returned index matches the splice route's. That was false before this change and is true after; make the comment say why it holds. Replace lines 1-5 with:

```ts
/* fs-26 (#480) — resolve a Listen-view playhead second to the chapter audio
   segment that contains it, so a re-record marker can be scoped to exactly the
   line under the marker. Segments carry start/end seconds + characterId; the
   segment index is its position in the chapter's `segments` array — the same
   index the splice route's `segmentIndices` addresses.

   That alignment is real only because the ChapterAudio endpoint publishes the
   on-disk segments array unfiltered (fs-10 / #412). Title rows are skipped as
   candidates below but still occupy their index. If anything ever re-filters
   the wire array, this function's contract breaks silently and "Fix this line"
   starts re-recording the wrong line — the failure mode fs-10 fixed. */
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/resolve-segment-for-sec.test.ts`
Expected: PASS — all cases, old and new.

- [ ] **Step 6: Commit**

```bash
git add src/lib/resolve-segment-for-sec.ts src/lib/resolve-segment-for-sec.test.ts
git commit -m "fix(frontend): stop Fix-this-line targeting the line before the marker"
```

---

### Task 3: Paint the title band on the mini-player scrubber

**Files:**
- Modify: `src/components/mini-player.tsx:97, 723-738`
- Test: `src/components/mini-player.test.tsx`

**Interfaces:**
- Consumes: `kind?: 'title'` (Task 1). `audio` state already holds the full `ChapterAudio` including `segments` (`mini-player.tsx:236`).
- Produces: DOM node `data-testid="mini-player-title-segment"`, a `<span>` inside `data-testid="mini-player-scrubber"`. Task 6's e2e asserts on it.

- [ ] **Step 1: Write the failing tests**

In `src/components/mini-player.test.tsx`, first extend the shared `resolveChapter` helper (line 177) so a test can supply segments. Change its signature and body:

```ts
async function resolveChapter(
  id: number,
  url: string,
  segments: ChapterAudio['segments'] = [],
) {
  const resolver = pendingByChapter.get(id);
  if (!resolver) throw new Error(`No pending fetch for chapter ${id}`);
  /* The .then handler in MiniPlayer's Effect 1 fires setAudio when this
     resolves; wrap in act so React's commit + Effect 2 run inside the
     test's act window instead of leaking past it. */
  await act(async () => {
    resolver({ url, durationSec: 600, peaks: [], sampleRate: 44100, segments });
  });
}
```

Add `import type { ChapterAudio } from '../lib/types';` to the file's imports if it is not already present.

Then append the new describe:

```ts
/* fs-10 (#412) — the chapter-title beat is painted as a labelled band at the
   head of the scrubber. It is DECORATIVE: clicks must reach the scrubber
   underneath, not hard-seek to 0. See the spec's §6.1 for why. */
describe('MiniPlayer — chapter-title band (fs-10)', () => {
  const TITLE_SEGMENTS: ChapterAudio['segments'] = [
    { start: 1.5, end: 3.5, characterId: 'narrator', kind: 'title' },
    { start: 5, end: 600, characterId: 'narrator', sentenceId: 1 },
  ];

  /* Named to avoid shadowing the file's existing `renderPlayer(ui)` helper at
     `:39`, which takes a different argument entirely. */
  function renderTitleBandPlayer() {
    return render(
      <Provider store={makeStore()}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
  }

  it('renders the band with payload-derived geometry and label', async () => {
    renderTitleBandPlayer();
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3', TITLE_SEGMENTS);

    const band = await screen.findByTestId('mini-player-title-segment');
    /* 1.5s of a 600s chapter = 0.25% from the left. */
    expect(band.style.left).toBe('0.25%');
    expect(band).toHaveAttribute('title', 'Chapter title · 0:01–0:03');
  });

  it('renders nothing for a legacy chapter with no title segment', async () => {
    renderTitleBandPlayer();
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3', [
      { start: 0, end: 600, characterId: 'narrator', sentenceId: 1 },
    ]);

    await screen.findByTestId('mini-player-scrubber');
    expect(screen.queryByTestId('mini-player-title-segment')).toBeNull();
  });

  it('is decorative — clicking it scrubs to the click position, not to 0', async () => {
    renderTitleBandPlayer();
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3', TITLE_SEGMENTS);

    const band = await screen.findByTestId('mini-player-title-segment');
    const scrubber = screen.getByTestId('mini-player-scrubber');
    /* jsdom reports a zero-size rect; stub the scrubber's so onScrub's
       percentage maths has real numbers to work with. */
    scrubber.getBoundingClientRect = () =>
      ({ left: 0, width: 400, top: 0, height: 28, right: 400, bottom: 28, x: 0, y: 0 }) as DOMRect;

    /* Click 2px in — genuinely ON the band. A hard-seek-to-0 implementation
       would show 0:00; a pass-through shows 2/400 * 600s = 3s. */
    fireEvent.click(band, { clientX: 2 });
    expect(screen.getByText('0:03')).toBeInTheDocument();
  });

  it('is not a focusable control', async () => {
    renderTitleBandPlayer();
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3', TITLE_SEGMENTS);

    const band = await screen.findByTestId('mini-player-title-segment');
    /* Assert the CONTRACT (not a control, not in the tab order), not the tag
       name — pinning `=== 'SPAN'` would freeze an incidental choice and make a
       later div/span swap look like a regression. */
    expect(band.tagName).not.toBe('BUTTON');
    expect(band).not.toHaveAttribute('tabindex');
    expect(screen.queryByRole('button', { name: /chapter title/i })).toBeNull();
  });
});
```

Ensure `fireEvent` is imported from `@testing-library/react` at the top of the file; add it to the existing import if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/mini-player.test.tsx -t "fs-10"`
Expected: FAIL — `Unable to find an element by: [data-testid="mini-player-title-segment"]` on three of the four cases.

- [ ] **Step 3: Derive the title segment**

In `src/components/mini-player.tsx`, immediately after the `issueSummary` memo (line 107), add:

```ts
  /* fs-10 (#412) — the synthetic narrator-voiced chapter-title beat, when this
     render has one. Chapters rendered before PR #101 have none, and the band
     null-renders for them.

     `kind` is currently a single-value enum. If a future render ever adds a
     third kind (`'silence'`, `'credits'`, …), this find() silently ignores it
     rather than mis-painting it — but any NEW consumer written as
     `kind === 'title' ? A : B` would quietly bin it into B. Widen deliberately,
     not by accident (spec §3). */
  const titleSegment = useMemo(
    () => audio.segments?.find((s) => s.kind === 'title') ?? null,
    [audio.segments],
  );
```

- [ ] **Step 4: Render the band**

In the scrubber container (line 723), insert the band between `<Waveform …/>` and the progress underline, so the progress bar and thumb stay painted on top:

```tsx
            <div
              onClick={onScrub}
              data-testid="mini-player-scrubber"
              className="flex-1 relative cursor-pointer group h-7"
            >
              <Waveform progress={progress} active peaks={audio.peaks} issues={audio.peaks?.length ? issues : undefined} />
              {/* fs-10 — decorative band marking the chapter-title beat. NOT a
                  button: it deliberately has no onClick and does not stop
                  propagation, so a click here reaches onScrub above and scrubs
                  normally. A floored width makes a ~2 s beat visible in a
                  40-minute chapter without swallowing the track underneath. */}
              {titleSegment && totalSec > 0 && (
                <span
                  data-testid="mini-player-title-segment"
                  role="img"
                  aria-label={`Chapter title, ${formatTime(titleSegment.start ?? 0)} to ${formatTime(titleSegment.end ?? 0)}`}
                  title={`Chapter title · ${formatTime(titleSegment.start ?? 0)}–${formatTime(titleSegment.end ?? 0)}`}
                  className="absolute inset-y-0 rounded bg-peach/60"
                  style={{
                    left: `${(((titleSegment.start ?? 0) / totalSec) * 100).toFixed(2)}%`,
                    width: `max(4px, ${((((titleSegment.end ?? 0) - (titleSegment.start ?? 0)) / totalSec) * 100).toFixed(2)}%)`,
                  }}
                />
              )}
              <div
                className="absolute bottom-0 left-0 h-[2px] rounded-full bg-gradient-progress pointer-events-none"
                style={{ width: `${progress * 100}%` }}
              />
```

Leave the `scrubber-thumb` span that follows exactly as it is.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/mini-player.test.tsx`
Expected: PASS — the whole file. The `resolveChapter` default parameter keeps every pre-existing caller passing `segments: []` as before.

- [ ] **Step 6: Commit**

```bash
git add src/components/mini-player.tsx src/components/mini-player.test.tsx
git commit -m "feat(frontend): mark the chapter-title beat on the mini-player scrubber"
```

---

### Task 4: Give the Generation strip a neutral title band

**Files:**
- Modify: `src/views/generation.tsx:2323-2339`
- Test: `src/views/generation.test.tsx:2766-2801`

**Interfaces:**
- Consumes: `kind?: 'title'` (Task 1).
- Produces: DOM node `data-testid="segment-band-title"` inside the "Narrative order" strip.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('ChapterSegmentStrip — issue waveform', …)` block in `src/views/generation.test.tsx` (the block spans 2766-2801; insert before its closing `});`):

```ts
  /* fs-10 (#412) — the chapter-title beat reaches this strip now that the
     server stops filtering it. It carries the narrator's characterId but no
     sentences, so it must NOT be painted in the narrator's palette colour. */
  it('paints the chapter-title beat neutrally, not in the narrator colour', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue({
      ...baseAudio,
      segments: [
        { start: 1.5, end: 3.5, characterId: 'narrator', kind: 'title' },
        { start: 5, end: 20, characterId: 'narrator', sentenceId: 1 },
      ],
    } as never);
    render(<ChapterSegmentStrip chapter={{ id: 1 } as never} bookId="b" characters={[]} />);

    const band = await screen.findByTestId('segment-band-title');
    expect(band).toHaveAttribute('title', 'Chapter title · 0:01–0:03');
    expect(band).toHaveClass('bg-ink/25');
    expect(band.style.background).toBe('');
  });

  it('renders no title band for a legacy chapter without one', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue({
      ...baseAudio,
      segments: [{ start: 0, end: 20, characterId: 'narrator', sentenceId: 1 }],
    } as never);
    render(<ChapterSegmentStrip chapter={{ id: 1 } as never} bookId="b" characters={[]} />);

    await screen.findByText('Narrative order');
    expect(screen.queryByTestId('segment-band-title')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/views/generation.test.tsx -t "title band"`
Expected: FAIL on `'paints the chapter-title beat neutrally, not in the narrator colour'` — `Unable to find an element by: [data-testid="segment-band-title"]`. The second new case (`'renders no title band for a legacy chapter without one'`) passes before the change too; it is a guard rail. Both match the `title band` filter — do not filter on `chapter-title beat`, which matches only the first.

- [ ] **Step 3: Branch on `kind` in the band map**

In `src/views/generation.tsx`, replace the map callback body (lines 2324-2338) with:

```tsx
        {audio.segments.map((seg, i) => {
          const start = seg.start ?? 0;
          const end = seg.end ?? start;
          const width = ((end - start) / audio.durationSec) * 100;
          /* fs-10 — the synthetic chapter-title beat carries the narrator's
             characterId but has no sentences behind it. Paint it neutral so the
             strip doesn't read as "the narrator has a line here", and floor its
             width so a ~2 s beat stays visible in a 40-minute chapter.

             NOTE: this is an explicit `=== 'title'` test, so a future third
             `kind` would fall through to the character-palette branch below and
             be painted as if someone spoke it. Revisit here when `kind` widens
             (spec §3). */
          if (seg.kind === 'title') {
            return (
              <div
                key={i}
                data-testid="segment-band-title"
                className="bg-ink/25"
                title={`Chapter title · ${formatTime(start)}–${formatTime(end)}`}
                style={{ width: `${width}%`, minWidth: 3 }}
              />
            );
          }
          const charId = seg.characterId ?? '';
          const charColor = findChar(charId)?.color ?? 'narrator';
          const hex = CHAR_COLORS[charColor]?.hex ?? CHAR_COLORS.narrator.hex;
          return (
            <div
              key={i}
              title={`${findChar(charId)?.name ?? (charId || 'unknown')} · ${formatTime(start)}–${formatTime(end)}`}
              style={{ width: `${width}%`, background: hex }}
            />
          );
        })}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/views/generation.test.tsx -t "ChapterSegmentStrip"`
Expected: PASS — the new pair plus the three pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/views/generation.tsx src/views/generation.test.tsx
git commit -m "feat(frontend): fill the chapter-title band neutrally in the narrative-order strip"
```

---

### Task 5: Give the mock a production-shaped title segment

**Files:**
- Modify: `src/lib/api.ts:1712-1762`
- Test: (no new test — this task's gate is that every existing suite stays green)

**Interfaces:**
- Consumes: `kind?: 'title'` (Task 1).
- Produces: `mockGetChapterAudio` returns 5 segments, index 0 being the title. Task 6's e2e depends on this.

**Why production geometry matters:** the real renderer emits `CHAPTER_LEAD_SILENCE_SEC = 1.5` of silence, then the title beat, then `CHAPTER_POST_TITLE_SILENCE_SEC` before the first body segment (`server/src/tts/synthesise-chapter.ts:387, 1078-1099`). A mock title spanning `[0, 3]` on top of a body segment that also starts at 0 would produce a shape the server cannot emit, and would make `resolveSegmentForSec`'s "direct hit wins immediately" branch order-dependent in a way no real payload is.

- [ ] **Step 1: Insert the title segment and open a gap for it**

In `src/lib/api.ts`, in `mockGetChapterAudio`, replace the `segments` array (lines 1738-1761) with:

```ts
    segments: [
      /* fs-10 — production always emits a title beat first: 1.5 s of lead
         silence, the narrator-voiced title, then post-title silence before the
         first body segment. Mirroring that geometry (rather than tiling from 0)
         is what makes the frontend tests say something true about the real
         payload. */
      { start: 1.5, end: 3.5, characterId: 'narrator', kind: 'title' as const },
      { start: 5, end: third, characterId: 'narrator', sentenceId: 1 },
      {
        start: third,
        end: third * 2,
        characterId: isFlaggedDemoChapter ? 'dockhand-remy' : 'halloran',
        sentenceId: 2,
        suspect: true,
        reasons: isFlaggedDemoChapter
          ? ['Content drift — heard "the ropes" where the script says "the ledger."']
          : ['Long sentence — possible truncation'],
      },
      { start: third * 2, end: lateStart, characterId: 'narrator', sentenceId: 3 },
      {
        start: lateStart,
        end: totalSec,
        characterId: 'narrator',
        sentenceId: 4,
        suspect: true,
        reasons: isFlaggedDemoChapter
          ? ['Near-silent — dead air detected before this line.']
          : ['Pacing anomaly — possible mispronunciation'],
      },
    ],
```

Note the only change to the four existing entries is the first body segment's `start: 0` → `start: 5`. Every `suspect` segment keeps its exact `start`/`end`, which is what `api-demo-capture.test.ts` asserts on.

- [ ] **Step 2: Run the suites the spec predicted would survive**

Run: `npx vitest run src/lib/api-demo-capture.test.ts src/components/mini-player.test.tsx src/components/layout.test.tsx src/views/generation.test.tsx src/routes/index.test.tsx`
Expected: PASS. These read `suspect`/`characterId`/`start`/`end`, use hand-built fixtures, or pass `segments: []`.

If any fails, do **not** loosen the assertion — read it and report which prediction in the spec's §8 was wrong.

- [ ] **Step 3: Run the whole frontend suite**

Run: `npm test`
Expected: PASS. A shared mock change has a wide blast radius; the full suite is the honest gate here, not a targeted subset.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "test(mocks): give mock chapter audio a production-shaped title segment"
```

---

### Task 6: End-to-end coverage and visual baselines

**Files:**
- Create: `e2e/listen-title-segment.spec.ts`
- Verify (expected unchanged): `e2e/{win32,linux}/**` visual baselines — see Step 3

**Interfaces:**
- Consumes: `data-testid="mini-player-title-segment"` (Task 3), `data-testid="segment-band-title"` (Task 4), the mock title segment (Task 5).
- Produces: nothing downstream.

**Scope note:** this e2e covers the *band* only. It cannot cover the Task 2 index fix — mock mode has no disk, and `mockStreamSplice` (`src/lib/api.ts:1670-1684`) fabricates the SSE without ever reading `segmentIndices`. The index guarantee comes from Task 1's server test plus Task 2's resolver test, composed. Do not add an e2e that appears to test it.

- [ ] **Step 1: Write the spec**

Create `e2e/listen-title-segment.spec.ts`:

```ts
/* fs-10 (#412) — browser-level coverage for the chapter-title band on the
 * Listen view's mini-player scrubber.
 *
 * Scope: the band's presence and labelling only. The segment-index fix that
 * shipped alongside it (spec §5) lives at a wire→disk seam that mock mode has
 * no way to reach, so it is covered by the server + resolver unit tests. */

import { test, expect, type Page } from '@playwright/test';

/* Serial for the same reason as mini-player-features.spec.ts: audio-element
   tests race each other under parallel-worker contention on Windows. */
test.describe.configure({ mode: 'serial' });

async function openSolwayBay(page: Page): Promise<void> {
  await page.goto('/#/books/sb/listen');
  await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
}

async function startPlaybackFromStart(page: Page): Promise<void> {
  const playButton = page.getByRole('button', { name: /Play from the start/i });
  await expect(playButton).toBeVisible({ timeout: 5_000 });
  await expect(playButton).toBeEnabled({ timeout: 5_000 });
  await playButton.click();
  await expect(page.locator('audio')).toHaveCount(1, { timeout: 3_000 });
}

test.describe('fs-10 — chapter-title band', () => {
  test('renders at the head of the mini-player scrubber, labelled', async ({ page }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    const band = page.getByTestId('mini-player-title-segment');
    await expect(band).toBeVisible({ timeout: 5_000 });
    await expect(band).toHaveAttribute('title', /^Chapter title · /);
  });

  test('is decorative — it adds no control to the player', async ({ page }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    const band = page.getByTestId('mini-player-title-segment');
    await expect(band).toBeVisible({ timeout: 5_000 });

    /* The band must not become a tab stop or a named control — the whole point
       of §6.1 is that it is a cue, not a competing affordance over the
       scrubber. Asserting the click-through behaviour itself belongs in the
       Vitest spec, where the scrubber's rect can be stubbed; in a real browser
       the band is ~4 px wide and distinguishing "scrubbed to 2 px" from
       "hard-seeked to 0" would be a flake, not a test. */
    await expect(band).not.toHaveAttribute('tabindex');
    expect(await band.evaluate((el) => el.tagName)).toBe('SPAN');
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test e2e/listen-title-segment.spec.ts --project=chromium`
Expected: PASS, 2 tests. If chromium is missing, run `npx playwright install chromium` first.

- [ ] **Step 3: Check the visual baselines — expect PASS, not FAIL**

Run: `npm run test:e2e:visual`
Expected: **PASS.**

This is a verification step, not a regeneration trigger, and the reasoning matters because the obvious assumption is wrong. `e2e/responsive/visual.spec.ts:92` sets `VISUAL_DIFF_OPTS = { maxDiffPixelRatio: 0.05 }` — 5 % of a 1280×720 viewport is ~46,000 pixels. The change to `generate.png` is, per visible chapter row, a ~3 px neutral band plus a ~5 px shift of one boundary inside an `h-2` (8 px tall) strip: order 10²–10³ pixels in total, comfortably inside tolerance. The committed baselines stay valid, which is exactly what the tolerance exists for.

**Do not "fix" a passing run by force-regenerating.** A bare `--update-snapshots` defaults to `=changed` and would write nothing at all (documented as trap #922 in `.github/workflows/regen-visual-baselines.yml:104`), and `--update-snapshots=all` would re-bless all 51 baselines on both platforms — re-baking every unrelated view against whatever chromium build happens to be present. Neither is wanted here.

**Only if Step 3 actually FAILS** does a regen enter scope. In that case:
1. Read the reported diff ratio — a real failure means the delta exceeded 5 %, which would be surprising and worth understanding before re-baking.
2. Regenerate win32 locally with `npx playwright test e2e/responsive/visual.spec.ts --project=chromium --workers=1 --update-snapshots=all` (the `=all` form, per the trap above), inspect `git status --short e2e/win32/`, and stage only what genuinely moved.
3. Regenerate linux via `gh workflow run regen-visual-baselines.yml --ref feat/frontend-fs10-title-segment`, wait ~10-15 min, then merge the pushed branch directly: `git fetch origin && git merge origin/ci/linux-visual-baselines-regen-<N>`. (The workflow's own `gh pr create` targets `main`, which is the wrong base for this purpose, and reportedly fails anyway on the repo's Actions-cannot-open-PRs setting.) The linux baselines are the ones CI validates: `e2e-visual` is its own job in `.github/workflows/verify.yml:339` and sits in the final gate's `needs:` (`:395`), so a genuinely stale linux baseline blocks merge.
4. Add the rebake back to the PR body's test plan, which currently does not claim it.

- [ ] **Step 4: Commit**

```bash
git add e2e/listen-title-segment.spec.ts
git commit -m "test(e2e): cover the chapter-title band on the mini-player scrubber"
```

---

### Task 7: Documentation, release notes, and the PR

**Files:**
- Modify: `docs/features/176-character-splice.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped PR.

- [ ] **Step 1: Update the active splice plan**

`docs/features/176-character-splice.md` is `status: active` and its 2026-06-05 entry documents the exact resolver → `segmentIndices` flow Task 2 changes. `CLAUDE.md`'s before-shipping checklist step 1 requires updating it in the same diff. Append a new paragraph after that entry:

```markdown
**Correction 2026-07-24 (fs-10 / #412):** the marker → `segmentIndex` →
`segmentIndices` chain described above was off by one for every chapter with a
voiced title beat. `resolveSegmentForSec` returns a position in the *published*
`ChapterAudio.segments` array, but `chapter-splice.ts` resolves `segmentIndices`
against the *on-disk* array — and the chapter-audio route was filtering the
`kind: 'title'` row out of the published one. "Fix this line" therefore targeted
the line **before** the marked one: silently re-recording the wrong line when
both belonged to the same speaker, and failing with `"segmentIndices must all
belong to the character in this chapter."` at a speaker boundary or `"No
re-recordable lines for this character in this chapter (title-only)."` when the
marked line was the chapter's first. fs-10 removed the filter (the two arrays
are now index-identical, pinned by a `sentenceId`-matched assertion in
`server/src/routes/chapter-audio.test.ts`) and taught the resolver to skip title
rows without renumbering. Anything that re-filters the published array
reintroduces this bug.
```

- [ ] **Step 2: Append to the technical release register**

First confirm the cycle is still open: `docs/release-notes-next.md` must still carry `release-notes-next-version: 1.14.0` and `RELEASE_NOTES.md` must still open with `# Castwright 1.14.0`. Both were true on 2026-07-24 and v1.14.0 was uncut. **If the marker has moved on, v1.14.0 was cut in the meantime and this is the first PR after a cut** — follow the reset procedure in [CONTRIBUTING.md "Release notes"](../../CONTRIBUTING.md#release-notes) rather than appending to a shipped section.

Add the bullet to `docs/release-notes-next.md` in the themed section that fits (the file is organised `## ✨ Headline features` → emoji-themed sections → bold-lead bullets); a listener-facing player change belongs with the other playback/Listen entries, not under a server or analyzer heading:

```markdown
- **fs-10 — chapter-title segment on the Listen timeline** (#412). `ChapterAudio.segments[]`
  gains an optional `kind: 'title'` discriminator and the chapter-audio route stops filtering the
  synthetic title beat out of both `/audio` and `/audio/previous`. The mini-player scrubber paints
  it as a decorative labelled band; the Generation view's "Narrative order" strip fills it neutrally
  rather than in the narrator's colour. **Also fixes a latent off-by-one:** because the published
  array was short one leading row, `resolveSegmentForSec`'s index no longer matched the on-disk
  index the splice route addresses, so Listen-view "Fix this line" targeted the line before the
  marked one.
```

- [ ] **Step 3: Append the user-facing line**

Add to the in-progress version section at the top of `RELEASE_NOTES.md`:

```markdown
- **You can see the chapter title on the timeline now.** Every chapter opens with its title read
  aloud — the player now shows that opening beat as a small marker at the start of the track, so
  what you see matches what you hear.
- **"Fix this line" now fixes the line you marked.** On chapters with a spoken title, marking a
  line for re-recording could quietly re-record the line before it, or fail with a confusing error
  about segment indices. Both are fixed.
```

- [ ] **Step 4: Run the branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: PASS on every in-scope leg (lint, typecheck, config:check, test:hooks, test, test:server, build).

- [ ] **Step 5: Commit and push**

```bash
git add docs/features/176-character-splice.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): record the fs-10 title segment and the splice index correction"
git push -u origin feat/frontend-fs10-title-segment
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "feat(frontend,server,openapi): render the chapter-title segment on the Listen timeline" --body "$(cat <<'EOF'
## Summary

Surfaces the synthetic narrator-voiced chapter-title beat that every render has produced since PR #101 but which no app surface could see — the chapter-audio route filtered it out at the API boundary.

- `ChapterAudio.segments[]` gains an optional `kind: 'title'`; the route publishes the title row instead of dropping it, on both `/audio` and `/audio/previous`.
- The Listen mini-player scrubber paints it as a decorative labelled band. It is deliberately **not** interactive — an earlier design made it a button, but the width floor needed to make a 2-second beat visible would have swallowed ~29 seconds of scrubbable track on a 38-minute chapter.
- The Generation view's "Narrative order" strip fills it neutrally rather than in the narrator's palette colour.

**Also fixes a live bug.** `resolveSegmentForSec` returns a position in the *published* segments array; `chapter-splice.ts` resolves `segmentIndices` against the *on-disk* array. With the title row filtered from one and not the other, the two were off by one, so Listen-view "Fix this line" targeted the line **before** the one the user marked — silently re-recording the wrong line mid-run, or failing with a confusing error at a speaker boundary. Removing the filter re-aligns them; the resolver now skips title rows without renumbering.

## Test plan

- `server/src/routes/chapter-audio.test.ts` — title row published with `kind` and no `sentenceId`; published index matches on-disk index **by `sentenceId`** for every row; same on `/audio/previous`.
- `src/lib/resolve-segment-for-sec.test.ts` — a marker in the lead silence resolves past the title (fails before the fix); a mid-array title is skipped without renumbering the rows after it.
- `src/components/mini-player.test.tsx` — band geometry and label derived from the payload; absent for legacy chapters; clicking it scrubs to the click position rather than hard-seeking to 0; not focusable.
- `src/views/generation.test.tsx` — neutral fill and `Chapter title` tooltip.
- `e2e/listen-title-segment.spec.ts` — band visible and labelled in a real browser.
- `npm run test:e2e:visual` green with the committed baselines untouched — the strip delta is well inside the suite's 5% `maxDiffPixelRatio`, so no rebake was needed.

The index fix spans a wire→disk seam that mock mode cannot reach, so it is pinned by the server and resolver tests composed, not by an e2e. This is called out in the spec and in the plan so nobody mistakes either half for the whole.

Design: `docs/superpowers/specs/2026-07-24-fs10-listen-title-segment-design.md`
Plan: `docs/superpowers/plans/2026-07-24-fs10-listen-title-segment.md`

Closes #412
EOF
)"
```

- [ ] **Step 7: Run the mandatory review gate**

Per `CLAUDE.md`'s before-shipping checklist step 9 and the model-routing skill: this is a multi-scope PR, so the `code-review` pass runs at `high` effort. Triage and fold findings before merge. Confirm `pr-title-lint`, `pr-issue-link`, and `verify.yml` are all green — including the `e2e-visual` job, which needs the linux baselines from Task 6 Step 7 merged in first.
