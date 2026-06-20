# English narrator-default attribution guard — design

- **Date:** 2026-06-20
- **Status:** active
- **Area:** server / analyzer (stage-2 sentence attribution)
- **Branch:** `feat/server-english-narrator-default`

## Problem

Listening to _Scepter of the Ancients_ (English, analyzed with the default
Gemini/`gemma-4-31b-it` model), runs of close third-person narration are voiced
in a character's voice instead of the narrator's. Confirmed from the Confirm-view
screenshot: a block attributed to **Stephanie Edgley** that is pure narration
_about_ her —

> "She'd taken a wrong turn… and she didn't know where she was."
> "She was lost."
> "She turned away from the dead end, wanting to scream at herself in frustration…"
> "She tried remembering their trail from the hall to the iron door…"

None of these are spoken. The model sweeps POV narration (and unquoted interior
thought / free indirect discourse) onto the dominant nearby character.

### Why it happens

The skill `skills/audiobook-sentence-attribution.md` **already** instructs the
correct behaviour — "Narrative prose (no quotes) → `narrator`" (line 127),
"third person about themself is still narration → `narrator`" (line 131),
"Free indirect discourse stays with the narrator" (line 132). The model
(especially the small default `gemma-4-31b-it`) **ignores rules it was given.**

There is already a deterministic safety net for exactly this failure —
`applyNonEnglishNarratorDefault` in `server/src/analyzer/narrator-default.ts` —
but it is **gated to non-English manuscripts only** (it took Russian attribution
from 0/6 to 6/6 with zero dialogue damage). English manuscripts get **no**
narrator protection at all.

### What it is NOT

Chunk size is a **red herring** for this bug. The misattribution is a _local_
pattern (the model latches onto the nearest dominant character name), so shrinking
the stage-2 chunk window would not change it — "She was lost." next to Stephanie
still gets pulled onto Stephanie in a small window too. Lowering the 9000-char
chunk threshold would add Gemini cost and boundary seams without fixing this.
This design does **not** touch chunking.

## The structural tell

Every misattributed line in the screenshot has **no quotation marks at all**. In
English (as in the skill contract), a sentence with no quote and no dialogue-dash
is narration regardless of whose name appears in it. The existing
`isSpokenLine()` predicate already encodes this and already handles English
straight (`"…"`) and smart (`"…"`) quotes.

### Why the guard is safe — including across quote conventions (defense in depth)

The skill contract guarantees every **spoken** split keeps its quote characters
verbatim (`"Hard to starboard,"` → speaker; `he said,` → narrator) and "if a
sentence has no embedded quotes at all, do NOT split it." So a quote-less row is,
by contract, narrator material. Demoting quote-less character-rows to narrator
**enforces** the contract rather than fighting it. A multi-sentence quoted
utterance split into per-sentence rows that strips interior quotes is covered by
the no-regression test against the Coalfall fixture.

**The "demote-only is safe" claim holds only for the quote styles `isSpokenLine`
recognizes** — anything it fails to see as spoken gets muted to narrator. The
original predicate (`narrator-default.ts:31-38`) recognized **double quotes and
guillemets only**, so **single-quote dialogue** (`'I'm lost,' she said.` — the
standard UK / Irish convention) would have been muted. Since we ingest books from
arbitrary `.env` locations and *will* hit every convention, the guard is hardened
to recognize the full set up front (defense in depth) rather than gating on each
book's style:

- **All common opening quotes** at line-start — guillemet `«`, straight double
  `"`, smart double `"`, smart single `'`, **straight single `'`** — plus the
  dialogue dashes already handled. A **leading** quote is unambiguous: apostrophes
  never appear at line-start, so straight `'` is safe here even though it is
  ambiguous mid-word. And because the skill contract makes spoken splits
  **quote-initial**, this leading-class check alone catches essentially all
  contract-following dialogue in every convention.
- **Embedded quoted spans**, including a **word-boundary-anchored** straight-single
  matcher (opens after start/space/bracket/dash, closes before space/punctuation)
  so mid-line dialogue is caught even when the model violates the splitting
  contract — without colliding with apostrophes (`don't`, `O'Brien`, possessive
  `dogs'`), whose `'` is never at a word boundary.

