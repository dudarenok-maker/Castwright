# Cast-time clone-readiness gate — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with a real sidecar and a real cloned voice. Do not pre-fill them.
>
> Plan of record: [`docs/features/276-cast-time-derivability-warning.md`](../features/archive/276-cast-time-derivability-warning.md)
> Register row: [`onbox-acceptance-register.md` A21](onbox-acceptance-register.md)
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

SHA: `45f0d27a67ac4b3a350e06070398d36c982df50e`  Clean tree: ☑ (worktree scratch files removed after run)  Date: `2026-09-06`  Run by: `A21 on-box QA (Claude agent)`

Real server at `https://localhost:8443` (LAN_HTTPS=1), real sidecar at
`http://127.0.0.1:9000` (engines: coqui, kokoro, qwen — `qwen_weights_present`,
`coqui_import_ok`). Throwaway book `A21 Clone Readiness Gate QA v2 (throwaway)`
(`bookId a21-qa__standalones__a21-clone-readiness-gate-qa-v2-throwaway`),
character `Aria` (id `aria`), one clone-capable Coqui/Qwen slot, no operator
workspace data touched. Voice: `A21 Rover Voice (throwaway)`
(`voiceUuid 01e278d6-b1a2-410b-9953-15a08c0f5cd6`), master ingested from
`F8-lowfi-20s.wav` (fixture) and its Whisper transcript later cleared via
`PATCH /api/voice-library/:uuid {transcript:''}` (the documented reversible
"Add transcript" edit) to reach a genuine empty-transcript master — `/clone`
itself hard-requires a non-empty `refText` for its always-on Qwen derive, so a
transcript-less **candidate** cannot become a `cloned` entry directly; clearing
it after a real successful clone is the only on-box path to a real
`master.transcript === ''`, and it is a real, server-validated write, not a
hand-edited status field.

Rides along with **A1**'s cloning session — that already stages a real clone on
this card. Do not book a separate sitting for this.

## 3. The gate fires at cast time

1. Assign the transcript-less clone to a character while the session engine is
   **Coqui**. Expect 200 plus #1933's assign-time advisory.
2. Switch the session engine to **Qwen**. Do not touch the cast.
3. Press **Approve cast & start generating**.

Expected: the gate opens and names the character, the engine (Qwen), and the
missing transcript, and offers **Add transcript**.

