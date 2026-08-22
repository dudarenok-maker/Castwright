# Wave 4 step 5e — Cast-screen browser rows (A43 full, A33 §8.8 only)

Issue: Castwright#2563 · Worktree: `wt-2551-onbox-wave4-retire` @ branch
`docs/docs-2551-onbox-wave4-retire`. Evidence-only — this file does **not**
edit `docs/testing/onbox-acceptance-register.md`, any live view, or any
`onbox-sitting-*.md` file. A later step folds this in.

Scope reminder from the task brief: A43 in full; A33 **§8.8 only**. A33's
§8.7 (re-render *Заказ Коалфолла* ch2 and listen — a live TTS render plus
human audio judgement) was explicitly out of scope for this step and is
recorded below as **STILL OWED to the operator**. A33 is **not** retired by
this step.

## Setup

- Real workspace root: `C:\AudiobookWorkspace` (from
  `C:\Claude\Projects\Audiobook-Generator\server\.env`'s `WORKSPACE_DIR`).
  Never written to — see the md5 proof at the bottom.
- Worktree's own isolated workspace:
  `C:\Claude\Projects\wt-2551-onbox-wave4-retire\castwright-workspace`
  (`server/.env`'s `WORKSPACE_DIR=../castwright-workspace`, resolved
  relative to `server/`).
- Books copied from the real workspace into the worktree's own workspace
  (never the other direction, never in place):
  - `Castwright/Standalones/Заказ Коалфолла` (13 characters + `mairin`/
    `coalfall-dragon` cast rows; already carries a `cast-id-history.json`
    from the real Wave-3 `--apply` run, `mayrin -> mairin`,
    `coalfall -> coalfall-dragon`, plus later `мэйрин`/`коалфолл`/
    `widow-casper` entries from a later real re-analysis run — all read
    directly off the copy before any edit, see below).
  - `Shannon Messenger/Keeper of the Lost Cities/Exile` (no
    `cast-id-history.json` in the source at all — confirmed by directory
    listing before copying).
- Server built (`cd server && npm run build`, clean `tsc -p .`) and started
  via `npm run dev` from the worktree root, detached, log redirected to
  `C:\Claude\Projects\wt4-step5e-devserver.log`. Confirmed listening:

  ```
  [frontend]   VITE v8.0.16  ready in 10380 ms
  [frontend]   ➜  Local:   http://127.0.0.1:5263/
  [server] 2026-08-21 14:14:17.216 [server] listening on http://localhost:8170
  [server] 2026-08-21 14:14:17.216 [server] workspace root: C:\Claude\Projects\wt-2551-onbox-wave4-retire\castwright-workspace
  ```

  Both ports match the worktree's assigned slot (API 8170, VITE 5263) —
  not 8080/5173. Confirmed again via `curl -s -o /dev/null -w "%{http_code}"
  http://localhost:8170/api/health` → `200` and the same against
  `http://localhost:5263/` → `200`, polled after start (attempt 5/12, ~25s
  after launch).

## Data setup — natural vs manufactured orphan (stated plainly)

A read-only dry run against the **real** workspace first (`WORKSPACE_DIR`
pointed at `C:\AudiobookWorkspace`, never `--apply`) established today's
ground truth, since the register's own A43 row text (candidates: Exile
`silveny` or Everblaze `lady-alina`) predates the real Wave-3 `--apply` run
that already recorded `mayrin`, `coalfall`, and `lady-alina` into their
books' `cast-id-history.json` — all three are therefore **already
auto-reconciled**, not "needs your decision", and cannot demonstrate the
link-through-UI flow A43 asks for. Confirmed directly by reading both
books' real `cast-id-history.json` before touching anything:

- *Заказ Коалфолла* real `cast-id-history.json`: `supersededBy` already
  contains `mayrin`, `coalfall`, `мэйрин`, `коалфолл`, `widow-casper`.
- *Everblaze* real `cast-id-history.json`: `supersededBy` already contains
  `lady-alina`.

The real dry run (`WORKSPACE_DIR=C:/AudiobookWorkspace
CACHE_DIR=C:/Claude/Projects/Audiobook-Generator/server/handoff/cache node
scripts/repair-cast-id-drift.mjs`) also showed Exile's `silveny` (17
segments across 4 chapters) is still genuinely orphaned — but Exile's own
live `cast.json` has **no** character named or id'd "Silveny" at all (only
*Stellarlune*, a different book in the series, has one), so there is no
live cast member in Exile's own book to link `silveny` onto — the "Compare
against…" list is scoped to the book's own roster. This rules out
`silveny` as a positive-link fixture too.