The guard remains **demote-only**, so any residual misfire is in the safe
direction: an unrecognized-as-spoken case is left as the model attributed it
(a false-negative), never a silenced dialogue line.

### Verification gates (do these before/while building)

1. **Quote convention is no longer a blocker.** With the full opening-quote class
   + boundary-aware embedded matcher, the guard handles double / smart-single /
   straight-single / guillemet / dash conventions. Still worth a glance at a real
   _Scepter_ dialogue line to confirm the live result, but it does not gate the
   build.
2. **Confirm `'narrator'` is in the valid-id set on BOTH routes** so guard
   demotions stay clear of the `attribution_drift` counter (see _Interaction with
   the drift guard_ below). Verified true at design time — main (`analysis.ts:1044-1045`,
   `:3955`) and subset (`:4940`, narrator exempt at `fold-minor-cast.ts:343`);
   re-confirm if that code moves.

## Design

Three components, all in `server/src/analyzer/narrator-default.ts` plus its
single call site in `server/src/routes/analysis.ts`.

### Component 1 — Generalize the guard to all languages + recognize single quotes

Drop the non-English gate so the narrator-default runs for English too, **and**
extend `isSpokenLine` to recognize single-quote dialogue so the guard does not
mute real single-quoted dialogue:

- Rename `applyNonEnglishNarratorDefault(sentences, language)` →
  `applyNarratorDefault(sentences)`. The `language` argument is no longer needed
  (it only drove the gate) — drop it, and **remove the now-dead `isNonEnglish`
  import** (`narrator-default.ts:21`).
- **There is exactly ONE call site** — `analysis.ts:1563`, inside the shared
  `attributeChapterStage2` runner. Both the main route (`:3650`) and the subset
  route (`:4805`) reach the guard through that single call, so full, subset,
  cached, and resumed runs all get identical treatment for free. Update that one
  call.
- **Extend `isSpokenLine` to cover all common quote conventions (defense in
  depth):**
  - **Leading-quote class** → add smart single `'` and straight single `'`:
    `/^[«"“‘']/`. Safe because a line-leading `'` is a dialogue opener, never a
    mid-word apostrophe. This is the load-bearing change — spoken splits are
    quote-initial by contract, so it catches dialogue in every convention.
  - **Embedded smart single** `‘[^’]+’` — unambiguous (only matches with a real
    U+2018 opener; a lone U+2019 apostrophe in `don't` cannot trigger it).
  - **Embedded straight single, word-boundary-anchored** — opens after
    start/whitespace/bracket/dash, closes before whitespace/punctuation:
    `/(?:^|[\s([{<«—–-])'(?=\S)[^']*?\S'(?=[\s.,!?;:)\]}>»]|$)/`. This catches
    mid-line dialogue (`She said 'go away' angrily.`) without matching apostrophes
    (`don't`, `she'd`, `O'Brien`) or possessives (`dogs'`), whose `'` is never at a
    word boundary. A straight-single span that *contains* an internal contraction
    and has no leading quote (e.g. a mid-line `'I'm here'`) is not matched by the
    embedded form — but the leading-class check covers the quote-initial case, and
    a miss here is the safe direction (left as-is, never muted).

**Invariant: sentence-level demote-only — but line counts (and therefore the
cast roster) DO change.** A non-spoken sentence has its `characterId` set to
`narrator`; a spoken line is returned unchanged; the guard never reassigns a
quoted line to a different speaker and never promotes `narrator` → character.
**However**, the guard runs **upstream** of `foldMinorCast` (`analysis.ts:1563`
→ fold at `:3923`/`:4895`), and fold counts dialogue lines per character off the
**already-demoted** list (`fold-minor-cast.ts:303,356,362`). So demoting a
character's misattributed narration **lowers that character's line count**, which
can fold them into the `unknown-male`/`unknown-female` bucket (`<minLines`, default
3) or drop them from the cast entirely (`lines === 0`, unless `proseTagged` /
role-protected). **This is accepted as more-accurate counting** — a "character"
who only ever appears in narration is not a speaking role. (Explicitly-tagged
speakers are already protected by `proseTagged` at `fold-minor-cast.ts:315,355`
and by `recoverTaggedNarratorLines` at `analysis.ts:3885`.) The earlier
"cannot change the cast" framing was wrong; the roster effect is intended and
pinned by a test (Component 3, item 3a). No special protagonist protection is
added (YAGNI — a book-wide-quoted protagonist keeps her slot; fold counts
book-wide).

