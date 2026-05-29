# Many Voices, One Machine

_A project narrative — updated 29 May 2026_

**Estimated read time:** 7 minutes for the narrative; 7 more for the functional and technical sections below.
**What this is:** The story behind a project I'm building during my time between roles — why fiction listening is broken, what I think can fix it, and where I am with the work. A functional section and a technical section sit below the narrative for design and engineering conversations. I refresh this every couple of days, so the dates and the state are honest at the top.

---

## The moment

I was driving the kids to my parents' place a few Saturdays ago. Half a fantasy novel deep on the bedside table, no chance of finishing it before bed for at least another week. I queued up the AI narrator everyone keeps recommending, settled in, and made it about four minutes before I caught myself reaching to turn the volume down — not because the voice was bad, but because it was the same.

Same voice for the thirteen-year-old apprentice. Same voice for the seventy-year-old swordsmith. Same voice for the dragon. Same voice for the narrator describing the dragon. All of it delivered in the careful, slightly bored register of someone reading instructions for a kettle.

The world I'd been building in my head — slowly, over weeks of stolen reading minutes — went quiet. The cast collapsed into a single observer. The story didn't end; the _book_ did. What I was hearing was words.

I drove the rest of the trip in silence and thought about it.

## Why this is broken

There's a market gap hiding in plain sight, and once you see it, you can't unsee it.

Three things exist today. There's professional human narration — beautiful when it's right, expensive, slow to produce, and even at its best, a single human can only do so many distinct voices before the cast starts to blur. There's basic AI text-to-speech, which serves accessibility well and serves fiction badly. And there's a new generation of voice-cloning tools — ElevenLabs and friends — which can produce a stunning _single_ voice from a sample, and are now used to clone narrators or read the news.

Nothing on that list does what fiction actually demands.

Fiction has a cast. Fiction has tone — a character is angry in this paragraph, broken in the next, deadpan three pages later. Fiction has narration that should _recede_ when dialogue is happening and step forward when describing a sunset. Reading aloud is a performance, and what we have is dictation.

The reason nobody's built it isn't that the technology is missing. It's that the conventional path costs too much. Render every audiobook in the cloud, with frontier-model orchestration on every chapter, and you've priced out anyone who isn't a streaming service. The interesting question isn't _can it be done_ — it's _can it be done on a machine someone already owns_.

That's the bet I'm taking.

## What I'm building

The shape of it is simple to describe.

You drop in a book. EPUB, PDF, MOBI, plain text, paste. The system reads it, identifies the twenty or thirty main characters, and builds a voice profile for each — age, gender, accent if the text implies one, personality, the vocal qualities the writer keeps gesturing at. The narrator gets a profile too. Those profiles are unique to _this book_ and they travel with it.

Then, chapter by chapter, the system renders the audio. Every line of dialogue lands in the right voice. Every paragraph of narration is delivered by the narrator the book has earned. Tone is read from the surrounding prose — fear sounds like fear, dry humour lands dry. When the apprentice speaks, you hear a thirteen-year-old. When the swordsmith answers, you hear seventy years and a forge.

Voices are reusable across books in a series. The narrator who carried Book 1 keeps carrying Book 2. A recurring character keeps their voice from one book to the next — and if the writer renamed them, the cast merge writes the old name into the new one's aliases, so the matcher in Book N+1 still recognises them. Your library learns who you've cast and offers them back, with provenance, every time you start a new manuscript.

You drop the resulting chapters into the audiobook app you already use. There's no new player. The magic isn't in the playback — it's in the conversion.

And it runs on the machine you own. The analysis pass uses a local LLM by default — Ollama with qwen3.5:4b — and falls back to Gemini's free tier if the daemon isn't reachable. There's a manual file-drop mode too, so a separate Claude window can do the heavy thinking for free when I want it to. Audio synthesis runs locally too: Kokoro v1 is the default voice engine, with Coqui XTTS v2 and a newer Qwen3-TTS engine available for zero-shot cloning and bespoke per-character voices — all of them models that fit on a mid-market GPU. Per-book, not per-listen. The frontier never sees a chapter.

## Why I'm building it

There are smarter business questions I could be working on. There are more obvious projects to put on a portfolio.

This one earns its place for three reasons, and I'd offer all three honestly.

I read a lot, and I drive a lot, and the gap between what I want from those two activities and what currently bridges them is personally insulting in the way only a small, fixable problem can be. I'm building this for me first.

The technology lives at the intersection of everything I've spent a career being interested in: AI, audio, taste, product, the boundary between what runs on a server and what runs at the edge. I cannot remember the last project I worked on where engineering, design, and craft all sat in the same room. This one does.

And — this is the part I haven't said out loud yet — I think the more interesting AI bets over the next two years are at the edge, on local hardware, doing things the cloud is too expensive to do. I want to be building one of those, with my own hands, while I'm thinking about what to build next at scale.

## Where it stands now

The first time I wrote this note, I called it _planning, paper, and a couple of small spikes_. That description is two months out of date in the way "small spike" turns into "the thing that runs the house" if you keep going.

The shape of the project today, as v1.5.0 sits tagged: **a working local audiobook pipeline, end-to-end, on the machine I own — packaged, driving on a phone, and now designing a bespoke voice per character.** Tagged release zip, cross-OS verify, one-click install path. Ingest a manuscript, analyse it on a local LLM, cast it, synthesise it on a local GPU, listen to it, hand the chapters off to whichever audiobook app the listener already uses — share a 30-second clip, mint a streaming-link URL, keep editorial notes per book, audition voices without committing, run two tabs in lockstep across the same workspace, and queue generation across several books at once while it churns in the background. Every stage works on a real series — The Hollow Tide, a multi-book run with a large recurring cast that has to keep its voices consistent from one volume to the next. It's the canonical regression I lean on precisely because the cross-book failure modes — a character introduced under one name and later revealed under another, a voice that has to stay the same person across books — are the interesting ones. Not every stage is _good_ yet. But every stage works, on desktop and on a phone or tablet over the home network, and a clean Windows / macOS / Linux box can install and run the whole thing from a release zip without me on the other end of a Slack DM.

