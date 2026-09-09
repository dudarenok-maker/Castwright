# Step 3 — A26 (Coqui catastrophic-WER override) + A32 (EPUB named-entity decode)

Issue: Castwright#2982 (chain #2960 → #2435). Worktree
`C:\Claude\Projects\wt-mechanical-batch-2`, branch `docs/docs-mechanical-batch-2`.
Real hardware throughout — no scripted-fake fixtures for the ASR/WER path, real
Coqui/XTTS + real Whisper for A26; a real (constructed) EPUB through the real
import pipeline for A32.

## Setup

`server/.env` gained (left in place; harmless defaults for the next run on this
worktree):

```
SEG_ASR_ENABLED=1
ASR_DEVICE=cuda
COQUI_DEVICE=cuda
PRELOAD_COQUI=0
```

Sidecar and dev server were (re)started fresh this run — GPU 0 (RTX 4070
Laptop, 8 GB) was idle at the start (`nvidia-smi` 0 MiB used), GPU 1 (RTX 5070
Ti) had ~4.8 GB in use by an unrelated process; both left untouched, all work
pinned to GPU 0 via `COQUI_DEVICE=cuda`/`ASR_DEVICE=cuda`. One of this
worktree's own stale sidecar processes (started by an earlier session, bound
to this worktree's own venv/port 9170 but not reflected in `.run/tts.owner.*`)
was killed and relaunched cleanly, per the same-worktree-own-process
convention documented elsewhere in this results file's own earlier runs — no
other lane's process was touched.

## Row A26 — Catastrophic-WER override on a real Coqui language-collapse (#2055, source #2026)

**Method:** drove the sidecar's raw `/synthesize` (`engine:"coqui"`,
`model:"xtts_v2"`, `voice:"Damien Black"`, `language:"ru"`) and `/transcribe`
endpoints directly (bypassing the app's book/cast/render pipeline, same
sidestep-the-confound technique this results file's step-2 runs already used
for Qwen/Kokoro), then fed the REAL ASR transcript + REAL signals into the
REAL production `classifyTranscript()` (`server/src/tts/segment-asr-qa.ts`,
imported directly via `npx tsx`, not a mock) — throwaway probe scripts
`scripts/qa-2982-a26-probe.mts` / `-probe2.mts`, deleted after this run, not
part of the test suite.

**#2026's own two historical collapse lines**, repeated (10 attempts total
across two probe runs — the first was cut short by a sidecar crash, see
below):

| Line | Attempts | ASR transcripts observed | Verdicts |
|---|---|---|---|
| `Хорошее олово.` | 2 (of 6 planned) | `Хорошие Олава!` (×2, identical) | `drift`, `drift` |
| `Тёплое море.` | 4 (of 6 planned in probe 1, resumed as 4 in probe 2) | `теплая моря.`, `теплея моря.`, `Чоплеем море.`, `Тёплея моря.` | `drift`, `drift`, `inconclusive`, `drift` |

**Result: collapse NOT reproduced this session** — every mistranscription
stayed inside Russian (wrong word-forms/endings, not a language swap to
Finnish/English the way #2026's original two collapses did). Per the row's
own text this is an accepted, non-failing outcome ("intermittent... #2026
needed 6 repeated runs to hit it once... record that plainly as 'not
reproduced this session'"). 10 attempts is the same order of magnitude as
#2026's own 6-run hit rate, not evidence the defect is gone.

**What WAS observed, and the caveat that matters:** every one of the 3
genuine same-language mismatches above correctly produced `verdict: "drift"`
with a plain WER-threshold reason (`"Content drift — word-error-rate 1.00
exceeds 0.4"`), through the real production classifier, on real hardware —
confirming the WER-drift mechanism itself works end to end. **None of these
reasons mention "catastrophically wrong"**, i.e. none specifically exercised
the *new* #2055 override path (which converts what would otherwise be an
`untrustworthy → inconclusive` verdict into `drift` when the transcript is
fluent/confident despite gross mismatch). In every attempt captured here
Whisper's own confidence signals (`avg_logprob`, `no_speech_prob`) never
crossed the "untrustworthy" thresholds, so the plain pre-existing
`wer > maxWer` branch fired instead of the override branch — the override's
own discriminating logic was not exercised, only its neighbour. One attempt
(`Чоплеем море.`, WER 0.5 on a 2-word reference) fell under the
short-reference "weak evidence" guard and returned `inconclusive`, correctly.

**False-positive control:** `Мастер Одуван кивнул.` (an invented-name line,
2 attempts) — **both fired `drift`** (WER 1.67 and 0.67), not clean. Whisper
mistranscribed the invented name `Одуван` outright both times
(`"аду ванки в нул пентаде"`, `"Адуван Кивнул, Бантевнул"`). This is a real
observation, not a mock artifact, but it is **not evidence of a #2055
regression** — no pre-#2055 baseline was run in this session to diff against,
and a 2-3 word reference is inherently fragile under WER scoring (one
substitution is 33-100% of the line). Flagging as owed: a longer-context or
larger-sample false-positive pass is needed to actually answer "no new
re-record rate vs. baseline"; this session's 2 short-line attempts don't
settle it either way.

**Incident — sidecar crash mid-pass (probe 1):** after the second successful
`Хорошее олово.` attempt, every subsequent call failed with `fetch failed`.
Sidecar log showed a second sidecar process (spawned by the dev server's own
`spawn-sidecar.ts` supervisor, which had adopted this worktree's
already-running sidecar and respawned its own child when the adopted one
"disappeared") losing a bind race on port 9170
(`[Errno 10048] ... only one usage of each socket address ...`), then its own
supervisor giving up (`sidecar exited with code 3 - not restarting`). At the
same moment `nvidia-smi` dropped to 0 MiB used on both cards (full VRAM
release) and the box was running 16-18 node.exe + 6 python.exe processes.
**Same signature already flagged `AGENT BLOCKED` on #2906** (silent
node/python process death under box-wide contention, 2026-09-06/07/08/09) —
not chased further as a code bug here; worked around by not re-introducing a
second manually-launched sidecar process and instead restarting only the dev
server, letting it manage/adopt the one sidecar. Probe 2, run against the
now-single-sidecar setup, completed cleanly end to end (6 attempts, zero
transport errors).

