# Aligner dash-invariance + anchor hardening — design

Status: approved for planning
Date: 2026-08-21
Issue: [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
Supersedes: the implementation on `fix/server-2537-dash-invariant-align` (PR
[#2577](https://github.com/dudarenok-maker/Castwright/pull/2577)) as it stands
at commit `9262412a` — see "Disposition of PR #2577" below.

## Problem

`alignSentences` and `locateSentenceOffsets`
(`server/src/analyzer/dialogue-structure/aligner.ts`) locate each sentence in
a chapter's raw body by substring-searching a "needle" built from the
sentence's cached, normalized `text`. An upstream stage sometimes strips a
sentence's leading paragraph-dash marker before caching it and sometimes
doesn't — an inconsistency in the cache, not a property of the sentence
itself. Today's needle construction (`normalize(s.text)`, no dash handling)
inherits that inconsistency: the SAME sentence can locate a different raw
span depending on which cache form happened to be stored. Confirmed on real
data: 22 of 23 books in the local library are unaffected, but the 23rd —
*Ночной дозор*, a dash-dialogue-dense Russian novel — shows 14 fields diverge
when its cache is compared straight vs. with every leading dash stripped
(`docs/testing/onbox-acceptance-register.md`, E11 §item 2).

Three implementation attempts on `fix/server-2537-dash-invariant-align` have
each failed an independent PR review:

1. **Unconditional strip** (`40bee7ff`) — strips the leading dash from every
   needle regardless of the cache form. This provably restores invariance
   (see "Why unconditional stripping is sufficient for invariance" below),
   but an independent review found a synthetic case where the now-shorter
   needle for a short dash-led reply (e.g. `"— Да."` → `"да."`) falsely
   matches inside unrelated text (`"да"` inside `"правда"`) in a run with no
   trustworthy anchor nearby. Rejected before an on-box run.
2. **"Keep the dash if the cache had one"** (`6dddbdc0`) — turned out to be a
   literal identity transform (`hadLeadingDash[i] ? t : t.replace(...)`
   returns `t` on both branches), i.e. no different from `main`. Confirmed
   both synthetically (0 diffs across 6,610 sentence evaluations on 6
   generated fixtures) and by a real on-box re-run against *Ночной дозор*
   (identical 14-field divergence, unchanged).
3. Same no-op pattern applied to `locateSentenceOffsets` (`3053f5dd`).

## Why unconditional stripping is sufficient for invariance

If needle construction is *always* `normalize(s.text).replace(/^-\s*/, '')`
— no branch on whether the cached text happened to carry the dash — then for
the same underlying sentence, a cache copy that kept the dash and one that
had it stripped upstream produce **byte-identical needles**, unconditionally,
by construction: `normalize("— Да.").replace(/^-\s*/, '') ===
normalize("Да.").replace(/^-\s*/, '')`. `locateNeedles` is a pure function of
the needle array and the haystack, so the entire `alignSentences`/
`locateSentenceOffsets` output is then guaranteed identical between the two
cache variants. That is exactly what E11 item 2's acceptance check measures
(straight run vs. dash-stripped-cache rerun, diffed field-by-field) — this
closes it by construction, independent of whether any individual match is
*correct*. Invariance and match-correctness are different properties; only
the first is what #2537 asked for. This is why attempt 1 was directionally
right and was rejected only for a separate, real concern (below), not for
failing invariance.

## The separate concern: false-match risk in sparse-anchor runs

The file already has a robustness mechanism for short/common needles:
`#2187`'s two-pass anchor system. Needles ≥ `ANCHOR_MIN_LEN` (24 normalized
chars) become "anchors" in a first pass (`findAnchors`) and bound a monotonic
cursor; every shorter needle is resolved in a second pass (`fillRun`),
strictly confined to the interval between its two neighboring anchors — the
file's docstring calls this "structurally impossible" to escape, **provided
anchors exist reasonably close on both sides**.

Attempt 1's rejected regression only reproduces in a run with **no anchor at
all** — e.g. a stretch of a book that's almost entirely short dash-led
dialogue with no long narration nearby, which is *Ночной дозор*'s apparent
profile. In that degenerate case Pass B's search is effectively unbounded
over the whole run, and a short needle can bind to the wrong occurrence of
common text. The independent review also showed "keep the dash to dodge this"
is not real protection (a differently-shaped decoy defeats it too) — the
dash's presence in the needle was never the actual safety mechanism; anchor
density is.

Separately, `findAnchors`' own code comment already documents an adjacent gap:
anchors are chosen by length alone with **no uniqueness check**, so a
duplicated ≥24-char sentence can still mis-anchor at the wrong occurrence and
strand the rest of its run — "a uniqueness check on anchor candidates is the
fix if this ever shows up in a real corpus." Per discussion this session, this
design closes that gap in the same pass rather than filing it separately,
since the mechanism (a uniqueness check) is shared with the sparse-run fix
below.

## Design

### 1. Needle construction (invariance, both functions)

In both `alignSentences` and `locateSentenceOffsets`, replace the current
branching needle construction with:

```ts
const needles = sentences.map((s) => normalize(s.text).replace(/^-\s*/, ''));
```

Unconditional — no `hadLeadingDash` branch, no per-sentence conditional. This
is a deliberate behavior change from `main` (which never strips), and from
attempts 1–3 (which either kept the dash or produced a no-op). Delete the
current stale doc comments in both functions describing the "keep the dash if
present" mechanism (PR #2577 review finding N2) — they describe a mechanism
this design replaces, not modifies.

### 2. Backward-extension over the raw dash (both functions, unconditional)

The existing backward-extension logic (extend a located match's raw start
back over a paragraph-leading `-`/`–`/`—` + optional whitespace, only when it
immediately precedes the match at the start of a line) is kept, but is no
longer gated on a `hadLeadingDash` flag — apply it to every located match. It
is already self-gating (it only fires when a dash literally precedes the
match at a line start in the RAW body), so it correctly no-ops for sentences
whose raw manuscript line never had a dash, and correctly recovers the dash
for ones that do — regardless of what the cache happened to store. Extend
`locateSentenceOffsets`'s version identically (today it has no
backward-extension logic in the reference no-op implementation on the
current branch; add it so the two functions genuinely share semantics, per
each one's own docstring claim).

Also fix the dash-glyph coverage in the extension's own regex: it currently
recognizes `[-–—]` (3 of the 5 dash forms this file's own `normalize()`
already canonicalizes — see `buildNormalizedMap`'s `&mdash;`/`&ndash;` and
2+-hyphen-run handling). Match on normalized output, not a fresh raw-text
regex, or explicitly enumerate all 5 forms — implementer's choice, but the
gap must close (PR #2577 review finding, minor but folded in since this
section is being rewritten anyway).

### 3. Anchor hardening — unify the eligibility rule

Replace `findAnchors`' single-condition eligibility (`needle.length >=
ANCHOR_MIN_LEN`) with two conditions, both required:

- `needle.length >= SPARSE_ANCHOR_MIN_LEN` — a new, lower constant. Well
  above the ~3–5 normalized chars of the highest-frequency ultra-short
  replies ("да.", "нет."), so those never enter the new eligibility band and
  never pay the extra scan.
- **Uniqueness**: after `findMatch` locates a candidate at `pos`, confirm no
  second occurrence exists later in the haystack
  (`haystack.indexOf(needle, pos + needle.length) === -1`). If a second
  occurrence exists, the candidate is ambiguous — skip it (leave it for Pass
  B), do not anchor on it.

This single rule does two things: needles in the new `[SPARSE_ANCHOR_MIN_LEN,
ANCHOR_MIN_LEN)` band can now anchor in previously-sparse runs (shrinking the
unbounded intervals Pass B searches), and needles at or above `ANCHOR_MIN_LEN`
now also require uniqueness, closing the documented duplicate-anchor gap for
every book, not just dash-dense ones.

`SPARSE_ANCHOR_MIN_LEN`'s exact value is an implementation/tuning detail, to
be set via the real-data validation in Testing below rather than guessed here
— start from a candidate around half of `ANCHOR_MIN_LEN` (~12) and adjust
based on how much it actually shrinks unbounded-run exposure on the validation
chapter without materially changing runtime.

### Explicit residual (not closed by this design)

A run where every sentence's needle recurs elsewhere in the chapter (e.g. an
exchange consisting entirely of duplicated one-word replies with nothing
distinctive nearby) can still have zero eligible anchors and falls back to
today's effectively-unbounded Pass B search for that stretch. This is a
pre-existing `#2187`-class limitation this design narrows but does not fully
close, and it is not worse than `main`'s current behavior for that run. State
this in the code (matching the file's existing "KNOWN RESIDUAL" comment
pattern in `findAnchors`) and in the PR body — do not claim full closure.

### Disposition of PR #2577

Rework the existing branch (`fix/server-2537-dash-invariant-align`) and PR
(#2577) in place rather than opening a new one — same issue, same review
history worth keeping visible. The three prior commits' needle-construction
and backward-extension logic should be replaced outright (not incrementally
patched) per the design above; the bookkeeping commits (release notes,
on-box register note) stay and get amended/extended once the real fix lands
and is validated, not re-litigated from scratch.

## Testing

1. **Invariance property test** (both functions): generate sentence pairs
   where one form carries a leading dash and the other has it stripped
   (parameterized over a handful of realistic dash glyphs, not just ASCII
   `-`), assert the two produce byte-identical needles. Also assert the
   with-dash needle differs from naive `normalize(s.text)` — this second
   assertion is what would have caught attempt 2 immediately, since its "fix"
   was a literal identity transform on that exact case.
2. **Regression test** for the attempt-1 repro (`"— Да."` vs. decoy `"правда"`
   in a near-zero-anchor run) and the reviewer's N4 decoy variant — document
   in the test whether anchor hardening resolves these specific fixtures or
   whether they still fall into the stated residual (both are legitimate
   outcomes; the test's job is to pin down which, not to assume).
3. **Anchor-uniqueness unit tests**: a duplicated ≥24-char sentence no longer
   silently mis-anchors on the wrong occurrence; a moderate-length
   (`SPARSE_ANCHOR_MIN_LEN`–`ANCHOR_MIN_LEN`) unique sentence in a sparse run
   now anchors where it previously wouldn't have.
4. **Real-data validation (required before merge, not deferred to on-box
   acceptance)** — GPU-free, per the #2187 plan's own reproduction recipe
   (`docs/features/247-dialogue-structure-attribution.md`): load the cached
   stage-2 sentences from `server/handoff/cache/mns_oyK7Po6BiT.json`
   (*Ночной дозор*), pick **one chapter** (not the whole book, per this
   session's direction) — whichever the E11 register note's per-chapter
   column shifts show as most affected (candidates: chapters 1, 6, 7, or 8;
   confirm which empirically rather than guessing) — parse it with the
   production parser and run `alignSentences`/`locateSentenceOffsets` both
   straight and against a scratch copy with every leading dash stripped from
   the cached text. Assert the two runs are now field-identical on that
   chapter, and that `alignedPct` does not regress relative to `main` on the
   same chapter. This directly targets the gap that let all three prior
   attempts look green while shipping a no-op or a rejected regression — bake
   it into the PR as a script under `scripts/` (or a throwaway harness
   documented in the PR body, implementer's call), not left to a separate
   on-box campaign.
5. Existing `aligner.test.ts` / `scene-breaks.test.ts` suites must stay green;
   `locateSentenceOffsets`'s docstring claim of sharing `alignSentences`'
   semantics (fuzzy fallback excepted) must actually hold after this change —
   verify by construction (shared logic/helper) or by an explicit parity
   test, implementer's choice.

## Out of scope

- Approach C from the design discussion (composite-needle localization for
  consecutive short dialogue blocks) — a stronger but substantially more
  complex mechanism, left as a follow-up if the real-data validation shows
  the residual above is still hit often enough to matter.
- Approach B (uniqueness-gated matching for *every* short needle in *every*
  book, not just sparse-anchor runs) — broader blast radius than this design
  accepts; not pursued.
- Any change to the upstream stage that inconsistently strips the dash before
  caching — this design makes the aligner tolerant of that inconsistency, it
  does not fix the inconsistency's source.
