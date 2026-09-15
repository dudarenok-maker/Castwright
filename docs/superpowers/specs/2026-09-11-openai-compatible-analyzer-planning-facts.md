---
status: reference
issue: 3084
date: 2026-09-11
---

# OpenAI-compatible analyzer — facts verified during planning

Evidence behind the [design](2026-09-10-openai-compatible-analyzer-design.md) and the [implementation plan](../plans/2026-09-11-openai-compatible-analyzer.md). Plan tasks cite these sections as `planning-facts §A` (openai SDK + undici), `§B` (llama.cpp / llama-swap / vLLM / OpenRouter / LM Studio / LiteLLM / Ollama) and `§C` (Gemini). Each fact carries its source; nothing here was assumed.

## §A — openai SDK 7.15.0 + undici 8.10.0 (observed by running probes)

Node v24.15.0 (built-in undici 7.24.4); `openai@7.15.0`; `undici@8.10.0` (= server/node_modules). openai declares `undici >=5 <9` as OPTIONAL peer; no hard deps. Probe scripts: [`assets/2026-09-11-openai-undici-probe/`](assets/2026-09-11-openai-undici-probe/) (`p01`–`p14` + `lib.mjs`; run with `npm install openai@7.15.0 undici@8.10.0` in that folder, then `node p01-happy.mjs`).

### Observed facts
1. `new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout, fetch: undici.fetch, fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } }) } })` streams chat completions correctly.
2. Same Agent WITHOUT `fetch: undici.fetch` → `APIConnectionError` ("…incompatible with the fetch implementation…"), cause `TypeError fetch failed` → `InvalidArgumentError UND_ERR_INVALID_ARG "invalid onRequestStart method"`. `fetch: undici.fetch` is mandatory.
3. **Abort AFTER headers (caller abort or `AbortSignal.any` ceiling) does NOT throw** — `for await` returns within ~2 ms (P2, P4a, P4c). Custom reasons too.
4. **Abort BEFORE headers throws `APIUserAbortError`** from `create()`, `err.cause === signal.reason` (`AbortError` / `TimeoutError` DOMException / custom Error) (P3, P4b).
5. After a silent end, only OUR signals tell which fired: `ceiling.aborted` (reason name `TimeoutError`) vs `caller.aborted`. `stream.controller.signal` is never the caller's signal and is also `aborted=true` after thrown errors — do not use it.
6. SDK `timeout` covers only until headers: no headers → `APIConnectionTimeoutError` (cause AbortError); after headers it is cleared (3 s silence did not fire it) (P5).
7. Server `res.end()` after chunks with no `finish_reason` and no `[DONE]` → loop ends cleanly (P9b). Must check "saw finish_reason".
8. Server `res.destroy()` mid-stream → loop THROWS plain `TypeError "terminated"`, cause `SocketError UND_ERR_SOCKET "other side closed"` — not an APIError subclass (P9a).
9. Connect timeout (`UND_ERR_CONNECT_TIMEOUT`, cause two levels: `err.cause.cause.code`) → `APIConnectionTimeoutError` (also `instanceof APIConnectionError`). `ECONNREFUSED`, `ENOTFOUND` → plain `APIConnectionError`, code at `err.cause.cause.code` (P6-P8).
10. Port 9 is rejected by undici fetch as "bad port" immediately — tests must not use it for connect-timeout; `10.255.255.1:8080` with connect.timeout 1500 errored at ~2046 ms.
11. HTTP errors throw from `create()` when streaming: 400 `BadRequestError`, 401 `AuthenticationError`, 429 `RateLimitError`, 503 `InternalServerError`; all `instanceof APIError`, `.status`, `.error` (parsed `{message,type,code,param}`), `.headers` is `Headers` (`retry-after` readable) (P11).
12. In-stream `data: {"error":{…}}` event → `APIError` thrown from the LOOP with `.status === undefined`, payload on `.error` (P11e).
13. Unknown top-level params pass to the wire untouched: `chat_template_kwargs`, `top_k`, `reasoning_effort`, `response_format` json_schema (P12).
14. `delta.reasoning_content` and `delta.reasoning` reach the consumer exactly as sent; the `choices: []` usage chunk (with `stream_options.include_usage`) is yielded, incl. `completion_tokens_details.reasoning_tokens` (P10, P13).
15. `client.models.list()` preserves unknown fields (`max_model_len`, `meta.n_ctx_train`) (P14).

### Source cites (openai 7.15.0; ESM at package root, TS under `src/`)
- `core/streaming.mjs:134-141` (TS `src/core/streaming.ts:175`): catch returns silently on transport abort / aborted controller. `:375-383` (TS 434-450): once aborted `next()` returns done. `:509-513` (TS 574) rethrows only non-abort errors.
- `client.mjs:960-992` (TS 1568-1604) `fetchWithTimeout` clears timeout when fetch resolves; `:525-531` (TS 1016) no body timer for streams; `:751-753,1296-1319` (TS 2030-2051) `AbortSignal.any([controller, caller])`; `:745-748,763-765,1179-1182` (TS 1840) user-abort error with `cause = signal.reason`; `:770-771` (TS 1301) timeout detection regex; `:797-812` (TS 1347) `APIConnectionTimeoutError` with cause; `:817-820` (TS 1363) `APIConnectionError` with cause.

### Consequences for the OpenAI transport classification (refines spec §1 "Classification")
After the loop (clean end) and in every catch, in order:
1. `callerSignal.aborted` → `AnalysisAbortedError`.
2. No response headers received yet AND cause chain (walk `.cause` up to 4 levels) has a code in `UNREACHABLE_CODES ∪ {UND_ERR_CONNECT_TIMEOUT}` or message `fetch failed` → `AnalyzerUnreachableError`.
3. `ceilingSignal.aborted` OR `err instanceof APIConnectionTimeoutError` → `AnalyzerTimeoutError`.
4. `err instanceof APIError && err.status !== undefined` → `AnalyzerHttpError { httpStatus: err.status, bodyExcerpt }` (429 / 5xx handled by the retry helper first).
5. `err instanceof APIError && err.status === undefined` (in-stream error event) → `AnalyzerHttpError { httpStatus: 0, bodyExcerpt: JSON of err.error }` — not retried.
6. Headers received AND (plain `TypeError "terminated"` with `UND_ERR_SOCKET`/`ECONNRESET` in chain, OR clean loop end with no `finish_reason` seen) → `AnalyzerStreamIncompleteError` (retried like idle).
7. Anything else → rethrow unchanged.
"Headers received" = `create()` resolved (the SDK returns the Stream only after `fetch` resolves).

## §B — local and gateway servers (source-read)

Commits read: llama.cpp `451b89ba`, llama-swap `41ec321b`, Ollama `b68b112b`, vLLM `5c642796`, LiteLLM `362033cb`.

### llama.cpp llama-server
1. **Streaming headers** are sent when a slot STARTS the prompt (an `is_begin` partial, `server-context.cpp` L3417-3424), i.e. before prefill completes but NOT while the request waits for a free slot. A request queued behind a busy slot gets no headers until a slot frees. (httplib header flush itself unconfirmed.)
2. `/props` `default_generation_settings.n_ctx` = per-slot served context (`n_ctx_slot()`, capped by `n_ctx_train`). `/v1/models` `data[].meta` carries BOTH `n_ctx_train` (training) AND `n_ctx` (per-slot served) (`server-context.cpp` L4545-4560).
3. `reasoning_effort`: no allowed set; `"none"` turns thinking off; any other string is passed to the Jinja template unvalidated (no 400); non-string ignored with a warning. `chat_template_kwargs: {enable_thinking: false}` also disables per request (string `"false"` throws). Budget field: `reasoning_budget_tokens` (alias `thinking_budget_tokens`).
4. Streamed reasoning delta field: `reasoning_content`; `reasoning_format` per request `none|auto|deepseek|deepseek-legacy` (`none` leaves thinking in `content`).
5. **ggml-org/llama.cpp#20345 is CLOSED** (2026-03-10) pointing at fix commit 62b8143 ("Fix structured outputs (#20223)"); later comments (2026-04..06) report recurrence on Qwen3.6 / gpt-oss, and "cannot work with reasoning_format=none"; related open bug #27279 (json_schema stops mid-object → 500). ⇒ schema enforcement with thinking cannot be assumed per model; the Test action's enforced/ignored probe stays necessary.
6. API key: `--api-key` / `LLAMA_API_KEY`; read from `Authorization` (with or without `Bearer `) or `X-Api-Key`; bad key → 401. `/props` and `/v1/models` require the key; `/health` does not.

### llama-swap
7. `GET /props?model=<id>` exists and **loads (swaps in) the model**; `/upstream/<model>/props` also swaps.
8. Unload: `GET /unload` (all, text OK), `POST /api/models/unload` (all, `{"msg":"ok"}`), `POST /api/models/unload/{model}` (one; 200 text OK or 404). All require the API key when `apiKeys` is set; all block until processes stop.
9. `apiKeys` config; accepted as `Authorization: Bearer`, Basic password, or `x-api-key`. Protected: inference, `/v1/models`, `/unload`, `/upstream/*`, `/api/*`, … ; open: `/health`.
10. `/v1/models` entries: `id, object, created, owned_by, name, description, architecture, capabilities, supported_parameters, context_length, context_window, meta, status:{value: loaded|unloaded}`. `context_length` / `context_window` / `meta.n_ctx` come ONLY from llama-swap config `capabilities.context` (omitted when unset) — user-declared, not read from upstream.

### Others
11. vLLM: `/v1/models` `max_model_len` (served). Streamed reasoning delta field is now **`reasoning`** (`reasoning_content` deprecated). `reasoning_effort` accepts `none|minimal|low|medium|high|xhigh|max`; sets `enable_thinking = effort != "none"` unless given.
12. OpenRouter: `/api/v1/models` `context_length`, `top_provider.{context_length,max_completion_tokens}`. Request `reasoning: {effort, max_tokens, exclude, enabled}` or top-level `reasoning_effort` (max…none). Streaming reasoning documented as `delta.reasoning_details` (ARRAY); plain `delta.reasoning` string in streams unconfirmed.
13. LM Studio: `/api/v0/models` `max_context_length`, `state`; `/api/v1/models` `loaded_instances[].config.context_length` (served). `response_format:{type:'json_object'}` → 400 "'response_format.type' must be 'json_schema' or 'text'" (user reports through 0.4.21, bug tracker #189 open).
14. LiteLLM: `/v1/models` may include `max_input_tokens`/`max_output_tokens` from LiteLLM's CATALOGUE (not the backend) — not a served value.

### Ollama
15. Model/tag/namespace cannot contain `::` (`types/model/name.go`); `::` can only appear in a host segment (`h::1/ns/model:tag`, contains `/`).
16. `think: false` on a non-thinking model: accepted silently. `think: true` or a level on a non-thinking model: **400 `"<model>" does not support thinking`**.
17. Think values: `true|false|"low"|"medium"|"high"|"max"`; other strings → parse error. gpt-oss ignores true/false (maps max→high). Other thinking models treat a level as "on" and pass it to the template.
18. `format` + `think: true`: schema IS enforced on the answer via a two-pass re-run (format held back while thinking; generation re-run with format when answer text starts → second prefill).

### Consequences for the plan (and spec amendments)
- Endpoint context prefill sources (served only): `max_model_len` (vLLM) → `meta.n_ctx` (llama.cpp per-slot; llama-swap config) → `context_length` (OpenRouter; llama-swap config). Never `meta.n_ctx_train`, never LiteLLM `max_input_tokens`.
- OpenAI transport reasoning activity fields: `delta.reasoning_content`, `delta.reasoning` (string), `delta.reasoning_details` (array, non-empty).
- `reasoning_effort` style is valid for llama.cpp too (`none` = off); `enable_thinking` style remains for templates that key on it.
- A request waiting on a busy llama.cpp slot has no headers → bounded by the endpoint ceiling (classified timeout), never unreachable.
- Ollama `on`/levels 400 on non-thinking models → surfaces as `analyzer-request-rejected`; the Test action records it.
- Endpoint unload for llama-swap: `POST {origin}/api/models/unload/{model}` with the key.

## §C — Gemini API (docs + installed SDK types; no live calls)

SDK `@google/genai` 2.19.0. `D` = `server/node_modules/@google/genai/dist/genai.d.ts`. Docs: generateContent pages are now under `/docs/generate-content/` ("Legacy"); Interactions API is primary.

1. **includeThoughts streaming** — docs: "thinking with streaming … returns rolling, incremental summaries during generation" (ai.google.dev/gemini-api/docs/generate-content/thinking). Docs evidence only; whether the first `thought` part arrives before thinking ends is UNOBSERVED. The wave-2 thinking window (plan P5) does not depend on it; an on-box row measures it.
2. **Levels.**
   - `thinkingLevel` enum MINIMAL/LOW/MEDIUM/HIGH (`D:14409-14430`).
   - 3.6 Flash / 3.5 Flash / 3 Flash: minimal supported; default medium (3.6/3.5), high (3 Flash). 3.5 / 3.1 Flash-Lite: minimal is default. 3.8 / 3.7 Flash: minimal = error. 3.1 Pro: no minimal.
   - 3.x cannot disable thinking; "minimal does not guarantee thinking is off".
   - 2.5: `thinkingBudget` — 2.5 Pro 128–32768 cannot disable; 2.5 Flash 0–24576 (0 disables); 2.5 Flash-Lite 512–24576, 0 disables, doesn't think by default; -1 dynamic (`D:14399`).
   - Sending BOTH thinkingLevel and thinkingBudget → 400. thinkingBudget to 3.x accepted (back-compat).
   - **Gemma 4 on the Gemini API supports thinking on/off: thinkingLevel "high" = on, "minimal" = off** (ai.google.dev/gemma/docs/core/gemma_on_gemini_api). includeThoughts on Gemma UNCONFIRMED.
   - ⇒ level sets must be per model (table keyed by id pattern), not per family.
   - **Re-verified 2026-09-13** (owner review F2) against ai.google.dev/gemini-api/docs/generate-content/thinking, ai.google.dev/gemini-api/docs/latest-model (Gemini 3.8 Flash) and ai.google.dev/gemini-api/docs/gemini-3. Quotes below came through a page fetch on that date.
     - **3.8 Flash and 3.7 Flash:** `low` / `medium` / `high`. `minimal` returns an error (latest-model: "`minimal` thinking level is not supported for Gemini 3.8 Flash and will return an error").
     - **3.6 Flash and 3.5 Flash:** `minimal` / `low` / `medium` / `high`.
     - **3.5 Flash-Lite and 3.1 Flash-Lite:** `minimal` / `low` / `medium` / `high` (`minimal` is the default).
     - **3.1 Pro:** `low` / `medium` / `high`, with no `minimal`.
     - **No off on 3.x.** Thinking page: "You cannot disable thinking for Gemini 3.1 Pro. Gemini 3 Flash and Flash-Lite also do not support full thinking-off."
     - **Defaults, settled: 3.8 / 3.7 Flash `medium`.** The thinking page's table, read twice on 2026-09-13, marks the default as:
       - `medium` for 3.8 & 3.7 Flash, and for 3.6 & 3.5 Flash;
       - `high` for Gemini 3 Flash (`gemini-3-flash-preview`), as the first read above records ("high (3 Flash)"). It needs its own row or an override, not the 3.x Flash row's `medium`;
       - `minimal` for 3.5 & 3.1 Flash-Lite;
       - `high` for 3.1 Pro: the thinking page lists "low, medium, high (default)" for 3.1 Pro (ai.google.dev/gemini-api/docs/generate-content/thinking).

       The 3.8 page agrees ("Medium (default): Best quality for most tasks."). An earlier owner-review read that recorded `low` for 3.8 / 3.7 was wrong. The plan uses these defaults only to gate reasoning-level overflow fixes (`defaultLevel`); the wire still omits the field at `model default`.
     - **`thinkingBudget` is still accepted for back-compat** (thinking page: "While `thinkingBudget` is accepted for backwards compatibility, using it with Gemini 3 Pro may result in unexpected performance."; gemini-3 page: "`thinking_budget` is still supported for backward compatibility, but we recommend migrating to `thinking_level`"). **The plan no longer uses it:** P9 is retired, Gemini 2.5 ids get `model default` only, and nothing sends `thinkingBudget`. The 2.5 budget facts above are kept as history only.
     - **Both fields → 400.** gemini-3 page: "You cannot use both `thinking_level` and the legacy `thinking_budget` parameter in the same request. Doing so will return a 400 error."
3. **models.list `Model`** fields (`D:10790-10841`): name, displayName, description, version, inputTokenLimit, outputTokenLimit, supportedActions, temperature, maxTemperature, topP, topK, `thinking?: boolean`. No output-modality field ⇒ filter = supportedActions includes generateContent AND name excludes `embedding|-tts|-image|-live|imagen|veo|aqa`.
4. **responseJsonSchema** (`D:5652-5667`) supported: `$id $defs $ref $anchor type format title description enum items prefixItems minItems maxItems minimum maximum anyOf oneOf properties additionalProperties required propertyOrdering`. NOT: `$schema minLength maxLength pattern exclusiveMinimum`. Docs: "The model ignores unsupported properties." (documented, untested). Size: "may reject very large or deeply nested schemas" (no numbers). `responseSchema` must be omitted when responseJsonSchema set.
5. `usageMetadata.thoughtsTokenCount?: number` (`D:5917`); stream response carries usageMetadata (`D:5760`); per-chunk presence undocumented (read the last chunk that has it).
6. maxOutputTokens INCLUDES thought tokens. gemini-3.6-flash and gemini-3.5-flash-lite: 1,048,576 input / 65,536 output.
7. `MAX_TOKENS` finish (`D:5100-5102`). Empty-text-with-MAX_TOKENS when thinking eats the cap: secondary evidence only (forum; python-genai #782).
8. Free-tier limits not published officially (AI Studio only); rate-limit.ts table unverifiable.
9. **Temperature guidance for Gemini 3 (2026-09-13).** A decision is owed outside #3084 (spec "Decisions owed outside #3084").
   - ai.google.dev/gemini-api/docs/gemini-3:
     - "For all Gemini 3 models, we strongly recommend keeping the temperature parameter at its default value of `1.0`."
     - "Changing the temperature (setting it below 1.0) may lead to unexpected behavior, such as looping or degraded performance, particularly in complex mathematical or reasoning tasks."
   - ai.google.dev/gemini-api/docs/latest-model (3.8 Flash migration): "Strip `temperature`, `top_p`, and `top_k` from generation configs".
   - Google Cloud's Gemini 3.8 Flash developer guide (docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash) says temperature, top_p and top_k are ignored by the backend. This is from the owner-review read; a 2026-09-13 re-fetch returned only the page's navigation, so that sentence was not re-read.
   - Castwright at `46e62a34`: `analyzer.gemini.temperature` defaults to 0.2 (`registry.ts:61-69`), and the Gemini validation retry replays at that temperature (`gemini.ts:484-493`).
   - Options owed: keep 0.2; default to 1.0; or send no temperature to 3.x.

## §D — the pinned main commit, and what moved under it

The plans were first written against main `2b63b451`. They are re-pinned to `46e62a34`; **104** commits landed in between — and main moved twice *during* the re-pin itself (`d8396649`, then `46e62a34` with PR #3195), which is why every citation below names the commit it was read at rather than "current main". Verified by diffing `2b63b451..origin/main` over `server/src`, `src` and `openapi.yaml`.

**Unchanged in that range** — so every plan claim resting on them still holds: all of `server/src/analyzer/` except `rate-limit.ts` and `attribution-eval/`; all of `server/src/gpu/**`, which is where `capacity-retry.ts` lives (**not** `server/src/tts/` — an earlier draft of this list named the wrong directory, and `git grep` could not catch it because this document is untracked); `server/src/routes/voice-style.ts`; `server/src/routes/annotate-emotion.ts`; instruct-annotation. Absent from the diff, not merely unsearched.

**Changed, and the plans were re-derived:**

1. **`routes/cast-design.ts`** — `6222e483` (second half of #3027, follow-ups `b8b12be5`, `f3d3a341`) wraps the lazy-path `generateVoiceStylePersona` + `writeVoiceStylePersona` call in its own try/catch inside `runDesignJob`: a failure pushes to `job.failures`, broadcasts `character_failed` and continues to the next character, instead of reaching the route's job-wide backstop. `ensureCharacterVoiceUuid` moved inside the per-character `try` for the same reason. ⇒ the lazy path is per character today; P20 owes no decision on it, and #3230 is now CLOSED (2026-09-12).
2. **`workspace/user-settings.ts`** — `95cf6f78` (#3175). Read at `origin/main`, because an earlier summary of this commit was wrong and the wrong version reached several plan files before being corrected: **nothing about a malformed file throws.** `performUserSettingsRead` (`:472-530`) recovers an unparseable file from its `.bak.N` backups; when the file and every backup are unreadable it warns once and returns in-memory defaults with `corrupt: true` (`:479-498`); an absent file returns defaults with a `null` stamp (`:499-509`); a **schema** failure returns whole-file defaults (`:522-525`). `readUserSettings()` rejects only when `readFile`/`stat` itself fails (a locked or unreadable file) or the legacy-settings migration's `copyFile` fails — which is why `bootWarmUserSettings` (`index.ts:135-144`) wraps the boot warm in its own try/catch and logs, called fire-and-forget at `:188`. ⇒ P25's lenient parse is still about schema failures, and the site it argues from is the whole-file fallback at `:522-525` (not `:375-380`, which is an unrelated in-flight-read comment).
3. **`routes/analysis.ts`** — ~800 lines changed across several #3169/#3174 commits: request-lifecycle logging moved to the top of the POST handler and gained `[analysis] request received`, `[analysis] subscribe` and `[analysis] start` lines; the snapshot writes and the stale-state delete in `endJob` sit in a wider try/catch. ⇒ every line citation re-pinned; steps that assert on analysis log output updated.
4. **`routes/script-review.ts`** — #3174: a start failure's SSE message goes through `requestFailureMessage()`, not the raw `err.message`, and subscriber cleanup clears each keepalive.
5. **`analyzer/rate-limit.ts` + `config/registry.ts`** — #3163: `resolveLimits` reads a saved Settings override after the env check, and the six `rate.*.gemma*` knobs are now `apply: 'live'`. Already stated correctly in w2 (cited as "since #3163"); no correction needed.
6. **`analyzer/attribution-eval/run-eval.ts`** — `83c359fe` (#3196, PR #3199): the engine is passed to stage-2 eval runs. This is wave 2's own dependency, already merged.

**Re-pinning line citations is by symbol, never by arithmetic.** The shift is not a constant offset: in `workspace/user-settings.ts` (+228/−19) `readUserSettings` moved 353→436 while the whole-file `safeParse` fallback moved 375→522 and `writeUserSettings` 402→592. Every citation was re-derived by finding the named construct at `46e62a34`. The load-bearing anchors, verified by reading them:

| What | At `46e62a34` |
|---|---|
| `readUserSettings` / whole-file schema fallback / `getCachedUserSettings` / `writeUserSettings` | `user-settings.ts:436` / `:522-525` / `:537` / `:592` |
| Malformed-file path (backup recovery, else defaults + `corrupt: true`) | `user-settings.ts:479-498` |
| Boot warm, fire-and-forget, wrapped in its own try/catch | `index.ts:188` (`bootWarmUserSettings`, `:135-144`) |
| `endJob` | `analysis.ts:3063` |
| Job terminal classify + `endJob` call | `analysis.ts:6444-6450` (subset `:8042`) |
| Phase-0 per-chapter content-block rethrow | `analysis.ts:4550` (subset `:7149`) |
| Subset Phase-0 per-chapter catch | `analysis.ts:7144-7155` |
| Phase-1 pool `launchNext` + its catch | `analysis.ts:5680-5691` (catch `:5685-5689`) |
| Silence warning / heartbeat threshold | `analysis.ts:4417-4423` / `:1184` |
| Stage-1 chunk-budget call | `analysis.ts:4496` (subset `:7065`) |
| `structureBudget` declaration and share | `analysis.ts:3692`, `:5462` (subset `:6805`, `:7361`) |
| Non-story classifiers | `analysis.ts:5814-5836` (subset `:7540-7566`), swallowing catch `:5831-5833` |
| `unloadResidentOllama` / `usesLocalAnalyzer` | `analysis.ts:3235` / `:3716` |
| `persistTerminalSnapshot` | `analysis.ts:2875` |
| Script review: content-block capture / catch / terminal event / budget call / warm / keep-alive pin | `script-review.ts:924` / `:944-951` / `:972-987` / `:840` / `:748` / `:798` |
| Gemini escalation analyzer (stays Gemini) | `analysis.ts:2182` |
| `FORBIDDEN_KEYS` set / its last entry `'tourCompletedAt'` / `stripForbiddenKeys` | `user-settings.ts:643-661` / `:660` (`]);` at `:661`) / `:663-671` |
| Mock settings whitelist: `mockPutUserSettings`, its destructure, its mirrored object | `src/lib/api.ts:7320` / `:7324-7337` / `:7341-7354` |

**PR #3195 refactored the very function P25 planned to rewrite.** The shipped read path is `inFlightRead` → `performUserSettingsRead` → `commitRead`, with unparseable-file recovery through `readJsonWithRecovery` over `.bak.N` backups, stamp-based cache invalidation, and a `corruptSettingsFile` flag. W3ab's endpoint-storage task had proposed its own `coldRead` single-flight wrapper plus per-entry drop logic against the OLD shape, so applying it verbatim would have clobbered that machinery; one of its replacement blocks would also have deleted the shipped `corruptSettingsFile` field from `UserSettingsResponse`. P25's behaviour is unchanged and its single-flight requirement is now **already satisfied** by the shipped code — the per-entry endpoint parse hooks into `performUserSettingsRead` relative to the whole-object `safeParse` (`:522`) instead. **Dropping an invalid endpoint entry does not set `corruptSettingsFile`:** that flag means the file itself was unreadable and was recovered, while a dropped entry is a schema failure on one entry, reported by its own warning naming the archive file.

**PR #3195 (in `46e62a34`) added a server-owned settings field the plans predate:** `corruptSettingsFile`. It sits in the real `FORBIDDEN_KEYS` set (`user-settings.ts:643-655`, beside `geminiApiKey`, `workspaceRoot` and the upgrade bookkeeping), so a client PUT cannot write or clear it, and it is exposed read-only over `GET /api/user/settings` with a frontend corruption banner. Any task that reproduces that key set — the settings PUT schema, the endpoint routes, the request-controls patch — must include it rather than copying the older list.

**#3192 also added an allowed import cycle** (merged 2026-09-13), `config/resolver.ts` ↔ `workspace/user-settings.ts`, to `server/madge-cycles-allowlist.json`. Read that file on current `main`: `npm run check:cycles` compares against the committed list, so a plan that assumes the older list will either fail the check or hide a swapped cycle. It does not weaken any of this plan's cycle-avoiding leaves — it means a new edge is an explicit allowlist row with a reason, not an assumption.

**Wave 0 is cleared, and its last merge moved these anchors.** #3141's fix, **PR #3192**, merged on 2026-09-13. `origin/main` is now `80be2f1d`, the merge commit. The PR is not small: `analyzer/select-analyzer.ts` (+83/−71), `routes/analysis.ts` (+80/−56), `workspace/user-settings.ts` (+85/−55), `routes/user-settings.ts` (+45), `src/lib/api.ts`, `openapi.yaml` (+72/−36), a new `config/ollama-resolved.ts`, and a changed `server/madge-cycles-allowlist.json`. Wave 1 can now start. Its first task re-reads every citation into those files against post-#3192 `main` (`80be2f1d` or later) and locates each construct by name; the plans stay pinned to `46e62a34`. The anchors below are correct at `46e62a34`; they are a starting point after #3192, not an authority.

**Main advanced past this pin while the plan was being finished, and the pin deliberately stays at `46e62a34`.** `origin/main` reached `4a545750` (merging #3201, which wave 3a lists as a dependency — now discharged — and #3198), and had moved on to `2b6c3f68` by the time this document was committed (133 commits past the branch's original base). The anchor comparison below was made at `4a545750`; re-check by symbol at whatever commit a task is implemented against. Chasing a moving branch would never terminate, so every citation here names the commit it was read at instead. Of the files these plans cite, these changed between `46e62a34` and `4a545750` and should be re-checked **by symbol** when their task is implemented: `routes/script-review.ts`, `routes/user-settings.ts`, `workspace/user-settings.ts`, `config/registry.ts`, `openapi.yaml` (one line), `src/lib/api.ts`, and `analyzer/{errors,index,ollama,select-analyzer,voice-style}.ts`. `routes/analysis.ts`, `routes/cast-design.ts`, `gpu/capacity-retry.ts`, `index.ts`, `failure-taxonomy.ts`, `annotate-emotion.ts`, `instruct-annotation.ts` and `gpu/**` did **not** change, so their anchors above hold at both commits.

Unchanged and therefore still valid as first written: `gpu/capacity-retry.ts`, `tts/sidecar.ts`, `tts/design-lock.ts`, `failure-taxonomy.ts`, `registry.ts:1335-1362`, `escalation.ts:235`, `openapi.yaml`, `analyzer/index.ts`, `annotate-emotion.ts`, `instruct-annotation.ts`, `attribution-eval/review-run.ts`, and the three chunk-budget modules the feature doc pins a fixture against (`stage1-chunk.ts`, `stage2-chunk.ts`, `chapter-chunker.ts`).
