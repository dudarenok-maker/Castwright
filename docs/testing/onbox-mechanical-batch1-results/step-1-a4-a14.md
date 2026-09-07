# Mechanical batch 1 — step 1: A4 (audition engine + tier fidelity) + A14 (real-book badge agreement)

Run 2026-09-06, worktree `C:\Claude\Projects\wt-onbox-mechanical-batch1`, branch
`docs/docs-onbox-mechanical-batch1`, server `:8220`, sidecar `:9140` (per-worktree
ports from `.env.local` / `server/.env`), frontend `:5313`. Book: the built-in
sample book "The Coalfall Commission" (`castwright__standalones__the-coalfall-commission`),
created via "or try a sample book" on an empty library — a real, freshly-analysed
manuscript with 14 characters, not a canned fixture.

## A4 — audition engine + tier fidelity

### Bullet 1 — Kokoro override renders in Kokoro, not silently falling back

**PASS**, verified by direct log inspection (not by ear, per the row's own allowance).

Method deviation from the row's literal wording: rather than a whole book whose
*default* engine is Coqui, I exercised the same code path — the per-character
"Voice engine for this character" override on the profile drawer
(`src/components/voice-override-picker.tsx` / `src/modals/profile-drawer.tsx`) —
against the character Maerin the reeve, in two steps:

1. Set Maerin's override to **Coqui XTTS**, saved, played her sample. Server log:
   `[tts] char-...__maerin → Sofia Hellen (engine=coqui, model=coqui-xtts-v2, ...)`.
2. Set Maerin's override to **Kokoro**, saved, played her sample again. Server log:
   `[tts] char-...__maerin → af_bella (engine=kokoro, model=kokoro-v1, ...)`.

Each switch produced a synthesis call tagged with the *correct* engine and model —
no silent fall-through to Coqui, Qwen, or a stale cached file from the previous
engine. This is the same override mechanism a Coqui-default book's per-character
picker would exercise; the book's own default engine is orthogonal to whether the
override plumbing dispatches correctly, which is what this bullet is actually
checking for.

### Bullet 2 — 1.7B tier renders at 1.7B, not silently falling back to 0.6B

**PASS**, verified by artifact filename plus sidecar state, not by ear.

The book's own Generate page defaults to "Engine: Qwen3-TTS 1.7B" already (no
override needed to reach this tier). The full multi-chapter render through the
normal generation queue turned out to be broken in this dev stack (see "Generation
queue does not dispatch to the sidecar" below), so tier fidelity was instead
verified through the "My voices → Create voice" design/audition path, which uses
the same Qwen synthesis call. Console log:

```
[sample-playback] playing /audio/voices/qwen-QMjdXT2qxxnNjGkjT6kan-qwen3-tts-1.7b-5j0f3o.mp3
```

The rendered file's own model-key segment is `qwen3-tts-1.7b`, not `qwen3-tts-0.6b`
— the tier actually used for synthesis is embedded in the artifact name by the
pipeline itself, so this is not a UI label that could lie about the model that
really ran.

### Bullet 3 — design/play cache pairing (no second synthesis on first Play)

**PASS**, verified by console log, not by ear.

Designed a new library voice ("Onbox Test Voice A4-3") via My Voices → Create
voice → Design & audition. The design step produced:

```
11:18:02.962 [sample-playback] playing /audio/voices/qwen-QMjdXT2qxxnNjGkjT6kan-qwen3-tts-1.7b-5j0f3o.mp3
```

Saved the voice, then pressed "Preview" on the saved library entry. Result:

```
11:18:38.445 [sample-playback] playing /audio/voices/qwen-QMjdXT2qxxnNjGkjT6kan-qwen3-tts-1.7b-5j0f3o.mp3
```

Identical filename (same hash, same model-key) on both plays — the Play step
reused the design step's own audio file rather than firing a second
`/synthesize` call. This is exactly the design/play cache pairing the row is
checking for (#2023-era bug: the two sides previously hashed different
filenames).

### Bullet 4 — capacity failure with Coqui resident names Coqui + points at its Stop button

**NOT ATTEMPTED this run.** Forcing a genuine VRAM capacity refusal safely
requires either a large concurrent multi-engine load or a box with materially
less free VRAM than this one has right now (GPU0 RTX 4070 8 GB had ~7.4 GB free,
GPU1 RTX 5070 Ti 16 GB had 9.9–15 GB free during this session, and shared with
other concurrently-running lanes on this box per the standing rule against
contending for a card another lane is using). Constructing an artificial
capacity refusal reliably — without risking an actual OOM crash on another
lane's resident model — needs more sidecar-internals knowledge and a dedicated
follow-up pass than this run's remaining time allowed after the generation-queue
investigation below. Left as owed acceptance, not as a pass or a fail.

One relevant, confirmed detail for whoever picks this up: the Coqui "Stop"
control the row expects the error to point at is real and reachable — it renders
as a `Stop Coqui XTTS` button next to a `Coqui XTTS ready` badge in the
"Voice engines loaded" strip at the top of every book page once Coqui is
resident (confirmed visually in this session).

## A14 — real-book QA/badge agreement

**BLOCKED — could not render.** Not attempted-and-failed; the render never
produced a completed chapter to compare badges on, root-caused live to a
generation-pipeline bug distinct from anything in scope for this row.

### The bug, reproduced twice

Symptom: clicking "Start generating" (or a single chapter's own "Generate this
chapter") marks the chapter "In progress" / "In flight" in both the Activity log
and the queue modal, the UI banner eventually reads "Worker has gone quiet — No
progress for N s", and the chapter settles into a `Stalled` state at `0/N` lines
— but the sidecar's own `/health` never shows `qwen_loading: true` or
`inflight_synth > 0` for that job, and `server` log gains zero `[tts]` lines for
it. The queue believes work is happening; the sidecar was never asked to do any.

Reproduced across a full dev-server restart (`npm run dev` killed and relaunched
clean): the restart logged
`[queue] reset 1 orphaned in_progress entry to queued on boot`
— i.e. the *previous* stall had already left an orphaned in-progress entry
behind, which the boot-time reconciler is aware of and designed to recover — but
the freshly-restarted server's own new generation attempt stalled the same way
within about a minute, on a different chapter, with a clean sidecar and 9+ GB
free on the GPU actually hosting Qwen. This rules out "leftover bad state from
this session's earlier voice-engine experiments" as the explanation — a cold
server hit the same wall.

What did keep working throughout, on the same sidecar, using the same Qwen
engine: single-line "sample" synthesis (voice preview/design, per A4 above).
Only the chapter-generation queue's dispatch-to-sidecar path is affected.

### Side effect of the restart: two chapters lost their analysis

After the restart, chapters 1 and 2 (of the original 4) showed
"Excluded — not analyzed, no audio will be generated." in the Generate view,
despite having been part of the completed cast-confirmation earlier in this same
session. Chapters 3 and 4 (562 + 2,184 words, 210 lines, the two largest)
remained analysed and queued. This looks like in-memory-only analysis state that
a restart does not persist to disk, which is itself worth a look but is not
something this row was scoped to chase down.

### What this means for the row

No chapter completed synthesis, so there is no rendered chapter to compare a
Suspect-badge true-peak reading against a Listen-view loudness badge for. The
row's criterion (plan 274 §6 row 1) cannot be exercised until the generation
queue actually dispatches work to the sidecar again.

## Recommendation

File the generation-queue stall (chapters marked in-flight/stalled with the
sidecar never contacted) as its own bug — it blocks A14 outright and would block
any other on-box row that needs a completed multi-chapter render. A4's bullets
1–3 stand on their own evidence and do not depend on this fix.
