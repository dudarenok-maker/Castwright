# fs-38 Wave 1 — Voice-library store + `#/voices` restructure + designed authoring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first-class, book-independent voice-library store (`My voices`), the three-section `#/voices` restructure, and standalone designed-voice authoring (create / redesign-with-compare / promote / assign) — Wave 1 of the approved spec `docs/superpowers/specs/2026-07-04-fs38-voices-library-design.md`. This wave alone delivers fs-12.

**Architecture:** New persistent store `audiobook-workspace/voice-library/<voiceUuid>/voice.json` (manifests; Qwen `.pt`s stay in the global `voices/qwen/` store), a new `server/src/routes/voice-library.ts` REST surface gated by a config-registry setting, a resolver pass-through in `voice-mapping.ts` so assignments reference library voices without touching the character's own `voiceUuid`, and a new `voice-library` RTK slice + restructured `src/views/voices.tsx` (My voices → In use → Catalogue). Design flow reuses the existing sidecar design path via an extracted scope-agnostic core.

**Tech Stack:** Node/Express + Vitest (server), Vite + React 18 + RTK + Vitest/RTL (frontend), openapi codegen, Playwright (e2e, mock mode).

## Global Constraints

- **Spec is the contract:** `docs/superpowers/specs/2026-07-04-fs38-voices-library-design.md`. On any conflict, the spec wins; flag it, don't improvise.
- **OpenAPI is the type source of truth** — edit `openapi.yaml`, then `npm run openapi:types`; never hand-write `Character`/`Voice`-family types (CLAUDE.md).
- **Type name is `VoiceLibraryEntry`** — NOT `LibraryVoice` (that name already exists in `server/src/routes/voice-match.ts:70` meaning "a voice a book character already uses").
- **Provenance field name is `provenance`** everywhere (`'designed' | 'cloned' | 'imported'`); the server `VoiceKind` enum stays a separate derived display concept.
- **Registry setting key:** `voices.library.enabled` (default `true`), following the `tts.preload.kokoro` shape in `server/src/config/registry.ts:523`.
- **RTK reducers mutate via Immer drafts** — no spread rewrites (CLAUDE.md).
- **No hex literals in components** — design tokens (`--peach`, `--ink`, …) via Tailwind config only.
- **Every new endpoint lands as a PAIRED `real*` + `mock*` in `src/lib/api.ts`** plus fixtures in `src/mocks/` — components only import `api.*`.
- **Touch targets ≥44px on phone** (`min-h-[44px] sm:min-h-0`); modals full-screen `<640px` (mobile protocol).
- **Commit convention:** `<type>(<scope>): <subject>` (CONTRIBUTING.md). Branch for this wave: `feat/frontend-voice-library-wave1` off latest `main` (multi-scope commits `feat(frontend,server): …` inside are fine).
- **Line numbers below were verified 2026-07-04** — if drifted, locate by the quoted symbol, not the number.
- Wave 1 explicitly does NOT include: clone/imported wizard or endpoints, audio ingest, XTTS latents, sidecar changes, emotion variants on library voices, Catalogue rebuild (Wave 2), In-app recording (Wave 4). The `provenance` enum and manifest fields for cloned/imported land now (additive, inert) so Wave 3 is schema-stable.

---

### Task 1: OpenAPI schema + generated types

**Files:**
- Modify: `openapi.yaml` (components/schemas + paths)
- Modify (generated): `src/lib/api-types.ts` via `npm run openapi:types`

**Interfaces:**
- Produces: `VoiceLibraryEntry`, `VoiceLibraryEngines`, `VoiceConsentRecord`, `VoiceSourceAttestation` schemas; `overrideTtsVoices` slots gain optional `libraryUuid` + `provenance`; paths `GET /api/voice-library`, `PATCH|DELETE /api/voice-library/{voiceUuid}`, `POST /api/voice-library/design`, `POST /api/voice-library/{voiceUuid}/redesign`, `POST /api/voice-library/{voiceUuid}/redesign/promote`, `POST /api/voice-library/{voiceUuid}/redesign/discard`, `POST /api/voice-library/promote`, `POST /api/voice-library/{voiceUuid}/assign`, `POST /api/voice-library/{voiceUuid}/sample`.

- [ ] **Step 1: Add schemas to `openapi.yaml`** (alongside `Voice`, ~line 4079):

```yaml
    VoiceLibraryEntry:
      type: object
      required: [voiceUuid, name, provenance, tags, pinned, engines, createdAt, updatedAt]
      properties:
        voiceUuid: { type: string }
        name: { type: string }
        provenance: { type: string, enum: [designed, cloned, imported] }
        tags: { type: array, items: { type: string } }
        pinned: { type: boolean }
        languageCode: { type: string }
        persona: { type: string, description: designed-only instruct text }
        consent: { $ref: '#/components/schemas/VoiceConsentRecord' }
        sourceAttestation: { $ref: '#/components/schemas/VoiceSourceAttestation' }
        sampleTranscript: { type: string }
        sampleMeta:
          type: object
          properties:
            durationSeconds: { type: number }
            sampleRate: { type: number }
            qualityChecks: { type: object, additionalProperties: true }
        engines: { $ref: '#/components/schemas/VoiceLibraryEngines' }
        promotedFrom:
          type: object
          properties: { bookId: { type: string }, characterId: { type: string } }
        createdAt: { type: string }
        updatedAt: { type: string }
    VoiceLibraryEngines:
      type: object
      properties:
        qwen:
          type: object
          required: [status]
          properties:
            status: { type: string, enum: [ready, deriving, stale, failed] }
            baseModel: { type: string }
        xtts:
          type: object
          required: [status]
          properties:
            status: { type: string, enum: [ready, deriving, stale, failed] }
            coquiVersion: { type: string }
            modelId: { type: string }
    VoiceConsentRecord:
      type: object
      required: [personName, relationship, permittedUse, attestedAt, attestedBy]
      properties:
        personName: { type: string }
        relationship: { type: string, enum: [self, family-with-permission, guardian-of-minor] }
        permittedUse: { type: string, enum: [personal] }
        attestedAt: { type: string }
        attestedBy: { type: string }
        revokedAt: { type: string }
    VoiceSourceAttestation:
      type: object
      required: [source, rightsNote, attestedAt]
      properties:
        source: { type: string }
        rightsNote: { type: string }
        attestedAt: { type: string }
```

- [ ] **Step 2: Add `libraryUuid` + `provenance` to ALL THREE `overrideTtsVoices` per-engine slot blocks** (Voice-list ~3958, Voice ~4162, Character ~4706 — each slot currently `{ name, variants? }`):

```yaml
              libraryUuid: { type: string }
              provenance: { type: string, enum: [designed, cloned, imported] }
```

- [ ] **Step 3: Add the nine paths** under a `Voice library` tag. Request bodies: `PATCH {voiceUuid}` takes `{ name?, tags?, pinned?, persona? }`; `design` takes `{ name, persona, languageCode? }` → `201 { entry: VoiceLibraryEntry, previewUrl: string }`; `redesign` takes `{ persona }` → `{ previewUrl: string }` (no `previewToken` anywhere — Tasks 9/12/15 all consume `previewUrl`, and openapi is the generated-type source of truth); `promote` takes `{ bookId, characterId, name }` → `201 VoiceLibraryEntry`; `assign` takes `{ bookId, characterId }` → `200 { updated: number }`; `sample` takes `{ }` → `{ url }` (mirrors `POST /api/voices/{voiceId}/sample`); `DELETE` → `200 { deleted: true }` or `409 { usage: [{ bookId, bookTitle, characterId, characterName }] }` unless `?confirm=1`.

- [ ] **Step 4: Regenerate + typecheck**

Run: `npm run openapi:types && npm run typecheck`
Expected: `api-types.ts` gains `VoiceLibraryEntry`; typecheck green (fields are additive/optional).

- [ ] **Step 5: Commit** — `feat(frontend,server): openapi schema for the fs-38 voice-library surface`

---

### Task 2: Config-registry setting + route-gating middleware

**Files:**
- Modify: `server/src/config/registry.ts` (add setting beside `tts.preload.kokoro`, ~:523)
- Create: `server/src/routes/voice-library-gate.ts`
- Test: `server/src/routes/voice-library-gate.test.ts`

**Interfaces:**
- Produces: `requireVoiceLibraryEnabled(req, res, next)` Express middleware; registry key `voices.library.enabled` (boolean, default `true`, label "Voice library", description "Turn off to hide My voices and disable its API").
- Consumes: the registry's existing `getSetting`/definition pattern (copy the `tts.preload.kokoro` block shape exactly).

- [ ] **Step 1: Write failing test** — with the setting `false`, middleware responds `404 { error: 'voice library disabled' }` and never calls `next()`; with `true` (default), calls `next()`. Mock the registry read the same way sibling route tests mock settings.
- [ ] **Step 2: Run** `cd server && npx vitest run src/routes/voice-library-gate.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the registry entry + middleware:

```ts
// server/src/routes/voice-library-gate.ts
import type { RequestHandler } from 'express'
import { configValue } from '../config/resolver'

export const requireVoiceLibraryEnabled: RequestHandler = (_req, res, next) => {
  if (!configValue<boolean>('voices.library.enabled')) {
    res.status(404).json({ error: 'voice library disabled' })
    return
  }
  next()
}
```

(`configValue<T>(key)` is the synchronous value reader — `server/src/config/resolver.ts:65`; it is safe to call from middleware, no await. There is NO `getSetting` in `registry.ts`.) Registry entry specifics: `env: ''`, a UI-appropriate `group`, and a **no-restart `apply`** — do NOT copy `tts.preload.kokoro`'s `apply: 'restart-sidecar'`; this knob gates a route/UI only. **Registering the entry in the single `KNOBS` array (`registry.ts:17`) IS the exposure** — `GET /api/config` serves `resolveAll()` over all of `KNOBS`; there is no separate allowlist step (Task 14 depends on the knob being served).
- [ ] **Step 4: Run test** — Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(server): voices.library.enabled setting + route gate for the voice library`

---

### Task 3: Manifest store module

**Files:**
- Create: `server/src/workspace/voice-library.ts`
- Modify: `server/src/workspace/paths.ts` (add `voiceLibraryDir()` beside the `voices/qwen` helpers, ~:238)
- Test: `server/src/workspace/voice-library.test.ts`

**Interfaces:**
- Produces:
  - `voiceLibraryDir(): string` → `<WORKSPACE_ROOT>/voice-library`
  - `entryDir(voiceUuid: string): string`
  - `readEntry(voiceUuid: string): Promise<VoiceLibraryEntry | null>`
  - `writeEntry(entry: VoiceLibraryEntry): Promise<void>` — atomic (write `voice.json.tmp`, rename); stamps `updatedAt`
  - `listEntries(): Promise<VoiceLibraryEntry[]>` — skips unparseable dirs with a `console.warn`, never throws on one bad manifest
  - `removeEntryDir(voiceUuid: string): Promise<void>`
  - server-side `VoiceLibraryEntry` type (manual mirror of the openapi schema — the server does not consume `src/lib/api-types.ts`; keep field names identical)
- Consumes: `WORKSPACE_ROOT` resolution from `paths.ts`.

- [ ] **Step 1: Write failing tests** (temp workspace root per test, same fixture pattern as existing `workspace/*.test.ts`): round-trip write→read; `listEntries` returns both valid entries and skips a dir containing corrupt JSON; `writeEntry` bumps `updatedAt`; `readEntry` of missing uuid → `null`; `removeEntryDir` deletes recursively.
- [ ] **Step 2: Run** `cd server && npx vitest run src/workspace/voice-library.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (Node `fs/promises`, `path.join(voiceLibraryDir(), uuid, 'voice.json')`; atomic rename; JSON validation = minimal structural check `voiceUuid && name && provenance`).
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): voice-library manifest store (read/write/list/remove)`

---

### Task 4: List + PATCH routes

**Files:**
- Create: `server/src/routes/voice-library.ts` (router; mount in the server's route index beside `routes/voices.ts` — find the `app.use('/api/voices'…)` site and mirror it as `app.use('/api/voice-library', requireVoiceLibraryEnabled, voiceLibraryRouter)`)
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Produces: `GET /api/voice-library` → `{ voices: VoiceLibraryEntry[] }` (sorted pinned-first then `updatedAt` desc). **Staleness is computed at list time** (equivalent to the spec's "startup scan," simpler): if a manifest's `engines.qwen.baseModel` differs from `QWEN_BASE_MODEL` (`server/src/tts/model-paths.ts:20` — the ONLY Node-side source of the current base model; nothing in `qwen-voice.ts` stamps a baseModel anywhere today), the returned entry's `engines.qwen.status` reads `'stale'` (manifest on disk untouched). Task 9's `currentQwenBaseModel()` wraps this same constant; the library-design route stamps it into `engines.qwen.baseModel` at creation. `PATCH /api/voice-library/:voiceUuid` accepting `{ name?, tags?, pinned?, persona? }` → updated entry; 404 unknown uuid; 400 on `persona` for a non-designed entry or attempts to change `provenance`. **Deliberately deferred to Wave 3:** the `rederive` endpoint — for a designed voice, re-deriving from a persona re-runs the generative 1.7B and produces a DIFFERENT voice (that's a redesign, which exists); true re-derivation only becomes meaningful with a retained master clip.
- Consumes: Task 3 store functions; Task 2 middleware.

- [ ] **Step 1: Write failing tests** (use the repo's existing route-test harness pattern from `routes/voices.ts` tests — express app + injected temp workspace): list sorting; PATCH name/tags/pinned; PATCH persona on `provenance:'designed'` OK, on `'cloned'` → 400; PATCH provenance → 400; unknown uuid → 404; gate off → 404.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement router** (thin: validate → store call → respond; no business logic in handlers).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): voice-library list + edit routes`

---

### Task 5: DELETE with usage scan + full erasure

**Files:**
- Modify: `server/src/routes/voice-library.ts`
- Create: `server/src/workspace/voice-library-usage.ts`
- Modify: `server/src/tts/voice-sample-cache.ts` (**created here, consumed by Tasks 9-10**: optional `contentToken?: string` folded into `voiceSampleFileName`'s djb2 hash, + new `purgeVoiceSamples(cacheScope: string)`)
- Test: `server/src/workspace/voice-library-usage.test.ts` + cases in `routes/voice-library.test.ts` + `voice-sample-cache.test.ts`

**Interfaces:**
- Produces: `scanLibraryVoiceUsage(voiceUuid): Promise<Array<{ bookId, bookTitle, characterId, characterName }>>` — scans every book's `cast.json` (reuse the directory-walk used by `routes/voices.ts` `aggregateVoices`, ~:212) for any `overrideTtsVoices[*].libraryUuid === voiceUuid`; `DELETE /api/voice-library/:voiceUuid` → `409 { usage }` when used and no `?confirm=1`; on confirm (or unused): clears matching override slots (leaving the character voiceless → fe-46 gate surfaces it), then erases **(1)** the entry dir, **(2)** `voices/qwen/qwen-<voiceUuid>.pt` + its sibling `.json`, **(3)** the voice's cached sample MP3s via `purgeVoiceSamples`. Also produces `voiceSampleFileName(..., contentToken?)` — omitted token yields byte-identical legacy filenames (snapshot BEFORE editing) — and `purgeVoiceSamples(scope)`.
- **Windows safety (spec §7):** the protection is **rm-then-rename** (`qwen-voice.ts:664-669` — "rm-then-rename so a Windows rename … can't EPERM"); the sidecar's `POST /qwen/evict-voice` is a separate, best-effort in-memory-cache-coherency call that the existing precedents fire AFTER the file operation (`qwen-voice.ts:701-712` and ~:813) — copy that ordering exactly (the sidecar caches prompts in memory, it does not hold the `.pt` open).
- Consumes: Tasks 3-4.

- [ ] **Step 1: Write failing tests**: usage scan finds a seeded cast.json reference; DELETE without confirm on a used voice → 409 with usage payload; DELETE with confirm removes manifest dir AND a seeded fake `voices/qwen/qwen-<uuid>.pt` AND clears the referencing override slot; **erasure-completeness test**: after confirmed delete, `existsSync` is false for every artifact path (the spec §2.4 unit assertion); `voiceSampleFileName` with a different `contentToken` → different filename, omitted token → EXACT legacy snapshot (capture before editing); `purgeVoiceSamples` removes only its scope's files.
- [ ] **Step 2: Run — FAIL.**  
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): voice-library delete = usage report + confirm + multi-location erasure`

---

### Task 6: Resolver pass-through in `voice-mapping.ts`

**Files:**
- Modify: `server/src/tts/voice-mapping.ts` (`pickVoiceForEngine`, ~:267-302; type `VoiceLike`, ~:56-79)
- Modify: `server/src/tts/synthesise-chapter.ts` (`CastCharacter`'s override-slot type, ~:253-255 — add the same two optional fields)
- Modify: `server/src/workspace/library-cast-scan.ts` (`LibraryCastCharacter`, ~:13-24 — this interface has NO `overrideTtsVoices` field today (runtime carries it because ~:60 pushes `character: c`, a whole-object reference); **ADD** the field with the widened slot type so Task 8's filter typechecks)
- Test: `server/src/tts/voice-mapping.test.ts` (extend the existing file)

**Interfaces:**
- Produces: for engine `qwen`, when `voice.overrideTtsVoices?.qwen?.libraryUuid` is set, `pickVoiceForEngine` returns `` `qwen-${libraryUuid}` `` — BEFORE the existing `qwenStorageKey(voice, voice.id)` derivation; the per-engine slot type widens to `{ name: string; libraryUuid?: string; provenance?: 'designed' | 'cloned' | 'imported'; variants?: … }` in ALL THREE server type sites: `VoiceLike`, `CastCharacter` (synthesise-chapter), `LibraryCastCharacter` (library-cast-scan) — Tasks 5/7/8 read/write these fields and will not typecheck otherwise. (Runtime pass-through already works: `toVoiceLike` at `synthesise-chapter.ts:760` copies slots by reference.) Also **PIN the read-path pass-through with a test**: `normaliseCastCharacter` (`routes/voices.ts:144-157`) does not strip extra slot fields today — lock that in so a future "cleanup" can't silently drop `provenance` (spec §2; note the spec's earlier `normaliseVoiceOverrides` name was a phantom — `normaliseCastCharacter` is the real symbol).
- Consumes: nothing new.
- **Guard:** `pickEmotionVariantVoice` (~:36-54) MUST remain untouched for non-library voices — add a regression test that a character with its own designed voice and NO library slot resolves exactly as before.

- [ ] **Step 1: Write failing tests**: (a) character with own `voiceUuid` 'abc' AND `overrideTtsVoices.qwen = { name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'designed' }` → `pickVoiceForEngine('qwen', …) === 'qwen-lib1'`; (b) same character WITHOUT libraryUuid → unchanged legacy result (`qwen-abc` path via `qwenStorageKey`); (c) `pickEmotionVariantVoice` unchanged for (b).
- [ ] **Step 2: Run — FAIL** (a).
- [ ] **Step 3: Implement** — three lines at the top of the qwen branch:

```ts
const qwenSlot = voice.overrideTtsVoices?.qwen
if (qwenSlot?.libraryUuid) return `qwen-${qwenSlot.libraryUuid}`
```

- [ ] **Step 4: Run — all three PASS.** Also run the FULL existing `voice-mapping.test.ts` — zero regressions.
- [ ] **Step 5: Commit** — `feat(server): pickVoiceForEngine passes through explicit voice-library keys`

---

### Task 7: Assign endpoint (+ provenance stamping)

**Files:**
- Modify: `server/src/routes/voice-library.ts`. **Write a bespoke character-targeted cast write** (read the book's cast.json → find character by id → merge the slot `{ ...existing, name, libraryUuid, provenance }` → atomic write). Do NOT reuse `applyOverrideToCastFiles` (`routes/voices.ts:665-707`): it is keyed by voiceId ACROSS all matching books (wrong granularity) and its `override` param is typed `{ engine, name }`, so it cannot introduce the new fields — reusing it silently drops provenance.
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Produces: `POST /api/voice-library/:voiceUuid/assign` `{ bookId, characterId }` → writes `overrideTtsVoices.qwen = { name: 'qwen-<voiceUuid>', libraryUuid: voiceUuid, provenance: entry.provenance }` into that character's cast.json row (merging, not clobbering, other engine slots) → `200 { updated: 1 }`. 404 unknown voice/book/character. 409 if `consent?.revokedAt` is set.
- Consumes: Task 3 store; Task 6 slot shape.
- **Note:** the character's own `voiceUuid` is NEVER modified (spec §3 — that was the aliasing hazard).

- [ ] **Step 1: Write failing tests**: assign stamps the slot exactly as above and leaves `character.voiceUuid` + `overrideTtsVoices.kokoro` untouched; revoked consent → 409; unknown ids → 404.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): assign a voice-library voice to a character (provenance-stamped slot write)`

---

### Task 8: Matcher exclusion for cloned-provenance assignments

**Files:**
- Modify: `server/src/workspace/library-cast-scan.ts` (`scanLibraryCharacters`) — the single seam feeding BOTH `routes/voice-match.ts` (`projectLibraryVoice`, ~:84-102) and `workspace/series-reuse-link.ts`
- Test: `server/src/workspace/library-cast-scan.test.ts` (extend or create beside existing tests)

**Interfaces:**
- Produces: any scanned character whose `overrideTtsVoices[*].provenance === 'cloned'` is EXCLUDED from the candidate records the scan returns. `imported`/`designed` provenance and provenance-less characters pass through unchanged.
- Consumes: Task 6 slot shape.
- **Scope note (intentional forward-wiring):** no clone endpoint exists in Wave 1, so this filter can't fire end-to-end until Wave 3 — it lands NOW, hand-seeded in tests, because the `provenance` field lands now and the guardrail must predate the first clonable voice (spec §6; spec §9 lists only the *hardening tests* under Wave 5).

- [ ] **Step 1: Write failing test**: seed two books — book A has a character with a `provenance: 'cloned'` qwen slot, book B has one with `provenance: 'imported'` and one legacy character; scan returns the imported + legacy characters, never the cloned one.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (a single `.filter()` at the scan seam with a comment citing spec §6).
- [ ] **Step 4: Run — PASS**, plus the full existing voice-match test file for zero regressions.
- [ ] **Step 5: Commit** — `feat(server): cross-book matcher never offers a cloned-provenance assignment back`

---

### Task 9: Design-flow extraction + library design/redesign routes

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` — the raw material exists but is NOT decoupled: `postDesignAndCache` (~:331-409) is a **nested closure inside `designQwenVoiceForCharacter`** (~:316-471, itself inside `withDesignLock`/`withGpuLoad` at ~:324-327) capturing character-coupled state (`p.sampleVoiceId`, `p.modelKey`, `p.bookDir`, `p.characterId`, `calibrationText`, `sidecarUrl`, `voiceId`). The extraction is a genuine lift-and-parameterise (storageKey, displayName, sampleScope, modelKey, logging context) into the new module — and the `withDesignLock(p.bookDir, …)` wrapper is REPLACED by the library single-flight lock for library calls, never reused. The design handler is at ~:473-619 (NOT :187-260 — that's `ensureCharacterVoiceUuid`). The sidecar persists the `.pt`; the core's job is request-shaping + preview-cache warming.
- Create: `server/src/tts/design-voice-core.ts`
- Modify: `server/src/routes/voice-library.ts` (design/redesign/promote/discard handlers)
- Test: `server/src/tts/design-voice-core.test.ts` + route cases

**Interfaces:**
- Produces:
  - `runVoiceDesign(opts: { storageKey: string; displayName: string; persona: string; languageCode?: string; preview?: boolean }): Promise<{ storageKey: string; previewUrl?: string }>` — scope-agnostic core; `preview: true` designs under `<storageKey>-preview` (the plan-161 pattern generalised) and ALWAYS warms the sample cache + returns the audition `url` exactly as the character flow does (`postDesignAndCache`'s `voiceSamplePublicUrl(fileName)` return at `qwen-voice.ts:390-404` — NOT :680-698, which is the promote route's cache-refresh copy) — this `previewUrl` is what the A/B modal plays (Task 15).
  - **Sample/audition text for a character-less design:** build a minimal `VoiceLike` (`{ id: storageKey, character: displayName, overrideTtsVoices: {} }`) and pass it through the same `buildSampleText(...)` call the character flow uses — it already tolerates missing evidence.
  - **`baseModel` source:** `QWEN_BASE_MODEL` in `server/src/tts/model-paths.ts:20` (the only Node-side current-base-model value; nothing in `qwen-voice.ts` stamps one today; the constant is MODULE-PRIVATE — export it, or have the helper re-derive `process.env.QWEN_BASE_MODEL || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'`; you cannot import it as-is). Export `currentQwenBaseModel()` from the core; the design route stamps it into `engines.qwen.baseModel`, and Task 4's staleness comparison imports the same helper.
  - `POST /api/voice-library/design` `{ name, persona, languageCode? }`: mints a fresh uuid (same nanoid generator srv-43 uses — NOT the character-coupled `ensureCharacterVoiceUuid`), runs `runVoiceDesign({ storageKey: 'qwen-<uuid>', displayName: name, persona })`, writes the manifest (`provenance: 'designed'`, `engines.qwen: { status: 'ready', baseModel }`), → `201 { entry, previewUrl }`.
  - `POST /:voiceUuid/redesign` `{ persona }` → `runVoiceDesign({ …, preview: true })` → `{ previewUrl }`; `/redesign/promote` replaces the live `.pt` with the preview one using **rm-then-rename, then best-effort `/qwen/evict-voice`** (the `qwen-voice.ts:664-669` + `:701-712` ordering — evict AFTER the file op, exactly like the existing promote precedent), updates `persona` + `updatedAt`, purges cached samples (`purgeVoiceSamples`, Task 5); `/redesign/discard` deletes preview artifacts then best-effort-evicts the preview key.
  - **Library single-flight lock:** a module-level in-flight map keyed by `voiceUuid` (plus one `'library:new'` key for creates) — 409 `{ error: 'design already running' }` on re-entry. This intentionally does NOT touch the per-`bookDir` `withDesignLock` (spec §3: no cross-scope server mutex; cross-scope protection = frontend single-slot + sidecar VRAM arbitration).
- Consumes: Tasks 3-4; the existing sidecar client used by `qwen-voice.ts` (mock it in tests exactly as `qwen-voice.ts` tests do).
- **Regression guard:** the existing character-scoped design route MUST keep passing its whole current test file after the extraction — extraction changes call-shape, never behavior.

- [ ] **Step 1: Write failing tests** for `runVoiceDesign` (sidecar client mocked): normal run persists under `storageKey`; `preview: true` under `<storageKey>-preview`; sidecar error → rejects with the same error shape the character route surfaces today.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Extract + implement.** Run the FULL `qwen-voice` test file — must stay green.
- [ ] **Step 4: Write + pass route tests**: design creates manifest with `engines.qwen.status === 'ready'`; concurrent second design → 409; redesign/promote swaps `.pt` and bumps `updatedAt`; discard leaves the live `.pt` untouched.
- [ ] **Step 5: Commit** — `feat(server): scope-agnostic design core + voice-library design/redesign routes`

---

### Task 10: Library sample route

**Files:**
- Modify: `server/src/routes/voice-library.ts` (`POST /:voiceUuid/sample`)
- Test: route case in `routes/voice-library.test.ts`

**Interfaces:**
- Produces: the sample route mirrors `POST /api/voices/:voiceId/sample` behavior (`routes/voice-sample.ts`) with `cacheScope = 'lib-' + voiceUuid` and `contentToken = djb2(entry.persona)` (Wave 3 swaps in the master-clip hash for cloned voices) → `{ url }`.
- Consumes: Task 5's `voiceSampleFileName(..., contentToken?)` + `purgeVoiceSamples`; Task 3 store.

- [ ] **Step 1: Write failing route test**: sample returns a url; after a PATCH that changes `persona`, the returned url differs (content token changed).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** (including the untouched legacy sample tests).
- [ ] **Step 5: Commit** — `feat(server): library voice sample route with content-hashed cache keys`

---

### Task 11: Promotion endpoint

**Files:**
- Modify: `server/src/routes/voice-library.ts`
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Produces: `POST /api/voice-library/promote` `{ bookId, characterId, name }`:
  1. Resolve the character's TRUE source storage uuid — via the same resolution `pickVoiceForEngine`/`qwenStorageKey` uses (`voice-mapping.ts:277-286`), so a **reused/matched** character copies from the SOURCE voice's `.pt`, not a nonexistent character-keyed one (spec §2.2 edge rule).
  2. Mint a NEW library uuid; if `voices/qwen/qwen-<sourceUuid>.pt` exists → byte-copy to `qwen-<libUuid>.pt` (+ sibling `.json`), `engines.qwen = { status: 'ready', baseModel: currentQwenBaseModel() }` — the `baseModel` stamp is REQUIRED or Task 4's list-time comparison reads `undefined ≠ QWEN_BASE_MODEL` and marks every freshly-promoted voice `stale`; if no `.pt` → copy persona only, `status = 'stale'` (on-demand derive later).
  3. Write manifest: `provenance: 'designed'`, `persona` from the character's design record, `promotedFrom: { bookId, characterId }`.
  → `201` entry. The origin character is NOT modified.
- Consumes: Tasks 3, 9.

- [ ] **Step 1: Write failing tests**: promote copies bytes (write a marker `.pt`, assert identical content under the new key); origin cast.json is byte-identical before/after; matched-voice character resolves the source uuid; missing `.pt` → `stale` + no throw.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): promote a character's designed voice into the library (new uuid, byte-copy)`

---

### Task 12: Frontend API pairs + mock fixtures

**Files:**
- Modify: `src/lib/api.ts` (both the `real` and `mock` object literals — they are untyped siblings unified by `typeof api`; add to BOTH or typecheck breaks)
- Create: `src/mocks/voice-library.ts` (fixtures: 4 designed entries — one pinned, one promoted, one with `engines.qwen.status: 'stale'`, and one with `voiceUuid: 'lib-used'` assigned in the mock book so delete-without-confirm exercises the 409 usage path)
- Test: `src/lib/api.voice-library.test.ts` (mock-side behavior)

**Interfaces:**
- Produces (all typed off `api-types.ts`): `api.listVoiceLibrary()`, `api.patchVoiceLibrary(uuid, patch)`, `api.deleteVoiceLibrary(uuid, { confirm })`, `api.designLibraryVoice({ name, persona })` → `{ entry, previewUrl }`, `api.redesignLibraryVoice(uuid, { persona })` → `{ previewUrl }` (the A/B modal plays this against the live sample), `api.promoteLibraryRedesign(uuid)`, `api.discardLibraryRedesign(uuid)`, `api.promoteToLibrary({ bookId, characterId, name })`, `api.assignLibraryVoice(uuid, { bookId, characterId })`, `api.sampleLibraryVoice(uuid)`.
- Mock behaviors: in-memory array seeded from fixtures; `designLibraryVoice` resolves after 300 ms with a new entry (enough to exercise pending UI in e2e); `deleteVoiceLibrary` without confirm returns the 409-shaped usage payload when the fixture uuid is `lib-used`.

- [ ] **Step 1: Write failing tests** against the mock: list returns fixtures; design appends; delete-without-confirm on `lib-used` → usage payload.
- [ ] **Step 2: Run** `npx vitest run src/lib/api.voice-library.test.ts` — FAIL.
- [ ] **Step 3: Implement both sides** (real = `fetch` wrappers matching every sibling endpoint's error-handling idiom in `api.ts`).
- [ ] **Step 4: Run — PASS** + `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(frontend): voice-library api surface (paired real+mock) and fixtures`

---

### Task 13: `voice-library` RTK slice + refetch-on-focus

**Files:**
- Create: `src/store/voice-library-slice.ts`
- Modify: `src/store/index.ts` (register reducer)
- Test: `src/store/voice-library-slice.test.ts`

**Interfaces:**
- Produces: state `{ entries: VoiceLibraryEntry[]; status: 'idle' | 'loading' | 'ready' | 'error'; designPending: boolean }`; thunks `fetchVoiceLibrary`, `designVoice`, `redesignVoice`, `promoteRedesign`, `discardRedesign`, `patchEntry`, `deleteEntry`, `assignVoice`, `promoteCharacterVoice` (each: optimistic where safe — pin/tags — otherwise refetch after success); selector `selectMyVoices` (pinned-first, `updatedAt` desc), `selectVoiceByUuid`.
- **Cross-tab (spec §5, explicit decision):** does NOT join `broadcast-middleware` — instead a `visibilitychange`/`focus` listener installed in the slice's setup (mirror how the router installs against the store in `src/store/index.ts`) dispatches `fetchVoiceLibrary` when a tab becomes visible and `entries` is non-empty-stale (>5 s since last fetch).
- Consumes: Task 12 `api.*`.

- [ ] **Step 1: Write failing tests**: reducers (Immer-style mutation); pinned-first sort; focus listener triggers refetch when stale, not when fresh.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(frontend): voice-library slice with refetch-on-focus`

---

### Task 14: `#/voices` page restructure shell

**Files:**
- Modify: `src/views/voices.tsx` (top-level: add a three-way segmented nav **My voices | In use | Catalogue**; the existing rollup tabs (All / This book / Series & older) become the interior of **In use**; the existing Base-voices tab becomes **Catalogue** unchanged this wave)
- Create: `src/components/voices/my-voices-section.tsx` (empty-state + list shell)
- Test: `src/views/voices.restructure.test.tsx`

**Interfaces:**
- Produces: `<MyVoicesSection />` rendering (a) an empty state with "Create voice" CTA when no entries, (b) the Designed group header + `VoiceLibraryCard`s (Task 15), (c) hidden entirely (and nav defaults to In use) when `voices.library.enabled` is off. **Gate mechanism (there is NO existing settings selector for this):** the knob is served by `GET /api/config` into `config-slice`, but `fetchConfig` is currently dispatched only when the Advanced view mounts (`advanced.tsx:224`) and `config-slice` initial `values` is `{}` — so this task ALSO dispatches `fetchConfig` at app boot (in `src/store/index.ts` setup, beside the router install) and the gate treats "config not yet hydrated" as ENABLED-pending (render nothing gated-off until values arrive, then settle) so the section can't flash-hide. Requires Task 2's `KNOBS` exposure.
- Section order fixed: My voices first, Catalogue last (LOCKED user decision).
- Consumes: Task 13 slice.
- **Guard:** the existing In-use machinery (families/compare/merge/pin) must keep passing `voices.tsx`'s current tests unchanged — this task moves JSX, it does not edit rollup logic.

- [ ] **Step 1: Write failing tests** (RTL): nav renders three segments in order; My voices empty-state CTA present; setting-off hides the segment.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Run the FULL existing voices-view test file — green.
- [ ] **Step 4: Run — PASS**, all viewports sanity (`min-h-[44px]` on segment buttons).
- [ ] **Step 5: Commit** — `feat(frontend): #/voices three-section restructure (My voices | In use | Catalogue)`

---

### Task 15: Library cards + create/redesign modals

**Files:**
- Create: `src/components/voices/voice-library-card.tsx`
- Create: `src/modals/create-library-voice.tsx`
- Create: `src/modals/redesign-library-voice.tsx`
- Test: colocated `*.test.tsx` for all three

**Interfaces:**
- Produces:
  - `<VoiceLibraryCard entry onAssign onEdit />`: name, inline tag editor (add on Enter, remove on ×), pin toggle, language chip, engine-readiness chips (`Qwen ✓` / `stale ⟳` / `failed ⚠` from `engines.qwen.status`), preview-play (calls `api.sampleLibraryVoice`), quiet "My voice" provenance marker for designed (the cloned/imported treatments arrive Wave 3 but the provenance switch lands now with all three branches).
  - `<CreateLibraryVoiceModal />`: persona textarea (reuse the persona-input idiom from `src/modals/profile-drawer.tsx` ~:288) → name field → "Design & audition" (dispatch `designVoice`, disable while `designPending`) → audition player (plays the `previewUrl` the thunk resolves with) → Save. Full-screen `<640px`.
  - `<RedesignLibraryVoiceModal entry />`: edited persona → preview → **A/B old-vs-new** (two play buttons: OLD = `api.sampleLibraryVoice(uuid)`, NEW = the `previewUrl` from `redesignVoice`; + "Keep new" / "Keep old" — the plan-161 compare idiom) → the `promoteRedesign` / `discardRedesign` thunks (Task 13).
  - While a library design runs, the modal dispatches the cast-design pill's `start` action with `bookId: null` (Task 16) so book views see `designRunningElsewhere`.
- Consumes: Tasks 12-13.

- [ ] **Step 1: Write failing tests**: card renders chips per status fixture; tag add/remove dispatches `patchEntry`; create modal blocks Save until a design result exists; redesign modal promote dispatches `promoteRedesign`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(frontend): voice-library cards, create-voice and redesign-with-compare modals`

---

### Task 16: Book-less design pill + assign surfaces + Save-to-my-voices

**Files:**
- Modify: `src/store/cast-design-slice.ts` (`CastDesignSnapshot.bookId: string` → `string | null`; reducers' cross-book guards treat `null` as "not this book", which makes `designRunningElsewhere` true for every book automatically — verify at `cast.tsx:328` and `src/modals/voice-readiness-gate.tsx:46`)
- Modify: `src/components/voice-library-panel.tsx` (new **My voices** group at top: same tap-to-assign/drag affordances; assign dispatches `assignVoice`)
- Modify: `src/modals/profile-drawer.tsx` (voice picker gains My-voices entries; add **"Save to my voices"** button on a designed character voice → `promoteCharacterVoice`)
- Modify: the In-use card component inside `src/views/voices.tsx` (provenance badge: `Designed` / `Catalogue` / `My voice` — from the slot's `libraryUuid`/`provenance` — plus inline **Save to my voices** on Designed cards; `My voice` cards link to the library card)
- Modify: `server/src/routes/voices.ts` — **the real strip site is the multi-book MERGE branch (~:340-348)**, which rebuilds `merged[e] = { name: val.name }` for any voice used in ≥2 confirmed-cast books; carry `libraryUuid` + `provenance` through there, and widen the `DerivedVoice` type's slot (~:124). The single-book path (~:420) already passes `overrideTtsVoices` by reference — no change needed there. (Do NOT patch ~:297-298; that block handles the deprecated `overrideTtsVoice` SINGULAR, which the badge never reads.) The frontend `VoiceProvenanceBadge` reads `voice.overrideTtsVoices[engine]` — pin that in its props type.
- Test: extend each surface's colocated tests + an aggregation test pinning that a seeded provenance-stamped slot survives into `GET /api/voices`

**Known-good behavior note:** while a library design runs (`bookId: null` snapshot), every book's Cast view shows the "design running elsewhere" state and the fe-46 gate warns accordingly — that is the intended single-slot semantics, not a bug; don't "fix" it.

**Interfaces:**
- Produces: assignment + promotion reachable from all three surfaces; badge component `VoiceProvenanceBadge({ slot })` shared by In-use cards, panel cards, and drawer rows (ONE component so Wave-3's cloned/imported treatments land in one place — spec §4 "shared voice-card treatment").
- Consumes: Tasks 12-15.
- **Guard:** `cast-design-slice`'s existing tests + the fe-46 gate specs must stay green after the `bookId: null` widening.

- [ ] **Step 1: Write failing tests**: `designRunningElsewhere`-equivalent selector true for any book while a `bookId: null` snapshot is running; panel My-voices tap-assign dispatches with the right uuids; drawer promote button dispatches `promoteCharacterVoice`; badge renders each provenance branch.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Run full frontend suite — green.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(frontend): assign/promote surfaces, provenance badges, book-less design pill`

---

### Task 17: Playwright e2e

**Files:**
- Create: `e2e/voice-library.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (the `#/voices` entry exists; assert the new segmented nav renders at all three viewports)

**Interfaces:**
- Consumes: mock mode (Task 12 fixtures + mock latencies).

- [ ] **Step 1: Write the spec** (mock mode, port 5174): (1) open `#/voices` → My voices first with fixtures; (2) Create voice → persona → design (mock 300 ms) → save → card appears in Designed; (3) assign fixture voice to a character in the mock book → cast row shows the `My voice` badge; (4) open a second mock book → same voice assignable (cross-book reuse); (5) In-use Designed card shows Save-to-my-voices; clicking adds a library entry. Use `test.describe.configure({ mode: 'serial' })` (known parallel-state gotcha).
- [ ] **Step 2: Run** `npm run test:e2e -- voice-library.spec.ts` — Expected: PASS (fix as needed).
- [ ] **Step 3: Run the full e2e battery** `npm run test:e2e` — zero regressions (14 specs were migrated to `confirmCastAndReachManuscript` recently; don't disturb helpers).
- [ ] **Step 4: Commit** — `test(e2e): voice-library create/assign/promote golden path + responsive coverage`

---

### Task 18: Docs, release notes, backlog + ship checklist

**Files:**
- Modify: `docs/features/194-voice-cloning.md` (status → `active`; add "Wave 1 shipped" note + link this plan)
- Modify: `docs/features/INDEX.md` (entry under its area if missing)
- Modify: `docs/release-notes-next.md` (technical entry, PR-refed) + `RELEASE_NOTES.md` (brand-voice line: building your own stable of narrators in My voices)
- Modify: `docs/BACKLOG.md` (fs-38 row: annotate Wave 1 delivered / fs-12 folded-delivered; per CLAUDE.md backlog rules)

- [ ] **Step 1: Make the doc edits** (PR body will carry `Refs #624` — partial delivery; fs-12's #419 is already closed into #624).
- [ ] **Step 2: Run `npm run verify`** — full battery green.
- [ ] **Step 3: Commit** — `docs(docs): fs-38 wave-1 ship notes + release notes`
- [ ] **Step 4:** Push branch, open PR titled `feat(frontend,server): fs-38 wave 1 — voice-library store, #/voices restructure, designed authoring` with `Refs #624`, run the mandatory code-review gate (`high` effort — multi-scope PR), fold findings, merge per repo flow.

---

## Wave sequencing (plans to be written when scheduled)

- **Wave 2 plan** — Catalogue rebuild (engine filter + facets). Small; may ride Wave 1's PR train instead.
- **Wave 3 plan** — clone pipeline: ffmpeg ingest, `/qwen/clone-voice` extraction, XTTS latents + validation bypass, two-phase wizard, consent/attestation, three-state substitution protection, ECAPA fidelity. Written against post-Wave-1 code.
- **Wave 4 plan** — in-app recording (MediaRecorder + fake-media e2e flags).
- **Wave 5 plan** — polish/hardening.

## Ship notes

Shipped 2026-07-24 via PR [#1800](https://github.com/dudarenok-maker/Castwright/pull/1800)
(`Refs #624` — partial; fs-38 Waves 2-5 remain), merge commit `3d8e10f4` on `main`. All 18 tasks
delivered subagent-driven with per-task + whole-branch review. Wave-1 follow-ups filed:
[#1801](https://github.com/dudarenok-maker/Castwright/issues/1801) (design/sample 503→502),
[#1802](https://github.com/dudarenok-maker/Castwright/issues/1802) (toggle-off blank pane),
[#1803](https://github.com/dudarenok-maker/Castwright/issues/1803) (badge docstring),
[#1804](https://github.com/dudarenok-maker/Castwright/issues/1804) (promote preview-stat hardening).
On-box live-GPU acceptance (real designed voice renders a chapter recognizably) still owed.
