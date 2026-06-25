# fs-56 — Manual per-line instruct editing UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author hand-write / refine the per-line free-text `instruct` (TTS delivery direction) on any manuscript line, reaching the "manual" rung of the resolver that fs-57 left unreachable.

**Architecture:** Mirror the shipped fs-25 emotion control. A new `setSentenceInstruct` reducer is the manual write site; `applyDetectedInstruct`'s existing fill-only guard makes "manual wins" automatic. A new `SentenceInstructControl` (inline chip → popover textarea) renders on every line in `manuscript.tsx`, dispatches the reducer, and conservatively marks the chapter stale-if-rendered (gated on the per-book `liveInstruct` boolean threaded down once). The engine path (synth, resolver, Stage-3 generation) already shipped via fs-57 — no server changes.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (Immer) + Vitest/RTL + Playwright. Frontend-only.

## Global Constraints

- **Design spec (authority):** `docs/superpowers/specs/2026-06-25-fs56-manual-instruct-editing-design.md`. Every task implicitly inherits its decisions.
- **Branch / base:** `feat/frontend-fs-56-instruct-editing`, worktree `C:\Claude\Projects\Audiobook-Generator-wt-fs56`. **PREREQUISITE (do ONCE before any task):** `#1100` is already merged to `origin/main` (commit `ce88c662`, "drop stale instruct/vocalization on split fragments + merge survivors"). Rebase this branch onto `origin/main` first — `git fetch origin && git rebase origin/main` — so the whole plan (incl. Task 4's split/merge guard) runs on a base that already carries the null-ing. Verify: `git merge-base --is-ancestor ce88c662 HEAD && echo OK`.
- **Design tokens only** — no hex literals; use `--ink`, `--peach`, etc. via Tailwind classes (CLAUDE.md convention).
- **Touch targets** — every control `min-h-[44px] sm:min-h-0` (WCAG 2.5.5); mobile-responsive per the mobile-testing protocol.
- **Single field, no provenance** — analyzer + manual instruct share `sentence.instruct`. No new schema field, no migration.
- **Change-log silent** — instruct edits do NOT dispatch `changeLogActions` (match the emotion precedent).
- **Audibility/staleness gate on `liveInstruct` ONLY** — never reconstruct the per-character `is17b` model key client-side (it isn't reliably visible; doing so is a silent-data-loss trap).
- **No `--no-verify`.** Each commit runs the scoped pre-commit gate; the final task runs full `npm run verify`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/store/manuscript-slice.ts` | + `setSentenceInstruct` reducer (manual write site) |
| `src/store/persistence-middleware.ts` | + `manuscript/setSentenceInstruct` persist entry |
| `src/components/sentence-instruct-control.tsx` | NEW — the chip + popover textarea control |
| `src/views/manuscript.tsx` | thread `liveInstruct` boolean; render control ungated |
| `src/store/manuscript-slice.test.ts` | reducer + fill-only + split/merge guard tests |
| `src/components/sentence-instruct-control.test.tsx` | NEW — component behaviour tests |
| `e2e/manuscript-instruct-edit.spec.ts` | NEW — cross-seam golden path |
| `docs/features/232-fs56-manual-instruct-editing.md` | NEW — regression plan |
| `docs/features/INDEX.md` | + entry for plan 232 |

---

## Task 1: `setSentenceInstruct` reducer + persistence + fill-only guard

**Files:**
- Modify: `src/store/manuscript-slice.ts` (add reducer next to `setSentenceEmotion`, ~line 300)
- Modify: `src/store/persistence-middleware.ts` (add entry next to `manuscript/setSentenceEmotion`, ~line 94)
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Produces: `manuscriptActions.setSentenceInstruct({ chapterId: number; sentenceId: number; instruct: string })` — trims; `''`/whitespace deletes `sentence.instruct`; non-empty sets it. No-op on unknown id.

- [ ] **Step 1: Write the failing reducer test** (after the `setSentenceEmotion` test, ~line 239)

```ts
it('fs-56 — setSentenceInstruct sets / trims / clears, scoped by (chapter, id)', () => {
  const start = baseState(
    sentences([
      { id: 1, text: 'a', characterId: 'narrator' },
      { id: 2, text: 'b', characterId: 'wren' },
    ]),
  );
  const set = manuscriptSlice.reducer(
    start,
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 2, instruct: '  a sharp whisper  ' }),
  );
  expect(set.sentences[1].instruct).toBe('a sharp whisper'); // trimmed
  expect(set.sentences[0].instruct).toBeUndefined(); // scoped — line 1 untouched
  // empty / whitespace clears the field back to undefined.
  const cleared = manuscriptSlice.reducer(
    set,
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 2, instruct: '   ' }),
  );
  expect(cleared.sentences[1].instruct).toBeUndefined();
  // unknown id is a no-op (no throw).
  const noop = manuscriptSlice.reducer(
    set,
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 99, instruct: 'x' }),
  );
  expect(noop.sentences[1].instruct).toBe('a sharp whisper');
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd C:\Claude\Projects\Audiobook-Generator-wt-fs56 && npm test -- manuscript-slice --run`
Expected: FAIL — `setSentenceInstruct is not a function`.

- [ ] **Step 3: Add the reducer** in `manuscript-slice.ts`, immediately after `setSentenceEmotion` (the comment + code block ending at the `setSentenceEmotion` closing brace ~line 300):

```ts
/* fs-56 — User edit: set (or clear) a sentence's free-text delivery `instruct`.
   The MANUAL write site for the resolver's top "manual" rung. Scoped by
   (chapterId, sentenceId) like setSentenceEmotion. A blank/whitespace value
   deletes the field (so the store never carries an empty instruct, and a
   re-detect may refill it). A hand-set instruct wins over analyzer instruct
   because applyDetectedInstruct is fill-only. */
