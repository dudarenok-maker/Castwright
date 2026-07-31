---
status: active
shipped: null
owner: null
---

# Cloned Qwen voices honour the book's language (fs-38 follow-up)

> Status: active
> Key files: `server/src/tts/sidecar.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/index.ts`, `server/tts-sidecar/main.py` (`synthesize`, `synthesize_batch`, `/synthesize-batch` route), `server/src/tts/clone-ingest.ts`, `server/src/routes/voice-library.ts`, `server/src/tts/clone-voice-resolver.ts`, `server/src/audio/render-integrity/audition-centroid.ts` + `aggregate.ts`, `server/src/routes/voice-sample.ts`
> URL surface: indirect — every chapter render using a cloned Qwen voice; the clone wizard's completion audition; the cast-row / profile-drawer Play-sample audition
> OpenAPI ops: none new. Two schemas gain a field they already shipped undocumented — `CloneSampleCandidate.detectedLanguage` and `VoiceMaster.languageCode` (the RAW Whisper detection; `VoiceLibraryEntry.languageCode` is the validated one).

Fixes [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951).
Related: [#1953](https://github.com/dudarenok-maker/Castwright/issues/1953) (designed-voice
language mismatch warns at assign time) — same family, different surface, not this plan.

## Benefit / Rationale

- **User:** a cloned voice reading a non-English book produces intelligible
  speech instead of unintelligible pseudo-English. Measured, not asserted —
  see below.
- **Technical:** removes a cache-vs-disk divergence in which the sidecar's warm
  `_prompt_cache` and the on-disk manifest disagree about a designed voice's
  language, so **restarting the sidecar changes the audio**.
- **Architectural:** brings Qwen in line with Coqui, which has honoured a
  per-request language since fs-60, and supplies the language that
  `clearMismatchedDesignedVoices`'s cloned-voice exemption
  (`server/src/tts/verify-designed-voice-language.ts:55`) already assumes exists.

## Measured evidence (dev box, 2026-07-30)

Production call path (`POST /synthesize` → `POST /transcribe`), clone
`qwen-0abceba4-…` whose `refText` is an **English** LibriVox passage, German
sentence *"Der alte Leuchtturm stand einsam auf den schwarzen Klippen, und das
Meer schlug gegen die Steine."*

| Condition | Whisper detects | `avg_logprob` | Transcript |
|---|---|---|---|
| Clone, manifest `English` — **shipped behaviour** | `en` | **−1.303** | *"throughout the term. Stand in the same way as the Swarzen Clip in the mirror."* |
| Clone, manifest patched to `German` + evicted — **the fix, simulated** | `de` | **−0.366** | *"Der alte Leuchtturm stand einsam auf den Schwarz in Clippen und das Meer schlug gegen die Steine."* |
| Native German designed voice — control | `de` | −0.201 | near-perfect |

Two conclusions, both load-bearing:

1. **The failure is total, not gradual.** A language mismatch does not degrade
   the audio; it destroys it.
2. **A clone prompt is language-neutral.** An English-`ref_text` prompt renders
   correct German once the language is right. `_calibration_text`'s
   ref_text/language coupling (`main.py:4095-4101`) matters for *designed*
   voices, whose reference is synthesised, but does not constrain a *distilled*
   clone prompt. This is what makes "the book's language wins" viable at all.

The workspace was restored byte-identical and the cache evicted after the run.

## The defect

`QwenEngine.synthesize` (`main.py:5719`) accepts a `language` argument and never
reads it on either the 0.6B or 1.7B path (`:5719-5782`); the language comes
solely from `_load_voice_prompt` (`:5767`). Designed voices survive this because
`clearMismatchedDesignedVoices` forces their baked language to match the book.
Cloned voices are **exempt** from that gate (`verify-designed-voice-language.ts:55`)
— deliberately, so a clone can be reused across books — but nothing then supplies
a language for them, and their manifest always says `"English"` because
`deriveEngineArtifact` never sends `X-Language`
(`server/src/tts/derive-engine-artifact.ts:63-73`), so
`clone_voice` computes `lang = DEFAULT_LANGUAGE` (`main.py:5256`).

### Why the obvious fix is a no-op — the trap this plan exists to avoid

**Qwen chapter sentences do not go through `/synthesize`.** They go through
`/synthesize-batch`, whose Node body (`sidecar.ts:265-285`) has **no `language`
field at any level**, whose route (`main.py:9367-9373`) never reads one, and
whose engine method `synthesize_batch(self, model, items, live_instruct)`
(`main.py:5784`) has no `language` parameter. `QWEN_BATCH_SIZE` defaults to 32
(`config/registry.ts:478`) and every Qwen group is batchable
(`synthesise-chapter.ts:2498`). The only Qwen `/synthesize` call in a chapter is
the **title beat** (`synthesise-chapter.ts:2108-2113`).

So a fix that only teaches `/synthesize` to honour its `language` would ship a
build where the chapter *title* is German and **every sentence of the book is
still English** — while passing every mechanism-level test. That is the placebo
shape this repo has already been burned by twice; the batch path is therefore the
*primary* regression surface, not a secondary one.

### The cache/disk divergence (designed self-heal)

`clone_voice` warms `_prompt_cache[voice_id] = (prompt, lang)` (`main.py:5290`)
with `"English"`. The designed self-heal path re-derives through `clone_voice`,
then restores the pre-derive designed manifest to recover `instruct`/`designModel`
(`clone-voice-resolver.ts:1001-1007`), putting `"language": "German"` back on
disk. No eviction follows. Disk says German, the warm cache says English, and
designed voices *do* read the manifest language — so the next synth is English
and a restart silently changes the output. `/qwen/evict-voice`'s own docstring
names the mechanism: "the cache has no on-disk mtime check".

## Design

Three principles:

1. **Language is per-item, not per-call.** Forced, not stylistic: a batch may
   **mix voices** — `main.py:5796-5798` ("a batch may MIX voices (narrator +
   dialogue)"), restated at `synthesise-chapter.ts:2346-2349`. One batch can hold
   a cloned character's line (must take the book language) and a designed
   narrator's line (must keep its manifest language). A batch-level field cannot
   express that.
2. **Clone-ness is decided in Node and never re-derived in the sidecar.** The
   wire signal is simply **whether `language` is present on the item**. The
   sidecar's rule is one line: *if the caller gave me a language, use it;
   otherwise use the manifest's.* It never learns what a clone is.
3. **An unmappable language degrades to today's behaviour** — never to a throw,
   never to English.

### Why principle 2, rather than reading `clone: true` in the sidecar

- **`clone: true` is not a reliable marker.** `mint_variant` never writes it
  (`main.py:5425-5441`), and cloned voices *can* reach `mint_variant`:
  `cast-design.ts:364-372` gates the base-design branch on
  `characterHasClonedSlot`, but the variant branch at `:374-383` has no such
  gate and `routes/qwen-voice.ts:370` is ungated.
- **It fails open.** `_read_voice_language` falls back to `DEFAULT_LANGUAGE` when
  the manifest is missing or unreadable (`main.py:5477-5493`), so a clone with a
  lost manifest is indistinguishable from a designed English voice.
- **Node already holds the authoritative answer** — `hasClonedProvenance`
  (`clone-engines.ts:113-124`), the same predicate the cited gate uses. Deciding
  there means one source of truth instead of two that can disagree.
- **It is free.** No `_prompt_cache` shape change, so none of its six write
  sites, the evict route, or the health counter are touched.

Emotion variants fall out correctly for free: a variant is selected by
`pickEmotionVariantVoice` but the **character** still carries
`provenance: 'cloned'`, so `hasClonedProvenance` is still true and the variant
still receives the language — regardless of `mint_variant`'s manifest.

### Rejected alternatives

1. **Bake the clip's language into the manifest and use it at synth time.**
   Wrong direction: it mirrors the bug. A German-cloned voice would then read an
   *English* book as German. Contradicted by the measurement above — the prompt
   is language-neutral.
2. **Honour the request language for all Qwen voices, designed included.** More
   uniform, but it changes behaviour for the 302 designed English manifests to
   fix a 3-manifest case, and on English books (where the gate does not run) it
   would silently override a deliberately-designed voice language. Out of
   proportion; the mismatch case is addressed by #1953's warning instead.
3. **Stop exempting clones from `clearMismatchedDesignedVoices`.** Forces a
   re-clone per book language — the user re-records their voice for every
   language. Discards a deliberate Wave 3c fix.

### Secondary: the clone's own manifest language

Independent of book synth, the manifest language governs two things that are
wrong today:

- the **completion audition** the wizard plays — the user's first impression of
  their own cloned voice;
