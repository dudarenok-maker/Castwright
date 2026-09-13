# OpenAI-compatible analyzer endpoints and request controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named OpenAI Chat Completions-compatible analyzer endpoints. Give every analyzer engine (Ollama, Gemini, endpoints) consistent controls, all through one stage runner:
- structured output;
- capacity;
- max output;
- reasoning;
- rate limits;
- custom payload.

**Architecture:**
- **Runner:** one stage runner is extracted from `OllamaAnalyzer` / `GeminiAnalyzer`. Each engine becomes a `ChatTransport` (Ollama, Gemini, OpenAI) with a per-transport retry policy that preserves today's behaviour.
- **Per-engine settings:** capacity, output caps and reasoning become descriptors resolved from settings.
- **Endpoints:** stored in user settings with origin-bound keys and a GPU card assignment. The existing analyzer guards and TTS eviction read that assignment.

**Tech Stack:**
- **Server:** Node/Express + TypeScript, Vitest; `openai` npm SDK 7.x over `undici` fetch; `@google/genai` 2.19.
- **Frontend:** Vite/React/RTK.
- **Contract and e2e:** OpenAPI → `src/lib/api-types.ts`; Playwright (mock mode).

**Spec:** [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../specs/2026-09-10-openai-compatible-analyzer-design.md). Read it before any task. Decision numbers D1–D10 and §1–§10 refer to it.

**Regression plan:** [`docs/features/284-openai-compatible-analyzer.md`](../../features/284-openai-compatible-analyzer.md). Issue: #3084.

## How this plan is organised

This file holds what every task needs:
- global constraints;
- decisions made while planning;
- the interface contract;
- the wave → PR map.

Each wave's tasks are in their own file:

| Wave | File | PRs |
|---|---|---|
| 1 — stage runner + Ollama/Gemini transports | [`2026-09-11-openai-compatible-analyzer-w1.md`](2026-09-11-openai-compatible-analyzer-w1.md) | 1a, 1b |
| 2 — capacity, max output, Gemini thinking, reasoning overflow | [`2026-09-11-openai-compatible-analyzer-w2.md`](2026-09-11-openai-compatible-analyzer-w2.md) | 2a, 2b |
| 3 — endpoints (engine ids, keys, OpenAI transport, structured output) | [`2026-09-11-openai-compatible-analyzer-w3ab.md`](2026-09-11-openai-compatible-analyzer-w3ab.md) | 3a, 3b |
| 3 — endpoints (catalog, limits, Test action, GPU, selection, UI) | [`2026-09-11-openai-compatible-analyzer-w3cd.md`](2026-09-11-openai-compatible-analyzer-w3cd.md) | 3c, 3d |
| 4 — persona generation through transports | [`2026-09-11-openai-compatible-analyzer-w4.md`](2026-09-11-openai-compatible-analyzer-w4.md) | 4 |
| 5 — reasoning controls + custom payload | [`2026-09-11-openai-compatible-analyzer-w5.md`](2026-09-11-openai-compatible-analyzer-w5.md) | 5a, 5b |

**Later waves cite earlier waves by symbol, not by line.** Each PR's first task re-reads every cited `file:line` against `main` at the time it starts (all citations are from `main` `46e62a34`). It also runs the `git grep` checks its entry criteria name. A symbol that moved is followed; a symbol that changed shape is reported to the coordinator before the task proceeds.

## Global Constraints

- **Wave 0 gates everything.**
  - Do not start wave 1 until #3139 and #3141 are merged. **State at `4a545750`:** #3139 is discharged — PR #3163 merged 2026-09-11. **#3141 is still OPEN**, and its fix is **PR #3192** (open, "make Advanced Settings own analyzer endpoint and phase models"). That is the one unmet wave-0 dependency; wave 1 waits on it, because #3141 is exactly the bug where Advanced Settings' analyzer-model overrides are silently overridden by Account-tab fields, and every wave here reads those saved per-phase models.
  - Then re-read every `file:line` cited in your wave file against `main` before editing. Both touch `rate-limit.ts`, `select-analyzer.ts`, `user-settings.ts` and the analysing view.
- **Incidental fixes already in flight must be on `main` first.**
  - #3196 (PR #3199, merged `839c65ac`): the attribution eval passes its engine to stage 2. Wave 2's pinning is captured after it.
  - #3200 (PR #3201): removes the retired `analyzer.engine` knob and gates the Advanced Settings Ollama-device row on the saved engine. **Merged** — it is in `4a545750`, so wave 3's assumption is already satisfied.
- **One worktree + branch per PR.**
  - Create it with `node scripts/wt-new.mjs <type>/<scope>-3084-<slug>` off the latest `main`.
  - **Branch names carry the single `server` scope** (the Wave → PR map lists each). `scripts/lib/branch-name.mjs`'s `SCOPE_GROUP` admits exactly one scope, so `wt-new.mjs` refuses a comma branch. PR titles and commit subjects carry the full multi-scope list; CONTRIBUTING's comma form is for commit subjects only.
  - Never work in the primary checkout.
  - Never copy the primary `server/.env` into a worktree (#2345).
- **Commits.** Never use `git commit --no-verify` or `git push --no-verify`. Subjects follow `<type>(<scope>): <subject>` (CONTRIBUTING.md). Dispatched implementers stage; the coordinating thread commits and pushes.
- **Behaviour preservation.**
  - Wave 1 changes no observable behaviour except the `<think>` strip.
  - Every current failure-taxonomy outcome stays.
  - Characterisation tests are written and green on `main` before the extraction they protect.
- **No endpoint is selectable** in any picker, settings default or env-accepted value until PR 3d.
- **Secrets.**
  - Endpoint API keys and the Gemini key are never returned by any GET, never accepted by the general settings PUT, never logged, and never written to persisted analyzer files.
  - Keys are sent only when `new URL(target).origin === storedOrigin`.
- **Custom payload (wave 5).**
  - It is never logged, and never persisted in analyzer files (`inbox`, `rawAttemptPath`, `errorPath`, `persistResponse`).
  - String values of 8 or more characters are redacted from upstream error text before logging or display.
- **OpenAPI is the type source.**
  - Every new or changed wire shape goes `openapi.yaml` → `npm run openapi:types` → commit the regenerated `src/lib/api-types.ts`.
  - Every new endpoint gets a mock in `src/lib/api.ts`. The one exception is Detect, which joins CLAUDE.md's documented local-machine exception list in the same PR.
  - `mockPutUserSettings` keeps an explicit field whitelist; add every new user-settings field to it.
- **Registry knobs** ship with their generated Settings row, `npm run config:sync`, and a paired test. A hand-written `.env.example` entry goes outside the BEGIN/END block.
- **No control is locked pending acceptance (P32).**
  - Every input to the effective chunk size stays user-editable in Advanced Settings or the endpoint form from the PR that introduces it.
  - No task hides, disables, locks or defers a control until an on-box row runs. On-box rows tune defaults only.
- **Wiki upkeep (P33).**
  - A PR that adds or changes an Advanced Settings knob updates the matching section of `docs/wiki/Advanced-Settings.md` in the same PR. `scripts/tests/knob-docs-sync.test.mjs` (#2012) already fails when a knob's label has no row there.
  - The same guard asserts the "— N knobs across M groups" count in `Advanced-Settings.md:14` ("117 knobs across 12 groups" at `46e62a34`). A PR that adds or removes a knob updates that count: 2b adds two knobs and 3d one.
  - The wiki is published by `npm run wiki:sync` (`scripts/sync-wiki.mjs`) after merge. That is a manual step, and the PR's post-merge checklist says so.
- **A new `FailureCode` touches all six places:**
  1. the union in `server/src/routes/failure-taxonomy.ts`;
  2. `failure-remediations.ts`;
  3. the sorted key list in `failure-taxonomy.test.ts`;
  4. the `openapi.yaml` `FailureCode` enum;
  5. the regenerated `api-types.ts`;
  6. `src/data/help-failures.ts` (`CATEGORIES` and `TITLES`).

  The help-count assertions (currently 23 and 49) move with each code.
- **Transport tests use a real HTTP server.**
  - Use `http.createServer` on `127.0.0.1:0` and a real undici `Agent`, following `server/src/analyzer/ollama-timeout.test.ts`.
  - No `vi.mock('undici')` and no stubbed `fetch` for any timeout, abort or unreachable case.
  - Connect-timeout tests never use port 9, which undici rejects as a "bad port".
- **Stop-the-run errors.** Any per-chapter or per-pass catch a later wave adds must rethrow `AnalyzerReasoningOverflowError` wherever the route rethrows `GeminiContentBlockedError` (P20).
- **Import cycles.** New analyzer modules import `StageCall` and other analyzer types from the leaf `server/src/analyzer/types.ts` (wave 1), never from `server/src/analyzer/index.ts`. Madge counts type-only imports as cycle edges (`npm run check:cycles`).
  - **The baseline is a committed list, and it moves.** `server/madge-cycles-allowlist.json` is checked as a list of cycles, not a count. Wave 0's open PR #3192 **adds one** (`config/resolver.ts` ↔ `workspace/user-settings.ts`), so re-read the file after that merge rather than assuming this plan's picture of it. Every leaf this plan introduces to dodge a cycle — `transports/allowlisted-fetch.ts`, `known-secrets-gate.ts`, `resolveEndpointApiKey`'s structural parameter, and validating request controls in the PUT route instead of `writeUserSettings` — stays required: a new cycle is a deliberate allowlist row with a reason, never a silent edge.
- **Mutation proofs.** Every test that guards a mechanism gets one in its task: revert the guarded line, show the test go red (output in the PR), restore.
- **Pinning and characterisation values are captured from `main`,** never computed by hand.
- **`openai` SDK.**
  - Use `openai@^7.15.0` in `server/package.json`.
  - Always pass `fetch: undici.fetch` from `server/node_modules/undici`, plus `fetchOptions.dispatcher`.
  - Set `maxRetries: 0`.
- **Model ids.**
  - Format: `openai:<endpointId>::<model>`, where `endpointId` matches `^[a-z0-9-]{1,40}$`.
  - Inference order: `^openai:[a-z0-9-]+::` → `openai`; contains `:` → `local`; else `gemini`.
  - The inference applies only where a selected model id is handled. Ollama tag-list sites keep their own handling.
- **Defaults** (from the spec):
  - **Structured output:** Ollama `schema`, Gemini `json`, endpoints `schema`.
  - **Reasoning:** Ollama `off`, Gemini and endpoints `model-default`.
  - **Endpoint concurrency:** `1`.
  - **Endpoint `requestCeilingMs`:** `1_800_000`.
  - **Endpoint `gpu`:** `any` for host `localhost` / `127.0.0.1` / `::1` / `[::1]`, else `none`.
  - **Endpoint `maxOutputTokens`:** `0` (Auto).
  - **Gemini built-in fallback limits:** 5 rpm / 100k tpm / 50 rpd.
  - **Fallback target:** `gemini` (P30).
  - **Gemini thinking window:** automatic = 120 000 ms for thinking models (P5).
  - **Endpoints:** unlimited.
- **Each PR** does all of these:
  - adds an entry to `docs/release-notes-next.md` and to the in-progress section of `RELEASE_NOTES.md` (skipped only for a PR with no shippable delta, stated in the PR body);
  - links `Refs #3084` (PR 5b uses `Closes #3084`);
  - runs the `pr-review-gate` skill before merge.
- **On-box acceptance** rows go into:
  - `docs/testing/onbox-acceptance-register.md`;
  - the run sheet `docs/testing/3084-openai-analyzer-onbox-acceptance.md`;
  - the live view `docs/testing/onbox-acceptance-register-live-view.html`.

  All three change in the shipping PR, per CLAUDE.md Before-shipping step 3. Row ids are minted from each group's `next-id` marker at ship time, never written into a task in advance.

## Decisions made while planning

None changes a spec decision, except the owner's 2026-09-13 review (F1–F7), which the spec now carries: P30–P34 are new, P9 is retired, and P5, P10, P20, P25 and P27 were updated. Each settles a detail the spec left open, or records a fact verified during planning. Where the spec needed correcting, it has been corrected (see its "Verified during planning" section).

| # | Decision | Why |
|---|---|---|
| P1 | Endpoint unloads are gated per card, and Ollama's gate is unchanged. An endpoint whose `gpu` is not `none` is busy on a card (its `gpu` card, or every card for `any`) while any analyzer run using it is active or any call to it is in flight. That busy state is re-checked immediately before each unload POST. Ollama eviction keeps today's gate with its text unchanged, read before each `evictOllama()`. The endpoint lever is separate: its own latch, set only by a 2xx unload, reached only on an iteration where Ollama was not evicted. | A per-call check reads the gap between chunk calls as idle, and a single check before several sequential POSTs goes stale. A remote endpoint shares no card. |
| P2 | `withTransportRetry` for an endpoint uses `maxTotalMs = endpoint.requestCeilingMs`. Its idle watchdog is `resolveStreamIdleTimeoutMs()` (45 s), armed after the first delta. | Local servers can take minutes before the first token; after that, 45 s of silence between tokens is a stall. |
| P3 | `{model}` in an unload URL is replaced by each model whose request was sent to that endpoint since server start: an in-memory set, one POST per model. Runs, Tests and requests that then fail all count; only one aborted while still queued does not. A model leaves the set once an unload POST for it answers 2xx or 404 (an all-models URL's 2xx clears the endpoint's set), so the set tracks what the server may still hold. An endpoint with no such model is skipped. | A single last-used model is retargeted by a Test click or a queued call, and misses the second model of a phase-0/phase-1 split on one endpoint. Persisting per call would write settings per request. |
| P4 | Reasoning deltas (`reasoning_content`, `reasoning`, non-empty `reasoning_details`) and Gemini thought-only chunks call `onChunk` with an unchanged byte count. | Keeps the analysis route's silence warning from firing during a long think (`analysis.ts:1184`, `:4417-4423`). |
| P5 | **Approved by the owner 2026-09-13** — no probe gate; thinking window default 120 s, adjustable in Advanced Settings. | Two review passes showed a probe cannot be made representative: request size, phase and the model's think length all change the answer, and a verdict table can drift from its evidence. |
| | **Thought summaries:** thinking models (P27's static id rule) request them. | |
| | **Thinking window:** `analyzer.gemini.thinkingIdleTimeoutMs` (env `GEMINI_THINKING_IDLE_MS`) bounds every silent gap until the first answer text: the first chunk, and each gap between thought parts. Default `0` = automatic: 120 000 ms for thinking models, today's idle window for others. Maximum 290 000 ms, because the SDK's global `fetch` carries undici's fixed 300 s timeouts. After answer text starts, today's 45 s idle watchdog applies. | |
| | **Advanced Settings:** the knob keeps its range (integer 0–290 000), its Advanced Settings row, `.env.example` line and `config:sync`. Help text: "Automatic = 2 minutes for thinking models. Raise it if long thinks time out; maximum 290 seconds." | |
| | **On timeout:** before answer text, a timeout raises `AnalyzerTimeoutError` (`analyzer-timeout`, copy names the setting). It is not retried and no retry is logged or announced. | |
| | **Ceiling:** `analyzer.gemini.requestCeilingMs` (30 min) bounds every request. | |
| | **Logging and tuning:** the transport logs time to first chunk, time to first answer text, and thought parts before the answer. A wave 2 on-box row measures them on real chapters, without gating the wave. The measurement informs a later default change within the maximum; it never changes the default by itself. | |
| | **Trade-off:** a stalled request on a thinking model (every Gemini 3.x, including the default `gemini-3.5-flash-lite`) fails once after up to 2 min, instead of two 45 s attempts. The phase card shows "Stalled" meanwhile. In return, a think that stays silent, or streams summaries, for up to 2 min at a time is not killed. | |
| P6 | An Ollama `done_reason: 'length'` finish with an empty answer follows the same rule as the other engines (split, or reasoning overflow when there is reasoning evidence) instead of today's empty-response error. Ollama's overflow copy names `num_ctx`, which is the binding limit; `num_predict` is already unlimited by default. | Spec §7's rule is engine-independent. Today's ordering (`ollama.ts:829` before `:838`) is why an empty cap-limited Ollama response never split. Wave 2 announces it. |
| P28 | Ollama's unreachable failures keep `main`'s taxonomy outcome, copy and detail exactly (the signature scan over `LocalUnreachableError`'s message). The `instanceof AnalyzerUnreachableError` → `analyzer-unreachable` mapping applies to endpoint errors only. | A mistyped host must keep showing `Ollama at <url> is unreachable (ENOTFOUND)`. A reachable daemon that resets before the first byte must not be told it is down. The pass-1 decision recorded "Ollama outcome unchanged". |
| P26 | Every `prepare()` warm-up is bounded at 10 s: the Gemini catalog (via the SDK's `httpOptions.timeout` plus an abort signal) and endpoint served limits. A warm-up that times out or fails lets the request proceed with fallback limits. The caller's abort signal releases that caller; the shared listing is cancelled only when no caller still waits. | A warm-up runs before the limiter, ceiling and watchdog. An unbounded one would hang every concurrent request behind one stalled listing, and pause could not interrupt it. |
| P29 | Custom payload values are not a place for credentials. Settings help says so, and names the endpoint key field for credentials. Payload redaction (P22) is defence in depth, applied only to errors from requests that carried that payload. | Payloads must be editable, so GET returns them to authorised devices. Redacting every payload string everywhere would blank ordinary words such as `BLOCK_NONE` in unrelated errors. |
| P27 | `geminiModelThinks(model)` uses a static id rule, never the live catalog's `thinking` flag, to decide a model's default. From wave 5, `geminiRequestThinks(model, level)` decides per request: a level that turns thinking on (Gemma `on`) makes a thinking request, with thought summaries and the thinking window, and a level that turns it off makes a non-thinking one. The same settings always give the same request shape. Gemma is outside the rule, so at its default level and at `off` it gets no `includeThoughts`, no `thoughtsTokenCount` counts as evidence, and its empty `MAX_TOKENS` keeps the #528 split recovery. Gemma at `on` is a thinking request like any other (G1): wave 5 adds `includeThoughts` (P19), its thought tokens are reasoning evidence, and an empty `MAX_TOKENS` there is a reasoning overflow (P6, P20), not a split. On every Gemini request, stage or free text, `thoughtsTokenCount` counts only when the wire sent `includeThoughts`: one flag decides both (A3). | Otherwise the answer would flip whenever a catalog warm-up failed. `includeThoughts` on Gemma is unconfirmed: wave 5a's Group E row checks the `on` Test step, and if the API refuses it, the `on` fragment drops `includeThoughts` and keeps `thinkingLevel: HIGH` (the thinking window still applies). Counting Gemma's `thoughtsTokenCount` as evidence at its default level could turn its split recovery into a run stop. |
| P21 | The OpenAI transport treats a failure as unreachable only for a connection-level error: `APIConnectionError` or its timeout subclass, or a non-`APIError` transport error raised before `create()` resolved. Even then, only connect-phase codes count: `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`. A reset or DNS hiccup before headers (`ECONNRESET`, `UND_ERR_SOCKET`, `EAI_AGAIN`) is an `AnalyzerStreamIncompleteError`: retried, never a fallback. Any `APIError` carrying an HTTP status is an `AnalyzerHttpError`, whatever its body says. | The SDK throws HTTP status errors from `create()` after the response arrives, and copies the body's `error.code` onto the error. A proxy's 502 with `code: "ECONNREFUSED"` would otherwise read as unreachable and silently fall back to Gemini. |
| P22 | **Headers:** the OpenAI client's `fetch` wrapper sends a fixed set: fixed `accept`, `content-type` and `user-agent` values, no `x-stainless-*` headers, and `Authorization` only for the endpoint's own key under the origin rule. **Keys:** a key containing any control character is refused at write. **Redaction:** known secrets (endpoint keys, the Gemini key, and in wave 5 payload values) are redacted where errors are built in all three transports, in endpoint routes (Detect, preview, key write), and in `classifyAnalysisFailure`'s `unknown` fallback. **No raw errors:** an error the transport rethrows is rebuilt as our own class with a redacted message that names the sanitized `causeCode` (for example `ERR_SSL_WRONG_VERSION_NUMBER`), never carrying the raw SDK error as `cause`. The run failure, the log and the Test action all show that code. | The SDK merges the host's `OPENAI_CUSTOM_HEADERS` after the auth header, so any `Authorization` set there would replace the endpoint key. Redacting only in a few classifier branches leaves 5xx and other statuses unredacted in SSE messages, saved chapter errors and logs. |
| P23 | Until PR 3d, the general settings PUT, the phase-model knobs and env refuse `openai:` ids; `getResolvedOllamaModel` ignores one from `OLLAMA_MODEL`. Selection maps a stray one to `analyzer-endpoint-missing`, never a silent Ollama run, and every selection call site (analysis phase 0, subset, phase 1, annotate-emotion, instruct-annotation, script review) catches any analyzer error selection throws and reports its classified code (`analyzer-endpoint-missing`, `auth` for a key-origin mismatch, and so on), so no selection error ends a stream uncoded. Until 5a/5b, endpoint routes refuse a non-default `reasoning` and a non-empty `extraParams`. | The model and phase fields are plain strings, and values saved before wave 5's checks exist would bypass them permanently. |
| P24 | Endpoint Auto output sends `max_tokens = min(served output limit if known, contextTokens − estimated input − max(1024, 10% of contextTokens))`. A 400 whose message names a token limit points to the endpoint's max-output setting. | The input size is an estimate, not a tokenizer count, and strict servers (vLLM) reject prompt plus `max_tokens` above the served context. |
| P25 | Endpoint entries are parsed one by one when settings load. An invalid entry is dropped from the loaded settings and never resets the file.
- **Scope (re-verified by reading `46e62a34`):** this covers **schema** failures on individual entries — the whole-file fallback at `user-settings.ts:522-525`. An unparseable `user-settings.json` is a different path and does **not** reject: `performUserSettingsRead` recovers it from its `.bak.N` backups, and when the file and every backup are unreadable it warns once and returns in-memory defaults with `corrupt: true` (`:479-498`). `readUserSettings` rejects only when `readFile`/`stat` itself fails or the legacy-settings migration fails. `dropInvalidEndpointEntries` sits **inside `performUserSettingsRead`** (`:472-530`), after the JSON parse and the eager-load migration and before the whole-file schema parse (`:522`) — it extends that shipped function rather than replacing or wrapping the read path, and changes nothing about the malformed-file path. Dropping an entry therefore never sets `corruptSettingsFile`: that flag means the file itself was unreadable and was recovered, and a dropped entry is reported by its own warning naming the archive file instead. Before any later write can persist the drop, the entry is appended to `user-settings.invalid-endpoints.json`, and the warning names that file.
- **Concurrent reads:** the cold settings read is single-flight — satisfied by PR #3195's shipped `inFlightRead` (`:438`), so the plan adds no wrapper of its own.
- **Marking:** an entry is marked archived only after its append succeeds.
- **Append failure:** a settings write never refuses because an append failed. It writes the unarchived entries back to the file raw, unchanged, so nothing is lost and saving still works; the append is retried on the next read.
- **Save validation (F5):** endpoint create/update, the key write and the settings PUT validate every endpoint field before writing (server 3b, UI 3d).
  - A malformed entry is refused with HTTP 400 `{ error, code, issues: [{ path: string[], message }] }`, with `path` as an array of segments; issue messages are field-aware templates with units, never raw zod text, and never echo a key or a field value.
  - The UI shows each issue inline next to its field. The account-slice endpoint thunks reject via `rejectWithValue({ error, code, issues })`, so `.unwrap()` keeps `issues` for that display.
  - Nothing is written, and nothing is silently dropped at save.
- **Visible drops (F5):** an entry dropped at read is listed read-only on `GET /api/user/settings` as `droppedEndpointEntries` until acknowledged, and 3d shows it as a banner (P31). The read-time safety above is unchanged.
- **Keys:** dropped key entries are archived with their origin only, never the key. An OpenAI answer that has a `finish_reason` counts as complete even if the idle watchdog fires, or the socket drops, before `[DONE]`. Detect builds `props` relative to the base URL with a trailing `/v1` removed, keeping any reverse-proxy path prefix. | `readUserSettings` replaces the whole file with defaults when any field fails the **schema** (`user-settings.ts:522-525`), including the saved Gemini key. A malformed file takes a different path — backup recovery, else defaults with a corruption flag — so this decision is about schema failures on individual entries. A finished answer must not be retried away. `new URL('/props', base)` drops a proxy's path. |
| P20 | **Approved by the owner 2026-09-13** — stop new spend, with a loud, actionable warning (F7; see the sub-row below and P34). A reasoning-overflow failure ends the analysis run, as `GeminiContentBlockedError` does (`analysis.ts:4550`, `:7149`; stage 2 through `runPhase1Pool`'s terminal handler), and the job starts no new model calls after it. **Alternative considered, not chosen:** skip the chapter and continue, which keeps chapters that fit (an overflow need not recur on the next chapter) but can spend a full thinking budget on each chapter that doesn't. It also stops a script-review pass, as a content block does (`script-review.ts:924-987`).
- **In-flight chapters:** they finish and cache for resume, as the pools are designed to (`analysis.ts:5672-5675`). The job is not aborted, because aborting would discard work a resume must redo, including another phase's model in pipelined mode.
- **Output-heavy passes:** the emotion and instruct passes stop on overflow as they do for a daily-quota error (`annotate-emotion.ts:243-259`, `instruct-annotation.ts:242-258`).
- **Attribution eval:** it rethrows (`attribution-eval/review-run.ts:130-136`).
- **Escalation and non-story classification:** after an overflow, the job starts no further escalation windows (up to 120 per chapter, `registry.ts:1335-1362`) and no further non-story classification calls (`analysis.ts:5831-5833`). A single escalation call that overflows still returns `null`, but it also marks the job through `StageCall.onReasoningOverflow`.
- **Marked jobs:** the chapter pools check `job.reasoningOverflowed` before dispatching each chapter. A marked job starts no further chapters and ends with the overflow code, whether the overflow came from a stage call or from escalation.
- **Attribution eval:** it has no job, so only its review pass rethrows. Its escalation windows are not stopped; it is a developer tool.
- **Voice design:** P20 covers analysis runs and their passes. In a voice-design job, today's behaviour is kept — and on `46e62a34` that behaviour is **per character on both persona paths**:
  - **Pre-pass:** persona errors are recorded per character (`cast-design.ts:320-334`).
  - **Lazy path:** per character too. `6222e483` (second half of #3027, follow-ups `b8b12be5`, `f3d3a341`) wrapped the lazy `generateVoiceStylePersona` + `writeVoiceStylePersona` pair in its own try/catch (`cast-design.ts:525-543`): a failure pushes to `job.failures`, broadcasts `character_failed`, and `continue`s to the next character. It no longer reaches the route's job-wide backstop (`:908-936`). `ensureCharacterVoiceUuid` moved inside the per-character ride-out `try` in the same change (`:713-721`).
  - **A reasoning-overflow persona failure takes that same per-character path,** so an overflow in a design job fails one character and the job carries on. That is deliberate: P20's "stop new spend" rule governs analysis runs, and this bullet is the voice-design carve-out that keeps today's behaviour.
  - **What that path records is a string, not a code:** `itemFailureReason(e, e.message)` (`workspace/file-lock.ts:183-185`) returns the curated lock-contention sentence for a `LockAcquisitionTimeoutError` and the raw message otherwise. `character_failed.errorReason` and `job.failures[].error` carry it; no `FailureCode` is recorded on this path, and wave 4 does not add one (W4's Failure-codes bullet says what it does instead).
  - **That catch is unconditional, so it also swallows an abort.** Once wave 4 hands the job signal to the lazy call, a pause would be recorded as a `character_failed` unless the catch tests `job.controller.signal.aborted` first; the loop's own abort check (`:388-389`) would then end the job `idle` carrying that spurious failure. Wave 4 adds the check — see its Cancellation bullet.
  - **No owner decision is owed here.** #3230 asked whether the lazy path should continue per character; `6222e483` makes it do exactly that. The issue is still OPEN but looks resolved by that commit — verify and close it outside this plan; do not treat it as a blocker for wave 4. | The same settings overflow again on the next chapter, and each attempt spends a full output budget of thinking on a 20-requests-per-day model. The fix is a setting change. The alternative, skipping the chapter and continuing (today's handling of non-blocked per-chapter errors), keeps any chapters that fit. The `fatal` taxonomy flag does not drive analysis, so this is a code decision, not a flag. |
| | **Loud, actionable warning (F7):** the failure names the chapter, the model and the engine or endpoint, and says the model spent its whole output budget thinking and gave no answer. Its `remediation` ends "then resume — finished chapters are kept". It carries structured `fixes` that deep-link the settings to change, rendered as a "How to fix" list with a notification that survives navigation. The thinking window is never offered. Mechanics, guard test and staging: P34. | Owner rule: stopping is right only if the user is loudly told what happened and how to proceed. |
| P7 | The Test action runs requests as a ladder, each differing from the previous in one field. Wave 5 adds the level step. | A probe that differs from the control in prompt or cap makes a cap-induced 400 read as `schema rejected`, which refuses runs permanently. A trivial cap makes thinking models end `length` and record nothing. `json` mode is rejected by some servers (LM Studio). No level may be recorded that was not sent. |
| | **Steps:** control (`off` mode, engine default level) → level (`off` mode, configured level) → mode (configured mode, configured level). | |
| | **Prompt and cap:** every step uses the same probe prompt, with the schema step's marker-key schema, and the same output cap (the model's resolved Auto cap, clamped to context minus estimated input). | |
| | **Control and level steps:** they prove acceptance only, so each passes whenever the provider accepts it, even when it stops with `length`. A control failure reports `failed` and keeps any previous record. | |
| | **400:** a 400 on a later step records that step's field `rejected`, unless the provider message names a context, token or length limit. That case is inconclusive. | |
| | **Inconclusive:** a 5xx, timeout or `length` / `blocked` finish on a probe is also inconclusive. Inconclusive saves nothing and returns 502. | |
| | **Record keys and aborts:** records are keyed by the level actually sent. The route passes the client's abort signal. | |
| P8 | `tpm: 0` in `analyzerRateLimitsByModel` means unlimited, matching the retired `rate.*.gemma*` knobs. Saved gemma overrides are copied into the map when settings load, without failing the load. | Keeps saved overrides meaningful after the knobs are removed. |
| P9 | **Retired 2026-09-13:** the owner's review (F2) drops the Gemini 2.5 `thinkingBudget` level control. Gemini 2.5 ids get `model default` only, the same as unknown ids. Nothing sends `thinkingBudget`, and a test pins that no Gemini request carries it. The row id stays so references do not dangle. (It was: 2.5 budget tiers off/low/medium/high = 0/1024/8192/24576, with no `minimal`.) | The owner directs focus to the current 3.x Flash family (3.5, 3.6, 3.7 and 3.8 Flash, plus the shipped Flash-Lite ids). 2.5 is legacy, and the budget branch is code and tests for a family Google is retiring. |
| P10 | A new knob type, `'analyzer-engine'`, modelled on `'device'`, with a literal id regex in the registry. It is introduced in **3d** for `analyzer.fallback.target` (P30), and wave 4's persona engine knob reuses it. Each knob keeps its own literal id regex; only the fallback knob's regex admits `off`. | A plain string knob would render as a free-text box; `registry.ts` must stay pure data (`registry-imports.guard.test.ts`). Moved from wave 4 to 3d on 2026-09-13 (F4), because the fallback target needs it first. |
| P11 | Readiness checks gain an `endpoint-missing` BlockerCause, so a saved `openai` engine does not demand Ollama (`setup-diagnosis.ts:323`, `setup-readiness.ts:204`). | Otherwise setup would report a missing Ollama for an endpoint user. |
| P12 | Saving an unload URL without `{model}` succeeds, with a warning that it unloads every model on that server, including another card's. | It is valid for a single-model server, but on a shared llama-swap it evicts across cards. Blocking would break the single-model case. |
| P13 | `Layout` hydrates the config slice on mount, as it already does for account settings, so the GPU guards and the generation hold know the TTS card in every session; and the sidecar's reported device resolves an `auto` knob (a resident Qwen's card, or CPU); only a `cuda` family with no card index stays unknown. | Today the config slice loads only when Advanced Settings is opened. Without it the TTS card is unknown and every GPU endpoint prompts. |
| P14 | Pre-run checks, and the digest read they need, run only when a new job is created, after the rejoin path. A live-job re-check follows the read, with no `await` before registration (#3004). They use the same selection resolution as the job (`resolvePhaseModelSelection`). A selection failure maps to a coded failure. | Checking before rejoin refuses a reload of a live job. A check that classifies ids differently from selection passes and then fails without a code. |
| P15 | Endpoint served output limits are warmed at run start through the transport's `prepare()`, cached per base URL with a TTL. A run never depends on a catalog having been opened. Context stays the saved `contextTokens` (spec §6). | Otherwise the same run gets different caps depending on UI history, and limits from an old base URL leak into a new one. |
| P16 | A Gemini payload is an **allowlist** of `config` keys: `temperature`, `topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `seed`, `safetySettings`. Any other key is refused. | The installed SDK applies `config.httpOptions` (`baseUrl`, `headers`, `extraBody`, `retryOptions`) per request. A denylist that misses it lets a payload send the API key to another host or reinject any protected field. |
| P17 | `mergeExtraParams` re-applies the protected-key and owned-container rules at run time. A stored reasoning level the table no longer offers refuses the run before its first call, with a coded failure. Settings are read per call, so a level saved during a run applies from that run's next call; every save is validated, so that level is offered. A value no save can produce (a hand-edited file) that reaches a call mid-run fails that call with `AnalyzerReasoningUnavailableError(…, 'mid-run')`, coded `analyzer-request-rejected`, instead of before the run (N10). | Save-time checks alone don't hold. Settings load leniently, so a value saved before a rule existed would otherwise reach the wire or fail mid-run with no code. |
| P18 | Ollama reasoning is stored per model (`analyzerReasoningByEngine.ollama: Record<modelId, ReasoningLevel>`, default `off`). A named level can be saved only with that model's accepted Test record. Persona generation uses its own model's entry. | Test records are per model, and Ollama returns 400 for `think` on a model that doesn't think. One shared value would send a level accepted by one model to another. |
| P19 | Test probes include the configured payload. A payload output cap (`max_tokens`, `max_completion_tokens`, `options.num_predict`, `config.maxOutputTokens`) becomes the cap that chunk sizing and the overflow rule use. Gemini free-text requests omit `thinkingConfig` until wave 5 applies a non-default level. `includeThoughts` accompanies any Gemini stage request that thinks, by model default or by level, and a free-text request only through a level that thinks. A persona (free-text) request drops the payload's output-cap keys (`payloadOutputCapKey`'s set) before the merge and keeps its own output length; its other payload keys apply (A4). | A record must describe the request a run sends, the wire and the budget must agree, and persona requests keep today's shape. |
| P30 | **Fallback target in Advanced Settings (owner, 2026-09-13, F4).** | The owner wants fallback optional and its destination chosen. The legacy read keeps a strict-local user strict-local with no migration. Refusing self, keyless and missing targets keeps a fallback from failing in a second, confusing way. |
| | **Knob:** `analyzer.fallback.target` (env `ANALYZER_FALLBACK_TARGET`), group `analyzer-models` (wiki §4 "Analyzer models & endpoints"), type `'analyzer-engine'` (P10). Values `off` / `local` (`getResolvedOllamaModel()`; the Settings row shows the concrete model and warns if it isn't installed) / `gemini` (the resolved `GEMINI_MODEL`, needs a key) / `openai:<endpointId>::<model>`. Default `gemini`. | |
| | **Resolution:** `resolveAnalyzerFallbackTarget()` (`server/src/analyzer/fallback-target.ts`, 3d): env → saved override → legacy, only when the knob's source is `default`: `getResolvedAllowCloudFallback() === false` → `off` → default `gemini`. That is the saved `allowCloudFallback === false`, or, before the first settings read, the existing env `ANALYZER_ALLOW_CLOUD_FALLBACK=0`. There is no write-migration. `allowCloudFallback` stays in the schema (`user-settings.ts:148`), read only for that step, and nothing writes it any more. Model Manager's "Cloud fallback" row (`src/components/model-settings-form.tsx:505-519`) is removed, and the "Analyzer engine" sublabel (`:493`) points to Advanced Settings → Analyzer fallback. | |
| | **Semantics:** one global target, one hop; the fallback analyzer is never wrapped. It triggers only on `AnalyzerUnreachableError` from an Ollama or endpoint primary; a Gemini primary never falls back. Classification is unchanged (P21, P28), and `AnalyzerTransportError` never falls back. `fallbackSelectionFor(primary)` (`server/src/analyzer/index.ts`, 3d) returns `null` when the target is `off`; is `local` with a `local` primary (never wrapped, whatever the models); equals an endpoint primary; is `gemini` with no key; or names a missing endpoint. That last case logs a warning, and the runtime is authoritative for it: an endpoint deleted after the save is skipped; `selectAnalyzer` wraps with `FallbackAnalyzer(primary, target)` only when it is non-null. `findEndpointReferences` counts the knob. | |
| | **Activation:** the target runs with its own limiter, concurrency, key-origin check and capability check; a capability refusal fails the call naming the target. A GPU-bound target (`local`, or an endpoint whose `gpu` is not `none`) takes the same in-flight and run busy marks a primary would, only once fallback activates; a switch after the job's release has run takes no mark. After a switch, later chunking uses the target's capacity, and phase-1 events carry the target engine. Up to K chapters (the pool width, default 2) can already be sized for the primary, so before routing any call to the target `FallbackAnalyzer` checks the prompt's estimated input against the target's capacity. The check covers every analyzer call a fallback can serve. Passes that split on `AnalyzerTruncatedError` (stage 1 chunks, stage 2, script review) get it thrown, split the chunk and retry on the target. Passes that cannot split (emotion annotation, instruct annotation, attribution escalation, non-story classification, whole-book stage 1) fail that call with `AnalyzerTargetInputTooLargeError` (→ `analyzer-request-rejected`, own copy naming the fallback target and its input limit; not an `AnalyzerTruncatedError`, not retried), never a silently truncated prompt. Non-story classification keeps its story default on this error but logs a warning naming the target. Only a switch to a smaller-context target can trigger this, and #3084's configurable fallback introduces that case, so nothing regresses and a visible failure beats corrupted analysis. `onFallback` names both the primary and the target. If the target is also unreachable, the run fails naming both. | |
| | **Announced behaviour changes (3d):** "never silent" is now literal. On `46e62a34` five `FallbackAnalyzer` methods fall back without calling `onFallback` (`runStage1`, `runEmotionChapter`, `runStage3Chapter`, `runAttributionEscalation`, `runNonStoryClassification`); from 3d all eight announce, through one private `switchTo`. The switch note renders the server's `fallbackReason` (`fallbackReasonFor`), which names both: `Ollama unreachable (<model>) — switched to <target>`, or `Analyzer endpoint unreachable (<endpoint name> · <model>) — switched to <target>`, replacing the note `Switched to Gemini — Ollama unreachable`. Script review's warm-fail copy "Or turn on Cloud fallback in Settings → analyzer to use Gemini when the local analyzer is unavailable." becomes "Or choose an analyzer fallback in Advanced Settings → Analyzer fallback." Each change is announced in the release notes, which also say Gemini is the default fallback for endpoint users, and (3d) that a fallback to a smaller model splits or clearly fails oversized requests instead of truncating them. | |
| | **Save validation:** a target naming a missing endpoint, or `gemini` with no key saved, is refused at save with a message. The Advanced Settings row shows the effective target, including a legacy `off`, and reads "Gemini — no API key, fallback inactive" when the target is `gemini` with no key. | |
| | **Unchanged:** persona generation never falls back (`registry.ts:1185`). Before 3d, today's Ollama → Gemini rule under `allowCloudFallback` (`index.ts:216`) is untouched. | |
| | **Privacy help (3d):** the "Is my data private?" topic (`src/data/help-topics.ts:337-340`) says only the optional Gemini analyzer can send chapter text off the machine. 3d rewrites it to name every path by which text can leave the machine: a remote analyzer endpoint, Gemini analysis, a fallback target once it activates, and Gemini TTS when chosen (`server/src/tts/gemini.ts`). | |
| P31 | **Dropped endpoint entries are visible, and acknowledged (F5).** Saves validate first (P25). | Owner rule: a malformed entry must be in the user's awareness and control, not only a log line. Archiving keeps P25's read-time safety; the acknowledge record stops the banner repeating for an entry the user has seen. |
| | **Exposure (3b):** `GET /api/user/settings` returns `droppedEndpointEntries: DroppedEndpointEntrySummary[]`, read-only and in `FORBIDDEN_KEYS` like `corruptSettingsFile`. `issues` are `path: code` strings from the schema, never values; key entries carry the origin only, and `name` is capped at 80 characters. `listDroppedEndpointEntries()` in `user-settings.ts` supplies it. An entry whose archive append has not yet succeeded (P25's append-failure path) is still listed, with `archiveId: null`, because the user must still be told; it cannot be acknowledged until archived. | |
| | **Acknowledge (3b):** `POST /api/user/settings/dropped-endpoint-entries/acknowledge` (operationId `acknowledgeDroppedEndpointEntries`, body `{ archiveIds: string[] }`) calls `acknowledgeDroppedEndpointEntries(archiveIds)`, which records those ids in a sidecar file, `user-settings.invalid-endpoints.acknowledged.json` (`droppedEndpointEntriesAcknowledgedPath()`), beside the archive. The archive stays append-only and is never rewritten; each archive record gains `archiveId` (a UUID) and a server-only `contentHash`. So the same unchanged entry is archived once and stays acknowledged across restarts, while a changed or new entry shows again. A key row's `contentHash` covers only the origin-only projection plus the endpoint id, never the key. So a changed but still-malformed key under the same origin stays acknowledged; that is accepted, so that no key-derived material is ever on disk. Acknowledgement is serialised. A `null` or unknown id is ignored, not refused. Acknowledged entries are no longer listed. OpenAPI schema, regenerated `api-types.ts` and mock-mode counterparts ship with it. | |
| | **Banner (3d):** Model Manager → Analyzer endpoints, and Advanced Settings' analyzer section, list each unacknowledged dropped entry: its name or id, what was wrong, that it was removed to protect the rest of the settings, and that a copy was saved to `user-settings.invalid-endpoints.json`, "next to `user-settings.json` in your workspace folder". It never shows an absolute path: the GET carries none, and an absolute workspace path must not reach a LAN client (the same reasoning as CLAUDE.md's lock-timeout rule). "Got it" acknowledges; a changed or new entry shows again. The `console.warn` stays. Before 3d there is no UI, which is acceptable because endpoints are not selectable. | |
| P32 | **Chunk-size inputs are never gated on on-box acceptance (F1).** Every input to the effective chunk size stays user-editable before any on-box row runs: Advanced Settings → Analyzer chunking (`analyzer.stage1.chunkCharBudget`, `analyzer.stage2.chunkCharBudget`, `analyzer.stage1.localInputFraction`, `analyzer.stage2.localInputFraction`, `analyzer.gemini.outputHeavyChunkChars`); Advanced Settings → LLM sampling (`analyzer.gemini.maxInputTokensPerRequest`); `analyzer.ollama.numCtx`; and per endpoint `contextTokens` and `maxInputTokensPerRequest`. No task hides, disables, locks or defers one pending acceptance. Defaults stay byte-identical until measured, and the pinning test is unchanged. Help text on those knobs and the two endpoint fields says how the effective budget is derived for its family: context family, min(input fraction × context tokens × 2 chars/token, the pass ceiling); request-cap family, `cloudBodyCharBudget` at min(max input tokens per request, the model's TPM limit), bounded by the pass ceiling. It is written in 2a and extended for endpoints in 3c. **Max lifted:** `analyzer.gemini.maxInputTokensPerRequest` has `max: 60000` today (`registry.ts:71-79`), lifted to `1_000_000` in 2b. The default stays 12000; its help text (which names "Gemma free tier = 16000/min") keeps the TPM guidance true, and every derived artifact the registry rules require moves with it. | The owner accepts unmeasured defaults as long as the user can override them. 2b's TPM bound (`perRequestInputCap = min(knob, TPM)`) now protects the request, and a 60 000 ceiling blocks larger chunks on Gemini 3.x (1M-token input). |
| P33 | **A dedicated wiki page for endpoints (F3).** `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` is written in 3d, extended in 5a (reasoning style per server) and 5b (custom payload examples per server), to the outline in the spec's Documentation section. It has one setup section per server: llama.cpp (llama-server), llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter. **Acceptance criterion:** every example is verified at implementation time against that tool's current documentation, and against the planning-facts probe findings where they exist, and each example block records the tool version it was checked against; no invented flags or URLs. **Linked from:** `docs/wiki/_Sidebar.md` (Full breadth), `Analysis-and-the-Analyzer.md` "Choosing an analyzer", `Advanced-Settings.md` §4, the endpoint form's help link in Model Manager, and the overflow fixes (P34). **Upkeep:** each wave that adds or changes an Advanced Settings knob updates `Advanced-Settings.md` in the same PR (for example the thinking window, request ceiling and lifted max in 2b, and the fallback target in 3d). `scripts/tests/knob-docs-sync.test.mjs` is followed and named in the task; it also asserts the "— N knobs across M groups" count in `Advanced-Settings.md:14`, which 2b (two knobs) and 3d (one) each update. The wiki is published by `npm run wiki:sync` after merge, and the PR's post-merge checklist says so. | Owner rule: each server needs setup guidance with well-documented examples. An unverified flag or URL would send a user down a wrong path, and a knob with no wiki row fails an existing guard. |
| P34 | **Overflow failures carry actionable fixes (F7).** | Owner rule: point the user to how to fix it, not just stall. A fix that pointed at a setting that does not exist would be worse than none, so the guard test makes that impossible. |
| | **Message:** for `analyzer-reasoning-overflow`, `classifyAnalysisFailure` (`server/src/routes/failure-taxonomy.ts:492`) returns a `userMessage` that is the headline: it names the chapter, the model and the engine or endpoint, and says the model spent its whole output budget thinking and gave no answer, with no "then retry". `remediation` lists the steps in plain words and ends with "then resume — finished chapters are kept". So the chapter is named on every path, the subset (Retry) route's Phase-1 loop gains the catch that records the chapter. | |
| | **Field:** `AnalysisFailure` (`failure-taxonomy.ts:400`), the SSE error payload and OpenAPI gain an optional `fixes: AnalysisFailureFix[]`, built by `reasoningOverflowFixes(ctx)` (interface contract), both in `server/src/routes/failure-taxonomy.ts`. `ctx` is `{ transport, model, endpointId? }`. No transport throws `AnalyzerReasoningOverflowError`: the runner's `mapFinish` does, called from `StageRunner.send`. Its constructor is `(transport, model, reasoningTokens, opts?: { endpointId?: string; reasoningLevel?: ReasoningLevel })`. `endpointId` arrives in 3b and comes from `OpenAIAnalyzer`, never `OpenAITransport`. It is set on both exits: a thrown error, via `withEndpointId`, and an escalation overflow reported through `StageCall.onReasoningOverflow`, whose hook `OpenAIAnalyzer` wraps. `reasoningLevel` is added to the same object in 5a, never positional: `mapFinish`'s ctx gains it, and `StageRunner` passes the level it resolved for that request. | |
| | **Offered per engine** (only settings that exist at that wave): Gemini — `analyzer.gemini.maxInputTokensPerRequest`, `analyzer.gemini.outputHeavyChunkChars`, `analyzer.gemini.maxOutputTokens` (only when set below the model's limit), a label-only "Switch to another model" (2b), and lower the reasoning level (copy and fix from 5a only). Ollama — `analyzer.ollama.numCtx` (the binding limit, P6), stage input fractions, and "turn reasoning off" for that model (5a), offered when the level sent was `on`, a named level or `model default` (an Ollama model can think by default), and never when it was `off`. **Reasoning gating (5a):** a Gemini level fix is offered only when the level the failing request ran at has a lower rung. That level is the explicit level, or at `model default` the row's documented `defaultLevel`: 3.8 / 3.7 and 3.6 / 3.5 Flash `medium`, Gemini 3 Flash (`gemini-3-flash-preview`) `high` (its own row or an override, not the 3.x Flash row's `medium`), 3.5 / 3.1 Flash-Lite `minimal`, 3.1 Pro `high`. So Flash-Lite at its default gets no level fix. `defaultLevel` gates fixes only; the wire still omits the field at `model default`. Gemma at `on` gets "turn reasoning off"; at `off` or its default, none. The Gemini and Ollama reasoning fixes link through `reasoningSetting`. Endpoint — its `maxOutputTokens` and `contextTokens` (must match the server), stage input fractions, reasoning level (5a), payload `max_tokens` (5b). The thinking window (P5) bounds time, not output, and is **never** offered. | |
| | **Guard test:** fails if any `settingKey` is not a registry key, or any `endpointField.field` is not a key of `analyzerEndpointSchema`'s shape. From 5a it also fails if `reasoningSetting.engine` is not `gemini` or `ollama`, or if a level fix is offered for a model with no lower rung. It checks that each `wikiPage` file exists. It lives in `server/src/routes/failure-taxonomy-fixes.test.ts`, and each wave that adds a fix extends it. **Proven able to fail:** a mutated `settingKey` goes red, and the guard runs with the conditional `maxOutputTokens` fix enabled, so that fix's key is checked too; it seeds the catalog with `_seedGeminiCatalogForTest(apiKey, models)` (2b, beside `_resetGeminiCatalogForTest`). **Mechanics:** it resolves `docs/wiki/` from `import.meta.url`, and its Gemini model ids come from an explicit one-id-per-row fixture checked to resolve back to its row, not from regex text. | |
| | **Loud:** the analysis failure surface renders a "How to fix" list with those links. The notification is raised in `src/store/analysis-stream-middleware.ts`'s `AnalysisError` branch, which owns the stream that survives navigation: a persistent toast carrying `fixes` under `dedupeKey: 'analysis-stream'`, replacing the plain 6 s toast for this code. Both `setHalted` dispatchers (the middleware, and the Analysing view's own catch) carry `fixes` into the halted state, and the Analysing view renders `haltFixes` for a halted run, so navigating away and back in the same session still shows them. `fixes` are not stored on the #3004 last-outcome record, because no frontend code reads the rejoin event's `priorOutcome`. Every link comes from one function, `fixHref(fix)` (`src/lib/failure-fixes.ts`, 2b), which both "How to fix" renderers call; later waves add branches to it, never to a renderer. It builds `#/advanced?focus=<settingKey>`; Advanced Settings scrolls to and highlights that row. The advanced route has no parameter today (`src/lib/router.ts:49-50`), so 2b gives the `Stage` union's `'advanced'` member a `focusKey`: `stageToHash` and `stageEqual` (`src/lib/router.ts`) emit and compare it, and `AdvancedRoute` reads it with `useSearchParams` + `useHydrateStage`, as `HelpRoute` does with `?code=` (`src/routes/index.tsx:491-496`), with tests. Routing is react-router; there is no `parseHash` (`src/routes/index.tsx:1126`). 5a adds `reasoningFocus` the same way. An `endpointField` links to `#/models?endpoint=<id>&field=<field>` (3d): the `Stage` union's `'model-manager'` member gains `endpointId` and `endpointField`, `uiActions.openModelManager(payload?)` takes them, and Model Manager opens that endpoint's editor with the field focused. A fix with both `settingKey` and `endpointField` keeps the `settingKey` link. A `reasoningSetting` links to `#/advanced?reasoningEngine=<engine>&reasoningModel=<encodeURIComponent(model)>` (5a), and Advanced Settings scrolls to and highlights that model's reasoning row. It uses two parameters because Ollama tags contain `:`, following the help route's `?code=` precedent. | |
| | **Wiki link entry:** the wiki link is its own fix. Each engine's list ends with one `{ label: 'Read: <section title>', wikiPage }` entry, and no other fix carries `wikiPage`. `wikiPage` is a page name, never an `#anchor`: `src/lib/wiki-links.ts` is page-level only, and the frontend builds `WIKI_BASE/<page>`. Gemini and Ollama (2b): `{ label: 'Read: When a model thinks past its output limit', wikiPage: 'Analysis-and-the-Analyzer' }`, whose section lands in 2b. Endpoints (3d): the same label with `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'` (P33). 5b's payload fix adds `{ label: 'Read: Custom payload', wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints' }`. The guard checks that each page file exists. | |
| | **Staging:** 2b — Gemini and Ollama fixes, the field, router focus, rendering, notification, guard test. 3b — endpoint fixes. 3d — the endpoint-editor deep link and the endpoint wiki page link. 5a — reasoning-level fixes. 5b — payload fix and its `Read: Custom payload` entry. | |

## Interface contract

**Names and types are binding.** A task that cannot use a name as written reports the conflict instead of renaming. The wave tag says which PR introduces each name.

### Engines and ids
`server/src/analyzer/model-id.ts` (3a) and `src/lib/model-id.ts` (3a):
```ts
export type AnalysisEngine = 'local' | 'gemini' | 'openai';
export function inferEngineFromModelId(id: string): AnalysisEngine;          // frontend name: engineForModelId
export function parseEndpointModelId(id: string): { endpointId: string; model: string } | null;
export function endpointModelId(endpointId: string, model: string): string;  // `openai:${endpointId}::${model}`
```
One case table, `server/src/analyzer/__fixtures__/model-id-cases.json`, drives the server and frontend tests. Until 3a, `AnalysisEngine` stays `'local' | 'gemini'` where it is declared today.

### Types leaf and errors
- **`server/src/analyzer/types.ts` (1a):** `StageCall`, `StageChunkInfo` and the other analyzer types. `index.ts` re-exports them.
- **`server/src/analyzer/errors.ts`:**
```ts
export type TransportKind = 'ollama' | 'gemini' | 'openai';                  // 1a
export class AnalysisAbortedError extends Error {}                             // 1a (moved; ollama.ts re-exports)
export class AnalyzerUnreachableError extends Error {                          // 1a
  constructor(message: string, readonly transport: TransportKind, readonly cause?: unknown);
}
export class LocalUnreachableError extends AnalyzerUnreachableError {}        // 1a (transport 'ollama', code stays 'LOCAL_UNREACHABLE')
export class AnalyzerHttpError extends Error {                                 // 1a — deliberately NO `status` property
  constructor(readonly transport: TransportKind, readonly httpStatus: number, readonly bodyExcerpt: string, message: string);
}
// AnalyzerTruncatedError.engine widens to TransportKind (1a).
export class AnalyzerReasoningOverflowError extends Error {                    // 2b
  constructor(readonly transport: TransportKind, readonly model: string, readonly reasoningTokens: number | undefined, opts?: { endpointId?: string; reasoningLevel?: ReasoningLevel });
  // Thrown by the runner's mapFinish (called from StageRunner.send), never by a transport. 2b: the first three params.
  // opts.endpointId: 3b, from OpenAIAnalyzer (never OpenAITransport), on both exits: a thrown error via withEndpointId, and an escalation overflow via the StageCall.onReasoningOverflow hook OpenAIAnalyzer wraps. opts.reasoningLevel: 5a, added to the same object (never positional), from the level StageRunner resolved for that request. Both feed reasoningOverflowFixes.
}
export class AnalyzerTimeoutError extends Error {                              // 2b (always: the Gemini request ceiling uses it; 3b reuses it)
  constructor(readonly transport: TransportKind, readonly model: string, readonly elapsedMs: number, readonly reason: 'ceiling' | 'connect-timeout' | 'thinking-idle');  // 'thinking-idle' (2b, P5): never retried
}
export class AnalyzerStreamIncompleteError extends Error { constructor(readonly transport: TransportKind, readonly model: string, opts?: { causeCode?: string }); }   // 3b; message names causeCode via causeCodeSuffix()
export function causeCodeSuffix(causeCode: string | undefined): string;   // 3b: " (CODE)" or ""; used by AnalyzerTransportError and AnalyzerStreamIncompleteError messages
export class AnalyzerInvalidOutputError extends Error { /* builds today's "failed validation after retry" text itself */ }            // 3b
export class AnalyzerEndpointMissingError extends Error { constructor(readonly endpointId: string, readonly source: 'settings' | 'env' | 'run-pick' | 'persona'); } // 3a (selection refuses stray endpoint ids, P23)
export class AnalyzerKeyOriginError extends Error { constructor(readonly endpointId: string, readonly endpointName: string); }        // 3b → FailureCode `auth`
export class AnalyzerCapabilityRejectedError extends Error { constructor(readonly modelId: string, readonly setting: 'structuredOutput' | 'reasoning', readonly value: string, readonly testedAt: string); } // 3c
export class AnalyzerTargetInputTooLargeError extends Error { constructor(readonly transport: TransportKind, readonly model: string, readonly targetLabel: string, readonly limitTokens: number, readonly family: 'context' | 'requestCap'); } // 3d (P30): a fallback target's pre-send capacity check refused a pass that cannot split. Not an AnalyzerTruncatedError; never retried; → `analyzer-request-rejected` with its own copy, never an HTTP status
```
FailureCodes:
- **`analyzer-reasoning-overflow`** (2b).
- **`analyzer-timeout`** (2b, with `AnalyzerTimeoutError`). After 2b the help counts are 25/51; wave 3b's three new codes bring them to 28/54.
- **`analyzer-request-rejected`** (3b). Covers any 400 from any transport, including a Gemini `ApiError` with status 400. `AnalyzerCapabilityRejectedError` also maps here, with "refused before start" copy. From 3d, `AnalyzerTargetInputTooLargeError` maps here too, with its own copy naming the fallback target and its input limit, and never an HTTP status.
- **`analyzer-invalid-output`** (3b).
- **`analyzer-endpoint-missing`** (3b).
- **`auth`** (existing) also covers `AnalyzerHttpError` 401/403 and `AnalyzerKeyOriginError`.

Overflow fixes (P34):
```ts
// server/src/routes/failure-taxonomy.ts (2b; later waves extend the fixes it returns). Guard: server/src/routes/failure-taxonomy-fixes.test.ts
export interface AnalysisFailureFix {
  label: string;                                          // e.g. "Lower Gemini max input tokens per request"
  settingKey?: string;                                    // a registry key → frontend links #/advanced?focus=<key> (2b: the Stage union's 'advanced' member gains focusKey; stageToHash's 'advanced' case builds its query with URLSearchParams (focus))
  endpointField?: { endpointId: string; field: string };  // 3b+ → frontend opens that endpoint's editor at the field (3d)
                                                          //   3d: links #/models?endpoint=<id>&field=<field>; stage { kind: 'model-manager'; endpointId?: string; endpointField?: string };
                                                          //   uiActions.openModelManager(payload?: { endpointId?: string; endpointField?: string })
  wikiPage?: string;                                      // a wiki page name, never an #anchor (src/lib/wiki-links.ts is page-level only). Set only on each list's closing { label: 'Read: <section title>', wikiPage } entry; no other fix carries it. The frontend builds WIKI_BASE/<page>; the guard checks the page file exists
  reasoningSetting?: { engine: 'gemini' | 'ollama'; model: string };  // 5a, additive widening: a per-model analyzerReasoningByEngine entry, which is neither a registry key nor an endpoint field
                                                                       //   → frontend links #/advanced?reasoningEngine=<engine>&reasoningModel=<encodeURIComponent(model)> (5a: the Stage union's 'advanced' member gains reasoningFocus; stageToHash adds reasoningEngine/reasoningModel to the same URLSearchParams builder, stageEqual compares it, AdvancedRoute reads it via useSearchParams + useHydrateStage)
}
// AnalysisFailure gains `fixes?: AnalysisFailureFix[]` (2b); the SSE error payload and openapi.yaml carry it too.
export function reasoningOverflowFixes(ctx: { transport: TransportKind; model: string; endpointId?: string }): AnalysisFailureFix[];
// Guard (failure-taxonomy-fixes.test.ts): seeds the catalog via _seedGeminiCatalogForTest so the conditional maxOutputTokens fix appears; resolves docs/wiki/ from import.meta.url;
//   takes Gemini model ids from an explicit one-id-per-row fixture checked to resolve back to its row, never from regex text.
// src/lib/failure-fixes.ts (2b) — the one place a fix becomes a link; both "How to fix" renderers (analysing.tsx, reasoning-overflow-toast.tsx) call it
export function fixHref(fix: AnalysisFailureFix): string | null;   // settingKey → #/advanced?focus= (2b); endpointField → #/models?endpoint=&field= (3d); reasoningSetting → #/advanced?reasoningEngine=&reasoningModel= (5a); otherwise null
```

### Transport, finish, retry — `server/src/analyzer/runner/` (1b unless tagged)
```ts
// transport.ts
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type StructuredOutputMode = 'schema' | 'json' | 'off';
export type StructuredOutputRequest = { mode: 'schema'; name: string; schema: Record<string, unknown> } | { mode: 'json' } | { mode: 'off' };
export interface FreeTextOptions { onCpu?: boolean; keepAlive?: string | number; absoluteMaxMs?: number }   // 4
export interface TransportRequest {
  system: string;
  messages: ChatMessage[];
  structuredOutput: StructuredOutputRequest;
  temperature: number;                   // 1b; wave 4 widens to `number | undefined` (undefined = send none, for the Gemini persona call)
  maxOutputTokens?: number;              // 1b: undefined = pre-wave-2 default; 2b: always resolved
  estimatedInputTokens: number;
  signal?: AbortSignal;
  call: Pick<StageCall, 'onChunk' | 'onWaiting' | 'onThrottle' | 'onEvalTiming'>;
  freeText?: FreeTextOptions;            // 4
  reasoning?: ReasoningLevel;            // 5a
  extraParams?: Record<string, unknown>; // 5b
}
export interface TransportUsage { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
export interface TransportResult {
  text: string; reasoningSeen: boolean; finish: 'stop' | 'length' | 'blocked';
  finishReason?: string; blockReason?: string; usage?: TransportUsage; receivedBytes: number;
}
export interface ChatTransport {
  readonly kind: TransportKind; readonly model: string;
  prepare?(signal?: AbortSignal): Promise<void>;   // 2b, bounded at 10 s (P26); StageRunner calls prepare(call.signal): awaited inside StageRunner's async send path before its settings read (Gemini catalog warm-up;
                                         //     3c endpoint served limits). The synchronous structuredOutput() must not depend on it.
  send(req: TransportRequest): Promise<TransportResult>;
}
// finish.ts
export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string;   // 1b; 2b adds the overflow rule (throws AnalyzerReasoningOverflowError); 5a: ctx gains reasoningLevel?: ReasoningLevel, which StageRunner passes for that request
export function withThinkEvidence(r: TransportResult): TransportResult;                               // 1b: unterminated <think> → reasoningSeen
export function hasReasoningEvidence(r: TransportResult): boolean;                                    // 2b
// parse.ts (1a, moved from gemini.ts, re-exported): parseAndValidate, ParseResult, stripCodeFences, repairUnescapedQuotes,
//   trimTrailingProse, repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse; stripThink (1b)
// prompt.ts (1a): buildSystemInstruction, languagePreamble, loadSkill, SkillName, SKILL_FILES, SKILL_TO_PROMPT_ID, estimateInputTokens
// retry-policy.ts
export interface ValidationRetryPolicy {
  readonly name: 'ollama' | 'gemini' | 'openai';
  initialTemperature(): number;
  buildRetry(input: { messages: ChatMessage[]; firstRaw: string; failure: Extract<ParseResult<unknown>, { ok: false }> }): { messages: ChatMessage[]; temperature: number };
  readonly writesRawAttempts: boolean;
  readonly warnsOnRepair: boolean;
  escalationRethrows(err: unknown): boolean;
}
export const OLLAMA_RETRY_POLICY: ValidationRetryPolicy;   // 1b
export const GEMINI_RETRY_POLICY: ValidationRetryPolicy;   // 1b
export const OPENAI_RETRY_POLICY: ValidationRetryPolicy;   // 3b (Ollama shape; temperatures 0.2 / 0.6)
// transport-retry.ts (1b, extracted from gemini.ts:536-652)
export type RetryDisposition = 'abort' | 'no-retry' | 'idle' | 'daily-quota' | 'rate-limit' | 'server-error';
export interface RetryClassifier { classify(err: unknown): RetryDisposition; retryAfterMs(err: unknown): number | null }
export async function withTransportRetry<T>(attempt: () => Promise<T>, opts: {
  model: string; limiter: GeminiRateLimiter; estimatedInputTokens: number; classifier: RetryClassifier;
  signal?: AbortSignal; onThrottle?: StageCall['onThrottle']; maxAttempts: number; maxTotalMs: number;
  backoffsMs: readonly number[]; logTag: string; displayName: string;
  recordActualTokens?: (result: T) => number | undefined;
}): Promise<T>;
```
The `finalFailureMessage` policy member exists in 1b and is removed in 3b, when `AnalyzerInvalidOutputError` builds the message.

### Runner — `runner/stage-runner.ts`, `runner/transport-analyzer.ts`
```ts
export type SchemaAdapter = (draft07: Record<string, unknown>) => { schema: Record<string, unknown>; dropped: string[] };
export const identitySchemaAdapter: SchemaAdapter;                             // 1b
export interface StageSpec<T> { manuscriptId: string; key: HandoffKey; skillName: SkillName; promptMd: string; grammarSchema: z.ZodType<unknown>; validationSchema: z.ZodType<T> }
export interface EngineRequestSettings {
  structuredOutput: StructuredOutputMode;   // 1b constants; 3b resolved from knob/endpoint
  maxOutputTokens: number | undefined;      // 1b undefined; 2b resolved
  reasoning?: ReasoningLevel;               // 5a
  extraParams?: Record<string, unknown>;    // 5b
}
export class StageRunner {
  constructor(opts: { transport: ChatTransport; policy: ValidationRetryPolicy; settings: () => EngineRequestSettings; adaptSchema: SchemaAdapter });
  runStage<T>(spec: StageSpec<T>, call: StageCall): Promise<T>;
  runSingleAttempt<T>(spec: StageSpec<T>, call: StageCall): Promise<T | null>;
  runFreeText(input: { system?: string; prompt: string; signal?: AbortSignal; temperature?: number; ollama?: FreeTextOptions }): Promise<string>;   // 4
}
export class TransportAnalyzer implements Analyzer { constructor(readonly runner: StageRunner) }
// 1b: OllamaAnalyzer extends TransportAnalyzer — constructor({ url, model, dispatcher? }) unchanged.
// 1b: GeminiAnalyzer extends TransportAnalyzer — constructor({ apiKey, model }) unchanged.
// 3b: OpenAIAnalyzer extends TransportAnalyzer — server/src/analyzer/openai.ts — constructor({ endpoint, apiKey, model, dispatcher? }).
```
Leaf `server/src/analyzer/ollama-settings.ts` (1a) holds the Ollama resolvers `ollama.ts` re-exports.

### Transports — `server/src/analyzer/transports/`
- **`ollama-transport.ts` (1b):** `OllamaTransport({ url, model, dispatcher? })`, the body of today's `chat()`. It gains a non-streaming persona branch in 4.
- **`gemini-transport.ts` (1b):** `GeminiTransport({ apiKey, model, client?, requestCeilingMs? })`. Thought parts set `reasoningSeen`, count as activity, and never enter `text`. `requestCeilingMs` and the thinking window arrive in 2b (P5). 5a adds the exported `mergeGeminiThinkingConfig(base, fragment)`, which keeps `includeThoughts` beside `thinkingLevel`. It handles `thinkingLevel` only.
- **`openai-transport.ts` (3b):** `OpenAITransport({ endpoint, apiKey, model, dispatcher?, now? })`.
  - **`prepare()` (3c):** warms the endpoint's served limits.
  - **`fetch` wrapper (P22):** `allowlistedFetch(apiKey, origin)` lives in the leaf `transports/allowlisted-fetch.ts` (3b), so the catalog, preview and served-limits clients import it without a cycle. It sends fixed `accept`, `content-type` and `user-agent` values, no `x-stainless-*` headers, and `Authorization` only under the origin rule. Errors are redacted when built, against `loadKnownAnalyzerSecrets()` (async, in `user-settings.ts`), and the raw SDK error is not attached as `cause`.
  - **Request settings (P24):** `openAIRequestSettings(endpoint, servedOutputLimit?)` resolves the settings closure, and wave 5 extends it. `resolveEndpointMaxOutputTokens` / `endpointAutoOutputMargin` give Auto `max_tokens`.
  - **Settings load (P25):** `dropInvalidEndpointEntries` runs inside `performUserSettingsRead`, between the eager-load migration and the whole-object `safeParse` (`user-settings.ts:522`). The cold read's single flight is #3195's shipped `inFlightRead`, not new code. Every drop is listed through `listDroppedEndpointEntries` until acknowledged (P31), and endpoint writes validate first, refusing a malformed entry with 400 `{ error, code, issues }` (P25).
  - **Failure classification,** in this order:
  1. caller abort → `AnalysisAbortedError`;
  2. a connection-level error: `APIConnectionError` (including its timeout subclass), or a non-`APIError` raised before `create()` resolved. It is unreachable only when its cause chain holds a connect-phase code (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`), or it is a bare `fetch failed` with no code in the chain. `ECONNRESET`, `UND_ERR_SOCKET` or `EAI_AGAIN` before headers → `AnalyzerStreamIncompleteError`. The result is `AnalyzerUnreachableError`. An `APIError` carrying a status is never unreachable (P21).
  3. ceiling signal or `APIConnectionTimeoutError` → `AnalyzerTimeoutError`;
  4. `APIError` with a status → `AnalyzerHttpError`;
  5. `APIError` without a status → `AnalyzerHttpError` with status 0, not retried;
  6. headers received, and a socket drop or no `finish_reason` → `AnalyzerStreamIncompleteError`.
- **`endpoint-runtime.ts` (3b):** `noteEndpointModelUsed` (called when the request is sent, after the semaphore admits it), `servedModels(endpointId): readonly string[]`, `forgetEndpointModel(endpointId, model)` — 3b; removes a model after a 2xx/404 unload, `undefined` clears the endpoint (3d.2's `forgetServedModel` defaults to it), `endpointSemaphore(endpoint)`.
- **`endpoint-served-limits.ts` (3c):** `warmEndpointServedLimits(...)`, `getEndpointServedLimits(baseUrl, model, now?)`, `SERVED_LIMITS_TTL_MS` (10 min, 60 s back-off after a failure), `SERVED_LIMITS_WARMUP_TIMEOUT_MS` (10 s, P26).
  - **Warm-up deps:** `timeoutMs` and `signal`. One shared listing per base URL; an abort releases only that caller; an abandoned listing caches nothing.
  - **Signals:** `OpenAITransport.prepare(signal?)` has a test-only `servedLimitsTimeoutMs` option. `CatalogDeps.listEndpoint` takes an optional `signal`.
  - **Headers:** every OpenAI SDK client (transport, catalog listing, preview, served limits) is built with `allowlistedFetch` (P22). Detect is a plain undici fetch: it follows the origin rule and redacts its errors, but builds no SDK client.
  - **Rebuilt errors (3b, P22):**
    - **Rule 7:** a non-`Analyzer*` error rethrown by a transport becomes `AnalyzerTransportError(transport, model, message, causeCode)`. Its message holds only class names and the sanitised `causeCode`.
    - **Rule 2:** it attaches no SDK error.
    - **Non-fallback:** `AnalyzerTransportError` never triggers a fallback.
  - **Leaf helpers (3b):**
    - `known-secrets-gate.ts` supplies `knownAnalyzerSecrets()` without an import cycle.
    - `analyzerSelectionErrorEvent(err)` codes every error selection can throw, through `classifyAnalysisFailure`, at every selection call site. It never returns `null`, and the stream never ends uncoded. It returns `detail` too.
    - `loadKnownAnalyzerSecrets()` / `knownAnalyzerSecrets()` are always reached through `known-secrets-gate.ts`, never by importing `user-settings.ts`. `resolveCapacity` takes only the served **output** limit from here; `contextTokens` stays the saved endpoint field (spec §6).

### Capacity, catalog, output — waves 2 and 3
```ts
// server/src/analyzer/capacity.ts
export interface EngineCapacity { family: 'context' | 'requestCap'; contextTokens: number; maxOutputTokens: number | null; perRequestInputCap?: number }
export function resolveCapacity(sel: { engine: AnalysisEngine; model: string; endpoint?: AnalyzerEndpoint }): EngineCapacity;  // 2a: engine 'local'|'gemini', no endpoint; 3c: endpoint branch
export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192;                                                                          // 2a
export function resolveGeminiMaxOutputTokens(model: string): number;                                                            // 2b
// 2a signature changes (all callers updated in the same task):
resolveStage1ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string, runningRoster?: CharacterOutput[]): number
resolveStage2ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string): number
chapterChunkBudget(capacity: EngineCapacity, reservedChars?: number, sampleText?: string, reservedTokens?: number): number
// server/src/analyzer/catalog/gemini-catalog.ts (2b)
export interface GeminiModelInfo { id: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean }
export async function listGeminiModels(apiKey: string, opts?: { refresh?: boolean; client?: GeminiModelsClient }): Promise<GeminiModelInfo[]>;
export async function warmGeminiCatalog(apiKey: string, opts?: { client?: GeminiModelsClient; signal?: AbortSignal }): Promise<void>;   // never throws; bounded by GEMINI_CATALOG_WARM_TIMEOUT_MS; shared listing, an abort releases only that caller; 60 s back-off after a failure
export function _seedGeminiCatalogForTest(apiKey: string, models: GeminiModelInfo[]): void;   // 2b, test-only, beside _resetGeminiCatalogForTest: lets the overflow-fixes guard make the conditional maxOutputTokens fix appear
export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined;   // answers only for the key most recently listed or warmed (keyed by key hash)
// Reasoning overflow bookkeeping (2b, P20), server/src/routes/analysis.ts:
//   AnalysisJob.reasoningOverflowed?: boolean; AnalysisJob.reasoningOverflowError?: AnalyzerReasoningOverflowError;
//   noteReasoningOverflow(job, structureBudget, err) sets both and empties the book's escalation budget;
//   throwIfReasoningOverflowed(job) rethrows the stored error (terminal handler, `halted`) — checked in Phase 0's dispatch loop,
//   Phase 1's runChapter after awaitPhase1Dispatch, and the subset route's Phase 1 loop;
//   buildNonStoryClassifier(...) replaces the two inline non-story closures, skips calls once the job is marked, and marks it on an overflow.
//   StageCall.onReasoningOverflow?: (err: AnalyzerReasoningOverflowError) => void — called by StageRunner.runSingleAttempt before it returns null
//   on an overflow, so an escalation call marks the job too.
// server/src/analyzer/rate-limit.ts — resolveLimits exported (2b, with the TPM-bound perRequestInputCap; the same PR lifts analyzer.gemini.maxInputTokensPerRequest's max to 1_000_000, P32); analyzerRateLimiter alias + unlimited endpoint ids (3b); analyzerRateLimitsByModel read (3c)
// Gemini thinking window (2b, P5): knob analyzer.gemini.thinkingIdleTimeoutMs (env GEMINI_THINKING_IDLE_MS, integer 0–290 000, default 0 =
//   automatic: 120 000 ms when geminiModelThinks(model), else resolveStreamIdleTimeoutMs()); a positive value applies to every model.
//   resolveGeminiThinkingIdleTimeoutMs(model, level?): number (gemini-transport; level added in 5a via geminiRequestThinks); bounds gaps until the first answer text; timeout → AnalyzerTimeoutError, no retry.
//   One console.info line per attempt: model, firstChunkMs, firstAnswerMs, thoughtPartsBeforeAnswer.
export const GEMINI_CATALOG_WARM_TIMEOUT_MS = 10_000;   // 2b, P26
export function geminiModelThinks(model: string): boolean;   // 2b, P27: static id rule only, never the catalog flag
```

### Endpoints, keys, capabilities, adapters — wave 3
```ts
// server/src/workspace/analyzer-endpoints.ts (3b)
export const REASONING_STYLES = ['reasoning_effort', 'enable_thinking', 'not_controllable'] as const;
export const analyzerEndpointSchema: z.ZodObject<…>;   // fields per spec §3: id, name, baseUrl, gpu, unloadUrl?, concurrency (1), requestCeilingMs (1_800_000),
                                                       // structuredOutput ('schema'), reasoningStyle ('not_controllable'), reasoning ('model-default'),
                                                       // maxOutputTokens (0), contextTokens (required, ≥512), maxInputTokensPerRequest?, extraParams?
export type AnalyzerEndpoint = z.infer<typeof analyzerEndpointSchema>;
export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none';
export function keyOriginMatches(stored: { origin: string } | undefined, url: string): boolean;
export function resolveEndpointApiKey(settings: { analyzerEndpointKeys: Record<string, { origin: string; key: string }> }, endpoint: AnalyzerEndpoint, targetUrl: string): string | null;  // structural param (no UserSettings import → no cycle); throws AnalyzerKeyOriginError on mismatch
export function resolveUnloadUrl(endpoint: AnalyzerEndpoint, model: string | undefined): string | null;   // called once per served model (P3); null when `{model}` is present and no model is given
export function findEndpointReferences(settings: { [k: string]: unknown }, endpointId: string): string[];
// server/src/workspace/user-settings.ts (3b)
export async function mutateUserSettings(fn: (current: UserSettings) => Partial<UserSettings>): Promise<UserSettings>;  // serialised writer; callers return only the fields they own, and it matches the five shipped writers' rotate/stamp/snapshot/clear-flag discipline
export function invalidEndpointsArchivePath(): string;   // 3b: user-settings.invalid-endpoints.json beside the settings file; named in the drop warning (P25)
export async function loadKnownAnalyzerSecrets(): Promise<string[]>;   // 3b: endpoint keys + the Gemini key, for redaction — reached only through known-secrets-gate.ts
export interface DroppedEndpointEntrySummary { archiveId: string | null; kind: 'endpoint' | 'key'; endpointId?: string; name?: string; origin?: string; issues: string[]; droppedAt: string }   // 3b (P31): issues are `path: code`, never values; key entries carry the origin only; name capped at 80 chars; archiveId null = archive append still pending (listed, not acknowledgeable)
export async function listDroppedEndpointEntries(): Promise<DroppedEndpointEntrySummary[]>;       // 3b (P31): archived entries minus the acknowledged sidecar, plus pending ones → GET `droppedEndpointEntries` (a sync twin, listDroppedEndpointEntriesSync, serves envDerived)
export async function acknowledgeDroppedEndpointEntries(archiveIds: string[]): Promise<void>;   // 3b (P31): adds the ids to the acknowledged sidecar; a null or unknown id is ignored
export function droppedEndpointEntriesAcknowledgedPath(): string;                               // 3b (P31): user-settings.invalid-endpoints.acknowledged.json beside the settings file
// 3b (P31): each archive record in user-settings.invalid-endpoints.json gains `archiveId` (a UUID) and a server-only `contentHash` (the same unchanged entry is archived once and stays acknowledged across restarts); the archive stays append-only, so acknowledgement lives only in the sidecar, and acknowledge is serialised.
// server/src/analyzer/known-secrets-gate.ts (3b) — the leaf that breaks the cycle; nothing under analyzer/ imports user-settings.ts for secrets
export function knownAnalyzerSecrets(): readonly string[];   // sync view, empty until the load provider has run
export function registerKnownSecretsProvider(load: () => Promise<string[]>): void;   // unconditional; registered at boot
// server/src/analyzer/runner/schema-adapters.ts (3b)
export function adaptSchemaForOllama(s): AdaptedSchema; export function adaptSchemaForGemini(s): AdaptedSchema; export function adaptSchemaForOpenAI(s): AdaptedSchema;
export function structuredOutputLabel(mode: StructuredOutputMode, dropped: string[], record: ModelCapabilityRecord | undefined, reasoningKey: string): string;
// server/src/analyzer/capabilities.ts (record type 3b; test action 3c; reasoning half 5a)
export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';
export interface ModelCapabilityRecord {
  serverUrl: string; testedAt: string; control: { ok: true } | { ok: false; error: string };
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  reasoning: Partial<Record<string, 'accepted' | 'rejected'>>;   // key type narrows to ReasoningLevel in 5a
  digest?: string;                                                // 3c (A3, pulled forward from 5a): Ollama only — the model's /api/tags `digest` when the Test ran; a record for another installed digest is discarded
  verdictTestedAt?: { reasoning?: Record<string, string>; structuredOutput?: Record<string, Record<string, string>> };  // 5a (A2): each verdict's own Test date, keyed like the verdicts
}
export function capabilityRecordFor(settings: UserSettings, modelId: string, currentServerUrl: string, currentDigest?: string): ModelCapabilityRecord | undefined;   // 3c: discarded on a server-URL change, or when both digests are known and differ
export function assertConfiguredCapabilitiesAllowed(record: ModelCapabilityRecord | undefined, configured: { structuredOutput: StructuredOutputMode; reasoning: string }, modelId: string): void;  // reasoning = the level this run sends; from 5a the refusal's testedAt is the rejected verdict's own date (verdictTestedAtFor)
export async function runModelTest(input: { modelId: string; scope: 'configured' | 'all' }, deps: ModelTestDeps): Promise<ModelCapabilityRecord>;
//   throws ModelTestControlFailedError (route → 502 `failed`, nothing written) or ModelTestInconclusiveError (502, nothing written)
export function plannedTestRequestCount(input: { modelId: string; scope: 'configured' | 'all' }, deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes'>): number;
// 3c: 1 (control) + one per non-`off` mode step; 5a adds its level step and the reasoning deps.
export class ModelTestControlFailedError extends Error {}   export class ModelTestInconclusiveError extends Error {}
// server/src/analyzer/limit-400-patterns.ts (3b leaf; 3c's Test action imports it, never redefines it):
export const LIMIT_400_PATTERNS: ReadonlyArray<{ provider: string; pattern: RegExp; example: string; source: string }>;
export function namesContextOrTokenLimit(text: string): boolean;
export const PROBE_PROMPT: string;   export const MARKER_KEY = 'cw_probe_marker';
export function probeOutputCap(limits: { contextTokens: number; maxOutputTokens: number | null }, estimatedInputTokens: number): number;
export function defaultReasoningKey(kind: TransportKind): string;   // Ollama 'off' (sent as think:false); others 'model-default'
export function classifyMarkerProbe(text: string, marker: string): 'enforced' | 'ignored';   // uses W1's <think> strip + jsonParseCandidates
// runner/parse.ts (3c): jsonParseCandidates(raw) extracted from parseAndValidate, not copied.
// server/src/analyzer/model-test-deps.ts (3c): modelTestDepsFor(modelId, settings) builds ModelTestDeps.
// select-analyzer.ts / preflight (3c): resolvePhaseModelSelection(opts) → { modelId, source }; preflightTargets(...); runAnalyzerPreflight(targets, settings, digests?: ReadonlyMap<string, string | undefined>) — synchronous, run only on new-job creation (P14);
//   resolvePreflightDigests(targets, deps?): Promise<Map<string, string | undefined>> (A3) — the one await the checks need, for Ollama targets only, fail-open; the analysis POSTs call it on the new-job path only, then re-check for a live job before the synchronous checks and registration (#3004, P14).
// 5a: ModelTestDeps drops `offeredLevels` and gains `reasoningSelection` / `configuredReasoning`; the deps become
//     Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>.
// 5a exports: isProbeRejected, probeReasoningLevels, reasoningSelectionFor, configuredReasoningFor. The level step fills 3c's step-2 hook via sendStep.
export function reasoningSelectionFor(settings: UserSettings, modelId: string, engine?: AnalysisEngine, currentDigest?: string): ReasoningSelection & { endpoint?: AnalyzerEndpoint };   // 5a: currentDigest passes through to capabilityRecordFor for the local engine only (A3) — every pre-run caller (runAnalyzerPreflight) passes the digest preflight already resolved; callers with none (the Test-request-count helper, persona generation, the catalog) keep capabilityRecordFor's own fail-open rule
export function configuredReasoningFor(settings: UserSettings, modelId: string, engine?: AnalysisEngine, currentDigest?: string): ReasoningLevel;
export function assertConfiguredReasoningOffered(settings: UserSettings, modelId: string, engine?: AnalysisEngine, currentDigest?: string): ReasoningLevel;   // P17: throws AnalyzerReasoningUnavailableError when the level the run would send isn't offered
// 3c (A3): ModelTestDeps gains `modelDigest?: () => Promise<string | undefined>` (Ollama only); runModelTest stamps `digest`.
// 5a (A2): runModelTest also stamps every verdict's `verdictTestedAt`; a Test whose digest differs from the saved record's replaces it instead of merging.
// 5a (A2) capabilities.ts: capabilityRecordKey(modelId): string; sameCapabilityRecordModel(a: string, b: string): boolean;
//   verdictTestedAtFor(record: ModelCapabilityRecord, cell: { setting: 'reasoning'; reasoning: string } | { setting: 'structuredOutput'; structuredOutput: StructuredOutputMode; reasoning: string }): string;  // the verdict's own date, else record.testedAt
// 3c (A3) analyzer/ollama-digest.ts (a leaf): ollamaModelDigest(url: string, model: string, fetchImpl?): Promise<string | undefined>;  // /api/tags, exact name; never throws
// 3c (A3) catalog: CatalogDeps.listOllamaTags(url) returns Array<{ name: string; digest?: string }> (was string[]), so entries drop a record for another digest.
// 5a (A2): both widen their name match through normalizeModelTag.
// 5a (A2) user-settings.ts: writeAnalyzerCapabilityRecord(modelId: string, record, sameModel: (savedKey: string) => boolean): Promise<UserSettings>;  // merges into, then removes, every saved key sameModel accepts
// server/src/analyzer/model-test-deps.ts (3c): modelTestDepsFor(modelId) builds ModelTestDeps; the route stays thin.
// server/src/analyzer/analyzer-concurrency.ts (3d) — endpoint busy registry (P1); the Ollama K limiter and its eviction gate are untouched
export function registerEndpointCallInFlight(endpointId: string): () => void;          // idempotent release
export function markEndpointRunActive(endpointIds: readonly string[]): () => void;     // every run-shaped caller, for the run's whole life: analysis (main + subset), script review, annotate-emotion, instruct-annotation, and the Test action; taken as the first statement inside the releasing try
export function isEndpointBusy(endpointId: string): boolean;                           // call in flight OR run active
export function endpointIdsForModelIds(modelIds: readonly string[]): string[];
export function _resetEndpointBusyForTest(): void;                                      // test-only; clears calls and runs
// endpoint-runtime.ts's forgetEndpointModel (3b) is declared once, in the 3b contract entry above; 3d consumes it as evictEndpointsOnDevice's forgetServedModel default.
// server/src/gpu/endpoint-eviction.ts (3d)
export function endpointsSharingDevice(endpoints: AnalyzerEndpoint[], deviceKey: string): AnalyzerEndpoint[];
export const ENDPOINT_UNLOAD_TIMEOUT_MS = 10_000;   // 3d: per-unload-POST budget, same shape as SERVED_LIMITS_WARMUP_TIMEOUT_MS
export interface EndpointUnloadOutcome { freed: number; failed: number; busy: boolean }   // per endpoint, per admission (A6)
export async function evictEndpointsOnDevice(deviceKey: string, deps?: { fetch?: typeof undici.fetch; settings?: () => UserSettings; servedModels?: (endpointId: string) => readonly string[]; isEndpointBusy?: (endpointId: string) => boolean; loggedBusy?: Set<string>; attemptedEndpoints?: Set<string>; endpointOutcomes?: Map<string, EndpointUnloadOutcome>; forgetServedModel?: (endpointId: string, model: string | undefined) => void }): Promise<{ attempted: number; unloaded: number }>;
// No eviction latch of any kind (A1). attemptedEndpoints is the sole bound: one POST per (endpointId, model) per admission,
//   marked before the fetch (a hang counts), never marked on a busy skip. Re-checks isEndpointBusy immediately before each
//   POST; one POST per served model (P1, P3); 10 s per POST. A 2xx or 404 removes the model from the served set; only a 2xx
//   counts as unloaded. Worst case per admission: Σ (served models on matching endpoints) × 10 s — and an admission is one
//   synthesize call (sidecar.ts postWithCapacityRetry), not one chapter.
export function endpointUnloadNotes(deviceKey: string, settings?: UserSettings, servedModels?: (endpointId: string) => readonly string[], outcomes?: ReadonlyMap<string, EndpointUnloadOutcome>): string[];
//   give-up notes (N2, A6), one per sharing endpoint still holding the card, first match: no Unload URL; busy throughout;
//   every POST failed; attempts spent (unloaded N, still short); {model} URL with nothing run on it since Castwright started.
// server/src/tts/tts-errors.ts (3d)
//   new NoCapacityError(engine, neededMb, deviceKey, blockers?, notes?: string[]) — notes are appended to `message` only;
//   no `notes` field is stored on the error.
// src/lib/analyzer-endpoints.ts (3d)
export function endpointForModelId(settings: Pick<UserSettings, 'analyzerEndpoints'>, id: string): AnalyzerEndpoint | undefined;
export function analyzerSharesTtsDevice(input: { engine: AnalysisEngine; endpointGpu: string | undefined; ttsDeviceKey: string | undefined }): boolean;
```
User-settings fields:
- **`analyzerEndpoints`** (3b): returned by GET, written only through the endpoint routes.
- **`analyzerEndpointKeys`** (3b): in `FORBIDDEN_KEYS`. GET exposes `analyzerEndpointKeyStatus: Record<id, 'set' | 'unset' | 'origin-mismatch'>`.
- **`droppedEndpointEntries`** (3b, P31): `DroppedEndpointEntrySummary[]`, read-only on GET, in `FORBIDDEN_KEYS`; an archived entry is cleared through `acknowledgeDroppedEndpointEntries`, which writes the acknowledged sidecar, and a pending entry (`archiveId: null`) stays listed until archived.
- **`analyzerCapabilitiesByModel`** (3b/3c): written by the server only.
- **`analyzerRateLimitsByModel`** (3c): general PUT, whole-map write.
- **`analyzerExtraParamsByEngine`** and **`analyzerReasoningByEngine`** (5a/5b): general PUT, validated on write in the PUT route, not in `writeUserSettings`, to avoid a `capabilities.ts` ↔ `user-settings.ts` cycle.
  - **Shape:** `analyzerReasoningByEngine.ollama` is stored as `Record<string, string>` with normalised model keys (P18). An unknown stored value is stale and refused before the run starts.
  - **Merge time:** stored payloads are filtered again (P17).

Catalog response (3c):
```ts
interface AnalyzerCatalog {
  groups: Array<{
    kind: 'ollama' | 'gemini' | 'endpoint';
    id: string; label: string; status: 'ok' | 'fallback' | 'error'; error?: string;
    models: Array<{
      id: string; label: string; engine: AnalysisEngine; model: string;
      contextTokens?: number; outputTokens?: number;
      structuredOutput: { mode: StructuredOutputMode; dropped: string[]; label: string };
      testPlan: { configured: number; all: number; attempts: number };
      capability?: ModelCapabilityRecord;
      offeredReasoningLevels?: string[];      // 5a
      requestControlLabelParts?: string[];    // 5b ("+ custom params", Auto disabled)
    }>;
  }>;
}
```
Status meanings: `ok`, a live listing; `fallback`, Gemini with no key or a failed listing, carrying no models (the frontend overlays its curated list); `error`, a failed Ollama or endpoint listing (endpoints stay selectable from saved settings with free-text entry). `label` is `displayName ?? model`.

### Reasoning and payload — wave 5
```ts
// server/src/analyzer/reasoning.ts (5a)
export type ReasoningLevel = 'model-default' | 'off' | 'on' | 'none' | 'minimal' | 'low' | 'medium' | 'high';
export function offeredReasoningLevels(sel: { engine: AnalysisEngine; model: string; endpoint?: { reasoningStyle: string }; record?: { reasoning: Partial<Record<string, 'accepted' | 'rejected'>> } }): ReasoningLevel[];
export function testableReasoningLevels(sel: …): ReasoningLevel[];
export function reasoningWireFragment(kind: TransportKind, sel: { model: string; endpoint?: { reasoningStyle: string } }, level: ReasoningLevel): Record<string, unknown>;
export const GEMINI_REASONING_TABLE: ReadonlyArray<{ match: RegExp; control: 'thinkingLevel' | 'gemmaOnOff'; levels: ReasoningLevel[]; defaultLevel?: ReasoningLevel }>;   // P9 retired: 2.5 and unknown ids match no row → model default only. defaultLevel = the documented default (3.8/3.7 and 3.6/3.5 Flash medium; gemini-3-flash-preview high, its own row or an override; 3.5/3.1 Flash-Lite minimal; 3.1 Pro high); it gates overflow fixes only, never the wire
export function defaultReasoningLevel(engine: AnalysisEngine): ReasoningLevel;   // replaces 3c's defaultReasoningKey (Ollama 'off', others 'model-default')
export function geminiRequestThinks(model: string, level: ReasoningLevel | undefined): boolean;   // P27: id rule for the default; a level that turns thinking on/off overrides it
// Ollama reasoning keys and capability-record lookups use normalizeModelTag, moved (body unchanged) into the import-free
//   server/src/analyzer/ollama-tag.ts beside entryForModelTag (ollama-settings.ts re-exports it); frontend mirror normalizeOllamaTag
//   is pinned to a shared fixture. capabilityRecordKey(modelId) normalises record keys; withNormalizedOllamaReasoningKeys(map) normalises saves.
// A level that turns thinking on carries includeThoughts inside its Gemini wire fragment (P19, P27).
// errors.ts (5a): AnalyzerReasoningUnavailableError(modelId, level, engine, when: 'before-start' | 'mid-run' = 'before-start') — a stored level no longer offered (or an unknown stored value); refused in runAnalyzerPreflight and
//   generateVoiceStylePersona before any call; reasoningWireFragment throws it with 'mid-run' for a value that reaches a call (N10; modelId is then the transport's model name).
//   Maps to `analyzer-request-rejected`: "was not started" copy before start, "stopped" copy mid-run. No new FailureCode.
// server/src/analyzer/runner/extra-params.ts (5b)
export const PROTECTED_KEYS: Record<TransportKind, readonly string[]>;
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]>;   // ollama: options; gemini: config; openai: chat_template_kwargs
export function validateExtraParams(kind: TransportKind, params: unknown, ctx: { reasoningStyle?: string }): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };
export function mergeExtraParams(kind: TransportKind, native: Record<string, unknown>, params: Record<string, unknown> | undefined, ctx?: { reasoningStyle?: string }): Record<string, unknown>;  // re-applies filterStoredPayload (P17)
export const GEMINI_CONFIG_ALLOWLIST: readonly string[];   // temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed, safetySettings (P16)
export function filterStoredPayload(kind: TransportKind, params: Record<string, unknown> | undefined, ctx?: { reasoningStyle?: string }): { value: Record<string, unknown> | undefined; dropped: string[] };  // drops protected and prototype keys (names logged, never values)
export function payloadOutputCap(kind: TransportKind, params: Record<string, unknown> | undefined): number | null | undefined;   // P19: null = payload removes the cap; feeds resolveCapacity / requestMaxOutputTokens; endpoints also recognise n_predict
export function payloadSecretValues(params: Record<string, unknown> | undefined): string[];    // string values ≥ 8 chars, passed per request to that request's redaction (P29), never global
export function payloadOutputCapKey(kind: TransportKind, params: Record<string, unknown> | undefined): string | undefined;  // names the payload key that set the cap (overflow copy)
export function withoutPayloadOutputCap(kind: TransportKind, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined;  // 5b (A4): params minus every output-cap key; the persona free-text request sends this
// server/src/workspace/analyzer-request-controls.ts (5a, widened 5b):
export interface StoredRequestControls { analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> }; analyzerExtraParamsByEngine?: { ollama?: Record<string, unknown>; gemini?: Record<string, unknown> } }  // 5b adds the payload map
export function changedRequestControls(patch: unknown, stored: StoredRequestControls): unknown;  // N6: the patch minus reasoning entries equal to the stored ones (Ollama keys through normalizeModelTag) and minus engine payloads whose JSON equals the stored one; a patch with neither map is returned as the same object; the PUT validates the result
// capabilities leaf (5a): sameServer (moved, body unchanged) + mergeCapabilityRecords(existing, probed) — a Test merges probed verdicts for the same server URL and the same `digest` (A2: a digest that differs, or is present on one side only, replaces the record);
//   each merged verdict keeps its own verdictTestedAt, a verdict with none taking its record's testedAt. Endpoints have no digest: a remapped model is caught on its first refused call (`analyzer-request-rejected`).
export function stripPayloadTemperature(kind: TransportKind, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined;  // kind: temperature's container differs per transport
export function payloadControlsOutputCap(kind: TransportKind, params: Record<string, unknown> | undefined): boolean;
export function redactPayloadValues(text: string, params: unknown): string;
// server/src/workspace/analyzer-request-controls.ts (5a/5b): write-time validation of engine-level reasoning levels and payloads (general PUT route).
// Endpoint reasoning / extraParams are validated in parseEndpointInput(input: unknown, stored?: AnalyzerEndpoint) (server/src/workspace/analyzer-endpoints.ts), which 5a/5b un-refuse (P23);
//   applyUpdate passes the stored endpoint, and an update judges the level (5a) and the payload (5b) only when that value or reasoningStyle differs from it (A7, the N6 rule);
//   openAIRequestSettings(endpoint, servedOutputLimit?) carries reasoning (5a) and extraParams (5b); its cap is
//   requestMaxOutputTokens('openai', extraParams, () => resolveEndpointMaxOutputTokens(...)).
```

### Fallback — wave 3d
```ts
// server/src/analyzer/fallback-target.ts (3d, P30)
export type AnalyzerFallbackTarget = 'off' | 'local' | 'gemini' | string;
export function resolveAnalyzerFallbackTarget(): 'off' | 'local' | 'gemini' | string;   // env → saved override → only when the knob's source is default: getResolvedAllowCloudFallback() === false → 'off' → default 'gemini'
export function fallbackTargetSaveError(value: string, saved: { endpointIds: readonly string[]; geminiKey: boolean }): string | null;   // refuses keyless 'gemini' and an unsaved endpoint; PUT /api/config → 400 { error }, PUT /api/user/settings → 400 { error, issues: [{ path: ['configOverrides', 'analyzer.fallback.target'], message }] }
// server/src/analyzer/index.ts (3d, P30)
export function fallbackSelectionFor(primary: AnalyzerSelection): AnalyzerSelection | null;   // null when the primary is gemini, or the target is off, gemini with no key, local with a local primary, the endpoint primary itself, or a missing endpoint (warns; the runtime is authoritative); selectAnalyzer wraps FallbackAnalyzer(primary, target) only when non-null
export function fallbackNames(primary: Pick<AnalyzerSelection, 'engine' | 'model'>, target: Pick<AnalyzerSelection, 'engine' | 'model'>): { primary: string; target: string };   // reads endpoint names from saved settings, never a key
export function fallbackReasonFor(err: AnalyzerUnreachableError, names?: { primary: string; target: string }): string;   // `Ollama unreachable (<model>) — switched to <target>`; bare cause without names
// new FallbackAnalyzer(primary, fallback, names?) — all eight methods announce through one private switchTo
// server/src/analyzer/capabilities.ts (3d, P30) — runAnalyzerPreflight's per-target body, moved here: index.ts importing preflight.ts would close preflight → select-analyzer → index
export function assertAnalyzerTargetUsable(target: { modelId: string; source: 'env' | 'run-pick' | 'settings'; engine: AnalysisEngine }, settings: UserSettings, digest?: string): void;
// server/src/config/types.ts (3d, P10)
export type KnobType = 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'device' | 'analyzer-engine';
// src/lib/types.ts (3d, P10): KnobDescriptor.type includes 'analyzer-engine'
// src/lib/analyzer-engine-options.ts (3d; wave 4 reuses these unchanged)
export interface AnalyzerEngineOption { value: string; label: string }
export function endpointModelOptions(catalog: AnalyzerCatalog): AnalyzerEngineOption[];
export function analyzerEngineOptions(staticValues: readonly string[], endpointModels: readonly AnalyzerEngineOption[], current: string): AnalyzerEngineOption[];
// OverrideRowProps.analyzerEndpointModels?: AnalyzerEngineOption[]  — every type: 'analyzer-engine' row renders a <select>
```
- **Knob:** `analyzer.fallback.target` (env `ANALYZER_FALLBACK_TARGET`), group `analyzer-models`, label `Analyzer fallback`, knob type `'analyzer-engine'` (P10, introduced here), `options: ['off', 'local', 'gemini']`.
  - **Values:** `off` / `local` / `gemini` / `openai:<endpointId>::<model>`. Default `gemini`.
  - **Id regex:** `pattern: /^(off|local|gemini|openai:[a-z0-9-]{1,40}::.+)$/`, the only knob regex that admits `off`.
  - **Ships with:** its Settings row, `.env.example` line, `config:sync`, and a row in `Advanced-Settings.md` §4 (P33).

### Persona — wave 4
- **`server/src/analyzer/voice-style.ts`:** `resolvePersonaSelection()` and `personaSharesGpu()` replace `resolvePersonaEngine()`.
- **Knob:** `analyzer.personaGeneration.engine` becomes knob type `'analyzer-engine'`, introduced in 3d for the fallback target (P10, P30).

### Routes (OpenAPI operationIds)
| Method + path | operationId | Wave | Mock? |
|---|---|---|---|
| `POST /api/analyzer/endpoints` | `createAnalyzerEndpoint` | 3b | yes |
| `PUT /api/analyzer/endpoints/{endpointId}` | `updateAnalyzerEndpoint` | 3b | yes |
| `DELETE /api/analyzer/endpoints/{endpointId}` | `deleteAnalyzerEndpoint` | 3b | yes |
| `PUT /api/analyzer/endpoints/{endpointId}/key` | `putAnalyzerEndpointKey` | 3b | yes |
| `POST /api/analyzer/endpoints/detect-context` | `detectAnalyzerEndpointContext` | 3b | **no** (local-machine exception; standalone frontend export) |
| `GET /api/analyzer/models?refresh=1` | `getAnalyzerModels` | 3c | yes |
| `POST /api/analyzer/models/preview` | `previewAnalyzerEndpointModels` | 3c | yes |
| `POST /api/analyzer/models/test` | `testAnalyzerModel` | 3c | yes |
| `POST /api/user/settings/dropped-endpoint-entries/acknowledge` | `acknowledgeDroppedEndpointEntries` | 3b | yes |

Router files: `server/src/routes/analyzer-endpoints.ts` (CRUD, key, detect) and `server/src/routes/analyzer-models.ts` (catalog, preview, test). The acknowledge route joins `server/src/routes/user-settings.ts`, beside the settings GET that exposes `droppedEndpointEntries` (P31).

Client (3b): the account-slice endpoint thunks `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint` and `saveAnalyzerEndpointKey` (`src/store/account-slice.ts`) are typed `{ rejectValue: AnalyzerEndpointRejection }`, where `AnalyzerEndpointRejection` is `{ error: string; code: string; issues: { path: string[]; message: string }[] }`. They reject via `rejectWithValue({ error, code, issues })`, so `.unwrap()` keeps `issues` for the form's inline display; plain `createAsyncThunk` serialisation would drop them.

## Wave → PR map

| PR | Delivers | Branch | Gate before merge |
|---|---|---|---|
| 1a | characterisation tests, errors + types leaf, helper moves breaking the ollama↔gemini cycle | `refactor/server-3084-w1a-characterise` | wave 0 merged |
| 1b | transports, retry policies, stage runner, `<think>` strip | `refactor/server-3084-w1b-runner` | 1a merged |
| 2a | pinning capture, capacity model (no behaviour change) | `refactor/server-3084-w2a-capacity` | 1b and #3199 merged |
| 2b | Gemini catalog, Auto max output, thought summaries + thinking window + request ceiling (P5, P26, P27), TPM-bound input cap with `analyzer.gemini.maxInputTokensPerRequest`'s max lifted to 1 000 000 (P32), reasoning overflow (stops new spend, P20) with actionable `fixes`, router focus and the Analyzer wiki overflow section (P34) | `feat/server-3084-w2b-output-cap` | P5 and P20 approved by the owner — **satisfied 2026-09-13** |
| 3a | engine union, id grammar, selection-id sites, `'local'` classification | `refactor/server-3084-w3a-engine-ids` | 2b merged (#3201 already is, in `4a545750`) |
| 3b | endpoint storage + keys + CRUD + Detect, save-time endpoint validation + `droppedEndpointEntries` + acknowledge route (P25, P31), OpenAI transport, adapters, structured-output knobs, failure codes, endpoint overflow fixes (P34) | `feat/server-3084-w3b-endpoints` | 3a merged |
| 3c | catalog + preview, limiter map + gemma migration, endpoint capacity, Test action, pre-run checks | `feat/server-3084-w3c-catalog-test` | 3b and #3163 merged |
| 3d | GPU card picker, guards, in-flight, eviction, fallback target in Advanced Settings (P30, with the `'analyzer-engine'` knob type, P10), dropped-entry banner (P31), selection, Settings UI, pickers, endpoint-editor fix deep link (P34), endpoints wiki page (P33), privacy help topic (P30) — **endpoints become selectable** | `feat/server-3084-w3d-selectable` | 3c merged |
| 4 | persona generation through transports (reuses 3d's `'analyzer-engine'` knob type, P10) | `feat/server-3084-w4-persona` | 3d merged |
| 5a | reasoning levels, control styles, Test reasoning, reasoning-level overflow fixes (P34), wiki reasoning style per server (P33) | `feat/server-3084-w5a-reasoning` | 4 merged |
| 5b | custom payload, payload overflow fix (P34), wiki custom payload examples per server (P33) (`Closes #3084`) | `feat/server-3084-w5b-payload` | 5a merged |

**On-box acceptance** is owed after the listed PRs. Each row is recorded in the shipping PR and does not block its merge.

| PR | Row |
|---|---|
| 1b | real-daemon telemetry and a real Gemini stream through the transports |
| 2b | thinking-model output; capacity recalibration |
| 3b | Ollama structured-output modes; Gemini `schema` mode |
| 3c / 3d | live structured output (Test action vs a real chapter); long silent prefill; same-card eviction |
