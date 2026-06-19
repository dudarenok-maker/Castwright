# Byline author cast collision — design

**Issue:** #938 · **Date:** 2026-06-20 · **Status:** design (approved, pre-plan)
**Area:** server (analyzer) · **Relates to:** plan 221 (multilingual attribution), #935

## Problem

On a first-person novel whose manuscript carries a title-page byline, the analyzer
rosters the **book's real-world author as a speaking character** and routes the
**first-person protagonist's narration and dialogue to that author entity** — the
author "eats" the hero's lines.

Reproduced on real data — *Ночной дозор* (Sergei Lukyanenko / Night Watch),
`C:\AudiobookWorkspace\books\Сергей Лукьяненко\…\Ночной дозор`:

- The detected cast (`.audiobook/cast.json`) contains
  `sergey-lukyanenko | Сергей Лукьяненко` with **`role: "Protagonist / Investigator"`** —
  the model literally cast the byline author as the hero.
- The book's true protagonist Anton appears separately (and, incidentally, split
  across `anton` / `anton-gorodetsky`).

### Root cause (two independent layers, both evidence-backed)

1. **Front matter is not stripped.** The opening content document the analyzer
   read (`temp_calibre_txt_input_to_html_split_000.html`) is a title-page /
   boilerplate block in the prose: `НОЧНОЙ ДОЗОР`, the byline `Сергей ЛУКЬЯНЕНКО`,
   an `_###ICE#BOOK#READER…###_ … AUTHOR: Сергей Лукьяненко TITLE: Ночной дозор`
   header, `(С) Сергей Лукьяненко` copyright, and `bestlibrary.ru` URLs. The
   EPUB `dc:creator` is `Сергей Лукьяненко`, matching the byline — so the author
   name is **literally in the text the model saw**.

2. **The "first-person document author" rule misfires.** The cast-detection
   prompt (inline in `buildStage1ChapterInbox`, `server/src/routes/analysis.ts:1313-1320`,
   mirrored in `skills/audiobook-character-detection-per-chapter.md`) says: *a
   first-person document whose author is named → the author is the character, not
   narrator.* That rule is meant for **in-fiction** documents (a diary, a letter,
   a registry file). *Ночной дозор* is a first-person **novel** ("Давным-давно **я**
   научился…"; Anton speaks as "— Не совсем, — **сказал я**"), and the byline is the
   "named author" in view — so the model assigns Anton's first-person voice to
   Сергей Лукьяненко.

## Goals / non-goals

**Goals**
- The book's byline author is **not** cast as a speaking character in normal story prose.
- The first-person protagonist **keeps** their narration and dialogue — reclaimed
  lines go to the protagonist, **not** dumped on narrator.
- The **legitimate** author-as-character case is preserved: a genuine, explicitly
  **framed** author's-note / in-fiction document still rosters its author (e.g.
  Unraveled's author's-note chapters; Oduvan's journal, Marlow's diary).

**Non-goals**
- General `anton` ↔ `anton-gorodetsky` cross-id de-duplication (plan 221 Wave C —
  deliberately a manual merge at cast review; risky to automate).
- A world-knowledge denylist for an author **not** present in the text. Layers A+C
  make that case unlikely and Layer B still catches it whenever the invented name
  matches book metadata, but we do not add a generic "famous author" filter.

## Design overview

Three layers, deterministic where it matters. Layer A removes the source so the
problem rarely arises; Layer B is the deterministic safety net that reclaims lines
for the protagonist; Layer C is a cheap prompt nudge that reduces how often B fires.

All three need the same **shared plumbing**: thread the book's `author` (and
`title`, `language`) — already stored in `state.json` / the analysis `record` — into
the body-prep path (A), the per-chapter attribution flow (B), and
`buildStage1ChapterInbox` (C). No new persisted state.

---

### Layer A — front-matter / boilerplate stripping (deterministic source fix)

New pure module `server/src/analyzer/strip-front-matter.ts`:

```ts
stripFrontMatterBoilerplate(body: string, opts: { author?: string; title?: string }): string
```

Applied to each chapter body **before** it enters stage-1 detection and stage-2
attribution, so the author name never reaches the model. It removes:

- **Always-safe global patterns** (anywhere in the body — ordinary prose never
  contains these): `_###ICE#BOOK#READER…###_` markers; `AUTHOR:` / `TITLE:` /
  `CODEPAGE:` reader-header fields; e-library distribution boilerplate
  ("Любое коммерческое использование…", "одобрен к распространению…"); bare
  library URLs; `(С)` / `(C)` copyright lines.
- **Byline / title echo — leading region only**: a *standalone short line* equal
  (normalized, case-insensitive — handles `Сергей ЛУКЬЯНЕНКО` ≈ `Сергей Лукьяненко`)
  to the book `author` or `title`, but only within the head block of the first
  chapter, before substantial narrative prose has begun.

**Conservative by construction:** the author/title-line removal is gated to a
leading non-narrative block, so a story that *mentions* the author mid-prose is
untouched. The global patterns are specific enough to be safe everywhere.

Applied at **analysis time** (the stored manuscript is left intact), so re-analysis
picks up improvements and the user's source file is never rewritten.

---

### Layer B — incremental per-chapter realignment with an early protagonist anchor

The byline-author guard runs **inside the existing per-chapter flow**, not as a
single end-of-run pass. Anchoring the protagonist from Chapter 1 — where the real
protagonist is established and dominant — makes the realignment target robust and
avoids guessing from end-of-book totals the author has already skewed.

New pure module `server/src/analyzer/byline-author-guard.ts` (exact shape settled in
the plan), driven by the analysis route across chapters:

1. **Stage-1 (per chapter) — flag the byline author.** When a detected character's
   name matches the book `author` (normalized via `normaliseNameKey`), flag it as
   the byline-author entity and **ignore the model-assigned role** (e.g. the bogus
   `"Protagonist"`).

2. **Protagonist anchor (sticky, established early).** Maintain a running anchor =
   the dominant **non-author, non-narrator** speaker accumulated so far. The real
   protagonist appears and dominates from Chapter 1, so the anchor locks on early
   (Anton via his dialogue) and **stays sticky** — a chatty side-character in a
   later chapter cannot steal it.

3. **Stage-2 (per chapter, as each chapter is attributed) — reclaim lines.** Any
   sentence attributed to the byline-author entity is **reassigned to the current
   anchor right then**. Cheap, incremental, self-correcting as the book flows.
   - **Reassignment target = the anchor (the protagonist). No confidence/margin
     gate** — that gate is what would force the bad narrator fallback. With two
     Anton rows the larger one wins; the protagonist keeps their voice.
   - **Narrator is a last resort only** when a book genuinely has no other speaker
     (degenerate; never true for a novel).

4. **Author-only-prologue edge.** If an early chapter is a prologue spoken only by
   the first-person voice and no other named speaker has appeared yet, there is no
   anchor at that instant. **Hold** those byline-author sentences and retroactively
   reassign them once the anchor establishes (almost always within Ch 1–2) — the
   protagonist still reclaims the prologue rather than losing it to narrator.

5. **Framed author's-note exemption (preserves the legit case).** If the byline
   author's lines fall inside an explicitly **framed** author's-note / in-fiction
   document section — detected by chapter title matching author-note patterns
   (`Author's Note`, `Notes from the author`, `От автора`,
   `Предисловие/Послесловие автора`, …; a small, extensible bilingual set) — those
   lines are **kept** on the author entity (legitimate author-as-speaker). Only
   non-framed (story) lines are reclaimed.

