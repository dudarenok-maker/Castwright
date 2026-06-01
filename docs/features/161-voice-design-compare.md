---
status: active
shipped: null
owner: null
---

# A/B "current vs proposed" voice audition in the Qwen design flow

> Status: active — code shipped, GPU audition validation owed
> Key files: `src/components/ab-compare-shell.tsx`, `src/lib/use-ab-audition.ts`, `src/modals/voice-compare-modal.tsx`, `src/modals/compare-cast-modal.tsx`, `src/modals/profile-drawer.tsx`, `src/components/voice-engine-picker.tsx`, `server/src/routes/qwen-voice.ts`, `server/tts-sidecar/main.py`
> URL surface: indirect — Profile drawer Qwen "Design & compare"
> OpenAPI ops: none (the Qwen design routes are server-internal, not in `openapi.yaml`)

## Benefit / Rationale

Designing a bespoke Qwen voice in the Profile drawer used to be one-shot: "Design
& preview" synthesised the new voice and played it once, with no side-by-side
against the character's current voice and no explicit approve. Judging whether a
re-designed voice (e.g. after the plan-160 persona-format change) is actually
better was guesswork.

- **User:** "Design & compare" now opens a two-pane A/B — Side A = the current
  voice, Side B = the freshly designed proposed voice (with an editable persona +
  Re-design inline + Auto A→B). "Use proposed voice" keeps it; Cancel discards.
- **Technical:** the A/B is **non-destructive**. A naive compare would have
  overwritten the live voice the instant it designed the proposed (the design
  route derives a stable per-character id and always overwrites). We stage the
  proposed under a `-preview` sibling id and only promote it onto the real id on
  approve, so Cancel leaves the live voice byte-for-byte intact.
- **Architectural:** the two-pane shell + playback orchestration are extracted
  into a reusable `AbCompareShell` + `useAbAudition`; the existing two-character
  CompareCastModal now renders through the same shell (one updated form). The
  committed voiceId stays the stable `qwen-<id>`, so reuse/series/duplicate
  detection (which key on it) are untouched.

## Architectural impact

- **New seams:** `useAbAudition` (per-side `play()` + `matchUrl`/`matchMode`,
  owns the loading rows + Auto A→B sequence) and `AbCompareShell` (overlay +
  header + responsive 2-col grid + footer). CompareCastModal refactored onto
  both with no observable behaviour change (its 12 existing tests stay green;
  the only render delta is `grid-cols-2` → `grid-cols-1 sm:grid-cols-2`, which is
  identical at `sm:`+). `sampleUrlPrefix` consolidated into `src/lib/sample-scope.ts`.
- **Preview/promote (server):** `POST …/design-voice` gains `preview:true`
  (stages under `qwen-<id>-preview`). New `POST …/promote-voice` moves the
  preview `.pt`/`.json` onto the real id, refreshes the cached audition, and
  evicts the sidecar's in-memory prompt cache. New `POST …/discard-voice` drops a
  staged preview on Cancel. New sidecar `POST /qwen/evict-voice` (the prompt
  cache has no on-disk mtime check, so a file-move behind its back needs an
  explicit evict). The sidecar `design_voice` itself is unchanged — it designs
  whatever voiceId it's handed.
- **Staging model preserved:** approve maps the promoted (stable) voiceId +
  persona back into the drawer's pending state (`designedVoiceId` / `persona`);
  the drawer's existing "Save changes" persists it series-scoped via
  `api.setVoiceOverride` exactly as before.
- **Reversibility:** revert the diff; no persisted shape changed. Orphaned
  `-preview` artifacts (if a process dies between design and discard) are inert
  and ignored by everything that resolves `qwen-<id>`.

## Invariants to preserve

- `useAbAudition` Auto A→B order: `sides.a.play()` → `playback.playUntilEnded()`
  → `sides.b.play()`; a cancel or a side error breaks the loop
  (`src/lib/use-ab-audition.ts`).
- Committed Qwen voiceId stays `deriveQwenVoiceId` = `qwen-<voiceId|id>` (stable);
  only the transient compare design uses the `-preview` suffix
  (`server/src/routes/qwen-voice.ts`).
- Approve stages into the drawer; **Cancel never calls `onApprove`** and discards
  the preview (`src/modals/voice-compare-modal.tsx`). Drawer Save unchanged
  (`profile-drawer.tsx` Save onClick).
- Side A resolves the current voice against the character's **persisted** engine
  (`character.ttsEngine ?? projectEngine`), not the edited Qwen selection.

## Test plan

### Automated coverage

- Vitest unit `src/lib/use-ab-audition.test.ts` — playSide stop-toggle, Auto A→B
  ordering, cancel-breaks-sequence, side-error → footer.
- Vitest unit `src/modals/voice-compare-modal.test.tsx` — approve promotes +
  stages (`onApprove` gets the real id); cancel discards (`onApprove` NOT
  called); re-design calls `designQwenVoice({preview:true,…})`; regenerate fills
  the textarea.
- Vitest `src/modals/compare-cast-modal.test.tsx` — 12 existing assertions stay
  green through the shell refactor (overlay testid + Auto button preserved).
- Vitest `src/modals/profile-drawer.test.tsx` — design opens the compare modal
  (`preview:true`), no confirm until approve, approve stages the voice + enables
  Play, Save writes the series-scoped override.
- Vitest server `server/src/routes/qwen-voice.test.ts` — `preview:true` stages
  under `-preview`; promote moves files onto the real id + returns it + evicts
  the sidecar; promote 409 when nothing staged, 400 on a foreign preview id;
  discard removes the preview and leaves the live voice.
- Pytest `server/tts-sidecar/tests/test_qwen_evict.py` — evict pops a cached
  prompt (hit), no-ops on a miss, 400 without a voiceId. (venv-gated → CI skips;
  runs on a bootstrapped dev box.)
- Playwright e2e `e2e/cast.spec.ts` — confirm-cast → drawer → Qwen → "Design &
  compare" opens `voice-compare-overlay` → "Use proposed voice" → designed
  confirm → Save (mock mode).

### Manual acceptance walkthrough (real backend + sidecar, GPU)

1. Open a Qwen character's Profile drawer → "Design & compare". Expect the A/B
   modal with the current voice on Side A and the proposed on Side B.
2. Play both / Auto A→B. Edit the persona on Side B → Re-design → audition again.
3. **Re-designing an existing Qwen character**: Cancel → confirm the character
   still generates/plays its ORIGINAL voice (the live `qwen-<id>.pt` is
   untouched; only `qwen-<id>-preview.*` was written then discarded).
4. "Use proposed voice" → Save → generate a chapter → confirm the new voice is
   used (promote moved the embedding + evicted the sidecar cache).

## Out of scope

- Migrating RebaselineModal's per-row current-vs-proposed UI onto the shared
  shell (separate, store-driven; unaffected).
- Bulk "re-design every character" — see backlog `srv-23`.

## Ship notes

(Filled in when status flips to `stable` after the GPU audition confirms the
non-destructive re-design + the audible delta. Append shipped date + commit SHA,
then move to `docs/features/archive/`.)

Related: [108-qwen-coexistence.md](108-qwen-coexistence.md) (design flow),
[160-voicedesign-persona-format.md](160-voicedesign-persona-format.md) (the
persona format this helps audition), and the Rebaseline plan (the other
current-vs-proposed surface).