## Row A32 — Named-entity decode reaches the TTS engine on a real EPUB (#2310)

**Method:** hand-built a minimal, valid, throwaway EPUB (`mimetype` +
`META-INF/container.xml` + OPF/NCX/two XHTML chapters, structurally identical
to `server/src/parsers/__fixtures__/sample.epub`) with named HTML entities in
exactly the places the row asks for, and imported it through the real
`POST /api/import` multipart endpoint (not a unit test fixing the string).
**Explicitly a hand-substituted construction**, stated per the issue's own
"say plainly if you did this" instruction — no suitable real-world EPUB with
named entities was available on this box this session.

Chapter 1 heading: `<h1>L&rsquo;&Eacute;t&eacute;</h1>`. Body:
`<p>&mdash;Ne partez pas, dit-elle.</p>` and
`<p>Il r&eacute;pondit avec un sourire &eacute;trange et l&rsquo;air
fatigu&eacute;.</p>`. Chapter 2: `&ccedil;` in `grin&ccedil;a`.

**Lead criterion — chapter-title beat, text level:** the import API's parsed
`candidate.chapters[0].title` came back as **`"Chapter One — L'Été"`** —
clean real apostrophe + accented É/é, no entity markup, no mangling. This is
the "no model behaviour can mask this" check the row calls out as primary,
and it passed on the real import → `stripHtml`/`extractFirstHeading`/`epub.ts`
pipeline, not a unit test.

**Body text, same import response, `candidate.sourceText`:**
```
—Ne partez pas, dit-elle.

  Il répondit avec un sourire étrange et l'air fatigué.

La porte grinça dans le silence.
```
Real em dash, real é/è-accented words, real ç — every named entity in the
fixture decoded correctly through the same pipeline.

**Lead criterion — chapter-title beat, audio level:** synthesized the decoded
title text `"L'Été."` twice on real hardware:
- Kokoro (`af_bella`, English voice — wrong-language engine, sanity check
  only): ASR transcript `"LAT."` — mispronounced as English (expected; Kokoro
  has no French model), but **not** spelled out as literal entity markup
  (`"ampersand r s quo semicolon..."`), which is the failure mode this row
  guards against.
- **Coqui/XTTS (`Damien Black`, `language:"fr"` — the right-language engine):**
  ASR transcript **`"L'été, bah il est en train de m'aider."`** — the decisive
  result. The first two words are a clean, correct rendering of `L'été`
  (French "the summer"); everything after the comma is a separate Whisper
  hallucination artifact on a very short utterance (a known ASR behaviour,
  not a TTS or decode defect — the synthesized clip is ~4.3s of audio for a
  2-word phrase, consistent with XTTS padding a very short utterance, and
  Whisper filling the silence with invented continuation). **The entity
  survived decode → TTS → ASR as real, correctly-pronounced French — no
  "ampersand/semicolon" artifact, no dropped diacritics.**

**Secondary (dash-opened dialogue / accented body line):** not run through
TTS this session (time/hardware budget went to the two decisive title-beat
checks above); the body-line *text*-level decode is already confirmed correct
via the `sourceText` dump above (real em dash, real accents survived the same
pipeline as the title). Audio-level confirmation of the dash-pause timing
specifically is not attempted here — out of scope for what this run could
responsibly fit after the A26 sidecar incident.

**Pre-fix reproduction check (design spec's "was this itself new information"
question):** not attempted — would need a scratch clone at the pre-#2310
commit; not run this session for the same time-budget reason as the secondary
body-line check above.

## Cleanup

Throwaway book `throwaway-qa__standalones__coalfall-a26a32-throwaway` and its
`castwright-workspace/` files are this worktree's own workspace, never the
operator's real book/library — left in place (harmless, matches this
worktree's existing throwaway-data convention). Probe scripts
`scripts/qa-2982-a26-probe.mts` / `-probe2.mts` were scratch, not committed.
No source edits made — this document is the only change (plus the
`server/.env` knob additions above, which are local dev config, not tracked
outside `.env.example`... actually `server/.env` IS git-ignored for this
worktree per its own header; confirmed via `git status` showing no `.env`
diff). `git status --porcelain` clean except this new file.

## Run by

claude, 2026-09-09 (scheduler heartbeat, issue #2982).
