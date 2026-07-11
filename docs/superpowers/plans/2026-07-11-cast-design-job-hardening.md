# Cast Design Job Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the "Design full cast" bulk voice-design job from silently grinding through every
remaining character with the same doomed GPU-contention error, and stop its status pill from showing a
climbing percent while zero characters are actually succeeding.

**Architecture:** Three independent-but-related fixes, landed in dependency order. (1)+(2) bring
`/qwen/design-voice` and `/qwen/mint-variant` in `server/tts-sidecar/main.py` up to the same
CUDA-poison-detection standard four sibling routes already use, so a GPU-OOM triggers the sidecar's
existing supervised-restart mechanism instead of a swallowed generic 500. (3) widens
`server/src/routes/cast-design.ts`'s per-character retry loop to recognize two systemic-error classes —
"sidecar restarting" (reuses the existing health-poll ride-out) and "GPU busy, no restart" (a new short
bounded sleep) — riding each out briefly before halting the whole job with a clear message, instead of
recording 15 identical failures one by one. (4) fixes the status pill's percent formula
(`src/components/layout.tsx`) so a failure no longer counts as "progress," and surfaces the failure count
inline in the running-state label (`src/components/top-bar.tsx`).

**Tech Stack:** Python/FastAPI (sidecar), Node/Express/TypeScript (server), React/Redux Toolkit
(frontend). Sidecar tests: pytest + `fastapi.testclient.TestClient`. Server tests: Vitest + supertest.
Frontend tests: Vitest + React Testing Library.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-11-cast-design-job-hardening-design.md` (read this
  first for the full rationale — this plan is the "how," that doc is the "why").
- Two `endJob` error `code`s stay separate per explicit user decision: `sidecar_unavailable` (sidecar
  restarting — connection-down OR the new CUDA-poison-restart case) and `gpu_contention` (GPU busy, no
  restart involved — the Node-side `GpuBusyError` eviction refusal).
- The Node-side classifier keys on specific `code` values (`gpu_poisoned`, `GPU_BUSY`), never a blanket
  `status === 503` — `/qwen/mint-variant`'s existing `base17-unavailable` 503 is a *permanent* condition
  (1.7B-Base not installed/corrupt) that must never be treated as retryable contention.
- No new configurability beyond what's specified below — in particular, the new GPU-busy ride-out delay
  is a single hardcoded constant, not a user/registry setting.
- Every step below traces to a section of the spec; don't add scope beyond what's written here.

---

## Task 1: Sidecar — classify CUDA poison in `/qwen/design-voice`

**Files:**
- Modify: `server/tts-sidecar/main.py:5587-5589`
- Test: `server/tts-sidecar/tests/test_qwen_design_poison.py` (new)

**Interfaces:**
- Consumes: existing `_CUDA_POISON_RE` (module-level regex, `main.py:498-505`) and `_mark_cuda_poisoned`
  (module-level function, `main.py:580-589`) — both already defined, used verbatim, no changes to either.
- Produces: on a CUDA-poison-shaped exception, `/qwen/design-voice` now returns
  `{"detail": "GPU is out of memory — likely another job (generation/analysis/design) is using it. Free
  up GPU memory and try again.", "poisoned": true, "code": "gpu_poisoned"}` at HTTP 503 (previously: a
  bare `{"detail": "Internal error."}` at 500 for every exception, poison included). Non-poison
  exceptions are UNCHANGED (still the generic 500). Task 3 consumes the `"code": "gpu_poisoned"` string.

- [ ] **Step 1: Write the failing test**

Create `server/tts-sidecar/tests/test_qwen_design_poison.py`:

```python
"""CUDA-poison classification for /qwen/design-voice and /qwen/mint-variant
(issue: the bulk 'Design full cast' job silently ground through every
character on GPU contention because these two routes never checked
_CUDA_POISON_RE like /transcribe and /embed already do — see
docs/superpowers/specs/2026-07-11-cast-design-job-hardening-design.md)."""

import pytest
from fastapi.testclient import TestClient

import main


def _reset_poison_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirrors test_speaker_embed.py's test_embed_load_poison_is_fenced: clear
    both guard flags so the route reaches the design call, and stub
    _mark_cuda_poisoned so the test process never schedules a real
    threading.Timer-based os._exit."""
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    monkeypatch.setattr(main, "_mark_cuda_poisoned", lambda reason: None)


class _FakeQwenOom(main.QwenEngine):
    def __init__(self):
        pass  # skip the real heavy __init__; the route only calls design_voice

    def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None, mint_method=None, fallback_for=None):
        raise RuntimeError(
            "CUDA out of memory. Tried to allocate 20.00 MiB (GPU 0; 8.00 GiB total capacity; "
            "7.90 GiB already allocated)"
        )


class _FakeQwenOther(main.QwenEngine):
    def __init__(self):
        pass

    def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None, mint_method=None, fallback_for=None):
        raise RuntimeError("some unrelated, unclassified failure")


def test_design_voice_oom_returns_classified_503(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenOom())

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={"voiceId": "qwen-x", "instruct": "warm"})

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "gpu_poisoned"
    assert body["poisoned"] is True
    assert "GPU is out of memory" in body["detail"]
    assert body["detail"] != "Internal error."


def test_design_voice_non_poison_exception_stays_generic_500(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenOther())

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={"voiceId": "qwen-x", "instruct": "warm"})

    assert res.status_code == 500
    assert res.json() == {"detail": "Internal error."}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen_design_poison.py -v`
