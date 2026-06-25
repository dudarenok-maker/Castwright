---
status: draft
issue: 1119
backlog-id: fs-63
follow-up-of: fs-58 Unit B (#1040)
---

# fs-63 — Auto-voice a created off-roster character

## 1. Problem

fs-58 Unit B added an off-roster `reattribute` flow: when the LLM script review proposes
moving a line to a speaker not on the roster, the operator confirms a `CreateCharacterForm`,
which mints a brand-new cast member via `POST /cast/create` and reassigns the line to it.

The minted member lands `voiceState: 'generated'` with **no voice override**. What that means
for audibility depends entirely on the project's TTS engine — and the engine split is the
crux of this feature:

- **Preset engines (Kokoro / Coqui / Gemini):** `pickVoiceForEngine` infers a
  gender/age-appropriate voice from the character's profile, so the new member is **already
  audible** with a sensible preset. Nothing is broken here.
- **Qwen (the default / main generation engine):** `pickVoiceForEngine('qwen', …)` returns
  `''` for an undesigned character. That is worse than silent: `computeQwenKokoroFallbackSet`
  detects the undesigned-voice fallback and **pauses the chapter at generation time** asking
  the operator to confirm or skip a generic-Kokoro fallback. The missing voice becomes a
  generation *blocker*, and the reassigned line never sounds like its own character.

So fs-63 is, in practice, a **Qwen-project** problem: a created off-roster character needs a
bespoke Qwen voice before its reattributed line is properly audible.

**Benefit (user):** an off-roster reattribute becomes properly audible in one tap, without a
separate trip to the Cast view to design a voice.

## 2. Approach

After an off-roster create on a Qwen project, surface a single **actionable toast** nudging the
operator to design voices for the freshly-created character(s). Tapping the action enqueues
exactly those characters into the **existing bulk-design pipeline** (`designAllRequested`),
which runs the srv-48 persona pre-pass + Qwen VoiceDesign and reports progress on the
`DesignPill` — the same machinery as "Design full cast", scoped to the new ids.

### 2.1 Why a toast nudge, not fully automatic

Bespoke Qwen design loads the VoiceDesign 1.7B model (~4–5 GB, evicts the analyzer) and takes
tens of seconds per character. Firing that silently on create would surprise an operator who is
mid-review and not yet ready to generate. A consent-driven nudge keeps the heavy GPU work
deliberate. The cost is honest: this is **one tap, not zero** — see §6.

### 2.2 Why bespoke design, not a cheap preset stamp

A lighter alternative — stamping a deterministic Kokoro override on create — would make the line
audible instantly with no GPU. It was rejected: an explicit override renders the character in
Kokoro *forever* and drops it out of the "Design full cast" nudge, leaving a non-bespoke voice
on a bespoke-voice project. Reusing the real design pipeline keeps the Qwen project's intent
intact.

## 3. Architecture & data flow

Three small touch points; no new server route, no new infra. The nudge is a **dedicated,
cast-design-aware component**, not a generic actionable-toast capability — see §3.2 for why.

### 3.1 `src/lib/apply-proposed.ts` — return the created characters

`applyProposedReattributions` already tracks ids minted this batch in its `memo` map. Extend its
return from `{ created: number; aborted: boolean }` to
`{ created: number; createdCharacters: { id: string; name: string }[]; aborted: boolean }`.
`createdCharacters` carries the `{id, name}` of every character actually minted this batch
(empty when every proposed op deduped to an existing roster member). The `name` rides along so
the nudge copy can name the character without a second lookup — `createCharacter` already returns
`{id, name}`. The order matches creation order; on an aborted batch it carries the characters
created before the abort.

### 3.2 The nudge is a dedicated, busy-aware component — NOT a generic actionable toast

A first design sketched a generic `{ label, dispatch }` action on every `Toast`. It was rejected
on two grounds:

1. **YAGNI.** A serializable-action-on-any-toast capability is speculative for a single consumer.
2. **It can't handle the re-entrancy reality.** The cast-design middleware enforces ONE in-flight
   design stream at a time, for any book: `cast-design-stream-middleware.ts` early-returns on
   `if (handle) …` when a bulk, single (drawer), or cold-boot-resubscribe stream is already open.
   The Cast view copes by **disabling its "Design full cast" button** while a run is active
   (`designRunningHere` / `designRunningElsewhere`). A dumb dispatch-then-dismiss toast has no way
   to know the middleware is busy — tapping it would silently no-op AND dismiss the nudge, leaving
   the character undesigned with zero feedback.

So the nudge is its own small component (`src/components/voice-nudge-toast.tsx`), rendered by
`ToastStack` for a new `Toast.kind: 'action'` carrying a typed `nudge` payload
(`{ bookId, characterIds, modelKey, names: string[] }`) — NOT an opaque action object. It reads
`castDesign.active` live and mirrors the Cast view's busy semantics:

- **Idle:** the action button reads "Design now" / "Design all"; tapping dispatches
  `castDesignActions.designAllRequested(...)` (built from the `nudge` payload) and dismisses.
- **A design is already running (any book):** the button is **disabled** with sub-text
  *"A voice design is already running…"* — the nudge **stays** (sticky), so the operator can act
  once the current run settles. No silent loss.
- **Sticky.** Action-kind toasts skip the 6 s auto-dismiss (a GPU action needs a real window);
  they clear on action, on manual dismiss, or via dedupe replacement.

`notifications-slice.ts` gains the `'action'` kind + the typed `nudge` field on `Toast`; the
payload is a plain serializable literal (ids + strings), so RTK's `serializableCheck` is satisfied
and the slice still never imports cast-design (the *component* owns that dependency).

### 3.3 `src/components/script-review-diff.tsx` `runProposed` — push the nudge

`ttsModelKey` is read once at component scope via `useAppSelector(s => s.ui.ttsModelKey)`
(the async `runProposed` can't call hooks). Mirror the existing `stageBookIdRef` pattern if a
fresh value is needed at resolve time. After `applyProposedReattributions` resolves with a
non-empty `createdCharacters`:

1. Compute the effective engine via `engineForModelKey(ttsModelKey)` — mirroring exactly how
   `cast.tsx` derives the active engine, so the gate can't diverge from the Cast view.
2. **Only when the effective engine is `'qwen'`**, push the action-kind nudge with payload:

   ```ts
   {
     bookId: startBookId,
     characterIds: createdCharacters.map((c) => c.id),
     modelKey: sampleModelKeyForEngine('qwen', ttsModelKey),
     names: createdCharacters.map((c) => c.name),
   }
   ```

   plus `dedupeKey: \`off-roster-voice-nudge:${startBookId}\`` so a second off-roster batch
   replaces the prior nudge rather than stacking a duplicate.

One nudge covers the whole batch (designs all created ids at once via `scope: 'bases'`), not one
per character. The copy is count-aware: singular names the character, plural states the count.

## 4. Edge cases & gating

- **Engine gate.** Qwen only, computed at push time from `ttsModelKey`. Preset-engine projects
  push nothing — the picker already voices the character.
- **Qwen unavailable / cold.** The toast still shows; tapping kicks the job, which auto-loads
  Qwen exactly as "Design full cast" does. A load failure surfaces per-character in the
  `DesignPill` completion summary — no bespoke handling.
- **Book switch during apply.** The existing `isSameBook()` guard aborts the create loop; the
  toast's baked action carries `startBookId`, so a later tap targets the correct book (and the
  bulk job no-ops against a book that has moved on).
- **Already designed before the tap.** The bulk job's freshness-skip already protects a character
  that gained a Qwen voice in the interim — it is skipped, never clobbered.
- **A design is already running when the operator taps.** The nudge button is disabled with
  *"A voice design is already running…"* (§3.2) and the nudge stays sticky — no silent no-op.
  Once the in-flight run settles, the button re-enables and the operator can act.
- **Batch with mixed creates + reattribute-to-existing.** Only minted characters enter
  `createdCharacters`; reattribute-to-existing decisions never mint a character, so they never
  trigger a nudge.
- **Relationship to the generation-time fallback gate.** The created character also trips the
  existing `computeQwenKokoroFallbackSet`, which *pauses the chapter at generation time* to warn
  about the generic-Kokoro fallback. The nudge is the **proactive complement** to that safety
  net — design early via the nudge and the generation-time pause never fires. The two reinforce
  each other; neither is removed.

## 5. Testing

- **Unit — `src/lib/apply-proposed.test.ts`:** `createdCharacters` lists `{id, name}` for every
  minted character; empty when all proposed ops dedupe to existing roster members; carries
  partial entries on an aborted (book-switch) batch.
- **Unit — `src/components/voice-nudge-toast.test.tsx`:** idle → the action button dispatches
  `designAllRequested` with the right `characterIds`/`modelKey`/`scope` then dismisses;
  **design-running → button disabled, nudge stays (not dismissed)**; count-aware copy (singular
  names the character, plural states the count); action-kind toasts are sticky (no 6 s
  auto-dismiss) while plain toasts still auto-dismiss.
- **Unit — `src/components/script-review-diff.test.tsx`:** a Qwen-effective project pushes the
  nudge with the correct payload; a preset-engine project pushes nothing; a batch that only
  reattributes-to-existing pushes nothing.
- **E2E — `e2e/script-review.spec.ts`:** off-roster reattribute on a Qwen mock book → nudge
  appears → tap the action → the `DesignPill` activates. One spec, per the e2e bar for
  behaviour crossing router / redux / layout seams.

## 6. Non-goals & notes

- **"One tap, not zero."** The issue's benefit line reads *"audible in one pass."* This design
  deliberately makes it **one tap** — the consent gate for a 4–5 GB GPU load is the point of the
  chosen toast-nudge trigger. The backlog/issue benefit should read *"audible in one tap."*
- **No preset-engine behaviour change.** Preset projects already auto-voice the character; this
  feature adds nothing there.
- **No new server route.** Reuses `POST /cast/create` (unchanged) and the existing cast-design
  SSE job.
- **No cross-chapter reattribute context** (a separate fs-58 Unit B follow-up).

## 7. Ship checklist

- Close #1119 via `Closes #1119` in the delivering PR; remove the fs-63 row from
  `docs/BACKLOG.md`.
- Update `docs/features/INDEX.md` if a regression plan is added.
- Soften the issue/backlog benefit line to *"audible in one tap"* (§6).
- Run `npm run verify`.
