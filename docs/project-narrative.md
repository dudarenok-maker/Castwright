# Castwright

**Many voices, one machine.**

_A project narrative — named 7 June, updated 8 June 2026_

**Estimated read time:** 6 minutes for the narrative; 7 more for the functional and technical sections below.
**What this is:** The story behind **Castwright** — _any book, performed by a full cast; effortlessly, even in your own voice._ Why fiction listening is broken, what fixes it, and where the product stands today. A functional section and a technical section sit below the narrative for design and engineering conversations. I refresh this every couple of days, so the dates and the state are honest at the top.

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

This past year the gap started to close — from the other side, and it's worth being honest about. Full-cast AI narration exists now: author-side studios sell it by the word in the cloud, and a handful of open-source projects do it locally for anyone comfortable with a Python install. The wave proves the appetite. But every one of them either sells to the rights-holder rather than the reader, meters the render through someone else's server, or forgets the cast the moment the book ends. Nobody builds the performance for the _reader_ — for the book you already own, on the machine already under your desk, with a cast that's still the same people in book five.

The reason it hasn't reached readers isn't that the technology is missing. It's that the conventional path costs too much. Render every audiobook in the cloud, with frontier-model orchestration on every chapter, and you've priced out anyone who isn't a streaming service. The interesting question isn't _can it be done_ — it's _can it be done on a machine someone already owns_.

That's the bet I'm taking.

## What Castwright is

A _cast-wright_ is the one who builds the cast — and that is the whole job. The shape of it is simple to describe.

You drop in a book. EPUB, PDF, MOBI, plain text, paste. Castwright reads it, identifies the twenty or thirty main characters, and builds a voice profile for each — age, gender, accent if the text implies one, personality, the vocal qualities the writer keeps gesturing at. The narrator gets a profile too. Those profiles are unique to _this book_ and they travel with it.

Then, chapter by chapter, the system renders the audio. Every line of dialogue lands in the right voice. Every paragraph of narration is delivered by the narrator the book has earned. Tone is read from the surrounding prose — fear sounds like fear, dry humour lands dry. When the apprentice speaks, you hear a thirteen-year-old. When the swordsmith answers, you hear seventy years and a forge. And it isn't English-only — Castwright performs in **English and Russian today, with more languages to come**, and it never lets a cast cross languages within a book.

Voices are reusable across books in a series. The narrator who carried Book 1 keeps carrying Book 2. A recurring character keeps their voice from one book to the next — and if the writer renamed them, the cast merge writes the old name into the new one's aliases, so the matcher in Book N+1 still recognises them. Your library learns who you've cast and offers them back, with provenance, every time you start a new manuscript.

When it's done, you listen however you like. Castwright has its own companion app — **Android today, iOS as we get moving** — that pairs with your library over the network, downloads books for offline listening, and remembers exactly where you left off. Or drop the chapters straight into the audiobook app you already use; nothing locks you in. Either way, the magic isn't in the playback — it's in the conversion.

And it runs on the machine you own. The analysis pass runs locally by default, with a free-tier cloud fallback if the local model isn't reachable. Audio synthesis runs locally on a voice engine that fits on a mid-market GPU. Per book, not per listen. The frontier never sees a chapter.

## The bet

The reason nobody had built this isn't that the technology was missing. It's the economics. Render every audiobook in the cloud, with a frontier model orchestrating every chapter, and you've priced it for streaming services, not for readers. So the cast never gets built, and fiction keeps getting read by one tired voice.

Castwright takes the other path. The expensive part — finding the cast, designing the voices, rendering the performance — happens on a machine you already own. Per book, not per listen. The frontier never sees a chapter. That single choice is what turns a full-cast audiobook from a streaming-budget luxury into something anyone with a mid-market GPU can make at home, for the price of the electricity.

It's a bet on the edge: that the most interesting things AI will do over the next few years are the ones the cloud is too expensive to do — run instead on local hardware, privately, one render at a time. A book is exactly that kind of problem. It's personal, it happens once, and it has no business phoning home. Castwright is what that bet looks like pointed at the thing readers actually want — their stories, performed, in voices they'll remember the next morning.

## Where it stands now

The first time I wrote this note, I called it _planning, paper, and a couple of small spikes_. That description is two months out of date in the way _small spike_ turns into _the thing that runs the house_ if you keep going.

The honest summary, as of v1.6.0 and the fortnight since: the engine runs end-to-end on the machine it's supposed to run on, against the book it's supposed to run on; **the install goes straight into someone else's hands and upgrades itself in place**; there's a companion app to listen on; the performance is expressive and gated for quality; and the rough edges that only show up on real, multi-book series are getting filed down one at a time. Everything beyond that is calibration.

What "runs" actually covers, in nine plot points.

### The engine runs end-to-end

Six iterations ago this was a hand-drawn mock. Today it's a real React application wired to a real server, persisting one directory per book on disk, mocking-or-real behind a single switch so the UI doesn't know which side it's talking to.

A type system built from the API contract means the character, chapter, sentence and voice shapes are _generated_, not hand-written. A discriminated-union stage machine makes it impossible to land on a _ready_ screen with no book selected. Design tokens live in CSS custom properties, so the cream-and-peach palette can never drift into hex literals in component code.

Behind it: a five-harness test gate that runs on every push, and a release flow that blocks the version tag on a green run across Windows, macOS, Linux and mobile e2e. Sounds like overkill on a solo project — until you remember the analysis pipeline has enough moving parts to silently regress something every other commit. The gate is for future-me reading a six-week-old failure mode.

The cost of that foundation was real. It is also the reason the rest of what follows could happen at all.

### Analysis became a phased pipeline

The obvious thing was to hand the whole book to the LLM and ask for the cast.

That worked on toy manuscripts and silently fell over on real ones — malformed JSON, hallucinated speakers, daemon hangs. Long chapters wedged the model. A single failed chapter torched a whole run. Retries piled up and crashed the queue.

So the pipeline rebuilt itself in phases. _Phase 0a_ walks the headings to find chapter boundaries with an observed-rate ETA, so the time-remaining is measured rather than aspirational. _Phase 0b_ detects cast per chapter, persisting incrementally so a crash mid-run loses nothing; one chapter's failure is just that chapter's failure now. _Phase 1_ verifies every claimed evidence quote against the source text with a three-tier match and drops what fails into an append-only audit ledger. The pipeline blocks advancement while any chapter is still failing — because a partial cast produces silently-wrong voice matches downstream.

Then a second model joined. An aggressive model races ahead on detection while a careful model trails behind on verification, gated by a warm-up lag so attribution anchors to the first model before the second arrives. The analysing view shows both model chips and lets you swap either mid-run.

That paragraph is the thing I wish I'd known to build first.

### A third engine that designs a voice instead of picking one

Kokoro reads from a fixed catalogue. XTTS clones from a sample. Both work — but neither handles a twenty-plus-character book without collapsing onto a handful of voices.

The new Qwen3-TTS engine takes a character's persona — the age, the accent, the vocal qualities the analysis already pulled from the text — and _designs_ a bespoke voice for them. The voice is cached and reused for consistency across the book and the series.

Engine choice is per character now. A narrator on Kokoro; a principal on a designed Qwen voice; a supporting cast on a cloned sample — all in the same book, all rendered in parallel. The assignment travels with the character, so switching the engine doesn't lose the cast.

The performance trade-off is real. The catalogue and clone engines render faster than they play. The designed-voice path takes roughly twice the audio's run-time — slower than playback, several times faster than the serial version that came before. Pulling that further down is the open performance problem; the gain it earns in voice differentiation is the reason it ships now.

### Generation became a queue, not a stream

The old model ran one book's generation as a live stream tied to that book's view.

The moment you wanted a second book churning, or the work to survive a tab reload, the abstraction creaked. Close the tab and the stream died. Click into Book B and Book A's progress lost its anchor.

So generation got rebuilt around a persisted, workspace-wide queue. Every enqueued chapter sits in one shared queue, drained by a configurable pool of workers, surviving reloads, spanning books. A global queue modal — reachable from any view — lets you see and drag-reorder everything in flight regardless of which book's view you're standing in.

This is the change that turned _analyse Book A while Book B generates and I edit Book C_ from an aspiration into a real workflow.

### Casting a series, not just a book

A series reader wants Book 2's cast to sound like Book 1's. That is the whole reason cross-book voice continuity matters.

The canonical regression I lean on is _Keeper of the Lost Cities_ — a multi-book run with a large recurring cast that has to keep its voices consistent from one volume to the next. The cross-book failure modes are the interesting ones: a character introduced under one name and later revealed under another, a voice that has to stay the same person across books, descriptors that drift between volumes.

