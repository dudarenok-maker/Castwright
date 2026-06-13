---
status: stable
shipped: 2026-05-16
owner: null
---

# 14a — Kokoro v1 TTS engine

Second local TTS engine, added 2026-05-16. Default for new accounts;
runs alongside Coqui XTTS v2 in the same sidecar process.

## Why

Coqui XTTS v2 was mid-pack on the 2026 TTS-Arena leaderboard and held
~3 GB of VRAM permanently — the analyzer Ollama and XTTS were forced
to evict each other on the user's 8 GB GPU, turning the
`ModelControlPill` into a daily friction point. Kokoro v1 delivers
higher-quality English narration at ~1 GB VRAM, fitting comfortably
alongside the analyzer, and ships under Apache-2.0 with no commercial
restrictions on the audio.

XTTS stays in the picker as an alternate so its 30-voice catalog and
zero-shot voice cloning remain available for future features (e.g. if
the cast UI ever surfaces "upload a reference clip per character").

## Invariants

1. **English-only voice surface.** The sidecar filters Kokoro's
   ~54-voice multilingual manifest to the 28 English voices
   (`af_*` / `am_*` / `bf_*` / `bm_*`) at load time. Non-English
   voice IDs must never reach the picker, the per-character override
   UI, or `GET /api/voices/base`. The filter lives in
   `server/tts-sidecar/main.py` `KokoroEngine.ENGLISH_VOICE_PREFIXES`.
   Tests pin: `server/tts-sidecar/tests/test_kokoro.py` (every
   `/speakers?engine=kokoro` response asserted to contain exactly 28
   af/am/bf/bm-prefixed entries).

2. **Quality config is fixed, not user-tunable.** ONNX runtime with
   CUDA execution provider (CPU fallback), fp32 weights, `speed=1.0`,
   native 24 kHz output. No `KOKORO_HALF` / `KOKORO_QUANTIZE` env knobs
   — quality is the goal and thrift knobs invite future degradation
   debates we don't want.

3. **Eagerly preloaded on sidecar startup, with a user-facing Stop.**
   The eager-preload hook in `server/tts-sidecar/main.py` warms Kokoro at
   sidecar startup (~1 s cold load, ~1 GB VRAM) so the first `/synthesize`
   call is hot. Kokoro now has its own in-app Load/Stop pill in the top
   bar — a user who wants to free the 1 GB (e.g. to make headroom for a
   long Coqui run) can click Stop without restarting the sidecar; the
   pill flips to "Kokoro idle / Load" and a subsequent click re-warms in
   ~1 s. The pill only renders on books whose effective engine is Kokoro
   (driven by `selectEnginesInUse` in `src/store/engines-in-use-selector.ts`).
   The eager preload itself is unchanged — restarting the sidecar always
   brings Kokoro back. Failure-tolerant: if the weights aren't installed
   yet, the sidecar logs a warning and stays alive on the Coqui path so
   the user can still get audio while they run
   `scripts/install-kokoro.ps1`.

   The Stop pill rides the same consolidated `useTtsLifecycle` hook that
   powers the Coqui pill — one /health probe per 30 s tick fans out into
   both engines' state. Adding any future engine pill MUST extend this
   hook, not spin up a parallel poll (see `BACKLOG #15` for the
   third-consumer extension guidance).

4. **Voice fallback mirrors Coqui's substitute-and-warn.** A
   `/synthesize` request for an unknown voice (including any
   non-English ID) falls back to `af_heart` and sets the
   `X-Voice-Substituted-From` response header so the Node side can
   surface a "your catalog is stale" warning to the user.

5. **Per-character overrides are per-engine.** Each cast member's
   `overrideTtsVoices` is a `Partial<Record<TtsEngine, { name }>>`
   map. Switching the project engine (Coqui ↔ Kokoro) picks up that
   engine's slot — no re-cast needed. Legacy `overrideTtsVoice`
   (singular) is migrated lazily at cast.json read time
   (`normaliseCastCharacter` in `server/src/routes/voices.ts`).

6. **Engine drift across already-rendered chapters is surfaced
   separately** — see `35-engine-drift-detection.md`. Switching the
   project engine after some chapters have been generated stamps those
   chapters as drifted in the Generation view so the user knows to
   regenerate for book-wide voice consistency.

7. **Account TTS defaults persist round-trip.** The engine/model picker
   and the `eagerLoadKokoro` toggle (Account → "Defaults for new books")
   write through `PUT /api/user/settings` and re-hydrate on the boot-time
   `GET`. Every writable user-setting field is asserted to survive
   PUT → GET → disk by `server/src/routes/user-settings.test.ts` ("round-trips
   every writable field"), guarding the allow-list-gap class of bug that
   silently dropped `qwen3-tts-0.6b` until `fb094e2` — a saved default that
   400s on PUT "reverts" to the built-in default on the next load.

## Critical files

- `server/tts-sidecar/main.py` — `KokoroEngine` class, `/speakers`
  multi-engine response, eager-preload startup hook
- `server/tts-sidecar/scripts/install-kokoro.ps1` — ONNX + voices
  manifest downloader (idempotent, ASCII-only per repo convention)
- `server/tts-sidecar/requirements.txt` — `kokoro-onnx>=0.4.0`,
  `onnxruntime-gpu>=1.20.0`
- `server/src/tts/voice-mapping.ts` — `KOKORO_PROFILE_VOICES`,
  `KOKORO_VOICE_DESCRIPTIONS`, `catalogForEngine` Kokoro branch
- `server/src/tts/base-voices.ts` — `buildKokoroVoices` aggregator
  with sidecar-live + static fallback
- `server/src/tts/voice-palette.ts` — Kokoro gradient lookup
- `server/src/routes/voices.ts` — `normaliseCastCharacter`,
  per-engine override read/write
- `src/lib/tts-models.ts` — picker entry (Kokoro first as new default)
- `src/lib/tts-voice-mapping.ts` — client mirror of the Kokoro tables
- `src/lib/voice-palette.ts` — client mirror of the gradient lookup
- `src/modals/profile-drawer.tsx` — `ModelVoiceOverridePicker` with
  per-engine tabs
- `src/store/voices-slice.ts` — `setOverride` writes to the engine slot

## Acceptance walkthrough

### Setup (one-time)

1. Pause OneDrive sync (system tray → Pause sync) to dodge the
   WinError 5 trap on pip installs under `OneDrive\…\Audiobook-Generator\`.
2. Install Kokoro deps:
   ```powershell
   cd server\tts-sidecar
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   powershell -ExecutionPolicy Bypass -File scripts\install-kokoro.ps1
   ```
   The script drops `kokoro-v1.0.onnx` (~300 MB) and `voices-v1.0.bin`
   (~30 MB) into `server/tts-sidecar/voices/kokoro/` (gitignored).
3. Restart the sidecar (`npm run tts:sidecar`). Look for:
   ```
   [sidecar] Loading Kokoro model=…\voices\kokoro\kokoro-v1.0.onnx …
   [sidecar] Kokoro loaded. English voices: 28 (filtered from ~54 total in manifest).
   ```

### Smoke

1. **`GET /speakers`** returns both engines:
   ```json
   { "coqui": [...], "kokoro": ["af_heart", "af_bella", …] }
   ```
   The `kokoro` list must be exactly 28 entries, all prefixed
   `af_`/`am_`/`bf_`/`bm_`.
2. **`POST /synthesize`** with `engine=kokoro, model=v1, voice=af_heart,
text="Hello, world."`:
   - 200 OK
   - `X-Sample-Rate: 24000`
   - `Content-Type: audio/L16;codec=pcm;rate=24000`
   - body is mono 16-bit LE PCM (audible after the Node-side MP3 encode)
3. **Non-English voice falls back**: `voice=ef_dora` → 200 OK with
   `X-Voice-Substituted-From: ef_dora`, audio uses `af_heart`.

### UI

4. Open the app on a fresh account: TTS model picker should default to
   **Kokoro v1 — Default · 28 English voices**.
5. Open the Profile Drawer for a cast member: the override picker shows
   **Coqui** and **Kokoro** tabs (and Gemini if `GEMINI_API_KEY` is set).
   Pick a voice in the Kokoro tab — slot indicator (dot) appears on the
   tab; the Coqui slot is unaffected.
6. Switch the project engine to Coqui via the picker, reopen the
   drawer: the Coqui tab is "Active", the Kokoro slot still exists.
   Switch back to Kokoro: the previously-set Kokoro voice is still
   selected.

### End-to-end

7. Drive the canonical manuscript
   `server/src/__fixtures__/the-coalfall-commission.md` through the full pipeline with
   Kokoro selected. Expect: audibly better narration vs the XTTS
   baseline; chapter render proceeds without the analyzer/TTS eviction
   dance; the Load/Stop pill is irrelevant during Kokoro synthesis.

### Engine coexistence

8. Load XTTS via the pill while Kokoro is resident. `nvidia-smi`
   should show ~3 GB + ~1 GB = ~4 GB used by `python.exe`. Run
   synthesis through the XTTS-selected picker — both work, no VRAM
   OOM. (If your GPU has <6 GB and the analyzer is also loaded, expect
   the existing XTTS-vs-Ollama eviction dance — Kokoro stays resident
   through it.)

## Known gaps

- **No auto-fill "fill Kokoro voices from Coqui assignments"** action
  yet. The profile-drawer per-engine tabs let users set the Kokoro slot
  manually; profile inference fills in the gap at synth time. If users
  want to bulk-port their Coqui cast to Kokoro, we'll add a one-click
  utility — for now, it's lazy/manual.