What that "works" actually covers:

**A real React application, not the Tailwind Play CDN mocks I started with.** Vite + React 18 + TypeScript + Redux Toolkit. A discriminated-union stage machine (`{ kind: 'books' | 'upload' | 'analysing' | 'confirm' | 'ready' }`) keeps the front end honest — you can't be on the _ready_ stage with no book selected, because the type won't let you. A hash router symmetric with the stage machine means every screen is linkable and reloadable. OpenAPI is the type source of truth for characters, chapters, sentences, and voices — types are _generated_, not hand-written, and a hand-written shape is treated as a regression. CSS custom properties carry the design tokens, so the cream/ink/peach/magenta/deep-purple palette can never drift into hex literals in component code. The whole UI runs end-to-end against a mock layer behind `VITE_USE_MOCKS`, and components don't know which side they're talking to.

**A real Express server behind it.** Three analyzer engines, one TTS sidecar adapter, library scanner, OpenAPI-shaped routes the front end calls through a single `api` module. The two never talk except through the contract.

**Three analyzer engines, one contract.** Local Ollama (qwen3.5:4b) is the default. Gemini's free tier is the cloud fallback — automatic when the local daemon is unreachable, opt-in when I want to measure. And a manual file-drop mode that writes the analyzer prompt to an inbox folder and waits for JSON in an outbox folder, so a separate Claude window can do the thinking at zero API cost. That last mode is the one I use when I'm iterating on prompts, and it's load-bearing for how I work on this project.

**Analysis is multi-phase, chapter-by-chapter, with per-chapter failure recovery.** The obvious thing was to hand the whole book to the LLM and ask for the cast. That worked on toy manuscripts and silently fell over on real ones — malformed JSON, hallucinated speakers, daemon hangs. So the pipeline rebuilt itself in phases. Phase 0a walks the headings to find chapter boundaries with an observed-rate ETA and a watchdog. Phase 0b detects cast per chapter; one chapter's failure no longer torches the run, retries serialise against the main run so the daemon never sees two concurrent inflight requests, and the cast file is persisted incrementally so a crash mid-run doesn't lose work. Phase 0b cleanup folds descriptor-named characters into the right speaker, drops evidenceless ones, and rolls long-tail speakers into two minor-cast buckets the user can tune. Phase 1 verifies every claimed evidence quote against the source text with a three-tier match (verbatim → punctuation-normalised → sentence-segment overlap), drops what fails all three into an append-only audit ledger, and _blocks_ advancement while any chapter is still failing — because partial casts produce silently-wrong voice matches downstream.

That paragraph is the thing I wish I'd known to build first.

**A TTS sidecar that runs at faster than real-time on consumer hardware.** A Python service wrapping XTTS v2, with DeepSpeed and fp16 wired in and pinned by pytest. On CPU it sat at 2.5–3.7× real-time, which made a chapter take longer to render than to listen to. On CUDA with fp16 and DeepSpeed it runs at 0.65–0.95× real-time, which means a chapter renders faster than it plays. The GPU is only 19–38% utilised because XTTS is kernel-launch-bound rather than compute-bound — that's the next lever — but the wall-clock number is already where I needed it. The newer Qwen engine is the slower, higher-touch path — it _designs_ a bespoke voice rather than reading a catalogue, and even batched into whole-chapter forward passes it sits around RTF 2 on a 4070 (roughly twice the audio's length to render), so a Qwen chapter renders slower than it plays. Batching is what claws that back from a serial rate several times worse; getting below RTF 2 is the open perf problem, and it's the one place this wall-clock story isn't won yet.

**An 8 GB GPU that holds either the analyzer or a heavyweight synthesiser, but not both — and a default that eats none of that budget.** Kokoro v1 is the default TTS engine, eager-loaded inside the sidecar at ~1 GB VRAM and ~1 s cold-start, sitting permanently resident alongside the analyzer Ollama on an 8 GB card. Two heavier engines stay button-driven for users who want more: Coqui XTTS v2 for zero-shot voice cloning, and a new Qwen3-TTS engine that _designs_ a bespoke voice from a character's persona and caches it for reuse. The top bar lets you load either on demand, evicting whatever it has to, with an inline banner so you know what happened. Engine choice is now per character — a narrator on Kokoro, a principal on a designed Qwen voice, all in the same book — and the assignments survive an engine switch. And because more than one book can be in flight at once, a VRAM-weighted arbitration semaphore now meters the card by per-engine cost, so concurrent sessions share the GPU instead of fighting over it. The mid-market-hardware claim holds without the user having to think about it.

**Cross-book voice continuity, end-to-end.** The whole reason this project exists for a _series_ and not a _book_ is that you want the cast in Book 2 to sound like the cast in Book 1. When you confirm the cast on a new manuscript in an existing series, the matcher scores every existing voice in your library against the new manuscript's characters by name, alias, and token overlap on the descriptors. Returning characters get offered back with a _From [Book]_ provenance pill before you've clicked. Manual cast merge writes the source character's name into the target's aliases — so a character introduced as _the swordsmith_ in Book 1 and as _Aldric Verrin_ in Book 2 still lands on the same voice the next time around.

**Audio is MP3 VBR V2 via ffmpeg**, loudness-normalised to EBU R128, written with a seekable Xing/Info VBR header so every player reports the right duration and scrubs cleanly, chapter markers wired, and an ffmpeg preflight in the start-app script so a fresh machine fails fast.

**Persistence is a single `.audiobook/` directory per book.** `state.json` for the slice payload, `cast.json` for the live cast (persisted incrementally during analysis), `dropped-quotes.json` as the verifier's append-only audit ledger, chapter audio and voice samples beside them. The frontend hydrates from these on load and PUTs slice patches back as you edit. Re-parse preserves manuscript edits and surfaces drift from the saved snapshot — so if you accept new metadata and chapter boundaries move, you see exactly what shifted.

**A two-tier automated test gate, across five harnesses.** Vitest for the frontend, Vitest for the server, Pester 5 for the PowerShell helpers, pytest for the TTS sidecar, and Playwright for browser-level end-to-end golden paths — plus an axe-core accessibility pass over the core views. Pre-commit runs the fast battery (`verify:fast`); pre-push runs the full one (`verify`: typecheck + lint + all tests + e2e + production build). On a solo project this sounds like overkill until you realise the analysis pipeline has enough moving parts to silently regress something every other commit. The gate is for future-me reading a six-week-old failure mode and trying to remember why a thing was the way it was.

**A complete, end-to-end application surface under one cohesive design language.** Stage flow for the linear, irreversible spine (_books → upload → analysing → confirm → ready_), tab flow for the non-linear surface inside _ready_ (_Manuscript / Cast / Voices / Generate / Listen / Log_). A/B revision diff player that holds drafts sentence by sentence. Voice drift detector with severity tiers and a one-click route back into regeneration. Per-character and batch regeneration with three scope tiles and a live ETA. Listener app handoff with platform-accurate iOS and Android share-sheet phone-frame mockups for the apps people actually use. Every screen, every state, every modal — the application surface is mature.

The v1.3.0 listen surface — speed picker, markers, sleep timer, real RMS waveform peaks, resume bookmarks, editorial notes, clip share, streaming-link download, the per-candidate voice audition, the revision-history timeline, the cross-tab `BroadcastChannel` sync, locked-stable dark mode, the no-terminal in-app onboarding — and the v1.4.0 packaging-and-mobile round are all baseline now, folded into what's described above. Here's what the v1.5.0 round pushed on top, and they're the biggest structural moves since the analysis pipeline was rebuilt in phases.

**Generation became a queue, not a stream.** The old model ran one book's generation as a live SSE stream; the moment you wanted a second book churning, or wanted the work to survive a page reload, the abstraction creaked. So it got rebuilt around a persisted queue. `.queue.json` in the workspace is now the single source of truth across every book; N configurable workers (default two) pull from it and coalesce per book; a global queue modal lets you see and drag-reorder everything in flight regardless of which book's view you're standing in. Close the tab, reopen it, the queue is exactly where you left it. This is the change that finally makes "analyse Book A while Book B generates and I edit the cast on Book C" a real workflow instead of an aspiration.

**A third voice engine that designs a voice instead of picking one.** Kokoro and XTTS read from fixed catalogues or clone from a sample. The new Qwen3-TTS engine takes a character's persona — the age, the accent cues, the vocal qualities the analysis already pulled from the text — and _designs_ a bespoke voice, then caches the embedding and reuses it for consistency across the book and the series. Engine choice is per character now, so a single book can mix a Kokoro narrator with designed Qwen principals, even within one chapter, and the worker pool synthesises the mixed cast in parallel. Under the hood Qwen renders a whole chapter in batched forward passes — length-bucketed to cut padding waste, with an SDPA attention path and a prompt cache — which pulls the batched rate to around RTF 2 on a 4070: still slower than playback (a chapter takes roughly twice its run-time to render), but several times better than the serial path. An opt-in FlashAttention-2 wheel is there for deployers who want to push it further, and dropping below RTF 2 is still open work. This is also the engine half of multi-language: Qwen3-TTS is the path to voices that aren't English.

**Analysis got a second model.** The phase pipeline now runs two models, not one: an aggressive model races ahead on Phase 0 chapter detection while a careful model follows on Phase 1 evidence verification, gated behind a chapter-index warm-up lag so attribution anchors to the roster-author model before the second model joins. The analysing view shows both model chips and lets you swap either mid-run.

**Casting a series, not just a book.** Cross-book continuity grew a deliberate workflow on top of the matcher described above. A _Rebaseline the series_ modal designs bespoke voices for the principal cast across every book in the series at once, with a current-vs-proposed audition before it regenerates anything, and it collapses recurring cast by name and alias so the same character isn't proposed twice. A cross-book duplicate-review surface walks you through likely-duplicate characters so a returning cast member doesn't fork into two library entries — and the link and aliases now ride on the voice itself, so the duplicate warning stays gone after a reload. The Voices view leads with voice _status_ now (a _Sampled_ tier joins _Matched_ and _Generated_), and a shared searchable picker makes assigning a voice across a long cast bearable.

**You can see how fast it's rendering.** Synthesis reports a live real-time factor up the whole stack — the sidecar times each batch, the server relays it, the frontend shows it — so instead of trusting on faith that the GPU is earning its keep, you read the render speed off the Generate view and the logs. That readout is what turned the round's one real performance scare into a config fix instead of a code hunt: the slow runs were the GPU parking its clocks, not the pipeline.

**And a handful of smaller moves that land bigger than they sound.** The top bar's scatter of state indicators collapsed into a single _Status_ pill — TTS load errors, analyzer state, pipeline readiness, all behind one hover popover — so the concurrent multi-book workflow stays legible no matter which book's view you're standing in. Every screen now stamps the running build in its footer (`v1.5.0 (a1b2c3d)`), so a deployer can confirm at a glance that an upgraded bundle actually extracted over the old one instead of running stale. And the import surface grew: EPUBs recover their chapter titles from the NCX even when the primary parser balks at a namespace-prefixed OPF, and MOBI joins the accepted formats — with a clean, actionable message on a DRM-locked file instead of an opaque server error.

**What's _not_ good enough yet to put in front of someone else.** With Qwen3-TTS designing a bespoke voice per character, a twenty-plus-character book no longer collapses onto a handful of catalogue voices — every character gets its own designed voice, so differentiation is handled by construction rather than rationed from a fixed pool. What I still can't judge from inside the application is the _taste_ layer above that: whether those designed voices are perceptually distinct and well-matched enough, across a whole cast, to carry a long listen. Drift-detection cutoffs are still placeholders pending a labelled set. The qwen3.5:4b malformed-JSON rate is acceptable after the schema-format + divergent-retry + quote-escape-repair pass, but I haven't measured it cleanly; the parked experiment to swap to qwen3.5:9b once the KV-cache math says it fits resident in 8 GB at 16K context still hasn't run. Kokoro v1, XTTS v2, and Qwen3-TTS are the three running engines; I haven't evaluated F5-TTS or OpenVoice v2 head-to-head on this manuscript. And multi-language is half-built: the Qwen3-TTS engine and the per-engine voice plumbing are in, but the language-detection-and-filtering half — auto-detecting a non-English manuscript, filtering the voice library to its language, never letting a cast cross languages — is the next big piece, and the most-requested one.

The honest summary: **the engine runs, on the machine it's supposed to run on, against the book it's supposed to run on, and the install can now go straight into someone else's hands. Everything beyond that is calibration.**

## What I'd ask of you, if you've read this far

Two things, slightly different from the last revision.

If you know voice-conversion or TTS people — XTTS v2 internals, F5-TTS, the prosody-control end of the field, anyone working on local-AI audio quality — I'd like to meet them. The wall-clock problem is largely solved — Kokoro and XTTS render faster than they play, and the bespoke-Qwen path (~RTF 2) is the holdout — but the _taste_ problem is wide open, and an introduction has saved me weeks every time in past lives.

If you want to react to the running application honestly — I can hand you a build and the canonical regression manuscript and you can hear it. I'd rather hear what's confusing now than what's polished later. The first ten minutes is the test: if you forget you're listening to AI, the bet works. If you don't, tell me where it broke.

The book can wait. Building can't.

---

## Appendix A — How it works (functional walkthrough)

_For readers who want to know what the application does today, screen by screen. The interaction patterns and design language are stable; specific behaviours are tagged by the regression plan in `docs/features/` that owns them._

### Two navigation models, used deliberately

The application has two modes of movement.

**Stages are linear and irreversible.** A book moves through a fixed sequence — _books → upload → analysing → confirm → ready_ — and you don't go back through them. Each completes forward. You upload a manuscript; the system analyses it; you confirm the cast; the book becomes ready to listen to and refine. The stage is a discriminated union in Redux (`ui.stage.kind`) and a hash-router fragment in the URL, kept symmetric by a single grammar (`src/lib/router.ts`).

**Tabs are non-linear and reversible.** Inside the _ready_ state, six tabs sit across the top — _Manuscript / Cast / Voices / Generate / Listen / Log_ — and you can move between them in any order. The book library and the application logo always return you to the library home, no matter where you are.

### The book library (home)

The application opens on a library of all your books. Each book sits on a card with a brand-gradient cover, the title in serif, a status pill, and three quick stats (chapters, voices, runtime). Status is derived from what's on disk: a progress bar for _generating_, a cast summary for _cast pending_, full runtime for _complete_, an analysis state for _analysing_ (driven by an empty or partial `cast.json` plus the chapter cache).

Filter pills at the top — _All / In progress / Complete_ — narrow the view with live counts. Clicking a book routes you to the right stage for its state. A book mid-analysis lands on the analysing screen; a book ready to listen lands on the Listen tab; a book waiting for cast confirmation lands on cast confirmation.

### The analysing view

The analysing view is more pipeline than progress bar. Phase 0a finds chapter boundaries with an observed-rate ETA so the time-remaining is honest rather than aspirational. Phase 0b detects cast per chapter, with cast chips appearing live and surviving phase transitions so you can see the roster build. Phase 1 verifies evidence quotes against the source text. The pipeline can run two models at once — an aggressive model on Phase 0 detection, a careful model trailing on Phase 1 verification, gated behind a chapter-index warm-up lag so the roster anchors to the first model before the second joins. The view shows a chip for each phase's model, and a model picker lets you swap either between local Ollama models and Gemini at any point; the dropdown groups by engine and routes on model-id shape, so the same UI handles both surfaces. If a chapter fails detection, you can retry just that chapter without restarting the run — the retry is serialised against the main run so the daemon doesn't get two concurrent inflight requests for the same context. Phase 1 advancement is blocked until every chapter has cleared cast detection, because partial casts produce silently-wrong voice matches downstream.

### The six tabs

**Manuscript** is the source-of-truth view of the book. Every paragraph renders as prose with character attribution applied at the sentence level — each sentence carries a colour-coded segment bar matching its assigned speaker. A drag handle sits between adjacent attributions; grab it and slide it across to reassign sentences from one speaker to another, with peach drop indicators showing the candidate target as you move. The narrator gets neutral grey so they don't compete for attention. Edits are non-destructive, persisted to `state.json`, and tracked in the change log.

**Cast** is the spreadsheet view of the characters. One row per speaker, with columns for assigned voice, gender, accent, age band, dialogue-line count, and status. Selecting one or more rows reveals a floating action bar at the bottom of the viewport — _Regenerate the selected characters across the book_. A drift indicator pill sits next to any character whose recent chapters have wandered from their established voice profile. Clicking a row opens the character's profile drawer with their full voice description, a sample, an evidence-quotes toggle, an editable alias list (editing aliases re-attributes the matching lines), a per-engine voice picker — assign a Kokoro voice, an XTTS speaker, or a designed Qwen voice independently, so switching the engine keeps the assignment — and a wide CTA, _Regenerate [Name]'s lines across the book_. Cast confirmation routes the user straight to Generate; generation is the natural next action after confirming the cast.

**Voices** is the library of every voice ever generated, across every book. Reused voices from prior books carry the deep-purple _library_ pill and a _From [Book]_ provenance line. You can audition any voice in place, assign it to a new character with one click, or pin a voice so it sticks across re-analyses. Compare lifts across books — A/B two voices from different books side by side — and a duplicate-review surface walks you through likely-duplicate characters across the series so a recurring cast member doesn't fork into two library entries. The view leads with voice _status_ (a _Sampled_ tier joins _Matched_ and _Generated_), and a shared searchable picker adds autocomplete to the voice, model, and merge selectors. For Qwen3-TTS, this is also where a bespoke voice gets _designed_ from a character's persona and cached for reuse, rather than picked from a fixed catalogue.

**Generate** is the engine room. Chapters list down the left; the active chapter expands to show every character speaking in it, with per-character progress. A gradient progress bar runs along the top of the active chapter, animated with diagonal stripes while work is happening. Per-character refresh icons appear on hover, letting you regenerate one character's lines in one chapter without touching the rest. Regeneration scopes — _this chapter_, _this chapter and forward_, _whole book_ — open a single modal with a live ETA that updates as the scope changes. Behind it all is a persisted queue: everything you enqueue lands in a workspace-wide queue (drained by a configurable pool of workers, two by default) that survives a reload and spans books, so a second book's chapters can be churning while you work on this one. A global queue modal — reachable from any view, with a top-bar chip showing depth — lists every item in flight and lets you drag to reorder them.

**Listen** is the rendered audiobook. An album-cover hero at the top uses the signature gradient with the book title in serif and a runtime/narrator credit. Below it, a chapter list with play buttons, durations, and current-position indicators. A mini-player pins to the bottom of the viewport across every page, so you can keep listening while you work elsewhere. The Listen header surfaces book metadata for inline editing.

**Log** is the auditable history. Every event the system has touched — regenerations, voice tunes, voice reuses, locks, boundary moves, chapter completes, cast confirms, analysis events, imports, library updates — grouped by _Today / Yesterday / Earlier_ with a filter strip (_All / Voice / Generation / Manuscript / Cast_). Revertable events expose a Revert action inline.

### Cross-cutting capabilities

**A/B revision diff player.** Every regeneration is held as a draft until you accept it. The diff player is a full-screen overlay with two summary cards — _A (current)_ and _B (new draft)_ — and a per-segment list where each changed sentence shows both versions side-by-side with their own play buttons and waveforms. Per-segment radio choice lets you pick A or B sentence by sentence. An _Auto-compare_ button plays each changed segment A-then-B in sequence. Quick actions at the foot of the overlay: _Accept all_, _Reject all_, _Commit selection_. A pulsing top-bar badge tells you when a draft is waiting.

**Voice drift detector.** Compares each rendered chapter against its character's established profile and surfaces chapters that have drifted. Severity-grouped — _Severe / Moderate / Mild_ — with metric comparisons (current vs profile) for each event. _Regenerate this chapter_ routes straight into the per-character regeneration modal pre-scoped to that chapter.

**Per-character and batch regeneration.** Two scoping triggers — one from the character drawer (defaults to _all chapters_), one from a per-chapter row (defaults to _just this chapter_) — both opening the same modal with three scope tiles, a reason chooser, and a live ETA that updates as you change the selection. Confirming flips the character's status from done to queued across the chosen chapters; affected chapters bump from _done_ to _in-progress_. Batch regeneration extends this to multiple characters at once via a Cast table multi-select.

**Cross-book voice continuity.** Voices generated for one book in a series are offered back when you start a new manuscript in the same series. The matcher scores name + alias + token overlap so a character renamed between books still matches. Manual cast merge writes the merged source's name into the target's aliases, building the matching key for the next book in the same step.

**Listener app handoff.** Generated chapters export as M4B with chapter markers (or per-chapter MP3 as a fallback, since chapter audio is MP3 VBR V2 on disk via ffmpeg). Multi-step walkthrough modals guide the user through getting the file into the listener app of their choice — BookPlayer, Apple Books, Smart AudioBook Player, Audiobookshelf, Plex — with platform-accurate iOS and Android share-sheet phone-frame mockups embedded in the walkthrough.

**Unified Status pill.** The top bar's separate state indicators collapsed into a single _Status_ pill backed by a status modal, with a hover popover that reveals the detail inline without opening the modal (and keeps the cast drawer open underneath). It surfaces TTS load errors, analyzer and generation state, and pipeline readiness in one place, so the global picture stays legible across the concurrent multi-book workflow regardless of which book's view is active. Model lifecycle still lives here: the analyzer (Ollama qwen3.5:4b) and the button-driven TTS engines (Coqui XTTS v2 and Qwen3-TTS; Kokoro v1 is eager-loaded and needs no load step) load and unload explicitly, with an auto-eviction banner when loading one frees the other and an `/api/ps`-backed "currently resident" indicator; an auto-load helper warms an engine just-in-time when the user hits a sample play button on a cold pipeline.

