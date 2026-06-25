# Expressive-prose A/B fixture (#1098)

A Castwright-original micro-scene for the **Phase-2 live-instruct delivery A/B**
(issue #1098). The structured data the renderer consumes is
[`expressive_passage.json`](./expressive_passage.json); this file is the
human-readable prose + how to use it.

## Why a passage, not a sentence

The A/B compares *delivery strategies* on the 1.7B live-instruct path. Rendering
the **same** sentence at different temperatures hides exactly what matters —
emotional **flow**, transitions between beats, and how a real **mixed batch**
behaves. So the fixture is one continuous scene whose consecutive sentences move
through all five emotions (whisper → neutral → excited → neutral → angry →
neutral → sad → whisper → neutral). Render it as a single batch and listen
end-to-end.

## The scene

> "Stay close," she breathed, barely louder than the dark itself. "The floor
> here remembers every footstep."
>
> The corridor narrowed until the lantern light touched both walls at once. They
> had been walking the better part of an hour, and the air grew colder with
> every turn.
>
> "There — do you see it? It is the seal, the real one, exactly where the letter
> said it would be!"
>
> The bronze disc lay half-buried in the dust, its edges still catching the
> light.
>
> "You knew," he said, and his voice dropped to something hard. "You knew it was
> here the whole time and you let us crawl through that filth for nothing!"
>
> For a moment neither of them moved.
>
> "I did not tell you," she said softly, "because I knew what it would cost. He
> never came back from the last one either."
>
> The lantern guttered, and the shadows leaned in around them.
>
> "We finish this," she whispered, "and then we go home."
>
> Somewhere far above, the old house settled, and went still.

## How to run the A/B (Phase 2, on the box)

1. Set `"voice"` in the JSON to a **designed 1.7B** voice id present in the
   workspace.
2. Render the 15 `sentences` as one `synthesize_batch(model="1.7b",
   live_instruct=True, …)` call three ways, saving each to its own WAV:
   - **(a) baseline** — strip `instruct` (let the pipeline derive from
     `emotion`), fixed `QWEN_INSTRUCT_TEMP`.
   - **(b) per-emotion temp** — plain/derived instruct, per-emotion temperature
     (the not-yet-built #1098 partitioned batcher; placeholder temps in the
     JSON's `ab_options`).
   - **(c) rich instruct** — use the per-sentence `instruct` text below at the
     fixed temp (no partitioning, one batch).
3. Listen to all three end-to-end. **Decision rule:** build (b)'s mechanism only
   if it clearly beats (c) on prosody *without* losing (c)'s single-batch
   flow/speed; otherwise close #1098 in favour of (c).

The per-sentence `emotion` + rich `instruct` directions live in the JSON.