The matcher scores name plus alias plus token overlap on the descriptors. Returning characters get offered back with a _From [Book]_ provenance pill before you've clicked. Manual cast merge writes the source character's name into the target's aliases, so the same character lands on the same voice the next time around. And a _Rebaseline the series_ flow designs bespoke voices for the principal cast across every book at once, with a current-vs-proposed audition before anything regenerates.

Cross-book continuity is now a workflow, not an aspiration.

### The performance got expressive

Designing a distinct voice per character solved _who_ is speaking. The next question was _how_ — a line is furious here, broken there, deadpan a page later. Castwright now reads emotion per quote and renders the line in a matching expressive variant, with a detect-emotions pass that backfills tone across a chapter and a per-quote control so you can overrule it by hand. A flat read was the easy thing to ship; an expressive one is the reason it's worth listening to.

### Quality became a gate, not a hope

The honest worry with any AI voice is the line that comes out fluent but _wrong_ — a dropped clause, a hallucinated word, a clip of dead air — and you only catch it three chapters later. So generation grew a gate. Before a chapter is assembled, every sentence is checked acoustically — dead air, silence runs, duration drift — and re-recorded automatically if it fails; an optional speech-to-text pass transcribes the render and flags lines whose words don't match the script. A committed golden-audio harness guards the render path itself against regressions. And once a chapter is rendered, a drift detector compares it against each character's established voice profile and flags the ones that have wandered — severity-tiered, with a one-click route back into regeneration, and the rendered engine stamped per character so the comparison is honest. The _taste_ judgement still needs ears; the plainly broken lines no longer reach them.

### A companion app, not just a converter

The bet was always that the magic is in the conversion, not the playback — but "sideload an M4B" is a clumsy last mile. So there's now a **Castwright companion app** — Android today, iOS as we get moving. Pair it to your library with a QR code over your home network and it syncs chapters as they render, downloads books for offline listening, and plays them in a real native player: resume across devices, lock-screen and Android-Auto / CarPlay controls, a sleep timer, per-chapter waveforms. The conversion is still the product; the app just makes the last mile feel like the rest of it. (It ships to an alpha channel as a signed build; the server pairs over LAN with per-device tokens you can revoke.)

### What's not good enough yet to put in front of someone else

With Qwen3-TTS designing a bespoke voice per character, a twenty-plus-character book no longer collapses onto a handful of catalogue voices. Every character gets its own designed voice. Differentiation is handled by construction rather than rationed from a fixed pool.

What I still can't judge from inside the application is the _taste_ layer above that: whether those designed voices are perceptually distinct and well-matched enough, across a whole cast, to carry a long listen. That needs ears, not metrics, and probably not mine alone.

Drift detection now ships and runs on every rendered chapter; what's left there is tightening its severity cutoffs against a larger labelled set. I haven't measured the analyzer's malformed-JSON rate cleanly — it's acceptable in practice after the schema-format and divergent-retry repair passes, but a parked experiment to swap to a heavier local model once the memory math says it fits hasn't run yet. F5-TTS and OpenVoice v2 haven't been evaluated head-to-head on this manuscript against the engines I'm using.

Multi-language is real now — English and Russian render end to end, with the hard rule that a cast never crosses languages. More languages are the obvious next step, along with the polish around them: auto-detecting a manuscript's language and filtering the voice library by it. It's among the most-requested directions.

That list is honest, not alarming. The engine runs. The install travels. The next round is calibration on top of a foundation that holds.

### Next: the book, in your own voice

The tagline makes a promise the engine doesn't fully keep yet — _even in your own voice._ Cloning a specific person from a short sample is the **next big release**: a parent reading a bedtime story in their own voice even when they're away; a kid hearing themselves as the hero. The pieces are within reach — XTTS already clones zero-shot from a reference clip, and Qwen can design toward a target — so the real work is the experience around them: capturing a clean sample, getting consent on the record, holding that voice consistent across a whole book and series the way designed voices already are, and keeping every byte of it on the machine it was recorded on. It's the most personal thing Castwright could do, which is exactly why it's next.

It also reshapes the voice library. A cloned voice — tied to a real, consenting person — can't sit in the same drawer as a voice _designed_ from a fictional persona. The library will split the two: cloned voices get their own section, their own provenance and consent trail, and their own reuse rules, so a family member's voice is never quietly offered back to a stranger's book the way a designed cast member's is.

