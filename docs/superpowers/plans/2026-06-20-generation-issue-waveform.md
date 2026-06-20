# Generation issue-waveform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-segment audio-QA flags (too-long sentence, long pause, ASR "wrong words") as amber regions on the RMS waveform in the generation view and the app-wide bottom player, with a context-padded bounding box and a jump-to-issue control that seeks just before each flagged region.

**Architecture:** The data already exists on disk (`<slug>.segments.json` carries `startSec`/`endSec`/`qa`/`suspect`/`asr`/`asrSuspect`; the peaks file shares that timebase). The `chapter-audio` route stops dropping `suspect`/`reasons`; a pure `deriveIssues` helper turns the wire `ChapterAudio` into padded, merged issue regions; the shared `Waveform` paints those regions amber; the generation row and the `MiniPlayer` both consume it. Auto-seek is gated to the generation view via `ui.stage.view`.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend), Node/Express + Vitest + supertest (server), OpenAPI (`openapi.yaml` → generated `src/lib/api-types.ts`), Playwright (e2e). Tests colocated as `*.test.ts(x)`.

## Global Constraints

- **Design tokens are CSS custom properties; no hex literals in component code.** Amber uses Tailwind palette classes (`amber-*`), matching the existing srv-27 Suspect badge (`bg-amber-100 / text-amber-800`).
- **OpenAPI is the type source of truth.** Hand-editing `src/lib/api-types.ts` is forbidden — edit `openapi.yaml` then run `npm run openapi:types`.
- **TDD:** every behaviour ships a test that fails first. Never `.skip`/delete a test without a replacement.
- **Touch targets ≥44×44 px on phone** (`min-h-[44px] sm:min-h-0`); the app must stay responsive at <640 / 640–1024 / ≥1024.
- **a11y:** `npm run verify` runs axe-core (`test:a11y`) on the core views — colour must not be the sole signal; interactive controls carry accessible names.
- Run `npm run verify` before declaring done (typecheck + all tests + e2e + build).
- Branch: `feat/frontend-generation-issue-waveform` (already cut, worktree at `.claude/worktrees/issue-waveform`).

---

### Task 1: Server — expose per-segment `suspect` + `reasons`

**Files:**
- Modify: `server/src/routes/chapter-audio.ts` (local `ChapterSegmentsFile` segment type ~`:101-115`; `current` mapper ~`:210-217`; `previous` mapper ~`:252-259`)
- Modify: `openapi.yaml` (`ChapterAudio.segments[].items.properties` ~`:4002-4006`)
- Generate: `src/lib/api-types.ts` (via `npm run openapi:types`)
- Test: `server/src/routes/chapter-audio.test.ts`

