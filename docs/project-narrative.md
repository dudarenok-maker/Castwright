# Many Voices, One Machine
*A project narrative — updated 15 May 2026*

**Estimated read time:** 7 minutes for the narrative; 6 more for the functional and technical sections below.
**What this is:** The story behind a project I'm building during my time between roles — why fiction listening is broken, what I think can fix it, and where I am with the work. A functional section and a technical section sit below the narrative for design and engineering conversations. I refresh this every couple of days, so the dates and the state are honest at the top.

---

## The moment

I was driving the kids to my parents' place a few Saturdays ago. Half a fantasy novel deep on the bedside table, no chance of finishing it before bed for at least another week. I queued up the AI narrator everyone keeps recommending, settled in, and made it about four minutes before I caught myself reaching to turn the volume down — not because the voice was bad, but because it was the same.

Same voice for the thirteen-year-old apprentice. Same voice for the seventy-year-old swordsmith. Same voice for the dragon. Same voice for the narrator describing the dragon. All of it delivered in the careful, slightly bored register of someone reading instructions for a kettle.

The world I'd been building in my head — slowly, over weeks of stolen reading minutes — went quiet. The cast collapsed into a single observer. The story didn't end; the *book* did. What I was hearing was words.

I drove the rest of the trip in silence and thought about it.

## Why this is broken

There's a market gap hiding in plain sight, and once you see it, you can't unsee it.

Three things exist today. There's professional human narration — beautiful when it's right, expensive, slow to produce, and even at its best, a single human can only do so many distinct voices before the cast starts to blur. There's basic AI text-to-speech, which serves accessibility well and serves fiction badly. And there's a new generation of voice-cloning tools — ElevenLabs and friends — which can produce a stunning *single* voice from a sample, and are now used to clone narrators or read the news.

Nothing on that list does what fiction actually demands.

Fiction has a cast. Fiction has tone — a character is angry in this paragraph, broken in the next, deadpan three pages later. Fiction has narration that should *recede* when dialogue is happening and step forward when describing a sunset. Reading aloud is a performance, and what we have is dictation.

The reason nobody's built it isn't that the technology is missing. It's that the conventional path costs too much. Render every audiobook in the cloud, with frontier-model orchestration on every chapter, and you've priced out anyone who isn't a streaming service. The interesting question isn't *can it be done* — it's *can it be done on a machine someone already owns*.

That's the bet I'm taking.

## What I'm building

The shape of it is simple to describe.

You drop in a book. EPUB, PDF, plain text, paste. The system reads it, identifies the twenty or thirty main characters, and builds a voice profile for each — age, gender, accent if the text implies one, personality, the vocal qualities the writer keeps gesturing at. The narrator gets a profile too. Those profiles are unique to *this book* and they travel with it.

Then, chapter by chapter, the system renders the audio. Every line of dialogue lands in the right voice. Every paragraph of narration is delivered by the narrator the book has earned. Tone is read from the surrounding prose — fear sounds like fear, dry humour lands dry. When the apprentice speaks, you hear a thirteen-year-old. When the swordsmith answers, you hear seventy years and a forge.

Voices are reusable across books in a series. The narrator who carried Book 1 keeps carrying Book 2. A recurring character keeps their voice from one book to the next — and if the writer renamed them, the cast merge writes the old name into the new one's aliases, so the matcher in Book N+1 still recognises them. Your library learns who you've cast and offers them back, with provenance, every time you start a new manuscript.

You drop the resulting chapters into the audiobook app you already use. There's no new player. The magic isn't in the playback — it's in the conversion.

And it runs on the machine you own. The analysis pass uses a local LLM by default — Ollama with qwen3.5:4b — and falls back to Gemini's free tier if the daemon isn't reachable. There's a manual file-drop mode too, so a separate Claude window can do the heavy thinking for free when I want it to. Audio synthesis runs locally on XTTS v2, a voice-conversion model that fits on a mid-market GPU. Per-book, not per-listen. The frontier never sees a chapter.

## Why I'm building it

