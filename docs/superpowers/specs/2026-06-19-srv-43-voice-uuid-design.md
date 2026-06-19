# srv-43 — Stable per-voice identity (`voiceUuid`)

- **Date:** 2026-06-19
- **Issue:** [#934](https://github.com/dudarenok-maker/Castwright/issues/934) (`area:srv`, `moscow:should`, `type:chore`)
- **Branch:** `chore/server-srv-43-voice-uuid`
- **Status:** approved design (revised after two adversarial passes) — ready for implementation plan

## Problem

A designed Qwen voice has no stable identifier. Its **on-disk storage key** is the derived
string `qwen-${voiceId ?? characterId}` (`deriveQwenVoiceId`, `server/src/routes/qwen-voice.ts`),
which is also written into `overrideTtsVoices.qwen.name` and handed verbatim to the sidecar at
synth time to load `voices/qwen/<key>.pt`. `voiceId` / `characterId` are stable **within** a
series but **repeat across** unrelated series: two different characters that share a name/id in
different books (e.g. a "Wren" in two unrelated series) both derive `qwen-wren`, write to the
**same** `.pt`/`.json`, and the sidecar prompt cache keys on that same string. The second design
silently **overwrites** the first (last-write-wins).

The collision is purely an **on-disk storage-key collision**. It is *not* a linker bug: both
`series-reuse-link.ts` and `cross-book-duplicates.ts` are already same-author + same-series scoped.
Only **Qwen** persists per-character designed files (no `coquiVoicesDir` / `kokoroVoicesDir`);
Coqui / Kokoro / Gemini use shared catalog voices — zero collision risk, out of scope.

## Design — forward-only

No on-disk migration. Correctness rests on two mechanisms that are reliable regardless of
upgrade path (a boot migration would be version-gated — fresh installs / restores / Pinokio
reinstalls skip it — so correctness must not depend on one):

1. **Design-time minting.** When a Qwen voice is first designed, mint an immutable
   `voiceUuid = nanoid()` on the `Character` (if absent), and write its storage key as
   `qwen-<voiceUuid>` into `overrideTtsVoices.qwen.name`. New designs are globally unique →
   **100 % of new cross-series collisions are prevented.**
2. **Runtime legacy fallback.** The key resolver returns the uuid-derived key when a
   `voiceUuid` is present, else the legacy `qwen-${voiceId ?? characterId}` key. Existing
   name-keyed voices keep resolving to their existing `.pt` files untouched — no migration,
   no data movement, no breakage.

Legacy voices stay name-keyed until they are next re-designed (at which point they lazily gain a
`voiceUuid`). Already-collided legacy pairs remain collided — that overwrite already happened on
disk and is unrecoverable by any approach.

**Downgrade-safe.** Because the full storage key still lives in `overrideTtsVoices.qwen.name`
(`qwen-<uuid>`), an older pre-srv-43 server ignores the unknown `voiceUuid` field, reads
`qwen.name` as the synth key, and finds the `.pt` we wrote. No schema bump, no
`UnsupportedSchemaError` refusal, no silent mis-synth.

### `voiceUuid` placement and the key resolver

- `voiceUuid` lives on the **`Character`**, not inside the qwen slot. It is the only id that
  survives an engine switch (the qwen slot can be absent when a character is on Coqui/Kokoro),
  and it is the engine-agnostic id future cross-book features want. This is *why* it is stored
  separately even though it is prefix-strippable from `qwen.name` — do not "simplify" it away.
- **Invariant** (uuid-backed voices only): `overrideTtsVoices.qwen.name === 'qwen-' + voiceUuid`,
  with `voiceUuid` as the source of truth. Asserted by a unit test.
- `deriveQwenVoiceId(character, characterId)` becomes the single resolver:
  `character.voiceUuid ? 'qwen-' + character.voiceUuid : 'qwen-' + (voiceId ?? characterId)`.
  It is **read-only** (resolve); minting happens at the genuine design-creation entry point.
  Every consumer must route through it: the **six call-sites** in `qwen-voice.ts`
  (≈ lines 141, 224, 265, 548, 642, 703), `persistEmotionVariant` (a *second* cast.json writer
  that defaults the base name), the `designed-persona` GET, `delete-variant`, and the `-preview`
  `promote-voice` / `discard-voice` validation (`expectedPreview = deriveQwenVoiceId(...) +
  '-preview'`). Update the stale `qwen-voice.ts:169-183` comment that says the committed id is
  kept stable to avoid rippling duplicate-detection — srv-43 changes that committed id.

The synth path is **untouched**: `pickVoiceForEngine` (`server/src/tts/voice-mapping.ts:248`)
keeps returning `overrideTtsVoices.qwen.name` verbatim — which is now `qwen-<uuid>` for designed
voices and the legacy name for unmigrated ones. The sidecar contract does not change.

### Propagating `voiceUuid` on reuse

So that two books in a series **share** one voice (one uuid, one `.pt`) — and so the invariant
holds on reused rows — `voiceUuid` must travel with the qwen override everywhere `voiceId`
already does. Reuse uses explicit **allowlists**, so each must name the field:

- `merge-analysis-cast.ts` — add `voiceUuid` to the `PRESERVED_VOICE_FIELDS` constant (`:32-41`),
  or a reparse/re-analysis **strips it** from the whole cast.
- `server/src/tts/hydrate-reused-voice.ts` (note: under `tts/`, not `workspace/`) —
  `ReuseHydratable`, `ResolvedReusedVoice`, `resolveReusedVoiceFields`, and `hydrateCharacterVoice`
  each carry `voiceUuid` alongside `overrideTtsVoices`/`ttsEngine`.
- `series-reuse-link.ts:324-339` denormalises `overrideTtsVoices.qwen.name = qwen-<sourceKey>`
  onto the reused character — it must set the source's `voiceUuid` on the same lines, or the
  reused row has `qwen.name` set with a blank `voiceUuid` (invariant break; dedup-skip never fires).
- **Audit every `voiceId`-copy site and copy `voiceUuid` alongside**: `cast-link-prior.ts`
  (`:192,230`), `voice-match.ts:227`, `voice-override-linked.ts:182`, `cast-add-from-roster.ts:136`,
  `series-roster.ts:48`, `revisions.ts:256`, `character-snapshots.ts:38`.

`import.ts` writes cast.json directly without a `voiceUuid`; that is benign (the voice keeps its
name-keyed `qwen.name`, resolved via the legacy fallback) — note it, no fix required.

### Cross-book dedup re-bucket (Qwen only)

`detectDuplicateCandidates` (`cross-book-duplicates.ts:129`) buckets by `${provider}|${ttsVoice.name}`
(`:137`) and then re-checks `looksLikeSameName(a.character, b.character)` (`:160`, **substring-aware**:
`"wren" ⊂ "wren sparrow"` — the header comment calls that the detector's reason to exist). Once
designed Qwen names are globally unique (`qwen-<uuid>`), the name bucket makes every Qwen voice a
singleton → dedup silently returns nothing.

Fix, **scoped to Qwen only**: coarsen the Qwen bucket key to `qwen|${author}|${series}` (available
via `ctx.seriesByBookId`), and let the existing in-bucket `looksLikeSameName` + author/series/
standalone/`notLinkedTo`/alias guards (`:153-195`) do the real, substring-tolerant match. **Leave
catalog engines (Coqui/Kokoro/Gemini) on `provider|name`** — re-bucketing them would change a
shipped feature's results. Do **not** "match on `voiceUuid`": separately-designed same-character
voices have *different* uuids by construction. A shared `voiceUuid` is used only to **skip** pairs
that are already linked.

### Frontend plumbing

- Add `voiceUuid?: string` (**optional**, additive) to the `Character` **and** `Voice` schemas in
  `openapi.yaml`; regenerate `src/lib/api-types.ts` (`npm run openapi:types`). Optional ⇒ no
  `src/mocks/canned-data.ts` fixture breaks.
- The voices aggregator in `voices.ts` (≈ 335–361) must **copy `c.voiceUuid`** onto each derived
  `Voice`, or the field never reaches the frontend and the dedup change is dead code.
- `voices.ts:350,355` key `gradientForTtsVoice` and the `generated`/`sampled` badges on
  `ttsVoice.name`; ensure `renderedQwenNames` / sample scope are keyed on the new `qwen-<uuid>`
  name so gradients/badges don't silently re-roll or mis-show. Cosmetic.

### Sidecar

`server/tts-sidecar/main.py` — the designed-voice `.json` descriptor gains a `voiceUuid` field per
the issue's acceptance. It is **inert / forward-looking**: the sidecar loads purely by filename and
reads `instruct`/`language`/`refText`; nothing keys on `voiceUuid` today. No sidecar logic change.

### Out of scope / non-goals

- **No on-disk file migration, no schema bump, no `upgrade-coordinator` / fs-1-seam wiring, no
  writer-side schema stamping.** (The boot-migration approach was rejected: a pure per-doc
  transform splits legitimately-shared reused voices into independent uuids; it is version-gated
  so unreliable; and it is unnecessary given the runtime fallback.)
- No rename UI. The qwen storage name is never user-facing (the cast view shows the character name
  + "Designed voice"); the issue's "`name` becomes a renamable mirror" acceptance is satisfied
  **vacuously** — references resolve via `voiceUuid`, so any future label rename is safe.
- No change to the `voiceId` field (still the reuse-link match key), to `pickVoiceForEngine`, or to
  the sidecar synth contract.
- Coqui / Kokoro / Gemini voices.

## Testing

Paired automated tests are required (CLAUDE.md testing discipline). All are GPU-free — the
`qwen-voice.test.ts` harness mocks `global.fetch` (the sidecar) and `selectTtsProvider`/
`synthesize` and writes designed-voice JSON manually (`:54-66, 110, 177`):

- **Collision regression** (route integration, mocked fetch) — design two same-named characters in
  different series; assert distinct `voiceUuid` and that two *different* `qwen-<uuid>.pt` paths are
  written, no overwrite. Fails on `main`.
- **Legacy fallback** — a character with **no** `voiceUuid` resolves through `deriveQwenVoiceId` to
  `qwen-${voiceId ?? characterId}` (unmigrated voices keep working).
- **Invariant** — a freshly-designed voice satisfies `qwen.name === 'qwen-' + voiceUuid`; its
  emotion variants are `qwen-<uuid>__<emotion>` with the base name unchanged.
- **Reuse propagation** — a reused character in a later book of the same series inherits the
  owner's `voiceUuid` (via `resolveReusedVoiceFields` + `series-reuse-link`); a reparse preserves
  it (`PRESERVED_VOICE_FIELDS`).
- **Dedup re-bucket** (pure unit test feeding synthetic `Voice[]` carrying `voiceUuid`, since mock
  mode leaves the field undefined) — two separately-designed same-character Qwen voices (different
  uuids, same series, substring names like "Wren" / "Wren Sparrow") are still surfaced as a
  candidate; catalog-engine (Coqui/Kokoro) dedup results are unchanged; an already-linked pair
  (shared uuid) is skipped.
- **api-types** — `voiceUuid` present on the derived `Voice` from the voices aggregator.
- **Sidecar descriptor** — `.json` round-trips `voiceUuid` (pytest); explicitly noted as inert.

No e2e spec expected (no router / redux / layout seam, and `voiceUuid` is undefined in mock mode).
Confirmed in the plan; add a Playwright spec only if a UI-visible path is found.

## Key files

- `server/src/routes/qwen-voice.ts` — `deriveQwenVoiceId` resolver (uuid-or-legacy) + design-time
  mint; the 6 call-sites, `persistEmotionVariant`, `designed-persona` GET, `delete-variant`,
  `-preview` promote/discard derivation; update the stale `:169-183` comment.
- `server/src/store/merge-analysis-cast.ts` — add `voiceUuid` to `PRESERVED_VOICE_FIELDS`.
- `server/src/tts/hydrate-reused-voice.ts` + `server/src/workspace/series-reuse-link.ts` — carry
  `voiceUuid` through reuse hydration + denormalisation (match key unchanged).
- `voiceId`-copy sites: `cast-link-prior.ts`, `voice-match.ts`, `voice-override-linked.ts`,
  `cast-add-from-roster.ts`, `series-roster.ts`, `revisions.ts`, `character-snapshots.ts`.
- `server/src/routes/voices.ts` — `applyOverrideToCastFiles` storage-name write; the voices
  aggregator (≈ 335–361) copies `c.voiceUuid`; gradient/badge keying (`:350,355`).
- `src/lib/cross-book-duplicates.ts` — Qwen-only series-axis re-bucket.
- `server/tts-sidecar/main.py` — `.json` descriptor gains inert `voiceUuid`.
- `openapi.yaml` + `src/lib/api-types.ts` — optional `voiceUuid` on `Character` and `Voice`.
