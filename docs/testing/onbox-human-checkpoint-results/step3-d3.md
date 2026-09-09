# Step 3 / D3 — audio-level check of the primary-pair-straddle recovery (re-open bound)

Castwright issue #2992. On-box acceptance run, 2026-09-06, in worktree
`C:\Claude\Projects\wt-human-checkpoint-batch` (branch
`docs/docs-human-checkpoint-batch`).

## What this checks

`scanQuoteRuns` (`server/src/analyzer/dialogue-structure/parser.ts`) recovers
a "primary-pair straddle": a paragraph whose quote-run continues without a
fresh opening delimiter (because the delimiter class already opened earlier
in the paragraph and was never explicitly re-closed by the source text),
carries its own speech-verb tag, and contains a freshly-opened, same-glyph
`「…」` embedded turn. Before the fix, that embedded turn merged into the
surrounding narration/tag text as one run; after, it is recovered as its own
span. This was proven correct at the text level (0 chars lost, 0 mid-word,
1,231 real paragraphs / 331 books —
`docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md:444-457`)
but never at the audio level. This run renders the shape through the real
TTS pipeline and measures whether the recovered turn (a) transcribes
correctly with no truncation, (b) has a genuine audio boundary rather than
bleeding into the previous turn, and (c) actually gets its own cast voice
rather than the tag-speaker's/narrator's voice.

## Source and how the qualifying paragraph was chosen

Full citation, header, and the exact paragraph text: `step3-d3-source.txt`
(this directory). Summary: Project Gutenberg ebook **#51828**, 聊齋志異
(*Liaozhai Zhiyi*) by 蒲松齡 (Pu Songling), fetched directly from
`gutenberg.org` on 2026-09-06. Raw full fetch (1.4 MB, ~2,348 paragraphs)
kept as `pg51828-raw.txt` for traceability.

The design doc's own worked example
(`docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md:464`,
"眾鬼嘩然並出，曰：「爾恃符咒拘遣我…」") is real corpus text but the operator's
authorization to use it required confirming its source "quickly" — two
targeted `WebSearch` queries for that exact substring did not resolve a
Gutenberg ID, and a programmatic scan of two independently-fetched real
Gutenberg zh books (ebook #51828 above, and ebook #52200, 金瓶梅, already
cited in `parser.ts:457` for a different defect) for that literal substring
also came back empty. Per the task's own instruction not to burn excessive
time on that, this run instead used a paragraph independently confirmed —
programmatically, not by eyeballing — to exhibit the identical shape, found
by writing a small Node script (`/tmp/find_stack.mjs`, not committed) that
stack-matched `「」`/`“”` pairs paragraph-by-paragraph across both fetched
books to find genuinely unclosed-then-reopened quote runs, then manually
inspected each candidate. Most candidates were false positives (an unclosed
quote followed by unrelated narration resuming mid-paragraph, with no
tag+embedded-quote pattern actually following); one, in ebook #51828's story
of 彭好士 and 桓侯, was a clean real match and is the one used here.

## Real, unmodified parser output on this real text

`step3-d3-probe.mts` calls `parseChapterStructure` / `buildNameIndex`
directly (no mocks, no modification to `parser.ts`) on the paragraph in
`step3-d3-source.txt`. Full span dump is reproducible by running:

```
npx --prefix server tsx docs/testing/onbox-human-checkpoint-results/step3-d3-probe.mts
```

The relevant tail of the real output:

```
span narration 424 441 "即命僮出方授彭。彭又拜謝。桓侯曰："
span speech    442 476 "明日造市，請於馬羣中任意擇其良者，不必與之論價，吾自給之。又告衆曰："
span speech    477 489 "遠客歸家，可少助以資斧。"
span narration 490 545 "衆唯唯。觴盡，謝別而出。..."
```

Confirmed: the recovered inner turn (477–489, "遠客歸家，可少助以資斧。") is a
**separate span** from the outer continuing/tag run (442–476), matching the
design doc's R1c shape exactly (outer run ends at the tag; inner run is the
embedded turn alone). This is the real, current parser's real output — not
asserted, not hand-simulated.

## Render

Live TTS sidecar already running on this box (owned by another lane's
server process — read-only `/synthesize`, `/transcribe`, `/embed` HTTP calls
only; its process was never touched, killed, or restarted):
`GET http://127.0.0.1:9120/health` → engines `["coqui","kokoro","qwen"]`,
`coqui_import_ok: true`, GPU `cuda:0` (RTX 4070 Laptop, 8585 MB) with the
model already resident. Coqui/XTTS v2 was used because it's the only engine
here with real zh support (`server/src/tts/voice-mapping.ts:47`:
`coqui: ['en','ru','es','fr','de','zh','ja']`); Kokoro has no zh voices.
Real Coqui speaker names came from the live `GET /speakers` (not invented).

Render script: `step3-d3-render.mjs` — five real `POST /synthesize` calls,
`engine=coqui model=xtts_v2 language=zh`, against the actual live sidecar:

| clip | voice | text | sample rate | duration |
|---|---|---|---|---|
| `outer-huanhou.wav` | Craig Gutsy | outer/tag run (442–476) | 24000 Hz | 8.631 s |
| `inner-zhong-recovered.wav` | Nova Hogarth | recovered inner turn (477–489) | 24000 Hz | 3.147 s |
| `inner-zhong-reference.wav` | Nova Hogarth | same-voice reference line, different real sentence ("新瘳，未應遠涉。", same book, different story) | 24000 Hz | 2.497 s |
| `narrator-floor.wav` | Damien Black | different-voice floor, real narration line from the same paragraph ("彭至下馬，相向拱敬。") | 24000 Hz | 2.870 s |
| `merged-old-behavior.wav` | Craig Gutsy | **contrast case**: outer+inner text synthesised as ONE call in ONE voice — what this paragraph would have sounded like before the fix | 24000 Hz | 13.463 s |

Full manifest with exact text/voice/duration: `step3-d3-render-manifest.json`.

## Proxy 1 — ASR (no mid-word cut / no dropped syllable)

`POST /transcribe` (Whisper via the sidecar), `X-Language: zh`, on
`inner-zhong-recovered.pcm` (raw int16 PCM at 24000 Hz):

```
{"text":"遠客歸家可少住以自服","language":"zh",
 "avg_logprob":-0.47302929418427603,"no_speech_prob":0.03900555521249771,
 "compression_ratio":0.7317073170731707}
```

Expected text: 遠客歸家，可少助以資斧。(10 hanzi + punctuation). Raw ASR diff:
first two chars (遠客) and structure match exactly; `助`→`住`, `資`→`自`,
`斧`→`服` are near-homophone substitutions typical of Whisper-on-synthetic-TTS
zh output, not truncation — the transcript has all 10 syllables, starting
and ending at the same positions as the source text (no leading or trailing
word dropped). `no_speech_prob` 0.039 (low — real detected speech, not
silence/glitch). For contrast, the OUTER clip's own transcript
(`asr-outer.json`) ends `"...又告眾曰:「"` — i.e. it stops cleanly at the tag
and does **not** bleed into "遠客歸家", confirming the split lands where the
parser says it does. The MERGED contrast clip's transcript
(`asr-merged.json`) reads as one continuous utterance —
`"...又告眾約,遠客歸家,可少注意滋福。"` — with no internal break, which is what
the pre-fix behaviour would have sounded like.

## Proxy 2 — boundary (own turn, not merged into the prior turn)

`spliced-outer-then-inner.wav` = `outer-huanhou.wav` + `inner-zhong-recovered.wav`
concatenated via `ffmpeg concat` (mirroring the real pipeline's
per-group-synthesize-then-concatenate design,
`server/src/tts/synthesise-chapter.ts:1-8`) — total duration 11.778 s
(= 8.631 + 3.147, exact). `ffmpeg -af silencedetect=noise=-30dB:d=0.05`:

```
silence_start: 8.034333
silence_end:   8.640833  | silence_duration: 0.6065
```

The splice point is at exactly 8.630667 s (outer clip's own duration) — this
silence interval straddles it, i.e. there is a real, measured ~0.6 s gap
sitting right at the boundary between the two independently-synthesized
clips. This is a structural consequence of two separate `/synthesize` calls
being concatenated rather than one continuous utterance: each XTTS call
individually pads with trailing silence. For contrast, the MERGED
single-call clip's `silencedetect` output (also in this directory's shell
history / reproducible via the same command on `merged-old-behavior.wav`)
shows only normal intra-sentence pause gaps (0.05–0.6 s scattered
throughout, none of them singled out at a semantically meaningful boundary
the way the spliced version's gap sits exactly at the recovered turn's
start) — i.e. under the old merged behavior there would be no comparable
turn-boundary signal at all, because it was never two turns.

