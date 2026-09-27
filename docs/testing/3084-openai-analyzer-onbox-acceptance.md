# #3084 OpenAI-compatible analyzer — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run each
> section, on the stated hardware. Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md)
> Implementation plan: [`docs/superpowers/plans/2026-09-11-openai-compatible-analyzer.md`](../superpowers/plans/2026-09-11-openai-compatible-analyzer.md)
> Regression plan: [`docs/features/284-openai-compatible-analyzer.md`](../features/284-openai-compatible-analyzer.md)
> Issue: [#3084](https://github.com/dudarenok-maker/Castwright/issues/3084)

---

## 1. Gemini thinking-window timing on real chapters — register row E108

**A measurement that gates nothing.** Wave 2 gives a thinking Gemini model a
thinking window of 120 000 ms (`GEMINI_THINKING_IDLE_TIMEOUT_MS`): every silent
gap before its answer text starts, including the wait for the first chunk, may
last that long. Any other model keeps today's 45 s (plan decision P5). No real
chapter has measured those waits. This section records them and whether the
default should change; a change is its own follow-up PR, within the knob's
290 000 ms maximum.

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:** one chapter
on each of three models. `gemini-3.6-flash` allows 20 requests a day, and §2
also uses it, so run §1 and §2 on different days.

### Preconditions

- [ ] A book with one chapter of 19,000–21,000 characters. Record its title,
      chapter id and exact character count.
- [ ] `GEMINI_THINKING_IDLE_MS` and `ANALYZER_MAX_OUTPUT_TOKENS` are unset
      in `server/.env`, and Advanced Settings has no override for "Gemini
      thinking idle timeout (ms)" or "Gemini max output tokens".
- [ ] The app is started with `npm start`, so that `logs/server.log` is written.
- [ ] A second terminal follows the log: `Get-Content logs/server.log -Wait`
      (PowerShell) or `tail -f logs/server.log` (Git Bash).

### Procedure

For each model in turn — `gemini-3.5-flash-lite`, `gemini-3.6-flash`,
`gemma-4-31b-it`:

1. Select the model for both analysis phases and start a fresh analysis of the
   chapter, so stage 1 (cast detection) and stage 2 (attribution) both call it.
2. Watch the Analysing view. When it moves from cast detection to attribution,
   note the last `[gemini] stream-timing` line printed so far: lines up to it
   are stage 1, lines after it are stage 2. If the view shows both phases
   running at once, record the two stages together and say so.
3. For each stage, record from its `[gemini] stream-timing model=<model> …` lines:
   - the number of lines (request attempts);
   - the largest and the median `firstChunkMs`, and the largest and the median
     `firstAnswerMs`;
   - the largest `thoughtPartsBeforeAnswer`;
   - every `firstAnswerMs=none` line, every `[gemini] stream idle` line, and
     every `analyzer-timeout` failure that names the thinking window.

### Decision

- **Lower the thinking default** if every thinking-model `firstAnswerMs` is far
  below 120 000; record the largest value seen.
- **Raise it, to at most 290 000,** if a thinking-model request failed with
  `analyzer-timeout` naming `analyzer.gemini.thinkingIdleTimeoutMs`. 290 000 is
  the knob's maximum: the SDK's `fetch` ends a request after undici's fixed
  300 s, so no higher value can take effect. If a request still fails at
  290 000, record that and recommend a design follow-up, not a larger value.
- Otherwise record **keep**.

### Result

`gemini-3.5-flash-lite` — Result:

`gemini-3.6-flash` — Result:

`gemma-4-31b-it` — Result:

Recommendation (keep / lower to … / raise to …, at most 290000):

Run by / date / SHA:

---

## 2. Thinking-model output with Auto max output tokens, and Gemma's split — register row E109

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:**
`gemini-3.6-flash` allows 20 requests a day, and this section runs one chapter
on it twice (Auto, then the 8192 baseline). Start on a fresh daily quota.

### Preconditions

- [ ] The same chapter as §1 (19,000–21,000 characters). Record its title,
      chapter id and exact character count.
- [ ] `ANALYZER_MAX_OUTPUT_TOKENS` is unset in `server/.env`, and Advanced
      Settings has no override for "Gemini max output tokens" (Auto).
- [ ] The app is started with `npm start`, so that `logs/server.log` is written.

### Procedure

1. Analyse the chapter with `gemini-3.6-flash` at Auto.
2. From `logs/server.log` and the Analysing view, record:
   - the `firstChunkMs` and `firstAnswerMs` of each `[gemini] stream-timing` line;
   - whether the chunk heartbeat moved while the model was thinking;
   - every `[gemini] stream idle` line;
   - every `output truncated` line;
   - any `analyzer-reasoning-overflow` failure (it stops the run) and any
     `analyzer-timeout`;
   - the number of Gemini requests the chapter took (AI Studio's RPD counter
     before and after).
3. Set Advanced Settings → "Gemini max output tokens" to `8192`, re-run the
   same chapter, and record the same fields.
4. **Gemma split.** Select `gemma-4-31b-it` for both phases, set "Gemini max
   output tokens" to `64`, and analyse the same chapter. A 64-token cap is far
   below any chapter's reply, so Gemma must stop at `MAX_TOKENS`. Record:
   - every `[gemini] output truncated reason=MAX_TOKENS bytes=0` line;
   - whether a `section N/M` re-split log line follows each of them;
   - any `analyzer-reasoning-overflow` failure;
   - whether the chapter completes. At a 64-token cap it may not; that is
     recorded, not judged.

   **If no `bytes=0` line appears at `64`, this row FAILS.** Record the
   truncation lines that did appear and the SHA. The split recovery is unproven
   until an empty `MAX_TOKENS` has been reproduced.
5. Clear the override (back to Auto).

### Pass

- Auto completes the chapter with no `analyzer-timeout` and no
  reasoning-overflow failure.
- Auto uses no more requests than the 8192 run.
- On `gemma-4-31b-it` at `64`, at least one `bytes=0` truncation appears,
  every one is followed by a re-split, and no `analyzer-reasoning-overflow`
  failure occurs.
- A truncation or overflow in the 8192 run is the baseline being recorded, not
  a failure of this row.

### Result

Auto — Result:

8192 baseline — Result:

Gemma split — Result:

Run by / date / SHA:

---

## 3. Capacity recalibration before any capacity default changes — register row B102

**Not a pass/fail acceptance of shipped behaviour.** Wave 2 kept every chunk
budget byte-identical (`server/src/analyzer/capacity-pinning.test.ts`). This
section records the measurement that must exist **before** anyone changes a
capacity default: `analyzer.ollama.numCtx`, the two
`analyzer.stage{1,2}.localInputFraction` knobs, or a clamp to `/api/show`'s
native context (spec §6, "After measurement").

**Hardware:** the 16 GB card, a real Ollama daemon, no TTS engine resident.

### Preconditions

- [ ] A large-context local model is pulled. Record its tag and its
      `/api/show` `model_info.*.context_length`.
- [ ] At least two short-context tags are pulled whose native context is below
      32768. Record each tag and value.
- [ ] *Ночной дозор* (Night Watch), or another book with chapters over 60,000
      characters.

### Procedure

1. **Baseline.** Analyse three large chapters at today's defaults (`num_ctx`
   32768, fractions 0.7 / 0.3). Record per chapter:
   - stage-1 and stage-2 section counts (the "section N/M" log lines);
   - the `output truncated` line count;
   - attribution quality (`scripts/measure-attribution.mjs`, as in register
     row E9).
2. **Large context.** Set `analyzer.ollama.numCtx` to the large model's served
   context — no higher than fits the card; record the value and `ollama ps`
   VRAM. Re-run the same three chapters and record the same figures.
3. **Short-context tags.** For each short-context tag, record `num_ctx` sent
   (32768) against its native context. Run one chapter and record its
   truncation count.

### Result

Baseline — Result:

Large context — Result:

Short-context tags — Result:

Run by / date / SHA:
