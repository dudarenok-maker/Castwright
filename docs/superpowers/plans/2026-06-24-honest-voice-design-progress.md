# Honest Streamed-Phase Voice-Design Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-design cast-drawer progress bar's three lies (fake "about 15s" ETA, false "GPU busy" warning, fake `designing→rendering` phases) with real phase progress streamed from the sidecar over the existing single-design SSE.

**Architecture:** The sidecar's `design_voice` / `mint_variant` already time each phase (commit `bff9ff54`). At each timing seam they call an optional `report_progress(phase)` callback, which fires a best-effort `urllib` POST to a server loopback relay route carrying `{token, phase}`. The server maps the token to the in-flight single-design job and broadcasts the phase onto the SSE the drawer already consumes. The audio response contract is unchanged (callback is additive/opt-in), so the bulk + REST callers are untouched. The client advances the bar on real phase events with a calibrated per-phase sub-fill and an honest ETA.

**Tech Stack:** Python 3.12 / FastAPI / Starlette (sidecar), Node 20 / Express / TypeScript (server), React 18 / Redux Toolkit / TypeScript (client), Vitest, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-24-honest-voice-design-progress-design.md` (read it, including the AR1–AR9 adversarial-review section).

## Global Constraints

- **Branch:** all work on `feat/frontend-design-progress` (cut off `main`); this plan's tasks share one branch and one PR. (Workstream C — the 1.7B-Base mint fallback — is a *separate* branch/PR, not in this plan.)
- **Commit convention:** `<type>(<scope>): <subject>`. Allowed scopes: `frontend | server | sidecar | app | scripts | e2e | mocks | openapi | docs | deps | ci`. Multi-scope: `fix(server,sidecar): …`. End commit bodies with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Never `--no-verify`.
- **Sidecar HTTP:** stdlib `urllib.request` only — no new dependency (AR1). The sidecar venv lives at `server/tts-sidecar/.venv/Scripts/python.exe`.
- **Progress is best-effort:** a failed/late/duplicate progress POST must NEVER fail or stall a design. All progress errors are swallowed (AR7).
- **Loopback transport:** the relay route is loopback-only (AR3); the server passes its own loopback callback URL matching its listener — `http://127.0.0.1:<PORT>` normally, `https://127.0.0.1:<LAN_HTTPS_PORT>` when `LAN_HTTPS` is set — and the sidecar POST uses an unverified SSL context for the https loopback (AR2).
- **Phase vocabulary (shared, exact strings):** `freeing-vram`, `loading-model`, `designing`, `anchoring`, `performing`, `distilling`, `rendering`. Monotonic rank = index in that array (AR5). `freeing-vram` is conditional (Kokoro resident); `loading-model` is always emitted (AR4, AR8).
- **No test deletion without replacement:** Task 7 rewrites `design-progress.test.tsx` (it encodes the old lying behavior) with honest-behavior assertions — a replacement, not a deletion.
- **Tests required per task** (CLAUDE.md): new behaviour → new test; UI crossing router/redux/SSE seams → a Playwright spec.

---

## File Structure

**Sidecar** (`server/tts-sidecar/main.py`)
- `_post_progress(url, token, phase)` — module-level best-effort urllib POST helper.
- `design_voice` / `mint_variant` — gain optional `report_progress: Optional[Callable[[str], None]] = None`; call it at each seam.
- `qwen_design_voice` / `qwen_mint_variant` route handlers — read `progressToken` / `progressUrl` from the body, build the closure.
- Tests: `server/tts-sidecar/tests/test_design_progress.py` (new).

**Server**
- `server/src/routes/single-design.ts` — widen `SingleJob.phase`; per-job progress token + `tokenToJob` Map; compute + pass the loopback callback URL; replace the fake `rendering`-before-persist broadcast; mount the relay route; delete the token on `endJob`.
- `server/src/routes/design-progress-relay.ts` (new) — `designProgressRelayRouter`: `POST /api/internal/design-progress`, loopback-gated, token→job→broadcast.
- `server/src/routes/qwen-voice.ts` — `DesignQwenVoiceParams` gains optional `progressToken?` / `progressUrl?`; both sidecar request bodies include them when present.
- `server/src/tts/loopback-url.ts` (new) — `serverLoopbackBaseUrl()` from env.
- `server/src/app.ts` — mount `designProgressRelayRouter`.
- Tests: colocated `*.test.ts`.

**Client**
- `src/lib/design-phase.ts` (new) — `DesignPhase` type, `DESIGN_PHASE_ORDER`, `DESIGN_PHASE_BUDGETS_MS`, `DESIGN_PHASE_LABELS`, `phaseRank()`.
- `src/lib/api.ts` — widen the phase union on `onPhase`, `onResumeSingle`, `CastDesignStreamEvent`, `SingleDesignStatus`; relax the `phase` event guard; extend `mockStartSingleDesign`.
- `src/store/cast-design-slice.ts` — widen `phase` types; make `setPhase` monotonic.
- `src/components/design-progress.tsx` — rebuilt (real-event-driven sub-fill + honest ETA + real-overage warning).
- `src/components/voice-engine-picker.tsx`, `src/modals/profile-drawer.tsx` — pass the widened `designPhase`.
- Tests: `design-progress.test.tsx` (rewritten), `cast-design-slice.test.ts` (extended), `design-phase.test.ts` (new), `e2e/single-design-progress.spec.ts` (new).

---

## Task 1: Sidecar — `report_progress` callback at the design/mint seams

**Files:**
- Modify: `server/tts-sidecar/main.py` (`design_voice` ~1837, `mint_variant` ~1953)
- Test: `server/tts-sidecar/tests/test_design_progress.py` (create)