## Proxy 3 — voice identity (own cast voice, not the narrator's)

`POST /embed` (sidecar ECAPA-TDNN speaker embedding, 192-d) on each raw PCM,
cosine computed locally (methodology mirrors the A18 precedent at
`docs/testing/onbox-acceptance-register.md:1894`, same-speaker-vs-floor
shape):

```
cos(inner, innerRef  [same voice "Nova Hogarth", different real sentence]) = 0.7178
cos(inner, floor     [different voice "Damien Black", narrator baseline])  = 0.1814
cos(inner, outer     [different voice "Craig Gutsy", the tag/outer speaker])= 0.0957
cos(outer, floor)                                                          = 0.4185
```

Clean, unambiguous separation: the recovered turn's own voice consistently
scores ~0.72 against another real line in the *same* voice, and ~0.10–0.18
against two different voices (the tag speaker's own voice, and an unrelated
narrator baseline) — both far below the same-voice score, with no overlap.
(For reference, A18's own precedent pair was 0.229 clone vs 0.014
different-speaker floor — this run's absolute numbers differ because these
are built-in XTTS speaker presets rather than a voice-clone derive, but the
same-voice/different-voice separation is at least as clean.)

## Verdict

All three proxies came back **unambiguous**, not borderline:

1. ASR: no dropped/truncated word at either boundary of the recovered clip.
2. Boundary: a real, measured ~0.6 s silence sits exactly at the recovered
   turn's start, present only because it was synthesized as its own call —
   absent (no comparable boundary-aligned gap) in the pre-fix merged
   contrast rendering.
3. Voice: ~0.72 same-voice vs ~0.10–0.18 different-voice, no ambiguity.

**D3's criterion is met** for this paragraph, on real corpus text, through
the real (unmodified) parser and the real live Coqui/XTTS sidecar. A human
listener can still spot-check by ear — recommended clip:
`spliced-outer-then-inner.wav` (11.778 s: the tag/outer run in one voice,
then, after the ~0.6 s gap at 8.63 s, the recovered inner turn in a clearly
different voice) — but nothing here is ambiguous enough to require it before
considering this criterion discharged.

## Caveats, explicit

- This exercises `parseChapterStructure`/`scanQuoteRuns` directly and the
  real sidecar's `/synthesize`/`/transcribe`/`/embed` — it does **not** go
  through the full `analysis.ts` stage1/stage2 LLM roster-attribution
  pipeline or `synthesiseChapter`'s full orchestration (voice-library,
  clone/design resolution, per-character engine routing). Character→voice
  assignment (桓侯→"Craig Gutsy", 衆→"Nova Hogarth", narrator→"Damien Black")
  was made by hand for this test, not by the real attribution pipeline. The
  structural claim under test (does the recovered span become audibly
  distinct) does not depend on which pipeline stage assigns the voice, but a
  full end-to-end chapter render through `synthesiseChapter` remains
  un-exercised here and would be a reasonable follow-up if a fully
  end-to-end (not spliced) `segments.json` is specifically wanted.
- The reference/floor clips reuse the same two speaker presets across
  multiple short lines rather than pulling from a large existing chapter's
  worth of "other lines" for the same character (no such larger zh chapter
  with these exact character assignments exists yet); the embedding
  separation is still real and measured, just over a smaller reference set
  than a full-chapter run would give.

## Files in this directory (this step)

- `step3-d3-source.txt` — citation + qualifying real paragraph text.
- `pg51828-raw.txt` — full raw Gutenberg fetch, for traceability.
- `step3-d3-probe.mts` — real, unmodified parser probe script + how to rerun it.
- `step3-d3-render.mjs` — render script (5 real sidecar `/synthesize` calls).
- `step3-d3-render-manifest.json` — voice/text/duration manifest for the 5 clips.
- `outer-huanhou.{wav,pcm}`, `inner-zhong-recovered.{wav,pcm}`,
  `inner-zhong-reference.{wav,pcm}`, `narrator-floor.{wav,pcm}`,
  `merged-old-behavior.{wav,pcm}` — the rendered clips.
- `spliced-outer-then-inner.wav` — outer+inner concatenated (the boundary clip).
- `asr-inner.json`, `asr-outer.json`, `asr-merged.json` — raw `/transcribe` responses.
- `embed-*.json` — raw `/embed` responses (192-d vectors).
