# fs-63 — Auto-voice a Created Off-Roster Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an off-roster `reattribute` mints new cast member(s) on a Qwen project, surface a sticky "Design now" nudge that enqueues bespoke Qwen voice design for exactly those characters.

**Architecture:** A dedicated, busy-aware nudge component (`VoiceNudgeToast`) is discriminated by an optional `nudge` field on the existing `Toast` model (NOT a new `kind`). It reuses the existing `castDesignActions.designAllRequested` bulk-design pipeline (server SSE job + `DesignPill`), scoped to the created character ids. The push happens from `script-review-diff.tsx` after the apply helper resolves, gated to the `qwen` effective engine.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (Immer reducers), Vitest + React Testing Library, Playwright (e2e).

## Global Constraints

- **Design tokens are CSS custom properties** — no hex literals in component code; use existing classes (`text-ink`, `bg-canvas`, `text-ink/70`, etc.).
- **RTK immer** — slice reducers mutate Immer drafts; never rewrite to spreads.
- **Touch targets** ≥ 44×44 px on phone: action button uses `min-h-[44px] sm:min-h-0`.
- **Spec:** `docs/superpowers/specs/2026-06-25-fs63-auto-voice-off-roster-character-design.md` is the source of truth.
- **Qwen-only:** the nudge fires only when `engineForModelKey(ttsModelKey) === 'qwen'`. Preset engines push nothing.
- **No new server route.** Reuses `POST /cast/create` and the existing cast-design SSE job.
- Commit message convention: `<type>(<scope>): <subject>`. Scope here is `frontend`.

---

### Task 1: `apply-proposed.ts` returns the created characters

**Files:**
- Modify: `src/lib/apply-proposed.ts`
- Test: `src/lib/apply-proposed.test.ts`

