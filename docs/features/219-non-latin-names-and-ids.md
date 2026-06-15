---
status: draft
shipped: null
owner: null
---

# 219 — Non-Latin (Cyrillic) character names, ids & cross-book keys

> Status: draft
> Key files: `server/src/analyzer/roster-coverage.ts` (`toKebabId`), `server/src/routes/analysis.ts` (`bookIdFromTitle`, ingest), `server/src/store/merge-analysis-cast.ts`, `server/src/workspace/series-prior-dedup.ts`, `server/src/routes/cast-series-patch.ts`, `server/src/routes/voice-override-linked.ts`, `server/tts-sidecar/main.py` (`_voice_paths`), `scripts/recover-missing-character.mjs`
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

These were deliberately split out because — unlike the two word-normalizer
one-liners — they touch **persisted ids and on-disk filenames**, so they need a
deliberate canonicalization scheme and a migration story, not a blind regex
swap.

### What actually breaks (evidence)

1. **Locally-minted slugs collapse to empty/colliding ids.**
   - `roster-coverage.ts:134` `toKebabId` — `…toLowerCase().replace(/[^a-z0-9]+/g, '-')…`
     → "Анна" → `""`. Used to mint a stable id for a speaker the roster-coverage
     guard auto-recovers; two distinct Russian names → same empty id → collision.
   - `routes/analysis.ts:706` `bookIdFromTitle` — same strip, `|| 'book'`
     fallback → **every** Russian-titled book that lacks a `record.bookId`
     resolves to the literal id `book` (used at `analysis.ts:3679` and `:4612`).
   - `scripts/recover-missing-character.mjs` `toKebabId` — same rule, same break.

2. **Model-returned character ids are never canonicalized.**
   `handoff/schemas.ts:32` — `id: z.string().min(1)`; the analyzer **model**
   supplies `id`, `name`, `color`. We do not normalize it at ingest, so on a
   Russian book the id is whatever the model emits (Cyrillic, transliterated, or
   inconsistent run-to-run). A Cyrillic id is fine as a JSON key/value, but it
   flows into a **filename** at voice-design time (next item).

3. **Sidecar voice-embedding filenames silently merge under ASCII sanitization.**
   `server/tts-sidecar/main.py:1298` `_voice_paths` — `re.sub(r"[^A-Za-z0-9_.-]",
   "_", voice_id)` → a Cyrillic-derived `voice_id` becomes a run of `_`, so two
   distinct Russian characters can overwrite each other's `.pt`/`.json`
   embeddings on disk. (The sanitizer itself is defensible — the real defect is
   that an un-canonicalized id reached it.)

4. **Cross-book name-match keys go dark (fail-safe, but non-functional).**
   `workspace/series-prior-dedup.ts:43`, `routes/cast-series-patch.ts:227`,
   `routes/voice-override-linked.ts:199` all use
   `normaliseToken = s.toLowerCase().replace(/[^a-z0-9]/g, '')` then guard with
   `if (n)`. For Cyrillic the token is `""` → dropped → **no** cross-book voice
   carryover / dedup for Russian casts. It fails safe (no *wrong* merges) but the
   series-reuse feature simply doesn't work for them.

### What is already safe (verified — do NOT touch)

- `util/text-match.ts` — evidence/quote verifier + voice-matcher Jaccard:
  `normaliseForMatch` preserves Cyrillic; matching is `.includes()` + length-based
  tokens. Russian speakers' lines are **not** wrongly pruned.
- `tts/text-normalize.ts` `stripUnsafeForTts` — preserves Cyrillic; only strips
  zero-width/control/surrogate codepoints. Russian TTS input is intact.
- **Chapter audio slugs** (`NN-<title>`, e.g. `restructure.ts`) — numeric-prefixed,
  so a Russian title yields `01-`, still unique. Chapter filenames are fine.
- Frontend search (`.includes`+`.toLowerCase`), sort (`.localeCompare`), and
  word-count (`/\s+/`) — Unicode-safe. Whisper ASR auto-detects Russian natively.

## Benefit / Rationale

- **User:** Russian (and other non-Latin) books stop silently mis-behaving —
  auto-recovered speakers get real distinct ids, designed voices don't clobber
  each other on disk, and cross-book voice reuse works for a non-Latin series.
- **Technical:** one canonical, tested `safeCharacterId` / `safeBookId` chokepoint
  replaces three+ divergent ASCII slugifiers; ids become guaranteed-unique and
  filename-safe regardless of source script or what the model emits.
- **Architectural:** establishes "**never trust an external (model or user)
  string to be a safe id — canonicalize at the persistence seam**" as an
  invariant, closing a whole class of script-assumption bugs.

## Architectural impact

### New seam

A single shared helper module — proposed `server/src/util/safe-id.ts`:

- `safeId(name: string, opts?: { taken?: Set<string>; prefix?: string }): string`
  — produces a lowercase, filename-safe, **non-empty, collision-free** id:
  1. Unicode-normalize (NFKD) + strip combining marks.
  2. **Transliterate** common non-Latin scripts to ASCII (Cyrillic at minimum —
     a small built-in table, no heavy dep) → "Анна" → `anna`.
  3. Kebab the result (`[^a-z0-9]+` → `-`, trim).
  4. **Fallback** when the result is empty (untransliterated script, e.g. CJK):
     `${prefix ?? 'char'}-${djb2(name)}` so it is always non-empty + stable.
  5. **Disambiguate** against `opts.taken` with a `-2`, `-3`… suffix.
