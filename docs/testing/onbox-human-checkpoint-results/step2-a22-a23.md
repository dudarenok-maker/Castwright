# Step 2 — A22 + A23 real re-render + embedding-cosine evidence

Real on-box run against the actual production workspace (`C:\AudiobookWorkspace`),
not a throwaway fixture. Server (`localhost:8270`) + TTS sidecar
(`127.0.0.1:9190`, `qwen3-tts-1.7b`) + frontend (`127.0.0.1:5273`) started fresh
for this run; no other lane's process was touched. Backups of every real file
touched are at `.backups/step2-a22-a23-20260906-150626/` (both books,
pre-existing from an earlier session that parked this claim).

## A22 — Playing with Fire, `buildCastResolver` read-time fix

### 1. Re-render

- Chapter 19 (`the-torment`, 37 of 67 segments) re-rendered:
  `audioQa.status: "ok"`, `durationSec: 699.2`, `rtf: 0.72`.
- Chapter 16 (`lightning-dave` + `pool-player-2`) re-rendered:
  `audioQa.status: "ok"`, `durationSec: 884.8`, `rtf: 0.67`.
- Both `synthesizedAt: 2026-09-06T05:2x/3x:xx.xxxZ` (this session).

### 2. `characterSnapshots` entry — **does NOT exist; real gap found, not a pass**

Neither `the-torment` nor `lightning-dave` gains a `characterSnapshots` entry
in the fresh `segments.json`, in either chapter. Root cause, read from source
rather than guessed:

- `buildCharacterSnapshots` (`server/src/audio/character-snapshots.ts:48-49`)
  iterates the book's live `cast` array and keeps only `c.id` values present in
  `speakingIds`.
- `speakingIds` (`server/src/audio/finalize-chapter-write.ts:287`) is built from
  the **raw, literal** `segment.characterId` — i.e. `"the-torment"` /
  `"lightning-dave"` (hyphen), never the resolved cast id.
- The live cast ids are `"the_torment"` / `"lightning_dave"` (underscore) —
  confirmed in `.audiobook/cast.json`. `buildCastResolver` matches
  `"the-torment"` → `the_torment` at **read time**, via the
  `'normalised-id'` tier (`server/src/store/cast-resolve.ts`), but that
  resolution is never fed back into `speakingIds` before the snapshot builder
  runs, so `c.id === 'the_torment'` is never in the (hyphenated) set and the
  character is skipped.

So the **voice fix is real** (see §3/§4 below) but the specific artifact the
issue asked to confirm (`characterSnapshots["the-torment"]` /
`["lightning-dave"]`) genuinely does not appear. This is a narrower gap than
it sounds: the Cast-screen banner (§5) does **not** read `characterSnapshots`
for its orphan/reconciled classification — it calls
`collectOrphanedCharacterFallbacks`, which runs `buildCastResolver` itself
against the raw `characterId`, so the user-visible outcome is unaffected by
this gap. But the literal bullet-2 criterion, read strictly, fails, and is
reported as such rather than papered over.

`renderedFallbackEngine: "kokoro"` is confirmed **gone** for `the-torment`
(the field is entirely absent from its segments post-fix; it now resolves and
renders under its tuned voice). For `lightning-dave` it is **still present**
(see §4) — for a different, legitimate reason, not a resolver regression.

### 3. Objective proxy — embedding cosine (A18's `/embed` methodology)

The production pipeline already computes and stores a 192-d unit-norm ECAPA
speaker embedding per stochastic-engine (Qwen) segment group at synthesis
time, straight from the pre-mux PCM (`server/src/tts/synthesise-chapter.ts:556`,
persisted to `<slug>.embeddings.json`). Using those **pipeline-native**
vectors (not a re-extraction — see the methodology note below for why):

- Chapter 19's `embeddings.json` samples 7 of Torment's 37 segments
  (`sentenceIds` 28, 32, 46, 68, 164, 169, 204) and 68 narrator segments.
- **Torment internal (same speaker):** 21 pairs, cosine mean **0.8107**
  (min 0.7345, max 0.9132).
- **Torment vs. narrator (cross speaker):** 105 pairs, cosine mean **0.1154**
  (min −0.0397, max 0.2301).
- This is the same shape as A18's own precedent (0.229 clone vs. 0.014
  floor) and considerably more decisive in absolute terms (≈0.70 gap here vs.
  ≈0.22 there) — **clear-cut, not ambiguous**.