**Interfaces:**
- Produces: `QwenEngine.design_voice(voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None)` and `QwenEngine.mint_variant(base_voice_id, variant_voice_id, emotion_instruct, language, calibration_text, voice_uuid=None, report_progress=None)`. `report_progress` is `Optional[Callable[[str], None]]`; called with phase strings in order. `design_voice`: `freeing-vram` (only if Kokoro resident) → `loading-model` → `designing` → `distilling` → `rendering`. `mint_variant`: `freeing-vram` (only if Kokoro resident) → `loading-model` → `anchoring` → `performing` → `distilling` → `rendering`.

- [ ] **Step 1: Write the failing test**

```python
# server/tts-sidecar/tests/test_design_progress.py
"""Phase-progress callback wiring for design_voice / mint_variant (GPU-free)."""
import sys
import tempfile
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


def test_design_voice_reports_phases_in_order(monkeypatch):
    import main

    qeng = main.QwenEngine()

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    qeng._design = _FakeDesign()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_design_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)
    # Kokoro not resident → no freeing-vram phase.
    main.ENGINES["kokoro"]._kokoro = None

    seen = []
    qeng.design_voice(
        "qwen-narrator-preview", "A warm voice.", "english", "Hi.",
        report_progress=seen.append,
    )

    assert seen == ["loading-model", "designing", "distilling", "rendering"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_design_progress.py -q`
Expected: FAIL — `design_voice()` got an unexpected keyword argument `report_progress`.

- [ ] **Step 3: Add the `report_progress` param + seam calls to `design_voice`**

Change the signature (around `main.py:1837`):

```python
    def design_voice(
        self, voice_id: str, instruct: str, language: Optional[str], calibration_text: Optional[str], voice_uuid: Optional[str] = None,
        report_progress: Optional[Callable[[str], None]] = None,
    ) -> SynthResult:
```

Add a local no-op-safe reporter right after the `try:` / `t0 = time.perf_counter()` line:

```python
            def _phase(name: str) -> None:
                if report_progress is not None:
                    try:
                        report_progress(name)
                    except Exception:  # best-effort: never fail a design on progress
                        pass
```

Then place calls at the existing seams inside `design_voice`:
- Immediately before `with _VD_KOKORO.design():`, only when Kokoro is resident:

```python
            _kokoro_pre = ENGINES.get("kokoro")
            if isinstance(_kokoro_pre, KokoroEngine) and _kokoro_pre._kokoro is not None:
                _phase("freeing-vram")
            with _VD_KOKORO.design():
```
- Right after entering the `with` block, before `self._ensure_design_loaded()`:
  `_phase("loading-model")`
- After the `load_ms = …` line and the `with self._synth_lock:` + re-ensures, immediately before `ref_wavs, ref_sr = self._design.generate_voice_design(`:
  `_phase("designing")`
- Immediately before `prompt = self._base.create_voice_clone_prompt(` (the distil call):
  `_phase("distilling")`
- Immediately before the audition `with self._synth_lock:` block (before `_t = time.perf_counter()` for `audition_ms`):
  `_phase("rendering")`

Add `Callable` to the `typing` import at the top of the file if not already present (check `from typing import …`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_design_progress.py -q`
Expected: PASS.

- [ ] **Step 5: Add the mint-variant test**

Append to `test_design_progress.py`:

```python
def test_mint_variant_reports_phases_in_order(monkeypatch):
    import main
    import numpy as np

    qeng = main.QwenEngine()

    class _RefCode:
        def to(self, device):
            return self

    class _Item:
        ref_code = _RefCode()
        ref_text = "Hi."

    class _Tok:
        def decode(self, items):
            return [np.zeros(10, dtype="float32")], 24000

    class _Model:
        speech_tokenizer = _Tok()

    class _FakeBase17:
        model = _Model()

        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._base17 = _FakeBase17()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_base17_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_load_voice_prompt", lambda v: ([_Item()], "english", True))
    monkeypatch.setattr(qeng, "_icl_instruct_synth", lambda *a, **k: (np.zeros(10, dtype="float32"), 24000))
    monkeypatch.setattr(qeng, "_base17_activity", lambda: __import__("contextlib").nullcontext())
    monkeypatch.setattr("os.path.isfile", lambda p: True)
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)
    main.ENGINES["kokoro"]._kokoro = None

    seen = []
    qeng.mint_variant(
        "qwen-base", "qwen-base__angry", "furious", "english", "Hi.",
        report_progress=seen.append,
    )

    assert seen == ["loading-model", "anchoring", "performing", "distilling", "rendering"]