setSentenceInstruct: (
  s,
  a: PayloadAction<{ chapterId: number; sentenceId: number; instruct: string }>,
) => {
  const sent = s.sentences.find(
    (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
  );
  if (!sent) return;
  const trimmed = a.payload.instruct.trim();
  if (trimmed === '') delete sent.instruct;
  else sent.instruct = trimmed;
},
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- manuscript-slice --run`
Expected: the new test PASSES.

- [ ] **Step 5: Write the failing fill-only protection test** (in the `applyDetectedInstruct` describe block, mirroring the fs-33 fill-only tests):

```ts
it('fs-56 — a hand-set instruct is NOT overwritten by applyDetectedInstruct (manual wins)', () => {
  const manual = manuscriptSlice.reducer(
    baseState(sentences([{ id: 1, chapterId: 1, text: 'a', characterId: 'wren' }])),
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 1, instruct: 'breathless' }),
  );
  const afterDetect = manuscriptSlice.reducer(
    manual,
    manuscriptActions.applyDetectedInstruct({
      chapterId: 1,
      annotations: [{ sentenceId: 1, instruct: 'shouting' }],
    }),
  );
  expect(afterDetect.sentences[0].instruct).toBe('breathless'); // manual preserved
});
```

- [ ] **Step 6: Run it — expect PASS** (fill-only already exists in `applyDetectedInstruct`; this locks the contract)

Run: `npm test -- manuscript-slice --run`
Expected: PASS. If it FAILS, the fill-only guard regressed — stop and fix `applyDetectedInstruct`.

- [ ] **Step 7: Add the persistence entry** in `persistence-middleware.ts`, after the `manuscript/setSentenceEmotion` block (~line 94):

```ts
/* fs-56 — a hand-set per-line instruct persists like the emotion tag, so the
   manual delivery direction survives reload and reaches synth via
   manuscript-edits.json. */
'manuscript/setSentenceInstruct': {
  slice: 'manuscript',
  build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
},
```

- [ ] **Step 8: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/persistence-middleware.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): setSentenceInstruct reducer + persistence (fs-56)"
```

---

## Task 2: `SentenceInstructControl` component

**Files:**
- Create: `src/components/sentence-instruct-control.tsx`
- Test: `src/components/sentence-instruct-control.test.tsx`

**Interfaces:**
- Consumes: `manuscriptActions.setSentenceInstruct` (Task 1); `useMarkCharacterStaleIfRendered()` → `(c:{id,name})=>void` (`src/lib/stale-chapters.ts`).
- Produces: `<SentenceInstructControl chapterId={number} sentenceId={number} instruct={string|undefined} character={Character|undefined} liveInstruct={boolean} />`.

Mirror `src/components/sentence-emotion-control.tsx` for the open/outside-click/`contentEditable={false}` scaffold. Key differences: a `<textarea>` (free text) instead of a fixed menu; pre-fill `instruct ?? ''`; on Save dispatch + conditional stale; muted style + caption when `!liveInstruct`.

- [ ] **Step 1: Write the failing component test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { manuscriptSlice } from '../store/manuscript-slice';
import { SentenceInstructControl } from './sentence-instruct-control';
import type { Character } from '../lib/types';