There are smarter business questions I could be working on. There are more obvious projects to put on a portfolio.

This one earns its place for three reasons, and I'd offer all three honestly.

I read a lot, and I drive a lot, and the gap between what I want from those two activities and what currently bridges them is personally insulting in the way only a small, fixable problem can be. I'm building this for me first.

The technology lives at the intersection of everything I've spent a career being interested in: AI, audio, taste, product, the boundary between what runs on a server and what runs at the edge. I cannot remember the last project I worked on where engineering, design, and craft all sat in the same room. This one does.

And — this is the part I haven't said out loud yet — I think the more interesting AI bets over the next two years are at the edge, on local hardware, doing things the cloud is too expensive to do. I want to be building one of those, with my own hands, while I'm thinking about what to build next at scale.

## Where it stands now

The first time I wrote this note, I called it *planning, paper, and a couple of small spikes*. That description is two months out of date in the way "small spike" turns into "the thing that runs the house" if you keep going.

The shape of the project today: **a working local audiobook pipeline, end-to-end, on the machine I own.** Ingest a manuscript, analyse it on a local LLM, cast it, synthesise it on a local GPU, listen to it, hand the chapters off to whichever audiobook app the listener already uses. Every stage works on a real book — a friend's novel, about 80k words, twenty-something characters, the canonical regression test I use because the failure modes are the interesting ones. Not every stage is *good* yet. But every stage works.

What that "works" actually covers:

**A real React application, not the Tailwind Play CDN mocks I started with.** Vite + React 18 + TypeScript + Redux Toolkit. A discriminated-union stage machine (`{ kind: 'books' | 'upload' | 'analysing' | 'confirm' | 'ready' }`) keeps the front end honest — you can't be on the *ready* stage with no book selected, because the type won't let you. A hash router symmetric with the stage machine means every screen is linkable and reloadable. OpenAPI is the type source of truth for characters, chapters, sentences, and voices — types are *generated*, not hand-written, and a hand-written shape is treated as a regression. CSS custom properties carry the design tokens, so the cream/ink/peach/magenta/deep-purple palette can never drift into hex literals in component code. The whole UI runs end-to-end against a mock layer behind `VITE_USE_MOCKS`, and components don't know which side they're talking to.

**A real Express server behind it.** Three analyzer engines, one TTS sidecar adapter, library scanner, OpenAPI-shaped routes the front end calls through a single `api` module. The two never talk except through the contract.

**Three analyzer engines, one contract.** Local Ollama (qwen3.5:4b) is the default. Gemini's free tier is the cloud fallback — automatic when the local daemon is unreachable, opt-in when I want to measure. And a manual file-drop mode that writes the analyzer prompt to an inbox folder and waits for JSON in an outbox folder, so a separate Claude window can do the thinking at zero API cost. That last mode is the one I use when I'm iterating on prompts, and it's load-bearing for how I work on this project.

**Analysis is multi-phase, chapter-by-chapter, with per-chapter failure recovery.** The obvious thing was to hand the whole book to the LLM and ask for the cast. That worked on toy manuscripts and silently fell over on real ones — malformed JSON, hallucinated speakers, daemon hangs. So the pipeline rebuilt itself in phases. Phase 0a walks the headings to find chapter boundaries with an observed-rate ETA and a watchdog. Phase 0b detects cast per chapter; one chapter's failure no longer torches the run, retries serialise against the main run so the daemon never sees two concurrent inflight requests, and the cast file is persisted incrementally so a crash mid-run doesn't lose work. Phase 0b cleanup folds descriptor-named characters into the right speaker, drops evidenceless ones, and rolls long-tail speakers into two minor-cast buckets the user can tune. Phase 1 verifies every claimed evidence quote against the source text with a three-tier match (verbatim → punctuation-normalised → sentence-segment overlap), drops what fails all three into an append-only audit ledger, and *blocks* advancement while any chapter is still failing — because partial casts produce silently-wrong voice matches downstream.

That paragraph is the thing I wish I'd known to build first.