(or `npm run test:sidecar -- test_qwen_design_poison.py` from repo root)
Expected: FAIL — `test_design_voice_oom_returns_classified_503` asserts `res.status_code == 503` but gets
`500` with `body == {"detail": "Internal error."}` (today's unconditional generic catch).

- [ ] **Step 3: Implement — classify the poison before the generic catch**

In `server/tts-sidecar/main.py`, replace lines 5587-5589:

```python
    except Exception:
        log.exception("/qwen/design-voice failed (voiceId=%s)", voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
```

with:

```python
    except Exception as e:
        err_str = f"{e}"
        if _CUDA_POISON_RE.search(err_str):
            log.warning("/qwen/design-voice CUDA poison (voiceId=%s): %s", voice_id, e)
            _mark_cuda_poisoned(err_str)
            return JSONResponse(
                {
                    "detail": (
                        "GPU is out of memory — likely another job (generation/analysis/design) "
                        "is using it. Free up GPU memory and try again."
                    ),
                    "poisoned": True,
                    "code": "gpu_poisoned",
                },
                status_code=503,
            )
        log.exception("/qwen/design-voice failed (voiceId=%s)", voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen_design_poison.py -v`
Expected: both tests PASS.

- [ ] **Step 5: Run the full sidecar suite to check for regressions**

Run: `npm run test:sidecar` (from repo root)
Expected: PASS (or the pre-existing SKIP banner if the venv isn't bootstrapped — in which case ask the
user to bootstrap it before continuing, per CLAUDE.md's testing discipline).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen_design_poison.py
git commit -m "fix(sidecar): classify CUDA-OOM as poison in /qwen/design-voice

Brings this route to parity with /transcribe, /embed, and two other
sidecar routes that already trigger the supervised restart on a
poisoning CUDA error instead of swallowing it into a generic 500."
```

---

## Task 2: Sidecar — classify CUDA poison in `/qwen/mint-variant`

**Files:**
- Modify: `server/tts-sidecar/main.py:5679-5681`
- Test: `server/tts-sidecar/tests/test_qwen_design_poison.py` (same file as Task 1 — same bug class, one
  more route)

**Interfaces:**
- Consumes: same `_CUDA_POISON_RE` / `_mark_cuda_poisoned` as Task 1.
- Produces: identical response shape to Task 1 (`code: "gpu_poisoned"`, `poisoned: true`, 503) from
  `/qwen/mint-variant`'s generic exception handler. `_ensure_base17_for_mint`'s existing OOM re-raise
  (`main.py:2158-2166`, unmodified) lands exactly here, so this closes the gap for both the base-design
  and mint-variant paths.

- [ ] **Step 1: Write the failing test**

Append to `server/tts-sidecar/tests/test_qwen_design_poison.py`:

```python
class _FakeQwenMintOom(main.QwenEngine):
    def __init__(self):
        pass

    def mint_variant(self, base_voice_id, variant_voice_id, emotion_instruct, language=None, calibration_text=None, voice_uuid=None, report_progress=None):
        raise RuntimeError("CUDA out of memory. Tried to allocate 20.00 MiB (GPU 0; 8.00 GiB total capacity)")


class _FakeQwenMintOther(main.QwenEngine):
    def __init__(self):
        pass

    def mint_variant(self, base_voice_id, variant_voice_id, emotion_instruct, language=None, calibration_text=None, voice_uuid=None, report_progress=None):
        raise RuntimeError("some unrelated, unclassified failure")


def _mint_body():
    return {
        "baseVoiceId": "qwen-base",
        "variantVoiceId": "qwen-base__angry",
        "emotionInstruct": "Delivered angrily, with raised intensity and edge.",
    }


def test_mint_variant_oom_returns_classified_503(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenMintOom())

    client = TestClient(main.app)
    res = client.post("/qwen/mint-variant", json=_mint_body())

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "gpu_poisoned"
    assert body["poisoned"] is True
    assert "GPU is out of memory" in body["detail"]


def test_mint_variant_non_poison_exception_stays_generic_500(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenMintOther())

    client = TestClient(main.app)
    res = client.post("/qwen/mint-variant", json=_mint_body())

    assert res.status_code == 500
    assert res.json() == {"detail": "Internal error."}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen_design_poison.py -v`
Expected: the two new `test_mint_variant_*` tests FAIL (same reason as Task 1 — the route's generic
catch swallows the poison into a plain 500).

- [ ] **Step 3: Implement — classify the poison before the generic catch**

In `server/tts-sidecar/main.py`, replace lines 5679-5681:

```python
    except Exception:
        log.exception("/qwen/mint-variant failed (baseVoiceId=%s)", base_voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
```

with:

```python
    except Exception as e:
        err_str = f"{e}"
        if _CUDA_POISON_RE.search(err_str):
            log.warning("/qwen/mint-variant CUDA poison (baseVoiceId=%s): %s", base_voice_id, e)
            _mark_cuda_poisoned(err_str)
            return JSONResponse(
                {
                    "detail": (
                        "GPU is out of memory — likely another job (generation/analysis/design) "
                        "is using it. Free up GPU memory and try again."
                    ),
                    "poisoned": True,
                    "code": "gpu_poisoned",
                },
                status_code=503,
            )
        log.exception("/qwen/mint-variant failed (baseVoiceId=%s)", base_voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen_design_poison.py -v`
Expected: all four tests in the file PASS.

- [ ] **Step 5: Run the full sidecar suite to check for regressions**

Run: `npm run test:sidecar` (from repo root)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen_design_poison.py
git commit -m "fix(sidecar): classify CUDA-OOM as poison in /qwen/mint-variant

Same fix as the prior design-voice commit, applied to the sibling
mint-variant route — _ensure_base17_for_mint's existing OOM re-raise
lands in this route's generic except block."
```

---

## Task 3: Server — two-branch systemic-error ride-out in the bulk design loop

**Files:**
- Modify: `server/src/routes/cast-design.ts:93-97` (constants), `:363-437` (per-character retry loop)
- Test: `server/src/routes/cast-design.test.ts`

**Interfaces:**
- Consumes: `code: "gpu_poisoned"` on the sidecar's 503 response (Task 1/2 — reaches Node as
  `SidecarDesignError.code`, already parsed by the existing fetch path in `qwen-voice.ts:382-391`, no
  changes needed there); the existing `GpuBusyError` class (`server/src/gpu/gpu-load.js`, `.code ===
  'GPU_BUSY'`); the existing `ensureSidecarEngineReady` (`server/src/tts/ensure-sidecar-loaded.js`).
- Produces: `endJob(job, { type: 'error', code: 'sidecar_unavailable' | 'gpu_contention', message })` on
  ride-out exhaustion — unchanged shape/consumers (the existing `onError` handler in
  `cast-design-stream-middleware.ts` already dispatches `halt` + a toast for any `endJob` error event
  regardless of `code`, so no client-side change is needed there).

- [ ] **Step 1: Write the failing tests**

Add to `server/src/routes/cast-design.test.ts`, inside the existing
`describe('POST /api/books/:bookId/cast/design', ...)` block, right after the existing "halts with
sidecar_unavailable only after the ride-out retries are exhausted" test (after line 387):

```ts
  it('rides out the recycling drain-fence message too (widened SIDECAR_DOWN_RE)', async () => {
    /* Pre-existing gap found during spec review: "Voice engine is recycling to
       free memory; retry shortly." never matched the old SIDECAR_DOWN_RE, so
       this transient case was ALSO wrongly treated as an ordinary per-character
       failure before this fix. */
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined);
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(new Error('Voice engine is recycling to free memory; retry shortly.'))
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 1, total: 1 });
    expect(ensureSpy).toHaveBeenCalled();

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  });

  it('rides out a gpu_poisoned sidecar response via the health-poll wait, then completes', async () => {
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined); // sidecar reports ready again
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(
        Object.assign(new Error('GPU is out of memory — likely another job is using it.'), {
          code: 'gpu_poisoned',
          status: 503,
        }),
      )
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 1, total: 1 });
    expect(ensureSpy).toHaveBeenCalled(); // used the health-poll wait, not a raw sleep
    expect(designSpy).toHaveBeenCalledTimes(2);

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  });

  it('halts with gpu_contention (not sidecar_unavailable) after a GPU_BUSY ride-out is exhausted', async () => {
    const ensureSpy = vi.spyOn(ensureMod, 'ensureSidecarEngineReady');
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValue(
        Object.assign(new Error('GPU busy with analysis — try again once it finishes.'), {
          code: 'GPU_BUSY',
        }),
      );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.code).toBe('gpu_contention');
    expect(errorEvent?.message).toContain('0 of 2 designed');
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);
    expect(designSpy).toHaveBeenCalledTimes(1 + MAX_RECYCLE_RIDEOUTS);
    /* GPU_BUSY uses the new bounded sleep, NOT the sidecar health-poll wait —
       ensureSidecarEngineReady must never be called for this class. */
    expect(ensureSpy).not.toHaveBeenCalled();

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  }, 10_000);

  it('base17-unavailable is NOT treated as systemic — records a per-character failure and continues', async () => {
    const ensureSpy = vi.spyOn(ensureMod, 'ensureSidecarEngineReady');
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(
        Object.assign(new Error("Qwen 1.7B-Base unavailable (not-installed)."), {
          code: 'base17-unavailable',
          status: 503,
        }),
      )
      .mockResolvedValue({ voiceId: 'qwen-v_brann' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.some((e) => e.type === 'character_failed' && e.characterId === 'aria')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'brann')).toBe(true);
    /* No ride-out attempted for a permanent condition. */
    expect(designSpy).toHaveBeenCalledTimes(2); // one failed attempt (aria) + one success (brann)
    expect(ensureSpy).not.toHaveBeenCalled();

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  });

  it('regression: a non-abort error during the sidecar-restart wait retries instead of silently dropping the character', async () => {
    /* Bug found during spec review: the OLD code's `catch { break }` around
       ensureSidecarEngineReady treated ANY thrown error there as a clean
       pause and silently exited without recording done/skipped/failures.
       ensureSidecarEngineReady wraps withGpuLoad, which CAN throw
       GpuBusyError (analysis contention) during the wait itself — that must
       NOT be treated as a run-level abort. */
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockRejectedValueOnce(
        Object.assign(new Error('GPU busy with analysis — try again once it finishes.'), {
          code: 'GPU_BUSY',
        }),
      )
      .mockResolvedValue(undefined); // second ride-out's wait succeeds
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(new Error('TTS sidecar (http://localhost:9000) is unreachable'))
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    const idle = events.find((e) => e.type === 'idle');
    /* The character must be accounted for — either designed here (this test's
       retry path succeeds) or, at minimum, never silently vanish from
       done+skipped+failures. */
    expect(idle).toBeDefined();
    expect((idle!.done as number) + (idle!.skipped as number) + (idle!.failures as unknown[]).length).toBe(1);

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  });
```

Add these two lines near the top of the file's shared imports/setup (they're new named exports Step 3
adds to `cast-design.ts`) — find the existing `MAX_RECYCLE_RIDEOUTS = castDesign.MAX_RECYCLE_RIDEOUTS;`
line (line 205) and confirm no change is needed there (it already reads the export live) — no edit
required for this step, just noting the dependency.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts`
Expected: FAIL — the four new systemic-path tests fail because `code: 'gpu_poisoned'` and `code:
'GPU_BUSY'` aren't recognized yet (today's code only checks `SIDECAR_DOWN_RE` against the message, so
these all fall through to "per-character failure, record and continue" — e.g. the `gpu_contention` halt
test will find no `error` event at all). The `base17-unavailable` test may already pass today (it's a
regression guard, not a new behavior) — that's fine, it just won't have been exercised before.

- [ ] **Step 3: Implement — widen the regex, add classifiers, add the sleep helper, restructure the retry loop**

In `server/src/routes/cast-design.ts`, replace lines 93-97:

```ts
export const MAX_RECYCLE_RIDEOUTS = 2;

/* The error-message shapes that mean "the sidecar is down / recycling" (vs. a
   per-character synthesis failure that should be recorded and skipped past). */
const SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding/i;
```

with:

```ts
export const MAX_RECYCLE_RIDEOUTS = 2;

/* The error-message shapes that mean "the sidecar is down / recycling" (vs. a
   per-character synthesis failure that should be recorded and skipped past).
   Widened to also recognize the existing drain-fence "recycling" 503
   ("Voice engine is recycling to free memory; retry shortly.") — that
   transient case never matched this regex before and was wrongly treated as
   an ordinary per-character failure (found auditing every 503 shape this
   route can return, see the design spec's review-findings section). */
const SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding|recycling/i;

/* Bounded pause between GPU-busy ride-out retries. Deliberately short and
   NOT test-configurable (kept simple per the spec's non-goals) — real
   contention from another job almost always outlasts any reasonable
   constant anyway, so this only meaningfully helps a brief, sub-second
   blip; its main job is to not hammer the same busy resource in a tight
   loop before giving up and halting with a clear message. */
const GPU_BUSY_RIDEOUT_MS = 1_000;

/* Abort-aware setTimeout — same idiom as ensure-sidecar-loaded.ts:217,
   retry.ts:103, analyzer/gemini.ts:821 (each file keeps its own local copy
   rather than a shared export, matching this codebase's existing
   convention for this exact helper). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('cast-design GPU-busy ride-out sleep aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* "Sidecar is down or restarting" — a connection-level failure OR the
   sidecar's own CUDA-poison classification (which schedules a supervised
   restart, see server/tts-sidecar/main.py's _mark_cuda_poisoned). The
   existing ensureSidecarEngineReady health-poll is the right wait for both:
   it already treats a `poisoned: true` /health response as "keep waiting". */
function isSidecarRestartClass(e: unknown, message: string): boolean {
  return SIDECAR_DOWN_RE.test(message) || (e as { code?: string } | null)?.code === 'gpu_poisoned';
}

/* "GPU busy, no sidecar restart involved" — the Node-side GpuBusyError
   thrown by withGpuLoad when the local Ollama analyzer is resident and busy.
   Reusing ensureSidecarEngineReady for this would immediately re-throw
   ANOTHER GpuBusyError (it wraps the same withGpuLoad check), not resolve
   "ready" — so this class gets its own short explicit sleep instead. */
function isGpuBusyClass(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'GPU_BUSY';
}
```

Then replace lines 402-436 (the whole `catch (e) { ... }` block):

```ts
        } catch (e) {
          const message = (e as Error).message || 'Voice design failed.';
          if (SIDECAR_DOWN_RE.test(message)) {
            /* Sidecar down/recycling. Ride out the respawn and retry this
               character — unless we've exhausted the budget (genuinely dead) or
               the job was cancelled, in which case stop the run. */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId }); // keep the pill alive through the respawn
              try {
                await ensureSidecarEngineReady('qwen', job.controller.signal);
              } catch {
                /* aborted (pause) during the wait — stop cleanly; the outer
                   loop's abort-check ends the job. */
                break;
              }
              continue; // sidecar should be back — retry this character
            }
            /* Exhausted ride-outs (or aborted): a still-down sidecar would fail
               every remaining character identically — stop with a catastrophic
               error instead of grinding through N timeouts. */
            clearInterval(heartbeat);
            endJob(job, { type: 'error', code: 'sidecar_unavailable', message });
            return;
          }
          /* Per-character synthesis failure — record it and move on. */
          job.failures.push({ characterId, name: character.name ?? characterId, error: message });
          broadcast(job, {
            type: 'character_failed',
            characterId,
            name: character.name ?? characterId,
            errorReason: message,
          });
          break;
        }
