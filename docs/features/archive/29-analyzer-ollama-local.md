---
status: stable
shipped: 2026-05-14
owner: null
---

# Local Ollama analyzer + Gemini fallback (`ANALYZER=local`)

> Status: stable, KNOWN: operational dependency (Ollama daemon must be running)
> Key files: `server/src/analyzer/ollama.ts`, `server/src/analyzer/index.ts`, `server/src/routes/ollama-health.ts`, `server/src/workspace/user-settings.ts`
> URL surface: indirect (`#/books/:bookId/analysing`)
> OpenAPI ops: `POST /api/manuscripts/:id/analysis`, `GET /api/ollama/health`

## What this covers

Default analyzer mode (`ANALYZER=local`, set by `.env.example`). Routes analysis through a local Ollama daemon on `:11434` running `qwen3.5:9b` (recommended). When `GEMINI_API_KEY` is set, the primary `OllamaAnalyzer` is wrapped in a `FallbackAnalyzer` decorator that delegates to the existing `GeminiAnalyzer` **only when the daemon is unreachable** — every other error type (HTTP, validation, schema) propagates and hard-fails.

Cross-link: when fallback fires, control passes to plan [06 — Gemini analyzer](06-analyzer-gemini.md). That doc covers the Gemini side; this doc covers the local primary and the fallback policy.

## Invariants to preserve

- Activated by `ANALYZER=local` (default in `.env.example`). Reading `getResolvedAnalysisEngine()` in `user-settings.ts` consults cached user-settings → env → `'local'`. Legacy `ANALYZER=manual` (the historical file-drop value) is coerced to `'local'` for forward compat.
- `OLLAMA_URL` env / user-settings `ollamaUrl` defaults to `http://localhost:11434`. Resolved at request time (no restart needed after a settings save). The Ollama **model tag** is not a separate setting — `defaultAnalysisModel` from the top "Analysis model" picker doubles as the Ollama tag when it has Ollama shape (contains `:`); `getResolvedOllamaModel()` enforces this, falling back to `OLLAMA_MODEL` env then `qwen3.5:9b` only when `defaultAnalysisModel` is a Gemini-shape id.
- `OllamaAnalyzer.runStage*` calls `POST /api/chat` with `format: <JSON Schema>` (per-stage Zod schema run through `zod-to-json-schema` with `$refStrategy:'none'` — Ollama 0.5+ constrained decoding), `stream: true`, `keep_alive: keepAliveFor(model)`, `think: false`, and a per-model `options.num_ctx` (16K in current code). The schema-mode format is load-bearing: the sampler can only emit tokens that keep the output a valid prefix of a value matching the schema, which eliminates "malformed JSON at byte N" on smaller models. The validation-retry loop still guards against semantic violations the schema can't express.
- Stage-1 + stage-2 responses are validated against the **same** Zod schemas (`server/src/handoff/schemas.ts`) as the Gemini analyzer. Validation-retry policy is identical: one retry feeding errors back as a follow-up turn before hard-failing.
- **Pre-validation JSON repair pipeline is shared** with the Gemini analyzer via `parseAndValidate` in `server/src/analyzer/gemini.ts` — see [06 — Gemini analyzer](06-analyzer-gemini.md#invariants-to-preserve) for the four classes of malformed output that get rescued (fences, unescaped dialogue quotes, trailing prose, single-token punctuation gaps). Deeply-truncated payloads (3+ unclosed containers) stay unparseable so the invalid-json retry policy correctly drops the broken assistant turn and bumps temperature (`ollama.ts:352`) instead of replaying a half-rescued skeleton.
- `LocalUnreachableError` is the SOLE trigger for the `FallbackAnalyzer` decorator. Cases that throw it: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `UND_ERR_SOCKET` (Node undici codes), bare `TypeError: fetch failed`, and `AbortError` BEFORE first byte. Everything else (HTTP non-2xx, mid-stream abort, validation failure) → plain `Error`, no fallback.
- The fallback is configured iff `GEMINI_API_KEY` is set AND `ANALYZER=local`. Without the key, bare `OllamaAnalyzer` is used and surfaces `LocalUnreachableError` to the UI verbatim — the user is expected to start the daemon or set a key.
- `GET /api/ollama/health` envelope mirrors `GET /api/sidecar/health`: `{status: 'reachable'|'unreachable', url, error?, models?, expectedModel?, modelPulled?}`. 2 s probe timeout, no caching.
- Per-request `model` override on the analysis POST overrides whichever engine is selected: on local, sets Ollama tag; on gemini, sets Gemini model id. The route layer doesn't try to be smart about engine mismatch — UI is responsible for sending coherent values.

## Acceptance walkthrough

Pre-flight (one-time): install Ollama for Windows, then `ollama pull qwen3.5:9b`. Confirm `curl http://localhost:11434/api/tags` returns JSON listing the model.

1. **Happy path (local)** — `cd server && npm run dev`. Upload canonical manuscript `server/src/__fixtures__/the-coalfall-commission.md` → run analysis. SSE label reads `Engine: Ollama (qwen3.5:9b)`, chunks arrive every 1–3 s, schema-valid output. `nvidia-smi` shows ~6.6 GB resident in `ollama_llama_server.exe` for ~5 min after completion, then released by the keep-alive timer.
2. **Fallback path** — `taskkill /F /IM ollama.exe` (or `ollama stop`). With `GEMINI_API_KEY` set, re-run analysis on a fresh manuscript. The server log shows `LocalUnreachableError` caught by `FallbackAnalyzer`, then Gemini progression. UI surfaces the engine switch.
3. **Hard-fail path** — Restart Ollama then `ollama rm qwen3.5:9b`. Re-run. UI surfaces "Ollama responded but model not found" verbatim (404 body); fallback is **not** fired. This is the load-bearing distinction — a reachable daemon with a bad config must not silently burn Gemini quota.
4. **VRAM contention** — After confirming a chapter analysis, immediately trigger XTTS generation. Ollama (6.6 GB) plus XTTS (~3–4 GB) exceeds 8 GB so Ollama must evict before XTTS finishes loading. `nvidia-smi` shows the swap. Acceptable — the pipeline is sequential.
5. **Schema regression** — If the model emits valid JSON that fails Zod (e.g. forbidden `additionalProperties`), the validation-retry loop fires once. On second failure, stream surfaces `{kind:'error', code:'schema-validation', detail:<issues>}`. Same shape as Gemini.
6. **Engine toggle via UI** — Open Account → Server configuration → Analyzer engine. Flip to Gemini, save. Re-run analysis; SSE label now reads a Gemini model. Flip back to Local; next analysis goes through Ollama again. No server restart required.
7. **Model pick is single-sourced** — Account → Defaults for new books → Analysis model lists both Local (Ollama tags like `qwen3.5:9b`) and Gemini ids grouped via `<optgroup>`. Pick a local tag, save; the server uses that tag for Ollama. There is **no** separate "Ollama model" text field — the top picker is the only model-selection surface, and `getResolvedOllamaModel()` derives the tag from it.
8. **Health probe** — `curl http://localhost:8080/api/ollama/health` returns `{status:'reachable', models:[…], expectedModel:'qwen3.5:9b', modelPulled:true}` when up; `{status:'unreachable', error:'…'}` when down. Same 2 s budget as the sidecar probe.

## Ship notes

- 2026-05-14 (`a229b6c`): "Fix qwen3.5:4b malformed-JSON failures: schema format, divergent retry, quote-escape repair". JSON-schema-mode structured output landed via `zod-to-json-schema` (server `package.json`) feeding per-stage Zod schemas into Ollama 0.5+'s `format:` field as a JSON Schema — replaced the prior `format:'json'` string-only constraint. The sampler is now constrained at decode time; the validation-retry loop still runs but covers only semantic violations the schema can't express.

## Out of scope

- Auto-installing Ollama or auto-pulling models: README addendum only. The repo sits under OneDrive; installer/pip steps are fragile and require explicit user opt-in.
- Hosting the LLM and TTS in one Python sidecar: deliberately not done. Ollama is its own daemon. Both are unified at the Node + UI layer only.
- Mid-stream engine swap: once a chapter starts on local, it finishes on local (or hard-fails). Fallback fires per chapter-start, not mid-chunk.
- Retrying Ollama HTTP 5xx: unlike Gemini, a stuck local model won't recover from a 3 s sleep. Surface the error.