**A TTS sidecar that runs at faster than real-time on consumer hardware.** A Python service wrapping XTTS v2, with DeepSpeed and fp16 wired in and pinned by pytest. On CPU it sat at 2.5–3.7× real-time, which made a chapter take longer to render than to listen to. On CUDA with fp16 and DeepSpeed it runs at 0.65–0.95× real-time, which means a chapter renders faster than it plays. The GPU is only 19–38% utilised because XTTS is kernel-launch-bound rather than compute-bound — that's the next lever — but the wall-clock number is already where I needed it.

**An 8 GB GPU that holds either the analyzer or the synthesiser, but not both.** Model lifecycle is button-driven. A Load / Stop pill in the application's top bar loads whichever model you're about to use and evicts the other one, with an inline banner so you know what happened. No eager preloads — the sidecar comes up in ~2 s with no model resident; the analyzer keeps qwen3.5:4b warm for five minutes and the heavier models for zero. Both sides expose load/unload as first-class HTTP, so the UI doesn't have to know which side of the GPU is hot. That single design choice — *don't preload* — is what makes the project's mid-market-hardware claim hold.

**Cross-book voice continuity, end-to-end.** The whole reason this project exists for a *series* and not a *book* is that you want the cast in Book 2 to sound like the cast in Book 1. When you confirm the cast on a new manuscript in an existing series, the matcher scores every existing voice in your library against the new manuscript's characters by name, alias, and token overlap on the descriptors. Returning characters get offered back with a *From [Book]* provenance pill before you've clicked. Manual cast merge writes the source character's name into the target's aliases — so a character introduced as *the swordsmith* in Book 1 and as *Aldric Verrin* in Book 2 still lands on the same voice the next time around.

**Audio is MP3 VBR V2 via ffmpeg**, chapter markers wired, and an ffmpeg preflight in the start-app script so a fresh machine fails fast.

**Persistence is a single `.audiobook/` directory per book.** `state.json` for the slice payload, `cast.json` for the live cast (persisted incrementally during analysis), `dropped-quotes.json` as the verifier's append-only audit ledger, chapter audio and voice samples beside them. The frontend hydrates from these on load and PUTs slice patches back as you edit. Re-parse preserves manuscript edits and surfaces drift from the saved snapshot — so if you accept new metadata and chapter boundaries move, you see exactly what shifted.

**A two-tier automated test gate, across four harnesses.** Vitest for the frontend, Vitest for the server, Pester 5 for the PowerShell helpers, pytest for the TTS sidecar. Pre-commit runs the fast battery (`verify:quick`); pre-push runs the full one (`verify`: typecheck + all tests + production build). On a solo project this sounds like overkill until you realise the analysis pipeline has enough moving parts to silently regress something every other commit. The gate is for future-me reading a six-week-old failure mode and trying to remember why a thing was the way it was.

**Six iterations of the application surface and one cohesive design language.** Stage flow for the linear, irreversible spine (*books → upload → analysing → confirm → ready*), tab flow for the non-linear surface inside *ready* (*Manuscript / Cast / Voices / Generate / Listen / Log*). A/B revision diff player that holds drafts sentence by sentence. Voice drift detector with severity tiers and a one-click route back into regeneration. Per-character and batch regeneration with three scope tiles and a live ETA. Listener app handoff with platform-accurate iOS and Android share-sheet phone-frame mockups for the apps people actually use. Every screen, every state, every modal — the application surface is mature.

What's *not* good enough yet to put in front of someone else: voice differentiation across twenty-plus characters in a single book is the open question. The model produces a distinct voice for any one character on demand; whether the cast collectively reads as twenty distinct people, or as five flavours of four, is something I can't measure from inside the application. Drift-detection cutoffs are still placeholders pending a labelled set. The qwen3.5:4b malformed-JSON rate is acceptable after the schema-format + divergent-retry + quote-escape-repair pass, but I haven't measured it cleanly; there's a parked experiment to swap to qwen3.5:9b once the KV-cache math says it fits resident in 8 GB at 16K context. XTTS v2 is the running TTS default; I haven't evaluated F5-TTS or OpenVoice v2 head-to-head on this manuscript.

