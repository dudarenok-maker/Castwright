# B101 on-box evidence, Gemini half (2026-11-28, #4733, parent #4728)

Sides: **current** = this worktree at `8d1ae74a` (docs-only over `main` `ddf1b3f0`), port 8100; **base** = `802bab81` (first parent of PR #3349's merge `369b644e`) in a throwaway detached worktree on port 8131 with its own workspace (node_modules junctions removed first, worktree removed afterwards). Real free-tier Gemini key, own `USER_SETTINGS_FILE` per side, sidecar auto-start off. Book: "Chapter One — The Knock" only (`the-coalfall-commission.md` lines 7-62, 3,477 bytes, 3,445 characters, 1 chapter) imported as a scratch book per side. Driver: `POST /api/manuscripts/<id>/analysis {"model":"gemma-4-26b-a4b-it","fresh":true}`.

An observe-only `fetch` preload (`wiretap.mjs.txt`) recorded what each server sent to Gemini and what came back (no headers, so no key).

## Reasoning level (owner decision on #4723)

At Gemma's default level, `gemma-4-26b-a4b-it` on **current** overflowed: `thoughtPartsBeforeAnswer=1366`, `output truncated reason=MAX_TOKENS bytes=0`, `analyzer-reasoning-overflow` after 954 s (`sse-26b-default-current-run1.txt`). So reasoning was set to `off` on both sides:

- current: saved setting `analyzerReasoningByEngine.gemini["gemma-4-26b-a4b-it"] = "off"` (`settings-current-reasoning-off.json`); the wire carries `thinkingConfig {thinkingLevel: MINIMAL}`.
- **base: 802bab81 has no reasoning-level setting at all** (its request is only `temperature`, `maxOutputTokens`, `responseMimeType`). The same one wire field was added by a fetch preload outside the repo (`inject-off.mjs.txt`). Base is therefore not byte-for-byte what the unmodified app sends.

At the default level base does not stop at the overflow: it re-splits ("large chapter, section 1/4") and was still running after 13 min when stopped by hand (`sse-26b-default-base-run1-stopped-by-hand.txt`). `gemma-4-31b-it` at default on current: cast finished (6 characters, 4 m 12 s), attribution failed with three 503s (`sse-31b-default-current-run1.txt`).

## Runs (reasoning off, `gemma-4-26b-a4b-it`)

See `runs-summary.txt` (per run: characters, sentences, wall time, `[gemini] generate failed` lines inside the run window, throttle events). Current runs 1 and 2 overlapped base runs 1 and 2; current run 2 then hit a per-minute input-token 429 (16,000 TPM, shared key) and is listed but not counted. Every later run was sequential.

Character count: 6 in every completed run (Narrator, Oduvan, Wren, Maerin, Coalfall, Unknown male).
Attributed sentences: current 59, 60, 78, 60, 59, 78, 59, 78, 78 (9 runs); base 77, 78, 78, 78, 78 (5 runs).

## Why the sentence counts differ (what was and was not established)

`request-comparison.txt`: the system instructions are byte-identical (same hash) on both sides for cast and attribution; the cast request differs only by the book title; the attribution request differs only in the roster the cast pass returned (current lists `aliases`, base does not) and ids/title. Current sends `maxOutputTokens` 32768, base 8192. The final sentence count equals the raw model reply's sentence count (`rawSentences` in that file), so nothing after the model merges or splits sentences: the 59-60 runs are the model keeping a multi-sentence quote as one sentence (`stage2-current-run1-59.json` against `stage2-base-run1-77.json`). Two later commits, outside #3349, explain the request differences: `65ce87ce` (#4031, roster lists aliases) and `067bd821` (#3084, Gemini max output tokens default to Auto); neither is an ancestor of `369b644e`. Current itself produced 78 in four runs, so the count is not fixed by the code. Not run: `369b644e` against `802bab81`, which would isolate #3349.

## Other files

- `capacity-probes.txt`: the tiny probes before each run (503s and 200s, with times).
- `server-gemini-lines.txt`: `[gemini]` lines from the servers' stderr/stdout (this launch redirected them to scratch files instead of `logs/server.log`). Every `generate failed` line is status 503, except two 429 per-minute token-limit lines (current run 2, base run 3).
- `wire-*-requests-responses.jsonl`: per-request wire summary (generation config, status, thought/answer sizes, usage).
- `sse-*.txt`: trimmed analysis streams (log, throttle, error, result counts).
- `ui-live-run10-no-chip.png`: browser during a live Gemma run, no throttle row (no wait was active at that moment). The throttle row itself was never captured on screen.