**Responsive across phone, tablet, and desktop.** Every view holds its shape at three breakpoints: single-column with drawers, bottom sheets, and full-screen modals on a phone; two-column with right-drawer secondary panes on a tablet; three-pane with the full top bar on desktop. The rule is touch-equivalence — every desktop drag or hover affordance ships a tap replacement (the cast voice library's drag-to-row also offers an _Assign_ pill; the manuscript boundary handle is one PointerEvent path covering mouse, touch, and pen; hover-reveal labels stay faintly visible on touch devices), and every interactive control meets a 44 px touch target. A one-time mkcert step serves the app over LAN HTTPS so a phone or tablet on the home network loads it with a lock icon and no certificate warning.

**Build-version footer.** Every view stamps the running build at the bottom of the page — `v1.5.0 (a1b2c3d)` in production, a verbose `v1.5.0 · sha · branch · time` in dev — so a deployer (or future-me) can confirm at a glance which bundle is actually running.

### The design language, in one paragraph

Cream canvas, near-black ink, Neue Montreal type (Inter as the free fallback). The accent palette is restrained to three colours, each with a single job. **Peach** (`#F79A83`) is the action colour — drag rings, drop indicators, regen affirmations, selected segments, active filter pills. Nothing idle uses it. **Magenta** (`#A43C6C`) carries the brand and the horizontal accent gradient. **Deep purple** (`#3C194F`) is series-context — reused voices, library matches, anything that belongs to a book beyond the current one. The signature four-stop vertical gradient (`#0F0E0D` → `#3C194F` → `#A43C6C` → `#F79A83`) appears no more than three times per page — at the end-of-page CTA or album-cover hero, at the active progress bar, and at one "magic moment" (analysis, cast confirmation, or the listen page hero). Every h1 and h2 carries one bold span inside an otherwise medium-weight sentence — the bold word carries the meaning, the rest is context. Tokens live as CSS custom properties in `src/styles.css`; Tailwind references the vars. Component code never sees a hex literal.

---

## Appendix B — Technical design

_For readers who want to challenge the architecture rather than the story. Compact by design; happy to go deeper on any block in conversation. The state described here is the running application, not a future plan._

### Pipeline (end-to-end)

**1. Ingest.** Accept EPUB, PDF, MOBI, plain text, paste. EPUB chapter titles are read from the NCX, with a raw-zip fallback that recovers books whose OPF uses namespace-prefixed elements or that the primary parser rejects; a DRM-locked MOBI returns a clean 415 with an actionable message rather than an opaque 500. The original bytes are persisted verbatim so re-parse can run without a `%TEMP%` roundtrip. Markdown is the canonical intermediate; chapter structure preserved, front-matter and back-matter chapters excluded from analysis and audio at the user's discretion.

**2. Analysis.** Three engines, one contract:

- **Local Ollama** (`ANALYZER=local`, default) — qwen3.5:4b as the default model; warmed with the same `num_ctx` as the analyzer uses (16384, after silent hangs on long chapters at lower values); GPU pinned via `num_gpu: 999`; `keep_alive` is 5m for qwen3.5:4b and 0 for heavier models so VRAM frees promptly. Auto-falls back to Gemini if the daemon is unreachable.
- **Gemini direct** (`ANALYZER=gemini`) — `gemma-4-31b-it` by default (its own free-tier bucket at 1,500 requests/day; flip to `gemini-3.1-flash-lite` etc. without code changes via `GEMINI_MODEL`). Every outbound call is gated through a per-model RPM/TPM/RPD limiter so retries can't compound into 429/500 storms. Streamed responses with a live heartbeat and a silence watchdog. Free-tier friendly.
- **Manual file-drop** (`ANALYZER=manual`) — writes the analyzer prompt to `server/handoff/inbox/`, waits for a JSON response in `server/handoff/outbox/`. A second Claude window does the thinking; zero API cost. The mode I use when iterating on prompts.

The analysis itself runs in phases:

- **Phase 0a — Chapter boundary discovery.** Walks the headings with an observed-rate ETA so the progress bar reflects measured throughput. Watchdog recovers from a wedged response without aborting the run.
- **Phase 0b — Per-chapter cast detection.** Each chapter is its own LLM call, because a single whole-book call silently failed on long manuscripts (malformed JSON, hallucinated speakers, daemon hangs). One chapter's failure no longer torches the run; failed chapters are retried serially against the main run so the daemon never sees two concurrent inflight requests for the same context. The cast file is persisted incrementally so a crash mid-run doesn't lose work.
- **Phase 0b cleanup.** Descriptor-named characters (e.g. _the apprentice_) are folded into the right speaker; evidenceless characters are dropped; "Unknown X" and low-line speakers fold into two minor-cast buckets with a threshold the user can tune.
- **Phase 1 — Evidence verification.** Every claimed evidence quote is reconciled against the source text using a three-tier match — verbatim, punctuation-normalised, sentence-segment overlap. Quotes that fail all three are dropped into `.audiobook/dropped-quotes.json` (append-only ledger) so I can audit verifier-prompt regressions. Phase 1 advancement is blocked while any chapter is still failing cast detection.
- **Two-model pipelining.** Phase 0 and Phase 1 can run different models concurrently — an aggressive model on detection, a careful model trailing on verification — on a watermark seam gated by a chapter-index warm-up lag (default 10), so attribution anchors to the roster-author model before the second model joins. Per-phase models resolve env > per-request > user-settings > default.
- **Library check.** Series-context match against voices already generated for prior books, scoring by name + alias + token overlap. Matches are offered back during cast confirmation with provenance.

The analyzer prompt is single-sourced; model/URL fallbacks resolve from one location so the analysis model is configurable without touching multiple files.

**3. Voice profile generation.** For each character and the narrator, generate a voice profile compatible with the local voice-conversion model. Profiles include text-derived attributes (age, gender, accent cues, vocal qualities) and a sample quote — verified against the source, never fabricated. Profiles are persisted per book and linked by reference when reused across books.

**4. Synthesis.** Three engines behind one local Python sidecar (`server/tts-sidecar/`), chosen _per character_:

- **Kokoro v1** (default) — eager-loaded at sidecar start, ~1 GB VRAM, ~1 s cold load, English-only catalogue of 28 voices. Permanently resident alongside the analyzer Ollama, so the default path costs nothing in lifecycle UX.
- **Coqui XTTS v2** — zero-shot voice cloning, button-driven (`PRELOAD_COQUI=0` so the port comes up in ~2 s with no model resident). DeepSpeed + fp16 wired in for CUDA; PCM-to-int16-LE conversion handles clipping, stereo downmix, and list inputs cleanly.
- **Qwen3-TTS** — _designs_ a bespoke voice from a character's persona via a transient VoiceDesign 1.7B model (kept warm across a cast-review session, freed on an idle watchdog — `QWEN_DESIGN_IDLE_TTL`, default 120 s — or at the first real synth), then caches the embedding (`voices/qwen/<id>.pt` + manifest) and reuses it for consistency. The Base 0.6B model synthesises from the cached voice in batched forward passes (`QWEN_BATCH_SIZE`, default 8) with length-bucketing to cut padding waste, an SDPA attention path plus prompt cache, and an optional FlashAttention-2 wheel (`QWEN_ATTN_IMPL`); the batched path runs at roughly RTF 2 end-to-end on a 4070 (≈ twice the audio's duration to render), down from a serial rate several times worse — sub-RTF-2 is dispatch-bound and still open.

