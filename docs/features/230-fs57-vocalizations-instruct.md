---
status: active
shipped: null
owner: null
---

# fs-57 — Non-verbal vocalizations + live context-aware instruct

> Status: active
> Key files: `server/src/handoff/schemas.ts`, `openapi.yaml`, `src/lib/api-types.ts`,
> `server/src/tts/synthesise-chapter.ts`, `server/src/tts/sidecar.ts`,
> `server/src/analyzer/gemini.ts`, `server/src/analyzer/ollama.ts`,
> `server/tts-sidecar/main.py`, `server/tts-sidecar/engines/qwen_engine.py`,
> `src/store/manuscript-slice.ts` (new `applyDetectedInstruct` reducer),
> `src/components/detect-emotions-button.tsx`,
> `server/src/tts/segment-asr-qa.ts`
> URL surface: `#/books/<id>/manuscript` (Detect-emotions button triggers Stage 3); `#/books/<id>/generate` (liveInstruct toggle)
> OpenAPI ops: `POST /api/books/{bookId}/instruct-annotation` (Stage 3 SSE), `GET /api/manuscripts/{id}/analysis`

## Benefit / Rationale

- **User:** narrated gasps, sighs, and laughter ("Ah!", "Haah…", "Haha!") are written into the manuscript text and delivered expressively by the Qwen 1.7B Base via a live per-line instruct — no bracket-tag hacks, no per-language vocab tables.
- **Technical:** makes the `instruct` field the canonical live-delivery channel on the 1.7B tier; the Stage 3 analysis pass emits native-language vocalization text + English instruct in a strict non-re-attributing envelope, parallel to the fs-33 emotion pass.
- **Architectural:** additive at the data/schema layer — a pre-fs-57 analysis validates and loads unchanged, and the 0.6B/Kokoro/Coqui audio paths are byte-identical to pre-fs-57. The 1.7B audio path changes by design when a book opts in via the per-book `liveInstruct` flag (default off), which is the accepted, operator-known consequence of moving from anchored-variant delivery to unified live-instruct.

## Architectural impact

**New seams / extension points:**
- `instruct?: string` and `vocalization?: boolean` optional fields on `Sentence` (schema + OpenAPI + api-types; additive — absent still parses).
- `liveInstruct` per-book boolean flag in book-meta (default off); gating the 1.7B raw-`generate` bypass vs the existing `generate_voice_clone` wrapper.
- `NEUTRAL_INSTRUCT = ""` sidecar constant pinned as the canonical no-op form for neutral 1.7B items (C2 gate — verified on-box before trusting neutral-parity language).
- Batch-level `liveInstruct` flag in the sidecar request body (`POST /synthesize-batch`); per-item optional `instruct` field.
- `resolveInstructForGroup` — pure helper (`synthesise-chapter.ts`) that applies the precedence ladder (manual edit › analyzer `instruct` › emotion-derived English phrase › neutral).
- `applyDetectedInstruct` reducer in `manuscript-slice` — fill-only instruct, marks sentence dirty on `text` edit.
- `POST /api/books/{bookId}/instruct-annotation` — own SSE endpoint + error type, distinct from the emotion contract.
- `skills/audiobook-instruct-annotation.md` + `prompt.instructAnnotation` registry knob (user-forkable).
- `vocalizationAllowlist` + `leadingVocalizationTokens(text)` in `segment-asr-qa.ts` — targeted carve-out for vocalization-prepended lines on the ASR gate.

**Invariants preserved:**
- `sentenceSchema` `.strict()` — any unknown key in a stored analysis still fails validation; the absent-still-parses test locks this.
- 0.6B Fast tier, Kokoro, and Coqui audio paths are byte-identical to pre-fs-57 (no code-path change for those engines).
- `liveInstruct=false` 1.7B books stay on `generate_voice_clone` + anchored variants — they are NOT silently restyled.
- Stage 3 is non-re-attributing: the envelope `{ sentenceId, text?, instruct?, vocalization? }` carries no `characterId` field; it never changes who speaks a line.
- Idempotency: a second Stage 3 trigger skips any sentence already `vocalization:true` — no double-prepend.

**Migration story:**
- Data layer: `instruct` and `vocalization` are optional — old analyses load and validate unchanged. No migration script required.
- 1.7B audio: opt-in only. Existing 1.7B books keep `generate_voice_clone` + anchored variants until the operator sets `liveInstruct=true` and re-renders. The per-book flag is the migration handle.

