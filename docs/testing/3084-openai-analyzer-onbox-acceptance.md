# #3084 OpenAI-compatible analyzer — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run each
> section, on the stated hardware. Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md)
> Implementation plan: [`docs/superpowers/plans/2026-09-11-openai-compatible-analyzer.md`](../superpowers/plans/2026-09-11-openai-compatible-analyzer.md)
> Regression plan: [`docs/features/284-openai-compatible-analyzer.md`](../features/284-openai-compatible-analyzer.md)
> Issue: [#3084](https://github.com/dudarenok-maker/Castwright/issues/3084)
>
> Register rows: A109 (§10 below, rewritten by #3777; the id is unchanged), A118 (§11, endpoint reasoning styles on llama-swap), A119 (§14, custom payload on real servers), B107 (§12, Ollama reasoning levels and Test attribution), E114 (§13, Gemini reasoning levels) and E115 (§15, Gemini config payload).

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
Qwen VoiceDesign. Two books whose characters have no voice description (a fresh import each;
steps 1-2 design every character of the first, and step 3 needs a second one that is still
undesigned), and a third book with a chapter you can render.

**Preconditions.** Advanced Settings → Persona generation engine MUST be set to the endpoint's
model (`openai:<endpointId>::<model>`). The default is `gemini`; left alone, the run never
touches the endpoint and proves nothing. Follow the endpoint's server log.

1. No render streaming, and VoiceDesign NOT resident at the start (idle past `QWEN_DESIGN_IDLE_TTL`,
   default 120 s, so there is a load line to order against). Start Design full cast. The
   endpoint's server log shows the persona requests arriving before VoiceDesign loads. First persona request at ___, VoiceDesign load at ___.
   Result:
2. W3d's eviction unloads the endpoint's model before VoiceDesign loads, and VoiceDesign loads and
   designs without an OOM. Unload line at ___, VoiceDesign load at ___. Result:
3. With a chapter render streaming on that card, open the SECOND undesigned book (not the one
   steps 1-2 designed: Design full cast is disabled there, and a book whose characters have a
   voice description never prompts) and start Design full cast. "Pause audio generation
   to design voices?" shows. Choose **Pause and design**: the render's abort is acknowledged
   before the first persona request (the pause route aborts and answers at once; the design
   starts only after that answer). It does not wait for an in-flight sidecar synth, so record
   whether the last synth's tail overlapped the first persona requests, and whether that caused
   an OOM. Pause acknowledged at ___ (the browser devtools Network panel: the response to
   `POST /api/books/<bookId>/generation/pause` and to `POST /api/queue/pause`; the server logs
   nothing for the pause route), last synth ended at ___, first persona request at ___.
   Overlap: yes / no. OOM: yes / no. Result:
4. The reverse order is also safe: with VoiceDesign resident on that card, run an analysis
   against the same-card endpoint. It does not OOM and does not silently fall back to another
   engine. Result:
5. After both complete (the design and the reverse-order analysis in step 4), a chapter render
   on that card succeeds. Result:

Run by / date / SHA:

## 11. Endpoint reasoning styles on llama-swap — register row A118

**Hardware:** the GPU box with llama-swap serving a Qwen3.6 model. Follow the endpoint's server log.

### Preconditions

- An OpenAI-compatible endpoint on that llama-swap, saved twice (or edited between runs): once with
  reasoning control `reasoning_effort`, once with `chat_template_kwargs.enable_thinking`.
- A chapter to analyse, and a Test available on the endpoint.

### Procedure

1. `reasoning_effort` endpoint: set Reasoning to `none` and analyse the chapter. Watch for
   `reasoning_content` deltas (`reasoningSeen`, or the route heartbeat continuing before any answer text).
   Repeat at `high`.
2. `enable_thinking` endpoint: repeat step 1 at `off` and at `on`.
3. At `on`, run the Test. Record the structured-output probe verdict (`enforced` or `ignored`) and
   whether the run label shows "schema (not enforced)".

### Pass

- At `none` (and `off`) no reasoning deltas stream; at `high` (and `on`) they do.
- The run label shows "schema (not enforced)" only for a level whose probe was recorded `ignored`.

`reasoning_effort` `none` / `high`: deltas ___ / ___ Result:

`enable_thinking` `off` / `on`: deltas ___ / ___ Result:

Probe at `on`: ___ label: ___ Result:

Run by / date / SHA:

## 12. Ollama reasoning levels and Test attribution — register row B107

**Hardware:** local Ollama only; one thinking tag (for example `qwen3.5:4b`) and one non-thinking tag.

### Preconditions

- Both tags pulled. A chapter to analyse.

### Procedure

1. Non-thinking tag: Test with scope `all`. Record each level's verdict.
2. Thinking tag: Test with scope `all`. Open Advanced settings → Analyzer request controls and check
   both models' rows.
3. Set a level the Test recorded `rejected` and start an analysis. Record when it fails and the copy.
4. A2: after step 2, re-pull the same tag so its build changes (`ollama pull <tag>`; `ollama list` shows
   a new digest). Test with scope `configured` and read the stored record.

### Pass

- Non-thinking tag: `on`, `low`, `medium` and `high` `rejected`; `off` and `model-default` `accepted`.
- Thinking tag: `low` `accepted`, and `low` is offered in that model's row and not in the other's.
- The `rejected` level fails the run before the first chapter, naming the level and the date of the
  Test that recorded it.
- After the re-pull, the record keeps only the verdict this Test probed.

Non-thinking verdicts: ___ Result:

Thinking-tag verdicts and rows: ___ Result:

Refusal copy: ___ Result:

A2 record after re-pull: ___ Result:

Run by / date / SHA:

## 13. Gemini reasoning levels — register row E114

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:** `gemini-3.6-flash` allows 20 requests
a day, and §1 and §2 also use it; run this on a different day.

### Preconditions

- A Gemini API key. A chapter long enough to exhaust the output cap (for G1) and an ordinary stage-2 chapter.

### Procedure

1. Test with scope `all` on `gemini-3.6-flash`, `gemini-3.8-flash` and `gemma-4-31b-it`.
2. Analyse a stage-2 chapter on `gemini-3.6-flash` at `model-default`, then at `high`. Record
   `thoughtsTokenCount` for each.
3. Analyse on `gemma-4-31b-it` at `off`, then at `on`. Record thought tokens, and whether the `on` step
   of the Test was `accepted` (A8: whether `thinkingLevel: HIGH` takes `includeThoughts`).
4. G1: on the long chapter, run Gemma at `on` and at its default level; record each outcome.
5. Stale `minimal`: with no analysis running, hand-set `minimal` for `gemini-3.8-flash` in `user-settings.json`,
   then reload the app. Do not Save from the reasoning card before reloading: the settings slice is fetched only
   once at boot, so it would send the stale whole map and overwrite the hand edit. Start an analysis and record
   the refusal copy and the Advanced settings row. Restore the saved level, then reload again.

### Pass

- Every offered level `accepted` (a `length` stop on a level step still counts). The `gemini-3.8-flash`
  result lists `model-default`, `low`, `medium` and `high` with no `minimal` step, and its Advanced
  settings reasoning row does not offer `minimal`.
- With `minimal` hand-set for `gemini-3.8-flash` in `user-settings.json` and the app reloaded, starting an
  analysis is refused before it starts ("is not offered for this model"), and the row shows `minimal` selected
  so it can be changed.
- `high` reports a larger `thoughtsTokenCount` than `model-default`; Gemma `on` differs from `off`.
- Gemma `on` with an empty `MAX_TOKENS` answer fails as `analyzer-reasoning-overflow`; at its default
  level the chunk splits and recovers (#528).
- If the Gemma `on` step is `rejected`, record it: the `on` fragment must drop `includeThoughts`, a
  decision to reopen.

Test verdicts: ___ Result:

Thought tokens (`model-default` / `high`; Gemma `off` / `on`): ___ Result:

A8, Gemma `on` step: ___ Result:

G1, `on` vs default: ___ Result:

Stale `minimal` refusal and row: ___ Result:

Run by / date / SHA:

## 14. Custom payload on real servers — register row A119

**Hardware:** the GPU box with llama-swap and Ollama; one thinking model on an endpoint. Follow the
endpoint's request log and `logs/server.log`.

### Preconditions

- An OpenAI-compatible endpoint on llama-swap, and a local Ollama model. A chapter to analyse.
- A thinking model on the endpoint (for the overflow check in step 5).

### Procedure

1. Endpoint with Custom parameters `{"top_k": 20, "min_p": 0.05, "presence_penalty": 1.5}`: analyse a
   chapter. Read llama-swap's request log for those fields. Note the run label.
2. Ollama with `{"options": {"min_p": 0.05}}` in its custom payload: analyse a chapter.
3. Redaction: save `{"grammar_note": "castwright-onbox-probe-value"}` on a server that rejects unknown
   fields, or `{"options": {"num_keep": "castwright-onbox-probe-value"}}` on Ollama, and analyse. Read the
   failure on screen and in `logs/server.log`.
4. Endpoint Max output tokens: with a custom output cap in the payload, check the field is read-only with
   the note "Ignored while custom parameters set the output cap." and keeps its stored value.
5. 5b-D1 / 5b-D2 / 5b-D3: set the thinking-model endpoint's custom parameters to `{"max_tokens": 64}` and
   analyse. It overflows (`analyzer-reasoning-overflow`). Read the remediation and the fix list. Then set
   `{"max_tokens": null}` and repeat.

### Pass

- Step 1 and step 2 complete a chapter; llama-swap's log shows the three fields. The run label reads
  "+ custom params".
- Step 3 fails with `[redacted]` in place of the value, on screen and in `logs/server.log`; the value
  appears in neither.
- Step 4: Max output tokens is read-only with that note, and its stored value is unchanged.
- Step 5, `{"max_tokens": 64}`: the failure is `analyzer-reasoning-overflow`; its remediation names
  `max_tokens` ("Raise the custom parameter …"); its fixes include that payload fix and
  `Read: Custom payload`, and offer no `Lower <name>'s max output tokens`. With `{"max_tokens": null}` the
  wording is "Set a value for the custom parameter …".

Fields in the request log (step 1): ___ label: ___ Result:

Ollama payload chapter: ___ Result:

Redaction, screen / `server.log`: ___ / ___ Result:

Max output tokens read-only and note: ___ Result:

Overflow wording and fixes, `max_tokens` 64 / null: ___ / ___ Result:

Run by / date / SHA:

## 15. Gemini config payload — register row E115

**Hardware:** any machine with a Gemini API key; no GPU.

### Preconditions

- A Gemini API key. A chapter to analyse. The Gemini payload editor is always shown in Advanced settings,
  with or without a key.

### Procedure

1. Set the Gemini payload to `{"config": {"topK": 40}}` and analyse a chapter.
2. Set `{"config": {"maxOutputTokens": 2048}}` and read the run label.
3. Set `{"config": {"safetySettings": [{"category": "castwright-onbox-probe-value", "threshold": "BLOCK_NONE"}]}}`
   (a value Gemini rejects) and analyse. Read the failure on screen and in `logs/server.log`.
4. Try to save `{"config": {"httpOptions": {"baseUrl": "http://127.0.0.1:1"}}}`.

### Pass

- Step 1 completes a chapter.
- Step 2: the label reads "max output set by custom params".
- Step 3 returns `analyzer-request-rejected`, with the value redacted on screen and in `logs/server.log`.
- Step 4 is refused on save, naming `config.httpOptions`.

topK chapter: ___ Result:

Label with `maxOutputTokens`: ___ Result:

Rejected safetySettings, screen / `server.log`: ___ / ___ Result:

`httpOptions` refusal: ___ Result:

Run by / date / SHA:
