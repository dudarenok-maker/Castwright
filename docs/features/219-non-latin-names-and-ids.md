---
status: active
shipped: null
owner: null
---

# 219 — Non-Latin (Cyrillic) character names, ids & cross-book keys

> Status: active (implemented on `fix/server-stage2-coverage-unicode`; on-box acceptance owed)
> Key files: `server/src/analyzer/roster-coverage.ts` (`toKebabId`), `server/src/routes/analysis.ts` (`bookIdFromTitle`, ingest), `server/src/store/merge-analysis-cast.ts`, `server/src/workspace/series-prior-dedup.ts`, `server/src/routes/cast-series-patch.ts`, `server/src/routes/voice-override-linked.ts`, `server/tts-sidecar/main.py` (`_voice_paths`), `scripts/recover-missing-character.mjs`, frontend cast-edit paths (TBD — see Phase 0)
> URL surface: indirect — analysis pipeline + cast/voice persistence
> OpenAPI ops: none (internal id/key generation)

## Context

A 9-chapter **Russian** book surfaced a family of latent bugs: text-processing
code across the stack assumes **Latin/ASCII script**. The acute one (analysis
stalling on a false "coverage" verdict) and its generation-side twin (the ASR
WER gate) were fixed in `fix(server): make attribution + ASR word-normalizers
script-aware` (branch `fix/server-stage2-coverage-unicode`, commit `3a56bf74`;
plan [181](archive/181-stage2-coverage-guard.md) follow-up). This plan covers
the **remaining, systemic half**: anywhere a character **id / slug** or a
**cross-book name-match key** is derived from a display name with an ASCII-only
rule, a Cyrillic name collapses to an empty or colliding token.

These were split out because — unlike the two word-normalizer one-liners — they
touch **persisted ids and on-disk filenames**, so they need a deliberate
canonicalization scheme, an idempotency guarantee, and a migration story.

### Load-bearing unknown (drives everything below)

Character `id`/`name`/`color` are **model-returned** strings
(`handoff/schemas.ts:32`, `id: z.string().min(1)`). For **English** the model
already emits clean kebab-ASCII ids — observed in the handoff inbox:
`master-oduvan`, `wren`, `tam-hollis`, `coalfall-dragon`. **What it emits for
Cyrillic names is unobserved.** The correct scope of this plan depends entirely
on that, so **Phase 0 is an empirical probe** and the design *branches* on its
result. Do not implement past Phase 0 without the probe data.

### What actually breaks (evidence)

1. **Locally-minted slugs collapse to empty/colliding ids.**
   - `roster-coverage.ts:226` mints a recovered speaker's id via
     `toKebabId(c.name)` (`:134`, `…toLowerCase().replace(/[^a-z0-9]+/g, '-')…`)
     → "Анна" → `""`; two distinct Russian names → same empty id → collision.
   - `routes/analysis.ts:706` `bookIdFromTitle` — same strip, `|| 'book'`
     fallback. **But** it is only a fallback: `record.bookId ?? bookIdFromTitle()`
     (`:3679`, `:4612`). Confirm in Phase 0 whether `record.bookId` (the `mns_…`
     id) is effectively always set — if so this is low-priority.
   - `scripts/recover-missing-character.mjs` `toKebabId` — same rule, same break.

2. **Model-returned character ids are never canonicalized** (`schemas.ts:32`).
   Whether this is a real defect is a **Phase 0 question** — see the decision
   gate. A Cyrillic id is a valid JSON key/value but becomes a filename at
   voice-design time (next item).

3. **Sidecar voice-embedding filenames merge under ASCII sanitization.**
   `server/tts-sidecar/main.py:1298` `_voice_paths` —
   `re.sub(r"[^A-Za-z0-9_.-]", "_", voice_id)` → a Cyrillic-derived `voice_id`
   becomes a run of `_`, so two Russian characters can overwrite each other's
   `.pt`/`.json`. The sanitizer is defensible; the defect is an
   un-canonicalized id reaching it. **Whether this fires depends on Phase 0**
   (only if a Cyrillic id reaches the sidecar).

4. **Cross-book name-match keys go dark (fail-safe, but non-functional).**
   `workspace/series-prior-dedup.ts:43`, `routes/cast-series-patch.ts:227`,
   `routes/voice-override-linked.ts:199` use
   `normaliseToken = s.toLowerCase().replace(/[^a-z0-9]/g, '')` then `if (n)`.
   For Cyrillic the token is `""` → dropped → **no** cross-book voice carryover
   / dedup for Russian casts. Fails safe (no *wrong* merges) but the feature is
   dead for them. This is script-independent of Phase 0 — it is always broken.

### What is already safe (verified — do NOT touch)

- `util/text-match.ts` — evidence/quote verifier + voice-matcher Jaccard:
  `normaliseForMatch` preserves Cyrillic; matching is `.includes()` + length-based
  tokens. Russian speakers' lines are **not** wrongly pruned.
- `tts/text-normalize.ts` `stripUnsafeForTts` — preserves Cyrillic; only strips
  zero-width/control/surrogate codepoints. Russian TTS input is intact.
- **Chapter audio slugs** (`NN-<title>`) — numeric-prefixed, so a Russian title
  yields `01-`, still unique. Chapter filenames are fine.
- Frontend search/sort/word-count, and Whisper ASR (auto-detects Russian).

## Phase 0 — Empirical probe (REQUIRED first; design gate)

Run the local analyzer (the engine the user hit this on — `qwen3.5:4b` via
Ollama) on a small fixture with **4–5 Cyrillic character names** (reuse /
extend `server/src/__fixtures__/the-coalfall-commission.ru.md`). Capture, from
the handoff inbox dump and `cast.json`:

- **Q1.** What shape are the model-returned `character.id`s? (Cyrillic kebab
  `мастер-одуван`? transliterated `master-oduvan`? inconsistent? collisions?)
- **Q2.** Are two distinct Cyrillic names given two distinct ids by the model?
- **Q3.** Does the model also emit `color`, and does it equal `id` or diverge?
- **Q4.** Is `record.bookId` set on this path (so `bookIdFromTitle` never fires)?
- **Q5.** Re-analyze the SAME book twice — are the model ids stable run-to-run?

**Decision gate (record the answers in this plan before coding):**

- If **Q1 = clean ASCII** (model transliterates): scope shrinks to items (1) +
  (4) only — fix the local slugifiers + the cross-book keys. Item (2)/(3)
  ingest-canonicalization and the sidecar change become **unnecessary**.
- If **Q1 = Cyrillic / inconsistent / colliding**: ingest-canonicalization
  (item 2) is required, and the sidecar (item 3) must accept the resulting id.
- **Q5 = unstable** strengthens the case for ingest-canonicalization (pin a
  deterministic id regardless of model jitter) and for cast-carryover pinning.

## Benefit / Rationale

- **User:** Russian (and other non-Latin) books stop silently mis-behaving —
  auto-recovered speakers get distinct ids, designed voices don't clobber each
  other on disk, and cross-book voice reuse works for a non-Latin series.
- **Technical:** one canonical, tested id chokepoint replaces three+ divergent
  ASCII slugifiers; ids become guaranteed-unique, **deterministic**, and
  filename-safe regardless of source script or model jitter.
- **Architectural:** establishes "**never trust an external (model or user)
  string to be a safe id — canonicalize deterministically at the persistence
  seam**" as an invariant.

## Architectural impact

### New seam — `server/src/util/safe-id.ts`

**Two helpers with deliberately different rules** (the id and the match key have
opposite requirements — see Invariants):

- `safeId(name, opts?: { taken?: Set<string>; prefix?: string }): string` —
  filename-safe, **non-empty, deterministic, collision-free** id.
  **Recommended scheme — Option C (Unicode-slug + hash fallback):**
  1. Unicode-normalize (NFKC) + lowercase.
  2. Kebab via `replace(/[^\p{L}\p{N}]+/gu, '-')` (trim) — **keeps Cyrillic
     letters**, so "Анна" → `анна` (human-readable, exact, no transliteration).
  3. **Fallback** when the slug is empty (e.g. a name that is only punctuation /
     an unrenderable script): `${prefix ?? 'char'}-${djb2(name)}` — always
     non-empty + stable.
  4. **Deterministic disambiguation** against `opts.taken`: do NOT use a
     run-order counter (`-2`/`-3` is order-dependent → unstable ids → orphaned
     voices, finding F5). On collision, suffix `-${djb2(name).toString(36)}`
     (a function of the *name*, stable across runs and roster orderings).
  - ASCII names MUST map byte-identically to the legacy `toKebabId` output
    (idempotency + zero English churn — see Invariants & tests).
  - **Transliteration (Cyrillic→Latin) is explicitly DEFERRED**, not adopted: it
    is lossy (can merge distinct names), ambiguous (ГОСТ/BGN/ISO-9), and a
    standing maintenance table. Option C needs none of it. (See Out of scope.)

- `normaliseNameKey(s): string` — the cross-book match key. **Unicode-exact, no
  transliteration**: `s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')`.
  "Анна" keys equal to "Анна" and to **nothing else** — transliterating here
  would risk false cross-book merges (the historical "narrator across unrelated
  series" bug class). Replaces the three copies of `normaliseToken`.

### Call-sites to route through the seam

- `roster-coverage.ts` `toKebabId` → delegate to `safeId`.
- `series-prior-dedup.ts`, `cast-series-patch.ts`, `voice-override-linked.ts`
  `normaliseToken` → shared `normaliseNameKey` (this is the always-broken item 4;
  ship it regardless of Phase 0).
- `scripts/recover-missing-character.mjs` `toKebabId` → mirror `safeId`.
- `analysis.ts` `bookIdFromTitle` → `safeBookId` (Unicode-slug + cap 32 + `book`
  fallback) — **only if Phase 0 Q4 shows the fallback actually fires.**
- `analysis.ts` / `merge-analysis-cast.ts` **ingest** (canonicalize model
  `character.id` + rewrite `sentence.characterId` in lockstep, + `color` if Q3
  shows it is reused as an id) — **only if Phase 0 Q1/Q5 shows model ids are
  unsafe/unstable.** If gated in, it MUST be idempotent (see Invariants).
- **Frontend cast-edit / add-character paths** — Phase 0 must locate any
  *client-side* id minting (manual "Add character", merge). If found, route it
  through a shared helper too, or have the server re-canonicalize on write.
- `tts-sidecar/main.py` `_voice_paths` — **conditional on Phase 0**: only needed
  if a non-ASCII id can reach it. If so, hash the full `voice_id` into the
  filename so a sanitized collision is impossible; otherwise leave as-is.

### Migration story / idempotency

- **Existing books are NOT re-keyed.** `safeId(asciiName)` is byte-identical to
  the old slug for ASCII input, so English books see **zero** id change.
- **Idempotency is a hard requirement, not an aspiration** (finding F4): if
  ingest-canonicalization is gated in, `safeId(modelId)` MUST be a no-op for the
  ids the model already produces for the *existing* corpus, AND re-analysis of
  any book MUST reproduce its current ids — otherwise designed voices and
  cast-carryover orphan. Phase 0 Q5 + the churn-guard test below verify this.
- No non-Latin book has shipped, so there is nothing to *migrate* — the change
  is forward-only by construction. State loudly: do **not** retro-rewrite ids of
  already-analyzed books.

### Reversibility

The helpers are pure and additive; for ASCII input there is no behavioural
change, so reverting cannot regress English books. Caveat (finding F10): once a
non-Latin book has been analyzed and voiced under the new ids, reverting would
re-mint the old broken ids and orphan those voices — clean reversal only holds
*before* a non-Latin book is processed (true today).

## Invariants to preserve

- `safeId(asciiName)` === current `toKebabId(asciiName)` for every ASCII-only
  name, and `safeId(safeId(x)) === safeId(x)` (idempotent). Pinned by test.
- `normaliseNameKey` is **Unicode-exact** — never transliterates; distinct
  Cyrillic names never share a key.
- `handoff/schemas.ts:32` keeps `id: z.string().min(1)` — canonicalization (if
  gated in) happens at *ingest*, not in the schema.
- Disambiguation is a function of the **name**, not roster order (deterministic).
- Chapter slug generation (`NN-<title>`) and `util/text-match.ts` /
  `tts/text-normalize.ts` stay untouched (verified safe).
- A character id is always non-empty, lowercased, `[\p{L}\p{N}-]+`, unique
  within its book's roster.

## Test plan

### Automated coverage

- Vitest server (`server/src/util/safe-id.test.ts`, new):
  - ASCII names byte-identical to legacy slug (no English churn);
  - idempotency: `safeId(safeId(x)) === safeId(x)`;
  - "Анна" → `анна`; two distinct Cyrillic names → two **distinct** ids;
  - punctuation-only / unrenderable name → non-empty `char-<hash>` fallback,
    **stable across calls**;
  - collision disambiguation is **deterministic** (same inputs in any roster
    order → same suffixes);
  - `normaliseNameKey("Анна") === normaliseNameKey("анна")`, bridges two books,
    and `normaliseNameKey("Анна") !== normaliseNameKey("Аня")` (no false merge).
- Vitest server — `roster-coverage` recovery: a Cyrillic missing-speaker gets a
  distinct non-empty id (regression for the empty-id collision).
- Vitest server — **churn guard**: re-running ingest over a representative
  English cast yields ids byte-identical to the pre-change output.
- Vitest server (gated by Phase 0) — `analysis.ts` ingest: a Cyrillic
  `character.id` is canonicalized and `sentence.characterId` rewritten in
  lockstep; idempotent on a second pass.
- Vitest server — `series-prior-dedup` / `voice-override-linked`: a Russian
  character carries its voice across two sibling books (was a no-op before).
- Vitest server (gated) — `safeBookId`: a long transliterated/Unicode title
  respects the 32-char cap without cutting mid-token into an empty id.
- Pytest sidecar (gated by Phase 0) — `_voice_paths`: two inputs that previously
  sanitized to the same string now map to distinct files.

### Manual acceptance walkthrough

1. **Phase 0 probe** — analyze the Russian fixture; paste the Q1–Q5 answers into
   this plan; pick the design branch.
2. Analyze a short Russian manuscript → no stall, cast shows distinct characters
   with sane ids (inspect `cast.json`).
3. Auto-recovery: a Russian speaker the roster guard recovers gets a distinct,
   non-empty id.
4. Design Qwen voices for two different Russian characters → two distinct
   `.pt`/`.json` files (no overwrite); both audition correctly.
5. Put the Russian book in a 2-book series → a designed voice carries over to the
   sibling book's matching character.

## Out of scope

- **Transliteration (Cyrillic→Latin) for ids** — deferred (lossy, ambiguous,
  maintenance burden); Option C needs none. Revisit only if human-readable ASCII
  ids are later required for portability.
- **Full UI internationalization / RTL.**
- **CJK word-segmentation** for the coverage/WER guards (they are Unicode-letter
  aware after plan 181 but still whitespace-tokenize); CJK names get the
  `char-<hash>` id fallback here, but proper CJK QA is a separate plan.
- **Language-specific dialogue-verb detection** (`analyzer/dialogue-verbs.ts` is
  English "said/asked" only) — detection *quality*, not ids.
- **Retroactive id migration** for already-analyzed books (none exist for
  non-Latin; forward-only by design).
- **`denormaliseAllCaps`** ASCII-only all-caps folding (minor TTS-quality nit).

## Implementation notes (2026-06-15, commit 23afa956)

Built on branch `fix/server-stage2-coverage-unicode` (stacked on the plan-181
word-normalizer fix). Two decisions diverged from the draft after the
adversarial review + an in-flight design question:

1. **Phase 0 probe substituted by defense-in-depth.** The live Ollama probe
   needed the analyzer running, so instead of branching scope on observed model
   output, `safeId` was made **idempotent + byte-identical for ASCII** (oracle
   tests vs the legacy slug), making canonicalization safe to apply regardless
   of what the model emits for Cyrillic. Owed: still worth observing real model
   ids on-box (Q1–Q5) to confirm no surprise.
2. **No ingest characterId rewrite.** The draft gated a global rewrite of
   model-returned `character.id` + `sentence.characterId`. That is the riskiest
   option (a missed reference → orphaned lines → silent narrator fallback), so it
   was **dropped** in favour of leaving the model's id as-is (a valid JSON key,
   Cyrillic or not) and hardening the FEW places an id becomes a **filename**.
