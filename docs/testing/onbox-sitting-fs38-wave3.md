# fs-38 Wave 3 — on-box sitting pack (register row A1)

> Sitting pack, not a rewrite. This is a **scheduling document over**
> [`fs38-wave3-onbox-acceptance.md`](fs38-wave3-onbox-acceptance.md) (the
> 3,264-line run sheet, read-only — this pack cites its section/test-ID numbers
> and never copies its criteria). Fill the run sheet's own `Result:` lines when
> you actually run each test; this pack's own `Result:` lines below are a
> per-step completion record only.
>
> Register row: [`onbox-acceptance-register.md` A1](onbox-acceptance-register.md)
> (search `### A1`). Plan of record: [`onbox-sitting-plan.md`](onbox-sitting-plan.md)
> §2.1, §4 step 8, §5 (pack format), §6 (re-resolution rule).
> Plans: `docs/features/267-fs38-wave3-voice-clone.md`,
> `docs/features/268-fs38-wave3b2-resolver.md`,
> `docs/features/271-fs38-wave3c-xtts.md` (all `status: active`).
> Tracking issue: [#624](https://github.com/dudarenok-maker/Castwright/issues/624).
>
> **Running time: multi-hour, several sittings** — the row's own unchanged
> estimate (`onbox-sitting-plan.md` §7), not a single number. This pack breaks
> it into **4 sittings**, each targeted at 2.5–3.5 hours, totalling roughly
> 11–11.5 hours of box time (~150 + ~170 + ~170 + ~190 minutes — see each
> sitting's header). **Box/card:** the dual-GPU dev box, single 8 GB `cuda:0`
> (RTX 4070) for every sitting in this pack — none of the still-owed sub-tests
> below need the 2-card eGPU boot, so run this pack with the eGPU **unplugged**
> (that rig is reserved for `onbox-sitting-two-card-boot.md`).

---

## 0. Re-resolution — what was checked before writing this pack

Per `onbox-sitting-plan.md` §6, the audit is a lead, not a fact. Re-checked
live, not taken on the row's or the audit's word:

- **`gh issue view` / `gh pr view`, re-run against `dudarenok-maker/Castwright`
  on 2026-08-20**, for every issue/PR the row's still-owed section depends on:

  | # | State (re-checked) | Matches row's claim? |
  |---|---|---|
  | Issue #1972 (stale-attribution bug — invalidated the 3 run-2 retractions) | `CLOSED`, closed 2026-07-31 | Yes — row already treats this as fixed |
  | Issue #1969 (voice-mismatch stale reference, A23-adjacent) | `CLOSED`, closed 2026-08-16 | Yes, and now has a merged fix (PR #2402, merged 2026-08-16) — newer than the row's text, not a contradiction |
  | Issue #1944 (Coqui won't load after `/embed`) | `CLOSED`, closed 2026-07-30 | Yes |
  | Issue #1967 (torchcodec/FFmpeg, blocked Section E on a stock box) | `CLOSED`, closed 2026-07-31 | Yes |
  | PR #1978 (fixes #1967) | `MERGED` 2026-07-31 | Yes |
  | Issue #2017 (spacy missing, E-04's `ImportError`) | `CLOSED`, closed 2026-08-01 | Yes |
  | PR #2039 (fixes #2017) | `MERGED` 2026-08-01 | Yes — confirms the row's own caveat that E-04's `F` "stands until the exact reproduction is re-run" is still the correct read: the **fix** is merged, the **re-run** is not done |
  | Issue #2026 (Russian XTTS quality, register row A40 — not this row) | `OPEN` | Yes, correctly left open |
  | Issue #1998 (XTTS cross-language identity loss, feeds E-01's by-ear finding) | `OPEN` | Yes |
  | Issue #399 (`side-11`, the host-memory-leak *investigation* tracking issue) | `CLOSED`, closed 2026-07-06 | **Needs its own note — see below** |

- **The `side-11` closure does NOT discharge C-02/D-02's blocker.** #399 was
  closed 2026-07-06 — three weeks *before* both fs-38 Wave 3 runs (2026-07-29,
  2026-07-31) independently hit the leak (sidecar recycled 3×, committed
  memory peaked at 29,395 MB — run sheet §7.2, "Pre-existing, not caused by
  this wave"). Reading why #399 could close while the leak still fires: its
  final fix, plan `243-side25-qwen-codec-gpu.md` (`status: stable`, `shipped:
  2026-07-06`), ships the Code2Wav-codec-on-GPU mitigation **inert by default**
  (`QWEN_CODEC_DEVICE=cpu`) — its own Benefit/Rationale section says the
  payoff "only lands once an operator opts a box in **after** the on-box
  acceptance run" it names as its own separate owed item. So on a default
  config — which is what both fs-38 runs used, and what this pack's sittings
  use — the leak is unmitigated. **C-02, D-02, and D-04's full-book variant
  stay excluded from every sitting below**, exactly as the register and the
  run sheet's own §7.4 state; the closed tracking issue is not a
  re-resolution finding, it's confirmation that the block is real and
  independent of that issue's lifecycle. (`D-04`'s *splice*-based repro does
  **not** need a full-chapter render, so it is not blocked by this — see
  Sitting 2.)

- **Re-ran the run sheet's own §7.1 totals arithmetic** rather than trusting
  the register's "20 of 60 run … ~40 still owed … 3 retracted" headline: the
  run sheet's own "Corrected totals — Run 2" table (§7.1, after the #1972
  root cause was found) shows **20 P (one partial) + 0 F + 8 B + 1 N/A + 31 not
  reached = 60**. That reconciles with the register's rounding ("~40 owed" ≈
  31 not-reached + 8 blocked, since a Blocked result is also not a discharge).
  No contradiction found — see §7 below for exactly which of the 31
  not-reached and how many of the 8 blocked this pack covers.

