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

## Tests

- `src/modals/regenerate.test.tsx` — picker defaults to the session model and
  `onConfirm` carries it; picking "Qwen3-TTS 1.7B" emits `modelKey: 'qwen3-tts-1.7b'`.
- `src/store/queue-dispatcher-middleware.test.ts` — `runner.open` uses the
  entry's `modelKey` when present, falls back to `ui.ttsModelKey` when absent.
- `server/src/workspace/queue-io.test.ts` — `enqueue()` carries `modelKey` onto
  the stored entry; omits it when absent.
- typecheck (frontend + server) + ESLint clean; full frontend + server suites green.

## Follow-up

- A Playwright click-through (open Regenerate → pick 1.7B → confirm → assert the
  queued entry's model) — the unit seams are covered; the e2e is a nice-to-have.

## Ship notes

_Pending merge._