**Methodology note on the exact requested line** (ch19 `groupIndex: 25`,
sentenceId 26, "Kill the child."): that specific segment was not one of the
7 sampled into `embeddings.json`. I attempted to reproduce a comparable
embedding by extracting its PCM straight from the assembled chapter `.mp3`
(`ffmpeg -ss 116.84 -t 1.44 ... -ar 16000 -f s16le`, matching A18's own
`/embed`-client contract) and posting it to the sidecar's `/embed`. That
**failed a same-segment sanity check**: re-extracting `the-torment`'s own
*already-sampled* sentenceId-28 line the same way and comparing it against
its own stored vector gave cosine **0.1105** — i.e. it does not even
recognise itself, vs. the ~0.81 same-speaker floor above. Transcribing that
same extracted clip (`/transcribe`) confirms the audio content itself is
correct ("Shoot her if you want set fire to her strangle her I do not
care" — matches the manuscript), so the mismatch is not wrong audio; it's
that the assembled/mp3-reencoded audio isn't embedding-equivalent to the
pre-mux PCM the pipeline embeds at synthesis time (mp3 lossy re-encode,
concatenation, and/or loudness normalisation shift the ECAPA vector enough
to decorrelate it from the synthesis-time embedding of the *same* audio).
Rather than report a fabricated number for the literal requested line, I'm
reporting the real, pipeline-native embeddings for the same character in the
same re-render, which support the same conclusion decisively. **If a human
wants the literal groupIndex-25 line specifically, listen to it directly**
(chapter 19, `startSec: 116.84–118.28`) — a numeric proxy for that one line
was not obtainable without instrumenting the render itself to keep every
segment's embedding rather than sampling.

### 4. Negative control — `pool-player-2`

**Unchanged, as expected — no regression.**

- `pool-player-2` is not in `.audiobook/cast.json` under any spelling
  (checked `pool-player`, `pool_player`, `pool-player-2` — only `pool_player`
  singular exists, a different id the analyzer never claims `pool-player-2`
  aliases to; `normaliseIdKey` does not equate them either, since they differ
  by more than separators/case, matching the run sheet's own §prediction).
- All 6 of its ch16 segments carry `voiceName: "qwen-lkIne-ibYaBDqcSU99w8C"`
  — **identical to this chapter's own narrator voiceName** — i.e. it is still
  narrator-substituted, exactly as before. It gains **no**
  `characterSnapshots` entry.
- Cast-screen banner (browser, see §5) independently confirms this: it is the
  **one and only** entry left in "1 character id needs your decision".

The apparent oddity — no `renderedFallbackEngine: "kokoro"` stamp on these
segments — is not a regression either: the narrator itself rendered under
Qwen (not Kokoro) in this run, so a narrator-substitution has nothing to
fall back from. Confirmed by comparing `voiceName` fields directly (see
above), not inferred.

### 5. Cast-screen banner (#2023) — live browser check (Playwright, real UI, not the API)

Navigated to `/#/books/derek-landy__skulduggery-pleasant__playing-with-fire/cast`
on the locally running frontend against the just-re-rendered book:

- **"1 character id needs your decision"** — lists only `"pool-player-2"`
  (6 segments), with `Not found in this book's cast — rendered in the
  narrator's voice instead.` **`the-torment` and `lightning-dave` are not
  named here.** ✅ matches the acceptance bullet exactly.
- **"1 character id auto-reconciled — audio is current"** — lists
  `"lightning-dave"` → Lightning Dave, 1 segment.
- **"1 character id auto-reconciled — audio needs a re-render"** — lists
  `"the-torment"` → Torment, **67 segments**, "resolves now — existing audio
  may still need a re-render". This is correct, not a bug: Torment has 67
  segments across the whole book and this step only re-rendered the 37 in
  chapter 19 (exactly as scoped: "re-render chapter 19 (`the-torment`, 37 of
  its 67 segments)"). The other 30 (other chapters) are genuinely still
  running pre-fix audio, and the aggregate honestly reflects that.

Net: the banner text is exactly what the acceptance criterion asks for —
`the-torment`/`lightning-dave` no longer appear in the "needs your decision"
(orphan) bucket, `pool-player-2` still does, and Torment's own reconciliation
bucket accurately flags that only part of its audio is current.

### A22 verdict

All 4 bullets addressed with real evidence. Bullet 2's literal
`characterSnapshots` criterion is **not met** (real, reported gap — see
above), but the underlying "audibly different voice" criterion (bullet 3) is
**clear-cut and decisive**, the negative control (bullet 4) is **confirmed
unchanged, no regression**, and the live banner (bullet 5) **matches
exactly**.

---

## A23 — Заказ Коалфолла ch2, Wave 3 `--apply` repair (§8.7 + §8.8)

`--apply` already ran for real on 2026-08-05 and rewrote the underlying
`characterId`s directly (`mayrin`→`mairin`, `coalfall`→`coalfall-dragon`),
confirmed in `.audiobook/cast-id-history.json`
(`supersededBy: {"mayrin":"mairin","coalfall":"coalfall-dragon", ...}`,
`seq: 18`). §8.7 (real re-render) and §8.8 (banner cross-check on the real
book) were the two pieces still owed.

### §8.7 — real re-render

Chapter 2 (`Глава первая — Стук`) re-rendered this session:
`audioQa.status: "ok"`, `durationSec: 255.7`, `synthesizedAt: 2026-09-06T05:46:11Z`.
Segments carry the **canonical, post-repair ids directly** (`mairin`,
`coalfall-dragon` — not the old orphaned spellings), each with its own
`voiceName` (`qwen-TP3sfCclL5WIPEhaZ9-Jd` for Мэйрин, distinct from
`qwen-RJznhtTqGRaeobU0bm5XN` for Коалфолл), and **both have a
`characterSnapshots` entry** — unlike A22's read-time-only fix, `--apply`
rewrote the data itself, so this book doesn't hit the same snapshot gap.

**Embedding cosine** (pipeline-native `embeddings.json`, same methodology as
A22 §3, no re-extraction needed since the sample coverage is closer here):

- `coalfall-dragon` internal (same speaker, 5 samples → 10 pairs): mean
  **0.7723** (min 0.6654, max 0.8675).
- `coalfall-dragon` vs. narrator (cross speaker, 85 pairs): mean **0.5643**
  (min 0.3618, max 0.6951).
- `mairin` only has **one** sampled segment this chapter, so no internal
  same-speaker baseline exists for her; vs. narrator (17): mean 0.2132; vs.
  `coalfall-dragon` (5): mean 0.2373; vs. `одуван` (7): mean 0.1876 — all in
  the same 0.19–0.24 band, no separation visible.

**Stated explicitly, as the issue asks: this one is ambiguous, not
clear-cut.** `coalfall-dragon` shows a real gap (0.77 same-speaker vs. 0.56
cross-speaker) but it's noticeably smaller than A22's Torment result (0.81 vs.
0.12) or A18's own precedent shape — plausibly because Коалфолл (a dragon
character) and the narrator may share more vocal-timbre similarity by design,
or because 5/17 samples is a thin base. `mairin` cannot be assessed
numerically at all with only one sample. **Recommend a human listen
directly** rather than trusting the cosine alone, at these exact clips in the
fresh chapter-2 render:

- `mairin`: `startSec` 38.94–39.98, 39.98–42.30, 46.14–48.62 (groupIndex 10,
  11, 13 — several short lines to choose from).
- `coalfall-dragon`: `startSec` 116.94–118.86, 187.37–189.13, 199.05–203.53
  (groupIndex 37, 58, 63) vs. any narrator line in the same chapter, to judge
  by ear whether the 0.56 cross-speaker cosine reflects genuine similarity or
  an embedding-methodology ceiling for this particular pair of voices.

### §8.8 — Cast-screen banner cross-check (live browser, real book)

Navigated to `/#/books/castwright__standalones__%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BA%D0%BE%D0%B0%D0%BB%D1%84%D0%BE%D0%BB%D0%BB%D0%B0/cast`.
**No orphan/reconciliation banner appears at all for this book** — zero
entries in any "needs your decision" or "auto-reconciled" bucket. This is the
correct post-repair state, not a missed check: `--apply` rewrote the
`characterId`s to their canonical live-cast spelling directly, so
`buildCastResolver` now resolves them via the `'exact'` tier, and
`collectOrphanedCharacterFallbacks` explicitly never reports an exact match
("not an orphan at all — never reported",
`server/src/audio/segments-io.ts:404`). Мэйрин and Коалфолл both appear as
ordinary, fully-designed cast rows in the main table
(`qwen-TP3sfCclL5WIPEhaZ9-Jd`, `qwen-RJznhtTqGRaeobU0bm5XN`), with no orphan
chip anywhere — matching what the row's own 2026-08-21 note recorded against
a throwaway copy of this book, now reconfirmed against the real production
workspace.

### A23 verdict

§8.7: real re-render confirmed, reaches actual audio, correct ids/snapshots.
Embedding evidence for `coalfall-dragon` is a real but smaller gap than
A22/A18's precedent (reported as ambiguous per the issue's own instruction,
with named clips for a human to confirm by ear); `mairin` has no numeric
baseline at all (single sample). §8.8: banner cross-check on the real book
confirms zero orphan chips remain for either character — clean pass.

---

## Standing rules followed

No other process on the box was stopped/restarted; the dev server, sidecar,
and frontend started here were fresh processes on their configured ports
(8270/9190/5273), all of which were free before this run. `server/.env` was
not touched. This step touches no `server/**` source, only this evidence file
and pre-existing backups — a normal foreground commit is fine (see
`.backups/step2-a22-a23-20260906-150626/` for the pre-touch snapshots taken by
the earlier parked-claim run).