- **No item in the "still owed" set was found already discharged, or
  self-contradictory, on inspection of the run sheet's own §7.1 result
  table.** Checked every ID this pack schedules (A-13, A-07/08/09, B-02,
  B-03, B-05, B-08…B-13, C-01, C-03…C-09, C-12…C-18, C-20, C-21, D-01, D-04,
  E-03, E-04, E-06, E-07) against its §7.1 row: all blank/**B**, none show a
  **P** that would make scheduling it redundant. C-19, D-03, B-01, B-04, B-06,
  B-07, C-10, C-11, E-01, E-02, E-05, E-08, E-09, and all of Section A except
  A-07/08/09/A-13 are already **P**/discharged/retired and are correctly
  **not** in this pack.

**No exclusions were needed** — see `## Excluded on re-resolution` below,
which is consequently empty of pack-relevant items.

## Excluded on re-resolution

Nothing excluded. Every still-owed sub-test this pack schedules was
independently re-confirmed still-owed against the run sheet's own §7.1 table
and the live `gh` state of its blocking issues (§0 above). The one item that
looked at first glance like it might have changed status — `side-11`/#399
being `CLOSED` — was investigated and found **not** to discharge C-02/D-02;
see §0's dedicated note. C-02, D-02, and D-04's full-chapter variant remain
excluded from every sitting for the reason already given in the run sheet and
register, not a new finding of this pack.

---

## 1. What this pack does NOT schedule

So the coverage arithmetic in §7 is checkable: this pack schedules **31** of
the run sheet's 60 sub-tests (all still-owed and un-blocked). It excludes:

- **20 already `P`/discharged**, **1 `N/A`** (B-06, retired in favour of an
  automated test) — no on-box run is owed.
- **1 `P` (incidental)** — D-03, proven while isolating #1941; not re-run.
- **8 `B` (blocked)**: A-07/A-08/A-09/B-02 need a real browser+mic — **this
  pack DOES schedule these four**, because the operator's box has both (this
  row was binned to the operator-sittings set in `onbox-sitting-plan.md` §2.1,
  not to `onbox-sitting-blocked-prerequisites.md`); their `B` marking in the
  run sheet reflects the *previous* runs being agent-driven with no mic
  access, not a hardware gap on this box. B-05 needs a way to fail `/embed`
  transiently — scheduled (Sitting 3). **C-02 and D-02 stay excluded** — blocked
  by the side-11 leak, confirmed still live in §0.

That leaves the 31 scheduled below, split across 4 sittings.

---

## 2. Sitting 1 — Browser/mic path, and cross-book identity (≈150 min)

**Covers:** A-13, A-07, A-08, A-09, B-02, B-03, B-08, D-01 (run sheet §5,
Sections A/B/D).

### 2.1 Preconditions

- [ ] Single 8 GB card only (`CUDA_VISIBLE_DEVICES=0`), eGPU unplugged.
- [ ] `npm start` — full stack (frontend + server + sidecar), **not**
      `npm run dev:mock`. Confirm real backend per run sheet §2.1's warning.
- [ ] A real desktop browser with a working, permission-grantable microphone
      on this box (Chrome recommended — the in-app recorder targets
      `audio/webm`, run sheet fixture F-7).
- [ ] Qwen weights present (P-13), session engine picker = Qwen (P-23).
- [ ] The Coalfall EN book (`server/src/__fixtures__/the-coalfall-commission.md`)
      imported, analysed, and already carrying the healthy cloned voice `$U`
      from the prior run's B-01/B-07 (confirm it is still assigned to its
      Section B character — redo the `POST /assign` from run sheet B-07 if the
      workspace was reset since the last session).
- [ ] A **second** Qwen-routed book imported for D-01 — a second import of the
      same Coalfall EN fixture under a different book id is sufficient; both
      books must resolve to the Qwen engine (no engine override).
- [ ] One extra shell free for `curl`/PowerShell probes alongside the browser.

### 2.2 Procedure

Ordered browser-driven wizard steps first (one continuous UI session), then
the cross-book check, so the microphone permission prompt is granted once.

1. **A-13** — confirm the voice library is unconditionally available even with
   a stale `"voices.library.enabled": false` override hand-added to
   `~/.castwright/user-settings.json`. Do: apply the override, restart the
   server, hit the routes and open `#/voices` + a cast profile drawer per run
   sheet A-13. Observe: neither route 404s, My-voices/clone CTA present, no
   "Voice library" group in Advanced settings. **Result:** _____________
2. **A-07** — run the browser recorder (webm/opus) end to end per run sheet
   A-07. Observe: the exact ingest/transcript flow A-01 already proved, now
   via the recorder — compare against A-01's recorded 202/transcript shape.
   **Result:** _____________
3. **A-08** — deny mic permission, confirm fallback to Upload per run sheet
   A-08. Observe: no dead-end, Upload tab remains reachable. **Result:** _____________
4. **A-09** — confirm Continue is gated on consent per run sheet A-09.
   **Result:** _____________
