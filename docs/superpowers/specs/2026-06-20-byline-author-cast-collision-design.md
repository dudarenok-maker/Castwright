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
problem rarely arises; Layer B is the deterministic guarantee — it **drops the
byline-author entity from the roster before stage-2**, after which the model
attributes the protagonist's dialogue to the real protagonist on its own (empirically
validated, see Layer B); Layer C is a cheap prompt nudge that reduces how often B fires.

All three need the same **shared plumbing**: thread the book's `author` (and
`title`, `language`) — already stored in `state.json` / the analysis `record` — into
the body-prep path (A), the per-chapter roster-finalization (B), and
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

### Layer B — per-chapter stage-1 roster guard (drop the byline author before stage-2)

**This layer was redesigned after an empirical observation (2026-06-20) overturned the
original "reclaim and reassign" approach.** See "Empirical grounding" below — the data
showed that simply *removing* the byline-author entity from the roster before stage-2
makes the model attribute the protagonist's dialogue to the real protagonist on its
own. No anchor, no line-reassignment, no narrator fallback is needed.

New pure helper (e.g. `server/src/analyzer/byline-author-guard.ts`), applied at the
**per-chapter stage-1 roster-finalization** step (where the route already finalizes
each chapter's detected roster, before stage-2 attribution runs for that chapter):

1. **Detect the byline author.** A detected character whose name matches the book
   `author` (normalized via `normaliseNameKey`) is the byline-author entity,
   regardless of the model-assigned role (e.g. the bogus `"Protagonist / Investigator"`).

2. **Framed author's-note exemption (preserves the legit case).** If the chapter is an
   explicitly **framed** author's-note / in-fiction document — detected by chapter
   title matching author-note patterns (`Author's Note`, `Notes from the author`,
   `От автора`, `Предисловие/Послесловие автора`, …; a small, extensible bilingual
   set) — **keep** the author entity (legitimate author-as-speaker, the Unraveled
   case). Otherwise → step 3.

3. **Drop it from the roster for this chapter.** Remove the byline-author entity from
   the chapter's roster contribution so it never reaches that chapter's stage-2
   attribution. Because the entity is dropped from the *running* roster too, later
   chapters don't carry it forward; if a later chapter's stage-1 independently re-mints
   it, the same per-chapter guard drops it again — idempotent and self-correcting.

4. **Let stage-2 re-attribute naturally.** With no "Protagonist"-labeled author in the
   roster, stage-2 attributes the protagonist's dialogue to the real protagonist
   (`anton`), addressed by name in the prose. **Empirically validated** (see below):
   the 8 dialogue lines that the author stole went to `anton` once the author was
   dropped. No reclamation pass needed.

5. **End state + log.** The byline author is absent from the final roster (no bogus
   `role: "Protagonist"` ghost). A summary line is emitted for the analysing-view log
   (e.g. *"Byline author 'Сергей Лукьяненко' excluded from N story chapters"*).

**Why this is simpler than the prior design.** The original Layer B reclaimed the
author's already-attributed sentences and reassigned them to a "dominant non-author
speaker = protagonist" anchor. The empirical run showed that heuristic would have
mis-picked **Larisa (11 lines)** over **Anton (0 lines — starved by the bug itself)**.
Dropping the author *before* stage-2 sidesteps the whole anchor problem: there are no
author-attributed sentences to reclaim, and stage-2's own name-resolution puts the
lines on the right character.

**Residual (unchanged, out of scope).** The `anton` / `anton-gorodetsky` duplication
remains (Wave C, manual merge): in the validation run the reclaimed dialogue split
`anton: 8` / `anton-gorodetsky: 1`. The protagonist's lines land on a real Anton, not
the author — the split is a cosmetic roster issue, not a loss of voice.

### Empirical grounding (2026-06-20, real gemma4-e4b on *Ночной дозор* Ch 1)

Real stage-2 attribution via local `gemma4-e4b-8gb`, same scene, same roster
(scratch harness, since deleted):

| Roster | `sergey-lukyanenko` | `anton` | `narrator` | `larisa` |
|---|---|---|---|---|
| **as detected** (author = "Protagonist") | **8 dialogue lines** | 0 | 97 (narration) | 11 |
| **author removed** | 0 | **8 dialogue lines** | 96 | 10 |

- The author stole the protagonist's **dialogue** (8 spoken lines: "— Не надо," "— Спасибо," …); first-person **narration** correctly went to `narrator` both ways.
- Removing the author from the roster → the dialogue went to `anton` with **no other change** to the design needed.
- A "dominant non-author = protagonist" anchor would have chosen Larisa, not Anton — the heuristic is disproven for this case. Dropping-before-stage-2 is the correct, simpler fix.

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
   └─ Layer B: at per-chapter roster finalization, DROP the byline-author entity
              (name==author) from the roster — unless the chapter is a framed
              author's-note. Dropped from the running roster too, so it isn't
              carried forward; idempotent if re-minted later.
   │
stage-2 attribution (per chapter)
   └─ runs against the cleaned roster → protagonist's dialogue lands on `anton`
      (empirically validated; no reclamation pass)
   │
finalisation: recoverTaggedNarratorLines → foldMinorCast  (unchanged)
```

## Testing

Per the project's testing discipline (paired automated tests for every change):

- **Layer A** — pure unit tests on `stripFrontMatterBoilerplate` using the *actual*
  Night Watch head (ICE BOOK READER markers, `Сергей ЛУКЬЯНЕНКО` byline, `(С)`
  copyright, library URLs) → stripped; ordinary narrative prose preserved; an
  author-name mention *inside* story prose left intact (conservative-boundary test);
  English book with no byline → no-op.
- **Layer B** — pure unit tests on the roster guard: byline-author detected by
  name-match (`normaliseNameKey`, case/inflection-tolerant: `Сергей Лукьяненко` ≈
  `sergey-lukyanenko`); dropped from a normal story chapter's roster (and the running
  roster); **kept** when the chapter title marks a framed author's-note (Unraveled
  case); idempotent re-mint drop; no-op when the book has no `author` or the author
  isn't on the roster.
- **Layer C** — `buildStage1ChapterInbox` renders the byline-author guidance + the
  narrowed first-person rule; skill-file parity assertion.
- **Integration regression** — a small first-person fixture with a byline run through
  the analysis path → final cast contains **no author-as-character** and the
  protagonist (not the author, not narrator) holds the dialogue. Mirrors the validated
  *Ночной дозор* observation.

## Open questions for the plan

1. Exact insertion point in `analysis.ts` for the Layer-B roster guard across the full
   **and** subset analysis entrypoints (it should ride the existing per-chapter
   roster-finalization / `mergeRosterChapter` path, before stage-2 runs for the
   chapter — not a separate end pass).
2. The bilingual author-note title pattern set's initial membership (start small,
   extend on real corpus data — same discipline as `GENERIC_ROLE_RU`).
3. Whether to emit a one-line analysing-view log when the guard drops an author, and
   whether to surface it in the change-log so a user can see why the author isn't cast.

## Shipped

- **Date:** 2026-06-20 · **Branch:** `fix/server-byline-author-cast-collision` · **Closes #938.**
- **Commits:** plan/spec `27a4c69b`, `e9d3f47b`, `5589a433`, `cd6a909d`; implementation `f8049ac7` (Layer A module) → `eff34609` (integration regression + review fix), 7 TDD tasks.
- **Build via subagent-driven execution:** adversarial plan review caught (and fixed) a cache-bypass bug — the guard was moved from the fresh-detection write to `rebuildRoster` + `buildInterimCast` so it covers a resumed / already-analyzed book. Empirically grounded on real `gemma4-e4b` + *Ночной дозор* (the byline author stole 8 of Anton's dialogue lines; removing it from the roster returned them to `anton`).
- **Open questions resolved in implementation:** (1) guard rides `rebuildRoster` (both entrypoints) + `buildInterimCast`, on the read path; (2) author-note pattern set seeded bilingual (`AUTHOR_NOTE_TITLE_RX` in `byline-author-guard.ts`); (3) a one-line analysing-view log is emitted when the guard drops an author.
- `npm run verify` green (typecheck + all tests + e2e + build); final whole-branch review (opus): ready to merge.
