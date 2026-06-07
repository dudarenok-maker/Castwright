# Single voice design — background-survivable with live progress

> Design spec · 2026-06-07 · brand: Castwright
> Status: approved (brainstorm) — implementation plan to follow via `docs/features/NNN-*.md`

## Problem

Designing a bespoke Qwen voice for one character (Profile Drawer → "Design &
preview" / "Design & compare") takes ~15 seconds, surfaced today as a **bare
spinner with a static "Designing voice…" label**. Two compounding failures:

- **Pain A — opaque wait.** No sense of progress or whether it will finish.
  Users conclude it's stuck and leave.
- **Pain B — work lost on close.** The designed voiceId lives only in the
  drawer's local React state until **Save**. Closing the drawer (backdrop click
  or ✕) — or navigating away — discards that link. The server *did* design and
  cache the voice, but nothing ties it to the character; reopening shows "No
  voice designed yet."

These chain: the opaque wait *causes* the abandonment, and the abandonment
*triggers* the loss. As the user put it: *"the spinner is what makes people
leave thinking it won't finish — then if it does, they never know."*

## Goals

1. The ~15s wait **feels alive and honest** — motion + a soft ETA + truthful
   phase labels — without a literal countdown.
2. Closing the drawer (or reloading) **never loses the design.** Work keeps
   running in the background, the result finds its way home, and a global cue
   announces it.
3. **Reuse**, not reinvent: lean on the existing bulk "Design full cast"
   machinery (server detached-job pattern, `castDesign` slice, Design status
   pill, stream middleware) rather than building a parallel mechanism.

## Non-goals

- Touching the **bulk** "Design full cast" flow's behavior (only generalizing
  shared client state it already owns).
- A distinct **"Warming the voice designer…"** sub-phase — that needs the
  sidecar to stream a model-load signal; it's a follow-up (see below).
- Changing how gender/age/persona **edits** are committed — Save still owns
  those. This feature only auto-persists the designed voiceId + the persona
  used to design it.
- Cross-tab broadcast of the single-design pill (same rationale as the bulk
  slice: a single owning tab).

## Locked UX — the in-drawer progress treatment

A branded, honest progress block replacing the bare spinner during design:

- **Living waveform** — the Castwright ragged-waveform mark, animated, conveys
  "a voice is being shaped." Primary signal of life.
- **Soft-fill ETA bar** — eases toward a typical ~15s, **holds near ~90%**, and
  snaps to complete only on the real completion event. Never a ticking number;
  a slow design simply holds rather than lying.
- **Honest cycling phase label**, driven by **real server SSE events** (not a
  client timer): **"Designing the voice…" → "Rendering the 12s audition…"**.
  Two phases are free server-side (the sidecar design call vs. the
  audition cache-encode step). If a phase runs long, the label shows the *true*
  current phase.
- **"Keeps running if you close" micro-note** — teaches that leaving is safe.

## Architecture

### Decision summary (approved)

- **D1 — Full:** upgrade the single-design route to **detached + SSE-streamed +
  reattachable**, mirroring the bulk job's "keeps running with zero subscribers,
  re-subscribe on reload" pattern. This is the only way to stream honest phases,
  and reload-resilience comes nearly for free from the existing pattern.
- **D2 — Reuse `castDesign`:** generalize the existing slice + Design status
  pill to also represent a single-character design, rather than a parallel
  slice.
- **D3 — Ready-to-compare:** a backgrounded **re-design never auto-applies** —
  it holds the `-preview` voice and announces "ready to compare."
- **D4 — Symmetric mutual exclusion:** a single design **marks itself busy** so
  a bulk job 409s while it runs (today only the reverse holds). Both continue to
  serialize on `withDesignLock(bookDir)`.

### Server

Upgrade the single route in `server/src/routes/qwen-voice.ts`:

- `POST …/cast/:characterId/design-voice` becomes an **SSE start** that registers
  a detached single-design job (one per book, in an in-memory registry keyed by
  bookId — the one-design-per-book invariant) and runs `withDesignLock`. Body
  unchanged: `{ persona, sampleVoiceId, modelKey, preview, emotion? }` — the
  **live drawer persona** still arrives in the body (the job must NOT re-read
  the on-disk persona, which may be stale relative to the open drawer).
- It **emits sub-phase events** around the existing core
  (`designQwenVoiceForCharacter`): `phase: 'designing'` before the sidecar call,
  `phase: 'rendering'` before the audition encode, then a terminal event.
- **Terminal behavior:**
  - **First design** (`preview` false): **persist the override in-process** via
    `applyOverrideToCastFiles` (series-scoped for a series book, workspace for a
    standalone) — exactly what the bulk loop does — then emit
    `designed { characterId, voiceId, previewUrl }`. Auto-attach.
  - **Re-design** (`preview` true): stage the `-preview` sibling (unchanged) and
    emit `preview_ready { characterId, previewVoiceId, previewUrl, persona }`.
    **No persist.** Promotion/discard stays with the existing
    `promote-voice` / `discard-voice` routes (the A/B approve/cancel).
- **Detach + reattach** (mirrors `cast-design.ts`): the job keeps running when
  its SSE subscriber disconnects; add a **status probe** (`GET …` — is a single
  design live for this book? returns `{ characterId, mode, phase }`) and a
  **bare-body subscribe** to re-attach after reload, replaying a `resume_from`.
