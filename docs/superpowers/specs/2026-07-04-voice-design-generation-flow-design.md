# fe-46 — Voice design in the generation flow (cast-first landing + readiness gate)

> Status: approved 2026-07-04 (adversarially reviewed; see "Review trail")
> Implementation plan: `docs/features/240-cast-first-landing-and-voice-readiness-gate.md`
> Scope: frontend-led, one small server seam; no engine/synthesis changes

## Problem

The book pipeline flows **confirm-cast → Manuscript → Generate**. The confirm CTA
("Confirm cast and review manuscript") lands on Manuscript; the Manuscript header CTA
("Approve cast & start generating") jumps straight to generation. The Cast view — the only
place voice design lives ("Design full cast", per-character Qwen VoiceDesign) — is never on
the path. Users reach generation with undesigned Qwen characters:

- **English books** silently fall back to generic Kokoro voices (`applyQwenFallback`) or
  park per-chapter in the `awaiting_fallback_confirm` queue gate.
- **Non-English books** hard-fail (`MissingDesignedVoiceError` — Kokoro is English-only).
- The tier modal only refuses 1.7B when *zero* voices are designed; 0.6B proceeds unvoiced.

## Decisions (user-approved)

1. **Reorder + gate** (belt and suspenders): the flow teaches the voice-design step, and a
   pre-flight gate at generation start enforces it.
2. **Soft for English, hard for non-English**: English books get an explicit "Proceed
   anyway — generic Kokoro fallback voices" escape hatch; non-English books block outright.
3. **Always land on Cast** after confirm, for all books/engines. New flow:
   **confirm → Cast (design voices) → Manuscript → Generate**, with a "Continue to
   manuscript" CTA on the Cast view.
4. Server fallback semantics stay as-is; the per-chapter `awaiting_fallback_confirm`
   machinery remains as the backstop for anything enqueued outside the pre-flight path.

## Design

### Flow reorder

`confirmCast` (ui-slice) lands on `view:'cast'` instead of `'manuscript'` — this also
removes an inconsistency, since `openBook` already defaults reopened books to Cast. The
Cast view gains an always-enabled "Continue to manuscript" `PrimaryButton`; the confirm
CTA is relabelled ("Confirm cast and design voices") and the guided tour reordered so Cast
steps precede Manuscript steps.

### Voice-readiness selector (new reusable seam)

`src/store/voice-readiness-selectors.ts`, sibling idiom to the analysis-busy gate
(`analysis-substage-selectors.ts`):

- `selectUndesignedQwenCharacters` — **exactly** the Cast view's `needsVoiceIds` semantics
  (effective engine resolves to Qwen, `resolveVoiceStatus` lifecycle `'Needs voice'`, no
  lines filter), talk-time sorted, so the gate and the Cast view always agree on roster
  and counts. Requires extracting `compareCastRows` from the lazy-loaded `cast.tsx` into
  `src/lib/cast-sort.ts` to keep the store bundle clean.
- **Gate firing condition** is narrower: only when a *speaking* (`lines > 0`) undesigned
  character exists — 0-line characters can't trigger the server fallback and must not
  block a run (they're still listed/designed).
- `selectIsBookNonEnglish` + `voiceReadinessGateMessage` (message-builder pair mirroring
  `analysisBusyMessage`).

### Pre-flight gate

A new modal (`voice-readiness-gate.tsx`) opened by `startGenerationFlow()` *before* the
tier prompt, listing undesigned characters. Primary CTA "Design full cast" navigates to
Cast and dispatches the same `designAllRequested` job as the Cast view's own button; if a
design run is already active it becomes "View design progress" (re-dispatching would abort
the running SSE). English books get the proceed-anyway escape hatch; non-English books omit
that affordance entirely. The 0.6B/1.7B tier choice stays in the existing tier modal —
deliberately not merged, since partially-designed casts still need the tier decision.

### De-dupe vs the per-chapter gate

"Proceed anyway" must not re-prompt per chapter. The existing **per-queue-entry**
`fallbackConfirmed` flag (today only settable via `POST /confirm-fallback`) becomes
stampable at enqueue time. Flag path: gate → `openStartGenPrompt({fallbackConfirmed:true})`
→ tier-modal confirm forwards it into `requestStartGeneration` → stream middleware stamps
each **fresh** `EnqueueInput` → server `enqueue()` persists it. Entry-scoped by
construction: chapters enqueued later (new characters, lone per-chapter clicks, resumed
runs) correctly re-trigger the per-chapter gate. Accepted residuals: resumed runs may see
the per-chapter prompt for pre-existing entries (safe, correct), and a sentence reassigned
to an undesigned character after proceeding renders without a fresh warning (English-only,
within the user's explicit consent).

## Rejected alternatives

- **Gate-only / reorder-only** — each half leaves the original failure mode reachable.
- **Skip the tier modal on proceed-anyway** (adversarial reviewer's suggestion) — wrong for
  partially-designed casts, which still need the 0.6B/1.7B choice for designed characters.
- **Blocking "Continue to manuscript" until fully designed** — relocates friction without
  removing it; users legitimately read the manuscript before deciding who needs a voice.
- **Per-queued-chapter gate precision** (parity with `computeQwenKokoroFallbackSet`) —
  meaningfully bigger selector for marginal benefit on a full-run CTA; revisit on evidence.

## Out of scope (filed separately)

- Pre-existing bug: the per-chapter queue gate offers "Render anyway" on non-English
  chapters that then deterministically throw `MissingDesignedVoiceError`.
- Pre-existing drift: `openapi.yaml`'s `QueueEnqueueRequest` schema doesn't match the real
  `entries[]` route shape.
- Converging the tier modal's ad-hoc 1.7B `hasDesignedVoice` check onto the new selector
  (TODO in code, fast-follow).

## Review trail

Designed 2026-07-04; adversarial (assumption-checker) pass ran against the full
implementation plan and confirmed four defects, all fixed in the plan before approval:
dropped de-dupe flag in the tier-modal path, selector/`needsVoiceIds` divergence,
`enqueueOnWork` payload threading + resume-path hole, and an in-flight-design re-dispatch
hazard. Full detail in the implementation plan's "Risks / open items".