The honest summary: **the engine runs, on the machine it's supposed to run on, against the book it's supposed to run on. Everything beyond that is calibration.**

## What I'd ask of you, if you've read this far

Two things, slightly different from the last revision.

If you know voice-conversion or TTS people — XTTS v2 internals, F5-TTS, the prosody-control end of the field, anyone working on local-AI audio quality — I'd like to meet them. The wall-clock problem is solved; the *taste* problem is wide open, and an introduction has saved me weeks every time in past lives.

If you want to react to the running application honestly — I can hand you a build and the canonical regression manuscript and you can hear it. I'd rather hear what's confusing now than what's polished later. The first ten minutes is the test: if you forget you're listening to AI, the bet works. If you don't, tell me where it broke.

The book can wait. Building can't.

---

## Appendix A — How it works (functional walkthrough)

*For readers who want to know what the application does today, screen by screen. The interaction patterns and design language are stable; specific behaviours are tagged by the regression plan in `docs/features/` that owns them.*

### Two navigation models, used deliberately

The application has two modes of movement.

**Stages are linear and irreversible.** A book moves through a fixed sequence — *books → upload → analysing → confirm → ready* — and you don't go back through them. Each completes forward. You upload a manuscript; the system analyses it; you confirm the cast; the book becomes ready to listen to and refine. The stage is a discriminated union in Redux (`ui.stage.kind`) and a hash-router fragment in the URL, kept symmetric by a single grammar (`src/lib/router.ts`).

**Tabs are non-linear and reversible.** Inside the *ready* state, six tabs sit across the top — *Manuscript / Cast / Voices / Generate / Listen / Log* — and you can move between them in any order. The book library and the application logo always return you to the library home, no matter where you are.

### The book library (home)

The application opens on a library of all your books. Each book sits on a card with a brand-gradient cover, the title in serif, a status pill, and three quick stats (chapters, voices, runtime). Status is derived from what's on disk: a progress bar for *generating*, a cast summary for *cast pending*, full runtime for *complete*, an analysis state for *analysing* (driven by an empty or partial `cast.json` plus the chapter cache).

Filter pills at the top — *All / In progress / Complete* — narrow the view with live counts. Clicking a book routes you to the right stage for its state. A book mid-analysis lands on the analysing screen; a book ready to listen lands on the Listen tab; a book waiting for cast confirmation lands on cast confirmation.

### The analysing view

The analysing view is more pipeline than progress bar. Phase 0a finds chapter boundaries with an observed-rate ETA so the time-remaining is honest rather than aspirational. Phase 0b detects cast per chapter, with cast chips appearing live and surviving phase transitions so you can see the roster build. Phase 1 verifies evidence quotes against the source text. A model picker lets you swap between local Ollama models and Gemini at any point; the dropdown groups by engine and routes on model-id shape, so the same UI handles both surfaces. If a chapter fails detection, you can retry just that chapter without restarting the run — the retry is serialised against the main run so the daemon doesn't get two concurrent inflight requests for the same context. Phase 1 advancement is blocked until every chapter has cleared cast detection, because partial casts produce silently-wrong voice matches downstream.

### The six tabs

**Manuscript** is the source-of-truth view of the book. Every paragraph renders as prose with character attribution applied at the sentence level — each sentence carries a colour-coded segment bar matching its assigned speaker. A drag handle sits between adjacent attributions; grab it and slide it across to reassign sentences from one speaker to another, with peach drop indicators showing the candidate target as you move. The narrator gets neutral grey so they don't compete for attention. Edits are non-destructive, persisted to `state.json`, and tracked in the change log.

