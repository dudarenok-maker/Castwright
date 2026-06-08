---
status: stable
shipped: 2026-06-07
owner: null
---

# Single voice design — background-survivable with live progress

> Status: active
> Key files: `server/src/routes/single-design.ts`, `src/store/cast-design-slice.ts`, `src/store/cast-design-stream-middleware.ts`, `src/components/design-progress.tsx`, `src/modals/profile-drawer.tsx`, `src/components/voice-engine-picker.tsx`, `src/components/top-bar.tsx`, `src/components/layout.tsx`
> URL surface: indirect — the Profile Drawer (`#/books/<id>/{cast,confirm}`) hosts the design UI; the global Design pill in the top bar shows the in-flight single design alongside bulk runs
> OpenAPI ops: `POST /api/books/{bookId}/cast/{characterId}/design-voice/stream`, `POST /api/books/{bookId}/cast/design-single/subscribe`, `GET /api/books/{bookId}/cast/design-single/status`

## Benefit / Rationale

- **User:** The ~15 s voice-design wait now feels alive (animated waveform + honest phase labels driven by real server events) and closing the Profile Drawer — or navigating away, or reloading — never loses the work. A toast announces completion; reopening the drawer shows the designed voice immediately.
- **Technical:** Single-character design is promoted from a synchronous blocking request to a detached, SSE-streamed, reattachable background job that survives arbitrary network interruptions. First designs auto-persist the override in-process; re-designs stage a `-preview` and hold the `ready-to-compare` terminal state until the A/B compare resolves.
- **Architectural:** The `castDesign` slice, Design status pill, and stream middleware are generalized to represent both bulk (`kind: 'bulk'`) and single (`kind: 'single'`) design jobs under one unified shape. The shared `designBusy` registry enforces symmetric mutual exclusion: a single design 409s a bulk start, and vice versa, through the same `isDesignBusy` / `markDesignBusy` / `clearDesignBusy` primitives in `server/src/tts/design-lock.ts`.

## Architectural impact

### New seams / extension points

- `server/src/routes/single-design.ts` — new SSE router with three endpoints:
  - `POST …/:bookId/cast/:characterId/design-voice/stream` — starts a detached per-character design job (one per book, in-memory `inFlightByBook` registry, mirrors `cast-design.ts` structure). Body: `{ persona, sampleVoiceId, modelKey, preview }`. Marks the `designBusy` registry; survives subscriber disconnect; emits `phase → designed / preview_ready`.
  - `POST …/:bookId/cast/design-single/subscribe` — re-attach after a reload; replays a `resume_from` event carrying `{ characterId, name, mode, phase }` so the client slice can open a snapshot at the right state.
  - `GET …/:bookId/cast/design-single/status` — cold-boot probe (`{ active, characterId, name, mode, phase }`); called by `layout.tsx` on mount to trigger `resubscribeSingle`.
- `src/store/cast-design-slice.ts` — `CastDesignSnapshot` gains `kind: 'bulk' | 'single'`, `characterId`, `mode: 'first' | 'redesign'`, `phase: 'designing' | 'rendering'`, and a new terminal `state: 'ready-to-compare'` with an attached `CastDesignPreview` payload. New reducers: `beginSingle`, `setPhase`, `previewReady`. New request actions: `designSingleRequested`, `resubscribeSingle`.
- `src/store/cast-design-stream-middleware.ts` — owns the single-design SSE (start, cold-boot resubscribe) alongside the existing bulk path. `runStream` accepts an optional callbacks-builder 4th argument so single and bulk can share the SSE loop plumbing while providing different event handlers.
- `src/components/design-progress.tsx` — branded in-drawer progress block: animated ragged-waveform mark (`data-testid="design-waveform"`), soft-fill ETA bar (`data-testid="design-fill"`) that eases toward ~92% and snaps to 100% on completion, and honest phase label driven by real SSE events.
- `src/lib/api.ts` — `CastDesignCallbacks` extended with `onPhase`, `onPreviewReady`, `onResumeSingle`; `readCastDesignStream` handles the new event types; `startSingleDesign`, `subscribeSingleDesign`, `getSingleDesignStatus` added to both the real and mock API objects.