```

- [ ] **Step 6: Add the `report_progress` param + seams to `mint_variant`**

Mirror Step 3 in `mint_variant` (~1953): add the param + the `_phase` helper, then:
- before the `with self._base17_activity(), _VD_KOKORO.design():` line, when Kokoro resident: `_phase("freeing-vram")`
- after entering the `with`, before `self._ensure_base17_loaded()`: `_phase("loading-model")`
- before `ref_wavs, ref_sr = self._base17.model.speech_tokenizer.decode(` (start of the ICL block): `_phase("anchoring")`
- before `emo_wav, emo_sr = self._icl_instruct_synth(`: `_phase("performing")`
- before the 0.6B `prompt = self._base.create_voice_clone_prompt(` distil: `_phase("distilling")`
- before the audition `with self._synth_lock:` block: `_phase("rendering")`

- [ ] **Step 7: Run both tests + the existing design test**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_design_progress.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py -q`
Expected: all PASS (the existing `test_design_voice_holds_arbiter_and_evicts_resident_kokoro` still passes — `report_progress` defaults to `None`).

- [ ] **Step 8: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_progress.py
git commit -m "feat(sidecar): report_progress callback at design/mint phase seams"
```

---

## Task 2: Sidecar — `_post_progress` helper + route wiring

**Files:**
- Modify: `server/tts-sidecar/main.py` (module scope; `qwen_design_voice` ~4027, `qwen_mint_variant` ~4086)
- Test: `server/tts-sidecar/tests/test_design_progress.py`

**Interfaces:**
- Consumes: Task 1's `report_progress` param.
- Produces: `_post_progress(url: str, token: str, phase: str) -> None` (module-level; fire-and-forget daemon-thread POST; swallows all errors; unverified SSL for `https://`). Route handlers read body `progressToken` / `progressUrl` (both optional strings) and pass `report_progress=lambda ph: _post_progress(progress_url, progress_token, ph)` into the engine call when both are present.

- [ ] **Step 1: Write the failing test**

```python
def test_design_route_posts_progress_when_token_present(monkeypatch):
    import main
    import numpy as np
    from starlette.testclient import TestClient

    class _FakeQwen:
        def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None):
            if report_progress:
                report_progress("loading-model")
                report_progress("designing")
            return main.SynthResult(pcm=np.zeros(4, dtype="<i2").tobytes(), sample_rate=24000)

    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwen())

    posted = []
    monkeypatch.setattr(main, "_post_progress", lambda url, token, phase: posted.append((url, token, phase)))

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={
        "voiceId": "qwen-x", "instruct": "warm",
        "progressToken": "tok123", "progressUrl": "http://127.0.0.1:8080/api/internal/design-progress",
    })
    assert res.status_code == 200
    assert posted == [
        ("http://127.0.0.1:8080/api/internal/design-progress", "tok123", "loading-model"),
        ("http://127.0.0.1:8080/api/internal/design-progress", "tok123", "designing"),
    ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_design_progress.py::test_design_route_posts_progress_when_token_present -q`
Expected: FAIL — `module 'main' has no attribute '_post_progress'` (and the route ignores the token).

- [ ] **Step 3: Add the `_post_progress` helper**

Add near the other module helpers in `main.py` (after the logging setup, before the engine classes):

```python
def _post_progress(url: str, token: str, phase: str) -> None:
    """Best-effort fire-and-forget progress POST to the server's loopback relay.
    Runs in a daemon thread; swallows every error (progress must never fail or
    stall a design). Uses an unverified SSL context for the https loopback —
    the server's LAN cert is self-signed and this is the same host (AR2)."""
    import json as _json
    import ssl as _ssl
    import threading as _threading
    import urllib.request as _ureq

    def _fire() -> None:
        try:
            data = _json.dumps({"token": token, "phase": phase}).encode("utf-8")
            req = _ureq.Request(
                url, data=data, method="POST",
                headers={"Content-Type": "application/json"},
            )
            ctx = _ssl._create_unverified_context() if url.lower().startswith("https") else None
            _ureq.urlopen(req, timeout=1.5, context=ctx).close()
        except Exception:
            pass

    _threading.Thread(target=_fire, daemon=True).start()
```

- [ ] **Step 4: Wire the route handlers**

In `qwen_design_voice` (after the existing body field reads, before the `asyncio.to_thread` call), add:

```python
    progress_token = body.get("progressToken") if isinstance(body.get("progressToken"), str) else None
    progress_url = body.get("progressUrl") if isinstance(body.get("progressUrl"), str) else None
    _report = (
        (lambda ph: _post_progress(progress_url, progress_token, ph))
        if progress_token and progress_url
        else None
    )
```

Pass `_report` as the new trailing arg to the `to_thread` call:

```python
        result = await asyncio.to_thread(
            qwen.design_voice,
            voice_id.strip(),
            instruct.strip(),
            language if isinstance(language, str) else None,
            calibration_text if isinstance(calibration_text, str) else None,
            voice_uuid,
            _report,
        )
```

Do the equivalent in `qwen_mint_variant` (read the same two body fields, build `_report`, pass it as the trailing arg to the `mint_variant` `to_thread` call).

- [ ] **Step 5: Run the test to verify it passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_design_progress.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_progress.py
git commit -m "feat(sidecar): POST phase progress to the server relay when a token is supplied"
```

---

## Task 3: Server — loopback URL helper + thread the token through the design core

**Files:**
- Create: `server/src/tts/loopback-url.ts`, `server/src/tts/loopback-url.test.ts`
- Modify: `server/src/routes/qwen-voice.ts` (`DesignQwenVoiceParams`, both fetch bodies ~353-368)
- Test: `server/src/routes/qwen-voice.test.ts` (or a focused new test file)

**Interfaces:**
- Produces: `serverLoopbackBaseUrl(env?): string` → `https://127.0.0.1:<LAN_HTTPS_PORT>` when `env.LAN_HTTPS` is set, else `http://127.0.0.1:<PORT>` (defaults `8443` / `8080`). `DesignQwenVoiceParams` gains `progressToken?: string` and `progressUrl?: string`; when both are present they are added to the sidecar request body as `progressToken` / `progressUrl` for BOTH the design and mint bodies.

- [ ] **Step 1: Write the failing test for the URL helper**

```typescript
// server/src/tts/loopback-url.test.ts
import { describe, it, expect } from 'vitest';
import { serverLoopbackBaseUrl } from './loopback-url.js';

describe('serverLoopbackBaseUrl', () => {
  it('uses plain http on PORT by default', () => {
    expect(serverLoopbackBaseUrl({ PORT: '8080' })).toBe('http://127.0.0.1:8080');
  });
  it('uses https on LAN_HTTPS_PORT when LAN_HTTPS is set', () => {
    expect(serverLoopbackBaseUrl({ LAN_HTTPS: '1', LAN_HTTPS_PORT: '8443' })).toBe(
      'https://127.0.0.1:8443',
    );
  });
  it('falls back to default ports', () => {
    expect(serverLoopbackBaseUrl({})).toBe('http://127.0.0.1:8080');
    expect(serverLoopbackBaseUrl({ LAN_HTTPS: 'true' })).toBe('https://127.0.0.1:8443');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/tts/loopback-url.test.ts`
Expected: FAIL — cannot find `./loopback-url.js`.

- [ ] **Step 3: Implement the helper**

```typescript
// server/src/tts/loopback-url.ts
/* The server's own loopback base URL, matching whatever listener index.ts
   started: plain http on PORT normally, https on LAN_HTTPS_PORT when LAN_HTTPS
   is set (mkcert cert). The sidecar POSTs phase progress here (AR2). */
export function serverLoopbackBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const lan = env.LAN_HTTPS != null && env.LAN_HTTPS !== '' && env.LAN_HTTPS !== '0';
  if (lan) return `https://127.0.0.1:${Number(env.LAN_HTTPS_PORT ?? 8443) || 8443}`;
  return `http://127.0.0.1:${Number(env.PORT ?? 8080) || 8080}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run src/tts/loopback-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for body threading**

Add to `server/src/routes/qwen-voice.test.ts` a test that stubs `fetch`, calls `designQwenVoiceForCharacter` with `progressToken`/`progressUrl`, and asserts the parsed request body carries them. (Follow the file's existing fetch-mock pattern; if none exists, mock `global.fetch` with `vi.fn()` returning `{ ok: true, headers: { get: () => '24000' }, arrayBuffer: async () => new ArrayBuffer(4) }` and read `JSON.parse(fetchMock.mock.calls[0][1].body)`.) Assert: body has `progressToken: 'tok'` and `progressUrl: 'http://127.0.0.1:8080/api/internal/design-progress'`; and a second call WITHOUT the params has neither key.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: FAIL — body lacks `progressToken`.

- [ ] **Step 7: Add the optional params + body fields**

In `DesignQwenVoiceParams` (the interface backing `designQwenVoiceForCharacter`), add:

```typescript
  progressToken?: string;
  progressUrl?: string;
```

In both branches of `fetchBody` (the `p.emotion ? mint-body : design-body`), spread the progress fields when present. Define once above the ternary:

```typescript
      const progressFields =
        p.progressToken && p.progressUrl
          ? { progressToken: p.progressToken, progressUrl: p.progressUrl }
          : {};
```

and add `...progressFields,` to each `JSON.stringify({ … })` object.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts src/tts/loopback-url.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/tts/loopback-url.ts server/src/tts/loopback-url.test.ts server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): loopback URL helper + thread progress token into the design core"
```

---

## Task 4: Server — the internal phase-relay route

**Files:**
- Create: `server/src/routes/design-progress-relay.ts`, `server/src/routes/design-progress-relay.test.ts`
- Modify: `server/src/routes/single-design.ts` (export `registerProgressToken` / `resolveProgressToken` / `dropProgressToken`; widen `SingleJob.phase`), `server/src/app.ts` (mount the router)

**Interfaces:**
- Consumes: the `inFlightByBook` job + `broadcast` from `single-design.ts`.
- Produces: a `tokenToJob: Map<string, SingleJob>` keyed registry exposed via `registerProgressToken(token, job)`, `resolveProgressToken(token)`, `dropProgressToken(token)`. The route `POST /api/internal/design-progress` accepts `{ token: string, phase: DesignPhase }`, rejects non-loopback requests (403), no-ops on unknown token (200, `{ ok: false }`), and on a hit `broadcast(job, { type: 'phase', phase, characterId: job.characterId })` then `{ ok: true }`. `SingleJob.phase` widened to the 7-string `DesignPhase` union.

- [ ] **Step 1: Widen `SingleJob.phase` + add the token registry to `single-design.ts`**

Change `SingleJob.phase` (line ~52) to:

```typescript
  phase: 'freeing-vram' | 'loading-model' | 'designing' | 'anchoring' | 'performing' | 'distilling' | 'rendering';
```

Add near `inFlightByBook` (line ~58):

```typescript
/* Progress-token registry: the sidecar POSTs phase progress to the loopback
   relay carrying this token; the relay maps it back to the in-flight job. A
   token is valid only while its job runs (deleted in endJob). */
const tokenToJob = new Map<string, SingleJob>();
export function registerProgressToken(token: string, job: SingleJob): void {
  tokenToJob.set(token, job);
}
export function resolveProgressToken(token: string): SingleJob | undefined {
  return tokenToJob.get(token);
}
export function dropProgressToken(token: string): void {
  tokenToJob.delete(token);
}
```

Export the broadcast for the relay (add `export` to `function broadcast`). Export the `SingleJob` type (`export interface SingleJob`).

- [ ] **Step 2: Write the failing relay test**

```typescript
// server/src/routes/design-progress-relay.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { designProgressRelayRouter } from './design-progress-relay.js';
import * as single from './single-design.js';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', designProgressRelayRouter);
  return app;
}

describe('POST /api/internal/design-progress', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('broadcasts the phase to the job on a valid token from loopback', async () => {
    const sent: unknown[] = [];
    const job = { characterId: 'c1', subscribers: new Set() } as unknown as single.SingleJob;
    vi.spyOn(single, 'resolveProgressToken').mockReturnValue(job);
    const bcast = vi.spyOn(single, 'broadcast').mockImplementation((_j, ev) => sent.push(ev));

    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .set('X-Forwarded-For', '') // supertest connects over loopback
      .send({ token: 'tok', phase: 'designing' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(bcast).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ type: 'phase', phase: 'designing', characterId: 'c1' });
  });

  it('no-ops on an unknown token', async () => {
    vi.spyOn(single, 'resolveProgressToken').mockReturnValue(undefined);
    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .send({ token: 'nope', phase: 'designing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });

  it('rejects a non-loopback client', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
      next();
    });
    app.use('/api/internal', designProgressRelayRouter);
    const res = await request(app).post('/api/internal/design-progress').send({ token: 't', phase: 'designing' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/design-progress-relay.test.ts`
Expected: FAIL — cannot find `./design-progress-relay.js`.

- [ ] **Step 4: Implement the relay route**

```typescript
// server/src/routes/design-progress-relay.ts
/* Internal loopback-only relay: the TTS sidecar POSTs single-design phase
   progress here (it can't reach the SSE directly), and we broadcast it onto the
   in-flight single-design job's SSE. Loopback-gated AND token-gated (AR3). */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { resolveProgressToken, broadcast } from './single-design.js';

const PHASES = new Set([
  'freeing-vram', 'loading-model', 'designing', 'anchoring', 'performing', 'distilling', 'rendering',
]);

function isLoopback(req: Request): boolean {
  const ip = req.ip ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '';
}

export const designProgressRelayRouter = Router();

designProgressRelayRouter.post('/design-progress', (req: Request, res: Response) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'loopback only' });
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const phase = typeof req.body?.phase === 'string' ? req.body.phase : '';
  if (!token || !PHASES.has(phase)) return res.status(400).json({ error: 'bad request' });
  const job = resolveProgressToken(token);
  if (!job) return res.status(200).json({ ok: false });
  broadcast(job, { type: 'phase', phase, characterId: job.characterId });
  return res.status(200).json({ ok: true });
});
```

- [ ] **Step 5: Mount it in `app.ts`**

Add the import beside the other route imports and mount it after the other `/api` routers (e.g. after the `pairSessionRouter` line):

```typescript
import { designProgressRelayRouter } from './routes/design-progress-relay.js';
// …
app.use('/api/internal', designProgressRelayRouter); // sidecar→server single-design phase relay (loopback only)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/design-progress-relay.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/design-progress-relay.ts server/src/routes/design-progress-relay.test.ts server/src/routes/single-design.ts server/src/app.ts
git commit -m "feat(server): loopback-gated internal relay for single-design phase progress"
```

---

## Task 5: Server — register the token in the job + drop the fake `rendering` broadcast

**Files:**
- Modify: `server/src/routes/single-design.ts` (`runSingleDesign` ~86-141, `endJob` ~71)
- Test: `server/src/routes/single-design.test.ts` (extend; if absent, create with the existing job-test pattern)

**Interfaces:**
- Consumes: `serverLoopbackBaseUrl` (Task 3), `registerProgressToken`/`dropProgressToken` (Task 4), `DesignQwenVoiceParams.progressToken`/`progressUrl` (Task 3).
- Produces: each single-design job mints a random token, registers it, passes `progressToken` + `progressUrl = serverLoopbackBaseUrl() + '/api/internal/design-progress'` into `designQwenVoiceForCharacter`, and drops the token in `endJob`. The fake `job.phase = 'rendering'` + its broadcast (lines ~140-141) are removed (the sidecar now drives `rendering`); the initial `'designing'` broadcast (lines ~115-116) stays as the honest pre-call baseline.

- [ ] **Step 1: Write the failing test**

Add to `single-design.test.ts` a test that runs a single design with a stubbed `designQwenVoiceForCharacter` (mock the module) and asserts: (a) `designQwenVoiceForCharacter` was called with a non-empty `progressToken` and a `progressUrl` ending `/api/internal/design-progress`; (b) the token resolves via `resolveProgressToken` *during* the design and returns `undefined` after `endJob`; (c) no `{ type: 'phase', phase: 'rendering' }` is broadcast by the server itself. Use `vi.mock('./qwen-voice.js')` to stub the core, capturing its args, and a fake subscriber recording broadcasts.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/single-design.test.ts`
Expected: FAIL — no `progressToken` passed; server still broadcasts `rendering`.

- [ ] **Step 3: Mint + register the token, pass the callback URL, stop faking `rendering`**

In `runSingleDesign`, before the `designQwenVoiceForCharacter` call, add:

```typescript
    const { randomUUID } = await import('node:crypto');
    const { serverLoopbackBaseUrl } = await import('../tts/loopback-url.js');
    const progressToken = randomUUID();
    registerProgressToken(progressToken, job);
    const progressUrl = `${serverLoopbackBaseUrl()}/api/internal/design-progress`;
```

Import `registerProgressToken` / `dropProgressToken` at the top from this same module is not needed (same file) — they're local; if the registry lives in this file (Task 4 Step 1), call them directly.

Add `progressToken` + `progressUrl` to the `designQwenVoiceForCharacter({ … })` argument object.

Delete these two lines (the fake transition, ~140-141):

```typescript
    job.phase = 'rendering';
    broadcast(job, { type: 'phase', phase: 'rendering', characterId: job.characterId });
```

In `endJob`, after `inFlightByBook.delete`, drop any token for the job:

```typescript
  for (const [tok, j] of tokenToJob) if (j === job) tokenToJob.delete(tok);
```

(Update `job.phase` assignments elsewhere — when the relay broadcasts, the SSE carries the phase; the server's own `job.phase` field is now only the initial `'designing'` baseline + the `status` snapshot, which is acceptable.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/single-design.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/single-design.ts server/src/routes/single-design.test.ts
git commit -m "feat(server): mint+register a progress token per single design; drop the fake rendering tick"
```

---

## Task 6: Client — shared phase module, widened types + monotonic reducer + mock sequence

**Files:**
- Create: `src/lib/design-phase.ts`, `src/lib/design-phase.test.ts`
- Modify: `src/lib/api.ts` (`onPhase`/`onResumeSingle`/`CastDesignStreamEvent`/`SingleDesignStatus` unions ~4593-4634, the `'phase'` handler guard ~4683-4688, `mockStartSingleDesign` ~4883-4891), `src/store/cast-design-slice.ts` (`setPhase` ~262-277 + the `phase` field types)
- Test: `src/store/cast-design-slice.test.ts` (extend)

**Interfaces:**
- Produces: `type DesignPhase = 'freeing-vram' | 'loading-model' | 'designing' | 'anchoring' | 'performing' | 'distilling' | 'rendering'`; `DESIGN_PHASE_ORDER: DesignPhase[]` (that order); `phaseRank(p: DesignPhase): number`; `DESIGN_PHASE_LABELS: Record<DesignPhase, string>`; `DESIGN_PHASE_BUDGETS_MS: Record<DesignPhase, number>`. `setPhase` ignores a phase whose rank ≤ the current phase's rank (AR5).

- [ ] **Step 1: Write the failing test for `design-phase.ts`**

```typescript
// src/lib/design-phase.test.ts
import { describe, it, expect } from 'vitest';
import { DESIGN_PHASE_ORDER, phaseRank, DESIGN_PHASE_LABELS, DESIGN_PHASE_BUDGETS_MS } from './design-phase';

describe('design-phase', () => {
  it('ranks phases by their canonical order', () => {
    expect(phaseRank('loading-model')).toBeLessThan(phaseRank('designing'));
    expect(phaseRank('rendering')).toBe(DESIGN_PHASE_ORDER.length - 1);
  });
  it('has a label and a positive budget for every phase', () => {
    for (const p of DESIGN_PHASE_ORDER) {
      expect(DESIGN_PHASE_LABELS[p]).toBeTruthy();
      expect(DESIGN_PHASE_BUDGETS_MS[p]).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/design-phase.test.ts`
Expected: FAIL — cannot find `./design-phase`.

- [ ] **Step 3: Implement `design-phase.ts`**

```typescript
// src/lib/design-phase.ts
/* Shared vocabulary for the honest single-design progress bar. Budgets are
   placeholder estimates until the on-box `qwen voice design:` numbers seed them
   (spec Open items); the bar self-corrects when the next real phase event
   arrives early (AR8). */
export type DesignPhase =
  | 'freeing-vram'
  | 'loading-model'
  | 'designing'
  | 'anchoring'
  | 'performing'
  | 'distilling'
  | 'rendering';

export const DESIGN_PHASE_ORDER: DesignPhase[] = [
  'freeing-vram', 'loading-model', 'designing', 'anchoring', 'performing', 'distilling', 'rendering',
];

export function phaseRank(p: DesignPhase): number {
  return DESIGN_PHASE_ORDER.indexOf(p);
}

export const DESIGN_PHASE_LABELS: Record<DesignPhase, string> = {
  'freeing-vram': 'Freeing GPU memory…',
  'loading-model': 'Loading the design model…',
  designing: 'Designing the voice…',
  anchoring: 'Anchoring to the base voice…',
  performing: 'Performing the emotion…',
  distilling: 'Distilling the voice…',
  rendering: 'Rendering the 12s audition…',
};

export const DESIGN_PHASE_BUDGETS_MS: Record<DesignPhase, number> = {
  'freeing-vram': 1_500,
  'loading-model': 12_000,
  designing: 55_000,
  anchoring: 6_000,
  performing: 60_000,
  distilling: 6_000,
  rendering: 12_000,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/design-phase.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen the unions in `api.ts`**

Replace every `'designing' | 'rendering'` occurrence in the four spots (the `onPhase` cb, `onResumeSingle` cb, `CastDesignStreamEvent.phase`, `SingleDesignStatus.phase`) with `DesignPhase` (import it: `import { type DesignPhase, DESIGN_PHASE_ORDER } from './design-phase';`). In the `'phase'` event handler, replace the guard `(e.phase === 'designing' || e.phase === 'rendering')` with `(DESIGN_PHASE_ORDER as string[]).includes(e.phase as string)`, and in `'resume_from'` map `phase: e.phase` through the same guard (default `'designing'`).

Extend `mockStartSingleDesign` to emit the richer sequence:

```typescript
  for (const phase of ['loading-model', 'designing', 'distilling', 'rendering'] as const) {
    cb.onPhase?.({ characterId: args.characterId, phase });
    await wait(60);
  }
```
(replacing the old two-phase `designing`/`rendering` emission).

- [ ] **Step 6: Write the failing monotonic-reducer test**

Add to `src/store/cast-design-slice.test.ts`:

```typescript
it('setPhase advances forward but never rewinds (monotonic)', () => {
  let s = reducer(undefined, designSingleRequested({ bookId: 'b', characterId: 'c', name: 'N', mode: 'first', lastTickAt: 0 }));
  s = reducer(s, setPhase({ bookId: 'b', characterId: 'c', phase: 'designing', lastTickAt: 1 }));
  expect(s.active?.phase).toBe('designing');
  // a late, lower-rank phase must be ignored
  s = reducer(s, setPhase({ bookId: 'b', characterId: 'c', phase: 'loading-model', lastTickAt: 2 }));
  expect(s.active?.phase).toBe('designing');
  // a higher-rank phase advances
  s = reducer(s, setPhase({ bookId: 'b', characterId: 'c', phase: 'rendering', lastTickAt: 3 }));
  expect(s.active?.phase).toBe('rendering');
});
```

(Import `setPhase`, `designSingleRequested`, and the reducer per the file's existing imports.)

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/store/cast-design-slice.test.ts`
Expected: FAIL — `loading-model` overwrites `designing` (current `setPhase` is unconditional) / type error on the new phase strings.

- [ ] **Step 8: Make `setPhase` monotonic + widen the slice phase types**

Widen the two `phase: 'designing' | 'rendering'` types in the slice (the `setPhase` payload + the snapshot/state type) to `DesignPhase` (import from `../lib/design-phase`). Replace the body of `setPhase`'s final two lines with:

```typescript
      const cur = snap.phase as DesignPhase | undefined;
      if (cur && phaseRank(action.payload.phase) <= phaseRank(cur)) return; // monotonic (AR5)
      snap.phase = action.payload.phase;
      snap.lastTickAt = action.payload.lastTickAt;
```

(import `phaseRank`). Also widen the `designSingleRequested` initial `phase: 'designing'` — it stays `'designing'` but the field type is now `DesignPhase`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/store/cast-design-slice.test.ts src/lib/design-phase.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/design-phase.ts src/lib/design-phase.test.ts src/lib/api.ts src/store/cast-design-slice.ts src/store/cast-design-slice.test.ts
git commit -m "feat(frontend): shared DesignPhase vocab, widened SSE unions, monotonic setPhase"
```

---

## Task 7: Client — rebuild `DesignProgress` (honest sub-fill, ETA, real-overage warning)

**Files:**
- Modify: `src/components/design-progress.tsx`
- Test: `src/components/design-progress.test.tsx` (rewrite — replaces the old lying-behavior assertions)

**Interfaces:**
- Consumes: `DesignPhase`, `DESIGN_PHASE_LABELS`, `DESIGN_PHASE_BUDGETS_MS`, `DESIGN_PHASE_ORDER`, `phaseRank` from `../lib/design-phase`.
- Produces: `DesignProgress({ phase: DesignPhase; complete?: boolean })`. Shows the phase label, a calibrated cumulative fill, an honest ETA, and the slow warning only past a real overage. `data-testid`s preserved: `design-waveform`, `design-fill`, `design-elapsed`, `design-eta`.

- [ ] **Step 1: Rewrite the test to encode honest behavior**

```tsx
// src/components/design-progress.test.tsx
import { render, screen, act } from '@testing-library/react';
import { DesignProgress } from './design-progress';

describe('DesignProgress (honest)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('labels the current phase', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
  });

  it('shows the loading-model and rendering labels', () => {
    const { rerender } = render(<DesignProgress phase="loading-model" />);
    expect(screen.getByText(/loading the design model/i)).toBeInTheDocument();
    rerender(<DesignProgress phase="rendering" />);
    expect(screen.getByText(/rendering the 12s audition/i)).toBeInTheDocument();
  });

  it('ticks the elapsed clock', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:00');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:03');
  });

  it('shows a realistic ETA, not "about 15s"', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-eta')).not.toHaveTextContent(/about 15s/i);
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/~\d/); // e.g. "~1:10 left"
  });

  it('does NOT cry "GPU busy" at a normal ~30s into designing', () => {
    render(<DesignProgress phase="designing" />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByTestId('design-eta')).not.toHaveTextContent(/taking longer than usual/i);
  });

  it('flips to the honest slow warning only past a real overage', () => {
    render(<DesignProgress phase="designing" />);
    act(() => vi.advanceTimersByTime(140_000)); // > 2× the designing budget
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/taking longer than usual/i);
  });

  it('snaps to complete', () => {
    const { container } = render(<DesignProgress phase="rendering" complete />);
    const fill = container.querySelector('[data-testid="design-fill"] > i') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('renders the waveform + fill scaffold', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('[data-testid="design-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-fill"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/design-progress.test.tsx`
Expected: FAIL — old component shows "about 15s" and warns at 21s; no `loading-model` label; `complete` snap shape differs.

- [ ] **Step 3: Rebuild the component**

```tsx
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  type DesignPhase,
  DESIGN_PHASE_LABELS,
  DESIGN_PHASE_BUDGETS_MS,
  DESIGN_PHASE_ORDER,
  phaseRank,
} from '../lib/design-phase';

const BARS = 12;
/* Real overage: a phase that has run past this multiple of its budget is
   genuinely stuck/contended (not just normally slow). */
const OVERAGE_MULT = 2;

interface Props {
  phase: DesignPhase;
  complete?: boolean;
}

function fmt(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
}

/* Cumulative budget at the START of `phase` and the TOTAL, over the phases that
   actually run for the detected path (a mint emits anchoring/performing; a
   design emits `designing`). We approximate the total as every phase at or
   before the highest-seen rank plus the canonical tail, which is close enough —
   the bar self-corrects on each real event (AR8). */
function budgetBounds(phase: DesignPhase): { before: number; total: number } {
  const rank = phaseRank(phase);
  let before = 0;
  let total = 0;
  DESIGN_PHASE_ORDER.forEach((p, i) => {
    const b = DESIGN_PHASE_BUDGETS_MS[p];
    total += b;
    if (i < rank) before += b;
  });
  return { before, total };
}

export function DesignProgress({ phase, complete = false }: Props) {
  const [now, setNow] = useState(0);
  const startRef = useRef(Date.now());
  const phaseStartRef = useRef(Date.now());
  const lastPhaseRef = useRef<DesignPhase>(phase);

  // Reset the in-phase clock whenever the phase advances.
  if (lastPhaseRef.current !== phase) {
    lastPhaseRef.current = phase;
    phaseStartRef.current = Date.now();
  }

  useEffect(() => {
    if (complete) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [complete]);

  const elapsedTotal = now === 0 ? 0 : now - startRef.current;
  const inPhase = now === 0 ? 0 : now - phaseStartRef.current;
  const budget = DESIGN_PHASE_BUDGETS_MS[phase];
  const { before, total } = budgetBounds(phase);

  // Cumulative fill: phases before this one are "done"; within this phase ease
  // toward (but never past) its budget until the next real event arrives.
  const inPhaseFill = Math.min(inPhase, budget * 0.92);
  const pct = complete ? 100 : Math.min(99, ((before + inPhaseFill) / total) * 100);

  const slow = !complete && inPhase > budget * OVERAGE_MULT;
  const remaining = Math.max(0, total - before - inPhase);

  const fillStyle: CSSProperties = complete
    ? { width: '100%', transition: 'width 300ms ease-out' }
    : { width: `${pct}%`, transition: 'width 700ms ease-out' };
  const fillClass = `design-fill mt-2${slow ? ' design-fill--indeterminate' : ''}`;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className={fillClass} data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">
          {DESIGN_PHASE_LABELS[phase]}
        </span>
        <span className="text-[11px] text-ink/40 tabular-nums" data-testid="design-elapsed">
          {fmt(elapsedTotal)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink/40" data-testid="design-eta">
        {slow
          ? 'Taking longer than usual — the GPU may be busy with another job.'
          : complete
            ? 'Done'
            : `~${fmt(remaining)} left`}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/design-progress.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/design-progress.tsx src/components/design-progress.test.tsx
git commit -m "feat(frontend): rebuild DesignProgress with honest per-phase fill, ETA, and overage warning"
```

---

## Task 8: Client — pass the widened phase through the drawer

**Files:**
- Modify: `src/components/voice-engine-picker.tsx` (`designPhase` prop ~69, the `<DesignProgress …>` usage ~215), `src/modals/profile-drawer.tsx` (`slicePhase` ~257, the prop passed to the picker ~1043 region)
- Test: covered by Task 7's component test + Task 9's e2e (no new unit test — pure prop-type widening; the typecheck is the gate).

**Interfaces:**
- Consumes: `DesignPhase` (from `../lib/design-phase`).
- Produces: `VoiceEnginePickerProps.designPhase?: DesignPhase`; `profile-drawer`'s `slicePhase: DesignPhase` read from `singleDesign?.phase`.

- [ ] **Step 1: Widen `designPhase` in `voice-engine-picker.tsx`**

Change the prop type (line ~69) from `designPhase?: 'designing' | 'rendering';` to `designPhase?: DesignPhase;` and add `import { type DesignPhase } from '../lib/design-phase';`. The `<DesignProgress phase={designPhase ?? 'designing'} />` usage (line ~215) needs no change.

- [ ] **Step 2: Widen `slicePhase` in `profile-drawer.tsx`**

Change line ~257 from `const slicePhase: 'designing' | 'rendering' = singleDesign?.phase ?? 'designing';` to `const slicePhase: DesignPhase = singleDesign?.phase ?? 'designing';` and import `DesignPhase`. Confirm it's passed into the picker as `designPhase={slicePhase}`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors across the widened unions).

- [ ] **Step 4: Run the frontend suite**

Run: `npx vitest run src/components/voice-engine-picker.test.tsx src/modals/profile-drawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voice-engine-picker.tsx src/modals/profile-drawer.tsx
git commit -m "feat(frontend): thread the widened DesignPhase through the cast drawer"
```

---

## Task 9: E2E — phase labels appear in order (mock path)

**Files:**
- Create: `e2e/single-design-progress.spec.ts`

**Interfaces:**
- Consumes: the widened `mockStartSingleDesign` sequence from Task 6 (`loading-model → designing → distilling → rendering`).

**Note (AR9):** the mock fakes timing, so this asserts label **order**, not durations. Real timing is covered by Task 1/2/the on-box run.

- [ ] **Step 1: Write the spec**

```typescript
// e2e/single-design-progress.spec.ts
import { test, expect } from '@playwright/test';
import { openCastDrawerForFirstQwenCharacter } from './helpers'; // reuse existing helpers; otherwise inline the nav

test('single-design progress shows real phase labels in order, no fake "about 15s"', async ({ page }) => {
  await page.goto('/');
  // Navigate to a Qwen book's cast, open a character profile, trigger a design.
  // (Use the same nav the existing cast e2e specs use; see e2e/responsive/coverage.spec.ts.)
  await openCastDrawerForFirstQwenCharacter(page);
  await page.getByRole('button', { name: /design/i }).click();

  const eta = page.getByTestId('design-eta');
  await expect(eta).not.toHaveText(/about 15s/i);

  // Labels appear in canonical order over the mock sequence.
  await expect(page.getByText(/loading the design model/i)).toBeVisible();
  await expect(page.getByText(/designing the voice/i)).toBeVisible();
  await expect(page.getByText(/rendering the 12s audition/i)).toBeVisible();
});
```

If no shared helper exists, inline the navigation steps the existing cast specs use (load a sample Qwen book → open the cast view → click a character → click Design). Keep the spec resilient: assert the labels and the absence of "about 15s".

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- single-design-progress`
Expected: PASS (chromium, mock mode).

- [ ] **Step 3: Commit**

```bash
git add e2e/single-design-progress.spec.ts
git commit -m "test(e2e): single-design progress shows real phase labels in order"
```

---

## Final verification

- [ ] **Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests (frontend, server, sidecar) + e2e + build PASS.

- [ ] **Update docs + flip the spec status**

- Set the spec frontmatter `status: draft → active`.
- Add a **Ship notes** line once merged (date + merge SHA).
- The on-box calibration of `DESIGN_PHASE_BUDGETS_MS` (from the real `qwen voice design:` line) is a follow-up tweak, not a blocker — note it in the PR body.

- [ ] **Open the PR**

PR title: `feat(frontend,server,sidecar): honest streamed-phase voice-design progress`. Body: enumerate the user-visible delta (real phase labels + honest ETA in the cast drawer, no more fake "about 15s" / spurious "GPU busy"), link the spec, and note the owed on-box budget calibration + that workstream C (1.7B-Base mint fallback) ships separately.

---

## Self-review (against the spec)

- **Spec coverage:** transport/callback (Tasks 1-5), phase taxonomy (Task 1/6), three layers — sidecar (1-2), server (3-5), client (6-8) — calibration (Task 6 `DESIGN_PHASE_BUDGETS_MS`), error handling AR-items (best-effort POST T2, loopback gate T4, monotonic T6, completion snap T7, token drop T5), testing (each task + T9 e2e). ✓
- **AR coverage:** AR1 urllib (T2), AR2 loopback URL + unverified SSL (T2/T3), AR3 loopback gate (T4), AR4 always-emit loading-model (T1), AR5 monotonic (T6), AR6 completion snap (T7 `complete`), AR7 best-effort/no-op (T2/T4), AR8 warm/cold self-correct (T7 fill math), AR9 e2e order-only (T9 note). ✓
- **Placeholder scan:** code shown for every code step; commands + expected output on every run step. ✓
- **Type consistency:** `DesignPhase` defined once (T6) and imported everywhere; `report_progress` signature identical across T1/T2; `registerProgressToken`/`resolveProgressToken`/`dropProgressToken` consistent across T4/T5; `serverLoopbackBaseUrl` consistent T3/T5. ✓
