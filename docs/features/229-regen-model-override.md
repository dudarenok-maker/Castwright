---
status: active
shipped: null
owner: null
---

# Per-regenerate model override (choose Qwen 1.7B at regen time)

> Status: active
> Key files: `src/modals/regenerate.tsx`, `src/components/layout.tsx`,
> `src/store/queue-thunks.ts`, `src/store/queue-dispatcher-middleware.ts`,
> `server/src/routes/queue.ts`, `server/src/workspace/queue-io.ts`,
> `openapi.yaml` (QueueEntry)
> URL surface: Regenerate modal (generate view)
> OpenAPI ops: `POST /api/queue/enqueue` (QueueEntry gains `modelKey`)

## Benefit / Rationale

_Benefit (user):_ regenerate a chapter at the **Qwen 1.7B quality tier** without
re-casting every character. Previously every regenerate used the global session
model (`ui.ttsModelKey`, default 0.6B); 1.7B was only selectable per-character.
Closes #1079.

## Design — thread an optional `modelKey` through the queue entry

The Regenerate modal gains a **Model** picker (Qwen 0.6B / 1.7B, plus the session
default as a "keep current" option when it's another engine). The chosen
`modelKey` travels with the work:

```
RegenerateModal (picker) → onConfirm({…, modelKey})
  → layout.tsx enqueue entries { …, modelKey }
  → POST /api/queue/enqueue
  → queue.ts validates (isTtsModelKey) + stores on the entry
  → queue-io.enqueue() carries it onto the persisted QueueEntry
  → dispatcher: runner.open(bookId, e.modelKey ?? ui.ttsModelKey, …)
  → generation route already accepts body.modelKey
```

`modelKey` is **optional** end-to-end: absent → the dispatcher falls back to the
session `ui.ttsModelKey`, byte-identical to pre-#4. It is persisted on the queue
entry so a reload/reorder keeps the override. An unrecognised value sent to the
route is dropped (falls back to the default) rather than rejected.

## Invariants

- No override → unchanged behaviour (dispatcher uses `ui.ttsModelKey`).
- The override is per-entry; a `forward` regenerate stamps every expanded
  per-chapter entry with the same choice.
- The 1.7B tier remains a per-character setting too (`voice-engine-picker`); this
  adds a chapter-level override at regen time, it doesn't replace per-character.
- **Elevate-only precedence (bug fix, side-11 follow-up):** a character's stored
  `ttsModelKey` (cast.json) and the regenerate-time `modelKey` are resolved via
  `higherQwenTier()` (`server/src/tts/model-keys.ts`), NOT "character always
  wins". Originally `routeFor()` in `synthesise-chapter.ts` let the per-character
  field win outright — since fs-56 stamps every cast member with a tier once
  cast, that made this whole feature a no-op on any already-cast book: picking
  "Qwen3-TTS 1.7B" here silently rendered every character at whatever tier
  cast.json already had. Now the per-character field only ever ELEVATES a
  character above the chosen tier here, never downgrades one below it.
- **The run-start VRAM-hygiene precompute must use the same elevate-only
  resolution (review finding on the fix above).** `generation.ts` evicts
  whichever Qwen base tier a run won't need, once, before chapter 1, so the
  in-use tier stays warm for the rest of the book. It derives "which tiers are
  needed" from the same cast + run default `routeFor` uses — now via the
  shared `computeUsedQwenTiers()` helper (`server/src/tts/per-character-engine.ts`)
  so the two can't drift apart again. Missing this the first time round meant a
  regenerate started at 1.7B with stale-0.6B cast entries evicted the 1.7B tier
  at run start, then paid a cold mid-run reload on chapter 1 anyway — exactly
  the stall this precompute exists to prevent.

## Tests

- `src/modals/regenerate.test.tsx` — picker defaults to the session model and
  `onConfirm` carries it; picking "Qwen3-TTS 1.7B" emits `modelKey: 'qwen3-tts-1.7b'`.
- `src/store/queue-dispatcher-middleware.test.ts` — `runner.open` uses the
  entry's `modelKey` when present, falls back to `ui.ttsModelKey` when absent.
- `server/src/workspace/queue-io.test.ts` — `enqueue()` carries `modelKey` onto
  the stored entry; omits it when absent.
- `server/src/tts/synthesise-chapter.test.ts` — elevate-only precedence pinned
  on BOTH `routeFor` branches: "never downgrades a 1.7B run/regenerate
  override for a character stuck on the 0.6B tier" (same-engine path) and
  "…on the resolveForEngine (cross-engine) path" (mixed-engine chapter).
- Two `higherQwenTier` cases in `server/src/tts/index.test.ts`.
- `server/src/tts/per-character-engine.test.ts` — three `computeUsedQwenTiers`
  cases pinning the run-start VRAM-hygiene precompute fix above.
- typecheck (frontend + server) + ESLint clean; full frontend + server suites green.

## Follow-up

- A Playwright click-through (open Regenerate → pick 1.7B → confirm → assert the
  queued entry's model) — the unit seams are covered; the e2e is a nice-to-have.

## Ship notes

_Pending merge._
