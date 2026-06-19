# srv-43 — Stable per-voice identity (`voiceUuid`)

- **Date:** 2026-06-19
- **Issue:** [#934](https://github.com/dudarenok-maker/Castwright/issues/934) (`area:srv`, `moscow:should`, `type:chore`)
- **Branch:** `chore/server-srv-43-voice-uuid`
- **Status:** approved design (revised after three adversarial passes) — ready for implementation plan

## Problem

A designed Qwen voice has no stable identifier. Its **on-disk storage key** is the derived string
`qwen-${voiceId ?? characterId}` (`deriveQwenVoiceId`, `server/src/routes/qwen-voice.ts`), which is
also handed to the sidecar at synth time to load `voices/qwen/<key>.pt`. `voiceId` / `characterId`
are stable **within** a series but **repeat across** unrelated series: two characters sharing a
name/id in different books (e.g. a "Wren" in two unrelated series) both derive `qwen-wren`, write to
the **same** `.pt`/`.json`, and the sidecar prompt cache keys on that same string. The second design
silently **overwrites** the first (last-write-wins).

Only **Qwen** persists per-character designed files (no `coquiVoicesDir` / `kokoroVoicesDir`);
Coqui / Kokoro / Gemini use shared catalog voices — zero collision risk, out of scope. The collision
is purely an **on-disk storage-key collision**; both `series-reuse-link.ts` and
`cross-book-duplicates.ts` are already same-author + same-series scoped, so it is not a linker bug.

### The constraint that shapes the design

The string `overrideTtsVoices.qwen.name` is doing **three** jobs that have conflicting requirements:

1. **Storage / synth key** — wants to be *globally unique* (the bug).
2. **Display label** — `cast.tsx:1412-1414` *deliberately* surfaces it ("so the row is
   self-explanatory"); shown on ≥5 surfaces (cast, confirm-cast, voice-compare, voice-library,
   rebaseline). Wants to stay *human-readable* (`qwen-wren`).
3. **Dedup bucket** — `cross-book-duplicates.ts` and the voices-view family grouping pre-bucket on
   it. Wants to stay *stable / shared-per-character*.

One field cannot be both globally-unique and human-readable, so the storage role must be split out.

## Design — split storage from name (`voiceUuid` = storage; `name` = human)

- **`voiceUuid`** — a new immutable `nanoid`, minted once per physical voice at design time, stored
  on the `Character`. It is the **canonical machine identity**. (`nanoid` is already a server dep.)
- **`overrideTtsVoices.qwen.name` stays exactly as today** — the human label
  (`qwen-${voiceId ?? characterId}`), shown in the UI and used by dedup. It may now collide across
  series, which is *harmless* because it is no longer a storage key. **Display, dedup, and the
  voices-view family grouping are therefore untouched** — they are out of scope for this change.
- **Storage key** = `qwen-<voiceUuid>`, *derived* (never materialized into `name`). It names the
  `.pt`/`.json` files and is the string handed to the sidecar at synth time.

### The synth-key resolver (the one behavioral change)

Introduce `qwenStorageKey(character)`:

```
qwenStorageKey(c) = c.voiceUuid ? `qwen-${c.voiceUuid}`
                                : deriveQwenVoiceId(c, characterId)   // legacy fallback
```

`deriveQwenVoiceId` is **unchanged** — it keeps returning the human `qwen-${voiceId ?? characterId}`
string used for `name` and as the legacy fallback. Everything that touches the *file* or the
*sidecar* routes through `qwenStorageKey` instead of reading `name`:

- `pickVoiceForEngine` (`server/src/tts/voice-mapping.ts:248`) — for `engine === 'qwen'`, return
  `qwenStorageKey(voice)` instead of `overrideTtsVoices.qwen.name`.
- `pickEmotionVariantVoice` (same file) — for a designed emotion, return
  `qwenStorageKey(base) + '__' + emotion` (presence of `variants[emotion]` still signals "designed").
- The `.pt`/`.json` path build (`qwen-voice.ts`, `paths.ts`) and the `deriveQwenVoiceId` consumers
  that compute file keys: `persistEmotionVariant`, `designed-persona` GET, `delete-variant`, and the
  `-preview` `promote-voice`/`discard-voice` validation — all use `qwenStorageKey`.

**Legacy voices keep working** with zero migration: no `voiceUuid` ⇒ `qwenStorageKey` falls back to
the human name ⇒ resolves to the existing `qwen-wren.pt`. Same fallback for their variants.

**Not downgrade-safe** for *newly*-designed voices: an older pre-srv-43 server resolves the synth key
from `name` (`qwen-wren`) and won't find `qwen-<uuid>.pt`. Acceptable for a `should` chore; noted.

### Mint / propagate lifecycle (the load-bearing correctness work)

The collision closes **only if every Character that shares one physical voice carries the same
`voiceUuid`**, and the uuid exists **before** the `.pt` is named. The voice id is read at three
points that must agree — the core's `.pt` name (`qwen-voice.ts:265`), the caller's persisted
override, and the synth resolver — so the mint must happen on the character object *and be persisted*
before the design core runs. Per-path rule:

| Path | Action | Where |
|---|---|---|
| Fresh single design | **MINT** `voiceUuid` if absent, stamp on owner **and** linked siblings, persist, **before** `qwenStorageKey` names the `.pt` | `qwen-voice.ts` design route |
| Fresh "Design full cast" bulk | **MINT** likewise (second, independent design+persist entry point) | `cast-design.ts:242-258` |
| Linked-sibling propagation on save | **STAMP/PRESERVE** the designed character's `voiceUuid` on every matched row; extend signature to receive it | `voices.ts` `applyOverrideToCastFiles` / `forEachMatchingCastCharacter` (`:572-622`) |
| Series reuse | **COPY** the source voice's `voiceUuid` onto reused rows | `series-reuse-link.ts:308` (next to `c.voiceId = best.voice.voiceId`) **+** the candidate scan that builds `best.voice` (`library-cast-scan` / `series-full-cast-scan` / `voice-match`) must expose `voiceUuid` **+** `resolveReusedVoiceFields` in `server/src/tts/hydrate-reused-voice.ts` |
| Manual unify / approve-duplicate | **CONVERGE** all unified rows to the **canonical** voice's `voiceUuid` (the other `.pt` then orphans, correctly) — required for the dedup "already-linked" suppression to hold | `voice-override-linked.ts:182-186` |
| Reparse / re-analysis | **PRESERVE** — add `voiceUuid` to the field allowlist | `merge-analysis-cast.ts` `PRESERVED_VOICE_FIELDS` (`:32-41`) |
| Snapshot restore | **PRESERVE** | `character-snapshots.ts:38` |
| Import | none — legacy fallback, benign | `import.ts` |

Mint must hold `withDesignLock` (`design-lock.ts`) so two concurrent designs of one character can't
mint two uuids.

### Field plumbing

- Add `voiceUuid?: string` (**optional**, additive) to the `Character` and `Voice` schemas in
  `openapi.yaml`; regenerate `src/lib/api-types.ts`. Optional ⇒ no `canned-data.ts` fixture breaks.
  v1 frontend does **not** consume it (dedup/display use `name`); it is exposed for future cross-book
  features and to satisfy the issue's acceptance.
- The voices aggregator (`voices.ts ~335-361`) copies `c.voiceUuid` onto each derived `Voice` (cheap;
  keeps the API honest even though no v1 consumer reads it).

### Sidecar

`server/tts-sidecar/main.py` — the designed-voice `.json` descriptor gains a `voiceUuid` field per
the issue's acceptance. **Inert / forward-looking**: the sidecar loads by filename and keys its
prompt cache on the voice *string* (now `qwen-<uuid>`, already distinct); nothing reads
`descriptor.voiceUuid`. No sidecar logic change.

## Explicitly out of scope (and why)

- **`cross-book-duplicates.ts`, the voices-view family grouping, and any display change** — `name`
  stays human and unchanged, so all three behave exactly as today. (Earlier drafts proposed a dedup
  re-bucket; unnecessary under this split.) If "skip already-linked pairs" is ever wanted, the
  existing `matchedFrom` / `notLinkedTo` guards already cover it without needing `voiceUuid` on the
  frontend.
- **On-disk migration / schema bump / `upgrade-coordinator` wiring** — rejected: a per-doc transform
  splits legitimately-shared reused voices, it is version-gated (fresh installs/restores skip it),
  and it is unnecessary given the runtime fallback.
- **No rename UI** (the issue's "renamable mirror" is satisfied vacuously — synth resolves via
  `voiceUuid`, so any future label rename is safe). **No change to `voiceId`, to the sidecar synth
  contract, or to the synthesis pipeline** (only the voice-mapping resolver changes).
- Coqui / Kokoro / Gemini voices.

## Testing

Paired automated tests required. All GPU-free — `qwen-voice.test.ts` mocks `global.fetch` and
`selectTtsProvider`/`synthesize` and writes designed-voice JSON manually (`:54-66,110,177`):

- **Collision regression** — design two same-named characters in different series; assert distinct
  `voiceUuid` and that two different `qwen-<uuid>.pt` paths are written (via `qwenStorageKey`), no
  overwrite. Fails on `main`.
- **Resolver unit tests** (`voice-mapping.test.ts`) — `pickVoiceForEngine`/`pickEmotionVariantVoice`
  return `qwen-<uuid>` (+ `__emotion`) for a uuid-backed voice and the legacy `name` for one without.
- **Display unchanged** — a designed voice still has a *human* `overrideTtsVoices.qwen.name`
  (`qwen-…`, **not** the uuid); guards the display regression the third pass caught.
- **Mint lifecycle** — single design and `cast-design.ts` bulk both stamp `voiceUuid` on owner +
  linked siblings and persist it before the `.pt` is written.
- **Propagation** — reuse copies the source `voiceUuid` (candidate scan exposes it; `:308`;
  `resolveReusedVoiceFields`); reparse preserves it (`PRESERVED_VOICE_FIELDS`);
  `voice-override-linked` converges a unified group to one canonical `voiceUuid`; promote / discard /
  delete-variant resolve the same key as synth.
- **api-types** — `voiceUuid` present on the derived `Voice`.
- **Sidecar descriptor** — `.json` round-trips `voiceUuid` (pytest); noted inert.

No e2e spec expected (no router/redux/layout seam; `voiceUuid` undefined in mock mode).

## Key files

- `server/src/tts/voice-mapping.ts` — new `qwenStorageKey`; route `pickVoiceForEngine` +
  `pickEmotionVariantVoice` synth resolution through it.
- `server/src/routes/qwen-voice.ts` — mint `voiceUuid` at design (before `:265`); name `.pt` via
  `qwenStorageKey`; `persistEmotionVariant`, `designed-persona`, `delete-variant`, preview
  promote/discard via `qwenStorageKey`; `deriveQwenVoiceId` stays human.
- `server/src/routes/cast-design.ts` — bulk design mints/stamps `voiceUuid` before storage-key derivation.
- `server/src/routes/voices.ts` — `applyOverrideToCastFiles`/`forEachMatchingCastCharacter` stamp/
  preserve `voiceUuid` on matched rows (signature gains the uuid); voices aggregator copies it.
- `server/src/workspace/series-reuse-link.ts` (`:308`) + the reuse-candidate scan
  (`library-cast-scan` / `series-full-cast-scan` / `voice-match`) + `server/src/tts/hydrate-reused-voice.ts`
  — copy the source `voiceUuid` through reuse.
- `server/src/routes/voice-override-linked.ts` — converge unified rows to the canonical `voiceUuid`.
- `server/src/store/merge-analysis-cast.ts` — add `voiceUuid` to `PRESERVED_VOICE_FIELDS`;
  `character-snapshots.ts` preserve.
- `server/src/workspace/paths.ts` — `.pt`/`.json` path built from the storage key.
- `server/tts-sidecar/main.py` — `.json` descriptor gains inert `voiceUuid`.
- `openapi.yaml` + `src/lib/api-types.ts` — optional `voiceUuid` on `Character` and `Voice`.
