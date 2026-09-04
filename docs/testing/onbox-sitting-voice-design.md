# On-box sitting pack — Qwen VoiceDesign, bulk cast design & audition (A4, A6, A7, A11, A20)

> **Sitting pack** for wave 2 of `#2435`, step 3 of the `#2453` chain. Covers
> register rows **A4, A6, A7, A11, A20** — the rows a human has to
> **listen to**: Qwen VoiceDesign persona/A/B audition, bulk cast design, the
> emotion-chip manuscript preview, cross-engine audition fidelity, and the
> golden-audio bless guards. (Two rows this sitting pack originally covered —
> the persona-prompt rewrite and the emotion-chip preview — are discharged
> 2026-08-26 and removed from the register; their sections below are kept for
> the historical run record.) Follows the shared format fixed by
> [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §5; the re-resolution rule
> of §6 was applied to every row (see
> [`## Excluded on re-resolution`](#excluded-on-re-resolution) — nothing was
> excluded).
>
> **Box/card target:** the operator's GPU box, **single 8 GB card**, pinned via
> `CUDA_VISIBLE_DEVICES=0`. Qwen VoiceDesign is warm-resident coming in from
> the preceding VRAM-contention sitting (`onbox-sitting-vram-contention.md`)
> per the plan of record's suggested order (§4 item 3); this pack does not
> depend on that residency surviving, but reuses it if present.
>
> **Running time total (recomputed 2026-08-20):** **155 minutes** — A4 ≈ 15,
> A6 ≈ 20, A7 ≈ 30, A14 ≈ 15, A15 ≈ 15, A17 ≈ 15, A27 ≈ 45. Sum = 155,
> matching the plan of record's stated total for this pack
> ([`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.1) exactly — all seven
> rows re-resolved as still owed, so nothing changed the arithmetic.

## Preconditions

Stated once for the sitting; do not repeat per row.

- [ ] **Single 8 GB card.** `CUDA_VISIBLE_DEVICES=0`; `nvidia-smi` lists the
      4070 8 GB as `cuda:0`. If the box policy pins renders to `cuda:1` (the
      16 GB card, owner's call since 2026-08-01, git-ignored `server/.env`),
      temporarily set `QWEN_DEVICE=cuda:0` / `COQUI_DEVICE=cuda:0` for this
      sitting and restore in teardown — everything here targets the 8 GB card.
- [ ] **Server started via `start-prod.bat`**, not a dev launcher — A6's
      forced-recycle check specifically needs the `.env` ceilings that only
      this launch path applies.
- [ ] **A Qwen project/book with a multi-voice cast** (≥3 characters, at least
      one with no persona yet and one already carrying an old-format persona
      pre-dating plan 160's rewrite) — needed for A6, A7 and A14's "compare
      against a character still on an old-format persona" step. A sibling book
      in the same series, for A7's series-propagation check.
- [ ] **Engines available and loadable from the UI:** Qwen VoiceDesign (0.6B
      and 1.7B tiers), Coqui XTTS, Kokoro (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx`
      + `voices-v1.0.bin` on disk, sidecar venv bootstrapped) — A4 needs all
      three plus both Qwen tiers in the same session; A27 needs Kokoro
      specifically.
- [ ] **A book set to the 1.7B tier** and a book/character overridden to
      Kokoro inside a Coqui book (A4's tier/engine-override checks).
- [ ] **A manuscript with a Qwen-voiced character carrying a designed `angry`
      emotion variant**, and the ability to remove/re-add that variant (A17).
- [ ] **A second browser tab/session** (A7's 2nd-tab serialization check).
- [ ] **A way to genuinely oversubscribe VRAM with Coqui resident** — e.g.
      hold the card near capacity with a concurrent Qwen load — to force a
      real capacity refusal (A4's fourth check).
- [ ] **A way to force a sidecar `/recycle` mid-run** (A6) — the existing
      recycle trigger the bug (#690) was filed against; the register names no
      dedicated endpoint beyond letting the sidecar's own recycle ceiling
      fire, so use whatever forces a recycle during a live bulk-design run
      (e.g. hold the sidecar near its committed-memory ceiling, or the
      supervisor's own forced-restart path if the box exposes one).
- [ ] **`npm run test:golden-audio`** runnable from the worktree/repo root,
      and the box **quiet** for A27 — `nvidia-smi` shows no concurrent GPU
      work when that step runs (its own `--bless` contention warning should
      print nothing).
- [ ] **Permission to hand-edit a committed baseline JSON** for A27's forced-
      refusal drills, with a plan to revert the hand-edit before committing
      anything.
- [ ] **One shell** for server/CLI control; a second free for `nvidia-smi` /
      log tailing.

## Procedure

Ordered so the bulk-design (Qwen-heavy) rows run first while the cast/session
setup is fresh, the single-voice persona/A/B/emotion rows follow on the same
Qwen residency, the multi-engine audition row (A4) comes next since it is the
one point this sitting swaps into Kokoro/Coqui/tier variations, and the
golden-audio bless row (A27) — which needs Kokoro alone on a **quiet** card —
runs last, after everything else is evicted.

### A6 + A7 · Bulk voice-design recycle resilience (plan 200) + Design full cast (plan 195) — steps 1–3

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> A6 `:719-730`, A7 `:732-741`; ship notes in
> `docs/features/200-bulk-design-recycle-resilience.md` and
> `docs/features/195-design-full-cast.md`.
> Re-resolved 2026-08-20: `gh issue view 690` → closed 2026-06-09T21:29:55Z,
> title matches ("Design full cast halts after the first voice (sidecar
> recycle not recovered)"); plan 200's own Ship notes read verbatim "Live-GPU
> acceptance (restart via `start-prod.bat`...) is the only remaining check" —
> unchanged, no later commit touches the file. `gh pr view 637` → merged
> 2026-06-07T11:37:03Z; `gh pr view 638` → merged 2026-06-07T11:57:28Z (fills
> the SHA only); plan 195's Ship notes still read "Live-GPU acceptance owed"
> verbatim, unedited by #638 beyond the SHA. Both STILL OWED. Run together —
> they exercise the same "Design full cast" bulk flow, so a single session
> covers both rather than re-warming the cast twice.

1. **(A7.1) Bulk "Design full cast" run — pill, navigation, reload-resume,
   terminal summary.** From the cast view of the prepared multi-voice
   project, click "Design full cast." Observe: the DesignPill shows
   "Designing," **survives navigating away and back**, and **survives a
   full page reload started mid-run** (the run resumes rather than
   restarting or silently dying). Let it run to completion and observe the
   terminal summary reads "Designed N · M failed · K skipped" with counts
   that add up to the cast size, and every row flips to "Designed."
   - Result:
2. **(A7.2) Series propagation, 2nd-tab serialization, VRAM headroom,
   re-analysis guard.** Confirm the same designed persona/voice propagates
   to the **sibling book** in the series (no independent re-design there).
   From the **second browser tab**, start a single-character design while
   the bulk run from another tab is still in flight (or immediately after)
   and confirm it **serializes** — no garbled/overlapping audition, no
   corrupted `.pt`. Watch `nvidia-smi` across the whole bulk run (VoiceDesign
   1.7B + a resident analyzer is the exact combination that caused the
   plan-108 OOM) and confirm headroom holds — no OOM, no forced eviction that
   interrupts the run. Then attempt a re-analysis of the same book mid- or
   post-design and confirm it is refused with **409**, not silently
   clobbering the just-designed voices.
   - Result:
3. **(A6) Forced `/recycle` mid-bulk-design.** With the sidecar started via
   `start-prod.bat` (Preconditions), start another "Design full cast" run
   (or continue one in flight) and force a sidecar `/recycle` partway
   through. Observe: the DesignPill **rides through the respawn** — it does
   not stall, hang, or silently drop the remaining characters — and the run
   completes with a correct terminal summary once the sidecar comes back.
   - Result:

### A14 · Real-book QA/badge agreement after the loudness measurement hoist (plan [274](../features/archive/274-loudness-measurement-provenance.md), [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922), [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923))

> **Register row: A14 — discharged 2026-08-26, row removed from the register**
> (owner-confirmed live observation: the rewritten pitch/purpose-clause wording
> changes the rendered voice on a real audition).

> **Criteria source:** `docs/features/160-voicedesign-persona-format.md`
> `:88-98` (manual acceptance walkthrough), `:9` (Status line), `:132-136`
> (Ship notes, still the unfilled placeholder). Re-resolved 2026-08-20 by
> direct read of the plan file: frontmatter `status: active`, body `> Status:
> active — code shipped, GPU audition validation owed to the user` (`:9`),
> Ship notes still literally "(Filled in when status flips to `stable`...)" —
> unchanged. The 2026-06-16 age-audibility follow-up (`ca4b4a93`) is a real,
> separately-landed fix informed by an informal listen, but it addresses a
> narrower defect (age not translated to acoustics) and does not substitute
> for the three-step walkthrough below — the plan's own text still lists it
> as owed. STILL OWED.

4. **(A14.1) Regenerate a persona.** On a Qwen character, hit "Regenerate
   voice style" (Profile drawer, or
   `POST /api/books/:bookId/cast/:characterId/voice-style/generate`).
   Observe the persona text: a full sentence, ~15–40 words, containing a
   pitch word and ending in a purpose clause (not a bare adjective list).
   - Result:
5. **(A14.2) Design → audition → A/B against the old format.** Design the
   voice from that regenerated persona and audition it. **Listening target:**
   compare it directly against a character still on an old-format (pre-plan-
   160) persona in the same session — you are listening for the new
   pitch/purpose-clause wording to produce an audibly different, more
   deliberate-sounding voice than the old flat-attribute phrasing, not merely
   "a voice." Confirm the cached `instruct` field at
   `voices/qwen/<voiceId>.json` matches the new persona text.
   - Result:
6. **(A14.3) Un-regenerated character unaffected.** Play a character whose
   persona was **not** regenerated this session. **Listening target:**
   confirm it plays its pre-existing designed voice unchanged — no silent
   drift in an existing book's cast just from this rewrite being live.
   - Result:

### A11 · A/B "current vs proposed" voice audition (plan 161) — steps 7–9

> **Criteria source:** `docs/features/161-voice-design-compare.md` `:100-109`
> (manual acceptance walkthrough), `:9` (Status line), `:117-121` (Ship
> notes, unfilled placeholder). Re-resolved 2026-08-20 by direct read: same
> pattern as A14 — frontmatter `status: active`, body `> Status: active —
> code shipped, GPU audition validation owed` (`:9`), Ship notes still the
> literal placeholder. `git log` on the plan file shows one commit only
> (`6fb41b7a`), nothing since. STILL OWED. Register row A15 states this
> explicitly: **"A non-destructive re-design — Cancel must leave the live
> `.pt` untouched — plus an audible delta on approve."** Directly downstream
> of A14; run in the same session.

7. **(A15.1) Open the A/B modal, play both sides.** Profile drawer → "Design
   & compare." Confirm Side A plays the **current** voice, Side B the
   **proposed**. Edit the persona on Side B → Re-design → audition again.
   **Listening target:** an audible delta between Side A and the freshly
   re-designed Side B — not identical audio with a different waveform file.
   - Result:
8. **(A15.2) Cancel is genuinely non-destructive — test it, don't assume it.**
   Before cancelling, note the live `qwen-<id>.pt`'s mtime/checksum and play
   it once as a baseline. Re-design Side B again, then **Cancel** instead of
   approving. Observe and record, explicitly:
   - the live `qwen-<id>.pt` mtime/checksum is **unchanged** from the
     pre-cancel baseline (only `qwen-<id>-preview.*` was written, then
     discarded — confirm it is gone or was never promoted);
   - the character's voice **plays and sounds identical** to the pre-cancel
     baseline recording — this is the audible half of "non-destructive," not
     just a file-timestamp check.
   - Result:
9. **(A15.3) Approve, save, render — the new voice is actually used.** Redo
   the re-design, this time click "Use proposed voice" → Save → generate a
   chapter using that character. **Listening target:** the rendered chapter
   audibly uses the **proposed** (Side B) voice, not the original — confirm
   against the Side B audition played in step 7.
   - Result:

### A17 · `/health` stays live through a contended eviction on the default Qwen path (plan [273](../features/archive/273-sidecar-lock-event-loop.md), [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919)) · **single 8 GB card**

> **Register row: A17 — discharged 2026-08-26, row removed from the register**
> (owner-confirmed live observation: the audible delta between a designed
> variant and the base voice, on a real sidecar).

> **Criteria source:** `docs/features/180-fe31-emotion-chip-preview.md`
> `:41-48` (manual walkthrough + live-GPU acceptance line), `:9` (Status
> line), `:55-57` (Ship notes, unfilled placeholder). Re-resolved 2026-08-20
> by direct read: frontmatter `status: active`, body `> Status: active`
> (`:9`), Ship notes still the bare placeholder "(Filled in when status flips
> to `stable`.)" Body text `:48` states verbatim: "**Live GPU acceptance
> owed:** the audible difference between a designed variant and the base
> voice can only be confirmed on a real sidecar." STILL OWED.

10. **(A17) Designed variant vs. base voice, by ear.** In the manuscript view,
    flip the speaking character to Qwen with its designed `angry` variant
    present, tag a dialogue line `angry`, and press the ▶ preview next to
    the chip. **Listening target:** the designed `angry` variant's
    intonation/delivery should be audibly angrier than the character's base
    voice — not a neutral read with a different filename. Then remove the
    `angry` variant and press ▶ again: **Listening target:** it now falls
    back to the base voice (calm/neutral relative to the first play), and
    the UI shows the "no angry variant for `<name>` — renders neutral" note.
    Switch the character to Kokoro and confirm ▶ is disabled with the
    "Emotion only audible on Qwen" tooltip (mock-mode-covered, but confirm
    it holds against the real cast state too).
    - Result:

### A4 · Audition engine + tier fidelity (#1849) — steps 11–14

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> `:690-703`. Re-resolved 2026-08-20: `gh pr view 1849` →
> `{"mergedAt":"2026-07-26T21:39:59Z","state":"MERGED","title":"fix(frontend,server):
> audition in the character's engine at the book's tier"}` — matches. No run
> sheet or issue references an on-box listening pass since. All four checks
> are audio-output/perceptual by construction — "never listened to" is
> accurate. STILL OWED.

11. **(A4.1) Engine-override preview.** In a Coqui-default book, override one
    character to Kokoro and press Preview on that character. **Listening
    target:** the stock Kokoro timbre (Kokoro's own catalogue voice) plays —
    audibly distinct from the book's default Coqui voice — confirming the
    preview honours the character-level engine override rather than the
    book's engine.
    - Result:
12. **(A4.2) Tier fidelity at 1.7B.** In a book set to the 1.7B tier, press
    Preview on a Qwen character. Confirm via the sidecar/server log or
    response metadata (`modelKey`/tier field) that the **1.7B** model served
    the request, not 0.6B — the two tiers are not reliably distinguishable
    by ear alone, so this check is instrument-confirmed, not by-ear.
    - Result:
13. **(A4.3) Instant-replay cache.** Design a voice in My voices, then press
    Play. **Observe:** the first play is **instant** — no visible/audible
    synthesis wait — and the network/server log shows only **one** synth
    call, not two (the design pass and the play pass now hash to the same
    cached filename, where before they diverged). Record the elapsed time to
    first audio.
    - Result:
14. **(A4.4) Capacity-refusal message names Coqui.** With Coqui resident,
    force a genuine capacity failure (oversubscribe VRAM per Preconditions).
    **Observe:** the error names **Coqui** specifically and points at where
    its Stop button is — not a generic "free VRAM" message.
    - Result:

### A20 · Golden-audio bless guards + `_make_kokoro` against a real engine (PR #2032) — steps 15–18

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> `:1412-1518` (full procedure already spelled out there — cited, not
> restated in full, except where a step needs the exact command). Re-resolved
> 2026-08-20: `gh pr view 2032` →
> `{"mergedAt":"2026-07-31T23:19:54Z","state":"MERGED"}`; `gh issue view
> 1995/2003/1987` → all closed 2026-07-31T23:19:56Z; the amendment chain
> `gh issue view 2069`/`2062` → both closed 2026-08-05T03:37:30Z — all match
> the row's own text. No later issue/PR/run-sheet references `--bless`,
> `IDENTITY_COSINE_EPSILON`, or `_make_kokoro` since. STILL OWED. Run this
> **last**, on a **quiet** card — evict every engine from the rows above
> first (see Teardown-before-A27 note below), because this row's own
> contention warning must print nothing for the run to mean anything.

> **Evict everything from A4–A17 before starting this row.** Stop Qwen,
> Coqui, and any resident analyzer; confirm `nvidia-smi` ≈ idle. A27 does not
> need CUDA (`ASR_DEVICE=cpu`/CPU Kokoro also exercises it) but does need the
> card **uncontended** for a stable, reproducible measurement.

15. **(A27.1) Clean bless run, byte-identical + noise-echo.** Run
    `npm run test:golden-audio -- --bless --sidecar-only` on the now-quiet
    box (confirm `nvidia-smi` first — the `--bless` contention warning
    should print **nothing**). Confirm it completes and writes
    `kokoro-baseline.json` / `instruct-baseline.json` **without** any of
    `GOLDEN_REBLESS_CONTENT=1` / `GOLDEN_REBLESS_THRESHOLDS=1` /
    `GOLDEN_REBLESS_MEASUREMENTS=1` set. **Observe two things, not one:**
    (a) `git diff` on both baseline files shows `transcript`/`text_edits`,
    the `tolerances` block, and the `identity`/`loudness_dbfs` figures all
    staying **byte-identical**; (b) the console **echoes** a
    `[golden-bless] identity moved within epsilon ... (noise -- reference
    unchanged) -- ...` / `[golden-bless] loudness_dbfs moved ...` line
    whenever this run's raw measurement differs at all from the committed
    figure. A byte-identical diff with **no echo** is not proof the guard
    fired — real hardware noise makes a nonzero diff near-certain, so the
    echo is the falsifiable signal, not the byte-identical file alone.
    Record the actual **per-leaf identity-cosine deltas** observed (the
    open #2066 question this run is meant to retire) — not just pass/fail.
    - Result:
16. **(A27.2) Force a real refusal — corrupted field.** Hand-edit a committed
    baseline to null out its `transcript` (or delete its `tolerances` key),
    re-run the same `--bless` command, and confirm it **refuses** with the
    expected `GOLDEN_REBLESS_*` message and leaves the file byte-identical
    to before the attempt. Revert the hand-edit immediately after recording
    the result.
    - Result:
17. **(A27.3) Force a real refusal — WINDOW-sized identity drift.** Hand-edit
    one committed `instruct-baseline.json` `identity.cosine.<emotion>`
    figure by clearly more than `IDENTITY_COSINE_EPSILON` (e.g. +0.05),
    re-run the same `--bless` command, and confirm it refuses with
    `GOLDEN_REBLESS_MEASUREMENTS` specifically (not `GOLDEN_REBLESS_THRESHOLDS`,
    which is reserved for `tolerances`), and leaves the file byte-identical.
    Revert the hand-edit immediately after recording the result.
    - Result:
18. **(A27.4) `_make_kokoro` fails, not skips, on a real broken engine.** Run
    `npm run test:golden-audio -- --sidecar-only --engine=kokoro -m golden`
    once normally (expect pass). Then deliberately break the engine — rename
    the `.onnx` weight file mid-run, or force a CUDA OOM by holding VRAM —
    and confirm the run now **FAILS**, not SKIPs (the #1987 defect this PR
    closed). Restore the weights/state afterward and confirm a clean run
    passes again.
    - Result:

## Excluded on re-resolution

None excluded. All seven rows were re-resolved against live repo/issue/PR
state and the plan-of-record files themselves on 2026-08-20 and remain owed:

- **A4** — `gh pr view 1849` → merged 2026-07-26T21:39:59Z, title matches.
  No on-box listening pass recorded since. STILL OWED.
- **A6** — `gh issue view 690` → closed 2026-06-09T21:29:55Z, title matches;
  plan 200 Ship notes re-read verbatim, unchanged: "Live-GPU acceptance... is
  the only remaining check." STILL OWED.
- **A7** — `gh pr view 637` → merged 2026-06-07T11:37:03Z; `gh pr view 638` →
  merged 2026-06-07T11:57:28Z (SHA-fill only); plan 195 Ship notes re-read
  verbatim, still "Live-GPU acceptance owed," unedited by #638 beyond the
  SHA. STILL OWED.
- **A14** — plan 160 frontmatter `status: active`, body `:9` re-read
  verbatim ("code shipped, GPU audition validation owed to the user"), Ship
  notes still the literal unfilled placeholder. The 2026-06-16
  age-audibility follow-up is real but narrower than the full walkthrough
  and does not discharge it (the plan's own text still lists the walkthrough
  as owed). STILL OWED.
- **A15** — plan 161 frontmatter `status: active`, body `:9` re-read verbatim
  ("code shipped, GPU audition validation owed"), Ship notes still the
  literal unfilled placeholder; `git log` shows one commit only, nothing
  since. STILL OWED.
- **A17** — plan 180 frontmatter `status: active`, body `:9` re-read verbatim
  (`active`), Ship notes still the bare placeholder; body `:48` re-read
  verbatim ("Live GPU acceptance owed: the audible difference... can only be
  confirmed on a real sidecar"). STILL OWED.
- **A27** — `gh pr view 2032` → merged 2026-07-31T23:19:54Z; `gh issue view
  1995`/`2003`/`1987` → all closed 2026-07-31T23:19:56Z; amendment chain
  `gh issue view 2069`/`2062` → both closed 2026-08-05T03:37:30Z. No later
  bless run, per-leaf delta measurement, or forced-Kokoro-failure run
  recorded anywhere since. STILL OWED.

None of the seven rows is AMBIGUOUS (that is A2/A16's queue, not this
pack's — the former A22 this note also used to name was retired 2026-08-21,
see `onbox-acceptance-register.md`'s wave-4 correction note) — every plan
file's frontmatter and body `Status:` line agree with
each other for A4, A6, A7, A14, A15, A17 and A27, unlike A16's genuine
frontmatter-vs-body contradiction handled in `onbox-sitting-vram-contention.md`.

## Teardown

- [ ] Evict every warm engine (Qwen Base, Qwen VoiceDesign, Coqui, Kokoro) so
      the next sitting starts cold.
- [ ] Restore `server/.env`'s `QWEN_DEVICE` / `COQUI_DEVICE` pins back to
      `cuda:1` (the owner's box policy) if they were changed for this
      sitting.
- [ ] Confirm any hand-edited baseline JSON from A27.2/A27.3 was reverted —
      `git status`/`git diff` on `server/tts-sidecar/tests/golden/` shows
      clean before this sitting ends.
- [ ] Confirm the Kokoro `.onnx` weight file (or whatever was broken for
      A27.4) is restored and a clean `test:golden-audio` run passes.
- [ ] Close the second browser tab/session (A7's 2nd-tab check).
- [ ] Remove/undo whatever forced the sidecar `/recycle` (A6) and whatever
      held VRAM to force the capacity refusal (A4.4), if either is still
      active.
- [ ] Confirm the card returns to baseline (`nvidia-smi` ≈ idle) before
      ending the sitting.