- the language the Voice Library **displays**, because `routes/voices.ts:412-421`
  reads the manifest word, converts it via `codeForSidecarName`, and stamps
  `languageCode` on the returned `Voice` (`:488`).

So the clone derive sends `X-Language` from the reference clip's Whisper-detected
language. `clone-ingest.ts:48-53` currently discards `TranscribeResult.language`;
it is retained on the candidate (an internal type — **no OpenAPI change**) and
mapped onto the entry's existing `languageCode` field
(`server/src/workspace/voice-library.ts:66`, already in the schema).

The two halves are coherent rather than contradictory: **manifest language = the
reference clip's** (governs the audition and the library label); **request
language = the book's** (governs book synth, and for a clone overrides the
manifest).

## Architectural impact

- **New seams:** one optional per-item `language` string on `/synthesize-batch`;
  `cloned?: boolean` on two internal TS interfaces (`tts/index.ts` `SynthesizeInput`
  and `SynthesizeBatchInput`'s item shape); `language?: string` on
  `DeriveArtifactInput`. No new endpoint, no OpenAPI change, no migration.
- **Invariants preserved:** the cloned-voice exemption
  (`verify-designed-voice-language.ts:55`) is untouched — this plan supplies the
  language it presupposes. Coqui's path is untouched. Designed-voice behaviour is
  byte-identical (Node simply stops sending a field Qwen already ignores).
- **Migration story:** none for synth. Existing clone manifests keep saying
  `"English"` and will keep being *displayed* as English until re-cloned or
  re-derived — called out in the release note rather than migrated, because
  recovering a distilled `.pt`'s language would mean re-transcribing the master.
- **Reversibility:** revert the PR. Every change is an additive optional field.

## Invariants to preserve

1. `clearMismatchedDesignedVoices` (`verify-designed-voice-language.ts:55`)
   exempts cloned voices via `hasClonedProvenance`. Do not remove or narrow it.
2. `sidecarLanguageName` (`server/src/tts/language.ts:34-44`) throws rather than
   defaulting to English. The new mapping must neither swallow that into an
   English default **nor** let it become fatal on a path that works today
   (see invariant 6).
3. `_load_voice_prompt` (`main.py:5495`) keeps returning
   `(prompt, language, cache_hit)` and `_prompt_cache` keeps its
   `dict[str, tuple[Any, str]]` shape (`main.py:4123`). The manifest language
   stays the **fallback**; the override is applied at the four synth call sites,
   not by adding a second cache-facing language source.
4. `/qwen/evict-voice` is idempotent (`main.py:8769, 8784`) — the resolver may
   call it unconditionally after a manifest restore.
5. Coqui keeps receiving a BCP-47 code for **every** voice, cloned or not
   (`sidecar.ts:156`, `main.py:2007`).
6. `voice-sample.ts:260-265` passes a client-supplied, unvalidated language and
   no `cloned` flag. It must remain incapable of reaching `sidecarLanguageName`,
   so the regression is closed structurally rather than by a `catch`.
7. `clone-voice-resolver.ts` takes **no runtime imports** for sidecar access —
   its header (`:11-15`) states every interaction goes through injected `deps`.
   The evict must arrive as `deps.evictSidecarVoice`, not a direct `fetch`.

## Implementation

### Node

| # | File | Change |
|---|---|---|
| a | `tts/index.ts` (`SynthesizeInput`) | add `cloned?: boolean` |
| b | `tts/index.ts` (`SynthesizeBatchInput` item) | add `cloned?: boolean` alongside `instruct`/`emotion` |
| c | `synthesise-chapter.ts:2313-2318` (single) and `:2367-2380` (batch items map) | set `cloned: hasClonedProvenance(char, 'qwen')`. `clone-engines.ts` is a leaf module already imported by `verify-designed-voice-language.ts:19` — no cycle |
| d | `sidecar.ts:155-163` | replace the `wireLanguage` ternary with `resolveWireLanguage(engine, language, cloned)` |
| e | `sidecar.ts:275-282` | add `...(itemLang != null ? { language: itemLang } : {})` per item |

```ts
function resolveWireLanguage(engine, language, cloned) {
  if (language == null) return undefined;
  if (engine === 'coqui') return coquiLanguageCode(language);   // unchanged
  if (engine !== 'qwen' || !cloned) return undefined;           // designed qwen + others: omit
  try { return sidecarLanguageName(language); }
  catch (e) {
    console.warn(`[tts] no sidecar language word for "${language}" — falling back to the voice's manifest language`, e);
    return undefined;
  }
}
```

Omitting the field is **not** an English default — it falls through to the
manifest language, i.e. byte-identical to today. The fail-loud guarantee for a
*book render* stays where it already is: `generation.ts:819-824` calls
`sidecarLanguageName(bookLanguage)` and returns `chapter_failed` before any synth,
with `chapter-splice.ts:261` and `chapter-qa-repair.ts:338` doing the same.

### Sidecar

| # | File | Change |
|---|---|---|
| f | `main.py:9385-9400` (batch route item validation) | accept an optional per-item `language`; 400 if present and not a string. No route-level field, no `synthesize_batch` signature change |
| g | `main.py:5903-5907` (0.6B loop) | `langs.append(item.get("language") or lang)` |
| h | `main.py:5861-5866` (1.7B loop) | identical |
| i | `main.py:5767` (single 0.6B), `:5745` (single 1.7B) | `lang = language or lang` after the `_load_voice_prompt*` call |

`langs` already flows into `_icl_instruct_synth_batch` (`:5885-5887`) and
`generate_voice_clone` (`:5889-5891`, `:5931-5933`), so nothing downstream changes.

### Evict + clip language

| # | File | Change |
|---|---|---|
| j | `workspace/purge-clone-artifacts.ts:187` | export the module-private `evictSidecarVoice` |
| k | `clone-voice-resolver.ts` (deps iface near `:696`) | add `evictSidecarVoice(uuid)`; call it after `writeSidecarManifest` at `:1007`; wire the real one in `buildDefaultCloneResolverDeps` |
| l | `clone-ingest.ts:48-53` | retain `TranscribeResult.language` on the candidate |
| m | `routes/voice-library.ts` (`/clone`, entry construction ~`:1050`) | set `languageCode` from the detected language when the registry knows it; pass the sidecar word to `deriveEngineArtifact` |
| n | `derive-engine-artifact.ts` | `language?: string` on `DeriveArtifactInput`; send `X-Language` when present (both engine branches — the sidecar reads it at `main.py:8578` qwen, `:8868` xtts) |

### Docs to correct in the same diff

`routes/qwen-voice.ts:452-455` states *"every later /synthesize of this voice
speaks the right language (**synth itself carries no language**)"* — that shipped
contract is being changed and the comment must change with it.

## Test plan

### Automated coverage

- **Pytest sidecar, `/synthesize-batch` — the PRIMARY regression test.** A batch
  containing two items: one with `language: "German"` and one without, against
  voices whose manifests both say `"English"`. Assert `generate_voice_clone`
  receives `language=["German", "English"]` — i.e. the override applies per item
  and the omitted item keeps its manifest language. **Must fail pre-fix**, where
  the field is neither transmitted nor read. Covers 0.6B and 1.7B loops.
- Pytest sidecar, single `/synthesize` — the same override on the non-batch path.
- Vitest server (`sidecar.test.ts`) — three cases: a **cloned** qwen item sends
  the sidecar word; a **designed** qwen item sends **no** `language`; the batch
  body carries the field per item. Plus a `voice-sample`-shaped call (language
  supplied, no `cloned`) proving `sidecarLanguageName` is never reached.
- Vitest server (`sidecar.test.ts:265-275`) — **an existing test is rewritten,
  not incidentally broken.** *"does NOT leak zh-cn onto a non-Coqui engine — Qwen
  sees plain zh unchanged"* asserts `body.language === 'zh'`. Under the new
  contract a designed Qwen voice sends no language at all. It becomes *"Qwen gets
  no language for a designed voice, and the sidecar word for a cloned one"* — a
  statement of the new contract. The fs-59 W4b invariant it protects (never leak
  `zh-cn` off Coqui) is preserved and must still be asserted.
- Vitest server (`clone-voice-resolver.test.ts`) — the designed self-heal path
  calls `deps.evictSidecarVoice` **after** `writeSidecarManifest`. Must fail pre-fix.
- Vitest server (`clone-ingest.test.ts`, `voice-library.test.ts`) — the detected
  language is retained and lands on `languageCode`; an unsupported detected
  language leaves it unset without failing the clone.
- Vitest server (`derive-engine-artifact.test.ts`) — `X-Language` sent when
  `input.language` is set, omitted when not, both engine branches.
- Pytest sidecar (`test_qwen3.py`) — the shared
  `_FakeQwenModel.create_voice_clone_prompt` fake returns a **list**, matching the
  real API, instead of a dict. This is why a placebo test was possible in #1942.

**Every new test must be shown to fail before the fix.** Given the batch trap
above, a passing test proves nothing on its own here.

No e2e spec: no UI surface changes.

### On-box acceptance

The acceptance criterion is **outcome-level, not mechanism-level** — the measured
form above, not "`language=[…]` reached the model":

1. Render a non-English chapter with a cloned voice. Transcribe the output with
   Whisper auto-detect. **Pass = detected language is the book's and
   `avg_logprob` is better than ≈ −0.5.** Pre-fix this yields `en` / ≈ −1.3.
2. Render with a designed self-healed voice, restart the sidecar, render again —
   audibly identical. Direct test for the divergence.
3. **C-17** (designed-voice self-heal preserves persona) is already owed on
   register row A1 and lives in this exact path — run it in the same session.

Folding these into A1 changes its "16 of 60" heading and the glance-table total
(`onbox-acceptance-register.md:86, 97`); `npm run check:onbox-register` verifies
that arithmetic, and the live HTML twin moves in the same PR.

### Manual acceptance walkthrough

Real sidecar, real weights — not mock mode.

1. Clone a voice, assign it to a character in a non-English book, generate a chapter.
2. Listen → the book's language, intelligible. Confirm
   `characterSnapshots.<id>.resolvedVoiceName` is the clone's storage key (no substitution).
3. Restart the sidecar, re-render → audibly identical.

## Folded in / also delivered

Three items this plan originally listed as out of scope ship in the SAME PR, at
the repo owner's direction. They are recorded here rather than struck out so the
plan stays readable as the design of record for what actually landed.

- **Designed voices whose language disagrees with the book** —
  [#1953](https://github.com/dudarenok-maker/Castwright/issues/1953), an
  assign-time warning. Deliberately a warning on a 200, not a 409: the guard at
  `voice-library.ts:1260` is scoped to cloned voices precisely because a hard
  failure for designed voices would be a regression. Covers English books, which
  the render-time gate skips entirely.
- **`import.ts:320` could persist an unregistered language code**
  (`normaliseBookLanguage` only lower-cases the primary subtag; no
  `isSupportedLanguage` check) — [#1955](https://github.com/dudarenok-maker/Castwright/issues/1955).
  Now rejected at the import boundary, before any disk write, instead of failing
  at render time as an opaque `chapter_failed`. The `generation.ts` throw is
  untouched: it remains the backstop for the splice and QA-repair paths.
- **`qwen-voice.ts:312` minted variants of a clone against the wrong identity**
  (`baseVoiceId = qwenStorageKey(...)` cannot produce `qwen-<libraryUuid>`) —
  [#1954](https://github.com/dudarenok-maker/Castwright/issues/1954). Same
  `qwenStorageKey`-vs-`libraryUuid` class as the bug
  `verify-designed-voice-language.ts:45-47` was written to fix. Resolved by
  **refusing** rather than re-anchoring: correct anchoring would mint derived
  artifacts of a real person's voice that consent revocation cannot erase
  (`purgeCloneArtifacts` anchors on a `.` boundary, so `qwen-<uuid>__angry.pt`
  matches neither its fixed path list nor its orphan sweep). Verified latent —
  zero such artifacts exist today — and kept that way.

Plus two seams the PR review found still passing no language, folded in for the
same reason: a fix that reaches only the render path leaves the other places
that synthesise the same voice disagreeing with it.

- **The speaker-drift reference** (`audio/render-integrity/audition-centroid.ts`,
  fed by `aggregate.ts`). `auditionCentroid` builds the centroid every chapter
  segment is compared against; rendering it in English against a German chapter
  would be a *new* source of false `voice-mismatch` flags on precisely the
  cloned voices this plan fixes. It now carries the same `language` + `cloned`
  pair as the render, for the same comparability reason `modelKey` is already
  threaded through it. The language comes from the book's `state.json` and the
  provenance from `cast.json` (`hasClonedProvenance`, against the character's
  own rendering engine). An unreadable `state.json` passes NO language rather
  than guessing English.
- **`POST /api/voices/:voiceId/sample`** now marks a cloned voice as cloned, so
  a supplied `language` reaches the Qwen mapping instead of the clone's English
  manifest. Cloned-ness is read from the library ENTRY, never the
  client-supplied `provenance` — a designed voice resolves to the identical
  `qwen-<uuid>` key shape. That makes `sidecarLanguageName` reachable from a
  route carrying an unvalidated, client-supplied language, so the route is now
  protected only by `resolveWireLanguage`'s try/catch rather than structurally;
  `routes/voice-sample-cloned-language.test.ts` drives the real provider through
  the real route to pin it (removing the catch turns a working Play-sample click
  into a 502).

## Out of scope

- **Backfilling existing clone manifests.** See "Migration story".
- **Threading the BOOK's language into `POST /api/voices/:voiceId/sample`.**
  The route now flags cloned voices (so a supplied `language` reaches the Qwen
  mapping), but no frontend caller sends one — `realGetVoiceSample` omits the
  field, and `VoiceSampleArgs` has no slot for it. Making the cast-row Play
  button audition in the book's language is a frontend change across every
  `playSampleWithAutoLoad` call site, and needs a decision for the surfaces with
  no book in scope. Not done here; see the review note on M4 seam 1.

## Ship notes

(To be filled when status flips to `stable`.)

**Not yet `stable`** — the code shipped in **PR #1964** (merge `b5479e9c`,
2026-07-30), but register row **A24** is only partly discharged.

### On-box acceptance, run 2026-07-31 (SHA `b5479e9c`, clean tree)

**§"On-box acceptance" step 1 — PARTIAL (corrected 2026-07-31).** The chapter-level half is **withdrawn**: that render went through a splice re-record and hit [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972), so most of the audio measured was the *narrator*, not the clone (0.949 against the chapter's own narrator). The direct-`/synthesize` evidence below is unaffected and does prove the fix. Re-run the chapter-level criterion after #1972 lands, or via a full chapter generation, which the defect does not touch. Original (now-qualified) text follows. German Coalfall ch.2, cloned voice
`563501c7-…` cast onto `oduvan`, re-recorded via splice so the render went over
the **`/synthesize-batch`** wire — the transport the original fix would have
missed. 12 spans (27.2 s) through `/transcribe` with **no `x-language`**:

| Audio | detected | `avg_logprob` |
|---|---|---|
| Cloned `oduvan` | **`de`** | **−0.233** |
| Designed `narrator` control, same chapter | `de` | −0.352 |
| Pre-fix baseline (2026-07-30) | `en` | −1.303 |

`characterSnapshots.oduvan.resolvedVoiceName` stayed `qwen-563501c7-…` — **not
corroborating evidence**: this is exactly the field [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972)
showed was re-derived from the cast record rather than recorded from the
render, so it reports the assigned voice regardless of what actually rendered.
Kept here only as a record of what the field said at the time; the retraction
above is what actually holds.

Corroborated on the single-synth wire, with an identity control the criterion
did not ask for but which matters — the fix changes *what language the model is
told to speak*, so it is worth knowing whether the cloned timbre survives it:

| Call | detected | `avg_logprob` | cos vs source clip |
|---|---|---|---|
| English text + `language: English` | `en` | −0.258 | 0.865 |
| German text + `language: German` | **`de`** | −0.699 | **0.809** |
| German text, language omitted (pre-fix) | `en` | −0.904 | 0.876 |

Row 3 reproduces the shipped bug live: German input, English phonetics,
transcript garbage. Identity holds at 0.809 against a ~0.03 different-speaker
floor. **The same claim also holds on Coqui** — run 2's E-01 rendered the
Russian Coalfall with this clone and measured `ru` at −0.368.

**Step 2 — NOT RUN.** The designed-self-heal → restart → re-render comparison
is still owed.

**Step 3 / C-17 — NOT RUN.**

**The §"On-box acceptance" QA sub-check FAILED, and this plan's stated cause was
wrong.** The register row predicted a `voice-mismatch` flood from an English
audition reference scored against a German chapter. That cannot happen:
`auditionCentroid` does carry the book's language (`audition-centroid.ts:50-57`,
this plan's own change). The actual cause is unrelated to language — a persisted
`audition` centroid is reused unconditionally after a character's voice is
reassigned, so the clone was scored against the *previous* voice's reference
(`{cleanMean 0.8388, pSevere 0.7852}` → clone at 0.750 → `severity: severe`).
Filed as [#1969](https://github.com/dudarenok-maker/Castwright/issues/1969).
Correct the register text when that lands.