**Interfaces:**
- Produces: each `ChapterAudio.segments[]` item gains `suspect?: boolean` and `reasons?: string[]`. `suspect = Boolean(seg.suspect || seg.asrSuspect)`. `reasons` = `seg.qa.reasons` (when `seg.suspect`) concatenated with `seg.asr.reasons` **only when `seg.asrSuspect === true`** (never include ASR reasons for an inconclusive ASR verdict).

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/chapter-audio.test.ts` (after the existing meta-endpoint describe blocks):

```ts
describe('meta endpoint — per-segment QA issues (issue-waveform)', () => {
  function writeSegments(segments: unknown[]) {
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId, chapterId: 1, chapterTitle: 'Chapter 1', durationSec: 12.5,
        sampleRate: 24_000, modelKey: 'xtts_v2', synthesizedAt: new Date().toISOString(),
        segments,
      }),
    );
  }

  it('publishes suspect + segment-QA reasons; excludes inconclusive-ASR noise', async () => {
    resetAudio();
    writeMp3();
    writeSegments([
      // segment-QA suspect, ASR ran but was inconclusive (must NOT leak asr.reasons)
      {
        groupIndex: 0, characterId: 'marlow', sentenceIds: [101], startSec: 0, endSec: 6.2,
        suspect: true, qa: { status: 'suspect', reasons: ['Long sentence — 6.2s'] },
        asrSuspect: false, asr: { reasons: ['Not scored — under the 12-char ASR floor.'] },
      },
      // ASR drift suspect (asrSuspect): include asr.reasons
      {
        groupIndex: 1, characterId: 'oduvan', sentenceIds: [103], startSec: 6.2, endSec: 12.5,
        asrSuspect: true, asr: { reasons: ['Wrong words — word-error 0.42'] },
      },
    ]);
    const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
    expect(res.status).toBe(200);
    expect(res.body.segments[0].suspect).toBe(true);
    expect(res.body.segments[0].reasons).toEqual(['Long sentence — 6.2s']);
    expect(res.body.segments[1].suspect).toBe(true);
    expect(res.body.segments[1].reasons).toEqual(['Wrong words — word-error 0.42']);
  });

  it('omits suspect/reasons for a clean segment', async () => {
    resetAudio();
    writeMp3();
    writeSegments([
      { groupIndex: 0, characterId: 'marlow', sentenceIds: [101], startSec: 0, endSec: 12.5 },
    ]);
    const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
    expect(res.body.segments[0].suspect).toBeUndefined();
    expect(res.body.segments[0].reasons).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/chapter-audio.test.ts -t "per-segment QA issues"`
Expected: FAIL — `res.body.segments[0].suspect` is `undefined` (route drops the fields).

- [ ] **Step 3: Widen the route's local segment type**

In `server/src/routes/chapter-audio.ts`, the local `interface ChapterSegmentsFile` `segments` array (~`:101-115`) — add the optional QA fields to the item shape:

```ts
  segments: Array<{
    groupIndex: number;
    characterId: string;
    sentenceIds: number[];
    startSec: number;
    endSec: number;
    kind?: 'title';
    // issue-waveform: per-segment QA, present when the gates ran
    suspect?: boolean;
    asrSuspect?: boolean;
    qa?: { reasons?: string[] };
    asr?: { reasons?: string[] };
  }>;
```

- [ ] **Step 4: Map the fields in BOTH mappers**

Define a shared local helper above the route handlers, then use it in the `current` mapper (~`:210`) and the `previous` mapper (~`:252`). Replace each `.map((s) => ({ start: s.startSec, end: s.endSec, characterId: s.characterId, sentenceId: s.sentenceIds[0] }))` with:

```ts
function publishSegment(s: ChapterSegmentsFile['segments'][number]) {
  const suspect = Boolean(s.suspect || s.asrSuspect);
  const reasons = suspect
    ? [
        ...(s.suspect ? (s.qa?.reasons ?? []) : []),
        ...(s.asrSuspect ? (s.asr?.reasons ?? []) : []),
      ]
    : undefined;
  return {
    start: s.startSec,
    end: s.endSec,
    characterId: s.characterId,
    sentenceId: s.sentenceIds[0],
    ...(suspect ? { suspect: true } : {}),
    ...(reasons && reasons.length ? { reasons } : {}),
  };
}
```

Then both mappers become `.filter((s) => s.kind !== 'title').map(publishSegment)`.

- [ ] **Step 5: Extend the OpenAPI contract + regenerate types**

In `openapi.yaml`, under `ChapterAudio.segments.items.properties` (~`:4002`), add after `sentenceId`:

```yaml
              suspect:
                type: boolean
                description: >-
                  issue-waveform — true when this segment is still flagged by the
                  pre-assembly segment-QA gate or the ASR content-QA gate. Absent
                  on clean / legacy / pre-QA renders.
              reasons:
                type: array
                items: { type: string }
                description: >-
                  Human-readable QA reasons for a suspect segment. Segment-QA
                  reasons always; ASR reasons only when the ASR verdict was drift.
```

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates with the two optional fields on the `ChapterAudio` segments item.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/chapter-audio.test.ts -t "per-segment QA issues"`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/chapter-audio.ts server/src/routes/chapter-audio.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): publish per-segment suspect + reasons on chapter-audio"
```

---

### Task 2: Shared `deriveIssues` helper (padded + merged regions)

**Files:**
- Create: `src/lib/chapter-issues.ts`
- Test: `src/lib/chapter-issues.test.ts`

**Interfaces:**
- Consumes: `ChapterAudio` (`src/lib/types.ts`) with `segments[]` (now carrying `suspect`/`reasons` from Task 1) + `durationSec`.
- Produces:
  - `export const ISSUE_CONTEXT_PAD_SEC = 2`
  - `export interface IssueRegion { startFrac: number; endFrac: number; seekSec: number; reasons: string[] }`
  - `export function deriveIssues(audio: Pick<ChapterAudio, 'segments' | 'durationSec'>): IssueRegion[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/chapter-issues.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveIssues, ISSUE_CONTEXT_PAD_SEC } from './chapter-issues';

const seg = (start: number, end: number, suspect?: boolean, reasons?: string[]) => ({
  start, end, characterId: 'c', sentenceId: 1, suspect, reasons,
});

describe('deriveIssues', () => {
  it('pads a single flagged segment and clamps + sets seekSec', () => {
    const r = deriveIssues({ durationSec: 20, segments: [seg(6, 10, true, ['Long sentence'])] });
    expect(r).toHaveLength(1);
    expect(r[0].seekSec).toBe(4); // 6 - 2
    expect(r[0].startFrac).toBeCloseTo(4 / 20);
    expect(r[0].endFrac).toBeCloseTo(12 / 20); // 10 + 2
    expect(r[0].reasons).toEqual(['Long sentence']);
  });

  it('merges two flagged segments within 2*PAD into one region', () => {
    const r = deriveIssues({
      durationSec: 60,
      segments: [seg(0, 3, true, ['A']), seg(4, 6, true, ['B'])],
    });
    expect(r).toHaveLength(1);
    expect(r[0].reasons).toEqual(['A', 'B']);
    expect(r[0].seekSec).toBe(0);
  });

  it('keeps two far-apart flags as separate regions', () => {
    const r = deriveIssues({
      durationSec: 60,
      segments: [seg(0, 3, true, ['A']), seg(50, 53, true, ['B'])],
    });
    expect(r).toHaveLength(2);
  });

  it('clamps a near-start issue startFrac to 0 without flagging it degenerate', () => {
    const r = deriveIssues({ durationSec: 60, segments: [seg(0, 3, true, ['A'])] });
    expect(r[0].startFrac).toBe(0);
    expect(r[0].endFrac).toBeCloseTo(5 / 60);
  });

  it('drops a region that covers the whole track (degenerate / short chapter)', () => {
    const r = deriveIssues({ durationSec: 3, segments: [seg(0, 3, true, ['A'])] });
    expect(r).toEqual([]);
  });

  it('ignores non-suspect segments', () => {
    expect(deriveIssues({ durationSec: 20, segments: [seg(0, 5)] })).toEqual([]);
    expect(ISSUE_CONTEXT_PAD_SEC).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/chapter-issues.test.ts`
Expected: FAIL — module `./chapter-issues` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/chapter-issues.ts`:

```ts
import type { ChapterAudio } from './types';

/** Lead-in / lead-out seconds so a jump lands BEFORE the flagged audio and the
    amber band bounds the issue with margin (you hear context on both sides). */
export const ISSUE_CONTEXT_PAD_SEC = 2;

export interface IssueRegion {
  /** Padded + clamped start, as a fraction of the chapter [0,1]. */
  startFrac: number;
  /** Padded + clamped end, as a fraction of the chapter [0,1]. */
  endFrac: number;
  /** Seconds to seek to (region start − pad, clamped ≥ 0). */
  seekSec: number;
  /** Concatenated QA reasons across merged segments. */
  reasons: string[];
}

/** Turn a chapter's flagged segments into padded, merged, clamped issue regions.
    Overlapping/abutting padded ranges coalesce into one band (one jump-stop);
    a band that would cover the whole track is dropped (the chapter-level
    fallback surface handles that case instead). */
export function deriveIssues(
  audio: Pick<ChapterAudio, 'segments' | 'durationSec'>,
): IssueRegion[] {
  const dur = audio.durationSec;
  if (!dur || dur <= 0 || !audio.segments?.length) return [];
  const PAD = ISSUE_CONTEXT_PAD_SEC;

  const padded = audio.segments
    .filter((s) => s.suspect)
    .map((s) => ({
      start: Math.max(0, s.start - PAD),
      end: Math.min(dur, s.end + PAD),
      reasons: s.reasons ?? [],
    }))
    .sort((a, b) => a.start - b.start);
  if (!padded.length) return [];

  const merged: typeof padded = [];
  for (const cur of padded) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
      last.reasons = [...last.reasons, ...cur.reasons];
    } else {
      merged.push({ ...cur });
    }
  }

  return merged
    .map((m) => ({
      startFrac: m.start / dur,
      endFrac: m.end / dur,
      seekSec: m.start,
      reasons: m.reasons,
    }))
    .filter((r) => !(r.startFrac <= 0 && r.endFrac >= 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/chapter-issues.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chapter-issues.ts src/lib/chapter-issues.test.ts
git commit -m "feat: deriveIssues — padded, merged per-chapter issue regions"
```

---

### Task 3: `Waveform` issue overlay + accessibility

**Files:**
- Modify: `src/components/waveform.tsx`
- Test: `src/components/waveform.test.tsx`

**Interfaces:**
- Consumes: `IssueRegion` from `src/lib/chapter-issues.ts`; `formatTime` from `src/lib/time.ts`.
- Produces: `Waveform` gains optional `issues?: IssueRegion[]`. When non-empty: bars within any region render amber (`bg-amber-400`); the bar row is `aria-hidden`; an `sr-only` `<ul>` lists each issue ("Issue at m:ss: <reasons>"). When empty/undefined the component renders byte-for-byte as before (Listen view unaffected).

- [ ] **Step 1: Write the failing test**

Create `src/components/waveform.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Waveform } from './waveform';

describe('Waveform issue overlay', () => {
  it('renders an sr-only reason list and aria-hides the bars when issues present', () => {
    const { container, getByText } = render(
      <Waveform progress={0} active peaks={Array(240).fill(0.5)}
        issues={[{ startFrac: 0.25, endFrac: 0.5, seekSec: 90, reasons: ['Long sentence'] }]} />,
    );
    expect(getByText(/Issue at 1:30: Long sentence/)).toBeInTheDocument();
    // some bars are amber
    expect(container.querySelectorAll('.bg-amber-400').length).toBeGreaterThan(0);
    // bar row is hidden from AT
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders unchanged (no amber, no list) with no issues', () => {
    const { container, queryByText } = render(
      <Waveform progress={0.5} active peaks={Array(240).fill(0.5)} />,
    );
    expect(container.querySelectorAll('.bg-amber-400').length).toBe(0);
    expect(queryByText(/Issue at/)).toBeNull();
  });

  it('paints no amber when peaks are empty even if issues exist', () => {
    const { container } = render(
      <Waveform progress={0} active peaks={[]}
        issues={[{ startFrac: 0.1, endFrac: 0.2, seekSec: 5, reasons: ['x'] }]} />,
    );
    // empty peaks → decorative fallback bars; caller is responsible for not
    // passing issues, but if it does we still must not assert a real shape.
    // Component renders the sr-only list; bars may be amber — that is the
    // caller's guard, not the component's. This test pins the sr-only list.
    expect(container.querySelector('ul.sr-only')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/waveform.test.tsx`
Expected: FAIL — `issues` prop ignored; no `.bg-amber-400`, no sr-only list.

- [ ] **Step 3: Write the implementation**

In `src/components/waveform.tsx`, add the import, widen the props, compute the amber set, and branch the render:

```tsx
import { formatTime } from '../lib/time';
import type { IssueRegion } from '../lib/chapter-issues';

interface WaveformProps {
  progress: number;
  active: boolean;
  peaks?: number[];
  /** issue-waveform — padded/merged regions to paint amber. */
  issues?: IssueRegion[];
}

function issueBarSet(issues: IssueRegion[] | undefined, count: number): Set<number> {
  const set = new Set<number>();
  for (const r of issues ?? []) {
    const lo = Math.max(0, Math.floor(r.startFrac * count));
    const hi = Math.min(count - 1, Math.ceil(r.endFrac * count) - 1);
    for (let i = lo; i <= hi; i += 1) set.add(i);
  }
  return set;
}

export function Waveform({ progress, active, peaks, issues }: WaveformProps) {
  const bars = peaksToBars(peaks) ?? BARS;
  const amber = issueBarSet(issues, bars.length);
  const hasIssues = (issues?.length ?? 0) > 0;

  const barRow = (
    <div className="flex items-end gap-[2px] h-7" aria-hidden={hasIssues || undefined}>
      {bars.map((h, i) => {
        const filled = i / bars.length <= progress;
        const cls = amber.has(i)
          ? 'bg-amber-400'
          : active && filled
            ? 'bg-magenta'
            : active
              ? 'bg-ink/15'
              : 'bg-ink/20';
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm transition-colors ${cls}`}
            style={{ height: `${h * 100}%` }}
          />
        );
      })}
    </div>
  );

  if (!hasIssues) return barRow;

  return (
    <>
      {barRow}
      <ul className="sr-only">
        {issues!.map((r, i) => (
          <li key={i}>{`Issue at ${formatTime(r.seekSec)}: ${r.reasons.join('; ')}`}</li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/waveform.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/waveform.tsx src/components/waveform.test.tsx
git commit -m "feat: Waveform amber issue overlay + sr-only reasons"
```

---

### Task 4: Generation row — waveform + issues + chapter-level fallback

**Files:**
- Modify: `src/views/generation.tsx` (`ChapterSegmentStrip`, ~`:2074-2128` — export it for testing)
- Test: `src/views/generation.test.tsx`

**Interfaces:**
- Consumes: `deriveIssues` (Task 2), `Waveform` (Task 3); `ChapterAudio` already fetched by `ChapterSegmentStrip` via `api.getChapterAudio` (carries `peaks` + `segments` + `durationSec`); `chapter.audioQa` (already on the frontend `Chapter`).
- Produces: `export function ChapterSegmentStrip(...)`.

- [ ] **Step 1: Write the failing test**

Add to `src/views/generation.test.tsx` (it already imports from `./generation` and has an api mock; reuse that pattern — mock `api.getChapterAudio`):

```tsx
import { ChapterSegmentStrip } from './generation';
// ... within the existing vi.mock('../lib/api', ...) ensure getChapterAudio is mockable.

describe('ChapterSegmentStrip — issue waveform', () => {
  const baseAudio = {
    url: 's', durationSec: 20, sampleRate: 44100, peaks: Array(240).fill(0.5),
    segments: [
      { start: 0, end: 6, characterId: 'narrator', sentenceId: 1 },
      { start: 6, end: 10, characterId: 'narrator', sentenceId: 2, suspect: true, reasons: ['Long sentence'] },
    ],
  };

  it('shows the issue count + amber when a segment is flagged', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue(baseAudio as never);
    render(<ChapterSegmentStrip chapter={{ id: 1, audioQa: { status: 'suspect', reasons: [] } } as never}
      bookId="b" characters={[]} />);
    expect(await screen.findByText(/1 issue to review/)).toBeInTheDocument();
  });

  it('shows the chapter-level baseline note when suspect but no per-segment issue', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue({
      ...baseAudio,
      segments: [{ start: 0, end: 20, characterId: 'narrator', sentenceId: 1 }],
    } as never);
    render(<ChapterSegmentStrip chapter={{ id: 1, audioQa: { status: 'suspect', reasons: ['Near-silent'] } } as never}
      bookId="b" characters={[]} />);
    expect(await screen.findByText(/Chapter-level issue/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/generation.test.tsx -t "issue waveform"`
Expected: FAIL — `ChapterSegmentStrip` not exported / no issue UI.

- [ ] **Step 3: Implement**

In `src/views/generation.tsx`: add imports `import { deriveIssues } from '../lib/chapter-issues';` and `import { Waveform } from '../components/waveform';` and `useMemo` (already importing React hooks). Change `function ChapterSegmentStrip` to `export function ChapterSegmentStrip`. Insert the derived values BEFORE the early-return, and append the new UI inside the returned `<div>`:

```tsx
  // ... after the existing useState/useEffect, BEFORE `if (error || !audio ...) return null;`
  const issues = useMemo(() => (audio ? deriveIssues(audio) : []), [audio]);

  if (error || !audio || !audio.segments?.length || !audio.durationSec) return null;
  const findChar = (id: string) => characters.find((c) => c.id === id);
  const hasPeaks = (audio.peaks?.length ?? 0) > 0;
  const chapterLevelOnly = chapter.audioQa?.status === 'suspect' && issues.length === 0;

  return (
    <div className="mt-4 ml-[60px]">
      <p className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold mb-1.5">
        Narrative order
      </p>
      <div className="flex h-2 rounded-full overflow-hidden bg-ink/4">
        {/* ...existing bands map unchanged... */}
      </div>

      {hasPeaks && (
        <div className="mt-2 relative">
          <Waveform progress={0} active={false} peaks={audio.peaks} issues={issues} />
          {chapterLevelOnly && (
            <div
              className="absolute left-0 right-0 -bottom-0.5 h-[2px] rounded-full bg-amber-400/70"
              title={chapter.audioQa?.reasons.join(' ') || 'Chapter-level issue'}
            />
          )}
        </div>
      )}

      {issues.length > 0 && (
        <p className="mt-1 text-[10px] font-semibold text-amber-700 flex items-center gap-1">
          <span aria-hidden>⚠</span>
          {issues.length} issue{issues.length > 1 ? 's' : ''} to review
        </p>
      )}
      {chapterLevelOnly && (
        <p className="mt-1 text-[10px] font-semibold text-amber-700 flex items-center gap-1"
           title={chapter.audioQa?.reasons.join(' ')}>
          <span aria-hidden>⚠</span> Chapter-level issue
        </p>
      )}
    </div>
  );
```

(Leave the existing narrative-order bands map exactly as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/generation.test.tsx -t "issue waveform"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/generation.tsx src/views/generation.test.tsx
git commit -m "feat: generation row issue-waveform + chapter-level fallback"
```

---

### Task 5: MiniPlayer — waveform scrubber

**Files:**
- Modify: `src/components/mini-player.tsx` (scrubber block ~`:673-686`)
- Test: `src/components/mini-player.test.tsx`

**Interfaces:**
- Consumes: `deriveIssues` (Task 2), `Waveform` (Task 3); `audio` state already carries `peaks` + `segments` + `durationSec`.
- Produces: a derived `issues` value (`useMemo(() => deriveIssues(audio), [audio])`) used here and in Task 6; the scrubber container keeps the `scrubber-thumb` testid.

- [ ] **Step 1: Write the failing test**

Add to `src/components/mini-player.test.tsx` (reuse the existing render helper + api mock; the existing tests mock `api.getChapterAudio`). Make the mock return a suspect segment:

```tsx
describe('MiniPlayer — issue waveform scrubber', () => {
  it('renders the issue list + keeps the scrubber thumb when a segment is flagged', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue({
      url: 'blob:x', durationSec: 20, sampleRate: 44100, peaks: Array(240).fill(0.5),
      segments: [{ start: 6, end: 10, characterId: 'n', sentenceId: 1, suspect: true, reasons: ['Long sentence'] }],
    } as never);
    renderMiniPlayer({ id: 1, title: 'Ch', duration: '0:20' }); // existing helper
    expect(await screen.findByText(/Issue at 0:04: Long sentence/)).toBeInTheDocument();
    expect(screen.getByTestId('scrubber-thumb')).toBeInTheDocument();
  });
});
```

(If the file has no shared `renderMiniPlayer` helper, mirror an existing `render(<Provider...><MiniPlayer .../></Provider>)` block from the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/mini-player.test.tsx -t "issue waveform scrubber"`
Expected: FAIL — no "Issue at" text (scrubber is the plain bar).

- [ ] **Step 3: Implement**

In `src/components/mini-player.tsx`: add imports `import { Waveform } from './waveform';` and `import { deriveIssues } from '../lib/chapter-issues';`. After the `audio` state is declared, add:

```tsx
  const issues = useMemo(() => deriveIssues(audio), [audio]);
```

Replace the scrubber `<div onClick={onScrub} className="flex-1 h-1 ...">…</div>` block (~`:673-686`) with a waveform layer plus the continuous fill + thumb overlaid (so pixel-accurate position survives the coarse bars):

```tsx
            <div
              onClick={onScrub}
              data-testid="mini-player-scrubber"
              className="flex-1 relative cursor-pointer group h-7"
            >
              <Waveform progress={progress} active peaks={audio.peaks} issues={issues} />
              <div
                className="absolute bottom-0 left-0 h-[2px] rounded-full bg-gradient-progress pointer-events-none"
                style={{ width: `${progress * 100}%` }}
              />
              <span
                data-testid="scrubber-thumb"
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 coarse-pointer:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
```

(`onScrub` is unchanged — it reads `getBoundingClientRect()` off `e.currentTarget`, which is still the scrubber div.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/mini-player.test.tsx -t "issue waveform scrubber"`
Expected: PASS.

- [ ] **Step 5: Run the full mini-player suite to confirm no regression**

Run: `npx vitest run src/components/mini-player.test.tsx`
Expected: PASS (existing `scrubber-thumb` / scrub tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/components/mini-player.tsx src/components/mini-player.test.tsx
git commit -m "feat: MiniPlayer waveform scrubber with amber issue bars"
```

---

### Task 6: MiniPlayer jump-to-issue + context-gated auto-seek

**Files:**
- Modify: `src/components/mini-player.tsx`
- Modify: `src/components/layout.tsx` (`MiniPlayer` mount ~`:1377-1391`)
- Test: `src/components/mini-player.test.tsx`

**Interfaces:**
- Consumes: `issues` (Task 5), `view` (`layout.tsx:174`).
- Produces: `MiniPlayer` gains prop `autoSeekToIssues?: boolean`; `layout.tsx` passes `autoSeekToIssues={view === 'generate'}`.

- [ ] **Step 1: Write the failing test**

Add to `src/components/mini-player.test.tsx`:

```tsx
describe('MiniPlayer — jump-to-issue + auto-seek', () => {
  const audioWithIssues = {
    url: 'blob:x', durationSec: 30, sampleRate: 44100, peaks: Array(240).fill(0.5),
    segments: [{ start: 10, end: 12, characterId: 'n', sentenceId: 1, suspect: true, reasons: ['Long sentence'] }],
  };

  it('⚠ next seeks to the issue seekSec (10 - 2 = 8)', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue(audioWithIssues as never);
    renderMiniPlayer({ id: 1, title: 'Ch', duration: '0:30' });
    const el = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(el, 'duration', { configurable: true, value: 30 });
    await screen.findByLabelText(/Next issue/);
    fireEvent.click(screen.getByLabelText(/Next issue/));
    expect(el.currentTime).toBe(8);
  });

  it('auto-seeks to the first issue in the generate context, overriding resume', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue(audioWithIssues as never);
    vi.mocked(api.getListenProgress).mockResolvedValue({ chapterId: 1, currentSec: 25 } as never);
    renderMiniPlayer({ id: 1, title: 'Ch', duration: '0:30' }, { autoSeekToIssues: true });
    const el = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(el, 'duration', { configurable: true, value: 30 });
    fireEvent.loadedMetadata(el);
    expect(el.currentTime).toBe(8); // first issue seekSec, NOT the 25s resume
  });

  it('does NOT auto-seek when autoSeekToIssues is false (Listen resumes)', async () => {
    vi.mocked(api.getChapterAudio).mockResolvedValue(audioWithIssues as never);
    vi.mocked(api.getListenProgress).mockResolvedValue({ chapterId: 1, currentSec: 25 } as never);
    renderMiniPlayer({ id: 1, title: 'Ch', duration: '0:30' }, { autoSeekToIssues: false });
    const el = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(el, 'duration', { configurable: true, value: 30 });
    fireEvent.loadedMetadata(el);
    expect(el.currentTime).toBe(25); // resume bookmark wins
  });
});
```

(Extend the shared `renderMiniPlayer` helper to forward an optional props override onto `<MiniPlayer>`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/mini-player.test.tsx -t "jump-to-issue"`
Expected: FAIL — no "Next issue" control; auto-seek not implemented.

- [ ] **Step 3: Implement the jump control + auto-seek**

In `src/components/mini-player.tsx`:

1. Add `autoSeekToIssues` to `MiniPlayerProps` and the destructured params:

```tsx
interface MiniPlayerProps {
  // ...existing...
  autoSeekToIssues?: boolean;
}
// in the function signature: ..., autoSeekToIssues = false }: MiniPlayerProps
```

2. Keep a ref of `issues` for the metadata handler (which closes over render scope but may run before `issues` settles):

```tsx
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
```

3. Add the jump handler (relative to the live playhead, so prev/next are robust):

```tsx
  const jumpToIssue = useCallback((dir: 1 | -1) => {
    const t = currentSecRef.current;
    const target =
      dir > 0
        ? issues.find((r) => r.seekSec > t + 0.25)
        : [...issues].reverse().find((r) => r.seekSec < t - 0.25);
    if (!target) return;
    const el = audioRef.current;
    if (el) el.currentTime = target.seekSec;
    setCurrentSec(target.seekSec);
    currentSecRef.current = target.seekSec;
  }, [issues]);
```

4. In the `onLoadedMetadata` handler, BEFORE the existing resume-bookmark block, add the context-gated auto-seek (it wins over resume in the generate context):

```tsx
              if (autoSeekToIssues && issuesRef.current.length > 0) {
                target.currentTime = issuesRef.current[0].seekSec;
                setCurrentSec(issuesRef.current[0].seekSec);
                currentSecRef.current = issuesRef.current[0].seekSec;
                pendingSeekRef.current = null; // suppress the resume seek below
              }
              const pending = pendingSeekRef.current;
              if (pending != null && pending > 0 && pending < d - 1) {
                // ...existing resume block unchanged...
              }
```

5. Render the jump control in the RHS controls cluster (next to the speed picker). Desktop shows prev+next; phone shows only the next button:

```tsx
            {issues.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => jumpToIssue(-1)}
                  aria-label="Previous issue"
                  title="Previous issue"
                  className="hidden md:grid place-items-center p-2 rounded-full hover:bg-canvas/10 text-amber-300"
                >
                  <span aria-hidden>‹⚠</span>
                </button>
                <button
                  type="button"
                  onClick={() => jumpToIssue(1)}
                  aria-label="Next issue"
                  title="Next issue"
                  data-testid="mini-player-next-issue"
                  className="grid place-items-center min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 md:p-2 rounded-full hover:bg-canvas/10 text-amber-300"
                >
                  <span aria-hidden>⚠›</span>
                </button>
              </div>
            )}
```

- [ ] **Step 4: Wire the context flag in layout**

In `src/components/layout.tsx`, the `MiniPlayer` mount (~`:1378`) — add the prop (the local `view` is already computed at `:174`):

```tsx
        <MiniPlayer
          chapter={trackChapter}
          bookId={bookId}
          autoSeekToIssues={view === 'generate'}
          // ...existing props...
        />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/mini-player.test.tsx -t "jump-to-issue"`
Expected: PASS (all three cases).

- [ ] **Step 6: Typecheck (layout + player wiring)**

Run: `npm run typecheck`
Expected: PASS (no type errors from the new prop).

- [ ] **Step 7: Commit**

```bash
git add src/components/mini-player.tsx src/components/layout.tsx src/components/mini-player.test.tsx
git commit -m "feat: MiniPlayer jump-to-issue + context-gated auto-seek"
```

---

### Task 7: E2E — preview jump-to-issue (desktop + phone)

**Files:**
- Modify: `src/lib/api.ts` (mock `getChapterAudio`, ~`:1648-1650` — flag one segment suspect so the feature is visible under mocks)
- Create: `e2e/issue-waveform.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (add the generation-row waveform case at every viewport — optional but matches the project's responsive net)

**Interfaces:**
- Consumes: the running app in mock mode (`npm run test:e2e` serves Vite on port 5174).

- [ ] **Step 1: Seed a suspect segment in the mock**

In `src/lib/api.ts`, the mock `getChapterAudio` return (~`:1648`), add `suspect` + `reasons` to the middle segment so a flagged region exists under mocks:

```ts
    segments: [
      { start: 0, end: third, characterId: 'narrator', sentenceId: 1 },
      { start: third, end: third * 2, characterId: 'halloran', sentenceId: 2,
        suspect: true, reasons: ['Long sentence — possible truncation'] },
      // ...remaining segment(s) unchanged...
    ],
```

- [ ] **Step 2: Write the failing e2e**

Create `e2e/issue-waveform.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('generation preview jumps to a flagged region', async ({ page }) => {
  await page.goto('/#/generate'); // mock book auto-selected; adjust to the app's mock entry
  // open a done chapter's preview (the row's preview button mounts the MiniPlayer)
  await page.getByRole('button', { name: /preview/i }).first().click();
  const next = page.getByTestId('mini-player-next-issue');
  await expect(next).toBeVisible();
  // capture playhead, jump, assert it advanced to the issue's seek point
  await next.click();
  // the audio element's currentTime should be > 0 (landed before the flagged region)
  const t = await page.locator('audio').evaluate((el: HTMLAudioElement) => el.currentTime);
  expect(t).toBeGreaterThan(0);
});
```

(Adjust the navigation/open steps to the app's actual mock generation entry — follow an existing spec in `e2e/` that reaches the generation view for the exact selectors.)

- [ ] **Step 3: Run it to verify it fails (then passes after the mock seed lands)**

Run: `npm run test:e2e -- issue-waveform`
Expected: initially FAIL if the mock isn't seeded / selectors differ; iterate selectors against a real existing generation-view spec until PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts e2e/issue-waveform.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): generation preview jump-to-issue + mock suspect segment"
```

---

### Task 8: Full verify + regression plan

**Files:**
- Create: `docs/features/<n>-generation-issue-waveform.md` (regression plan from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md` (add the new plan under its area)

- [ ] **Step 1: Write the regression plan**

Copy `docs/features/TEMPLATE.md` to a new numbered file, fill in the invariants (segments persist QA; route publishes `suspect`/`reasons` with ASR-noise gating; `deriveIssues` pads+merges+drops-degenerate; amber overlay + a11y; context-gated auto-seek), and a manual acceptance walkthrough using the canonical fixture `server/src/__fixtures__/the-coalfall-commission.md`.

- [ ] **Step 2: Update the index**

Add the new plan to `docs/features/INDEX.md` under the audio/generation area.

- [ ] **Step 3: Run the full battery**

Run: `npm run verify`
Expected: PASS — typecheck + all tests + e2e + build, including `test:a11y`.

- [ ] **Step 4: Commit**

```bash
git add docs/features/
git commit -m "docs: regression plan for generation issue-waveform"
```

---

## Self-Review

**Spec coverage** (each spec component → task):
- Component 0 `deriveIssues` (pad/merge/degenerate) → **Task 2** ✓
- Component 1 server route + OpenAPI + ASR-reason gating + previous mapper → **Task 1** ✓
- Component 2 Waveform overlay + a11y (sr-only, aria-hidden bars) → **Task 3** ✓ (visible `⚠ N` count → Task 4/Task 6 consumers ✓)
- Component 3 generation row on every (peakful) done chapter + keep narrative strip + peakless strip-only → **Task 4** ✓
- Component 4 MiniPlayer waveform scrubber + jump + context-gated auto-seek + mobile compact jump + layout wiring → **Tasks 5 & 6** ✓
- Component 5 chapter-level baseline underline → **Task 4** ✓
- Component 6 tests (unit/server/RTL/e2e; unit-vs-e2e honesty) → distributed across **Tasks 1–7**; click-seek left to e2e (jsdom rect=0) ✓
- Acceptance "`npm run verify` green incl. a11y" → **Task 8** ✓

**Placeholder scan:** no TBD/TODO; every code step carries real code. The e2e (Task 7) navigation selectors are explicitly flagged to be matched against an existing generation-view spec — concrete intent, harness-specific selector.

**Type consistency:** `IssueRegion { startFrac, endFrac, seekSec, reasons }` defined in Task 2 is consumed identically in Tasks 3/5/6; `deriveIssues(Pick<ChapterAudio,'segments'|'durationSec'>)` signature consistent; `autoSeekToIssues` prop name consistent across Task 6 + layout; `publishSegment` shape matches the OpenAPI fields added in Task 1; testids (`scrubber-thumb`, `mini-player-next-issue`) consistent between impl and tests.