**Interfaces:**
- Consumes: existing `ApplyProposedDeps` (unchanged), whose `createCharacter` resolves to `{ id: string; name: string }`.
- Produces: `applyProposedReattributions(...)` now returns
  `{ created: number; createdCharacters: { id: string; name: string }[]; aborted: boolean }`.
  `createdCharacters` lists `{id, name}` for every character minted this batch (in creation order; partial on abort; empty when all ops dedupe to existing roster members).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/apply-proposed.test.ts`:

```ts
it('returns createdCharacters with {id,name} for each minted member', async () => {
  let n = 0;
  const result = await applyProposedReattributions(
    [
      { chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Mara' } } as never,
      { chapterId: 1, id: 11, op: 'reattribute', proposed: { name: 'Mara' } } as never, // dup name
      { chapterId: 2, id: 12, op: 'reattribute', proposed: { name: 'Tom' } } as never,
    ],
    {
      rosterByName: new Map(),
      createCharacter: async (p) => ({ id: `id-${++n}`, name: p.name }),
      addCharacter: () => {},
      setSentenceCharacter: () => {},
      onBoundaryMove: () => {},
      isSameBook: () => true,
    },
  );
  expect(result.created).toBe(2);
  expect(result.createdCharacters).toEqual([
    { id: 'id-1', name: 'Mara' },
    { id: 'id-2', name: 'Tom' },
  ]);
  expect(result.aborted).toBe(false);
});

it('returns empty createdCharacters when every op dedupes to an existing roster member', async () => {
  const result = await applyProposedReattributions(
    [{ chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Hart' } } as never],
    {
      rosterByName: new Map([['hart', { id: 'hart-1' }]]),
      createCharacter: async () => { throw new Error('should not create'); },
      addCharacter: () => {},
      setSentenceCharacter: () => {},
      onBoundaryMove: () => {},
      isSameBook: () => true,
    },
  );
  expect(result.createdCharacters).toEqual([]);
});

it('carries partial createdCharacters when the batch aborts on a book switch', async () => {
  let n = 0;
  const result = await applyProposedReattributions(
    [
      { chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Mara' } } as never,
      { chapterId: 2, id: 12, op: 'reattribute', proposed: { name: 'Tom' } } as never,
    ],
    {
      rosterByName: new Map(),
      createCharacter: async (p) => ({ id: `id-${++n}`, name: p.name }),
      addCharacter: () => {},
      setSentenceCharacter: () => {},
      onBoundaryMove: () => {},
      isSameBook: () => n < 1, // true before the first create's post-await check, false after
    },
  );
  expect(result.aborted).toBe(true);
  expect(result.createdCharacters).toEqual([{ id: 'id-1', name: 'Mara' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/apply-proposed.test.ts`
Expected: FAIL — `result.createdCharacters` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/apply-proposed.ts`, change the return type and collect created characters:

```ts
export async function applyProposedReattributions(
  proposed: ReviewOpWithChapter[],
  deps: ApplyProposedDeps,
): Promise<{ created: number; createdCharacters: { id: string; name: string }[]; aborted: boolean }> {
  const memo = new Map<string, string>(); // normName -> id created this batch
  const createdCharacters: { id: string; name: string }[] = [];
  let created = 0;
  for (const op of proposed) {
    if (!op.proposed) continue;
    const key = norm(op.proposed.name);
    let id = deps.rosterByName.get(key)?.id ?? memo.get(key);
    if (!id) {
      const c = await deps.createCharacter(op.proposed);
      if (!deps.isSameBook()) return { created, createdCharacters, aborted: true };
      deps.addCharacter(c);
      id = c.id;
      memo.set(key, id);
      createdCharacters.push({ id: c.id, name: c.name });
      created += 1;
    }
    deps.setSentenceCharacter(op.chapterId, op.id, id);
    deps.onBoundaryMove(op.chapterId);
  }
  return { created, createdCharacters, aborted: false };
}
```

> Note: the `createdCharacters.push` lands AFTER the `isSameBook()` guard returns on abort, so an aborted batch keeps only the characters created before the abort — matching the partial-abort test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/apply-proposed.test.ts`
Expected: PASS (all three new cases + existing cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/apply-proposed.ts src/lib/apply-proposed.test.ts
git commit -m "feat(frontend): apply-proposed returns createdCharacters {id,name}"
```

---

### Task 2: `notifications-slice` — `nudge` field + merge-dedupe

**Files:**
- Modify: `src/store/notifications-slice.ts`
- Test: `src/store/notifications-slice.test.ts` (create if absent)

**Interfaces:**
- Produces:
  ```ts
  export interface VoiceNudge {
    bookId: string;
    characterIds: string[];
    modelKey: string;
    names: string[];
  }
  ```
  `Toast` gains `nudge?: VoiceNudge`. `pushToast`'s payload gains `nudge?: VoiceNudge`.
  When a push carries a `dedupeKey` matching an existing toast AND both carry a `nudge`, the
  existing nudge's `characterIds`/`names` are **unioned** (dedupe by id, preserve order) rather
  than overwritten.

- [ ] **Step 1: Write the failing test**

Create/extend `src/store/notifications-slice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { notificationsSlice, notificationsActions, type VoiceNudge } from './notifications-slice';

const reduce = (actions: ReturnType<typeof notificationsActions.pushToast>[]) =>
  actions.reduce((s, a) => notificationsSlice.reducer(s, a), notificationsSlice.reducer(undefined, { type: '@@INIT' }));

const nudge = (over: Partial<VoiceNudge>): VoiceNudge => ({
  bookId: 'b1', modelKey: 'qwen3-tts-0.6b', characterIds: ['mara'], names: ['Mara'], ...over,
});

describe('notifications nudge merge-dedupe', () => {
  it('unions characterIds/names into an existing same-key nudge instead of overwriting', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: '1 needs a voice', dedupeKey: 'k', nudge: nudge({}) }),
      notificationsActions.pushToast({
        kind: 'info', message: '1 needs a voice', dedupeKey: 'k',
        nudge: nudge({ characterIds: ['tom'], names: ['Tom'] }),
      }),
    ]);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara', 'tom']);
    expect(s.toasts[0].nudge?.names).toEqual(['Mara', 'Tom']);
  });

  it('does not duplicate an id already present in the existing nudge', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: 'x', dedupeKey: 'k', nudge: nudge({}) }),
      notificationsActions.pushToast({ kind: 'info', message: 'x', dedupeKey: 'k', nudge: nudge({}) }),
    ]);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara']);
  });

  it('carries nudge on a fresh (non-dedupe) push', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: 'x', nudge: nudge({}) }),
    ]);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/store/notifications-slice.test.ts`
Expected: FAIL — `VoiceNudge` not exported / `nudge` not stored / not merged.

- [ ] **Step 3: Write minimal implementation**

In `src/store/notifications-slice.ts`:

```ts
export interface VoiceNudge {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  names: string[];
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  dedupeKey?: string;
  createdAt: number;
  /** fs-63 — present only on the off-roster "Design now" nudge; routes the
      toast to <VoiceNudgeToast> and exempts it from auto-dismiss. */
  nudge?: VoiceNudge;
}
```

Add `nudge?: VoiceNudge` to `PushToastPayload`, thread it through `prepare`, and merge in the reducer:

```ts
pushToast: {
  reducer: (s, a: PayloadAction<{ id: string; createdAt: number } & PushToastPayload>) => {
    const { id, kind, message, dedupeKey, createdAt, nudge } = a.payload;
    if (dedupeKey) {
      const existing = s.toasts.find((t) => t.dedupeKey === dedupeKey);
      if (existing) {
        existing.createdAt = createdAt;
        existing.kind = kind;
        existing.message = message;
        // fs-63 — union nudge work-lists so a burst of off-roster creates
        // yields ONE nudge covering every still-unvoiced character.
        if (nudge && existing.nudge) {
          for (let i = 0; i < nudge.characterIds.length; i++) {
            const cid = nudge.characterIds[i];
            if (!existing.nudge.characterIds.includes(cid)) {
              existing.nudge.characterIds.push(cid);
              existing.nudge.names.push(nudge.names[i]);
            }
          }
        } else if (nudge) {
          existing.nudge = nudge;
        }
        return;
      }
    }
    s.toasts.push({ id, kind, message, dedupeKey, createdAt, nudge });
  },
  prepare: (payload: PushToastPayload) => ({
    payload: {
      ...payload,
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2),
      createdAt: Date.now(),
    },
  }),
},
```

And extend `PushToastPayload`:

```ts
interface PushToastPayload {
  kind: ToastKind;
  message: string;
  dedupeKey?: string;
  nudge?: VoiceNudge;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/store/notifications-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/notifications-slice.ts src/store/notifications-slice.test.ts
git commit -m "feat(frontend): notifications Toast.nudge field + merge-dedupe"
```

---

### Task 3: `VoiceNudgeToast` — dedicated busy-aware component

**Files:**
- Create: `src/components/voice-nudge-toast.tsx`
- Test: `src/components/voice-nudge-toast.test.tsx`

**Interfaces:**
- Consumes: `Toast` (with `nudge: VoiceNudge`) from Task 2; `castDesignActions.designAllRequested`
  (`src/store/cast-design-slice.ts`); `notificationsActions.dismissToast`; `useAppSelector`/`useAppDispatch`.
- Reads `s.castDesign.active?.state` to decide busy.
- Produces: `export function VoiceNudgeToast({ toast }: { toast: Toast })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/voice-nudge-toast.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { VoiceNudgeToast } from './voice-nudge-toast';
import { notificationsSlice, type Toast } from '../store/notifications-slice';
import { castDesignSlice } from '../store/cast-design-slice';

const makeStore = (designRunning: boolean) =>
  configureStore({
    reducer: { notifications: notificationsSlice.reducer, castDesign: castDesignSlice.reducer },
    preloadedState: {
      notifications: { toasts: [] },
      castDesign: { active: designRunning ? ({ state: 'running', bookId: 'b1' } as never) : null },
    },
  });

const toast: Toast = {
  id: 't1', kind: 'info', message: 'New character «Mara» needs a voice', createdAt: 0,
  dedupeKey: 'off-roster-voice-nudge:b1',
  nudge: { bookId: 'b1', characterIds: ['mara'], modelKey: 'qwen3-tts-0.6b', names: ['Mara'] },
};

describe('VoiceNudgeToast', () => {
  it('idle: tapping the button dispatches designAllRequested and dismisses the toast', () => {
    const store = makeStore(false);
    const spy: { type: string; payload: unknown }[] = [];
    store.subscribe(() => {});
    const origDispatch = store.dispatch;
    (store as { dispatch: typeof origDispatch }).dispatch = ((a: never) => {
      spy.push(a);
      return origDispatch(a);
    }) as never;
    // seed the toast so dismiss has something to remove
    origDispatch(notificationsSlice.actions.pushToast({ kind: 'info', message: 'x' }));

    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));

    const design = spy.find((a) => a.type === 'castDesign/designAllRequested');
    expect(design).toBeTruthy();
    expect((design!.payload as { characterIds: string[] }).characterIds).toEqual(['mara']);
    expect((design!.payload as { scope: string }).scope).toBe('bases');
    expect((design!.payload as { modelKey: string }).modelKey).toBe('qwen3-tts-0.6b');
    expect(spy.some((a) => a.type === 'notifications/dismissToast')).toBe(true);
  });

  it('busy: button is disabled and the nudge is NOT dismissed', () => {
    const store = makeStore(true);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    const btn = screen.getByRole('button', { name: /design now/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/a voice design is already running/i)).toBeTruthy();
  });

  it('plural copy when several characters need voices', () => {
    const store = makeStore(false);
    const plural: Toast = {
      ...toast,
      nudge: { ...toast.nudge!, characterIds: ['mara', 'tom'], names: ['Mara', 'Tom'] },
    };
    render(<Provider store={store}><VoiceNudgeToast toast={plural} /></Provider>);
    expect(screen.getByText(/2 new characters need voices/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /design all/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/voice-nudge-toast.test.tsx`
Expected: FAIL — module `./voice-nudge-toast` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/voice-nudge-toast.tsx`:

```tsx
/* fs-63 — off-roster "Design now" nudge. A sticky toast (no auto-dismiss)
   rendered by ToastStack when a Toast carries a `nudge`. It mirrors the Cast
   view's busy semantics: while a cast-design run is active (any book) the
   action is disabled, so a tap can never silently no-op against the
   single-stream middleware. Tapping enqueues bespoke Qwen design for exactly
   the created characters via the existing designAllRequested pipeline. */

import { useAppDispatch, useAppSelector } from '../store';
import { IconWarning, IconClose } from '../lib/icons';
import { notificationsActions, type Toast } from '../store/notifications-slice';
import { castDesignActions } from '../store/cast-design-slice';

export function VoiceNudgeToast({ toast }: { toast: Toast }) {
  const dispatch = useAppDispatch();
  const designRunning = useAppSelector((s) => s.castDesign.active?.state === 'running');
  const nudge = toast.nudge!;
  const count = nudge.characterIds.length;
  const label = count > 1 ? 'Design all' : 'Design now';
  const message =
    count > 1
      ? `${count} new characters need voices`
      : `New character «${nudge.names[0]}» needs a voice`;

  const onDesign = () => {
    dispatch(
      castDesignActions.designAllRequested({
        bookId: nudge.bookId,
        characterIds: nudge.characterIds,
        modelKey: nudge.modelKey,
        scope: 'bases',
      }),
    );
    dispatch(notificationsActions.dismissToast(toast.id));
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-ink/10 bg-white px-4 py-3 shadow-card min-w-[280px] max-w-[360px] fade-in text-ink">
      <div className="flex items-start gap-3">
        <IconWarning className="w-4 h-4 mt-0.5 shrink-0" />
        <p className="flex-1 text-sm leading-snug">{message}</p>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dispatch(notificationsActions.dismissToast(toast.id))}
          className="p-1 rounded-full hover:bg-ink/10 shrink-0"
        >
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 pl-7">
        <button
          type="button"
          disabled={designRunning}
          onClick={onDesign}
          className="px-3 min-h-[44px] sm:min-h-0 sm:py-1.5 rounded-full bg-ink text-canvas text-sm font-semibold disabled:opacity-40"
        >
          {label}
        </button>
        {designRunning && (
          <span className="text-xs text-ink/55">A voice design is already running…</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/voice-nudge-toast.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voice-nudge-toast.tsx src/components/voice-nudge-toast.test.tsx
git commit -m "feat(frontend): VoiceNudgeToast busy-aware off-roster design nudge"
```

---

### Task 4: `ToastStack` routes `nudge` toasts (sticky, no auto-dismiss)

**Files:**
- Modify: `src/components/toast-stack.tsx`
- Test: `src/components/toast-stack.test.tsx`

**Interfaces:**
- Consumes: `VoiceNudgeToast` (Task 3), `Toast.nudge` (Task 2).
- Behaviour: a toast with `nudge` renders `<VoiceNudgeToast>` (which has no auto-dismiss timer → sticky); a plain toast renders the existing `<ToastItem>` (still auto-dismisses at 6 s).

- [ ] **Step 1: Write the failing test**

Add to `src/components/toast-stack.test.tsx` (adapt to the file's existing store/render helpers):

```tsx
it('renders a nudge toast via VoiceNudgeToast and does not auto-dismiss it', () => {
  vi.useFakeTimers();
  const store = makeStoreWithToast({
    id: 'n1', kind: 'info', message: 'New character «Mara» needs a voice', createdAt: Date.now(),
    nudge: { bookId: 'b1', characterIds: ['mara'], modelKey: 'qwen3-tts-0.6b', names: ['Mara'] },
  });
  render(<Provider store={store}><ToastStack /></Provider>);
  expect(screen.getByRole('button', { name: /design now/i })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(7000); });
  // still present after the 6s window — nudge toasts are sticky
  expect(screen.getByRole('button', { name: /design now/i })).toBeTruthy();
  vi.useRealTimers();
});
```

> If `toast-stack.test.tsx` has no `makeStoreWithToast` helper, build a store with
> `notifications` + `castDesign` reducers and a preloaded `toasts: [theToast]`, mirroring the
> Task 3 test's `makeStore`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/toast-stack.test.tsx`
Expected: FAIL — no "Design now" button (nudge not routed).

- [ ] **Step 3: Write minimal implementation**

In `src/components/toast-stack.tsx`, import the component and branch in the map:

```tsx
import { VoiceNudgeToast } from './voice-nudge-toast';
```

```tsx
{toasts.map((t) =>
  t.nudge ? <VoiceNudgeToast key={t.id} toast={t} /> : <ToastItem key={t.id} toast={t} />,
)}
```

(No change to `ToastItem`; its 6 s auto-dismiss is untouched, so plain toasts behave exactly as before. Nudge toasts never mount `ToastItem`, so they have no dismiss timer → sticky.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/toast-stack.test.tsx`
Expected: PASS (new case + existing cases green).

- [ ] **Step 5: Commit**

```bash
git add src/components/toast-stack.tsx src/components/toast-stack.test.tsx
git commit -m "feat(frontend): ToastStack routes nudge toasts to VoiceNudgeToast"
```

---

### Task 5: `script-review-diff.tsx` pushes the nudge after apply

**Files:**
- Modify: `src/components/script-review-diff.tsx`
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `applyProposedReattributions` (now returns `createdCharacters`, Task 1);
  `engineForModelKey` (`src/lib/tts-models.ts`); `sampleModelKeyForEngine`
  (`src/lib/tts-voice-mapping.ts`); `notificationsActions.pushToast` with `nudge` (Task 2);
  `s.ui.ttsModelKey`.
- Behaviour: after `runProposed`, when `createdCharacters` is non-empty AND
  `engineForModelKey(ttsModelKey) === 'qwen'`, dispatch `pushToast` with the nudge payload +
  `dedupeKey: \`off-roster-voice-nudge:${startBookId}\``.

- [ ] **Step 1: Write the failing test**

Add to `src/components/script-review-diff.test.tsx` two cases (adapt to the file's existing
render harness + mock of `api.createCharacter`). The key assertions:

```tsx
it('pushes a Design-now nudge after an off-roster create on a Qwen project', async () => {
  // store seeded with ui.ttsModelKey = 'qwen3-tts-0.6b', an active off-roster review bucket,
  // and api.createCharacter mocked to resolve { character: { id: 'mara', name: 'Mara' } }.
  // …drive the confirm flow to completion (create "Mara")…
  await waitFor(() => {
    const t = store.getState().notifications.toasts.find((x) => x.nudge);
    expect(t).toBeTruthy();
    expect(t!.nudge!.characterIds).toEqual(['mara']);
    expect(t!.nudge!.modelKey).toBe('qwen3-tts-0.6b');
    expect(t!.dedupeKey).toMatch(/^off-roster-voice-nudge:/);
  });
});

it('pushes NO nudge on a preset-engine (kokoro) project', async () => {
  // same flow but ui.ttsModelKey = 'kokoro-v1'
  await waitFor(() => { /* flow done */ });
  expect(store.getState().notifications.toasts.some((x) => x.nudge)).toBe(false);
});
```

> If driving the full confirm UI is heavy in this suite, factor the push into a tiny exported
> helper `maybePushVoiceNudge(dispatch, { ttsModelKey, startBookId, createdCharacters })` in
> `script-review-diff.tsx` and unit-test THAT directly (engine gate + payload), keeping the
> component test to a single happy-path render. Either satisfies the gate.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/script-review-diff.test.tsx`
Expected: FAIL — no nudge toast pushed.

- [ ] **Step 3: Write minimal implementation**

Add imports to `src/components/script-review-diff.tsx`:

```tsx
import { notificationsActions } from '../store/notifications-slice';
import { engineForModelKey } from '../lib/tts-models';
import { sampleModelKeyForEngine } from '../lib/tts-voice-mapping';
```

Read the model key at component scope (near the other `useAppSelector`s, ~line 143):

```tsx
const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
```

In `runProposed`, capture the result and push the nudge:

```tsx
const { createdCharacters } = await applyProposedReattributions(finalized, {
  /* …existing deps unchanged… */
});
if (createdCharacters.length > 0 && engineForModelKey(ttsModelKey) === 'qwen') {
  dispatch(
    notificationsActions.pushToast({
      kind: 'info',
      message:
        createdCharacters.length > 1
          ? `${createdCharacters.length} new characters need voices`
          : `New character «${createdCharacters[0].name}» needs a voice`,
      dedupeKey: `off-roster-voice-nudge:${startBookId}`,
      nudge: {
        bookId: startBookId,
        characterIds: createdCharacters.map((c) => c.id),
        modelKey: sampleModelKeyForEngine('qwen', ttsModelKey),
        names: createdCharacters.map((c) => c.name),
      },
    }),
  );
}
setConfirm(null);
dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
```

> The `message` here seeds the dedupe-display text; `VoiceNudgeToast` recomputes its own copy
> from `nudge`, so the two stay consistent. `startBookId` (not the live `bookId`) keeps the
> nudge bound to the book the characters were created in.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/script-review-diff.test.tsx`
Expected: PASS (Qwen pushes nudge; kokoro pushes none).

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): push off-roster voice nudge after apply (qwen-only)"
```

---

### Task 6: e2e — nudge appears and activates the design pill

**Files:**
- Modify: `e2e/script-review.spec.ts`

**Interfaces:**
- Consumes: the mock-mode script-review flow already exercised by this spec.

- [ ] **Step 1: Write the failing test**

Add a spec that drives an off-roster reattribute on a Qwen mock book, confirms the create, then
asserts the nudge appears and tapping it activates the `DesignPill`:

```ts
test('off-roster reattribute on a Qwen book surfaces a Design-now nudge that activates the design pill', async ({ page }) => {
  // …open a Qwen mock book, open script review, pick an off-roster reattribute op,
  //   confirm CreateCharacterForm with a new name…
  await expect(page.getByRole('button', { name: /design now/i })).toBeVisible();
  await page.getByRole('button', { name: /design now/i }).click();
  // The DesignPill seeds synchronously via castDesign begin.
  await expect(page.getByTestId('design-pill')).toBeVisible();
});
```

> Reuse the spec's existing helpers for entering script review and the off-roster confirm path.
> Confirm the real `data-testid` of the design pill from `src/components/layout.tsx` (search
> `design-pill` / the `DesignPill` render) and match it; adjust the selector if it differs.

- [ ] **Step 2: Run test to verify it fails (or is RED before wiring)**

Run: `npm run test:e2e -- script-review`
Expected: FAIL until Tasks 1–5 are merged into the running build.

- [ ] **Step 3: Implement** — no new app code; this task validates Tasks 1–5 end-to-end. If the
selector or flow needs a `data-testid`, add the minimal one to the relevant component.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- script-review`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/script-review.spec.ts
git commit -m "test(frontend): e2e off-roster voice nudge → design pill"
```

---

### Task 7: Docs, issue, and backlog cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-06-25-fs63-auto-voice-off-roster-character-design.md` (frontmatter `status: draft` → `stable` + Ship notes)
- Modify: `docs/BACKLOG.md` (remove the fs-63 row)
- Modify: `docs/features/INDEX.md` (only if a regression plan doc is added — this feature is small/localized, so the spec + paired tests are the record; note that explicitly in the PR)
- External: GitHub issue #1119 (soften benefit line), PR body (`Closes #1119`)

- [ ] **Step 1:** Flip the spec frontmatter to `status: stable`; add a **Ship notes** line with the merge date + commit SHA (filled at merge time).
- [ ] **Step 2:** Remove the fs-63 row from `docs/BACKLOG.md`.
- [ ] **Step 3:** Edit issue #1119's benefit line from *"audible in one pass"* to *"audible in one tap"* (the consent-gate consequence): `gh issue edit 1119 --body-file -`.
- [ ] **Step 4:** Commit:

```bash
git add docs/superpowers/specs/2026-06-25-fs63-auto-voice-off-roster-character-design.md docs/BACKLOG.md
git commit -m "docs(docs): ship fs-63 — backlog row + spec status + ship notes"
```

> Final delivery gate (outside the task commits): `npm run verify` green, then open the PR with a
> conventional title and a mini-release-notes body containing `Closes #1119`.

---

## Self-Review

**Spec coverage:**
- §3.1 created-characters return → Task 1. ✓
- §3.2 `Toast.nudge` field + merge-dedupe → Task 2. ✓
- §3.2 dedicated busy-aware `VoiceNudgeToast` (disabled while running, sticky) → Task 3. ✓
- §3.2 `ToastStack` routing on the `nudge` field (no new `kind`) → Task 4. ✓
- §3.3 push gated to qwen, dedupeKey, abort-inclusive → Task 5. ✓
- §4 edge cases (busy, already-designed, book-switch, mixed batch) → covered across Tasks 1/3/5 tests. ✓
- §5 testing (unit slice, unit component, unit script-review, e2e) → Tasks 2/3/5/6. ✓
- §6/§7 docs + benefit-line softening + backlog → Task 7. ✓

**Placeholder scan:** all code steps carry full code; the e2e/script-review tests note "adapt to existing harness" but give exact assertions — acceptable since the harness specifics are discoverable and the behavioural contract is concrete.

**Type consistency:** `VoiceNudge` (`bookId`, `characterIds`, `modelKey`, `names`) is defined in Task 2 and consumed unchanged in Tasks 3 & 5. `createdCharacters: {id,name}[]` defined in Task 1, consumed in Task 5. `designAllRequested({ bookId, characterIds, modelKey, scope })` matches `DesignAllRequestedPayload` in `cast-design-slice.ts`. Busy predicate `castDesign.active?.state === 'running'` consistent across Task 3 impl + test.
