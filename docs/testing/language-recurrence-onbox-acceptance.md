# Language recurrence + ambiguity prompt — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box. Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md`](../superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md)
> Plan of record: [`docs/superpowers/plans/2026-08-13-language-recurrence-and-prompt.md`](../superpowers/plans/2026-08-13-language-recurrence-and-prompt.md)
> Register rows: [`onbox-acceptance-register.md` B2](onbox-acceptance-register.md) —
> the sibling voice-design row, A43, is discharged (2026-08-26) and removed from
> the register; §§2-4 below (the voice-design half) are its historical record.
> Issue: [#2246](https://github.com/dudarenok-maker/Castwright/issues/2246)

---

## 1. Purpose & scope

This branch closes #2246 items 3 and 4: nothing can silently write or keep an
unstated book `language`, and when detection genuinely cannot decide, the user
gets a way to set one. Automated coverage (per-tier unit tests, the static
seam guard with its neutralisation proof, and RTL/Playwright for the frontend
prompt) proves the mechanism against mocks. Two things only real hardware can
show:

- **§2 — the analysis gate**, needs a **live local analyzer** (Ollama or
  Gemini): that an unset book is actually refused at analysis, that the
  prompt genuinely unblocks it, and that the analyzer then picks the
  language's own dialogue conventions rather than the English default.
- **§3 — the voice-design gate**, needs a **live Qwen sidecar**: that the
  three voice-design routes (`cast-design`, `qwen-voice`, `single-design`)
  refuse before ever opening a sidecar connection on an unset book, and design
  normally once the language is set.

Run both sections; they use different preconditions and can be split across
sittings if the box is contended.

## 2. Preconditions

- [ ] A real local Ollama daemon (or a Gemini key) reachable by the server —
      no analyzer mocking.
- [ ] A book (or the ability to produce one) with `language: null` on disk —
      e.g. import with detection surrendered and "Decide later" selected, or
      any of the R2/R3/R5 paths (bundle import, backup restore, sample
      install) carrying no `language`.
- [ ] A second, short non-English book with dash-opened dialogue (a Russian
      chapter is the calibrated case — see #2325's dialogue-collapse guard)
      to exercise the conventions-table check in §2.
- [ ] For §3: a live, Qwen-capable TTS sidecar, single 8 GB card is enough.
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

## 3. §Analysis language gate — register row B2

1. Confirm the test book's `state.json` carries `language: null` (not
   `"en"`, not absent-and-defaulted — an explicit `null`).
2. Start analysis on the book through the normal UI/API path (not a
   detached script).

   Expected: the request is refused before the analysis job detaches — a
   `409` with `{ error: 'language_unset' }` (or the client-visible
   equivalent), not a silently-started English analysis.

   Result: _______________________________________________

3. Resolve the language through the prompt — the library's "unset"
   affordance → Book settings language row, or the confirm-screen re-entry
   if the book is still at that stage.

   Result (prompt reachable, language set): ________________

4. Re-start analysis on the same book against the live analyzer.

   Result (analysis proceeds, no gate this time): __________

5. **The conventions-table check — the reason this row exists.** On the
   non-English (Russian) fixture from Preconditions, once its language is
   confirmed set, run a real analysis and confirm dash-opened dialogue lines
   are attributed to the speaking character, not the narrator —
   `conventionsFor('ru').dialogueOpen` actually reached the attribution
   pass. Record the narrated-speech percentage if convenient (compare
   against #2325's calibrated bands: healthy well under 60%, collapsed well
   over).

   Result (dialogue attributed correctly, not to narrator): __________

## 4. §Voice-design gate — register row A43 (discharged 2026-08-26, removed from the register)

6. Using the still-unset book from §3 step 1 (or a fresh one), and with the
   live Qwen sidecar running, attempt **Design full cast** (cast-design).

   Expected: refused with `{ type: 'error', code: 'language_unset' }` in
   the route's existing streaming envelope. Check the sidecar's own log —
   there must be **no** new connection/design attempt logged for this
   request.

   Result: _______________________________________________

7. Attempt a single-character design via **qwen-voice**.

   Result (refused, no sidecar attempt): __________

8. Attempt a standalone design via **single-design**.

   Result (refused, no sidecar attempt): __________

9. **Control — set the language and repeat all three.** Set the book's
   `language`, then repeat steps 6-8 against the same book.

   Expected: all three design normally end-to-end through the live sidecar
   — the gate must not fire, and no regression in ordinary design flow.

   Result (cast-design): __________
   Result (qwen-voice): __________
   Result (single-design): __________

## 5. Outcome

- [ ] §3 run (register row B2)
- [ ] §4 run (register row A43, discharged 2026-08-26, removed from the register)
- [ ] Defects filed: ____________________________________

Record what was observed, by whom, and when — here and in the register rows.
"Tests pass, so it's presumably fine" never discharges this row.