Per-character engine choice lives in a per-engine override map on the character — `overrideTtsVoices: { coqui? | kokoro? | gemini? | qwen? }` — so switching the engine preserves the assignment (legacy single-field `overrideTtsVoice` is migrated lazily at read time). Within a single chapter, the sentences fan out across a bounded sentence-level worker pool, so a mixed-engine cast renders in parallel — a distinct layer from the chapter dispatcher (see _Generation queue_ below), which schedules whole chapters across books. Output is MP3 VBR V2 via ffmpeg — the one and only chapter-audio format — EBU R128 loudness-normalised and written through a temp file so a seekable Xing/Info VBR header lands (players report the right duration and scrub cleanly); `scripts/rexing-existing.mjs` back-fills the header losslessly onto an older library. Endpoints: `POST /load`, `POST /unload`, `POST /synthesize`, `POST /qwen/design-voice` on the sidecar; `POST /api/ollama/{load,unload}` for the analyzer. Loading a heavy engine auto-evicts the analyzer (and vice versa); a banner in the UI tells the user what just happened. The Ollama side uses the daemon's `keep_alive` idiom for the in-band evict.

**5. Verification.** The voice-drift comparator runs on every rendered chapter, computing metric distances between the chapter's audio and the character's established profile. Drift events are surfaced in the application with severity tiers and a one-click route back into the regeneration flow. Cutoffs are still placeholders pending a labelled set.

**6. Distribution.** Output as M4B with chapter markers; per-chapter MP3 fallback. Sideload into any app that accepts M4B. No proprietary player.

### Generation queue & GPU arbitration

- **A persisted queue is the single source of truth.** `.queue.json` at the workspace level (not per-book) holds every enqueued unit across all books; there's no implicit "this book is generating" override any more. The frontend mirrors it through a Redux slice fed by SSE with auto-reconnect and `resume_from`, and a `BroadcastChannel` keeps two tabs' queue chips in lockstep. The mock layer runs an in-memory queue with the same contract, so the whole flow exercises end-to-end without a server.
- **N workers drain it — one queue worker = one chapter.** The dispatcher (default two workers, set by `GEN_WORKERS` env or the `generationWorkers` user-setting) claims one chapter per worker and opens its own stream, so N chapters run concurrently across all books — including sibling chapters of the *same* book (the old per-book chapter scheduler was removed; this dispatcher is now the sole chapter-level concurrency authority — a separate layer from the sentence-level pool that parallelises synthesis inside each chapter). Jobs are keyed `${bookId}::${chapterId}`, so forcing chapter X displaces only chapter X's prior job — a sibling chapter Y of the same book is untouched. Each entry leaves the queue the instant its own chapter completes (chapter-level reconcile), and the dispatcher flips an entry to `in_progress` the moment it claims it so the queue modal shows live in-flight chapters rather than a stale "Queued".
- **A VRAM-weighted semaphore arbitrates the GPU.** Concurrent sessions acquire tokens priced per engine (the analyzer, a heavy TTS engine, and Kokoro cost different amounts), so multi-book work shares an 8 GB card instead of deadlocking. The per-engine cost map is provisional and wants tuning against real hardware.
- **Live render-speed telemetry.** Each synthesis batch reports its real-time factor from the sidecar through the server to the frontend, surfaced in the Generate view and the structured logs, so render throughput is observable rather than inferred — and generation is gated on the target engine being model-ready before the first chapter, so a cold sidecar can't drop the opening sentences.

### Application architecture (UI layer)

- **Vite + React 18 + TypeScript + Redux Toolkit**, served from `src/`. Self-contained mocks behind `VITE_USE_MOCKS` mean components are oblivious to the backend.
- **Two-axis navigation** — stages (linear, irreversible) and tabs (non-linear, reversible inside _ready_). The stage is a discriminated union (`src/store/ui-slice.ts`) and a hash-router grammar (`src/lib/router.ts`), kept symmetric by a `RouterStore` adapter so the router stays decoupled from the store.
- **OpenAPI as type source of truth.** `openapi.yaml` at the repo root; `src/lib/api-types.ts` regenerated via `npm run openapi:types`. Character, Chapter, Sentence, Voice — all generated.
- **CSS custom properties for design tokens.** `--peach`, `--ink`, `--magenta`, `--deep-purple` etc. declared in `src/styles.css`; `tailwind.config.ts` references the vars. No hex literals in component code.
- **RTK Immer drafts.** Slice reducers mutate via drafts; spread-style rewrites are a regression.
- **Multi-book state.** `activeBookId` is the global key; every sub-view reads from it. The application logo and project title in the topbar always return to the library home.
- **Cross-tab sync.** A `BroadcastChannel` middleware (`src/store/broadcast-middleware.ts`) mirrors analysis- and generation-pill state across tabs on the same workspace — full snapshots plus debounced progress diffs, with instance-tagged echo suppression — so a second tab stays live without re-hitting the catch-up endpoint.
- **Decomposed views.** The listen view is a thin orchestrator over three region sub-components (`src/components/listen/`), so feature work lands in the relevant region file rather than fighting for one monolith.
- **Auditable change log.** Every state-mutating event is captured in an append-only timeline with type, target, timestamp, and revertability flag. The Log tab is a UI over that stream.

### Server layer

- **Express + TypeScript**, served from `server/`. Routes wire the OpenAPI contract end-to-end. Three analyzer adapters, one TTS sidecar adapter, one library scanner.
- **`.env` via Node 20.6+ native `process.loadEnvFile`** — no dotenv dependency. `server/.env.example` documents the surface.
- **Persistence is per-book under `.audiobook/`** — `state.json` (slice payload), `cast.json` (live cast, persisted incrementally during analysis), `dropped-quotes.json` (append-only verifier ledger), chapter audio + voice samples. The generation queue lives one level up, workspace-wide, in `.queue.json`.
- **Log lines carry millisecond timestamps** so 6 a.m. me has a chance of debugging midnight me.

