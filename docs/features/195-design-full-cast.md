---
status: active
shipped: null
owner: null
---

# Design full cast (bulk Qwen voice design)

> Status: active
> Key files: `src/views/cast.tsx`, `src/store/cast-design-slice.ts`, `src/store/cast-design-stream-middleware.ts`, `src/components/top-bar.tsx` (DesignPill), `src/components/layout.tsx`, `server/src/routes/cast-design.ts`, `server/src/tts/design-lock.ts`, `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter`)
> URL surface: `#/books/<id>/cast` (the button); the pill is global (top bar)
> OpenAPI ops: `POST /api/books/{id}/cast/design`, `GET …/cast/design/status`, `POST …/cast/design/pause` (SSE — not specced, per the analysis/generation precedent)
> Recycle resilience: a back-to-back bulk run hits sidecar recycles the single-design path rarely does — see `200-bulk-design-recycle-resilience.md` for the ride-out + restart-on-43 + config-handshake fixes that keep this job from halting on the first one.

## Benefit / Rationale

- **User:** one click on the Cast screen designs a bespoke Qwen voice for **every**
  "Needs voice" character, monitored from anywhere via a **third top-bar status pill**
  (beside Analysis and Generation) — replacing the one-character-at-a-time drawer grind.
- **Technical:** the per-character design path (`designQwenVoiceForCharacter`) is now an
  extractable, lock-guarded, GPU-fair core shared by the single-design route and the bulk
  job; the override write reuses the drawer's exact `applyOverrideToCastFiles` path.
- **Architectural:** introduces a per-book **design mutex** + a cross-operation **busy
  registry** (`design-lock.ts`) that serialize designs and make re-analysis ↔ bulk-design
  mutually exclusive — closing a pre-existing `cast.json` write-race that this feature
  would otherwise amplify.

## How it works

**Server (`cast-design.ts`)** owns an in-memory `Map<bookId, DesignJob>`. `POST …/cast/design`
both **starts** a job (body `{ characterIds, modelKey }`) and **re-subscribes** to an in-flight
one (bare body) — the job keeps running with zero subscribers so a browser reload re-attaches
and the pill resumes (the reload-resilience analysis does NOT actually have). The serial loop,
per character: re-read cast fresh → **freshness-skip** if already designed (never clobber a
manual design) → Gemini persona fallback (minimal-patch persist) → `designQwenVoiceForCharacter`
(under the per-book design lock + GPU semaphore, with ~6s heartbeats so the pill's 30s stall
heuristic doesn't trip) → persist the override via `applyOverrideToCastFiles` (series scope for a
series book, workspace scope for a standalone — the series filter skips standalones). Per-character
failures are recorded and the loop continues; a sidecar-down error aborts early.

**Frontend:** the Cast view dispatches `castDesignActions.designAllRequested`; the
`cast-design-stream-middleware` owns the single SSE (start + cold-boot resubscribe), translating
events into the `castDesign` slice and mirroring each `character_designed` into the cast slice so
rows flip "Needs voice" → "Designed" live. The layout computes a `designPill` (work-weighted
percent + inline stall check) → `summarizeStatus` → the compact Status pill + a "Design" section
in the status popover. The cold-boot probe (`layout.tsx`) calls `getCastDesignStatus` for the open
book and dispatches `resubscribe` when a job is live.

## Concurrency hardening (targeted)

- **Per-book design mutex** (`withDesignLock`) shared by the bulk loop AND the single-design
  route → two designs for the same stable `voiceId` can't corrupt the sidecar `.pt`/audition cache.
- **Mutual exclusion:** the bulk start 409s while analysis is live (and the single-design route
  409s while a bulk job is live); the analysis route emits a `design_in_progress` error while a
  bulk job is live. Keyed on `bookDir` (the busy registry, ref-counted for analysis main+subset).
- **Freshness-skip + minimal-patch writes** shrink the generic lost-update window. A full
  `serializeCastMutation` across all 15 cast.json writers is an explicit **follow-up**, not here.
- **UI defense-in-depth:** the drawer's "Design a Qwen voice" button is disabled while a bulk run
  owns the book; the Cast button becomes Cancel for the running book and is disabled for another.

## Test coverage

- `src/store/cast-design-slice.test.ts` — reducer surface + cross-book guard + failure accumulation.
- `src/store/cast-design-stream-middleware.test.ts` — start/resubscribe, mirror-into-cast, serial
  order, failure-continues, settle+clear, re-entrancy.
- `src/components/top-bar.test.tsx` — `summarizeStatus` design rung + priority; `DesignPill` render.
- `src/views/cast.test.tsx` — button gating (Qwen + needs-voice), dispatch payload, Cancel state.
- `server/src/routes/cast-design.test.ts` — full SSE loop (real ffmpeg), series-scope persist,
  persona fallback, freshness-skip, failure-continues, mutual-exclusion 409s, status/pause/bare-idle.
- `server/src/tts/design-lock.test.ts` — mutex serialization + busy ref-counting.
- `e2e/design-full-cast.spec.ts` — confirm → ready cast (Qwen project) → click → pill "Designing"
  → rows flip to "Designed" → button clears.

## Ship notes

- Shipped: 2026-06-07 · commit `7f0d5f4b` (merge `e65961ab`, PR #637). Plan stays `active` —
  it flips to `stable` once the live-GPU acceptance below is signed off.
- **Live-GPU acceptance owed** (needs a Qwen project with weights + a Gemini key for persona-less
  chars): pill ticks + survives navigation; **reload mid-run resumes** the pill; rows flip; terminal
  "Designed N · M failed · K skipped" summary; series propagation to a sibling book; VRAM headroom
  across a long run (VoiceDesign 1.7B + resident Ollama is the plan-108 OOM); a 2nd-tab single design
  is serialized (no garbled audition); designed voices survive an attempted re-analysis (409).

## Follow-ups

- Full `serializeCastMutation` across all cast.json writers (generic lost-update).
- Responsive coverage case for the Cast header button at phone/tablet (`e2e/responsive/coverage.spec.ts`).