**Reversibility:** set `liveInstruct=false` to revert 1.7B renders to the pre-fs-57 variant path. Remove `vocalization:true` sentences via the script-review / manuscript editor to undo Stage 3 insertions. The `vocalization` flag makes every insertion auditable.

## Invariants to preserve

1. `sentenceSchema` in `server/src/handoff/schemas.ts` is `.strict()` — `instruct` and `vocalization` MUST be declared there; an absent key on an old analysis still passes (the absent-still-parses test locks this invariant at both sites).
2. 0.6B / Kokoro / Coqui synth code paths in `server/src/tts/synthesise-chapter.ts` are unchanged — their `SentenceGroup` carry of `instruct` is a no-op (passed but not forwarded to those engines).
3. The 1.7B batched path MUST select the path at **batch level** (one `generate` forward cannot mix `generate_voice_clone` wrapper and raw bypass). The `liveInstruct` flag, not per-item instruct presence, decides the path.
4. `NEUTRAL_INSTRUCT = ""` is sidecar-owned; the TS server sends an empty string for neutral items, not a sentinel.
5. Stage 3 never splits or inserts a new sentence — edit-in-place only for v1. `splitSentence` / `mergeSentences` carry `instruct`/`vocalization` via `{...original}` spread (pre-existing behaviour; see owed items below).
6. Stage 3 apply revalidates `sentenceId` targets against the live manuscript (fs-58 index-map / staleness check); a stale ID drops the annotation rather than mis-applying it.
7. The precedence ladder is synth-side: `resolveInstructForGroup` in `synthesise-chapter.ts` applies `manual edit › analyzer instruct › emotion-derived English phrase › neutral`; the stored `instruct` field holds only genuine analyzer/manual instructs, not emotion-derived phrases.
8. Script Review MUST NOT strip a vocalization sentence or drop its `instruct` — the `skills/audiobook-script-review.md` guard `NEVER strip intentional non-verbal vocalizations` is the enforcement point (Task 18 regression test locks it).
9. ASR carve-out is dominance-gated, not blanket: when `vocalization===true` AND the non-vocalization remainder of `text` would be below the `minChars` floor, relax to `inconclusive`; otherwise score the full text. The `leadingVocalizationTokens` helper extracts only the leading gasp token(s) for the allowlist — the lexical words remain fully scored.

## Test plan

### Automated coverage

**Schema (Task 1 + Task 2)**
- Vitest server (`server/src/handoff/schemas.test.ts`) — `instruct?: string` and `vocalization?: boolean` absent-still-parse on a pre-fs-57 fixture; present fields round-trip; unknown keys are rejected (`.strict()` assertion).
- `npm run typecheck` — `instruct` and `vocalization` are present in generated `src/lib/api-types.ts`.

**Emotion-to-instruct map (Task 3)**
- Vitest server (`server/src/tts/emotion-instruct.test.ts`) — every supported `emotion` enum value maps to an English phrase; the map is a pure function (no sidecar dependency).

**Book-meta + liveInstruct flag (Task 4)**
- Vitest frontend/server — `liveInstruct` field round-trips through book-meta save/load; absent on an old book → `false`.

**Sidecar C2 gate — NEUTRAL_INSTRUCT (Task 5)**
- Pytest sidecar (`server/tts-sidecar/tests/test_instruct_path.py`) — establishes on-box what an empty per-item instruct actually produces and pins the neutral form; asserts that neutral items render without errors on the batched ICL+instruct path.

**Sidecar batch ICL+instruct path (Task 6)**
- Pytest sidecar (`server/tts-sidecar/tests/test_instruct_batch.py`) — asserts the batched path gives per-item delivery with identity intact (ECAPA cosine within tolerance); heterogeneous instruct-length items pack correctly; `instruct_ids` + `voice_clone_prompt` signature drift-guard (fails loudly if `qwen-tts` API changes).

**Instruct length cap (Task 6)**
- Pytest sidecar — pathological instruct length is clamped/rejected before hitting the tokenizer.

**Server threading + `resolveInstructForGroup` (Task 8)**
- Vitest server (`server/src/tts/resolve-instruct.test.ts`) — pure unit test of `resolveInstructForGroup`: manual edit wins, analyzer `instruct` wins over emotion-derived phrase, emotion-derived phrase wins over neutral; `liveInstruct=false` always returns neutral regardless of `instruct` presence.