## Hear it for yourself

There's only one test that matters, and it takes ten minutes.

Drop a book into Castwright, let it cast the thing, and listen. If you forget you're hearing AI — if the apprentice, the swordsmith, and the dragon land as three different people, and you reach the next chapter without reaching for the volume — then it works. If you don't, the exact moment it breaks is the most useful thing you can tell us. We'd rather hear what's confusing now than what's polished later.

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

**Companion apps.** A first-party Castwright listener — **Android today, iOS on the roadmap** — pairs with the server over your home network, syncs the library (grouped by author and series, with filters and collapsible sections), downloads books for offline playback, and tracks position, chapters, playback speed, and auto-advance between chapters. Optional, never required: the conversion is the product, and rendered audio always exports to any player.

**Listener app handoff.** Generated chapters export as M4B with chapter markers (or per-chapter MP3 as a fallback, since chapter audio is MP3 VBR V2 on disk via ffmpeg). Multi-step walkthrough modals guide the user through getting the file into the listener app of their choice — PocketBook, Voice, BookPlayer, Apple Books, Smart AudioBook Player, Audiobookshelf, Plex — with platform-accurate iOS and Android share-sheet phone-frame mockups embedded in the walkthrough.

**Unified Status pill.** The top bar's separate state indicators collapsed into a single _Status_ pill backed by a status modal, with a hover popover that reveals the detail inline without opening the modal (and keeps the cast drawer open underneath). It surfaces TTS load errors, analyzer and generation state, and pipeline readiness in one place, so the global picture stays legible across the concurrent multi-book workflow regardless of which book's view is active. Model lifecycle still lives here: the analyzer (Ollama qwen3.5:4b) and the button-driven TTS engines (Coqui XTTS v2 and Qwen3-TTS; Kokoro v1 is eager-loaded and needs no load step) load and unload explicitly, with an auto-eviction banner when loading one frees the other and an `/api/ps`-backed "currently resident" indicator; an auto-load helper warms an engine just-in-time when the user hits a sample play button on a cold pipeline.