- **Symmetric busy:** call `markDesignBusy(bookDir)` at start /
  `clearDesignBusy` at end (reusing the shared `designBusy` set), and add an
  `isDesignBusy` guard to the **bulk** start path so bulk 409s during a single.
  (Single already guards on `isDesignBusy`.)

### Client

- **`src/store/cast-design-slice.ts`** — generalize `CastDesignSnapshot`:
  - `kind: 'bulk' | 'single'`, and for single: `characterId`, `mode: 'first' |
    'redesign'`, `phase: 'designing' | 'rendering'`.
  - new terminal state **`'ready-to-compare'`** carrying
    `preview: { characterId, previewVoiceId, previewUrl, persona }`.
  - For a single design: `total: 1`, `currentName: <character name>`.
- **Stream middleware** (`cast-design-stream-middleware.ts`, or a sibling that
  shares the slice) — own the single-design SSE:
  - new request action `designSingleRequested({ bookId, characterId, persona,
    sampleVoiceId, modelKey, mode })` + a `resubscribeSingle` cold-boot path.
  - phase events → slice `phase`; `designed` → `setQwenOverrideName` (row flips
    live) + a `"<name>'s voice is ready"` toast; `preview_ready` →
    `'ready-to-compare'` state + a `"<name>'s new voice is ready to compare"`
    toast that deep-links the drawer open with the compare staged.
- **Layout cold-boot probe** (`layout.tsx`) — also probe single-design status
  for the open book and dispatch `resubscribeSingle` when one is live.
- **Top-bar Design pill** — already reads `castDesign`; with the generalization
  it renders single designs too (subtitle e.g. *"Designing Aria · rendering
  audition"*).
- **Profile Drawer** (`profile-drawer.tsx` + `voice-engine-picker.tsx`) — drive
  the design UI from the slice **for this character** rather than purely-local
  `designBusy`:
  - render the waveform + soft-fill + phase label from the slice while a design
    for this character is in flight (so reopening mid-design shows live state,
    not a fresh button).
  - on `'ready-to-compare'` for this character, open `VoiceCompareModal` staged
    with the preview (the same modal the synchronous path opens today).
  - dispatch `designSingleRequested` instead of awaiting `api.designQwenVoice`.

## Completion behavior

| | Drawer open | Drawer closed / navigated away |
|---|---|---|
| **First design** | stage + play audition (as today) **and auto-persist** | auto-persist, row flips live, toast *"Aria's voice is ready"* |
| **Re-design** | open A/B compare (as today) | hold preview, toast *"Aria's new voice is ready to compare"* → deep-link reopens drawer with compare staged |

## Edge cases & risks (adversarial review)

- **Persona staleness.** The job uses the persona **passed in the start
  request** (live drawer text), never the on-disk value — otherwise an unsaved
  persona edit would be ignored. First-design also persists that persona so a
  later re-design reads a consistent value.
- **Second design while one runs.** One design per book; a second start (single
  or bulk) **409s** and the buttons are disabled + explained, exactly like the
  bulk button today.
- **Abandoned re-design preview.** A `-preview` voice that's never
  approved/discarded is cleaned up on the **next design of that character**
  (and/or a TTL sweep) — never clobbers the live voice.
- **Soft-fill vs. reality.** The fill is elapsed-driven but **capped ~90%** and
  only completes on the real terminal event, so a slow design holds rather than
  showing "done" early; the phase label always reflects the true phase.
- **Server restart mid-design.** Loses only the live pill (re-click finishes) —
  same contract as the bulk job. A first-design persists only on completion; a
  re-design preview is transient.
- **Gender/age edits.** Auto-persist writes only voiceId + persona; other
  identity edits still require Save (unchanged, called out so it isn't a
  surprise).

## Test coverage (paired with implementation)

- `cast-design-slice.test.ts` — single-kind snapshot, phase transitions,
  `ready-to-compare` terminal + preview payload, cross-book/character guards.
- `cast-design-stream-middleware.test.ts` — `designSingleRequested` +
  `resubscribeSingle`; phase→slice; `designed`→`setQwenOverrideName`+toast;
  `preview_ready`→ready-to-compare+toast; re-entrancy / one-per-book.
- `server/src/routes/qwen-voice.test.ts` — SSE phases, first-design persist
  (series scope) vs. re-design preview (no persist), live-persona honored,
  detach/reattach + status probe, symmetric `isDesignBusy` 409s.
- `top-bar.test.tsx` — Design pill renders a single design + phase subtitle.
- `profile-drawer.test.tsx` — drawer renders slice-driven progress for its
  character; reopen-mid-design shows waveform; `ready-to-compare` opens compare.
- `e2e/` — design single → close drawer → pill ticks → toast → reopen shows
  designed + playable; re-design → close → ready-to-compare deep-link → compare.

## Follow-ups (not in v1)

- **"Warming the voice designer…" sub-phase** — needs the sidecar to stream a
  model-load signal for the VoiceDesign 1.7B cold load.
- **Preview TTL sweep** — background cleanup of orphaned `-preview` artifacts.
- Fold the single + bulk middleware into one module if the sibling split proves
  redundant.