### Invariants preserved

- `CastDesignSnapshot.kind = 'bulk'` is set in the existing `begin` reducer, so all bulk paths remain on their existing code path — the generalization is purely additive.
- The shared `designBusy` registry (`design-lock.ts`) serializes all single + bulk designs on the same `withDesignLock(bookDir)` GPU semaphore path, preserving the one-design-per-book invariant.
- The existing synchronous `POST …/design-voice` route (emotion-variant design) is kept unchanged — only the base-voice drawer path moves to the new SSE stream.
- Redux-persist rehydration of the `castDesign` slice is unchanged (the new fields are optional).

### Migration story

- No `state.json` / `cast.json` schema changes. The new SSE endpoint is purely in-memory; the detached job data does not survive a server restart (same contract as the bulk job).
- Cold-boot resubscribe: on page load, `layout.tsx` probes `getSingleDesignStatus` (alongside the existing `getCastDesignStatus` probe) and dispatches `resubscribeSingle` if an in-flight design exists. This is best-effort: a server restart drops the job.

### Reversibility

Revert by removing `singleDesignRouter` from `server/src/index.ts` and restoring the Profile Drawer to dispatch `api.designQwenVoice` directly. The `castDesign` slice changes are backward-compatible (bulk paths unaffected); reverting the slice means dropping the `beginSingle`/`setPhase`/`previewReady` reducers and the `kind`/`characterId`/`mode`/`phase`/`ready-to-compare` fields.

## Invariants to preserve

- The `kind: 'single'` branch of the slice must never mutate a `kind: 'bulk'` snapshot, and vice versa. The `setPhase` and `previewReady` reducers both guard on `snap.kind === 'single'`. The `bulk` reducers (`characterDesigned`, `allDesigned`, etc.) are untouched.
- `onIdle` for a `kind: 'single'` first design clears the slice after `SUMMARY_LINGER_MS`; for a `ready-to-compare` redesign, the clear is skipped until the A/B compare resolves (the drawer calls `dispatch(castDesignActions.clear())` on approve/cancel).
- The `castDesign` slice must not reference `Date.now()` directly — callers pass `lastTickAt` per the existing convention.

## Test plan

### Automated coverage

- Vitest frontend (`src/store/cast-design-slice.test.ts`) — `beginSingle` opens a `kind:single` snapshot at phase `designing`; `setPhase` advances phase and guards against wrong-character; `previewReady` flips to `ready-to-compare` with preview payload; cross-book/character guards.
- Vitest frontend (`src/store/cast-design-stream-middleware.test.ts`) — `designSingleRequested` → phases mirrored into slice, designed event → `setQwenOverrideName` + toast, `preview_ready` → `previewReady` + toast; re-entrancy guard (one design per book); `resubscribeSingle` cold-boot path.
- Vitest server (`server/src/routes/single-design.test.ts`) — first-design SSE phases + `applyOverrideToCastFiles` called; preview path emits `preview_ready` without persisting; subscribe to no-job → `idle`; `isDesignBusy` 409 guard; status endpoint returns `active: false` when idle.
- Vitest server (`server/src/routes/cast-design.test.ts`) — bulk start 409s when a single design is busy via `isDesignBusy`.
- Vitest frontend (`src/components/design-progress.test.tsx`) — renders phase labels; `design-waveform` and `design-fill` test-IDs present.
- Vitest frontend (`src/modals/profile-drawer.test.tsx`) — renders `DesignProgress` when slice has a running single design for this character; opens compare modal when slice is `ready-to-compare`.
- Vitest frontend (`src/components/top-bar.test.tsx`) — `DesignPill` renders the phase subtitle for a single design.
- Playwright e2e (`e2e/single-voice-design-background.spec.ts`) — opens a character's drawer, switches to Qwen, clicks "Design & preview", closes the drawer (Escape), asserts toast `"is ready"` fires, reopens drawer and asserts `[data-testid="qwen-designed-confirm"]` is visible.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev` or `npm run test:e2e`).