**Cast** is the spreadsheet view of the characters. One row per speaker, with columns for assigned voice, gender, accent, age band, dialogue-line count, and status. Selecting one or more rows reveals a floating action bar at the bottom of the viewport — *Regenerate the selected characters across the book*. A drift indicator pill sits next to any character whose recent chapters have wandered from their established voice profile. Clicking a row opens the character's profile drawer with their full voice description, a sample, an evidence-quotes toggle, and a wide CTA — *Regenerate [Name]'s lines across the book*. Cast confirmation routes the user straight to Generate; generation is the natural next action after confirming the cast.

**Voices** is the library of every voice ever generated, across every book. Reused voices from prior books carry the deep-purple *library* pill and a *From [Book]* provenance line. You can audition any voice in place, assign it to a new character with one click, or pin a voice so it sticks across re-analyses.

**Generate** is the engine room. Chapters list down the left; the active chapter expands to show every character speaking in it, with per-character progress. A gradient progress bar runs along the top of the active chapter, animated with diagonal stripes while work is happening. Per-character refresh icons appear on hover, letting you regenerate one character's lines in one chapter without touching the rest. Regeneration scopes — *this chapter*, *this chapter and forward*, *whole book* — open a single modal with a live ETA that updates as the scope changes.

**Listen** is the rendered audiobook. An album-cover hero at the top uses the signature gradient with the book title in serif and a runtime/narrator credit. Below it, a chapter list with play buttons, durations, and current-position indicators. A mini-player pins to the bottom of the viewport across every page, so you can keep listening while you work elsewhere. The Listen header surfaces book metadata for inline editing.

**Log** is the auditable history. Every event the system has touched — regenerations, voice tunes, voice reuses, locks, boundary moves, chapter completes, cast confirms, analysis events, imports, library updates — grouped by *Today / Yesterday / Earlier* with a filter strip (*All / Voice / Generation / Manuscript / Cast*). Revertable events expose a Revert action inline.

### Cross-cutting capabilities

**A/B revision diff player.** Every regeneration is held as a draft until you accept it. The diff player is a full-screen overlay with two summary cards — *A (current)* and *B (new draft)* — and a per-segment list where each changed sentence shows both versions side-by-side with their own play buttons and waveforms. Per-segment radio choice lets you pick A or B sentence by sentence. An *Auto-compare* button plays each changed segment A-then-B in sequence. Quick actions at the foot of the overlay: *Accept all*, *Reject all*, *Commit selection*. A pulsing top-bar badge tells you when a draft is waiting.

**Voice drift detector.** Compares each rendered chapter against its character's established profile and surfaces chapters that have drifted. Severity-grouped — *Severe / Moderate / Mild* — with metric comparisons (current vs profile) for each event. *Regenerate this chapter* routes straight into the per-character regeneration modal pre-scoped to that chapter.

**Per-character and batch regeneration.** Two scoping triggers — one from the character drawer (defaults to *all chapters*), one from a per-chapter row (defaults to *just this chapter*) — both opening the same modal with three scope tiles, a reason chooser, and a live ETA that updates as you change the selection. Confirming flips the character's status from done to queued across the chosen chapters; affected chapters bump from *done* to *in-progress*. Batch regeneration extends this to multiple characters at once via a Cast table multi-select.

**Cross-book voice continuity.** Voices generated for one book in a series are offered back when you start a new manuscript in the same series. The matcher scores name + alias + token overlap so a character renamed between books still matches. Manual cast merge writes the merged source's name into the target's aliases, building the matching key for the next book in the same step.

**Listener app handoff.** Generated chapters export as M4B with chapter markers (or per-chapter MP3 as a fallback, since chapter audio is MP3 VBR V2 on disk via ffmpeg). Multi-step walkthrough modals guide the user through getting the file into the listener app of their choice — BookPlayer, Apple Books, Smart AudioBook Player, Audiobookshelf, Plex — with platform-accurate iOS and Android share-sheet phone-frame mockups embedded in the walkthrough.

**Model control pill.** A Load / Stop pill in the application's top bar surfaces both local models — the TTS sidecar (XTTS v2) and the analyzer (Ollama qwen3.5:4b) — with explicit load and unload, an auto-eviction banner when loading one frees the other, and an `/api/ps`-backed "currently resident" indicator. The auto-load helper warms a model just-in-time when the user clicks a sample play button on a cold pipeline.