### Test discipline

Five harnesses, two-tier git gate.

- **Vitest (frontend)** — `npm run test`. Tests live next to the unit.
- **Vitest (server)** — `cd server && npm run test`. Same colocation, including real-ffmpeg integration where relevant. Five timeout-prone files split off into a one-fork `test:server-slow`.
- **Pester 5 (PowerShell scripts)** — `scripts/tests/` covers log rotation, OneDrive-lock-tolerant workspace bootstrap, and start-app preflight.
- **pytest (TTS sidecar)** — `server/tts-sidecar/tests/` covers smoke, synthesis, runtime wiring, Kokoro, Qwen3, logging format, and concurrent synthesis. The runtime-wiring suite pins the CUDA + DeepSpeed + fp16 primary path: DeepSpeed init reaches the model and runs before `tts.to(device)`, init failure is swallowed, fp16 autocast wraps the synth call, audio conversion handles clipping/stereo/list-input. It's now wired into `npm run test:all` (skips with a banner on an unbootstrapped venv).
- **Playwright (e2e)** — `e2e/` runs browser-level golden paths against Vite in mock mode, chromium for the pre-push gate, with opt-in phone (Pixel 7) and tablet (iPad Pro 11) projects and a separate visual-snapshot battery. An axe-core accessibility pass covers the core views.
- **Husky pre-commit** runs `npm run verify:fast` (hook tests + frontend + server). **Pre-push** runs `npm run verify` (typecheck + lint + all tests + e2e + production build), cache-aware so each step skips when its input hash matches the last green run. CI mirrors this with a path-filtered job that runs only the legs a PR's diff touches (and skips entirely for doc-only PRs); cross-OS verify lives in its own workflow (manual dispatch plus a weekly cron), and the release cut itself blocks on a green macOS + Windows + mobile-e2e run before the version tag is created. I don't use `--no-verify`; the gate is the contract.

### Non-negotiables

- **Local for synthesis.** Audio rendering does not depend on cloud inference. Frontier-model use is bounded to the analysis pass — and even there, local is the default.
- **Open formats throughout.** EPUB and PDF in. Markdown intermediate. M4B and MP3 out. Voice profiles in a documented schema.
- **Privacy by default.** Books, profiles, and renders all stay on the user's machine unless explicitly exported.
- **Mid-market hardware target.** Production target is an 8 GB consumer GPU. The default Kokoro engine is light enough to sit resident alongside the analyzer; a heavy TTS engine (XTTS, Qwen voice design) evicts the analyzer and back, arbitrated by the VRAM semaphore. If it requires datacentre GPUs to be useful, the project has missed its point.
- **No proprietary player.** The magic is in the conversion, not the playback; the audiobook drops into the app the listener already uses.
- **OpenAPI is the contract, not the documentation.** Types come from the generated file; hand-written shapes are a regression.

### Open questions and known risks

- **Voice-engine selection.** Kokoro v1 is the running default, with XTTS v2 and Qwen3-TTS as alternates; F5-TTS and OpenVoice v2 haven't been evaluated head-to-head on this manuscript. Quality, licensing for derivative voices, and prosody control are the three competing axes — and per-character engine mixing now multiplies the combinations to judge.
- **Multi-language, second half.** The engine and per-engine voice plumbing are in (Qwen3-TTS); the language-detection-and-filtering half is not — auto-detecting a non-English manuscript, filtering the voice library by language, auto-loading the right engine, and the hard invariant that a cast never crosses languages. This is the next major piece.
- **Cast diversity at scale.** Qwen designs a unique voice per character, so a large cast no longer shares a small catalogue — differentiation is handled by construction. What's left is a taste judgement I can't make from inside the application: whether twenty bespoke voices are perceptually distinct enough to read as twenty people across a long book.
- **qwen3.5:4b malformed-JSON rate.** Acceptable today after the schema-format + divergent-retry + quote-escape-repair pass, but not measured cleanly. A parked experiment swaps to qwen3.5:9b once the KV-cache math says it fits resident in 8 GB at 16K.
- **Drift detection thresholds** — the metric set and the severity cutoffs need calibration against a labelled set of drifted-vs-not chapter audio. Currently placeholder.
- **Speaker attribution accuracy** — long-tail dialogue (no "she said" tag) is the hard case. The drag-handle reattribution UI is the user-correctable fallback; the open question is what fraction of cases reach the user.
- **Performance ceiling.** XTTS is kernel-launch-bound on this GPU at 19–38% utilisation; the Qwen engine is slower still — batching (length-bucketed whole-chapter forward passes) pulls it to about RTF 2 on a 4070, down from a serial rate several times worse, but it stays dispatch-bound below that and the obvious lever — a static-cache / CUDA-graphs fork of the Qwen talker — is blocked upstream by `_supports_static_cache=False`. Live RTF telemetry also exposed that a parked GPU clock, not the code, is the real throughput risk on a fresh box (RTF ballooned to ~5 when the SM clock parked at ~400–525 MHz instead of ~3100) — a configuration concern (high-performance power plan + "prefer max performance" for the Python process), not an engineering one.
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

**Maintenance cadence:** I refresh this document every couple of days, or whenever a single change has shifted the _story_ of where the project is — not every feature, but every plot point. The dated header at the top is the contract. If a reader can't tell from the first paragraph that they're seeing recent state, the doc has failed.

This refresh runs as a delta against the v1.4.0 baseline: the previous note's listen-surface, voice, and cross-tab work is folded into the established description above, and the "Where it stands now" delta carries the v1.5.0 plot points — the persisted cross-book generation queue, the third voice engine that _designs_ a voice instead of picking one, two-model analysis, live render-speed telemetry, the rebaseline-the-series cast flow, the unified Status pill, and the build-version footer. Subsequent refreshes follow the same shape: absorb the last delta into the baseline, write the next.