- `normaliseNameKey(s: string): string` — the cross-book match key, Unicode-aware
  (`[^\p{L}\p{N}]+` removed, lowercased, **plus** the same transliteration so
  "Анна" in book A keys equal to "Анна" in book B). Replaces the three copies of
  `normaliseToken`.

### Call-sites to route through the seam

- `roster-coverage.ts` `toKebabId` → delegate to `safeId`.
- `analysis.ts` `bookIdFromTitle` → `safeBookId` (transliterate before the
  `'book'` fallback; keep the 32-char cap).
- `analysis.ts` / `merge-analysis-cast.ts` **ingest**: canonicalize each
  model-returned `character.id` through `safeId` (defense-in-depth — do not trust
  the model). Rewrite the matching `sentence.characterId` references in lockstep.
- `series-prior-dedup.ts`, `cast-series-patch.ts`, `voice-override-linked.ts`:
  replace `normaliseToken` with the shared `normaliseNameKey`.
- `scripts/recover-missing-character.mjs` `toKebabId` → mirror `safeId`.
- (Defense-in-depth) `tts-sidecar/main.py` `_voice_paths`: keep the ASCII
  sanitizer but assert non-degenerate input, OR hash the full `voice_id` into the
  filename so a sanitized collision can't occur even if a raw id slips through.

### Migration story

- **Existing books are NOT re-keyed.** Their ASCII ids on disk stay valid;
  `safeId` is byte-identical to the old slug for any ASCII-only name (English
  unchanged). The change is **forward-only** — it only affects newly analyzed /
  newly recovered characters and new books.
- Risk if we *did* retro-rewrite ids: cast.json `id`, `sentence.characterId`,
  `overrideTtsVoices` is engine-keyed (safe), Qwen `.pt`/`.json` filenames, and
  any queue/revision state referencing the id would all need a coordinated
  rename. **Out of scope** — no existing Russian book has shipped, so there is
  nothing to migrate; we only need correctness going forward. State this loudly.

### Reversibility

The helper is pure and additive; reverting a call-site restores the old slug.
No env flag needed — there is no behavioural change for ASCII input, so it
cannot regress existing English books.

## Invariants to preserve

- `safeId(asciiName)` MUST equal the current `toKebabId(asciiName)` /
  `bookIdFromTitle` output for every ASCII-only name (no churn for English books).
  Cite the test that pins this.
- `handoff/schemas.ts:32` keeps `id: z.string().min(1)` — canonicalization
  happens at *ingest in analysis.ts*, not in the schema.
- Chapter slug generation (`NN-<title>`) is untouched — it is already safe.
- `util/text-match.ts` and `tts/text-normalize.ts` stay as-is (verified safe).
- A character id is always non-empty, lowercased, `[a-z0-9-]+`, and unique within
  its book's roster after `safeId`.

## Test plan

### Automated coverage

- Vitest server (`server/src/util/safe-id.test.ts`, new) —
  - ASCII names are byte-identical to the legacy slug (no English churn);
  - "Анна" → `anna`, "Мария" → `mariya` (transliteration table);
  - two distinct Cyrillic names → two **distinct** ids (no collision);
  - an untransliterable name (e.g. CJK "李雷") → non-empty `char-<hash>` fallback,
    stable across calls;
  - `taken` disambiguation appends `-2`/`-3`;
  - `normaliseNameKey("Анна") === normaliseNameKey("анна")` and bridges two books.
- Vitest server — `roster-coverage` recovery test extended with a Cyrillic
  missing-speaker → gets a real distinct id (regression for the empty-id collision).
- Vitest server — `analysis.ts` ingest test: a model payload with a Cyrillic
  `character.id` is canonicalized and the matching `sentence.characterId` is
  rewritten in lockstep.
- Vitest server — `series-prior-dedup` / `voice-override-linked`: a Russian
  character carries its voice across two sibling books (was a no-op before).
- Pytest sidecar (`server/tts-sidecar/tests/`) — `_voice_paths` for two distinct
  inputs that previously sanitized to the same string now map to distinct files.

### Manual acceptance walkthrough

1. Analyze a short **Russian** manuscript (reuse / adapt
   `server/src/__fixtures__/the-coalfall-commission.ru.md`). Confirm: no stall,
   every chapter completes, the cast view shows distinct characters with sane ids.
2. Auto-recovery: a Russian speaker the roster guard recovers gets a distinct,
   non-empty id (inspect `cast.json`).
3. Design Qwen voices for two different Russian characters; confirm two distinct
   `.pt`/`.json` files on disk (no overwrite) and both audition correctly.
4. Put the Russian book in a 2-book series; confirm a designed voice carries over
   to the sibling book's matching character.

## Out of scope

- **Full UI internationalization / RTL** — this plan is about ids/keys, not
  translating the app chrome.
- **CJK word-segmentation** for the coverage/WER guards — those guards are now
  Unicode-letter-aware (plan 181 follow-up) but still whitespace-tokenize, which
  is wrong for spaceless scripts; CJK gets the `char-<hash>` id fallback here but
  proper CJK QA is a separate plan.
- **Language-specific dialogue-verb detection** (`analyzer/dialogue-verbs.ts` is
  English "said/asked" only) — affects detection *quality* on Russian, not ids.
- **Retroactive id migration** for already-analyzed books (none exist for
  non-Latin; forward-only by design — see Migration story).
- **`denormaliseAllCaps`** ASCII-only all-caps folding (minor TTS-quality nit).

## Ship notes

(Filled when status flips to `stable`.)