vi.mock('../lib/stale-chapters', () => ({ useMarkCharacterStaleIfRendered: () => vi.fn() }));

function renderControl(props: Partial<React.ComponentProps<typeof SentenceInstructControl>> = {}) {
  const store = configureStore({ reducer: { manuscript: manuscriptSlice.reducer } });
  const spy = vi.spyOn(store, 'dispatch');
  render(
    <Provider store={store}>
      <SentenceInstructControl
        chapterId={1}
        sentenceId={2}
        instruct={undefined}
        character={{ id: 'wren', name: 'Wren', ttsEngine: 'qwen' } as unknown as Character}
        liveInstruct={true}
        {...props}
      />
    </Provider>,
  );
  return { store, spy };
}

describe('fs-56 SentenceInstructControl', () => {
  it('empty chip has the set-instruct aria-label', () => {
    renderControl();
    expect(screen.getByLabelText('Set delivery direction for this line')).toBeInTheDocument();
  });

  it('a set chip exposes the edit aria-label (accessible name on both states)', () => {
    renderControl({ instruct: 'whisper softly' });
    expect(screen.getByLabelText('Delivery direction: whisper softly — edit')).toBeInTheDocument();
  });

  it('opens pre-filled, focuses the textarea, and Save dispatches the trimmed value', () => {
    const { spy } = renderControl({ instruct: 'whisper softly' });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('whisper softly');      // pre-filled with the current/LLM instruct
    expect(document.activeElement).toBe(ta);       // focus-on-open (a11y)
    fireEvent.change(ta, { target: { value: '  shout it  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manuscript/setSentenceInstruct', payload: expect.objectContaining({ instruct: '  shout it  ' }) }),
    );
  });

  it('Clear dispatches an empty string (reducer deletes the field)', () => {
    const { spy } = renderControl({ instruct: 'x' });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manuscript/setSentenceInstruct', payload: expect.objectContaining({ instruct: '' }) }),
    );
  });

  it('shows the inaudible caption (naming the 1.7B tier) when liveInstruct is off', () => {
    renderControl({ instruct: 'x', liveInstruct: false });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    expect(screen.getByText(/Qwen 1\.7B tier with Live expressive delivery on/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- sentence-instruct-control --run`
Expected: FAIL — module `./sentence-instruct-control` not found.

- [ ] **Step 3: Create the component**

```tsx
/* fs-56 — per-line free-text delivery-direction ("instruct") control.

   Mirrors SentenceEmotionControl: an inline chip rendered OUTSIDE the sentence
   text span (so it never perturbs the selection→split offset math), opening a
   small popover. Unlike emotion (a fixed menu), instruct is free text, so the
   popover hosts a <textarea> pre-filled with the line's current instruct —
   authored OR Stage-3-proposed (one field; the control is the single edit
   surface). A hand-set value wins because applyDetectedInstruct is fill-only.

   Audibility/staleness gate on the per-book `liveInstruct` flag ONLY (the
   reliably-known half; the per-character 1.7B model key is a server detail we
   can't see). liveInstruct off ⇒ definitely silent ⇒ muted + caption; on ⇒
   may be audible ⇒ render normally + conservatively mark stale-if-rendered. */

import { useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { useMarkCharacterStaleIfRendered } from '../lib/stale-chapters';
import type { Character } from '../lib/types';

const PREVIEW_MAX = 24;

export function SentenceInstructControl({
  chapterId,
  sentenceId,
  instruct,
  character,
  liveInstruct,
}: {
  chapterId: number;
  sentenceId: number;
  instruct?: string;
  character?: Character;
  liveInstruct: boolean;
}) {
  const dispatch = useAppDispatch();
  const markStale = useMarkCharacterStaleIfRendered();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(instruct ?? '');
  const ref = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync the draft whenever the popover opens (instruct may have changed via
  // a Detect-emotions run since last open).
  useEffect(() => {
    if (open) {
      setDraft(instruct ?? '');
      taRef.current?.focus();
    }
  }, [open, instruct]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const commit = (value: string) => {
    dispatch(manuscriptActions.setSentenceInstruct({ chapterId, sentenceId, instruct: value }));
    // Conservative staleness: only when the book intends expressive delivery.
    // Never reconstruct the per-character 1.7B key here (spec — silent-loss trap).
    if (liveInstruct && character) markStale({ id: character.id, name: character.name });
    setOpen(false);
    chipRef.current?.focus();
  };

  const current = instruct?.trim() ? instruct.trim() : undefined;
  const preview = current
    ? current.length > PREVIEW_MAX
      ? current.slice(0, PREVIEW_MAX) + '…'
      : current
    : undefined;
  const inaudible = !liveInstruct;

  return (
    <span ref={ref} className="relative inline-block align-baseline select-none" contentEditable={false}>
      <button
        ref={chipRef}
        type="button"
        data-testid="instruct-chip"
        aria-label={current ? `Delivery direction: ${current} — edit` : 'Set delivery direction for this line'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          current
            ? `mx-0.5 inline-flex items-center min-h-[20px] px-1.5 rounded-full text-[10px] font-medium ${inaudible ? 'opacity-50 text-ink/40 bg-ink/5' : 'text-purple-deep/70 bg-purple-deep/5'}`
            : 'mx-0.5 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-4 sm:h-4 rounded-full text-ink/30 opacity-0 group-hover:opacity-100 focus:opacity-100 coarse-pointer:opacity-40 align-middle transition-opacity'
        }
      >
        {preview ?? <span className="text-xs leading-none" aria-hidden>🎬</span>}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Edit delivery direction"
          className="absolute z-50 left-0 top-full mt-1 max-w-[90vw] w-64 rounded-lg border border-ink/10 bg-white picker-surface shadow-lg p-2 flex flex-col gap-2"
        >
          <textarea
            ref={taRef}
            aria-label="Enter delivery direction"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                chipRef.current?.focus();
              }
            }}
            rows={3}
            placeholder="e.g. a sharp, startled whisper"
            className="w-full max-h-32 resize-none rounded border border-ink/15 px-2 py-1 text-xs text-ink"
          />
          {inaudible && (
            <span className="text-[10px] text-ink/50">
              Delivery directions play on the Qwen 1.7B tier with Live expressive delivery on.
            </span>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => commit('')} className="px-2 py-1 text-xs text-ink/60 hover:text-magenta min-h-[44px] sm:min-h-0">
              Clear
            </button>
            <button type="button" onClick={() => commit(draft)} className="px-2 py-1 text-xs font-semibold text-ink hover:text-magenta min-h-[44px] sm:min-h-0">
              Save
            </button>
          </div>
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- sentence-instruct-control --run`
Expected: all four tests PASS. (If the `🎬`/`group-hover` empty chip isn't found by `getByLabelText`, confirm the `aria-label` string matches the test exactly.)

- [ ] **Step 5: Commit**

```bash
git add src/components/sentence-instruct-control.tsx src/components/sentence-instruct-control.test.tsx
git commit -m "feat(frontend): SentenceInstructControl chip + popover (fs-56)"
```

---

## Task 3: Placement + `liveInstruct` threading in `manuscript.tsx`

**Files:**
- Modify: `src/views/manuscript.tsx`

**Interfaces:**
- Consumes: `SentenceInstructControl` (Task 2); `selectLiveInstruct(bookId)` (`book-meta-slice.ts:167`) → boolean; `bookId` already at `manuscript.tsx:120`.
- Produces: the control rendered for every sentence, receiving a `liveInstruct` boolean computed ONCE and threaded through `SegmentRow`.

- [ ] **Step 1: Import + compute `liveInstruct` once** at the `Manuscript` top level (near the `bookId` read, ~line 120):

```ts
import { SentenceInstructControl } from '../components/sentence-instruct-control';
import { selectLiveInstruct } from '../store/book-meta-slice';
// …inside Manuscript(), after bookId is read:
const liveInstruct = useAppSelector(selectLiveInstruct(bookId));
```

- [ ] **Step 2: Thread `liveInstruct` to `SegmentRow`** — add `liveInstruct: boolean` to the `SegmentRowProps` interface, pass it at **both** `<SegmentRow … />` call sites (`manuscript.tsx:901` and `:932`), and destructure it in the `SegmentRow({ … })` signature (alongside `findChar`). `SegmentRow` is a plain `function` (NOT `React.memo` — verified, so there is no comparator to update); do NOT call `selectLiveInstruct` inside the row (a per-sentence selector is the 500-call trap). `SentenceInstructControl` is likewise intentionally un-memoized, mirroring `SentenceEmotionControl`.

- [ ] **Step 3: Render the control** immediately after the `SentenceEmotionControl` block (~line 1489), UNGATED (every sentence, narrator included):

```tsx
{/* fs-56 — per-line delivery-direction control, ungated (narrator included). */}
<SentenceInstructControl
  chapterId={s.chapterId}
  sentenceId={s.id}
  instruct={s.instruct}
  character={char}
  liveInstruct={liveInstruct}
/>
```

- [ ] **Step 4: Typecheck + run the manuscript suite**

Run: `npm run typecheck && npm test -- manuscript --run`
Expected: PASS — no type errors (the new prop is wired through `SegmentRowProps`), existing manuscript tests stay green.

- [ ] **Step 5: Manual smoke (dev server)**

Run: `npm run dev`, open a book → manuscript view. Verify: a faint 🎬 reveals on row hover for narrator + dialogue lines; clicking opens the textarea; an LLM-instruct'd line pre-fills; Save persists (reload keeps it); with live-instruct off the chip is muted + the caption shows.

- [ ] **Step 6: Commit**

```bash
git add src/views/manuscript.tsx
git commit -m "feat(frontend): render per-line instruct control in manuscript view (fs-56)"
```

---

## Task 4: Split/merge guard tests (base already carries #1100)

**Files:**
- Modify: `src/store/manuscript-slice.test.ts`

> Base note: with the up-front rebase done (Global Constraints), `ce88c662` is in the base, so `splitSentence`/`mergeSentences` already null `instruct`/`vocalization`. These tests guard that seam from fs-56's side and fail loudly if the base ever regresses. Defensive check first: `git merge-base --is-ancestor ce88c662 HEAD || { echo "REBASE MISSING"; exit 1; }`.

**Interfaces:**
- Consumes: `setSentenceInstruct` (Task 1); `splitSentence` (payload `{ chapterId, sentenceId, offsets: number[], characterIds: string[] }`) and `mergeSentences` (existing).

- [ ] **Step 1: Write the SPLIT guard test**

```ts
it('fs-56 — a hand-set instruct does not bleed onto split fragments (#1100 base)', () => {
  const tagged = manuscriptSlice.reducer(
    baseState(sentences([{ id: 1, chapterId: 1, text: 'She paused. She ran.', characterId: 'narrator' }])),
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 1, instruct: 'breathless whisper' }),
  );
  // NOTE: payload is `offsets: number[]` (plural array), NOT `offset`.
  const split = manuscriptSlice.reducer(
    tagged,
    manuscriptActions.splitSentence({ chapterId: 1, sentenceId: 1, offsets: [11], characterIds: ['narrator', 'narrator'] }),
  );
  const fragments = split.sentences.filter((s) => s.chapterId === 1);
  expect(fragments.length).toBe(2); // if not 2, adjust offsets to land a clean 2-piece split
  expect(fragments[0].instruct).toBe('breathless whisper'); // head keeps it
  expect(fragments[1].instruct).toBeUndefined();            // tail must NOT inherit it
});
```

- [ ] **Step 2: Write the MERGE guard test** (the spec says split/merge, not split alone)

```ts
it('fs-56 — a merge does not carry a stale instruct onto the survivor (#1100 base)', () => {
  const tagged = manuscriptSlice.reducer(
    baseState(sentences([
      { id: 1, chapterId: 1, text: 'She paused.', characterId: 'narrator' },
      { id: 2, chapterId: 1, text: 'She ran.', characterId: 'narrator' },
    ])),
    manuscriptActions.setSentenceInstruct({ chapterId: 1, sentenceId: 1, instruct: 'breathless whisper' }),
  );
  const merged = manuscriptSlice.reducer(
    tagged,
    manuscriptActions.mergeSentences({ chapterId: 1, sentenceIds: [1, 2] }),
  );
  const survivor = merged.sentences.find((s) => s.chapterId === 1);
  expect(survivor?.text).toContain('She ran.'); // merged text
  expect(survivor?.instruct).toBeUndefined();   // #1100 drops the survivor's stale instruct
});
```

> Payload pinned (verified): `mergeSentences({ chapterId, sentenceIds: number[] })`; the **lowest id survives** (here id 1), higher ids are spliced + tombstoned. Per `ce88c662`, `mergeSentences` sets `live[0].instruct = undefined`, so the survivor drops the stale direction — the assertion holds on the rebased base.

- [ ] **Step 3: Run them — expect PASS** (base carries #1100)

Run: `npm test -- manuscript-slice --run`
Expected: PASS. If a split/merge test FAILS with the instruct still present, the rebase is missing — stop and rebase.

- [ ] **Step 4: Commit**

```bash
git add src/store/manuscript-slice.test.ts
git commit -m "test(frontend): guard manual instruct against split/merge bleed (fs-56)"
```

---

## Task 5: E2E golden path

**Files:**
- Create: `e2e/manuscript-instruct-edit.spec.ts`

**Interfaces:** Playwright (chromium) vs Vite mock mode. Mirror an existing manuscript spec (`e2e/manuscript-emotion-preview.spec.ts`) for navigation to the manuscript view.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test('fs-56 — author edits a per-line instruct; it shows + round-trips in-session', async ({ page }) => {
  // Nav preamble copied verbatim from manuscript-emotion-preview.spec.ts (proven).
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

  // The instruct chip renders on every line (ungated). The empty chip is
  // opacity-0/hover-reveal but is in the DOM and clickable (Playwright's
  // actionability check ignores opacity).
  const chip = page.getByTestId('instruct-chip').first();
  await chip.click();
  const ta = page.getByRole('textbox');
  await ta.fill('a slow, dramatic pause');
  await page.getByRole('button', { name: /save/i }).click();

  // Chip now shows the truncated preview (redux→view seam works).
  await expect(page.getByTestId('instruct-chip').first()).toContainText('a slow, dramatic');

  // Re-open: the saved value round-trips into the textarea (store→control).
  await page.getByTestId('instruct-chip').first().click();
  await expect(page.getByRole('textbox')).toHaveValue('a slow, dramatic pause');
});
```

> The nav preamble (`goToConfirm` + the Confirm button + the URL assertion) is copied verbatim from `e2e/manuscript-emotion-preview.spec.ts:13,37-39`. Reload-across-persistence is intentionally NOT asserted here — mock-mode reload state is unreliable; persistence is locked instead by the `manuscript/setSentenceInstruct` middleware entry being byte-identical to the proven `setSentenceEmotion` path (Task 1).

- [ ] **Step 2: Run it — expect PASS**

Run: `npm run test:e2e -- manuscript-instruct-edit`
Expected: PASS (chromium). If the chip isn't visible (hover-reveal), `click({ force: true })` or hover the row first — match the emotion-preview spec's approach.

- [ ] **Step 3: Commit**

```bash
git add e2e/manuscript-instruct-edit.spec.ts
git commit -m "test(e2e): manuscript per-line instruct edit golden path (fs-56)"
```

---

## Task 6: Regression plan + INDEX

**Files:**
- Create: `docs/features/232-fs56-manual-instruct-editing.md` (from `docs/features/TEMPLATE.md`, `status: stable` once shipped)
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the regression plan** — frontmatter `status: active`; sections: invariants (single field; manual wins via fill-only; change-log silent; audibility/staleness gate on `liveInstruct` only; control ungated incl. narrator), the manual acceptance walkthrough (matches the spec's Acceptance 1–8), and links to the spec + issue #996. Cite the canonical fixture only if an e2e run is described.

- [ ] **Step 2: Add the INDEX entry** under the relevant area (expressive TTS / manuscript), linking `232-fs56-manual-instruct-editing.md`.

- [ ] **Step 3: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. Fix any red leg before committing (triage related-vs-pre-existing per CLAUDE.md; never `--no-verify`).

- [ ] **Step 4: Commit + push + open the PR**

```bash
git add docs/features/232-fs56-manual-instruct-editing.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan 232 for fs-56 manual instruct editing"
git push -u origin feat/frontend-fs-56-instruct-editing
```
PR title: `feat(frontend): manual per-line instruct editing UI (fs-56)`. Body: `Closes #996`, link the spec + plan 232, enumerate the user-visible delta + the tests that lock it. Open as draft; add `run-ci` only for a clean-room check before merge.

---

## Self-Review (done at authoring)

- **Spec coverage:** Reducer (T1) ✓; persistence (T1) ✓; component incl. pre-fill/save/clear/a11y/audibility/staleness (T2) ✓; ungated placement + `liveInstruct` threading (T3) ✓; split/merge guard (T4) ✓; e2e (T5) ✓; regression plan (T6) ✓. Acceptance 1–8 all map to a test in T1/T2/T4/T5.
- **Placeholders:** none — real code in every implementation step; the two "copy the preamble" notes (T5) and the `splitSentence` payload check (T4) point at exact sibling files to read, not vague instructions.
- **Type consistency:** `setSentenceInstruct({chapterId, sentenceId, instruct})` identical across T1 reducer, T2 dispatch, T4 test; `SentenceInstructControl` prop shape identical across T2 and T3; `liveInstruct: boolean` consistent T3↔T2.
