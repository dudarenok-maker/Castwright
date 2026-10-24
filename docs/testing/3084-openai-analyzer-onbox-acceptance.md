# #3084 OpenAI-compatible analyzer — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run each
> section, on the stated hardware. Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md)
> Implementation plan: [`docs/superpowers/plans/2026-09-11-openai-compatible-analyzer.md`](../superpowers/plans/2026-09-11-openai-compatible-analyzer.md)
> Regression plan: [`docs/features/284-openai-compatible-analyzer.md`](../features/284-openai-compatible-analyzer.md)
> Issue: [#3084](https://github.com/dudarenok-maker/Castwright/issues/3084)
>
> Register row: A109 (§10 below, rewritten by #3777; the id is unchanged).

---

## 1. Gemini thinking-window timing on real chapters — register row E110

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
  the knob's maximum, a deliberate local ceiling (the owner kept it in #3724;
  it is not a limit the SDK imposes, so a larger value is not ruled out by
  mechanism). If a request still fails at 290 000, record that attempt's
  `stream-timing` line values `firstChunkMs` and `thoughtPartsBeforeAnswer`, and
  that it ran to 290 000 with no answer (its `firstAnswerMs` prints `none`, so
  there is no value to record), and leave raising the ceiling to the owner
  rather than recommending a larger value.
- Otherwise record **keep**.

### Result

`gemini-3.5-flash-lite` — Result:

`gemini-3.6-flash` — Result:

`gemma-4-31b-it` — Result:

Recommendation (keep / lower to … / raise to …, at most 290000):

Run by / date / SHA:

---

## 2. Thinking-model output with Auto max output tokens, and Gemma's split — register row E111

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

## 4. Ollama structured-output modes — register row B105

Book: *The Coalfall Commission* chapter one (`server/src/__fixtures__/the-coalfall-commission.md`).

Prerequisites: a real Ollama daemon with `qwen3.5:4b` pulled; no TTS engine resident.

1. Default (`schema`): analyse chapter one. Note the validation retries (count `*.attempt1.raw.txt` files).
   Result:
2. Set `analyzer.ollama.structuredOutput` = `json`. Re-analyse chapter one. Confirm the inbox request had `format: "json"`. Note retries and outcome.
   Result:
3. Set it to `off`. Re-analyse. Confirm the request had no `format` key. Note retries and outcome.
   Result:
4. Restore `schema`.

Run by / date / SHA:

## 5. Gemini `schema` mode — register row E112

Book: as §4. Prerequisites: a Gemini API key; no local analyzer needed.

1. Set `analyzer.gemini.structuredOutput` = `schema`. Analyse chapter one on `gemma-4-31b-it`. Record: HTTP 400 or accepted; the debug "schema adapter dropped" list; first-attempt conformance.
   Result:
2. Repeat on `gemini-3.5-flash-lite`.
   Result:
3. Restore `json`.

Run by / date / SHA:

## 6. Live structured output — register row A113

Register rows: A113 (this PR; id minted from Group A's next-id marker); wave 3's last
PR extends it and adds the eviction and long-prefill rows. Prerequisites: the GPU box,
Ollama with `qwen3.5:4b`, a Gemini API key, llama-swap serving a Qwen3 model (thinking
switchable) with a per-model unload endpoint, and either a vLLM endpoint started with a
small `--max-model-len` or an OpenRouter key.

1. Advanced Settings → Analyzer rate limits. For each of `qwen3.5:4b`, one `gemma-*`,
   one `gemini-*`, and the llama-swap model (thinking on, then off): click **Test**, confirm
   the request count (2; 1 for a model whose configured mode is `off`), run. Then **Test**
   with "Test every structured-output mode" (3: the off-mode control, `schema`, `json`).
   Result:
2. For each `schema` outcome, send one request by hand in `schema` mode and note whether the
   reply contains `cw_probe_marker`. `enforced` ⇔ present, `ignored` ⇔ absent.
   Result:
3. Thinking models: `gemini-3.6-flash` (default `json`) and the llama-swap Qwen3 model with
   thinking on each end with a saved record, not 502 `finish=length`. Note the
   `max_tokens` / `maxOutputTokens` every request carried; all requests of one test carry
   the same value. Result:
4. Small context: on the small-context vLLM endpoint (or an OpenRouter model whose output
   cap exceeds its remaining context), **Test every mode**. No mode is recorded `rejected`
   because of size; note any 502 "inconclusive" message verbatim. Result:
5. Failed test keeps the record: stop llama-swap, **Test** its model → the 502 says the
   control request failed; the Settings row still shows the earlier outcome. Result:
6. `GET /api/analyzer/models` → note each Gemini entry's `structuredOutput.dropped`.
   Result:
7. Change the llama-swap endpoint's base URL (e.g. `localhost` → `127.0.0.1`): the entry's
   `capability` is gone and the label no longer says "not enforced".
   Result:
7a. Re-pulled Ollama model: note the saved record's `digest` for `qwen3.5:4b`; pull a different
   build of the tag (new digest in `ollama list`); the catalog entry has no `capability`, and an
   analysis on it starts rather than refusing. Old digest ___ new digest ___ Result:

### Real chapters (added in W3d, extends A113)

8. Pick the llama-swap model as the per-run model; analyse one chapter with thinking on,
   then off (`chat_template_kwargs` / server config). Result:
9. Same chapter on `gemma-4-31b-it` and `gemini-3.6-flash` in `schema`, then `json`
   (Advanced → `analyzer.gemini.structuredOutput`). Compare attributions. Result:
10. For the thinking-on llama-swap model and `gemini-3.6-flash`: did any call end
    `analyzer-reasoning-overflow` in a mode the Test recorded `enforced`/`accepted`? Result:

Run by / date / SHA:

## 7. Long silent prefill — register row A115

1. Endpoint on the slower card, context ≥ 64k; chapter whose stage-1 prompt > 64k tokens.
2. Time to first token: ___  Total: ___  Timeouts/retries/fallbacks in the log: ___
   Result:

Run by / date / SHA:

## 8. Fallback to a smaller context — register row A117

1. Endpoint (context ≥ 64k) primary, target `local` with `num_ctx` ≤ 16k; stop `llama-server` during phase 0.
   Per target chunk: `prompt_eval_count` ___ `eval_count` ___ `num_ctx` ___ `done_reason` ___ context shift or error ___
   Result:
2. Ollama primary, llama.cpp target started with `-c 16384`; stop Ollama mid-run.
   Per request: `timings.prompt_n` ___ `timings.predicted_n` ___ context-shift or "exceeds the available context size" lines ___
   Result:
3. A chunk the target cannot take: input-too-large failure (or escalation-skip warning) logged, no request in the target's log. Result:

Run by / date / SHA:

## 9. Same-card eviction — register row A116

1. Idle, one served model: Qwen on the endpoint's card → one unload POST logged, Qwen loaded. Result:
2. Qwen on the other card → no unload POST. Result:
3. Mid-run, between two chunk calls (log shows a finished chunk, the next not yet sent): Qwen
   load on the endpoint's card → no unload POST; the next chunk call needs no model reload;
   Resume prompts. Timestamps of chunk end / Qwen request / next chunk start: ___ Result:
4. Two served models (phase 0 and phase 1 on different models of the endpoint), run finished →
   two unload POSTs, both models unloaded. Unload Qwen, load it again without analysing → no
   unload POST (the models left the served set). Result:
5. Unload URL without `{model}` → the Settings warning shows; the save succeeds. Result:
6. Unload URL removed → NoCapacityError text names "Unload URL" and the endpoint. Result:
7. Run starts during a blocking unload POST (time the Qwen load so the next chunk call begins
   while the POST is out): chapter continues, one model reload, admission retries, and exactly
   one "busy; not unloading" line for that admission. Timestamps: ___ Result:
8. Restart with the endpoint still holding a model, no analysis yet, then load Qwen on its card:
   no unload POST, and the failure names the endpoint and "since Castwright started". Result:
9. Unload URL points at a server that never answers (or answers past 10 s), two served models:
   load Qwen on its card and let the admission poll several times before giving up. Exactly ONE
   unload POST per model across the whole admission (two), the lever's share of the wait near
   2 × 10 s (Σ served models × 10 s), not `maxAttempts` × 10 s, and the failure says every unload
   request to that endpoint failed. Then render a chapter on that card: number of denied synth
   ops ___, time lost ___ (each denied synthesize call repays the bound). Result:
10. Two endpoints on one card, analysis running on B only: Qwen load → A unloaded at once, one
    "busy; not unloading" line for B. B's run ends while the admission polls → B unloaded within
    the same admission; or, if it gave up first, the failure names B as busy for the whole wait.
    Timestamps of A's POST / B's run end / B's POST: ___ Result:

Run by / date / SHA:

## 10. Persona generation on a same-card endpoint — register row A109

**Hardware:** a single 8 GB card, a real OpenAI-compatible server (llama.cpp/llama-swap or
LM Studio) holding a model on that same card (the endpoint's `gpu` = the card Qwen targets),
Qwen VoiceDesign. A book whose characters have no voice description, and a second book with a
chapter you can render.

**Preconditions.** Advanced Settings → Persona generation engine MUST be set to the endpoint's
model (`openai:<endpointId>::<model>`). The default is `gemini`; left alone, the run never
touches the endpoint and proves nothing. Follow the endpoint's server log.

1. No render streaming. Start Design full cast. The endpoint's server log shows the persona
   requests arriving before VoiceDesign loads. First persona request at ___, VoiceDesign load at ___.
   Result:
2. W3d's eviction unloads the endpoint's model before VoiceDesign loads, and VoiceDesign loads and
   designs without an OOM. Unload line at ___, VoiceDesign load at ___. Result:
3. With a chapter render streaming on that card, start Design full cast. "Pause audio generation
   to design voices?" shows. Choose **Pause and design**: the render halts before any persona
   request reaches the endpoint. Render stopped at ___, first persona request at ___. Result:
4. The reverse order is also safe: with VoiceDesign resident on that card, run an analysis
   against the same-card endpoint. It does not OOM and does not silently fall back to another
   engine. Result:
5. After the design finishes, a chapter render on that card succeeds. Result:

Run by / date / SHA:
