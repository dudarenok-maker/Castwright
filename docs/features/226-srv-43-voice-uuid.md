---
status: stable
shipped: 2026-06-20
owner: server
---

# 226 — Stable per-voice identity (`voiceUuid`) to prevent cross-series name collisions (srv-43)

> Status: stable
> Key files: `server/src/tts/voice-mapping.ts`, `server/src/routes/qwen-voice.ts`, `server/src/routes/cast-design.ts`, `server/src/routes/voices.ts`, `server/src/workspace/series-reuse-link.ts`, `server/src/tts/hydrate-reused-voice.ts`, `server/src/routes/voice-override-linked.ts`, `server/src/store/merge-analysis-cast.ts`, `server/src/workspace/paths.ts`, `server/tts-sidecar/main.py`, `openapi.yaml`, `src/lib/api-types.ts`
> URL surface: indirect — voice design, generation, and audition routes; no frontend URL change
> OpenAPI ops: `POST /api/books/{id}/characters/{characterId}/design-voice`, `POST /api/books/{id}/cast/design`, `GET /api/books/{id}/cast`, `POST /api/sample`

## Benefit / Rationale

- **User:** two characters sharing a name across unrelated series (e.g. "Wren" in Book A and "Wren" in Book B) no longer silently overwrite each other's designed Qwen voice. Each character's voice is now permanently keyed to an immutable `voiceUuid`, so the second design creates a distinct `.pt` file rather than clobbering the first.
- **Technical:** splits the previously overloaded `overrideTtsVoices.qwen.name` field into two roles — `name` stays human-readable (display, dedup, voices-view grouping — all unchanged), while `voiceUuid` is the globally-unique machine identity used for on-disk storage and sidecar loading. Legacy voices without a `voiceUuid` continue to resolve by the human name (zero migration required).
- **Architectural:** introduces `qwenStorageKey(character, characterId)` in `server/src/tts/voice-mapping.ts` as the single canonical resolver for every `.pt`/`.json` file path and every sidecar voice-string. All consumers that previously read `overrideTtsVoices.qwen.name` for file I/O now go through this resolver. The `voiceUuid` field is optional and additive on both `Character` and `Voice` in `openapi.yaml`, so no existing clients or fixtures break.

## Architectural impact

### The storage / name split

`overrideTtsVoices.qwen.name` was doing three jobs with conflicting requirements: (1) globally-unique storage key, (2) human display label, and (3) dedup bucket. This change removes responsibility (1):

- **`voiceUuid`** — a `nanoid`, minted once per physical voice at design time. Immutable. The canonical machine identity for all file I/O and sidecar loading.
- **`overrideTtsVoices.qwen.name`** — when a `voiceUuid` is present, this is now the **storage key** `qwen-<uuid>` (not the human label). The legacy form `qwen-<voiceId>` is still written for pre-uuid voices. Direct reads of this field yield the storage key, not a display label.
- **`ttsVoice.name`** (voices aggregator output) — always the **human display label** `qwen-${voiceId ?? characterId}`. Used for display in the cast row, voice-library family grouping, and cross-book dedup bucket matching. The aggregator converts the on-disk storage key to this form. May collide across series — harmless, since dedup buckets on this stable per-character label intentionally, and the distinct `.pt` files are keyed by `voiceUuid`.
- **`qwenStorageKey(c, cId)`** — returns `qwen-${c.voiceUuid}` when `voiceUuid` is present, or `deriveQwenVoiceId(c, cId)` (the legacy human name) otherwise. This is the one behavioral change; `deriveQwenVoiceId` itself is unchanged.

### Mint / propagate lifecycle

The `voiceUuid` must exist **before** the `.pt` file is named, and every character that shares one physical voice must carry the **same** `voiceUuid`. The rules, by entry point:

| Path | Action |
|---|---|
| Fresh single design (`qwen-voice.ts` design route) | **MINT** `voiceUuid` if absent; stamp owner and linked siblings via `applyOverrideToCastFiles`; persist under `withDesignLock`; then `qwenStorageKey` names the `.pt`. |
| Fresh "Design full cast" bulk (`cast-design.ts:242-258`) | **MINT** likewise — second independent design entry point. |
| Linked-sibling propagation on save (`voices.ts:applyOverrideToCastFiles`) | **STAMP / PRESERVE** the owning character's `voiceUuid` on every matched row. |
| Series reuse (`series-reuse-link.ts:308`, `hydrate-reused-voice.ts:resolveReusedVoiceFields`) | **COPY** the source voice's `voiceUuid` onto reused rows; candidate scan (`library-cast-scan` / `series-full-cast-scan` / `voice-match`) exposes it. |
| Stale-link revert (`series-reuse-link.ts:clearStaleLink`) | **CLEAR** the old `voiceUuid` so the character can mint a fresh one on next design (prevents re-collision via an orphaned uuid). |
| Manual unify / approve-duplicate (`voice-override-linked.ts:182-186`) | **CONVERGE** all unified rows to the canonical voice's `voiceUuid`; the other `.pt` then orphans, correctly. |
| Reparse / re-analysis (`merge-analysis-cast.ts:PRESERVED_VOICE_FIELDS`) | **PRESERVE** — `voiceUuid` added to the allowlist; never overwritten by re-analysis. |
| Snapshot restore (`character-snapshots.ts`) | **PRESERVE** — carried through the snapshot roundtrip. |
| Import | None — legacy fallback applies; import is not a design entry point. |

### Downgrade safety

Not downgrade-safe for newly-designed voices: a pre-srv-43 server resolves synth key from `name` and won't find `qwen-<uuid>.pt`. Acceptable for a `should`-priority chore; the fix is forward-only.

### Sidecar

`server/tts-sidecar/main.py` — the designed-voice `.json` descriptor gains a `voiceUuid` field. Inert/forward-looking: the sidecar loads by filename (already distinct — `qwen-<uuid>.pt`) and keys its prompt cache on the voice string passed at synth time. Nothing in the sidecar reads `descriptor.voiceUuid`.

### Field plumbing

`voiceUuid?: string` added as an optional, additive field on both `Character` and `Voice` in `openapi.yaml`; `src/lib/api-types.ts` regenerated. The voices aggregator copies `c.voiceUuid` onto each derived `Voice` object. The v1 frontend does not consume `voiceUuid` (display and dedup use `name`, which is unchanged).

### Out of scope

- `cross-book-duplicates.ts`, the voices-view family grouping, any display change — `name` is unchanged; all three behave exactly as before.
- On-disk migration / schema bump / `upgrade-coordinator` wiring — rejected: a runtime fallback makes it unnecessary, and a per-doc transform would split legitimately-shared reused voices.
- Coqui / Kokoro / Gemini voices — only Qwen persists per-character designed files.
- No rename UI — the `name` field is the display label and remains as-is; synth now resolves through `voiceUuid` so a future label rename is safe without any code change.

## Invariants to preserve

1. **`qwenStorageKey` is the single file-path resolver** — every code path that reads or writes `voices/qwen/<key>.pt` or passes a voice string to the sidecar must go through `qwenStorageKey(character, characterId)` in `server/src/tts/voice-mapping.ts`, never by reading `overrideTtsVoices.qwen.name` directly for file I/O.

2. **`ttsVoice.name` (aggregator output) is the human display name** — `overrideTtsVoices.qwen.name` in `cast.json` is the **storage key** (`qwen-<uuid>` when a `voiceUuid` is present, else the legacy `qwen-<voiceId>`). The voices aggregator (`GET /api/voices`) converts this to the human display form `qwen-${voiceId ?? characterId}` when emitting `ttsVoice.name`, so cast-view display and cross-book dedup (which bucket on `ttsVoice.name`) both see the stable per-character label. Any display path that reads `overrideTtsVoices.qwen.name` directly will see the storage key — always go through `ttsVoice.name` (the aggregator output) or derive the human label as `qwen-${voiceId}` explicitly.

3. **Mint before write** — `voiceUuid` must be stamped on the character and persisted before `qwenStorageKey` is called to name the `.pt` file. The design routes both call `withDesignLock` to prevent a concurrent double-mint.

4. **Legacy fallback** — a character with no `voiceUuid` must resolve to `deriveQwenVoiceId(c, cId)` (the legacy human key), so pre-srv-43 designed voices continue to load without migration.

5. **`PRESERVED_VOICE_FIELDS` includes `voiceUuid`** — re-analysis (`merge-analysis-cast.ts`) must not strip `voiceUuid`. Any new cast-write path that doesn't go through `mergeAnalysisResultWithExistingCast` must explicitly preserve it.

6. **Same `voiceUuid` on every linked row** — characters sharing one physical voice (same-series reuse, linked siblings, manually unified rows) must all carry the same `voiceUuid`. `applyOverrideToCastFiles` and `resolveReusedVoiceFields` are the enforcement points.

## Test plan

### Automated coverage

- **Collision regression** (`server/src/routes/qwen-voice.test.ts`) — designs two same-named characters in two different standalone books; asserts that they receive distinct `voiceUuid` values and that `qwenStorageKey` produces two different `.pt` paths, with no overwrite. Fails on `main` without this change.
- **Resolver unit tests** (`server/src/tts/voice-mapping.test.ts`) — `pickVoiceForEngine` returns `qwen-<uuid>` for a uuid-backed voice and the legacy human name for one without; `pickEmotionVariantVoice` returns `qwen-<uuid>__<emotion>` for a uuid-backed variant.
- **Display via aggregator** — the voices aggregator (`GET /api/voices`) emits `ttsVoice.name = qwen-<voiceId>` (human label) even when `overrideTtsVoices.qwen.name` in `cast.json` is the uuid storage key `qwen-<uuid>`. The new Wave 2 regression test in `voices.test.ts` (srv-43 Wave 2 test) pins this split: a character with `voiceUuid='ABC123'` and `voiceId='wren'` must have `ttsVoice.name === 'qwen-wren'` AND `generated === true` (keyed on `qwen-ABC123`).
- **Mint lifecycle** (`server/src/routes/qwen-voice.test.ts`, `server/src/routes/cast-design.test.ts`) — single design and bulk "Design full cast" both stamp `voiceUuid` on the owner + linked siblings and persist it before the `.pt` is written.
- **Propagation** (`server/src/workspace/series-reuse-link.test.ts`, `server/src/routes/voices.test.ts`, `server/src/routes/voice-override-linked.test.ts`) — reuse copies the source `voiceUuid`; reparse preserves it via `PRESERVED_VOICE_FIELDS`; manual unify converges a unified group to one canonical `voiceUuid`.
- **No snapshot drift** (`server/src/workspace/character-snapshots.test.ts`) — `voiceUuid` is carried through a snapshot roundtrip without being added to the snapshot itself (no spurious drift).
- **api-types** — `voiceUuid` present on the derived `Voice` response from the aggregator.
- **Sidecar descriptor** (`server/tts-sidecar/tests/test_voice_descriptor.py`) — the `.json` descriptor roundtrips `voiceUuid`; field is inert (sidecar does not read it for routing).
- **Audition / `/sample` path** (`server/src/routes/qwen-voice.test.ts`) — `POST /api/sample` resolves the voice string through `qwenStorageKey` using the `voiceUuid` carried on the frontend's character payload.

No Playwright e2e spec — `voiceUuid` is undefined in mock mode and crosses no router/redux/layout seam.

### Manual acceptance walkthrough

Requires a running server + sidecar (GPU box with Qwen weights installed).

1. **Design "Wren" in Book A (standalone)**
   - Open Book A → Cast → Profile drawer for a character named "Wren".
   - Click "Design & compare" → complete the Qwen design flow → "Use proposed voice".
   - On disk: confirm `voices/qwen/qwen-<uuid-A>.pt` exists (NOT `qwen-wren.pt`).
   - In `<bookA-dir>/cast.json`: confirm `characters["wren"].voiceUuid` is set to `<uuid-A>` and `overrideTtsVoices.qwen.name === "qwen-<uuid-A>"` (the storage key, NOT the human label).
   - In the cast view, confirm the voice row shows **`qwen-wren`** (the human `qwen-<voiceId>` form emitted by the aggregator), not `qwen-<uuid-A>`.

2. **Design "Wren" in Book B (different standalone, unrelated to Book A)**
   - Open Book B → Cast → Profile drawer for a character also named "Wren".
   - Complete the Qwen design flow.
   - On disk: confirm `voices/qwen/qwen-<uuid-B>.pt` exists, where `<uuid-B> !== <uuid-A>`.
   - Confirm that `voices/qwen/qwen-<uuid-A>.pt` is **still intact** (was not overwritten).

3. **Generate a chapter in Book A**
   - Queue and generate Chapter 1 of Book A.
   - Confirm the chapter generates successfully using Wren's voice (not Kokoro fallback).
   - Confirm the sidecar log shows `qwen-<uuid-A>` as the voice key, not `qwen-wren`.