**Batch-budget accounting (Task 8a)**
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — instruct tokens count against `qwenBatchTokenBudget` on the liveInstruct path; a heterogeneous-instruct-length batch packs within budget.

**Flag-off code-path regression / C1 (Task 9A)**
- Vitest server / pytest sidecar — with `liveInstruct=false` (flag-off), the 1.7B path routes through `generate_voice_clone` wrapper; `instruct_ids` are NOT passed to `generate`; byte-identical to pre-fs-57 for flag-off books. (Primary guarantee is a code-path assertion, not an audio golden.)

**Stage 3 skill + pass (Task 10 + 11)**
- Vitest server (`server/src/analyzer/instruct-annotation.test.ts`) — given a manuscript line with an explicit reaction, `runStage3Chapter` emits a native-language vocalization in `text` + an English `instruct` + `vocalization:true`, strict envelope (no `characterId`).

**Stage 3 negative fixtures (Task 12)**
- Vitest server — an unsignalled line emits nothing; a stale `sentenceId` (post-merge/split) drops rather than mis-applying the annotation.

**Stage 3 language clause (Task 15)**
- Vitest server — `languagePreamble` for `es`/`ru`/`fr`/`de` carries the Stage-3 clause (vocalization text in book language, `instruct` in English).

**`applyDetectedInstruct` reducer (Task 13)**
- Vitest frontend (`src/store/manuscript-slice.test.ts`) — fill-only: a hand-set `instruct` wins; the reducer applies `text` edits via `setSentenceText` and marks the sentence dirty for re-gen; `vocalization:true` sentences are skipped on a second Stage-3 apply.

**Stage 3 endpoint + SSE (Task 11)**
- Vitest server — `POST /api/books/{bookId}/instruct-annotation` fires the Stage-3 pass, streams SSE events matching the schema, returns the correct error type on failure.

**DetectEmotionsButton wiring (Task 16)**
- Vitest frontend (`src/components/detect-emotions-button.test.tsx`) — button fires both emotion pass and Stage-3 pass; progress copy covers the text-mutating / audio-invalidating work.

**liveInstruct toggle (Task 16)**
- Vitest frontend — `liveInstruct` toggle in the Generate view persists the per-book flag; absent on non-1.7B cast shows the mitigation copy.

**ASR tolerance (Task 17)**
- Vitest server (`server/src/tts/segment-asr-qa.test.ts`) — a `vocalization:true` sentence whose vocalization token is the sole content → `inconclusive`; a `vocalization:true` sentence with a substantial lexical remainder → ASR still scores the words; `leadingVocalizationTokens` extracts the correct token(s).

**Script-Review locks (Task 18)**
- Vitest server — a sentence with a vocalization `text` + `instruct` survives a Script Review pass unchanged (text not stripped, `instruct` not dropped).
- Vitest frontend (`src/lib/script-review-apply.test.ts`) — a `strip_tag` apply through `dispatchAcceptedOps`/`setSentenceText` preserves `instruct` + `vocalization` on the rewritten sentence (P-Mo2 regression lock).

**e2e (Task 16)**
- Playwright (`e2e/instruct-annotation.spec.ts`) — the Detect-emotions button triggers Stage 3 alongside the emotion pass; the analysis form reflects the Stage-3 result (a vocalization sentence is visible with its instruct in the manuscript view). Mock mode.

### Manual acceptance walkthrough

Run with `npm start` (full stack) against a real GPU, using `server/src/__fixtures__/the-coalfall-commission.md` as the canonical test manuscript. Spanish and Russian canaries: `samples/the-coalfall-commission/manuscript.{es,ru}.md`.

1. **Import** the Coalfall manuscript → `#/books/<id>/manuscript` (`stage: { kind: 'ready', view: 'manuscript' }`).
2. **Analyze** the book (Stage 1 + Stage 2). Wait for the analysis to complete (SSE `{ kind: 'result' }` final event).
3. **Click "Detect emotions"** — this now fires BOTH the emotion pass (Stage 2 backfill) AND Stage 3 (instruct + vocalization). Wait for both SSE streams to complete.
   - Expected: at least one sentence in a chapter with an explicit non-verbal reaction (e.g. a gasp or sigh) shows `vocalization:true` in the manuscript view; its `text` contains a pronounceable vocalization; its `instruct` is an English delivery direction.
   - Expected: the confirm copy on the button mentions both emotion tagging and vocalization insertion.
