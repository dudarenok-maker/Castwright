# Cast-time clone-readiness gate — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with a real sidecar and a real cloned voice. Do not pre-fill them.
>
> Plan of record: [`docs/features/276-cast-time-derivability-warning.md`](../features/276-cast-time-derivability-warning.md)
> Register row: [`onbox-acceptance-register.md` A31](onbox-acceptance-register.md)
> Issue: [#1980](https://github.com/dudarenok-maker/Castwright/issues/1980)

---

## 1. Purpose & scope

The gate's **verdict** is well covered by automated tests: a fixture table over
the predicate, a co-oracle contract test binding it to the render's own oracle
(`classifyClonedVoice`), adapter and selector tests, CTA-presence tests, and an
e2e walkthrough. None of that proves the thing the feature is actually for —
that **pressing the buttons repairs the render**. Every automated layer stops at
the API response. No suite derives an artifact or synthesises a line.

Two gaps, one structural:

- **`derive-failed` / "Retry derive" cannot be reached in mock mode at all.**
  `mockCloneVoice` unconditionally stamps `engines.qwen.status: 'ready'`, and no
  exported mock mutator can move a slot to `'failed'`. The e2e spec
  (`e2e/clone-readiness-gate.spec.ts`) therefore covers `no-transcript` plus the
  two silent controls and **cannot** cover this CTA. That is a property of mock
  mode, not an omission in the spec — it will not be closed by writing more e2e.
- **"Add transcript" is proven only to persist.** `voice-library.test.ts` asserts
  the write (including `sampleTranscript` and the language stamps). Nothing
  asserts a Qwen derive then *succeeds* against the corrected text, which is the
  CTA's entire premise.

Section 4 is the one that matters. Sections 3 and 5 are cheap and mostly
re-confirm what automation already says; skip them under time pressure and say
so, rather than skipping section 4.

## 2. Preconditions

- [ ] The 8 GB card, real TTS sidecar, real Qwen weights. Not mock mode.
- [ ] A real cloned voice with a real master clip, ingested **without** a
      transcript (`master.transcript === ''`).
- [ ] A book whose cast has at least one character that voice can be assigned to,
      plus one unrelated character as a control.
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

Rides along with **A1**'s cloning session — that already stages a real clone on
this card. Do not book a separate sitting for this.

## 3. The gate fires at cast time

1. Assign the transcript-less clone to a character while the session engine is
   **Coqui**. Expect 200 plus #1933's assign-time advisory.
2. Switch the session engine to **Qwen**. Do not touch the cast.
3. Press **Approve cast & start generating**.

Expected: the gate opens and names the character, the engine (Qwen), and the
missing transcript, and offers **Add transcript**.

Result: _______________________________________________

## 4. The fix actually fixes — the reason this row exists

4. Use **Add transcript**. Supply real text matching the clip. Save.

Expected: the gate clears for that character; re-opening shows no warning.

Result: _______________________________________________

5. **Render a chapter.** Confirm the cloned voice actually speaks on Qwen —
   i.e. the derive succeeded against the user-supplied text.

Record `characterSnapshots.<character>.resolvedVoiceName` from `state.json` —
it must be the clone's storage key. **The absence of an error is not the
observation**; a generic voice substituting silently would also produce no
error, and plan 276 invariant 4 says that must never happen.

Result (resolved voice key): ____________________________

Result (listened, sounds like the clone): ________________

## 5. `derive-failed` and the retry CTA

Reachable only here — see §1.

6. Force a genuine `failed` qwen slot: attempt a Qwen derive against an empty
   transcript on-box, so the 400 persists as `status: 'failed'`
   (`clone-voice-resolver.ts` is the only non-test writer of that value).
7. Open the gate. Expected: **derive-failed**, with **Retry derive**.
8. Press it, then re-open the gate.

Expected: the predicate re-evaluates to the **underlying** cause — with the
transcript still blank it must report `no-transcript`, **not** clear to healthy.
Plan 276 Decision 7 argues this is why the CTA cannot loop into "retry reports
success, render fails again"; nothing automated exercises it against a real
stamp.

Result: _______________________________________________

## 6. Control — the check is not simply always-on

9. Switch the session engine back to **Coqui** and press
   **Approve cast & start generating** with the same cast.

Expected: **no gate**.

This is not optional. Steps 3–8 pass equally well against a check that always
warns, which is the failure mode two earlier revisions of this plan actually
shipped.

Result: _______________________________________________

## 7. Outcome

- [ ] All sections run
- [ ] §4 run (the load-bearing one)
- [ ] Defects filed: ____________________________________

Record what was observed, by whom, and when — here and in the register row.
"Tests pass, so it's presumably fine" never discharges this row.