4. **Generate a chapter in Book B**
   - Queue and generate Chapter 1 of Book B.
   - Confirm the chapter generates using Wren's voice from Book B (`qwen-<uuid-B>`), distinct from Book A's.

5. **Audition from the voice-compare / profile drawer**
   - From Book A's "Wren" profile drawer, click Play on the designed voice.
   - Confirm the correct voice plays (matches the Book A `qwen-<uuid-A>.pt` embedding).

6. **Legacy voice compatibility**
   - If a pre-srv-43 `qwen-wren.pt` already exists in `voices/qwen/`, open a character that has `overrideTtsVoices.qwen.name === "qwen-wren"` but no `voiceUuid` in `cast.json`.
   - Generate a chapter for that character. Confirm it plays successfully (legacy fallback resolves to `qwen-wren.pt`).

## Known forward-only limitations

### (a) fs-22 demo bundle stays legacy / collision-prone

`samples/the-coalfall-commission/` ships **legacy name-keyed** `.pt` files (e.g. `qwen-wren.pt`) and a `cast.json` with **no `voiceUuid`** on any character. `samples.ts:112-127` merges the bundle into the workspace **by filename, no-clobber**: if the user's workspace already holds an unrelated `qwen-wren.pt` (from a different "Wren" they designed earlier), the bundle's `qwen-wren.pt` is skipped and the demo's "Wren" will bind to the stranger's embedding — the exact collision this change prevents, now unprotected for the shipped demo.

**Current resolution:** the demo bundle is explicitly documented as legacy/name-keyed. The collision only occurs if the user happens to have independently designed a voice with the same derived name (`qwen-wren`). For v1.8.0 open beta the risk is low (pre-existing workspaces are uncommon at launch), but the bundle should be regenerated post-srv-43 on a GPU box so its `.pt` files are `qwen-<uuid>` and its `cast.json` carries `voiceUuid` on each character. A follow-up issue has been filed to track this (see Backlog item `fs-22-bundle-regen`).

**Recommended action:** regenerate `samples/the-coalfall-commission/` by running `scripts/capture-sample-book.mjs` on a post-srv-43 GPU box after designing all 13 voices fresh, then commit the uuid-keyed `.pt` files and updated `cast.json`.

### (b) Legacy maintenance scripts are superseded

`scripts/relink-stripped-qwen-voices.mjs` and `scripts/repair-reused-qwen-overrides.mjs` are one-off recovery tools that correlate cast characters to `voices/qwen/qwen-<voiceId>.pt` by the legacy name. Post-srv-43, voices designed after this change are stored as `qwen-<uuid>.pt`. If these scripts are re-run on a post-srv-43 workspace, they will treat uuid-keyed voice files as "no embedding on disk" and fail to re-link them. Both scripts carry a header comment noting this limitation. A uuid-aware update is required before either script can be safely rerun.

## Ship notes

Shipped 2026-06-20 on branch `chore/server-srv-43-voice-uuid` (PR closes [#934](https://github.com/dudarenok-maker/Castwright/issues/934)).

Key implementation SHAs (all on branch `chore/server-srv-43-voice-uuid`):
- `7038b3aa` — resolve qwen synth key from `voiceUuid` (`qwenStorageKey` in `voice-mapping.ts`)
- `0ce34fbb` — route all qwen `.pt`/key consumers through `qwenStorageKey`
- `a5474f37` — mint + persist `voiceUuid` at design time, both entry points
- `6a600d2e` — strengthen srv-43 collision regression to drive the design path
- `c3b66290` — propagate `voiceUuid` through series reuse
- `e32cad73` — preserve `voiceUuid` across reparse, override-save, snapshots
- `a78110e1` — converge `voiceUuid` to canonical on manual unify
- `2b6f9175` — persist inert `voiceUuid` in the voice descriptor (sidecar)
- `be0cd114` — surface `voiceUuid` on derived `Voice` + align qwen generated-flag fixtures
- `ed211bc3` — carry `voiceUuid` into the audition/sample path
- `439bf768` — seed `voiceUuid` into design preview + approve so audition resolves right after design

Behaviour delta vs. spec: none. The implementation follows the design spec (`docs/superpowers/specs/2026-06-19-srv-43-voice-uuid-design.md`) and the 5-round adversarial plan exactly. The fs-22 demo bundle remains legacy (limitation (a) above); the maintenance scripts are flagged (limitation (b) above).