4. **Verify idempotency:** click "Detect emotions" a second time. The vocalization sentences must NOT be re-edited (`"Ah!"` does not become `"Ah! Ah!"`).
5. **Navigate to Generate** (`#/books/<id>/generate`). Confirm the cast has at least one 1.7B-engine character.
6. **Toggle "Live expressive delivery (1.7B)"** on (`liveInstruct=true`). Confirm the toggle persists on a page reload.
7. **Render a chapter** that contains a vocalization sentence. Monitor the generation SSE for segment events.
   - Expected on a 1.7B-engine character: the sidecar receives `liveInstruct=true` + the per-item `instruct` string in the synthesize-batch body.
   - Expected: the chapter completes and the audio includes an audible gasp/sigh/laugh at the marked sentence.
8. **Confirm identity is intact:** ECAPA cosine between the vocalized sentence and a neutral sentence from the same character is within tolerance (use the `/embed` endpoint or the generation waveform's drift indicator).
9. **Spanish canary:** import `samples/the-coalfall-commission/manuscript.es.md`, run Stage 3, confirm vocalization `text` is in Spanish, `instruct` is in English.
10. **Russian canary:** same for `manuscript.ru.md`, confirm `text` is in Russian, `instruct` is in English.
11. **Flag-off regression:** toggle `liveInstruct` off, re-render the same chapter. Confirm the audio path uses `generate_voice_clone` + anchored variants (check sidecar request log; no `instruct_ids` in the raw-`generate` call). 0.6B and Kokoro characters must produce byte-identical audio to a pre-fs-57 render.
12. **Script Review guard:** run Script Review on the chapter containing a vocalization sentence. Confirm the vocalization `text` and `instruct` are unchanged after the review pass.

## Out of scope

- Instruct on Kokoro / Coqui / Gemini or on the 0.6B Fast tier — 0.6B keeps anchored-variant delivery; vocalization `text` still renders (flat read, no sigh delivery).
- Single `/synthesize` (voice previews / auditions / samples) — stays neutral; live-instruct is batch-only for v1.
- Per-emotion intensity tuning of live instruct (deferred to operator calibration).
- A `validate_instruct` Script-Review operation class (defer to an fs-58 follow-up).
- Deleting the 1.7B anchored-variant path — dual path kept for migration safety; cleanup is a tracked future item (§6 of the spec).
- Per-character `liveInstruct` toggle — v1 is per-book.
- fr/de vocalization text on-box canary — rides along because `instruct` is English regardless; es/ru validated on their Coalfall canaries.

## Owed / follow-ups

**9B (deferred, opt-in, non-gating):** the GPU golden-audio instruct fixture — ECAPA identity stability across instructs + an audible delivery change, committed to `test:golden-audio` tier. Also: a committed batched-RTF baseline (heterogeneous-instruct-length batch) that replaces the unverified parent-spec RTF 0.67. The fs-55 sidecar golden (`test_golden_regression.py`) should be scoped to 0.6B so it does not overlap the new 1.7B instruct fixture. These are NOT in `verify`.

**Split/merge field propagation:** `splitSentence` / `mergeSentences` carry `instruct` and `vocalization` via `{...original}` spread. A split fragment can inherit `vocalization:true`; a merge drops merged-away members' values. This is pre-existing spread behaviour; decide in a follow-up whether to nullify these fields on split/merge or file as an fs-58/fs-57 interaction issue.

**P-Mi4 — double-prepend on a manually-typed vocalization:** an operator who hand-types a gasp without setting `vocalization:true` leaves `vocalization:undefined`, so a Stage-3 re-run could prepend a second vocalization. Documented as an accepted v1 edge; a fix would check the sentence `text` for a known vocalization pattern before prepending.

**Toggle grey-out:** the `liveInstruct` toggle is visible for all engines (includes a mitigation-copy note for non-1.7B). A follow-up should grey it out entirely when no 1.7B cast member is present in the current book.

## Ship notes

_Pending merge + on-box GPU acceptance (Tasks 5, 6, 9B)._

Spec (source of truth): `docs/superpowers/specs/2026-06-24-fs57-nonverbal-vocalizations-instruct-design.md`