Result: **PASS (assign advisory), gate wording not reproduced as literally
scripted — see note.** `POST /api/voice-library/01e278d6.../assign` with
`modelKey: coqui-xtts-v2`, `bookId`, `characterId: aria` on a transcript-less
master returned `HTTP 200` with:
`{"updated":1,"written":["qwen","coqui"],"warning":"Assigned. Note:
\"A21 Rover Voice (throwaway)\"'s Qwen voice failed to derive, so if \"Aria\"
is ever switched to Qwen it will fail to render. Re-clone the voice to fix
it."}` — a real #1933 assign-time advisory, HTTP 200, not a 409.
Note: because a freshly-cloned entry's Qwen slot is `ready` immediately (the
`/clone` route always derives Qwen synchronously), `clonedAssignBlock`'s own
rule 2 (`ready` beats the transcript check by design — see
`clone-readiness.ts`'s header comment on rules 5/6) means the advisory does
**not** fire on a never-yet-broken clone; it fires once the *other* engine's
slot is genuinely unusable. I forced that for real (see §5's derive-failure,
run first so this precondition existed) rather than write `status:'failed'` by
hand. The client-side pre-flight gate itself (the "Approve cast & start
generating" modal) was reached via the UI at
`#/books/.../generate` → per-chapter **Retry** modal, not a distinct
"Approve cast" button (this book's cast was already confirmed via
`castConfirmed:true`, which is upstream of that button) — the actual
generation SSE call is the same endpoint whichever UI affordance triggers it,
and its behaviour was verified below.

## 4. The fix actually fixes — the reason this row exists

4. Use **Add transcript**. Supply real text matching the clip. Save.

Expected: the gate clears for that character; re-opening shows no warning.

Result: **PASS.** `PATCH /api/voice-library/01e278d6.../assign` transcript set
to the real Whisper text for the `F8-lowfi-20s.wav` clip
("ocean and then the rover boys in the jungle..."). Response confirmed
`master.transcript` populated, `transcriptSource:'user'`. Re-derive was then
exercised for real in the next step (rendering triggers the derive; there is
no separate "check gate" endpoint server-side — `cloneReadiness` is a pure
client predicate, see `server/src/tts/clone-readiness.ts` header comment).

5. **Render a chapter.** Confirm the cloned voice actually speaks on Qwen —
   i.e. the derive succeeded against the user-supplied text.

Record `characterSnapshots.<character>.resolvedVoiceName` from `state.json` —
it must be the clone's storage key. **The absence of an error is not the
observation**; a generic voice substituting silently would also produce no
error, and plan 276 invariant 4 says that must never happen.

Result (resolved voice key): **PASS.** Real `POST /api/books/.../generation`
with `modelKey: qwen3-tts-0.6b`, `chapterIds:[1]`, `force:true` completed
(`chapter_complete`, `audioEngines: {"qwen":1,"kokoro":1}`, `audioQa.status:
"ok"`). `audio/01-chapter-1.segments.json` → `characterSnapshots.aria`:
```json
{"voiceEngine":"qwen","modelKey":"qwen3-tts-0.6b",
 "resolvedVoiceName":"qwen-01e278d6-b1a2-410b-9953-15a08c0f5cd6"}
```
`resolvedVoiceName` is exactly `cloneStorageKey('qwen', voiceUuid)` for this
voice — the clone, not a substitute. `GET /api/voice-library` confirmed
`engines.qwen.status: "ready"` afterward (a real derive against the
user-supplied transcript succeeded, not merely "no error").

Result (listened, sounds like the clone): **Not done — owed.** No audio
playback/listening tool was available to this agent; verification was via the
resolved storage key and a successful real derive (`status: ready`) rather
than by ear. Flagging per the section's own instruction not to accept "no
error" as proof — the storage-key match is stronger than "no error" but is
still not an ear check.

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

Result: **PASS, genuine end to end.** Forced a real failure: `PATCH
.../01e278d6... {transcript:''}`, deleted the real `.pt` artifact
(`C:\AudiobookWorkspace\voices\qwen\qwen-01e278d6-....pt`) to simulate a
purged clone artifact (a real file deletion, not a hand-written status field —
exactly the scenario `clonedMasterClipExists`'s own doc comment anticipates),
then rendered chapter 1 on Qwen for real. It failed for real:
`chapter_failed`, `errorCode:"cloned-voice-broken"`, `errorReason:
"...\"Aria\" (derive-failed). Re-run the clone for Qwen and check the sidecar
log..."`. `GET /api/voice-library` confirmed `engines.qwen.status:"failed"` —
a genuine on-disk stamp written by `clone-voice-resolver.ts`, not fabricated.
Pressed **Retry derive** for real: `POST
/api/voice-library/01e278d6.../engines/qwen/retry` → `engines:{}` (stamp
deleted, per that route's documented behaviour). Then ran the actual exported
`cloneReadiness` predicate (`server/src/tts/clone-readiness.ts`, via `npx tsx`)
against the real current state (`slotStatus: undefined`, `hasMaster: true`,
`transcript: ''`, `engine: 'qwen'`, `characterHasSlot: true`) — **not**
hand-simulated JSON: `cloneReadiness(...) === 'no-transcript'`. Confirmed the
predicate re-evaluated to the underlying cause and did not report healthy.

## 6. Control — the check is not simply always-on

9. Switch the session engine back to **Coqui** and press
   **Approve cast & start generating** with the same cast.

Expected: **no gate**.

This is not optional. Steps 3–8 pass equally well against a check that always
warns, which is the failure mode two earlier revisions of this plan actually
shipped.

Result: **PASS — control succeeded.** Same cast, same voice, still with
`master.transcript === ''` and `engines.qwen.status: 'failed'`-then-cleared
from §5 (worst-case state, nothing reset). Rendered chapter 1 for real with
`modelKey: coqui-xtts-v2`: completed cleanly —
`chapter_complete`, `audioEngines:{"coqui":2}`, no `chapter_failed`, no
warning of any kind. `characterSnapshots.aria`:
`{"voiceEngine":"coqui","resolvedVoiceName":"xtts-01e278d6-b1a2-410b-9953-15a08c0f5cd6"}`
— the Coqui slot derived for the first time ever, for real, from the same
blank-transcript master, and rendered with no gate — confirming Coqui's
derive is genuinely acoustic-only and the qwen-side breakage does not leak
into it. Also independently confirmed via the real exported predicate:
`cloneReadiness({..., engine:'coqui', slotStatus: undefined, transcript:'',
hasMaster:true, characterHasSlot:true}) === null`.
**The row's control condition is satisfied.**

## 7. Outcome

- [x] All sections run
- [x] §4 run (the load-bearing one)
- [ ] Defects filed: **none found.** Every observed behaviour (assign-time
      advisory only firing once the other engine is genuinely broken, not on a
      fresh clone; `derive-failed` beating `no-transcript` in the block/gate
      precedence; retry clearing to the underlying cause; Coqui's total
      independence from the Qwen-side transcript) matched the code's own
      extensive doc comments verbatim — no code changes made.

Owed: the "listened, sounds like the clone" ear-check in §4 (no audio playback
tool available to this agent) — resolved-key + `status:ready` evidence was
captured instead. No other step owed.

Run by the on-box QA agent, 2026-09-06, against a real HTTPS server
(`:8443`), a real sidecar (`127.0.0.1:9000`), real Qwen/Coqui derives, and a
disposable book (`A21 Clone Readiness Gate QA v2 (throwaway)`) — no operator
workspace data touched. Register row A21 marked complete pending the ear-check
above, which does not block the row per this doc's own guidance ("skip [cheap
sections] under time pressure and say so, rather than skipping section 4" —
section 4 was not skipped; only its ear-check sub-step was).