3. **Id scheme = Option C (keep Unicode), per the user.** `unicodeKebab`
   preserves Cyrillic letters; filesystem boundaries that derive a name from an
   id are hardened to ASCII (sidecar `_voice_paths`, voice-sample `.mp3` cache —
   both back-compatible: ASCII ids unchanged, non-ASCII get a stable hash
   suffix).
4. **`makeBookId` was the real book-id bug** (worse than `bookIdFromTitle`): via
   `slug`, every Cyrillic book mapped to `untitled__standalones__untitled`.
   Fixed by routing `slug` through `unicodeKebab`.

### Follow-on — Stage-1 large-chapter chunking (2026-06-16)

On-box testing of the Russian book surfaced a *second*, distinct failure: **Stage-1
cast detection had no chunker** (only Stage-2 did, plan 187/#528), so every large
chapter overflowed Ollama's `num_ctx` — the input filled the window, leaving no
room for output → `done_reason:'length'` after ~0 bytes, every chapter dropped
from the roster. Cyrillic made it acute (denser tokenisation), but it is a
general large-chapter gap, not non-Latin-specific.

Fixed (maintainer chose "both"):
- **`num_ctx` 16384 → 32768** (`ollama.ts` const + registry default + `.env.example`):
  headroom so fewer chapters need splitting.
- **New `server/src/analyzer/stage1-chunk.ts`** — `runStage1ChapterChunked`
  mirrors the Stage-2 chunker: split an over-budget chapter into paragraph-bounded
  sub-bodies, detect each, **union** the rosters (injects the route's
  `mergeRosterChapter`, so the module stays pure), thread the accumulated roster
  into later chunks' prompts (so a recurring character keeps one id), and
  adaptively re-split a chunk that still truncates. Local budget derives from
  `num_ctx`; **cloud engines never chunk** (huge context, small output). Within-budget
  chapters run exactly one call (byte-identical). Wired into both Phase-0a call
  sites in `analysis.ts`. New knob `analyzer.stage1.chunkCharBudget`.
- Tests: `stage1-chunk.test.ts` (single-call / split+union / roster-threading /
  adaptive re-split / budget derivation).

### Follow-on — cast name fidelity (2026-06-16)

On-box Russian testing showed the local 4B model **copying surnames** across
characters (`Сергеевич Городецкий` / `Назарова` smeared from Anton / Svetlana
onto unrelated cast) and **folding distinct names** together (`Игорь`↔`Илья`,
`Гарик`↔`Игорь`). The Phase-0a prompt had strong id-reuse guidance but no
anti-invention / anti-merge guardrail. Fixes:
- Prompt: a **name-fidelity** rule (use the name exactly as the text uses it;
  never add/copy a surname/patronymic/title; aliases only for forms the text
  itself equates) + a **no-spurious-merge** rule (distinct names are separate
  people unless the text explicitly equates them).
- Dropped the Stage-1 chunker's **intra-chapter roster-threading** (it fed those
  full names into every section, amplifying the smear); cross-chapter id
  stability still comes from the book-level running roster.
- Live ETA: also shipped section-progress refinement for the Phase-0a ticker so
  the first chapter no longer reads "over budget" (`refineCastChapterEstMs`).

Caveat: these reduce but don't eliminate the errors on a 4B local model over
Russian — the reliable fix for name/alias fidelity is the **Gemini analyzer**.

### Owed (on-box acceptance — issue to file)

- **ffmpeg + Cyrillic filesystem paths on Windows.** Book directories already use
  display strings verbatim (`bookDirByDisplay`), so Cyrillic paths reach ffmpeg
  **today**, independent of this plan; chapter audio filenames now also carry the
  Cyrillic title (`01-война.mp3`). Validate a full analyze→generate→export of a
  Russian book on the Windows box. If ffmpeg chokes, the fallback is an ASCII
  chapter-slug scheme (numeric prefix already guarantees uniqueness).
- Observe real model character ids for Cyrillic names (Phase 0 Q1–Q5).
- Cross-book voice carryover for a Russian 2-book series (live).
- MAX_PATH headroom for long Cyrillic book ids/titles on Windows.

## Ship notes

(Filled when status flips to `stable`.)