1. **Cold boot at `#/`** → library cards. Start a new book, upload text, save, start analysis, wait for confirm view.
2. **Open a character's Profile Drawer** → click any character card. Evidence section appears.
3. **Switch engine to Qwen** → select `qwen` from the engine picker. The persona textarea auto-fills. The "Design & preview" button becomes enabled.
4. **Click "Design & preview"** → in-drawer progress block appears with animated waveform + "Designing the voice…" label + "Keeps running if you close" note. Pill in the top bar shows "Designing <name>".
5. **Close the drawer** (Escape or ✕) while the design is in flight → the drawer disappears; the Design pill persists in the top bar showing phase progress.
6. **Toast appears**: `"<name> is ready."` within ~15 s (mock: ~200 ms). The pill clears.
7. **Reopen the same character's drawer** → "Voice designed — saving will pin it across this series." confirmation is visible. The engine remains Qwen.
8. **Re-design** (click "Design & compare") → same flow, but the terminal event opens the A/B compare modal (`voice-compare-overlay`). Approve or Cancel — the `ready-to-compare` state clears; pill disappears.
9. **Reload mid-design** (real sidecar only) → the cold-boot probe fires `resubscribeSingle`; the pill re-attaches and shows the correct phase; completion fires the toast as before.
10. **Bulk "Design full cast" while a single design is in progress** → 409 error toast; bulk button disabled. Symmetric: a single design while bulk runs also 409s.

## Out of scope

- A distinct **"Warming the voice designer…"** sub-phase — needs the sidecar to stream a model-load signal for the VoiceDesign 1.7B cold load (follow-up).
- **Preview TTL sweep** — background cleanup of orphaned `-preview` artifacts (follow-up).
- Cross-tab broadcast of the single-design pill (same rationale as the bulk slice: a single owning tab). The `castDesign` slice is excluded from `broadcast-middleware.ts`.
- Changing how gender/age/persona **edits** are committed — Save still owns those. This feature only auto-persists the designed voiceId + the persona used to design it.

## Ship notes

Shipped **2026-06-07** via PR [#639](https://github.com/dudarenok-maker/AudioBook-Generator/issues/639) (commit `0906207`). Single-character Qwen voice design became a detached, SSE-streamed, reattachable background job reusing the bulk `castDesign` slice/middleware/pill (`kind: 'bulk' | 'single'`); branded in-drawer `DesignProgress` (ragged-waveform mark + soft-fill ETA + honest `designing`/`rendering` phases); first designs auto-persist + toast, re-designs hold a `-preview` and enter `ready-to-compare`; symmetric single↔bulk 409 via the shared `designBusy` registry; cold-boot resubscribe. Behaviour delta vs. spec: descoped first-design auto-play (user clicks Play). Live-GPU acceptance owed.

Shipped: {{date}}
SHA: {{sha}}

## Follow-ups

1. **"Warming the voice designer…" sub-phase** — a fourth honest phase before `designing` that signals the VoiceDesign 1.7B model loading. Needs the sidecar to emit a `warming` event on the `/design_voice` stream (currently the sidecar loads the model silently before the first token). Unlocks a more truthful first-impression of the design wait.
2. **Preview TTL sweep** — background cleanup for `-preview` voice artifacts whose owning redesign was abandoned without approve/cancel. Could fire on the next design of that character, or a workspace-level idle watchdog. Prevents orphaned sidecar prompt-cache entries accumulating.
3. **Optional first-design auto-play** — while the drawer is open and a first design completes, auto-play the 12s audition so the user hears it immediately without clicking "Play 12s sample." Descoped from v1 (the user may have closed the drawer; auto-audio without intent is surprising on mobile).