### The design language, in one paragraph

Cream canvas, near-black ink, Neue Montreal type (Inter as the free fallback). The accent palette is restrained to three colours, each with a single job. **Peach** (`#F79A83`) is the action colour — drag rings, drop indicators, regen affirmations, selected segments, active filter pills. Nothing idle uses it. **Magenta** (`#A43C6C`) carries the brand and the horizontal accent gradient. **Deep purple** (`#3C194F`) is series-context — reused voices, library matches, anything that belongs to a book beyond the current one. The signature four-stop vertical gradient (`#0F0E0D` → `#3C194F` → `#A43C6C` → `#F79A83`) appears no more than three times per page — at the end-of-page CTA or album-cover hero, at the active progress bar, and at one "magic moment" (analysis, cast confirmation, or the listen page hero). Every h1 and h2 carries one bold span inside an otherwise medium-weight sentence — the bold word carries the meaning, the rest is context. Tokens live as CSS custom properties in `src/styles.css`; Tailwind references the vars. Component code never sees a hex literal.

---

## Appendix B — Technical design

*For readers who want to challenge the architecture rather than the story. Compact by design; happy to go deeper on any block in conversation. The state described here is the running application, not a future plan.*

### Pipeline (end-to-end)

**1. Ingest.** Accept EPUB, PDF, plain text, paste. The original bytes are persisted verbatim so re-parse can run without a `%TEMP%` roundtrip. Markdown is the canonical intermediate; chapter structure preserved, front-matter and back-matter chapters excluded from analysis and audio at the user's discretion.

**2. Analysis.** Three engines, one contract:

- **Local Ollama** (`ANALYZER=local`, default) — qwen3.5:4b as the default model; warmed with the same `num_ctx` as the analyzer uses (16384, after silent hangs on long chapters at lower values); GPU pinned via `num_gpu: 999`; `keep_alive` is 5m for qwen3.5:4b and 0 for heavier models so VRAM frees promptly. Auto-falls back to Gemini if the daemon is unreachable.
- **Gemini direct** (`ANALYZER=gemini`) — Gemini 2.5 Flash by default (flip to 3 Flash without code changes via `GEMINI_MODEL`). Streamed responses with a live heartbeat and a silence watchdog. Free-tier friendly.
- **Manual file-drop** (`ANALYZER=manual`) — writes the analyzer prompt to `server/handoff/inbox/`, waits for a JSON response in `server/handoff/outbox/`. A second Claude window does the thinking; zero API cost. The mode I use when iterating on prompts.

The analysis itself runs in phases:

- **Phase 0a — Chapter boundary discovery.** Walks the headings with an observed-rate ETA so the progress bar reflects measured throughput. Watchdog recovers from a wedged response without aborting the run.
- **Phase 0b — Per-chapter cast detection.** Each chapter is its own LLM call, because a single whole-book call silently failed on long manuscripts (malformed JSON, hallucinated speakers, daemon hangs). One chapter's failure no longer torches the run; failed chapters are retried serially against the main run so the daemon never sees two concurrent inflight requests for the same context. The cast file is persisted incrementally so a crash mid-run doesn't lose work.
- **Phase 0b cleanup.** Descriptor-named characters (e.g. *the apprentice*) are folded into the right speaker; evidenceless characters are dropped; "Unknown X" and low-line speakers fold into two minor-cast buckets with a threshold the user can tune.
- **Phase 1 — Evidence verification.** Every claimed evidence quote is reconciled against the source text using a three-tier match — verbatim, punctuation-normalised, sentence-segment overlap. Quotes that fail all three are dropped into `.audiobook/dropped-quotes.json` (append-only ledger) so I can audit verifier-prompt regressions. Phase 1 advancement is blocked while any chapter is still failing cast detection.
- **Library check.** Series-context match against voices already generated for prior books, scoring by name + alias + token overlap. Matches are offered back during cast confirmation with provenance.