5. **B-02** — full wizard happy path via **Record** (run sheet B-02, steps =
   B-01's steps 2-9 substituting Record for Upload). Record the second `$U`
   — you need it for D-01 below. Observe: `candidate.json.captureMethod` and
   the persisted entry's `master.captureMethod` both read `"record"`.
   **Result:** _____________ **Second $U:** _____________
6. **B-03** — the by-ear identity check (run sheet B-03). Play F-1, then the
   wizard audition, then a **fresh** `/sample` synth (not the wizard's
   in-memory preview). Judgement is against F-1 directly, not a vibe: same
   speaker / arguably same / clearly different, circled per the run sheet's
   own verdict line. Get a second listener if one is on hand. **Result:** _____________
7. **B-08** — cast-view Play on the Section-B character (run sheet B-08).
   Observe: unmistakably the cloned speaker (same bar as B-03), and a new
   `qwen-<uuid>-<modelKey>-<hash>.mp3` appears under `server\audio\voices\`;
   a second Play is served `cached: true`. **Result:** _____________
8. **D-01** — assign the *first* `$U` to a character in book A (already true
   from B-07) and the *second* `$U` (from step 5) to a character in book B.
   Start a render in book A, then start book B's render while A is still in
   flight (run sheet D-01 steps 2-5). Observe: both complete, each renders
   its own cloned identity with no cross-book bleed, and `voices\qwen\` holds
   exactly one `.pt` per uuid — no duplicate/competing files. **Result:** _____________

### 2.3 Teardown

- [ ] Remove the hand-added `"voices.library.enabled": false` override from
      `~/.castwright/user-settings.json`, restart the server (A-13's cleanup,
      run sheet §7.3 checklist).
- [ ] Leave both `$U` values recorded for later sittings — do not revoke
      either yet (Sitting 2 needs the first `$U` healthy).
- [ ] Confirm no chapter render is still in flight before closing the browser.

---

## 3. Sitting 2 — Qwen resolver classification & lifecycle (≈170 min)

**Covers:** C-01 ⭐, C-03, C-04, C-05a, C-05b, C-06, C-07, C-08 ⭐, C-09, C-12,
C-18, D-04 (run sheet §5, Section C + D-04). Same card and engine as Sitting
1 — no swap. This sitting is the deliberate-kill / manifest-editing family;
group it apart from the UI-facing checks in Sitting 3 so PowerShell-driven
scripted work doesn't keep alternating with browser observation.

### 3.1 Preconditions

- [ ] Same box/card as Sitting 1 (`cuda:0`, eGPU still unplugged) — no
      re-plug needed.
- [ ] Qwen resident, session engine = Qwen.
- [ ] The first `$U` from Sitting 1, healthy, assigned to a character (`$K`
      = its Qwen storage key) in the Coalfall EN book, in a chapter where it
      speaks **≥6 lines** and is **not** the narrator (needed for C-03/C-04's
      contrast case).
- [ ] A second character in the same book with **its own** cloned or designed
      voice, for C-03's "unrelated broken voice doesn't fail the chapter" case
      — the second `$U` from Sitting 1 works.
- [ ] A chapter with a **narrated title** (for C-04) and, separately, one with
      **no** narrated title (for C-05a/C-05b) — confirm both exist in the
      fixture book per run sheet §4.1's checklist.
- [ ] `cast.json` backed up before starting (`Copy-Item cast.json
      cast.json.bak`) — C-05a/C-05b hand-edit it to create an orphaned
      `characterId`.
- [ ] Ability to hard-kill the sidecar process (`Stop-Process -Name python
      -Force`, verified against the PID in `logs\tts.log`, not a guess) for
      C-08 and C-12.
- [ ] Two shells: one to tail `logs\tts.log`, one to fire pre-staged
      PowerShell commands (revoke, kill) at a precise moment for C-01/C-12.

### 3.2 Procedure

Ordered so the manifest returns to a known-healthy state between tests, and
the two timing-sensitive tests (C-01, C-12) — which may need 3-5 attempts
each per the run sheet's own budget — are run while attention is freshest.

1. **C-01** ⭐ — force Repairable (delete `$K.pt`), start the chapter render,
   fire a pre-staged revoke in the window before `Cloned + cached Qwen voice`
   appears in `tts.log` (run sheet C-01). Observe, all three must hold:
   `revokedAt` survives; the chapter fails `cloned-voice-broken`/`revoked`;
   no `.pt`/`.json`/`__1.7b.pt`/entry-dir `master.wav` survives. Budget 3-5
   attempts. **Result:** _____________ **Attempts:** ____
2. Re-clone (or restore) `$U` to healthy before continuing — C-01 leaves it
   revoked by design.
3. **C-08** ⭐ — force Repairable again, **stop the sidecar** (leave server
   up; disable `autoStartSidecar` first if it would respawn), generate the
   chapter, immediately read `engines.qwen.status` (run sheet C-08). Observe:
   the chapter fails, but status is **not** `'failed'`; restart the sidecar
   and re-run the same chapter — it now completes with no manual repair.
   **Result:** _____________ **Status after failed run:** _____________
4. **C-09** — corrupt the entry (`master.transcript = ''`), force Repairable,
   generate (run sheet C-09). Observe: fails `derive-failed`; status **is**
   `'failed'` this time (contrast with C-08); restart + re-run fails again
   immediately with no derive attempted (terminal). Restore the transcript
   afterward. **Result:** _____________
5. **C-12** — record the good `.pt`'s hash/size, trigger a rewrite (C-07's
   method 2: bump `baseModel`, then render), hard-kill the sidecar the
   instant the derive begins per run sheet C-12. Observe: the live `.pt` is
   either byte-identical to the pre-kill hash or a complete new file — never
   truncated; any leftover temp file is the `.tmp`-suffixed shape, which is
   acceptable. Repeat a few times to actually land inside the write window.
   **Result:** _____________ **Attempts:** ____ **Truncated `.pt` ever seen?** ☐ no ☐ yes
6. **C-06** — delete only `$K.pt` (leave manifest/master alone), generate,
   observe the self-heal per run sheet C-06: chapter completes, exactly one
   `Cloned + cached Qwen voice` log line, `.pt` reappears with a fresh
   timestamp, a second chapter afterward fires no further derive.
   **Result:** _____________
7. **C-07** — simulate a stale `baseModel` (edit `voice.json` per run sheet
   C-07 option 2, noting in the notes field that it's simulated not a real
   model bump), generate. Observe: exactly one re-derive despite the `.pt`
   already existing; `baseModel` afterward matches the sidecar's current
   value. **Result:** _____________ **Method used:** simulated
8. **C-18** — with the `.pt` present, set a bogus `baseModel` on a
   **designed** voice (not `$U`'s cloned one — use a second, designed
   library entry), generate. Observe: **no** re-derive fires, `.pt`'s
   `LastWriteTime`/hash unchanged — contrast against C-06/C-07's cloned-voice
   behaviour (run sheet C-18). **Result:** _____________
9. **C-03** — assign `$U` (speaks) and the second character's voice (silent
   in this chapter — verify!) into the same chapter, revoke the second voice,
   generate (run sheet C-03). Observe: chapter completes normally, `$U`
   renders as itself; then generate a chapter where the second character
   *does* speak and confirm that one fails naming it. **Result:** _____________
10. **C-04** — assign `$U` to the **narrator**, with chapter-title narration
    on and a narrated title; revoke `$U`; generate (run sheet C-04). Observe:
    fails `cloned-voice-broken` naming the narrator, no title audio produced
    — confirms the title-beat union into the readiness set. Re-clone/restore
    `$U` afterward. **Result:** _____________
11. **C-05a** — snapshot `cast.json`, remove a non-narrator character object
    so its sentences become orphaned; assign the narrator a **healthy**
    cloned voice (contrast with the original C-05, which used revoked); turn
    off chapter-title narration; generate (run sheet C-05, the "C-05a" note
    under C-05). Observe (post-#2023-fix expectation): the chapter now fails
    `cloned-voice-broken` naming the narrator — a healthy cloned voice must
    never render another character's orphaned line either.
    **Result (C-05a):** _____________
12. **C-05b** — repeat with a **designed** (non-cloned) narrator instead.
    Observe: the chapter completes, AND the rendered segment carries
    `renderedFallbackCharacterId` naming the narrator, `GET
    /api/books/:id/state`'s `orphanedCharacterFallbacks` map names the
    orphan, and the Cast view shows the amber advisory banner. Restore
    `cast.json` from the backup when done. **Result (C-05b):** _____________
13. **D-04** — with a **revoked** cloned voice assigned to a speaking
    character (reuse `$U` post-C-01, or revoke it fresh), trigger a chapter
    **splice** on that chapter, then an **audio-QA repair** (run sheet D-04).
    Observe (verify-as-expected per run sheet §6 KL-i, not a defect if seen):
    both fail with the plain `UnresolvableClonedVoiceError.message` naming
    the voice and reason, but **no** `cloned-voice-broken` toast/help
    link/`generationErrorCode` on these two paths — contrast against C-01/C-15's
    generation-route failure. **Result:** _____________

### 3.3 Teardown

- [ ] Restore `$U` to healthy (re-clone if C-01/C-04 left it revoked and you
      need it again in Sitting 3 — B-11/B-12/C-13/C-14/C-16/C-17 all want a
      healthy or freshly-broken clone, not a leftover revoked one).
- [ ] Restore `cast.json` from `cast.json.bak`; delete the backup once
      confirmed restored.
- [ ] Re-enable `autoStartSidecar` if you disabled it for C-08.
- [ ] Restore the corrupted transcript from C-09.
- [ ] Confirm the sidecar is up and `/health` answers before ending.

---

## 4. Sitting 3 — Diagnostics, capacity, UI surfacing & designed self-heal (≈170 min)

**Covers:** C-13, C-14, C-15, C-16, C-17 ⭐, C-20, C-21, B-05, B-09, B-10,
B-11, B-12, B-13 (run sheet §5, Sections B + C). Same card/engine as
Sittings 1-2 — no swap; this is the third and last Qwen-only sitting before
Sitting 4 moves to Coqui.

### 4.1 Preconditions

- [ ] Same box/card, eGPU still unplugged.
- [ ] A healthy `$U` assigned to a character that speaks **≥6 lines** across
      **2 chapters** (for B-09/B-10's consistency checks).
- [ ] `SEG_CAPACITY_ADMISSION` confirmed `1` (or unset) in `server/.env`
      before starting (B-12 needs it ON first, then toggles it).
- [ ] The generation view open and visible in the browser for C-15 (toast
      timing) — same browser session as Sitting 1 is fine to reopen.
- [ ] A way to hold an exclusive file handle on a `.pt` from a second
      PowerShell session (`[System.IO.File]::Open(..., 'None')`) for C-21.
- [ ] A **designed** (not cloned) voice created fresh on this branch, with
      its retained `qwen-<uuid>__master.wav` confirmed present — required for
      C-17; a voice designed before this branch cannot self-heal and is not a
      valid fixture for this test.
- [ ] The Kokoro engine available as a picker option (for C-13/C-14's
      wrong-engine cases).

### 4.2 Procedure

1. **B-09** — generate the chapter with `$U` speaking ≥6 lines (run sheet
   B-09). Observe: completes, every line of `$U`'s character is the same
   voice with no drift or fallback, no `Cloned + cached Qwen voice` line in
   the log (healthy voice, no re-derive). **Result:** _____________
2. **B-10** — generate the second chapter `$U` speaks in, A/B a line from
   each chapter (run sheet B-10). Observe: indistinguishable identity across
   chapters, `baseModel` unchanged from B-01. **Result:** _____________
3. **B-05** — make `/embed` fail transiently without touching
   `/qwen/clone-voice` (run sheet B-05 lists the practical options), clone.
   Observe: the clone still completes (`.pt` written) despite the fidelity
   check failing — advisory, not fatal. **Result:** _____________
4. **B-11** — edit a throwaway clone's manifest per run sheet B-11's
   PowerShell snippet to force each of cases (i)/(ii)/(iii), attempting the
   assign each time. Observe the three distinct outcomes: (i) 409 naming
   Coqui XTTS v2, (ii) 409 naming Qwen, (iii) 200 with a `warning` field
   naming Qwen and a chapter that still renders on Coqui. Also confirm the
   separate revoked-entry 409. Restore the manifest afterward.
   **Result:** _____________
5. **B-12** — confirm admission ON, clone (record which device the
   reservation landed on), then force the no-capacity branch by occupying
   the target card, clone again (run sheet B-12). Observe: step 2 clone
   succeeds naming a concrete device; step 3 clone gets a 503
   `{noCapacity:true,...}` with **no orphan `.pt`/entry dir** left behind.
   Optionally A/B with admission OFF, then **restore to `1`**.
   **Result:** _____________ **Device:** _____ **`neededMb` on 503:** _____
6. **B-13** — stop the sidecar, run the wizard to Save, confirm the 503 (not
   a fake success, nothing persisted), restart the sidecar, provoke a
   sidecar-side 4xx via the direct curl in run sheet B-13. Observe: the 4xx
   surfaces through `POST /api/voice-library/clone` as **502**, not the raw
   4xx. **Result:** _____________
7. **C-13** — with `$U` assigned and Qwen healthy, switch the session engine
   to **Kokoro**, generate (run sheet C-13). Observe: fails naming
   `(wrong-engine)`, remedy says "switch the book to Qwen", **not** "Qwen is
   unavailable". Contrast: switch back to Qwen, stop the sidecar, generate —
   now `(engine-unavailable)` with a different remedy. Record both exact
   messages. **Result:** _____________
8. **C-14** — run all four cases from run sheet C-14 (session=Kokoro/no
   override; session=Qwen/character override=kokoro; character
   override=coqui contrast; pending-picker-beats-persisted-default).
   Observe the four distinct HTTP outcomes and exact 409 copy per case.
   **Result:** _____________
9. **C-15** — with a Broken cloned voice (reuse a revoked one), open the
   generation view, start the failing chapter, watch for the immediate toast,
   click its help link, then fail the same chapter again (no duplicate
   toast) and a different chapter (does produce one) (run sheet C-15).
   **Result:** _____________
10. **C-16** — walk the state table in run sheet C-16 (healthy / revoked /
    no-master / failed / repairable), reloading `#/voices` between each.
    Observe the exact chip per state, and note the two documented KL-h
    approximation gaps (no chip for a `.pt`-deleted Repairable, no chip for
    wrong-engine) as expected, not defects. **Result:** _____________
11. **C-17** ⭐ — snapshot the designed voice's persona (`instruct`,
    `designModel`, `mintMethod`, `fallbackFor`), assign it to a speaking
    character on Qwen, delete only its `.pt`, generate a **full chapter
    render** (not a splice — #1972 makes a splice unsafe for this check; a
    full chapter reads one source and is unaffected), re-read the manifest
    and the Profile Drawer persona box, then trigger a re-design (run sheet
    C-17). Observe: `instruct` byte-identical to the pre-heal snapshot,
    `designModel`/`mintMethod`/`fallbackFor` preserved, persona box still
    populated, re-design still works. This is the genuine re-run the
    #1972-retracted run-2 attempt never actually exercised.
    **Result:** _____________ **`instruct` identical?** ☐ yes ☐ no (fail)
12. **C-20** — delete a Repairable clone's `.pt`, start the chapter, hit
    Pause during the "Preparing voice…" window, observe no
    `cloned-voice-broken` toast/failure and no `'failed'` stamp, then
    resume (run sheet C-20). Repeat once against C-17's designed-voice setup.
    **Result:** _____________
13. **C-21** — open an exclusive file handle on `$K.pt` from a second shell,
    revoke `$U` from the first, read the response and `logs\server.log` (run
    sheet C-21). Observe: still HTTP 200 with `revokedAt` set, but
    `artifactPurgeIncomplete: true` and `artifactPurgeFailedPaths` naming the
    held path; every other artifact still erased. Close the handle, confirm
    the straggler clears on a second revoke/delete. **Result:** _____________

### 4.3 Teardown

- [ ] Restore `SEG_CAPACITY_ADMISSION=1` if it was toggled in B-12.
- [ ] Restore the session engine picker to Qwen (undoes C-13/C-14).
- [ ] Restore any hand-edited `voice.json` from B-11/C-07/C-09/C-16/C-18, or
      re-clone/re-design the affected voice.
- [ ] Release the C-21 file handle if not already closed.
- [ ] Restore `autoStartSidecar` preference if changed.
- [ ] Confirm `$U` and the C-17 designed voice are left in a known state
      (healthy, or explicitly note if revoked) before ending the sitting.