6. **End state.** The byline-author entity has no story lines left → dropped from
   the roster (removing the bogus `role: "Protagonist"` ghost). The protagonist
   carries the reclaimed narration + dialogue. A summary line is emitted for the
   analysing-view log (e.g. *"Byline author 'Сергей Лукьяненко' removed; N lines
   reassigned → Антон"*).

**Stated limitation.** "Dominant non-author speaker = protagonist" is a heuristic.
In a rare book whose most-talkative character is not the POV protagonist, reclaimed
lines land on that major character instead — still a named voice, recoverable by
manual re-cast, and strictly better than narrator per the chosen preference. The
residual two-Anton split for the protagonist's *own* originally-correct lines stays
a manual merge (Wave C); this fix only guarantees the reclaimed lines land on a real
protagonist, never narrator.

---

### Layer C — prompt clarification (soft; reduces how often B must fire)

In `buildStage1ChapterInbox` (`analysis.ts`) **and** the skill file
`skills/audiobook-character-detection-per-chapter.md` (kept in sync — both carry the
rule today):

- **Pass the byline author into the prompt** and state: the book's listed author is
  **not** a character unless they explicitly act or speak *in the story*; never
  assign them the narrator's or protagonist's first-person lines.
- **Narrow the first-person-document rule** to **clearly-framed embedded documents**
  (explicit header / signature / title — a journal, letter, registry file). Add: a
  whole first-person **novel** is not such a document; its first-person voice is the
  protagonist/narrator, not the book's author.

Soft by nature (the local `gemma4-e4b` follows prompt nudges unreliably — prior alias
nudges hit ~0% compliance), so it is the cheap top layer; A and B are the
deterministic guarantees beneath it.

## Data flow

```
parse (epub) → chapters + book meta { author, title, language }
   │
   ├─ Layer A: stripFrontMatterBoilerplate(body, {author,title})  ← per chapter, pre-model
   │
stage-1 cast detection (per chapter)
   ├─ Layer C: byline author rendered into the inbox prompt
   └─ Layer B(1): flag byline-author entity by name==author
   │
stage-2 attribution (per chapter)
   └─ Layer B(2,3,4,5): update sticky anchor; reassign byline-author sentences
                        to anchor (hold-until-anchor for early prologue;
                        framed author's-note sections exempt)
   │
finalisation: recoverTaggedNarratorLines → foldMinorCast
   └─ Layer B(6): byline-author entity now line-less → dropped; summary logged
```

## Testing

Per the project's testing discipline (paired automated tests for every change):

- **Layer A** — pure unit tests on `stripFrontMatterBoilerplate` using the *actual*
  Night Watch head (ICE BOOK READER markers, `Сергей ЛУКЬЯНЕНКО` byline, `(С)`
  copyright, library URLs) → stripped; ordinary narrative prose preserved; an
  author-name mention *inside* story prose left intact (conservative-boundary test);
  English book with no byline → no-op.
- **Layer B** — pure unit tests on the guard: byline-author detected by name-match;
  anchor establishes from Ch 1's dominant non-author speaker; anchor sticky across
  later chapters; per-chapter reassignment moves author sentences to the anchor;
  author-only prologue **held then retroactively reassigned**; framed author's-note
  section **kept** (Unraveled case); narrator only when no candidate exists; the
  line-less author entity is dropped at the end.
- **Layer C** — `buildStage1ChapterInbox` renders the byline-author guidance + the
  narrowed first-person rule; skill-file parity assertion.
- **Integration regression** — a small first-person fixture with a byline (a variant
  of the canonical `the-coalfall-commission` fixture, or a purpose-built minimal one)
  run through the analysis path → final cast contains **no author-as-character** and
  the protagonist holds the reclaimed first-person lines.

## Open questions for the plan

1. Exact insertion points in `analysis.ts` for Layer B across the full and subset
   analysis entrypoints (the route already threads per-chapter results; the guard
   should ride that, not a separate pass).
2. Whether the anchor is recomputed per chapter or maintained as a running tally
   (the plan picks the cheapest correct shape).
3. The bilingual author-note title pattern set's initial membership (start small,
   extend on real corpus data — same discipline as `GENERIC_ROLE_RU`).