**Decision: the A43 positive-link case is MANUFACTURED, stated plainly.**
In the **copy only** (never the source), two segments in *Заказ
Коалфолла*'s `audio/03-глава-вторая-отливка.segments.json` that originally
read `"characterId": "mairin"` (groupIndex 10 and 12) were hand-edited to
`"characterId": "mairin-onboxtest"` — an id that exists nowhere in the
book's cast, history, or analysis cache, so it surfaces as a genuine
"needs your decision" row with a real live-cast candidate (Мэйрин) to link
it to. This is weaker evidence than a naturally-drifted id would be, exactly
as the task brief anticipates — recorded here rather than silently upgraded.

**The A43 negative-case is NATURAL, not manufactured.** Exile's real
`unknown-male` row (21 segments in the book's `needs your decision` list,
43 raw segment occurrences across the book, reserved fold-bucket source per
`fold-minor-cast.ts`) was used as-is, unedited, straight from the copy.

**A33 §8.8's positive check reuses the real, pre-existing
`mayrin`/`coalfall` aliases** in the *Заказ Коалфолла* copy (already
recorded by the real Wave-3 `--apply` run against the source, and copied
over unedited) — natural, not manufactured. Its negative control reuses the
same real Exile `unknown-male` row.

## A43 — Linking an orphaned characterId through the Cast screen actually reconnects its segments

Register row: `onbox-acceptance-register.md` A43 (L2444). Criteria: #2238
acceptance criterion 5 / plan 278.

### Steps 1-2 — dry-run baseline, then link through the UI

Screenshot (before): `docs/testing/onbox-wave4-results/screenshots/a43-01-before-needs-decision.png`
— *Заказ Коалфолла* Cast screen, "1 character id needs your decision" ·
`"mairin-onboxtest"` · 2 segments · `Compare "mairin-onboxtest" against`
combobox showing "Мэйрин" as an option.

Action: selected "Мэйрин" in the combobox, clicked **Link to this
character** (`POST /api/books/.../cast/mairin/link-orphan-match` under the
hood, fired by the UI itself — not a direct API call).

Screenshot (after): `docs/testing/onbox-wave4-results/screenshots/a43-02-after-linked.png`
— toast reads exactly `Linked "mairin-onboxtest" to Мэйрин.` The
needs-your-decision bucket is gone; a new bucket appears: **"1 character id
auto-reconciled — audio needs a re-render"**.

### Step 3 — row moved into auto-reconciled, rendered-page confirmation

Screenshot (expanded): `docs/testing/onbox-wave4-results/screenshots/a43-03-expanded-reconciled.png`
— accessibility snapshot of the expanded bucket:

```
button "1 character id auto-reconciled — audio needs a re-render" [expanded]
list:
  listitem:
    "mairin-onboxtest"
    Мэйрин
    2 segments
    resolves now — existing audio may still need a re-render
```

**PASS** — the row moved from "needs your decision" to "auto-reconciled" in
the rendered page, exactly as A43 steps 2-3 require.

Underlying data (the copy's `.audiobook/cast-id-history.json`, read directly
after the click):

```json
"supersededBy": {
  ...
  "mairin-onboxtest": "mairin"
},
"recordedAtSeq": { ..., "mairin-onboxtest": 7 },
"recordedAtIso": { ..., "mairin-onboxtest": "2026-08-21T04:18:37.452Z" }
```

Confirms `.audiobook/cast-id-history.json` gained a real `supersededBy`
entry for it, per A43 step 3's own text.

### Step 4 — re-run the dry pass, confirm the report/re-render counts moved

Dry run against the **copy's own workspace** after the link
(`WORKSPACE_DIR=<worktree>/castwright-workspace`, empty scratch `CACHE_DIR`):

```
--- Castwright / Standalones / Заказ Коалфолла ---
  SKIPPED:
    mayrin — already-recorded: cast-id-history.json already maps this to "mairin"
    coalfall — already-recorded: cast-id-history.json already maps this to "coalfall-dragon"
    mairin-onboxtest — already-recorded: cast-id-history.json already maps this to "mairin"
...
--- Re-render list ---
  Castwright / Standalones / Заказ Коалфолла | ch3 "Глава вторая — Отливка" | mairin-onboxtest | 2 seg | ~6s
...
--- Summary ---
reported for human decision: 8 id(s) / 53 segment(s)
skipped (already recorded / rejected): 3
re-render candidates: 11 chapter row(s) / 55 segment(s)
```