---

## 5. Sitting 4 — Coqui/XTTS Section E, cross-cutting VRAM, and the post-32 follow-ups (≈190 min)

**Covers:** E-03, E-04, E-06 ⭐, E-07 ⭐ (run sheet §5, Section E), plus the
six post-32 follow-up checks (register A1, "Six checks added by the post-32
follow-up campaign" — pass/fail criteria in `docs/features/271-fs38-wave3c-xtts.md`).
The only engine swap in this whole pack: Qwen → Coqui. Run this sitting last,
alone, as `onbox-sitting-plan.md` §4 step 8 directs for the whole row.

### 5.1 Preconditions

- [ ] Same card (`cuda:0`), eGPU still unplugged.
- [ ] Coqui/XTTS installed with weights present (`coqui_import_ok: true` in
      `/health` — read that field, not `coqui_package_installed`, which is a
      stale `find_spec` probe per the run sheet's own superseded-advice note
      under Section E). No special `COQUI_PIN_IMPORT_ORDER` flag is needed —
      #1944's fix is merged to `main` (confirmed §0), so a normal fresh
      sidecar boot should load Coqui cleanly after `/embed`.
- [ ] The Russian Coalfall book (`the-coalfall-commission.ru.md`) imported and
      analysed — this is the fixture that actually routes to Coqui by
      default (confirm the cast picker's resolved engine before relying on
      it, per run sheet E-01 step 2).
- [ ] A healthy cloned voice with an existing Coqui derive (`$KX =
      "xtts-$U"`) — reuse `$U` from earlier sittings; if it was left revoked,
      re-clone before this sitting.
- [ ] A **designed** Qwen voice with no existing Coqui-side artifact yet, for
      E-06/E-07.
- [ ] A second, Qwen-cast character in the **same** Coqui-routed book, for
      the VRAM-partitioning follow-up check (needs one Qwen voice + one Coqui
      voice resolving in the same chapter).
- [ ] `nvidia-smi` watchable in a spare shell throughout, for the VRAM
      partitioning check.
- [ ] A second shell to pre-stage the revoke command for E-03's timing race.

### 5.2 Procedure

1. **E-04 (re-run)** — reproduce the exact repro from the run sheet's E-04
   row on the current (post-#2039) SHA: a 46-char line on `$KX` (expect
   **200**, PCM as before) and a 245-char Russian line on the same voice
   (expect **200 + PCM now**, not the old 500 — `#2017`'s fix declares
   `spacy` and retries with `enable_text_splitting=False` on `ImportError`).
   This clears the row's own stated debt ("re-run of the reproduction … on
   real Coqui weights, not an outstanding bug"). **Result:** _____________
2. **E-03** — delete `$KX.pt` to force a repair derive, pre-stage a revoke,
   fire it in the window between the chapter starting and the derive
   completing (run sheet E-03, same technique as C-01). Observe: `revokedAt`
   survives; the chapter fails naming the character and `revoked`; no
   `.pt`/`.json`/temp-WAV survives under `voices\xtts\`. If you land past
   the window instead (mid-forward), the chapter may complete and return
   audio for that one in-flight request — record which outcome, both are
   informative per the run sheet's own note. Budget 3-5 attempts.
   **Result:** _____________ **Attempts:** ____
3. Re-clone/derive `$KX` back to healthy before continuing.
4. **E-06** ⭐ — cast the designed voice on a Coqui-routed character with no
   prior Coqui artifact, generate (triggers the lazy designed-voice-on-Coqui
   derive), listen, and judge against how that character would have sounded
   on the stock Coqui catalogue voice it replaces (run sheet E-06). This is
   an open verdict, not pass/fail — record it honestly.
   **Result:** ☐ Better ☐ Worse ☐ About the same **Notes:** _____________
5. **E-07** ⭐ — with a designed voice cast on a Coqui character and no
   existing artifact, force the derive to fail (stop the sidecar mid-chapter,
   or remove the retained calibration clip), generate, restore afterward
   (run sheet E-07). Observe: the chapter **completes** on the stock Coqui
   catalogue voice, not silence/crash, and no coqui slot gets written for
   this character — fail-**soft**, the deliberate opposite of E-02/E-03's
   fail-loud cloned-voice policy. **Result:** _____________
6. **Post-32 check 1 — `preparing-voice` phase.** Render a chapter with a
   Repairable cloned voice or the E-06 self-healing designed voice and
   confirm the Generate screen shows a "Preparing voice — `{character}`"
   pill/caption before synthesis starts (already fixed per run sheet §6
   KL-f/#1813 — this is the box confirmation, not a defect hunt). Then
   render a chapter for a character with no library voice at all and confirm
   the phase never appears. **Result:** _____________
7. **Post-32 check 2 — cloned voice end-to-end on XTTS, concretely.** Play
   the E-03/E-04 chapter's rendered audio and confirm it's recognisably the
   cloned speaker, not a stock catalogue voice, and that `cast.json` records
   `overrideTtsVoices.coqui.libraryUuid` matching the clone's uuid with
   `provenance: 'cloned'`. Largely already established by E-01/E-03's own
   measurements — this step is the explicit `cast.json` field check that
   register text notes as not yet separately confirmed. **Result:** _____________
8. **Post-32 check 3 — revoke-then-render on Coqui.** Revoke consent for a
   voice already cast on Coqui, render a chapter using it. Observe: fails
   loud with `UnresolvableClonedVoiceError`, **zero audio** for that
   chapter — same shape as C-01/C-02 on Qwen, E-02/E-03 on Coqui, but this
   time confirming it end to end through a real generation rather than the
   API-level checks above. **Result:** _____________
9. **Post-32 check 4 — VRAM partitioning across a mixed chapter.** Cast one
   character to a Qwen cloned/designed voice and another to a Coqui
   cloned/designed voice in the **same** book/chapter; watch `nvidia-smi`
   through the resolver pre-pass while it renders. Observe: Qwen and Coqui
   never both hold GPU memory resident at the same time — a spike showing
   both resident simultaneously is a regression. **Result:** _____________
10. **Post-32 check 5 — `voice_language_mismatch` advisory on all three
    streams.** On the Russian book, with a reused designed voice originally
    designed for a different language: (a) run a per-character re-record
    from the cast profile drawer's "Fix … audio", and (b) hit the repair
    button on a `suspect` chapter row in Listen view. Observe: each raises
    ONE amber toast naming the cleared character, once per run not per
    chapter, and the run still completes. An English-only book raises none
    on either path. **Result:** _____________
11. **Post-32 check 6 — Preview plays on the ready engine.** Get a voice into
    a state where `engines.qwen.status` is not `ready` but
    `engines.xtts.status` is `ready` (a revoked-then-restored Qwen leg, or a
    Coqui-only clone with no Qwen derive), press Preview on its My-voices
    card. Observe: real Coqui audio plays instead of a 409 toast. Then
    confirm a voice with both engines ready still previews on Qwen (the
    primary engine). **Result:** _____________

### 5.3 Teardown

- [ ] Restore any revoked voice from E-03/post-32-check-3 if it's needed for
      a future session; otherwise leave revoked (revocation is deliberately
      irreversible — note which uuids were spent here).
- [ ] Restart the sidecar if E-07's derive-failure step stopped it; confirm
      `/health` is clean.
- [ ] Restore the calibration clip if you removed it for E-07.
- [ ] Confirm no stray `voices\xtts\` temp files remain from the E-03 kill
      window (an empty `voices\xtts\` directory after erasure is expected —
      run sheet §7.3 — but a partial `.pt`/`.json` pair is not).
- [ ] Fill run sheet §7.1's result table and §7.4's verdict block for every
      test ID run across all four sittings; this pack's own `Result:` lines
      are a per-step log, not a substitute for the run sheet's own record.
- [ ] Follow run sheet §8 (record the run, update the plans, file defects,
      release notes) once this pack's four sittings are complete.

---

## 6. Coverage reconciliation

31 scheduled (Sittings 1-4) + 20 already `P`/discharged + 1 `N/A` (B-06) + 1
`P` incidental (D-03) + 2 correctly excluded as blocked (C-02, D-02) +
5 sub-tests folded into other IDs and not separately counted in the run
sheet's own 60-test denominator (D-04's split into the C-05a/C-05b pieces is
already counted under C-05 in the run sheet's own headcount, not additive) =
**60** (D-04 counts once, under Section D's 4; C-05a/C-05b share C-05's single
slot in Section C's 21 — the run sheet's own §7.1 "C-05 (one of the 18
above)" note makes this explicit). Matches the run sheet's own Section
totals (A 13 + B 13 + C 21 + D 4 + E 9 = 60) with nothing double-counted and
nothing dropped.
