# Blocked-on-acquisition — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this
> on the box, once the prerequisite each row is blocked on has actually been
> obtained. Do not pre-fill them.
>
> Plan of record: [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.3, §5
> Register rows: [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> F1 (Group F), H1 and H2 (Group H), D3 (Group D)
> Audit input: [`onbox-acceptance-staleness-audit.md`](onbox-acceptance-staleness-audit.md)

---

## 1. Purpose & scope

This sitting covers the four register rows blocked on something that must be
**obtained**, not on time or a free GPU slot: **F1** needs a real Android
device (and, for one item, a CarPlay/Android Auto head unit); **H1**, **H2**
and **D3** need a real CJK manuscript this repo's corpus does not currently
have available. Unlike every other sitting in this wave, this pack cannot be
scheduled today — it exists so the procedure is ready the moment each
prerequisite lands.

**Running time total (this sitting, once unblocked):** H1 (15 min) + H2
(15 min) + D3 (20 min) = **50 minutes** for the three CJK-manuscript rows,
run together once one or both manuscripts are in hand. **F1 is excluded from
that total** — its own plan does not estimate it, and it is "an entire
untested axis," not batchable with any other row in this register (see
`onbox-sitting-plan.md` §7). F1 gets its own dedicated block whenever a
device and (for app-9) a head unit are available; it does not ride the same
sitting as H1/H2/D3, since neither shares hardware, engine residency or
fixtures with the other.

**Card / box:** H1 and H2 need no GPU, sidecar, or analyzer — pure functions
over chapter text, runnable on any machine. D3 needs a working TTS engine
(Kokoro, Coqui or Qwen — any one) to render a chapter, so a single card is
enough; no VRAM contention concern. F1 needs the operator's GPU server
reachable over LAN from the phone, not a dedicated card session on its own.

## 2. Re-resolution — re-checked live, not taken from the audit

Per `onbox-sitting-plan.md` §6 (the A2 false-grep incident), every row below
was re-resolved against its own citations rather than trusted from the
staleness audit.

- **F1** (`docs/features/188-android-companion-app.md`): line 24 still reads
  "all built, tested, and merged... The only thing left is the batched
  live-device acceptance pass" verbatim, confirmed live in this worktree.
  `app-3` through `app-8`/`app-13`/`app-14` all still carry "**Live device
  acceptance owed**" against every entry (checked `app-3`–`app-5` directly;
  matches the audit's citation). No file under `docs/testing/` records a
  live-device run. **Audit verdict (STILL OWED) confirmed.**
- **H1 / H2** (`server/src/tts/prose-units.ts`, #2256):
  `gh api repos/dudarenok-maker/Castwright/issues/2256` →
  `{"state":"closed","closed_at":"2026-08-14T11:17:46Z"}` — the *bug-fix*
  issue is closed and merged, exactly as the register already accounts for;
  closure does not discharge the on-box row, which is about the fix's real-
  scale acceptance, not its existence. `ls
  C:\AudiobookWorkspace\books\Castwright\Standalones\` lists the same seven
  Coalfall Commission translations the audit found: two real CJK samples
  (`煤落的委托` — zh, `コールフォールの依頼` — ja **mixed** kanji+kana), no
  all-kana Japanese text and no full-length Han book. **Audit verdict (STILL
  OWED, both rows) confirmed** — no new manuscript has arrived since the
  audit ran.
- **D3** (`server/src/analyzer/dialogue-structure/parser.ts`, #2315):
  `gh api repos/dudarenok-maker/Castwright/issues/2315` →
  `{"state":"closed","closed_at":"2026-08-13T21:32:45Z"}` — matches the
  audit's citation exactly. **One re-resolution finding beyond what the
  audit recorded:** the register's own D3 text (and the design doc's "What
  it fixes, on real books" section) point at real corpus books —
  `pg/zh/23835.txt` and others — as already read by "this PR's own
  instruments," which reads as though a usable manuscript already exists.
  It does not, on this box: those files were read from
  `scratchpad/s2315/…`, a throwaway analysis directory this worktree does
  not contain (`find … -iname s2315` returns nothing), and no copy of
  `pg/zh/23835.txt` or the corpus it belongs to exists under
  `C:\AudiobookWorkspace` or the primary checkout either. The "already in
  the corpus" framing describes a one-time analysis fetch, not a persistent
  asset — so **D3 is correctly binned as blocked-on-acquisition**, same as
  H1/H2, and the audit's "real CJK manuscript" hardware field is accurate in
  effect even though the register's own wording could be read as implying
  otherwise. No file under `docs/testing/` mentions #2315 or
  "primary-pair-straddle," confirmed. **Audit verdict (STILL OWED)
  confirmed.**

No row is excluded on re-resolution — all four remain genuinely blocked.

## 3. Preconditions

Stated once for the sitting; check off only what applies to the rows you are
actually running (H1/H2/D3 share a session, F1 is its own).

**For H1 / H2 / D3 (CJK manuscript rows):**

- [ ] A real, legally usable **all-kana (no kanji) Japanese manuscript** —
      the realistic shape is a children's book or early-reader text with no
      kanji at all — for H1.
- [ ] A real, legally usable **full-length Han (Chinese) manuscript** — book
      scale, not an excerpt — for H2. (H1 and H2 need two *different* texts;
      neither of this repo's existing Coalfall samples satisfies either,
      per §2 above.)
- [ ] For **D3**, no new manuscript is strictly required if either the H1 or
      H2 manuscript (or this repo's existing `コールフォールの依頼` / `煤落的委托`
      samples) contains a continuation paragraph of the shape the design doc
      describes (an opening quote delimiter with no closer, itself containing
      a quoted turn) — check for one before importing anything extra. If none
      of the available texts contains that shape, D3 needs its own zh or ja
      manuscript with at least one such paragraph.
- [ ] A working TTS engine available (Kokoro, Coqui or Qwen — any one; D3
      only, H1/H2 need no engine at all).
- [ ] Repo checked out at this worktree/branch, `cd server && npm run
      build` current (H1/H2 call `detectManuscriptLanguageFromChapters`
      directly; D3's render goes through the normal import → chapter
      generation path).
- [ ] One shell is enough for all three rows.

**For F1 (Android live-device rows):**

- [ ] A real Android phone — the plan names a **Pixel 10 Pro**
      (`docs/features/188-android-companion-app.md`).
- [ ] The operator's GPU server reachable on the **same LAN/Wi-Fi** as the
      phone.
- [ ] For **app-9** only: a real **Android Auto / CarPlay head unit** (or a
      head-unit emulator Google/Apple ship, if the plan later names one —
      not confirmed present as of this pack).
- [ ] At least 2 books available on the server library to exercise the
      dual-book download/resume scenario.
- [ ] A chapter the operator can regenerate mid-session, to exercise the
      targeted re-sync + in-car position push-back step.

## 4. Procedure

### 4.1 H1 — kana-trigram richness gate at real-book scale (all-kana Japanese)

*Blocked pending corpus.* Once an all-kana manuscript is in hand:

1. Import the manuscript (or run its chapters directly through
   `detectManuscriptLanguageFromChapters`, e.g. via `npx tsx` — see
   `server/src/tts/detect-language.test.ts`'s `finding 3(b)` fixture for the
   call shape this exercises) and observe the result.
   **Result:** _(fill in: `{ language, supported, fallback }`)_
2. Separately call `guiraudR` on the same (deduped, per `dedupeProseUnits`)
   winning sample and record the actual value against
   `LEXICAL_RICHNESS_FLOOR` (3) — see `server/src/tts/prose-units.ts`'s own
   finding-3(b) block for what "winning sample" means here.
   **Result:** _(fill in: observed R)_
3. If the manuscript has multiple chapters, note the total combined
   character count the richness gate actually saw (no length cap applies —
   `prose-units.ts`'s finding-3(a) retraction).
   **Result:** _(fill in: combined character count, and whether the margin
   at that scale still clears the floor)_

### 4.2 H2 — lexical-richness floor at full-length real Han-book scale

*Blocked pending corpus.* Once a full-length Chinese manuscript is in hand:

1. Import it (or run `detectManuscriptLanguageFromChapters` over its
   chapters directly) and record the result.
   **Result:** _(fill in: `{ language, supported, fallback }`, expected `zh`)_
2. Record the combined character count of the joined winning sample the
   gates actually saw (every winning chapter's `prepareSample` output, each
   capped at 20,000 chars, joined) and the observed `guiraudR` against
   `LEXICAL_RICHNESS_FLOOR` (3).
   **Result:** _(fill in: N, and observed R)_
3. Record the distinct-Han-character count at that scale — the `V` in
   `V / sqrt(N)`. At N ≈ 400,000, R clears the floor only if V is above
   ~1,900; this is the number that answers the row.
   **Result:** _(fill in: distinct-Han-character count V)_

### 4.3 D3 — the recovered turn actually sounds right when voiced

*Blocked pending corpus* (see §2's re-resolution finding — the design doc's
cited corpus books are not present on this box; D3 needs the same kind of
acquisition as H1/H2 unless one of their manuscripts happens to contain a
qualifying paragraph). Once a qualifying zh or ja manuscript is available:

1. Import a `zh` or `ja` book containing a continuation paragraph of the
   shape `docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md`
   § "What it fixes, on real books" describes — an opening quote delimiter
   with no closer of its own, itself containing a quoted turn (that section
   quotes a worked `zh` example: `…眾鬼嘩然並出，曰：「爾恃符咒拘遣我...」聚而攢擊。…`
   recovering as two runs rather than one merged run). If H1's all-kana or
   H2's Han manuscript already contains such a paragraph, reuse it here
   rather than importing a third text.
2. Generate that chapter with a working TTS engine (any of Kokoro/Coqui/
   Qwen — engine choice is not the variable under test).
3. Listen to the rendered continuation paragraph. Confirm the previously-
   swallowed inner turn now renders as its **own** speech turn, in the
   character's own cast voice, rather than merged into the narration/tag
   reading of the turn before it.
   **Result:** _(fill in: pass/fail — own voice, correctly separated?)_
4. Confirm the recovered boundary does not land mid-word and does not drop
   a syllable, listening across the cut point specifically.
   **Result:** _(fill in: pass/fail — clean boundary?)_
5. **Optional, lower priority per the row's own text:** if a `ru` or `de`
   chapter is convenient from the same import, spot-check one of its
   affected continuation paragraphs the same way. Not required for this row
   to clear.
   **Result:** _(fill in: run? pass/fail if yes)_

### 4.4 F1 — Android companion app, v1 live-device acceptance

*Blocked pending device (and, for app-9, a head unit).* An entire untested
axis — every module (`app-3` through `app-14`) is unit/widget-tested and CI-
green, but **zero of it has been proven on a physical phone.** Once a Pixel
10 Pro (or equivalent) and LAN access to the server are available, the full
plan-188 live-device pass is three scenarios; write the procedure now so no
decision is needed once the device lands, but do not attempt any of it
without the device in hand:

1. **v1 core, single end-to-end scenario** (`docs/features/
   188-android-companion-app.md:622-630` has the full script): pair the
   phone to the server via QR (token + CA fingerprint auto-verified, no OS
   cert install) → browse the library by author/series/book → download 2
   books → play offline with background, lock-screen and Bluetooth controls
   plus a sleep timer → switch between the 2 books, confirming each resumes
   at its own position → regenerate one chapter of book A on the server →
   return to home Wi-Fi → confirm the app auto-syncs only that chapter and
   pushes the in-car listening position back to the server.
   **Result:** _(fill in: pass/fail per sub-step, per `:622-630`)_
2. **app-9, head unit:** Android Auto / CarPlay media-browse tree
   navigation and playback from a real head unit. Requires the head unit
   separately from the phone.
   **Result:** _(fill in: pass/fail)_
3. **app-10, stream over LAN** (`docs/features/
   188-android-companion-app.md:504-508`): an undownloaded chapter with
   "Stream over LAN" on starts instantly, mid-chapter seek works,
   lock-screen transport works, it survives backgrounding, and no OS
   cert-install prompt appears; with streaming off or off-Wi-Fi, confirm a
   "download to play" message appears rather than a stall.
   **Result:** _(fill in: pass/fail per sub-check)_

## 5. Teardown

- **H1/H2:** no engine or process was started — nothing to unload. Discard
  any manuscript-import artifacts created only for the test if they should
  not remain in the library.
- **D3:** stop/close the render session; evict the TTS engine used if it
  should not stay warm for whatever sitting runs next; close the book if it
  was imported solely for this row.
- **F1:** unpair the phone from the server, stop any active playback,
  disconnect the head unit if one was used, and confirm the server-side
  library returns to its pre-sitting state (no stray test-only downloads
  left counted against library storage).

_(Once each row is actually run and recorded, mark it discharged in
`onbox-acceptance-register.md` with a summary of this result — that edit is
out of scope for this pack and belongs to whoever runs the sitting.)_