The analyzer prompt is single-sourced; model/URL fallbacks resolve from one location so the analysis model is configurable without touching multiple files.

**3. Voice profile generation.** For each character and the narrator, generate a voice profile compatible with the local voice-conversion model. Profiles include text-derived attributes (age, gender, accent cues, vocal qualities) and a sample quote — verified against the source, never fabricated. Profiles are persisted per book and linked by reference when reused across books.

**4. Synthesis.** XTTS v2 via a local Python sidecar (`server/tts-sidecar/`). DeepSpeed + fp16 wired in for CUDA; PCM-to-int16-LE conversion handles clipping, stereo downmix, and list inputs cleanly. Output is MP3 VBR V2 via ffmpeg, with a legacy WAV fallback for pre-format chapters. The sidecar defaults to `PRELOAD_COQUI=0` so the port comes up in ~2 s with no model resident — model load is button-driven. Endpoints: `POST /api/sidecar/{load,unload}`, `POST /api/ollama/{load,unload}`. Loading one auto-evicts the other; a banner in the UI tells the user what just happened. The Ollama side uses the daemon's `keep_alive` idiom for the in-band evict.

**5. Verification.** The voice-drift comparator runs on every rendered chapter, computing metric distances between the chapter's audio and the character's established profile. Drift events are surfaced in the application with severity tiers and a one-click route back into the regeneration flow. Cutoffs are still placeholders pending a labelled set.

**6. Distribution.** Output as M4B with chapter markers; per-chapter MP3 fallback. Sideload into any app that accepts M4B. No proprietary player.

### Application architecture (UI layer)

- **Vite + React 18 + TypeScript + Redux Toolkit**, served from `src/`. Self-contained mocks behind `VITE_USE_MOCKS` mean components are oblivious to the backend.
- **Two-axis navigation** — stages (linear, irreversible) and tabs (non-linear, reversible inside *ready*). The stage is a discriminated union (`src/store/ui-slice.ts`) and a hash-router grammar (`src/lib/router.ts`), kept symmetric by a `RouterStore` adapter so the router stays decoupled from the store.
- **OpenAPI as type source of truth.** `openapi.yaml` at the repo root; `src/lib/api-types.ts` regenerated via `npm run openapi:types`. Character, Chapter, Sentence, Voice — all generated.
- **CSS custom properties for design tokens.** `--peach`, `--ink`, `--magenta`, `--deep-purple` etc. declared in `src/styles.css`; `tailwind.config.ts` references the vars. No hex literals in component code.
- **RTK Immer drafts.** Slice reducers mutate via drafts; spread-style rewrites are a regression.
- **Multi-book state.** `activeBookId` is the global key; every sub-view reads from it. The application logo and project title in the topbar always return to the library home.
- **Auditable change log.** Every state-mutating event is captured in an append-only timeline with type, target, timestamp, and revertability flag. The Log tab is a UI over that stream.

### Server layer

- **Express + TypeScript**, served from `server/`. Routes wire the OpenAPI contract end-to-end. Three analyzer adapters, one TTS sidecar adapter, one library scanner.
- **`.env` via Node 20.6+ native `process.loadEnvFile`** — no dotenv dependency. `server/.env.example` documents the surface.
- **Persistence is per-book under `.audiobook/`** — `state.json` (slice payload), `cast.json` (live cast, persisted incrementally during analysis), `dropped-quotes.json` (append-only verifier ledger), chapter audio + voice samples.
- **Log lines carry millisecond timestamps** so 6 a.m. me has a chance of debugging midnight me.

### Test discipline

Four harnesses, two-tier git gate.

