# OpenAI-Compatible Analyzer Endpoints

An **analyzer endpoint** is a server that speaks the OpenAI Chat Completions API: llama.cpp,
llama-swap, LM Studio, vLLM, LiteLLM or OpenRouter. Castwright can analyse a book on it instead
of the local Ollama daemon or the Gemini API.

Use an endpoint when:
- you already serve models with one of these tools and want Castwright to use them;
- the model you want is not in Ollama, or runs better on your server;
- the server is another machine on your network, or a paid gateway.

Keep local Ollama when you want Castwright to manage the model for you, and Gemini when you have no
GPU to spare. See [Analysis & the Analyzer](Analysis-and-the-Analyzer).

Add one in **Admin → Model Manager → Analyzer endpoints**. Its models then appear in every
analysis-model picker as `<endpoint name> · <model>`.

## The fields

| Field | What to enter |
|---|---|
| Name | Any label. The endpoint id is made from it (lowercase letters, digits and `-`, up to 40 characters) and never changes. |
| Base URL | The OpenAI-compatible root, usually ending in `/v1`. Each server's value is below. |
| API key | Optional. The key is bound to the base URL's **origin** (scheme, host and port) and is only sent there. Change the host or port and Castwright asks for the key again; tick "This server needs no key" if it has none. |
| Model | Picked from the list, and saved everywhere as `openai:<endpointId>::<model>`, for example `openai:lab::qwen3-30b`. If the list is empty, type the model id under the endpoint's row. |
| Context size | **Required.** The context the server actually serves per request, not the model's training context. **List models** fills it from served values (`max_model_len`, then `meta.n_ctx`, then `context_length`); **Detect** reads llama.cpp or llama-swap `/props`. |
| GPU card | `none` (a remote or CPU server), `any` (treated as sharing every card) or `cuda:N`. A `localhost`, `127.0.0.1` or `::1` base URL starts at `any`, anything else at `none`. Castwright uses it to ask before analysing on the card your voices use, and to unload this server when a voice model needs that card's memory. |
| Unload URL | Optional, same host and port as the base URL. Castwright sends it a POST to free the card for a voice model, once for each model that has served a request since Castwright started; `{model}` is replaced by that model. **Without `{model}` it unloads every model on that server**, including one that another card or app is using. |
| Concurrent requests | 1–16. Match the server's parallel slots. |
| Request ceiling | 1–240 minutes, default 30: the longest one request may run after it leaves the queue. |
| Structured output | `schema` sends Castwright's output schema; `json` asks for any JSON object; `off` sends neither. **Test** shows what a model really does. |
| Max output tokens | `0` is Auto: the server's listed output limit, or context minus input. |
| Max input tokens per request | Optional. When set, chunks are sized to fit it (see "Chunk size" below). |

## Servers

Every command and file below was checked against the tool's documentation on the date under it.
If your version is different, check its documentation before copying.

### llama.cpp (llama-server)

**Pick it when** you serve one GGUF model and want the fewest moving parts.

```bash
llama-server -m /models/qwen3-30b-q4.gguf -c 32768 -np 2 --host 127.0.0.1 --port 9931 --api-key sk-change-me
```
_Checked against llama.cpp server README (master) on 2026-10-17._
<!-- Source: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md — flags -m, -c/--ctx-size, -np/--parallel, --host, --port, --api-key. UNVERIFIED: the exact build number; the README is not versioned and no usable build tag was returned. -->

- **Base URL:** `http://127.0.0.1:9931/v1`. The README's default port is `9931` (`--port`, env `LLAMA_ARG_PORT`); older builds and many guides use `8080`, so use whatever you passed to `--port`.
- **API key:** `--api-key <key>` or `LLAMA_API_KEY` (comma-separated for several keys). The server reads `Authorization` (with or without `Bearer `) or `X-Api-Key`; a wrong key answers 401. `/props` and `/v1/models` need the key; `/health` does not. <!-- planning facts §B6; README --api-key / LLAMA_API_KEY, /health public, checked 2026-10-17 -->
- **Context size:** the per-slot served context: `/props` → `default_generation_settings.n_ctx`, or `/v1/models` → `data[].meta.n_ctx`. Never `meta.n_ctx_train`, which is the training context. With `-c 32768 -np 2` each slot serves less than 32768. **Detect** with flavor llama.cpp reads it. <!-- §B2 -->
- **GPU card:** the card llama-server runs on, as `cuda:N`.
- **Unload URL:** none — llama-server serves the model it was started with, and its README documents no unload endpoint. <!-- README checked 2026-10-17: no unload endpoint documented -->
- **Structured output:** `schema`, then run **Test**. Schema enforcement while a model is thinking cannot be assumed: ggml-org/llama.cpp#20345 was closed by a fix, and later reports say it recurs on Qwen3.6 and gpt-oss. <!-- §B5 -->
- **Pitfalls:**
  - A request waiting for a busy slot gets no reply headers until a slot frees. It counts against the request ceiling and fails as a timeout, not as unreachable. Set **Concurrent requests** to the server's slot count. <!-- §B1 -->
  - 401: the key is missing or wrong. Re-enter it on the endpoint.

### llama-swap

**Pick it when** several models share one or more cards and should load on demand.

```yaml
apiKeys:
  - "sk-change-me"

models:
  "qwen3-30b":
    cmd: |
      llama-server --port ${PORT}
      --model /models/qwen3-30b-q4.gguf
      --ctx-size 32768
    capabilities:
      context: 32768
```
_Checked against llama-swap v265 on 2026-10-17._
<!-- Source: https://github.com/mostlygeek/llama-swap/blob/main/docs/config.example.yaml (apiKeys, models.<id>.cmd with ${PORT}, capabilities.context). Release tag v265, published 2026-10-14. -->

- **Base URL:** `http://127.0.0.1:8080/v1`. llama-swap listens on `0.0.0.0:8080` unless you set `-listen` or `LLAMA_SWAP_LISTEN`. <!-- README install table: LLAMA_SWAP_LISTEN default 0.0.0.0:8080, checked 2026-10-17 -->
- **API key:** `apiKeys` in the config. Sent as `Authorization: Bearer`, a Basic password or `x-api-key`. Inference, `/v1/models`, `/unload`, `/upstream/*` and `/api/*` need it; `/health` does not. With the list empty, authorization is not checked. <!-- §B9; config.example.yaml 2026-10-17 -->
- **Context size:** set `capabilities.context` in the config; llama-swap then lists it as `context_length`, `context_window` and `meta.n_ctx`. Its current example config also says an unset capability is filled in from the upstream server when the model becomes ready (llama-server and vLLM), but treat the value you declare as the one you control. Or use **Detect** with flavor llama-swap and a model: that calls `GET /props?model=<id>`, which **loads the model**, so Castwright asks first. <!-- §B7, §B10. config.example.yaml on 2026-10-17 describes auto-fill from the upstream, which §B10 (commit 41ec321b) did not; reported in the completion comment. -->
- **GPU card:** the card the models run on. If models run on different cards, add one endpoint per card, each with its own models, or use `any`.
- **Unload URL:** `http://127.0.0.1:8080/api/models/unload/{model}` unloads one model (200, or 404 if it is not loaded). `POST /api/models/unload` and `GET /unload` unload **every** model: do not use them on a shared server. Each call waits until the process stops, and needs the key when `apiKeys` is set. <!-- §B8; README lists POST /api/models/unload and POST /api/models/unload/:model_id, checked 2026-10-17 -->
- **Structured output:** as llama.cpp: `schema`, then **Test**.
- **Pitfalls:** List models shows no context when `capabilities.context` is not set and the upstream does not report one; add it or Detect.

### LM Studio

**Pick it when** you manage models in the LM Studio app.

```bash
lms server start --port 1234
lms load qwen/qwen3-30b-a3b --context-length 32768
```
_Checked against LM Studio docs (lms CLI; API tokens need 0.4.0 or newer) on 2026-10-17._
<!-- Sources: https://lmstudio.ai/docs/cli/serve/server-start , https://lmstudio.ai/docs/cli/local-models/load , https://lmstudio.ai/docs/developer/core/authentication . UNVERIFIED: the installed app version; the model key above is an example, use `lms ls` for yours. -->

- **Base URL:** `http://127.0.0.1:1234/v1` (the docs' examples use port 1234; `lms server start` without `--port` reuses the last port). You can also start the server from the app: Developer tab → **Start server**. It binds to `127.0.0.1` unless you pass `--bind 0.0.0.0`.
- **API key:** off by default. If you turn on authentication in Developer → Server Settings, create a token under **Manage Tokens** and enter it as the key; otherwise tick "This server needs no key". Tokens need LM Studio 0.4.0 or newer.
- **Context size:** the loaded context, `/api/v1/models` → `loaded_instances[].config.context_length` (the model must be loaded). `/api/v0/models` → `max_context_length` is the model's maximum, not what is loaded. <!-- §B13 -->
- **GPU card:** the card LM Studio loads onto.
- **Unload URL:** none usable. LM Studio unloads with `POST /api/v1/models/unload` and a JSON body `{"instance_id": …}`, and Castwright's Unload URL sends no body, so leave it empty. <!-- https://lmstudio.ai/docs/developer/rest/unload checked 2026-10-17 -->
- **Structured output:** `schema` or `off`, **never `json`**: LM Studio answers `response_format: {"type": "json_object"}` with 400 `'response_format.type' must be 'json_schema' or 'text'` (reported through 0.4.21). <!-- §B13 -->

### vLLM

**Pick it when** you serve a model with high throughput on a Linux GPU box.

```bash
vllm serve Qwen/Qwen3-30B-A3B --max-model-len 32768 --api-key token-abc123
```
_Checked against vLLM v0.31.0 docs on 2026-10-17._
<!-- Sources: https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md (`vllm serve … --api-key token-abc123`), docs/getting_started/quickstart.md (default http://localhost:8000, --host/--port, --api-key / VLLM_API_KEY). Release tag v0.31.0. UNVERIFIED: `--max-model-len` was not found in the docs pages read; it is the engine argument behind /v1/models max_model_len (§B11) — confirm with `vllm serve --help`. -->

- **Base URL:** `http://127.0.0.1:8000/v1`. The server starts on `http://localhost:8000` unless you pass `--host` and `--port`.
- **API key:** `--api-key <key>` or the `VLLM_API_KEY` environment variable; several keys are accepted for rotation. vLLM's own security notes say the key does not protect every endpoint, so do not expose the server to an untrusted network on the strength of it.
- **Context size:** `/v1/models` → `max_model_len`, the served length. **List models** fills it. <!-- §B11 -->
- **GPU card:** the card(s) vLLM uses; `any` if it spans several.
- **Unload URL:** none: vLLM hosts one model per server process and documents no unload endpoint.
- **Structured output:** `schema`, then **Test**.
- **Pitfalls:** a small `max_model_len` leaves little room for output; a 400 naming a token limit during **Test** is recorded as inconclusive, never as "rejected".

### LiteLLM

**Pick it when** one gateway fronts several providers or local servers.

```yaml
model_list:
  - model_name: qwen3-30b
    litellm_params:
      model: openai/qwen3-30b
      api_base: http://127.0.0.1:9931/v1
      api_key: "os.environ/BACKEND_API_KEY"

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```
_Checked against LiteLLM 1.105.1 on 2026-10-17._
<!-- Sources: https://docs.litellm.ai/docs/proxy/configs (model_list / litellm_params / general_settings.master_key, `litellm --config /path/to/config.yaml`, "RUNNING on http://0.0.0.0:4000"); version from PyPI. UNVERIFIED: the `openai/<name>` provider prefix for an OpenAI-compatible backend comes from LiteLLM's provider docs, not the page read. -->

Start it with `litellm --config /path/to/config.yaml`.

- **Base URL:** `http://127.0.0.1:4000/v1` (the proxy's startup line reads `RUNNING on http://0.0.0.0:4000`).
- **API key:** the proxy's `master_key` (`general_settings.master_key`), sent as a Bearer token.
- **Context size:** your **backend's** served context. LiteLLM's `/v1/models` may list `max_input_tokens` / `max_output_tokens` from LiteLLM's own catalogue, not from the backend: do not copy those. <!-- §B14 -->
- **GPU card:** the backend's card if the backend runs on this machine, otherwise `none`.
- **Unload URL:** none: the unload URL must share the gateway's host and port.
- **Structured output:** depends on the backend; run **Test**.

### OpenRouter

**Pick it when** you want hosted models with no GPU of your own.

- **Base URL:** `https://openrouter.ai/api/v1`. <!-- https://openrouter.ai/docs/api-reference/overview: chat completions at https://openrouter.ai/api/v1/chat/completions, Authorization: Bearer; checked 2026-10-17 -->
- **API key:** your OpenRouter key, bound to `https://openrouter.ai`.
- **Context size:** `/api/v1/models` → `context_length`, and `top_provider.context_length`; **List models** fills it. <!-- §B12; live response on 2026-10-17 carries both fields -->
- **GPU card:** `none`. **Unload URL:** none.
- **Max output tokens:** `top_provider.max_completion_tokens` is the provider's limit. <!-- §B12; live response on 2026-10-17 -->
- **Pitfalls:** an output cap larger than what is left of the context is a 400; **Test** records it as inconclusive, and a run shows which limit to lower.

## Fallback

- When this endpoint cannot be reached (connection refused, host not found, or no connection
  within the connect timeout), Castwright hands that call, one hop, to **Advanced Settings →
  Analyzer fallback**: `off`, `local` (the Ollama model a local run uses, shown in the setting), `gemini` (the default; needs a
  Gemini API key) or another endpoint model.
- Once a run has fallen back, **every later call that would have gone to that endpoint model stays on the fallback**,
  in either phase, even if the server comes back. A second model on the same server (llama-swap, for example) is its own
  model, so it tries the server itself; a phase on another endpoint model, or on Gemini, keeps its own. When the failed
  primary is a local Ollama model, every later Ollama call switches, whatever its model. The next analysis you start tries your server again.
- A reply that breaks off mid-stream, a reset or a proxy's 502 is **retried**, never a fallback.
- The fallback is never itself wrapped. If it is unreachable too, the run fails naming both.
- The switch is always announced, for example
  `OpenAI endpoint Lab · qwen3-30b unreachable — switched to Gemini (gemini-3.5-flash-lite)`.
- Saving a fallback that names a missing endpoint, or `gemini` with no key, is refused. An endpoint
  the fallback names cannot be deleted until the fallback changes.
- An install that turned the old Model Manager "Cloud fallback" switch off reads as `off` until you
  choose a target.

## Chunk size

Castwright splits each chapter so a request fits the endpoint:

- each stage's chunks are at most **its input fraction × Context size × 2 characters per token**,
  capped by that pass's ceiling;
- **Max input tokens per request**, or the endpoint model's TPM limit in Advanced Settings →
  Analyzer rate limits (whichever is smaller), lowers that further.

The inputs are the endpoint's **Context size** and **Max input tokens per request**, and Advanced
Settings → Analyzer chunking (`analyzer.stage1.localInputFraction`,
`analyzer.stage2.localInputFraction`, `analyzer.stage1.chunkCharBudget`,
`analyzer.stage2.chunkCharBudget`). All of them can be changed at any time.

## When a model thinks past its output limit

**What you see:** the run stops with `analyzer-reasoning-overflow`. The model spent its whole output
budget thinking and gave no answer. Castwright starts no new model calls; chapters already running
finish and are kept.

**Fix:** the failure's "How to fix" links open these settings:

1. Raise the endpoint's **Max output tokens**, or set it to `0` (Auto). It cannot exceed what the
   server allows.
2. Check **Context size** matches what the server serves: more context leaves more room for output.
3. Lower the stage input fractions (Advanced Settings → Analyzer chunking), so each chunk leaves
   more room.

Then resume — finished chapters are kept.

## Voice descriptions

An endpoint's model can also write your cast's voice descriptions. Open Advanced Settings and pick it under **Persona generation engine**. It runs under the same limits as analysis, and Castwright never switches to Gemini for you. If the endpoint is missing, design fails before any request. If the endpoint runs on the same graphics card as your voices and can't be reached, design stops once and says so. Any other model that fails reports that failure for each character it couldn't write.

If audio generation is streaming on that card, every way of starting a design asks "Pause audio generation to design voices?" first, the same way analysis does: Design full cast, the voice-style button and Qwen auto-generate in a character's profile, Regenerate in the compare window, Propose in rebaseline, the nudge toast and the readiness gate. **Pause and design** pauses the render and starts the design once Castwright confirms the pause; if Castwright can't pause the queue, the design doesn't start and a message tells you. The question appears only when the design will write a voice description, so not for Variants only, and not when every character already has one. Pressing Escape on it is the same as **Wait** (and on the analysis question too, which shares the dialog), and it goes away if you leave the screen. A local Ollama model isn't asked, because Castwright moves it to system memory. A direct API call isn't asked either; as with analysis, only the app prompts.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `<endpoint> · <model> could not be reached: …` | Connection refused, host not found, or the connection timed out | Start the server; check the host and port. The fallback runs if one is set. |
| A 502, or "reset" in the server log | The server or a proxy failed mid-reply. Castwright retries it. | Check the server's own log. This never triggers the fallback. |
| `The API key saved for <endpoint> was entered for a different host, so it was not sent — re-enter the key for <endpoint>.` | The base URL's host or port changed after the key was saved | Re-enter the key on the endpoint. |
| A 400 naming a context, token or length limit | The output cap plus the input exceed what the server allows | Lower Max output tokens, or correct Context size. |
| `schema (partial)` beside the model | Some keywords of Castwright's output schema could not be sent to this server. Castwright still checks every reply against the full schema. | Usually fine. If replies fail validation, try `json` or a model that takes the full schema. |
| `schema (not enforced)` beside the model | **Test** found the model ignores the schema | Use `json` or `off`, or a model that enforces the schema. |
| A banner: "Some analyzer endpoint settings were malformed and were removed" | An endpoint or key entry in `user-settings.json` failed validation when settings were read. It was removed so the rest load, and copied to `user-settings.invalid-endpoints.json` | Add the endpoint again, then **Got it**. |