```

with:

```ts
        } catch (e) {
          const message = (e as Error).message || 'Voice design failed.';
          if (isSidecarRestartClass(e, message)) {
            /* Sidecar down/recycling/poison-restarting. Ride out the respawn
               and retry this character — unless we've exhausted the budget
               (genuinely dead) or the job was cancelled, in which case stop
               the run. */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId }); // keep the pill alive through the respawn
              try {
                await ensureSidecarEngineReady('qwen', job.controller.signal);
              } catch {
                /* Only a genuine run-level abort is a clean stop here — the
                   outer loop's abort-check ends the job. Anything else (e.g.
                   ensureSidecarEngineReady's own withGpuLoad wrap throwing a
                   GpuBusyError mid-wait) falls through to retry instead of
                   silently dropping this character's accounting (bug found
                   during spec review — the old code broke unconditionally on
                   ANY throw here). rideouts is already bounded above. */
                if (job.controller.signal.aborted) break;
              }
              continue; // retry this character
            }
            /* Exhausted ride-outs (or aborted): a still-down sidecar would fail
               every remaining character identically — stop with a catastrophic
               error instead of grinding through N timeouts. */
            clearInterval(heartbeat);
            endJob(job, {
              type: 'error',
              code: 'sidecar_unavailable',
              message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
            });
            return;
          }
          if (isGpuBusyClass(e)) {
            /* GPU busy (no restart involved) — a short bounded pause, then
               retry; NOT the sidecar health-poll (that would just re-throw
               the same GpuBusyError immediately, not actually wait). */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId });
              try {
                await sleep(GPU_BUSY_RIDEOUT_MS, job.controller.signal);
              } catch {
                break; // aborted during the wait — clean stop
              }
              continue; // retry this character
            }
            clearInterval(heartbeat);
            endJob(job, {
              type: 'error',
              code: 'gpu_contention',
              message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
            });
            return;
          }
          /* Per-character synthesis failure — record it and move on. */
          job.failures.push({ characterId, name: character.name ?? characterId, error: message });
          broadcast(job, {
            type: 'character_failed',
            characterId,
            name: character.name ?? characterId,
            errorReason: message,
          });
          break;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts`
Expected: all tests in the file PASS, including the four new ones and the pre-existing suite (the
existing "rides out a mid-bulk sidecar recycle" and "halts with sidecar_unavailable" tests must still
pass unchanged — `isSidecarRestartClass` is a strict superset of the old `SIDECAR_DOWN_RE`-only check for
those message shapes).

- [ ] **Step 5: Typecheck**

Run: `cd server && npm run typecheck` (or `npm run typecheck` from repo root, which covers both)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "fix(server): ride out GPU contention in the bulk design job instead of grinding through it

Two systemic-error classes now get a bounded ride-out before the job
halts with a clear message: sidecar-restarting (widened SIDECAR_DOWN_RE
+ the new gpu_poisoned code, reusing the existing health-poll wait) and
GPU-busy-no-restart (GpuBusyError, a new short explicit sleep). Also
fixes a latent bug where any non-abort error during the health-poll
wait silently dropped a character's accounting."
```

---

## Task 4: Frontend — stop counting failures as progress, surface the failure count while running

**Files:**
- Modify: `src/components/layout.tsx:1449-1450`, `src/components/top-bar.tsx:1053`
- Test: `src/components/layout.test.tsx`, `src/components/top-bar.test.tsx`

**Interfaces:**
- Consumes: nothing new — `DesignPillData.failureCount` already exists and is already threaded through
  (`top-bar.tsx:1016`), just not rendered in the `'running'` branch yet.
- Produces: nothing new consumed elsewhere — purely a display fix.

- [ ] **Step 1: Write the failing test — component level (top-bar.test.tsx)**

In `src/components/top-bar.test.tsx`, inside the `describe('DesignPill', ...)` block, add right after
the existing `'renders the running summary "Designing · done/total · percent"'` test (after line 485):

```ts
  it('surfaces the failure count inline while running (not just in the terminal summary)', () => {
    render(
      <DesignPill
        data={{
          state: 'running',
          done: 2,
          total: 6,
          percent: 83,
          skipped: 3,
          failureCount: 1,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId('design-pill')).toHaveTextContent('2/6 · 1 failed · 83%');
  });

  it('omits the failed segment when nothing has failed', () => {
    render(
      <DesignPill
        data={{
          state: 'running',
          done: 3,
          total: 8,
          percent: 38,
          skipped: 0,
          failureCount: 0,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId('design-pill')).toHaveTextContent('3/8 · 38%');
    expect(screen.getByTestId('design-pill')).not.toHaveTextContent('failed');
  });
```

- [ ] **Step 2: Write the failing test — selector level (layout.test.tsx)**

In `src/components/layout.test.tsx`, add a new describe block right after the existing `describe('Layout
— Export status pill (fs-54)', ...)` block (after line 713):

```ts
describe('Layout — Design status pill percent excludes failures (issue: "0/16 · 94%")', () => {
  it('does not inflate percent when every processed character has failed', async () => {
    const store = makeStore();
    store.dispatch(
      castDesignSlice.actions.begin({
        bookId: 'b1',
        total: 16,
        currentName: 'Narrator',
        lastTickAt: Date.parse('2026-01-01T00:00:00Z'),
      }),
    );
    for (let i = 0; i < 15; i += 1) {
      store.dispatch(
        castDesignSlice.actions.charFailed({
          bookId: 'b1',
          characterId: `char_${i}`,
          name: `Char ${i}`,
          error: 'GPU is out of memory — likely another job is using it.',
          lastTickAt: Date.parse('2026-01-01T00:00:00Z'),
        }),
      );
    }

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('design-pill');
    expect(pill).toHaveTextContent('0/16');
    expect(pill).toHaveTextContent('15 failed');
    /* The bug: this used to read "94%" (15 failures / 16 counted as
       "progress"). Failures no longer count toward percent. */
    expect(pill).not.toHaveTextContent('94%');
    expect(pill).toHaveTextContent('0%');
  });
});
```

Confirm `castDesignSlice` is already imported in this file (it is, per line 33 — `import {
castDesignSlice } from '../store/cast-design-slice';`) and that `fireEvent` is already imported from
`@testing-library/react` (check the existing imports near the top of the file; the "Export status pill"
block above already uses it, so it must already be imported — no new import needed).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/components/top-bar.test.tsx src/components/layout.test.tsx`
Expected: FAIL — `top-bar.test.tsx`'s new "surfaces the failure count inline" test fails because the
running-branch summary doesn't include `failureCount` yet; `layout.test.tsx`'s new test fails because the
pill currently shows `94%`, not `0%`.

- [ ] **Step 4: Implement — layout.tsx percent formula**

In `src/components/layout.tsx`, replace lines 1449-1450:

```ts
    const completed = done + skipped + failures.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
```

with:

```ts
    const completed = done + skipped;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
```

- [ ] **Step 5: Implement — top-bar.tsx running-state summary**

In `src/components/top-bar.tsx`, replace line 1053:

```ts
      : `${done}/${total}${total > 0 ? ` · ${percent}%` : ''}`;
```

with:

```ts
      : `${done}/${total}${failureCount > 0 ? ` · ${failureCount} failed` : ''}${total > 0 ? ` · ${percent}%` : ''}`;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/components/top-bar.test.tsx src/components/layout.test.tsx`
Expected: all tests PASS, including the pre-existing DesignPill/Layout tests (the running-summary test
for `failureCount: 0` must render identically to before — verify `'renders the running summary
"Designing · done/total · percent"'` still passes unchanged).

- [ ] **Step 7: Run the full frontend suite to check for regressions**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/layout.tsx src/components/top-bar.tsx src/components/layout.test.tsx src/components/top-bar.test.tsx
git commit -m "fix(frontend): stop counting design-job failures as progress

The Design pill's percent silently included failures.length in its
numerator while the visible X/Y text showed only successes — a run
failing almost everything still read as nearly complete ('0/16 · 94%').
Failures no longer inflate percent; the running-state label also now
surfaces the failure count inline instead of hiding it until the
terminal toast."
```

---

## After all tasks: branch-level verification

- [ ] **Step 1: Run the branch-scoped verify battery**

Run: `npm run verify:fast:branch`
Expected: PASS (lint, typecheck, test, test:server, build, and test:sidecar since this branch touches
`server/tts-sidecar/**`).

- [ ] **Step 2: Update the regression plan**

This work has no existing `docs/features/*.md` plan to update (it's a bug-hardening fix, not a new
feature) — per CLAUDE.md's before-shipping checklist, small/localized items skip the plan doc; the spec
at `docs/superpowers/specs/2026-07-11-cast-design-job-hardening-design.md` plus the paired tests above
are the spec of record. Note this explicitly in the PR description rather than silently omitting it.

- [ ] **Step 3: Update release notes**

Append an entry to `docs/release-notes-next.md` (technical register) and a matching user-facing,
brand-voice line to the in-progress version section at the top of `RELEASE_NOTES.md`, per CLAUDE.md's
"Update the two release-notes documents" step. Read both files' current top section first to match
existing entry style/tone before appending.

- [ ] **Step 4: File and link the GitHub issue, open the PR**

Per CLAUDE.md: this is bug-shaped work, so it gets the standalone `bug` label. File the issue (title
summarizing the "0/16 · 94%" + silent-grind symptom), then open the PR with `Closes #NN` in the body.
PR title must match the commit-convention subject format; since this PR spans three scopes
(sidecar/server/frontend), CONTRIBUTING.md's multi-scope guidance suggests the commits stay separately
scoped (as done above) while the PR title itself picks the dominant scope — use `fix(server): harden
cast design job against GPU contention` as the PR title, with the frontend/sidecar detail in the PR
body's Summary section.

- [ ] **Step 5: Mandatory independent code-review pass**

Per CLAUDE.md's Model routing → Mandatory independent review gate: this is a multi-scope PR (sidecar +
server + frontend), so it gets **high** effort. Run the `code-review` skill (no `--fix`) once the branch
is pushed, before merge. Triage and fold findings.
