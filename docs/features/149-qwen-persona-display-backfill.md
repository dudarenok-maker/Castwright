---
status: active
shipped: null
owner: null
---

# 149 — Qwen persona display fallback + voiceStyle backfill

> Status: active (live acceptance pending → stable)
> Key files: `server/src/routes/qwen-voice.ts`, `server/src/workspace/paths.ts`, `src/modals/profile-drawer.tsx`, `src/lib/api.ts`, `scripts/backfill-qwen-voicestyle.mjs`
> URL surface: indirect — Profile Drawer "Voice persona" textarea (cast/confirm views)
> OpenAPI ops: `GET /api/books/{bookId}/cast/{characterId}/designed-persona` (undocumented in `openapi.yaml` — returns `{ instruct }`, no new schema component)

## Benefit / Rationale

- **User:** a reused/origin character whose Qwen voice is already designed no longer shows a BLANK "Voice persona" textarea — the persona that designed the voice is shown, and a re-design is no longer blocked by the empty-persona 400.
- **Technical:** the persona text (designed-voice `instruct`) becomes readable by every surface that reads `character.voiceStyle`, both at runtime (lazy GET fallback) and on disk (one-shot backfill), with reuse pass-through carrying it forward.
- **Architectural:** extends the plan-138 "read-time resolve + denormalize" doctrine from the voice *link* (`overrideTtsVoices`) to the voice *persona* (`voiceStyle`). No new write-path hook — the backfill heals existing data; reuse already copies `voiceStyle`.

## Context

The persona was historically persisted only on the voice sidecar `voices/qwen/<name>.json` under `instruct`, never mirrored onto `character.voiceStyle` — absent even in origin books. The drawer seeds the textarea from `character.voiceStyle` (`src/modals/profile-drawer.tsx:219`), so it read blank for reused/origin Qwen characters, and `POST .../design-voice` 400s because its persona defaults to the empty `voiceStyle` (`server/src/routes/qwen-voice.ts:101`). The voice LINK was already correct (plan 138); this is the persona-text half of the same denormalization gap.

## Architectural impact

- **New seams:** `qwenVoiceSidecarPath(name)` / `qwenVoicesDir()` in `server/src/workspace/paths.ts` centralise the `voices/qwen` dir (previously re-derived in `spawn-sidecar.ts` + the repair script). New read-only route `GET .../designed-persona` on `qwenVoiceRouter`. New `api.fetchDesignedPersona(bookId, characterId)` (real + mock) returning `{ instruct }`.
- **Runtime fallback:** the drawer lazily fetches the sidecar `instruct` only when `character.voiceStyle` is empty AND a designed Qwen voice exists (`designedVoiceId` non-null), then mirrors it into redux (`castActions.setVoiceStyle`) exactly like `generatePersona`. Never clobbers a persona the user has started typing.
- **Migration story:** `scripts/backfill-qwen-voicestyle.mjs` (dry-run default, `--apply`, per-file `.bak`, `BASE` env) writes each designed voice's `instruct` onto the character's empty `voiceStyle`. Idempotent. Ran on live `C:\AudiobookWorkspace`: **5 cast files, 105 personas backfilled, 0 unresolved.**
- **Reversibility:** route + drawer fallback are additive (no behaviour change when a `voiceStyle` already exists or no sidecar is found). Backfill writes `.bak` per file.

## Invariants to preserve

- The persona GET resolves the voiceId the SAME way as design-voice: own `overrideTtsVoices.qwen.name` else `deriveQwenVoiceId(character, characterId)` (`server/src/routes/qwen-voice.ts:68`) — so a reused character (empty own override, `voiceId` set) resolves its series-shared sidecar.
- The GET returns 200 `{ instruct: '' }` (not 404) when the sidecar/key is absent — a benign blank, identical to today's behaviour; 404 is reserved for unknown book/character.
- The drawer effect only seeds when `character.voiceStyle` is empty (guards against overwriting an edited/persisted persona) and mirrors the same redux action `generatePersona` uses (`profile-drawer.tsx`).

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/qwen-voice.test.ts`) — `designed-persona` block: sidecar present → 200 `{ instruct }`; per-character override name wins over derived `qwen-<voiceId>`; no sidecar → 200 `{ instruct: '' }`; sidecar without `instruct` → `''`; unknown book/character → 404.
- Vitest unit (`src/modals/profile-drawer.test.tsx`) — seeds the textarea from the sidecar `instruct` when `voiceStyle` is empty (plan 149); does NOT fire the lookup when a `voiceStyle` already exists.
- **Script:** `scripts/backfill-qwen-voicestyle.mjs` has no JS test, matching the precedent of `scripts/repair-reused-qwen-overrides.mjs` (the `scripts/tests/` Pester harness covers other scripts, not the repair `.mjs`). Validated via the dry-run + idempotency walkthrough below — intentional omission.

### Manual acceptance walkthrough (real backend, `BASE="C:/AudiobookWorkspace"`, The Drowning Bell / Wren)

1. Open Wren's drawer in The Drowning Bell (pre-fix): card shows "Qwen · qwen-wren · Designed voice", 12s sample plays, but "Voice persona" is BLANK; Design → 400.
2. Runtime fallback (route deployed, pre-backfill): re-open Wren → textarea shows "A relatable 15-year-old girl…"; Design synthesises (no 400).
3. Backfill dry-run → prints `+ Wren … qwen-wren` for The Drowning Bell + origin; "DRY RUN", no writes.
4. `--apply` → `.bak` per changed cast.json; `voiceStyle` written.
5. Re-run dry-run → 0 changed (idempotent). The Drowning Bell cast.json Wren now has `"voiceStyle": "A relatable 15-year-old girl…"`.
6. Regenerate The Drowning Bell → Narrator/Wren render Qwen (link was already correct), the stale `Fallback (Kokoro)` pill clears.

## Out of scope

- Denormalising `voiceStyle` at the auto-match WRITE site (the sibling of `srv-14`, which did the same for `overrideTtsVoices`). Filed as `srv-18`. This plan heals existing data once + resolves at read-time; it does not add a new write-path hook.
- The stale `Fallback (Kokoro)` pill itself is data, not code — it clears on regeneration (`server/src/audio/segments-io.ts:101-105`).

## Ship notes

(Filled when status flips to `stable`: shipped date + commit SHA.)