**Responsive across phone, tablet, and desktop.** Every view holds its shape at three breakpoints: single-column with drawers, bottom sheets, and full-screen modals on a phone; two-column with right-drawer secondary panes on a tablet; three-pane with the full top bar on desktop. The rule is touch-equivalence — every desktop drag or hover affordance ships a tap replacement (the cast voice library's drag-to-row also offers an _Assign_ pill; the manuscript boundary handle is one PointerEvent path covering mouse, touch, and pen; hover-reveal labels stay faintly visible on touch devices), and every interactive control meets a 44 px touch target. A one-time mkcert step serves the app over LAN HTTPS so a phone or tablet on the home network loads it with a lock icon and no certificate warning.

**Build-version footer.** Every view stamps the running build at the bottom of the page — `v1.5.0 (a1b2c3d)` in production, a verbose `v1.5.0 · sha · branch · time` in dev — so a deployer (or future-me) can confirm at a glance which bundle is actually running.

### The design language, in one paragraph

This is the **Castwright** brand now, not just an app theme — the mark is a ragged three-voice waveform rising off an open book (peach and magenta voices over a page), and the four-stop gradient below is its signature. Cream canvas, near-black ink, General Sans type (Inter as the free fallback), Lora for titles. The accent palette is restrained to three colours, each with a single job. **Peach** (`#F79A83`) is the action colour — drag rings, drop indicators, regen affirmations, selected segments, active filter pills. Nothing idle uses it. **Magenta** (`#A43C6C`) carries the brand and the horizontal accent gradient. **Deep purple** (`#3C194F`) is series-context — reused voices, library matches, anything that belongs to a book beyond the current one. The signature four-stop vertical gradient (`#0F0E0D` → `#3C194F` → `#A43C6C` → `#F79A83`) appears no more than three times per page — at the end-of-page CTA or album-cover hero, at the active progress bar, and at one "magic moment" (analysis, cast confirmation, or the listen page hero). Every h1 and h2 carries one bold span inside an otherwise medium-weight sentence — the bold word carries the meaning, the rest is context. Tokens live as CSS custom properties in `src/styles.css`; Tailwind references the vars. Component code never sees a hex literal.

---

## Appendix B — Technical design

_For readers who want to challenge the architecture rather than the story. Compact by design; happy to go deeper on any block in conversation. The state described here is the running application, not a future plan._

### Pipeline (end-to-end)

**1. Ingest.** Accept EPUB, PDF, MOBI, plain text, paste. EPUB chapter titles are read from the NCX, with a raw-zip fallback that recovers books whose OPF uses namespace-prefixed elements or that the primary parser rejects; a DRM-locked MOBI returns a clean 415 with an actionable message rather than an opaque 500. The original bytes are persisted verbatim so re-parse can run without a `%TEMP%` roundtrip. Markdown is the canonical intermediate; chapter structure preserved, front-matter and back-matter chapters excluded from analysis and audio at the user's discretion.

**2. Analysis.** Two engines, one contract:

- **Local Ollama** (`ANALYZER=local`, default) — qwen3.5:4b as the default model; warmed with the same `num_ctx` as the analyzer uses (16384, after silent hangs on long chapters at lower values); GPU pinned via `num_gpu: 999`; `keep_alive` is 5m for qwen3.5:4b and 0 for heavier models so VRAM frees promptly. Auto-falls back to Gemini if the daemon is unreachable.
- **Gemini direct** (`ANALYZER=gemini`) — `gemma-4-31b-it` by default (its own free-tier bucket at 1,500 requests/day; flip to `gemini-3.1-flash-lite` etc. without code changes via `GEMINI_MODEL`). Every outbound call is gated through a per-model RPM/TPM/RPD limiter so retries can't compound into 429/500 storms. Streamed responses with a live heartbeat and a silence watchdog. Free-tier friendly.

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

### Performance — observed RTFs

The wall-clock characteristics that used to live in the narrative section, gathered here as a reference for engine-selection conversations.

- **CPU XTTS v2** — 2.5–3.7× real-time. A chapter takes longer to render than to listen to. Unusable as a default but kept for the no-GPU path.
- **CUDA XTTS v2 with fp16 and DeepSpeed** — 0.65–0.95× real-time. A chapter renders faster than it plays. The GPU sits at 19–38% utilisation because XTTS is kernel-launch-bound rather than compute-bound; that's the next lever.
- **Qwen3-TTS batched** — ~RTF 2 on a 4070 (roughly twice the audio's length to render). Batching pulls this back from a serial rate several times worse via length-bucketed whole-chapter forward passes, an SDPA attention path, and a prompt cache. Sub-RTF-2 is dispatch-bound and open work; FlashAttention-2 is opt-in via `QWEN_ATTN_IMPL`.
- **A parked clock is the real risk on a fresh box.** Live RTF telemetry exposed that the slow runs were the GPU parking its SM clock at ~400–525 MHz (against ~3100) — a power-plan configuration issue rather than a code problem. High-performance power plan + "prefer max performance" on the Python process is the fix; the readout from the Generate view is the way it gets noticed.

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

- **Express + TypeScript**, served from `server/`. Routes wire the OpenAPI contract end-to-end. Two analyzer adapters, one TTS sidecar adapter, one library scanner.
- **`.env` via Node 20.6+ native `process.loadEnvFile`** — no dotenv dependency. `server/.env.example` documents the surface.
- **Persistence is per-book under `.audiobook/`** — `state.json` (slice payload), `cast.json` (live cast, persisted incrementally during analysis), `dropped-quotes.json` (append-only verifier ledger), chapter audio + voice samples. The generation queue lives one level up, workspace-wide, in `.queue.json`.
- **Log lines carry millisecond timestamps** so 6 a.m. me has a chance of debugging midnight me.

### Test discipline

Five harnesses, three-tier git gate.

- **Vitest (frontend)** — `npm run test`. Tests live next to the unit.
- **Vitest (server)** — `cd server && npm run test`. Same colocation, including real-ffmpeg integration where relevant. Five timeout-prone files split off into a one-fork `test:server-slow`.
- **Pester 5 (PowerShell scripts)** — `scripts/tests/` covers log rotation, OneDrive-lock-tolerant workspace bootstrap, and start-app preflight.
- **pytest (TTS sidecar)** — `server/tts-sidecar/tests/` covers smoke, synthesis, runtime wiring, Kokoro, Qwen3, logging format, and concurrent synthesis. The runtime-wiring suite pins the CUDA + DeepSpeed + fp16 primary path: DeepSpeed init reaches the model and runs before `tts.to(device)`, init failure is swallowed, fp16 autocast wraps the synth call, audio conversion handles clipping/stereo/list-input. It's now wired into `npm run test:all` (skips with a banner on an unbootstrapped venv).
- **Playwright (e2e)** — `e2e/` runs browser-level golden paths against Vite in mock mode, chromium for the pre-push gate, with opt-in phone (Pixel 7) and tablet (iPad Pro 11) projects and a separate visual-snapshot battery. An axe-core accessibility pass covers the core views.
- **Husky commit-msg** validates the commit subject against the `<type>(<scope>): <subject>` convention. **Pre-commit** runs `npm run verify:fast` (hook tests + frontend + server). **Pre-push** runs `npm run verify` (typecheck + lint + all tests + e2e + production build), cache-aware so each step skips when its input hash matches the last green run. CI mirrors this with a path-filtered job that runs only the legs a PR's diff touches (and skips entirely for doc-only PRs); cross-OS verify lives in its own workflow (manual dispatch plus a weekly cron), and the release cut itself blocks on a green macOS + Windows + mobile-e2e run before the version tag is created. I don't use `--no-verify`; the gate is the contract.

### Non-negotiables

- **Local for synthesis.** Audio rendering does not depend on cloud inference. Frontier-model use is bounded to the analysis pass — and even there, local is the default.
- **Open formats throughout.** EPUB and PDF in. Markdown intermediate. M4B and MP3 out. Voice profiles in a documented schema.
- **Privacy by default.** Books, profiles, and renders all stay on the user's machine unless explicitly exported.
- **Mid-market hardware target.** Production target is an 8 GB consumer GPU. The default Kokoro engine is light enough to sit resident alongside the analyzer; a heavy TTS engine (XTTS, Qwen voice design) evicts the analyzer and back, arbitrated by the VRAM semaphore. If it requires datacentre GPUs to be useful, the project has missed its point.
- **No lock-in.** Castwright ships its own companion apps (Android now, iOS next), but the magic is in the conversion, not the playback — rendered audio always exports as M4B/MP3 to whatever player the listener prefers. You're never trapped.
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

### Code statistics

For the curious — the project's size in source lines, refreshed automatically on every release (`scripts/bump-version.mjs` runs `npm run stats -- --write`).

<!-- CODE-STATS:START -->
_Generated by `npm run stats` on 2026-06-03 via [tokei](https://github.com/XAMPPRocky/tokei). "Code" excludes blank lines and comments. `node_modules`, `dist`, and other `.gitignore`d paths are not counted._

| Language | Files | Code | Comments | Blanks |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 555 | 91,766 | 26,901 | 9,971 |
| TSX | 173 | 53,714 | 8,380 | 3,532 |
| JSON | 7 | 14,230 | 0 | 0 |
| JavaScript | 55 | 7,847 | 1,712 | 891 |
| Python | 21 | 6,306 | 893 | 1,261 |
| YAML | 1 | 4,178 | 21 | 88 |
| PowerShell | 14 | 933 | 293 | 171 |
| CSS | 1 | 499 | 230 | 40 |
| HTML | 2 | 282 | 19 | 18 |
| Shell | 2 | 84 | 50 | 22 |
| Batch | 2 | 9 | 0 | 0 |
| INI | 1 | 4 | 0 | 0 |
| Markdown | 215 | 0 | 18,875 | 5,469 |
| Plain Text | 2 | 0 | 65 | 3 |
| **Total** | **1,051** | **179,852** | **57,439** | **21,466** |

- **Source code** (excl. JSON / Markdown / YAML): **161,158** lines across **823** files.
- **Production vs test:** ~81,603 lines of application code against ~79,555 lines of test code (410 test files) — roughly **0.97** lines of test per line of source.
- **Comment + blank share:** ~30% of all tracked lines are comments or blank.
<!-- CODE-STATS:END -->

---

## Sources & maintenance

- `docs/features/INDEX.md` — living regression plans for every feature. The features doc is the spec; this narrative is the story.
- `CLAUDE.md` — project context for Claude Code: commands, layout, conventions, test discipline.
- `openapi.yaml` — API contract, source of truth for backend shapes.
- `server/.env.example` — analyzer / TTS engine configuration surface.

**Maintenance cadence:** I refresh this document every couple of days, or whenever a single change has shifted the _story_ of where the project is — not every feature, but every plot point. The dated header at the top is the contract. If a reader can't tell from the first paragraph that they're looking at the current state, the doc has failed.