- **Vitest (frontend)** — `npm run test`. Tests live next to the unit.
- **Vitest (server)** — `cd server && npm run test`. Same colocation, including real-ffmpeg integration where relevant.
- **Pester 5 (PowerShell scripts)** — `scripts/tests/` covers log rotation, OneDrive-lock-tolerant workspace bootstrap, and start-app preflight.
- **pytest (TTS sidecar)** — `server/tts-sidecar/tests/` covers smoke, synthesis, and runtime wiring. The runtime-wiring suite pins the CUDA + DeepSpeed + fp16 primary path: DeepSpeed init reaches the model and runs before `tts.to(device)`, init failure is swallowed, fp16 autocast wraps the synth call, audio conversion handles clipping/stereo/list-input. The pytest harness isn't wired into `npm run test:all` yet — that's the next gate milestone.
- **Husky pre-commit** runs `npm run verify:quick` (frontend + server + Pester). **Pre-push** runs `npm run verify` (typecheck + all tests + production build). I don't use `--no-verify`; the gate is the contract.

### Non-negotiables

- **Local for synthesis.** Audio rendering does not depend on cloud inference. Frontier-model use is bounded to the analysis pass — and even there, local is the default.
- **Open formats throughout.** EPUB and PDF in. Markdown intermediate. M4B and MP3 out. Voice profiles in a documented schema.
- **Privacy by default.** Books, profiles, and renders all stay on the user's machine unless explicitly exported.
- **Mid-market hardware target.** Production target is an 8 GB consumer GPU with the analyzer and the TTS resident one-at-a-time, not both at once. If it requires datacentre GPUs to be useful, the project has missed its point.
- **No proprietary player.** The magic is in the conversion, not the playback; the audiobook drops into the app the listener already uses.
- **OpenAPI is the contract, not the documentation.** Types come from the generated file; hand-written shapes are a regression.

### Open questions and known risks

- **Voice-conversion model selection.** XTTS v2 is the running default; F5-TTS and OpenVoice v2 haven't been evaluated head-to-head on this manuscript. Quality, licensing for derivative voices, and prosody control are the three competing axes.
- **Cast diversity at scale.** Each voice is plausible alone; whether twenty voices in one book collectively read as twenty distinct people is the question I can't answer from inside the application.
- **qwen3.5:4b malformed-JSON rate.** Acceptable today after the schema-format + divergent-retry + quote-escape-repair pass, but not measured cleanly. A parked experiment swaps to qwen3.5:9b once the KV-cache math says it fits resident in 8 GB at 16K.
- **Drift detection thresholds** — the metric set and the severity cutoffs need calibration against a labelled set of drifted-vs-not chapter audio. Currently placeholder.
- **Speaker attribution accuracy** — long-tail dialogue (no "she said" tag) is the hard case. The drag-handle reattribution UI is the user-correctable fallback; the open question is what fraction of cases reach the user.
- **Performance ceiling.** XTTS is kernel-launch-bound on this GPU at 19–38% utilisation. CUDA-graph capture or a batched-prefill rework is the next lever.
- **OneDrive sync locks.** The repo sits under a OneDrive-synced folder. `pip install/uninstall` fails with WinError 5 if the folder is mid-sync; the start-app script routes around it but the failure mode is worth documenting for anyone cloning fresh.
- **Legal and IP** — rendering a copyrighted book locally for personal use is the use case. Distribution of rendered audio is not.

### What success looks like, technically

A user drops a book on the application, walks away, and comes back to a folder of chapter audio files that, when played in their existing app, makes them forget they're listening to AI for the first ten minutes — and remembers a character's voice the next morning.

---

## Sources & maintenance

- `docs/features/INDEX.md` — living regression plans for every feature. The features doc is the spec; this narrative is the story.
- `CLAUDE.md` — project context for Claude Code: commands, layout, conventions, test discipline.
- `openapi.yaml` — API contract, source of truth for backend shapes.
- `server/.env.example` — analyzer / TTS engine configuration surface.

**Maintenance cadence:** I refresh this document every couple of days, or whenever a single change has shifted the *story* of where the project is — not every feature, but every plot point. The dated header at the top is the contract. If a reader can't tell from the first paragraph that they're seeing recent state, the doc has failed.

This first refresh captures the project as a whole — the holistic shape of what exists today, not a delta against the last note. Future refreshes can run as deltas once there's a stable "as of" to diff against.