**Always-on for English** — no setting or feature flag. It is deterministic, and
every demoted block is reviewable via the low-confidence pill (Component 2).

### Component 2 — Flag demoted blocks low-confidence (one stop per block, both languages)

When the guard demotes a sentence whose model-assigned `characterId` was a **real
character** (an actual override, not a line the model already called `narrator`),
clamp its `confidence` to `Math.min(existing ?? 1, 0.5)` so the existing "Low
confidence" pill (`< 0.75`) surfaces it in the Confirm-view checks.

**Clamp only the FIRST override in each contiguous demoted run — not every
sentence.** The Confirm-view low-confidence *navigator* filters per sentence
(`manuscript.tsx:321`, `s.confidence < 0.75`), so clamping all four sentences of a
narration block would create four navigator stops on (correctly) narrator lines.
Clamping only the first gives the user **one review stop per demoted block**;
consecutive same-id sentences already merge into a single pill
(`manuscript.tsx:172`), so the visual remains one pill either way. Subsequent
overrides in the same run are still demoted (correct attribution) but keep their
model confidence (no extra navigator stop).

Run semantics (a pure forward pass; reset the "clamped this run" flag on every
spoken line):

- `isSpokenLine(s)` → return `s` unchanged; reset the run flag.
- non-spoken, `characterId === 'narrator'` already → return `s` unchanged (not an
  override; does not consume the run's clamp slot).
- non-spoken override, **first** in this run → `{ ...s, characterId: 'narrator',
  confidence: Math.min(s.confidence ?? 1, 0.5) }`; set the run flag.
- non-spoken override, later in the run → `{ ...s, characterId: 'narrator' }`
  (demoted, confidence untouched).

`Math.min` (not a flat assignment) so a first-of-run line the model already rated
below 0.5 keeps its lower value. Applies to **both** language paths — the
non-English guard previously overrode silently; it now flags too.

**Keep `forceNarratorOnNonSpokenLines` field-preserving (id-only).** The clamp +
first-of-run logic lives in `applyNarratorDefault`, NOT in the low-level force
helper — so the helper's existing field-preservation test (`narrator-default.test.ts:65-69`,
which asserts confidence survives demotion) stays green, and the two concerns
stay cleanly separated.

The model's **original** `characterId` is discarded on override — no audit trail
of what a demoted line was attributed _from_. Accepted for v1 (the pill invites
the user to re-check / re-attribute the block); revisit only if debugging demands.

### Interaction with the attribution-drift guard (verified safe, both routes)

`reconcileSentenceCharacterIds` (`analysis.ts:3957`) demotes and **counts** only
ids that are NOT in the valid-id set, feeding the `>5%` `attributionDriftExceeded`
abort. The guard runs upstream (`:1563`) and emits `'narrator'`, which **is** a
valid roster id on **both** routes — main (`:3955`, narrator added at
`:1044-1045`) and subset (`:4940`, narrator exempt in `foldMinorCast`
`fold-minor-cast.ts:343` / `dropEvidencelessCast` `analysis.ts:404`). So guard
demotions are invisible to the drift counter and cannot trip the abort
(`:3979`/`:4964`) even on a near-100%-narrator chapter. `warnPerChapterDrift`
(`:1098-1119`) likewise keys on reconcile's orphan-id demotions, **not** guard
demotions, so the per-chapter WARN also stays quiet on heavy guard demotion — the
intended outcome. This ordering is load-bearing: the guard must stay upstream of
reconcile, and `'narrator'` must remain valid on both routes. A test pins it.

### Component 3 — Tests

In `server/src/analyzer/narrator-default.test.ts` (and the Coalfall
full-pipeline path where applicable):

1. **Scepter regression (English, double-quote):** a run of quote-less POV
   narration attributed to a real character → all demoted to `narrator`; **only
   the first** carries `confidence === 0.5`, the rest keep their model confidence
   (one-stop-per-block).
2. **No-regression, double-quote dialogue:** the Coalfall fixture's real, quoted
   multi-sentence dialogue is **not** demoted; spoken lines keep their speaker
   and confidence.
3. **No-regression, SINGLE-quote dialogue (the critical one):** an English line
   using smart single quotes (`'I'm lost,' she said.`) is **not** demoted. Coalfall
   is double-quoted and does NOT exercise this — use a dedicated inline fixture.
   This is the test that guards the Component-1 single-quote extension; without it
   the suite gives false confidence.
3a. **Cast-roster effect (the corrected invariant):** an English character whose
   only "lines" are demoted narration drops below `minLines` and folds to the
   unknown bucket / is dropped — the *intended* outcome (mirror the existing
   non-English fold test `narrator-default.test.ts:89-124` in English). A
   separately-quoted (book-wide) character keeps her slot.
4. **Scare-quote narration is left alone:** a narration sentence containing an
   embedded quoted span (`She read the sign that said "Exit".`) is treated as
   spoken and **not** demoted (documented false-negative — safe direction).
5. **Both-language flag:** a non-English override now also carries the clamped
   confidence (previously it did not).
6. **Drift-guard ordering pin:** guard demotions emit `'narrator'` and are not
   counted by `reconcileSentenceCharacterIds` / do not trip `attributionDriftExceeded`.
7. **One-stop-per-block:** a contiguous demoted run of N>1 sentences yields exactly
   one sentence with `confidence === 0.5`; a spoken line between two demoted runs
   resets the run so each block gets its own single flag.

**Existing tests that change** (no test deleted without a replacement assertion):
- `narrator-default.test.ts` "no-op for English / same array reference" — English
  now runs the guard; replace with the new English behaviour.
- The clamp lives in `applyNarratorDefault`, so the field-preservation test at
  `:65-69` (on `forceNarratorOnNonSpokenLines`) **stays green** — that helper is
  unchanged. The fold-interaction tests at `:89-124` stay valid (and 3a adds the
  English counterpart).

## Non-goals & documented limitations

- No change to chunking / chunk-size thresholds.
- No new prompt/skill text (the rules already exist and are ignored — see above).
- No reassignment of mis-attributed _quoted_ dialogue to a different speaker
  (a separate, harder "who is speaking" problem; not observed in this report).
- No quote-span state machine unless the no-regression tests prove it necessary.
- No user-facing setting/flag.
- **Free-indirect / interior monologue → narrator is a deliberate product
  choice, not an objective truth.** Unquoted interior thought ("Weren't there any
  signs?") will read in the narrator's voice. The user confirmed this is desired;
  it is a choice, and could be revisited if interior monologue should one day get
  the POV character's voice.
- **Scare-quote / title narration is a known false-negative.** A narration
  sentence containing an embedded quoted span (a sign, a title, an air-quote) is
  treated as spoken and left as the model attributed it. Safe direction (never a
  _wrong_ demotion), but it means such lines are not auto-corrected.
- **Straight-single-quote (`'`) dialogue IS now handled** (leading class +
  boundary-aware embedded matcher — see Component 1). Residual limitation: a
  *mid-line* straight-single span that contains an internal contraction and has
  no leading quote is not matched by the embedded form — rare, and a miss is the
  safe direction (left as-is, never muted).
- **CJK corner-bracket quotes (`「…」`) are not recognized** by `isSpokenLine`.
  Pre-existing (the non-English path already shipped with this gap); not widened
  here, but now more visible since the guard runs for all languages. Out of scope.

## Files touched

- `server/src/analyzer/narrator-default.ts` — drop the language gate (and the
  now-dead `isNonEnglish` import), extend `isSpokenLine` to the full opening-quote
  class + boundary-aware embedded single-quote matcher, add the first-of-run
  low-confidence clamp in `applyNarratorDefault` (keep `forceNarratorOnNonSpokenLines`
  field-preserving), rename the applier.
- `server/src/routes/analysis.ts` — update the single call site (`:1563`) to the
  renamed applier.
- `server/src/analyzer/narrator-default.test.ts` — new + updated tests.

## Acceptance

- The Stephanie-shaped narration block in _Scepter of the Ancients_ is attributed
  to `narrator`, and the block surfaces as one "Low confidence" review stop
  (first sentence flagged), not one per sentence.
- No real dialogue is demoted — **double-quote** (Coalfall) **and smart
  single-quote** dialogue both keep their speaker.
- Quote convention of the actual _Scepter_ manuscript checked (verification gate 1).
- `npm run verify` is green.