**PASS** — `mairin-onboxtest` moved out of "reported for human decision"
into "skipped (already recorded)", matching A43 step 4's criterion exactly
("the reported count dropped by that id"). It correctly **still** appears
on the re-render list (2 segments) since no actual re-render happened yet
— matches the UI's own "audio needs a re-render" label, and matches the
A33/§8's own established rule that only re-rendering, not merely recording
the alias, clears the re-render list (see `cast-id-drift-onbox-acceptance.md`
§9's `isAudioCurrent`/`castHistorySeq` mechanism).

### Step 5 — the negative case (both halves)

**(a) Direct POST, real HTTP call:**

```
$ curl -s -X POST "http://localhost:8170/api/books/shannon-messenger__keeper-of-the-lost-cities__exile/cast/timkin/link-orphan-match" \
    -H "Content-Type: application/json" -d '{"orphanedId":"unknown-male"}' \
    -w "\nHTTP_STATUS:%{http_code}\n"

{"error":"\"unknown-male\" is a shared fallback id — a minor-cast fold bucket — not one addressable character, so it can't be linked as the source of an alias."}
HTTP_STATUS:400
```

**PASS — 400, real reason in the body.**

**(b) Browser-rendered disabled affordance, visible reason:**

Screenshot: `docs/testing/onbox-wave4-results/screenshots/a43-04-negative-disabled-unknown-male.png`
— Exile Cast screen, needs-your-decision list, `"unknown-male"` row (21
segments). Selected "Timkin" (the ranked #1 candidate per the dry run) in
its combobox; **Link to this character stayed disabled**:

```js
// browser_evaluate on the button
{
  "title": "Can't link this — it's a shared fallback id (a minor-cast fold bucket), not one addressable character.",
  "disabled": true
}
```

**PASS — disabled, with a visible reason** (rendered as the button's
`title` tooltip, matching what the screenshot shows on hover).

### A43 verdict

**Fully discharged this step**, both halves of every sub-step: positive
link through the UI (steps 1-3), dry-run count drop (step 4), and the
negative case's both halves (step 5a direct POST 400, step 5b disabled
button + visible reason). The positive-link fixture was manufactured (see
Data setup above); the negative case, the dry-run drop measurement, and the
underlying resolver/history mechanics are all real, unedited data.

## A33 §8.8 ONLY — Cast-screen banner cross-check

Register row: `onbox-acceptance-register.md` A33 (L1671). Run-sheet
section: `cast-id-drift-onbox-acceptance.md` §8.8 (L622-631), exact wording:

> 13. Open the Cast screen for *Заказ Коалфолла* and *Everblaze*.
> Expected: the auto-reconciled section names `mayrin`/`coalfall` (Заказ
> Коалфолла) and `lady-alina` (Everblaze). The needs-your-decision section
> still names the untouched ids — spot-check *Exile*'s `unknown-male` as
> the negative control (a reserved-bucket source must still refuse to
> auto-record).

**Только §8.8 run this step. §8.7 was explicitly out of scope and is NOT
run — see "STILL OWED" below.** Everblaze itself was not copied into the
worktree this step (only Заказ Коалфолла and Exile were, per the A43
fixture decision above); its half of §8.8's wording is therefore not
independently re-confirmed here beyond what the real workspace's own
`cast-id-history.json` already shows (`lady-alina -> dame-alina`, read
directly, see Data setup). The Заказ Коалфолла half and the Exile negative
control are fully confirmed live in the browser below.

Screenshot: `docs/testing/onbox-wave4-results/screenshots/a33-01-koalfall-banner-auto-reconciled.png`
— *Заказ Коалфолла* Cast screen, "2 character ids auto-reconciled — audio
is current" bucket expanded:

```
button "2 character ids auto-reconciled — audio is current" [expanded]
list:
  listitem: "coalfall"  Коалфолл  13 segments
  listitem: "mayrin"    Мэйрин    8 segments
```

**PASS — names `mayrin`/`coalfall` exactly as §8.8 expects**, and labelled
"audio is current" (not "needs a re-render"), consistent with these two
aliases having been recorded well before this step (2026-08-05/08-20, per
the real `cast-id-history.json` timestamps read in Data setup).

Negative control: the same screenshot used for A43 step 5b
(`a43-04-negative-disabled-unknown-male.png`) also shows Exile's
needs-your-decision list still naming `"unknown-male"` (21 segments) —
**it did not move to auto-reconciled**, matching §8.8's negative-control
expectation exactly ("a reserved-bucket source must still refuse to
auto-record").

### A33 §8.8 verdict

**PASS, this step.** The Заказ Коалфолла auto-reconciled banner names
`mayrin`/`coalfall`; the Exile negative control (`unknown-male`) still sits
in needs-your-decision, unmoved. Everblaze's `lady-alina` half of the
wording is corroborated only by the real `cast-id-history.json` file read
directly (not by a live Everblaze Cast-screen render this step, since
Everblaze was not one of the two books copied in).

### §8.7 — STILL OWED to the operator

**Not run. Explicitly out of scope for this step**, per the task brief.
§8.7 (`cast-id-drift-onbox-acceptance.md` L606-621) needs a real TTS
render of *Заказ Коалфолла* ch2 (the chapter carrying the real
`mayrin`/`coalfall` orphaned segments) plus a human **listening** to
confirm both characters' lines are audibly distinct from the narrator —
neither the render nor the listen is agent-runnable. This remains owed to
the operator exactly as `onbox-sitting-cloning-identity.md` and the
register's A33 row already record.

**A33 is NOT retired by this step.** Only §8.8 is discharged here; §8.7
stays open, so the row as a whole stays open, matching the task brief's
explicit instruction not to claim A33 fully discharges.

## Box-safety — md5 before/after, source untouched

md5 of the source book files, captured **before** any work this step and
**again after** everything (including cleanup):

```
Before:
e334c7ee5be97c6315702100f70183fb *C:/AudiobookWorkspace/.../Заказ Коалфолла/.audiobook/cast.json
39be07401e62fb8d045b91cd6dd100d9 *C:/AudiobookWorkspace/.../Заказ Коалфолла/.audiobook/cast-id-history.json
66cdcf291c57c48d10981400dc9b0804 *C:/AudiobookWorkspace/.../Exile/.audiobook/cast.json

After:
e334c7ee5be97c6315702100f70183fb *C:/AudiobookWorkspace/.../Заказ Коалфолла/.audiobook/cast.json
39be07401e62fb8d045b91cd6dd100d9 *C:/AudiobookWorkspace/.../Заказ Коалфолла/.audiobook/cast-id-history.json
66cdcf291c57c48d10981400dc9b0804 *C:/AudiobookWorkspace/.../Exile/.audiobook/cast.json
```

**Byte-identical, confirmed.** The real workspace at `C:\AudiobookWorkspace`
was only ever read (the dry runs against it never used `--apply`); every
write this step (the manufactured orphan, the link-through-UI POST, the
`cast-id-history.json` growth) landed exclusively in the worktree's own
`castwright-workspace` copy.

## Cleanup performed

- App stopped: killed the two process trees actually bound to 8170/5263
  (`taskkill /PID 35284 /T /F`, `/PID 66272 /T /F`, plus their `cmd.exe`
  parents `13956`/`58796`) — confirmed via `netstat` that nothing listens
  on 8170 or 5263 afterward. No other process on the box was touched; other
  `wt-*` worktrees' lanes were left alone.
- Browser: no persistent tabs — the Playwright MCP session's pages are
  ephemeral to this run.
- Copied workspace book folders deleted from the worktree's own
  `castwright-workspace/books/`: both `Castwright/` and
  `Shannon Messenger/` subtrees removed; `castwright-workspace/books/` is
  empty again.

## Outcome summary

- [x] A43 — fully discharged this step (positive link + rendered-page
      confirmation + dry-run count drop + negative case both halves).
- [x] A33 §8.8 — discharged this step (banner cross-check, both the
      positive Заказ Коалфолла case and the Exile negative control).
- [ ] A33 §8.7 — **STILL OWED to the operator.** Needs a real TTS
      re-render of *Заказ Коалфолла* ch2 plus human listening. Tracked in
      `onbox-sitting-cloning-identity.md`; not attempted here, per the task
      brief's explicit scope boundary. **A33 stays open as a row.**
