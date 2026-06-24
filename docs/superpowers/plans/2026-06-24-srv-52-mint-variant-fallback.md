# srv-52 Mint-Variant → Design-Voice Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Qwen 1.7B-Base model is not-installed or corrupt, the server transparently mints the requested emotion variant via `/qwen/design-voice` (persona + emotion clause) instead of failing — logged, marked on disk, and surfaced in the bulk Design panel; a transient OOM stays a loud failure.

**Architecture:** Sidecar-decides / server-reacts. The sidecar classifies a Base17 failure (not-installed / corrupt / OOM) and returns a distinct `503 {code:"base17-unavailable", reason}` for the first two; an OOM stays a generic 500. The server's `designQwenVoiceForCharacter` catches that signal, resolves a persona, and re-routes the variant to `/qwen/design-voice`. The produced `.pt` is a 0.6B clone prompt — format-identical to an anchored mint, so it is render-compatible.

**Tech Stack:** Python (FastAPI sidecar, pytest), TypeScript (Express server + Vitest), React/Redux-Toolkit frontend (Vitest + RTL).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-srv-52-mint-variant-design-voice-fallback-design.md` — read it before starting.
- **Worktree:** all work happens in `C:\Claude\Projects\Audiobook-Generator-wt-srv52` on branch `docs/srv-52-mint-variant-fallback-spec` (rename to `feat/srv-52-mint-variant-fallback` if desired). NEVER touch the main checkout `C:\Claude\Projects\Audiobook-Generator`.
- **No `--no-verify`.** Husky hooks must pass. `node_modules` is junctioned into the worktree so they run.
- **OOM is NEVER a fallback trigger.** The `"out of memory"` substring is the PRIMARY OOM gate (exception-type check is belt-and-suspenders). Misclassifying an OOM as corrupt → firing the fallback is the cardinal failure this feature forbids.
- **Narrow catch:** only the Base17 *load* may be classified as corrupt — never the decode / instruct-synth / 0.6B distil phases of `mint_variant`.
- **Ordering:** the base-`.pt` `VoiceNotDesignedError → 409` always precedes the not-installed `503`.
- **Commit convention:** `<type>(<scope>): <subject>`; allowed scopes include `sidecar`, `server`, `frontend`. End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands run from the worktree root** unless noted. Sidecar pytest is venv-gated (`server/tts-sidecar/.venv`); if absent it SKIPs — note that, don't treat as pass.

---

## File Structure

**Sidecar (`server/tts-sidecar/`)**
- `main.py` — new `Base17UnavailableError`, `_qwen_base17_weights_present()`, `QwenEngine._ensure_base17_for_mint()`; wire into `mint_variant` + the `/qwen/mint-variant` route; `/qwen/design-voice` provenance fields; `/health` field.
- `tests/test_qwen3.py` — classification + provenance + health tests.

**Server (`server/src/routes/`)**
- `sidecar-health.ts` — forward `qwenBase17WeightsPresent`.
- `qwen-voice.ts` — `SidecarDesignError`, `postDesignAndCache` extraction, fallback control flow + persona resolution + widened return.
- `cast-design.ts` — `variant_designed` gains `viaFallback`/`fallbackReason`.
- `*.test.ts` colocated.

**Frontend (`src/`)**
- `lib/api.ts` — widen `onVariantDesigned` payload + SSE parse.
- `store/cast-design-slice.ts` — `fallbacks: CastDesignFallback[]` ({characterId, emotion}) + `variantFellBack` reducer (guards on `state.active`).
- `store/cast-design-stream-middleware.ts` — dispatch `variantFellBack` on `viaFallback` (`onVariantDesigned`); add a `· N via fallback` part to the `onIdle` completion toast (the real summary surface — there is no failures-list component).
- `*.test.ts` colocated.

---

## Task 1: Sidecar — `qwen_base17_weights_present` in `/health`

**Files:**
- Modify: `server/tts-sidecar/main.py` (new helper near `_qwen_weights_present` ~3428; `/health` dict ~3655-3670)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Produces: module fn `_qwen_base17_weights_present() -> bool`; `/health` JSON key `"qwen_base17_weights_present": bool`.

- [ ] **Step 1: Write the failing test**

Add to `server/tts-sidecar/tests/test_qwen3.py`:

```python
def test_base17_weights_present_true_when_blob_exists(tmp_path, monkeypatch):
    import main
    repo = tmp_path / ("models--" + main.QwenEngine.BASE17_MODEL.replace("/", "--"))
    snap = repo / "snapshots" / "abc"
    snap.mkdir(parents=True)
    (snap / "model.safetensors").write_bytes(b"x")
    monkeypatch.setattr(main, "_qwen_hub_cache_dir", lambda: str(tmp_path))
    assert main._qwen_base17_weights_present() is True


def test_base17_weights_present_false_when_absent(tmp_path, monkeypatch):
    import main
    monkeypatch.setattr(main, "_qwen_hub_cache_dir", lambda: str(tmp_path))
    assert main._qwen_base17_weights_present() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k base17_weights -v`
Expected: FAIL with `AttributeError: module 'main' has no attribute '_qwen_base17_weights_present'`

- [ ] **Step 3: Add the helper**

In `server/tts-sidecar/main.py`, immediately after `_qwen_weights_present()` (ends ~3445):

```python
def _qwen_base17_weights_present() -> bool:
    """True if the 1.7B-Base snapshot holds at least one real weight blob.
    Mirrors `_qwen_weights_present` but targets `QwenEngine.BASE17_MODEL` (the
    anchored emotion-variant engine, fs-55). Read the constant at call time so
    a QWEN_BASE_17B_MODEL env override is honoured."""
    repo_dir = os.path.join(
        _qwen_hub_cache_dir(),
        "models--" + QwenEngine.BASE17_MODEL.replace("/", "--"),
    )
    snapshots = os.path.join(repo_dir, "snapshots")
    if not os.path.isdir(snapshots):
        return False
    try:
        for _root, _dirs, files in os.walk(snapshots):
            for fname in files:
                if fname.endswith(_QWEN_WEIGHT_SUFFIXES):
                    return True
    except OSError:
        return False
    return False
```

- [ ] **Step 4: Add the `/health` field**

In the `/health` return dict (after `"qwen_weights_present": qwen_weights_present,` ~3669):

```python
        "qwen_base17_weights_present": _qwen_base17_weights_present(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k base17_weights -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(sidecar): report qwen_base17_weights_present in /health"
```

---

## Task 2: Sidecar — classify Base17 unavailability (not-installed / corrupt / OOM)

**Files:**
- Modify: `server/tts-sidecar/main.py` (new exception near `VoiceNotDesignedError`; new `QwenEngine._ensure_base17_for_mint`; `mint_variant` ~2006/2008; `/qwen/mint-variant` route ~4076-4081)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `_qwen_base17_weights_present()` (Task 1), `_ensure_base17_loaded()` (existing).
- Produces: `Base17UnavailableError(reason: str)` with `.reason ∈ {"not-installed","corrupt"}`; `QwenEngine._ensure_base17_for_mint() -> None`; `/qwen/mint-variant` returns `503 {"code":"base17-unavailable","reason","detail"}` for those, `500` for OOM/other, `409` for missing base.

- [ ] **Step 1: Write the failing tests**

Add to `server/tts-sidecar/tests/test_qwen3.py` (the `fake_qwen_runtime` fixture builds a `QwenEngine` with fakes; reuse it):

```python
def test_ensure_base17_for_mint_not_installed(fake_qwen_runtime, monkeypatch):
    import main
    eng = fake_qwen_runtime["engine"]
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: False)
    with pytest.raises(main.Base17UnavailableError) as ei:
        eng._ensure_base17_for_mint()
    assert ei.value.reason == "not-installed"


def test_ensure_base17_for_mint_corrupt_on_nonoom(fake_qwen_runtime, monkeypatch):
    import main
    eng = fake_qwen_runtime["engine"]
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: True)
    def boom(): raise RuntimeError("bad safetensors header")
    monkeypatch.setattr(eng, "_ensure_base17_loaded", boom)
    with pytest.raises(main.Base17UnavailableError) as ei:
        eng._ensure_base17_for_mint()
    assert ei.value.reason == "corrupt"


def test_ensure_base17_for_mint_reraises_oom(fake_qwen_runtime, monkeypatch):
    import main
    eng = fake_qwen_runtime["engine"]
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: True)
    def oom(): raise RuntimeError("CUDA out of memory: tried to allocate 2 GiB")
    monkeypatch.setattr(eng, "_ensure_base17_loaded", oom)
    with pytest.raises(RuntimeError) as ei:   # NOT Base17UnavailableError
        eng._ensure_base17_for_mint()
    assert "out of memory" in str(ei.value).lower()
    assert not isinstance(ei.value, main.Base17UnavailableError)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k base17_for_mint -v`
Expected: FAIL with `AttributeError: module 'main' has no attribute 'Base17UnavailableError'`

- [ ] **Step 3: Add the exception class**

In `server/tts-sidecar/main.py`, next to `VoiceNotDesignedError` (search for `class VoiceNotDesignedError`):

```python
class Base17UnavailableError(Exception):
    """The 1.7B-Base model can't be used for an anchored mint for a
    deterministic reason the separate VoiceDesign model won't share. The
    mint route maps it to a 503 the server treats as a design-voice fallback
    signal. `reason` is 'not-installed' (weights absent) or 'corrupt' (weights
    present but the load raised a non-OOM error). A CUDA OOM is NOT this — it
    re-raises as a generic error (no fallback)."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Qwen 1.7B-Base unavailable ({reason}).")
        self.reason = reason
```

- [ ] **Step 4: Add the classified-load method**

In `class QwenEngine`, immediately after `_ensure_base17_loaded` (~1473):

```python
    def _ensure_base17_for_mint(self) -> None:
        """Mint-only: ensure the 1.7B-Base is available, raising a typed
        Base17UnavailableError the mint route maps to the 503 fallback signal.
        A CUDA OOM is re-raised unchanged (generic 500, no fallback). Other
        callers keep using _ensure_base17_loaded() and are unaffected."""
        import torch  # type: ignore

        if not _qwen_base17_weights_present():
            raise Base17UnavailableError("not-installed")
        try:
            self._ensure_base17_loaded()
        except Exception as e:  # noqa: BLE001 — classify then re-raise
            msg = str(e).lower()
            if "out of memory" in msg or isinstance(
                e, getattr(torch.cuda, "OutOfMemoryError", ())
            ):
                raise  # OOM → generic 500, NEVER a fallback
            raise Base17UnavailableError("corrupt") from e
```

- [ ] **Step 5: Run the engine-level tests to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k base17_for_mint -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Wire the method into `mint_variant`**

In `mint_variant`, replace the two `self._ensure_base17_loaded()` calls (~2006 and ~2008) with `self._ensure_base17_for_mint()`. Leave everything else (kokoro evict, decode, instruct-synth, 0.6B distil) unchanged.

- [ ] **Step 7: Map the typed error in the route**

In `qwen_mint_variant` (`/qwen/mint-variant`), add an `except` arm BEFORE the existing generic `except Exception` (~4079):

```python
    except VoiceNotDesignedError as exc:
        log.warning("/qwen/mint-variant: base voice not designed — %s", exc)
        return JSONResponse({"detail": str(exc)}, status_code=409)
    except Base17UnavailableError as exc:
        log.warning("/qwen/mint-variant: 1.7B-Base %s", exc.reason)
        return JSONResponse(
            {"code": "base17-unavailable", "reason": exc.reason, "detail": str(exc)},
            status_code=503,
        )
    except Exception:
        log.exception("/qwen/mint-variant failed (baseVoiceId=%s)", base_voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
```

- [ ] **Step 8: Write the route-level tests**

Add to `server/tts-sidecar/tests/test_qwen3.py` (follow the existing TestClient pattern in that file for `/qwen/mint-variant` — find an existing mint-variant route test and mirror its client setup). The body must include a designed base so the 409 path isn't hit:

```python
def test_mint_variant_route_503_not_installed(qwen_test_client, designed_base_voice):
    # base voice exists; base17 weights absent
    import main
    main._qwen_base17_weights_present = lambda: False  # or monkeypatch in fixture
    r = qwen_test_client.post("/qwen/mint-variant", json={
        "baseVoiceId": designed_base_voice, "variantVoiceId": designed_base_voice + "__angry",
        "emotionInstruct": "Delivered angrily.",
    })
    assert r.status_code == 503
    body = r.json()
    assert body["code"] == "base17-unavailable"
    assert body["reason"] == "not-installed"


def test_mint_variant_route_500_on_oom(qwen_test_client, designed_base_voice, monkeypatch):
    import main
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: True)
    eng = main.ENGINES["qwen"]
    def oom(): raise RuntimeError("CUDA out of memory")
    monkeypatch.setattr(eng, "_ensure_base17_loaded", oom)
    r = qwen_test_client.post("/qwen/mint-variant", json={
        "baseVoiceId": designed_base_voice, "variantVoiceId": designed_base_voice + "__angry",
        "emotionInstruct": "Delivered angrily.",
    })
    assert r.status_code == 500
    assert "code" not in r.json()  # NOT a fallback signal
```

> **Net-new test infra (H2):** `qwen_test_client` and `designed_base_voice` do
> NOT exist in `test_qwen3.py` — build them locally from the existing
> mint-variant route test's setup (~`:1129-1209`): `TestClient(main.app)` +
> `engine.design_voice("v1", …)` to create a base first. **Critical:** the
> existing route tests stub the whole engine method via `_fake_mint_variant(...)`
> — these 503/500 tests must NOT do that, or they bypass `_ensure_base17_for_mint`
> entirely and test nothing. Instead `monkeypatch` `_qwen_base17_weights_present`
> and/or `engine._ensure_base17_loaded` so the REAL `mint_variant` →
> `_ensure_base17_for_mint` path runs and raises. Keep the fixtures local.

- [ ] **Step 9: Run the full qwen test file**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -v`
Expected: PASS (all, including the new 503/500 route tests)

- [ ] **Step 10: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(sidecar): classify 1.7B-Base mint failures (not-installed/corrupt/OOM)"
```

---

## Task 3: Sidecar — `/qwen/design-voice` provenance fields

**Files:**
- Modify: `server/tts-sidecar/main.py` (`design_voice` signature + manifest write ~1837/1914; `/qwen/design-voice` route ~3989)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Produces: `/qwen/design-voice` accepts optional body `mintMethod: str`, `fallbackFor: {baseVoiceId, emotion}`; when present they are written into the voice's `.json` manifest.

- [ ] **Step 1: Write the failing test**

```python
def test_design_voice_writes_fallback_provenance(fake_qwen_runtime, tmp_path):
    import json, os
    eng = fake_qwen_runtime["engine"]
    eng.design_voice(
        "qwen-x__angry", "a warm narrator", "english", "Hello.", None,
        mint_method="design-voice-fallback",
        fallback_for={"baseVoiceId": "qwen-x", "emotion": "angry"},
    )
    _pt, jpath = eng._voice_paths("qwen-x__angry")
    meta = json.loads(open(jpath, encoding="utf-8").read())
    assert meta["mintMethod"] == "design-voice-fallback"
    assert meta["fallbackFor"] == {"baseVoiceId": "qwen-x", "emotion": "angry"}


def test_design_voice_manifest_unchanged_without_provenance(fake_qwen_runtime):
    import json
    eng = fake_qwen_runtime["engine"]
    eng.design_voice("qwen-y", "a warm narrator", "english", "Hello.", None)
    _pt, jpath = eng._voice_paths("qwen-y")
    meta = json.loads(open(jpath, encoding="utf-8").read())
    assert "mintMethod" not in meta and "fallbackFor" not in meta
```

- [ ] **Step 2: Run to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k provenance -v`
Expected: FAIL with `TypeError: design_voice() got an unexpected keyword argument 'mint_method'`

- [ ] **Step 3: Extend `design_voice`**

Change the signature (~1837) to add two optional params:

```python
    def design_voice(
        self, voice_id: str, instruct: str, language: Optional[str],
        calibration_text: Optional[str], voice_uuid: Optional[str] = None,
        mint_method: Optional[str] = None,
        fallback_for: Optional[dict] = None,
    ) -> SynthResult:
```

In the manifest dict written via `_json.dump` (~1914-1924), after `"designModel": self.VOICEDESIGN_MODEL,` add:

```python
                        **({"mintMethod": mint_method} if mint_method else {}),
                        **({"fallbackFor": fallback_for} if fallback_for else {}),
```

- [ ] **Step 4: Thread through the route**

In `qwen_design_voice` (`/qwen/design-voice` ~3989), read the two optional fields and pass them to `design_voice`:

```python
    mint_method = body.get("mintMethod") if isinstance(body.get("mintMethod"), str) else None
    fallback_for = body.get("fallbackFor") if isinstance(body.get("fallbackFor"), dict) else None
```

And in the `asyncio.to_thread(qwen.design_voice, ...)` call (~4015) append `mint_method, fallback_for` as the trailing args (matching positional order) or pass as kwargs.

- [ ] **Step 5: Run to verify pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_qwen3.py -k provenance -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(sidecar): stamp design-voice fallback provenance into voice manifest"
```

---

## Task 4: Server — forward `qwenBase17WeightsPresent` from `/health`

**Files:**
- Modify: `server/src/routes/sidecar-health.ts` (`SidecarHealthBody` ~65, `SidecarHealthResult` ~202, the mapping ~274)
- Test: `server/src/routes/sidecar-health.test.ts` (if present; else add a focused test)

**Interfaces:**
- Produces: `SidecarHealthResult.qwenBase17WeightsPresent?: boolean` (default `false`).

- [ ] **Step 1: Write the failing test**

In `server/src/routes/sidecar-health.test.ts`, mirror an existing `probeSidecarHealth` test that stubs `fetch`:

```ts
it('forwards qwen_base17_weights_present', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true, qwen_base17_weights_present: true }), { status: 200 }),
  );
  const r = await probeSidecarHealth();
  expect(r.qwenBase17WeightsPresent).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts -t base17_weights`
Expected: FAIL (`qwenBase17WeightsPresent` is `undefined`)

- [ ] **Step 3: Add the field**

`SidecarHealthBody` (~65, near `qwen_base17_loaded`): add `qwen_base17_weights_present?: boolean;`
`SidecarHealthResult` (~203, near `qwenBase17Loaded`): add `qwenBase17WeightsPresent?: boolean;`
In the reachable-response mapping (~274, near `qwenBase17Loaded: body.qwen_base17_loaded === true,`):

```ts
      qwenBase17WeightsPresent: body.qwen_base17_weights_present === true,
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): forward qwenBase17WeightsPresent from sidecar /health"
```

---

## Task 5: Server — `SidecarDesignError` + extract `postDesignAndCache`

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (the inline POST/cache block in `designQwenVoiceForCharacter` ~347-440)
- Test: `server/src/routes/qwen-voice.test.ts`

**Interfaces:**
- Produces: `class SidecarDesignError extends Error { status: number; code?: string; reason?: string }`; inner `postDesignAndCache(target: string, body: string, p, baseVoiceId, voiceId): Promise<{voiceId:string; url:string}>` (closure over `p`, the gpu/lock scope already held by the caller). On non-OK it throws `SidecarDesignError` with `.status` and the parsed `.code`/`.reason`.

This task is a **pure refactor + new error type** — existing behaviour (anchored mint, base design) must stay green.

- [ ] **Step 1: Write the failing test**

In `server/src/routes/qwen-voice.test.ts`:

```ts
it('throws SidecarDesignError carrying status/code/reason on a 503', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }),
  );
  await expect(
    designQwenVoiceForCharacter(makeVariantParams()),  // helper builds a valid variant param set
  ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 503, code: 'base17-unavailable' });
});
```

> `makeVariantParams()` builds a `DesignQwenVoiceParams` with `emotion` set, a stub `bookDir`, `character`, `persona: 'a warm narrator'`. Stub `getResolvedSidecarUrl`, `withDesignLock`, `gpuSemaphore`, `encodePcmToAudio`, fs writes as the existing tests in this file already do — reuse their setup helpers.

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t SidecarDesignError`
Expected: FAIL (currently throws a plain `Error`, no `.status`/`.code`)

- [ ] **Step 3: Add the error class**

Top of `server/src/routes/qwen-voice.ts` (after imports):

```ts
export class SidecarDesignError extends Error {
  status: number;
  code?: string;
  reason?: string;
  constructor(message: string, status: number, code?: string, reason?: string) {
    super(message);
    this.name = 'SidecarDesignError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}
```

- [ ] **Step 4: Extract `postDesignAndCache`**

Inside `designQwenVoiceForCharacter`, after `gpuSemaphore.acquire(...)` and `getResolvedSidecarUrl()` are obtained, move the per-call fetch+cache logic into a local helper. It owns its OWN `AbortController`, `startedAt`, liveness `setInterval`, and `p.signal` listener, and clears them in its own `finally`. The single `releaseGpu()` stays in the OUTER `finally`.

```ts
const postDesignAndCache = async (
  target: string,
  fetchBody: string,
  outVoiceId: string,
): Promise<{ voiceId: string; url: string }> => {
  const controller = new AbortController();
  const startedAt = Date.now();
  let abortReason: 'unreachable' | 'absolute' | null = null;
  const livenessTimer = setInterval(() => {
    void (async () => {
      const { probeSidecarHealth } = await import('./sidecar-health.js');
      const health = (await probeSidecarHealth()).status;
      const decision = evaluateDesignLiveness({ startedAt, now: Date.now(), health, absoluteMaxMs: DESIGN_ABSOLUTE_MAX_MS });
      if (decision.action === 'abort') { abortReason = decision.reason; controller.abort(); }
    })();
  }, DESIGN_LIVENESS_INTERVAL_MS);
  const onExternalAbort = () => controller.abort();
  if (p.signal) {
    if (p.signal.aborted) controller.abort();
    else p.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(target, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: fetchBody,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        if (p.signal?.aborted) throw new SidecarDesignError('Voice design was cancelled.', 0);
        if (abortReason === 'unreachable')
          throw new SidecarDesignError(`TTS sidecar (${sidecarUrl}) stopped responding to /health during voice design.`, 0);
        throw new SidecarDesignError(`Sidecar ${target} did not complete within ${DESIGN_ABSOLUTE_MAX_MS}ms.`, 0);
      }
      throw new SidecarDesignError(`TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`, 0);
    }
    if (!upstream.ok) {
      let detail = '', code: string | undefined, reason: string | undefined;
      try {
        const b = (await upstream.json()) as { detail?: string; error?: string; code?: string; reason?: string };
        detail = b.detail ?? b.error ?? ''; code = b.code; reason = b.reason;
      } catch { /* not json */ }
      throw new SidecarDesignError(
        detail || `Sidecar ${target} returned ${upstream.status} ${upstream.statusText}.`,
        upstream.status, code, reason,
      );
    }
    const sampleRate = Number(upstream.headers.get('X-Sample-Rate') ?? '24000') || 24000;
    const pcm = Buffer.from(await upstream.arrayBuffer());
    const fileName = voiceSampleFileName({ cacheScope: p.sampleVoiceId, modelKey: p.modelKey, text: calibrationText, voiceName: outVoiceId });
    const filePath = voiceSampleFilePath(fileName);
    const url = voiceSamplePublicUrl(fileName);
    try {
      await mkdir(voiceSampleAudioDir(), { recursive: true });
      const mp3 = await encodePcmToAudio(pcm, sampleRate);
      await writeFile(filePath, mp3);
    } catch (encErr) {
      throw new Error(`Designed the voice but failed to cache its preview: ${(encErr as Error).message}`);
    }
    // fs-45 v1: record the design peak (Base + VoiceDesign resident here).
    const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
    await maybeSampleSidecarEngine('qwen:design');
    return { voiceId: outVoiceId, url };
  } finally {
    clearInterval(livenessTimer);
    if (p.signal) p.signal.removeEventListener('abort', onExternalAbort);
  }
};
```

> **H3 (do not drop behavior):** the extracted helper MUST keep (a) the
> cache-error `try/catch` that rethrows `"Designed the voice but failed to cache
> its preview: …"` and (b) the `maybeSampleSidecarEngine('qwen:design')`
> telemetry call — both exist in the current inline block (`qwen-voice.ts:418-433`)
> and an existing test asserts on `maybeSampleSidecarEngineMock`. The single
> `releaseGpu()` stays in the OUTER `finally`, never in this helper.

Then the existing body becomes (for now, behaviour-preserving):

```ts
const target = p.emotion ? `${sidecarUrl}/qwen/mint-variant` : `${sidecarUrl}/qwen/design-voice`;
const fetchBody = p.emotion
  ? JSON.stringify({ baseVoiceId, variantVoiceId: voiceId, emotionInstruct: EMOTION_INSTRUCT[p.emotion], voiceUuid: p.character.voiceUuid ?? null, language: p.language, calibrationText })
  : JSON.stringify({ voiceId, voiceUuid: p.character.voiceUuid ?? null, instruct: p.persona, language: p.language, calibrationText });
return await postDesignAndCache(target, fetchBody, voiceId);
```

Keep the outer `try/finally` that calls `releaseGpu()` exactly once.

- [ ] **Step 5: Run the full file to verify no regression + new test passes**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (existing anchored/base tests stay green; the new SidecarDesignError test passes)

- [ ] **Step 6: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "refactor(server): extract postDesignAndCache + typed SidecarDesignError"
```

---

## Task 6: Server — fallback control flow + persona resolution + return shape

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter` return type ~301; control flow)
- Test: `server/src/routes/qwen-voice.test.ts`

**Interfaces:**
- Consumes: `postDesignAndCache`, `SidecarDesignError` (Task 5); `qwenVoiceSidecarPath`, `qwenStorageKey`, `readJson` (already imported in module).
- Produces: `designQwenVoiceForCharacter` resolves `{ voiceId: string; url: string; fellBackToDesignVoice?: boolean; fallbackReason?: 'not-installed' | 'corrupt' }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('falls back to design-voice on 503 not-installed (no retry)', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }))
    .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
  const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: 'a warm narrator' }));
  expect(r.fellBackToDesignVoice).toBe(true);
  expect(r.fallbackReason).toBe('not-installed');
  // exactly two fetches: mint (503) + design-voice (200) — NO retry
  const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
  expect(calls.filter((u) => u.includes('/qwen/mint-variant'))).toHaveLength(1);
  const dvCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/qwen/design-voice'))!;
  const sentBody = JSON.parse(String((dvCall[1] as RequestInit).body));
  // EMOTION_INSTRUCT is module-private; assert structurally instead of pasting
  // the (long, real) angry clause. The composed instruct is `${persona} ${clause}`.
  expect(sentBody.instruct.startsWith('a warm narrator ')).toBe(true);
  expect(sentBody.instruct.length).toBeGreaterThan('a warm narrator '.length);
  expect(sentBody.voiceId).toMatch(/__angry$/);
  expect(sentBody.mintMethod).toBe('design-voice-fallback');
});

it('falls back on 503 corrupt', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'corrupt', detail: 'x' }), { status: 503 }))
    .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
  const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: 'a warm narrator' }));
  expect(r.fallbackReason).toBe('corrupt');
});

it('does NOT fall back on a generic 500 (OOM)', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Internal error.' }), { status: 500 }));
  await expect(designQwenVoiceForCharacter(makeVariantParams({ persona: 'p' }))).rejects.toThrow();
  expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/qwen/design-voice'))).toBe(false);
});

it('declines the fallback when no persona is recoverable', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }));
  // readJson stubbed to return no instruct (see setup)
  await expect(designQwenVoiceForCharacter(makeVariantParams({ persona: '' }))).rejects.toThrow(/no persona on disk/i);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t "falls back"`
Expected: FAIL (no fallback logic yet — the 503 propagates)

- [ ] **Step 3: Widen the return type**

```ts
export async function designQwenVoiceForCharacter(
  p: DesignQwenVoiceParams,
): Promise<{ voiceId: string; url: string; fellBackToDesignVoice?: boolean; fallbackReason?: 'not-installed' | 'corrupt' }> {
```

- [ ] **Step 4: Implement the control flow**

Replace the variant return in the inner scope (Task 5's `return await postDesignAndCache(...)`) with:

```ts
if (!p.emotion) {
  return await postDesignAndCache(`${sidecarUrl}/qwen/design-voice`, JSON.stringify({
    voiceId, voiceUuid: p.character.voiceUuid ?? null, instruct: p.persona, language: p.language, calibrationText,
  }), voiceId);
}

// Variant: try the anchored mint, fall back on a deterministic 1.7B-Base failure.
const mintBody = JSON.stringify({
  baseVoiceId, variantVoiceId: voiceId, emotionInstruct: EMOTION_INSTRUCT[p.emotion],
  voiceUuid: p.character.voiceUuid ?? null, language: p.language, calibrationText,
});
try {
  return await postDesignAndCache(`${sidecarUrl}/qwen/mint-variant`, mintBody, voiceId);
} catch (e) {
  const err = e as SidecarDesignError;
  const isFallback = err?.name === 'SidecarDesignError' && err.status === 503 && err.code === 'base17-unavailable'
    && (err.reason === 'not-installed' || err.reason === 'corrupt');
  if (!isFallback) throw e;  // OOM/500, cancel, unreachable, 409 → propagate

  // Resolve a persona: p.persona → base voice's sidecar .json instruct → decline.
  let persona = (p.persona ?? '').trim();
  if (!persona) {
    const baseVoiceName = p.character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(p.character, p.characterId);
    const sidecarJson = await readJson<{ instruct?: string }>(qwenVoiceSidecarPath(baseVoiceName)).catch(() => null);
    persona = (typeof sidecarJson?.instruct === 'string' ? sidecarJson.instruct : '').trim();
  }
  if (!persona) {
    throw new Error('1.7B-Base unavailable and no persona on disk to fall back with — design the base voice’s persona first.');
  }

  const reason = err.reason as 'not-installed' | 'corrupt';
  console.warn(
    `[qwen-voice] 1.7B-Base unavailable (reason=${reason}) — minted ${p.emotion} variant for ${p.characterId} via design-voice fallback (lower fidelity).`,
  );
  const fallbackBody = JSON.stringify({
    voiceId, voiceUuid: p.character.voiceUuid ?? null,
    instruct: `${persona} ${EMOTION_INSTRUCT[p.emotion]}`,
    language: p.language, calibrationText,
    mintMethod: 'design-voice-fallback',
    fallbackFor: { baseVoiceId, emotion: p.emotion },
  });
  const out = await postDesignAndCache(`${sidecarUrl}/qwen/design-voice`, fallbackBody, voiceId);
  return { ...out, fellBackToDesignVoice: true, fallbackReason: reason };
}
```

> Confirm `qwenVoiceSidecarPath`, `qwenStorageKey`, `readJson` are imported at the top of `qwen-voice.ts` (they are — used by the `designed-persona` route). Add to the import if tree-shaken.

- [ ] **Step 5: Run to verify pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (all fallback tests + the existing anchored/base/no-regression tests)

- [ ] **Step 6: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): fall back variant mint to design-voice when 1.7B-Base unavailable"
```

---

## Task 7: Server — surface `viaFallback` on the bulk `variant_designed` event

**Files:**
- Modify: `server/src/routes/cast-design.ts` (destructure ~356; `variant_designed` broadcast ~380)
- Test: `server/src/routes/cast-design.test.ts`

**Interfaces:**
- Consumes: `designQwenVoiceForCharacter` return `{ fellBackToDesignVoice, fallbackReason }` (Task 6).
- Produces: SSE event `{ type:'variant_designed', characterId, emotion, voiceId, viaFallback?: boolean, fallbackReason?: string }`.

- [ ] **Step 1: Write the failing test**

In `server/src/routes/cast-design.test.ts`, mirror an existing test that drives a bulk variant run and captures broadcasts. Stub `designQwenVoiceForCharacter` to return `{ voiceId, url, fellBackToDesignVoice: true, fallbackReason: 'not-installed' }`:

```ts
it('marks variant_designed viaFallback when the mint fell back', async () => {
  vi.mocked(designQwenVoiceForCharacter).mockResolvedValue({ voiceId: 'qwen-x__angry', url: '/u', fellBackToDesignVoice: true, fallbackReason: 'not-installed' });
  const events = await runBulkVariantJobAndCollect(/* existing helper */);
  const ev = events.find((e) => e.type === 'variant_designed');
  expect(ev).toMatchObject({ viaFallback: true, fallbackReason: 'not-installed' });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts -t viaFallback`
Expected: FAIL (`viaFallback` undefined)

- [ ] **Step 3: Thread the field through**

At the variant destructure (~356) capture the new fields:

```ts
const { voiceId, fellBackToDesignVoice, fallbackReason } = await designQwenVoiceForCharacter({ ... });
```

At the `variant_designed` broadcast (~380):

```ts
broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
  ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
```

Update the broadcast event union type if one is declared in the file.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): flag variant_designed viaFallback in bulk design stream"
```

---

## Task 8: Frontend — widen `onVariantDesigned` payload

**Files:**
- Modify: `src/lib/api.ts` (callback type ~4578; real parse ~4729-4740; mock ~4964)
- Test: `src/lib/api.test.ts` (if a stream-parse test exists; else add one)

**Interfaces:**
- Produces: `onVariantDesigned?: (e: { characterId; emotion; voiceId; viaFallback?: boolean; fallbackReason?: 'not-installed' | 'corrupt' }) => void`.

- [ ] **Step 1: Write the failing test**

If `src/lib/api.test.ts` has an SSE-parsing test, add a case feeding a `variant_designed` event with `viaFallback: true` and asserting the callback receives it. Otherwise add a minimal parse test mirroring the existing stream-handler tests.

```ts
it('passes viaFallback through onVariantDesigned', async () => {
  const got: any[] = [];
  await drveStream('event: variant_designed\ndata: {"characterId":"c","emotion":"angry","voiceId":"v","viaFallback":true,"fallbackReason":"corrupt"}\n\n',
    { onVariantDesigned: (e) => got.push(e) });
  expect(got[0]).toMatchObject({ viaFallback: true, fallbackReason: 'corrupt' });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/lib/api.test.ts -t viaFallback`
Expected: FAIL

- [ ] **Step 3a: Extend the event interface (C3)**

The SSE parse is typed `e: CastDesignStreamEvent` (`src/lib/api.ts:4664`), a flat
interface at `:4615-4636` — it has NO `viaFallback`/`fallbackReason`, so reading
them is a TS error unless you add them. In `interface CastDesignStreamEvent`,
after `url?: string;` (~4635), add:

```ts
  viaFallback?: boolean;
  fallbackReason?: 'not-installed' | 'corrupt';
```

- [ ] **Step 3b: Widen the callback type**

Callback type (~4578):

```ts
  onVariantDesigned?: (e: { characterId: string; emotion: Emotion; voiceId: string; viaFallback?: boolean; fallbackReason?: 'not-installed' | 'corrupt' }) => void;
```

- [ ] **Step 3c: Pass the fields through the parse**

The parsed event variable is **`e`** (not `ev`). In the `case 'variant_designed':`
block (`:4729-4740`), inside the existing `cb.onVariantDesigned?.({ … })`:

```ts
          cb.onVariantDesigned?.({
            characterId: e.characterId,
            emotion: e.emotion as Emotion,
            voiceId: e.voiceId,
            ...(e.viaFallback ? { viaFallback: true, fallbackReason: e.fallbackReason } : {}),
          });
```

(The mock at ~4964 needs no change unless you want it to emit fallbacks for tests.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): carry viaFallback through the variant_designed stream callback"
```

---

## Task 9: Frontend — `fallbacks[]` snapshot state + reducer + middleware dispatch

> **Round-1 correction (C1/H4):** the slice state is `{ active: CastDesignSnapshot | null }`
> (`cast-design-slice.ts:82-88`) — there is **no `byBook` map** and **no `open`
> action**. Reducers guard with `if (!snap || snap.bookId !== payload.bookId) return;`
> (see `charFailed` `:177-195`); the openers are `begin` (`:113`) and `beginSingle`
> (`:234`). `failures: []` is initialized at exactly two sites (`:133` in `begin`,
> `:256` in `beginSingle`). The fallback record carries **no `name`** (the bulk
> `variant_designed` event has none and there is no `selectCharacterName` selector
> — H4); `{characterId, emotion}` is enough for the count-based summary (Task 10).

**Files:**
- Modify: `src/store/cast-design-slice.ts` (`CastDesignFallback` type ~31; `CastDesignSnapshot.fallbacks` ~77; init at `:133` and `:256`; `variantFellBack` reducer after `charFailed` ~195)
- Modify: `src/store/cast-design-stream-middleware.ts` (`onVariantDesigned` `:85-88`)
- Test: `src/store/cast-design-slice.test.ts`, `src/store/cast-design-stream-middleware.test.ts`

**Interfaces:**
- Consumes: `onVariantDesigned` payload (Task 8).
- Produces: `castDesignActions.variantFellBack({ bookId, characterId, emotion, lastTickAt })`; `CastDesignSnapshot.fallbacks: CastDesignFallback[]` where `CastDesignFallback = { characterId: string; emotion: string }`.

- [ ] **Step 1: Write the failing slice test**

In `src/store/cast-design-slice.test.ts` (use `begin`, and `state.active` — match the existing tests in the file):

```ts
it('records a fallback variant in the active snapshot', () => {
  let s = reducer(undefined, castDesignActions.begin({ bookId: 'b', total: 1, currentName: 'Mara', lastTickAt: 1 }));
  s = reducer(s, castDesignActions.variantFellBack({ bookId: 'b', characterId: 'c', emotion: 'angry', lastTickAt: 2 }));
  expect(s.active?.fallbacks).toEqual([{ characterId: 'c', emotion: 'angry' }]);
});

it('ignores a fallback for a different book', () => {
  let s = reducer(undefined, castDesignActions.begin({ bookId: 'b', total: 1, currentName: null, lastTickAt: 1 }));
  s = reducer(s, castDesignActions.variantFellBack({ bookId: 'OTHER', characterId: 'c', emotion: 'angry', lastTickAt: 2 }));
  expect(s.active?.fallbacks).toEqual([]);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/store/cast-design-slice.test.ts -t fallback`
Expected: FAIL (`variantFellBack` is not a function)

- [ ] **Step 3: Add the type + state field + init + reducer**

Add the type near `CastDesignFailure` (~31):

```ts
export interface CastDesignFallback {
  characterId: string;
  emotion: string;
}
```

Add to `CastDesignSnapshot` after `failures: CastDesignFailure[];` (~77):

```ts
  /** Emotion variants minted via the design-voice fallback (1.7B-Base
      unavailable) — lower fidelity. Count surfaced in the completion summary. */
  fallbacks: CastDesignFallback[];
```

Add `fallbacks: [],` immediately after `failures: [],` at BOTH init sites — `begin` (`:133`) and `beginSingle` (`:256`).

Add the reducer immediately after `charFailed` (~195), mirroring its cross-book guard:

```ts
    /* A variant was minted via the design-voice fallback (1.7B-Base
       unavailable). Recorded for the completion summary; does NOT bump `done`
       (charDone already counts the success). */
    variantFellBack(
      state,
      action: PayloadAction<{ bookId: string; characterId: string; emotion: string; lastTickAt: number }>,
    ) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.fallbacks.push({ characterId: action.payload.characterId, emotion: action.payload.emotion });
      snap.lastTickAt = action.payload.lastTickAt;
    },
```

- [ ] **Step 4: Run the slice test to verify pass**

Run: `npx vitest run src/store/cast-design-slice.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing middleware test**

In `src/store/cast-design-stream-middleware.test.ts`, mirror the existing `onVariantDesigned` test: invoke the built callback with `{ characterId:'c', emotion:'angry', voiceId:'v', viaFallback:true }` and assert a `castDesign/variantFellBack` action was dispatched (capture dispatched actions as the existing tests do).

- [ ] **Step 6: Dispatch from the middleware**

In `cast-design-stream-middleware.ts`, replace the `onVariantDesigned` handler (`:85-88`):

```ts
      onVariantDesigned: ({ characterId, emotion, voiceId, viaFallback }) => {
        dispatch(castActions.setCharacterEmotionVariant({ characterId, emotion, voiceId }));
        if (viaFallback) {
          dispatch(castDesignActions.variantFellBack({ bookId, characterId, emotion, lastTickAt: Date.now() }));
        }
        dispatch(castDesignActions.charDone({ bookId, lastTickAt: Date.now() }));
      },
```

(No name lookup — the record is `{characterId, emotion}`; `bookId` is already in closure scope from `buildCallbacks(bookId, …)`.)

- [ ] **Step 7: Run both store tests to verify pass**

Run: `npx vitest run src/store/cast-design-slice.test.ts src/store/cast-design-stream-middleware.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add src/store/cast-design-slice.ts src/store/cast-design-slice.test.ts src/store/cast-design-stream-middleware.ts src/store/cast-design-stream-middleware.test.ts
git commit -m "feat(frontend): record design-voice fallback variants in the design snapshot"
```

---

## Task 10: Frontend — surface the fallback count in the completion summary toast

> **Round-1 correction (C2):** there is **no failures-list component** —
> `grep "\.failures"` over `src/components`/`src/views` returns nothing. The
> design summary is the completion **toast** built in
> `cast-design-stream-middleware.ts`'s `onIdle` (`:101-115`):
> `"Designed 6 · 1 failed · 2 skipped."`. The fallback note belongs there, as a
> `· N via fallback` part. The count comes from the slice state the middleware
> accumulated during the run (`store.getState().castDesign.active?.fallbacks`),
> read at idle — `settle` is dispatched first but the snapshot is still present
> (it's cleared later, after `SUMMARY_LINGER_MS`).

**Files:**
- Modify: `src/store/cast-design-stream-middleware.ts` (`onIdle` toast builder, `:101-115`)
- Test: `src/store/cast-design-stream-middleware.test.ts`

**Interfaces:**
- Consumes: `CastDesignSnapshot.fallbacks` (Task 9).

- [ ] **Step 1: Write the failing test**

In `src/store/cast-design-stream-middleware.test.ts`, drive a run that records ≥1 fallback (dispatch `variantFellBack` via the `onVariantDesigned` path, or seed the store), then invoke `onIdle({ done: 1, total: 1, skipped: 0, failures: [] })` and assert the pushed toast message contains the fallback part:

```ts
it('includes a fallback count in the completion toast', () => {
  // arrange: store has an active bulk snapshot with one fallback recorded
  // (begin → variantFellBack), then call the onIdle callback.
  const toasts = captureToasts(); // existing helper / spy on notificationsActions.pushToast
  cb.onIdle({ done: 1, total: 1, skipped: 0, failures: [] });
  expect(toasts.at(-1)?.message).toMatch(/1 via fallback/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/store/cast-design-stream-middleware.test.ts -t fallback`
Expected: FAIL (toast has no "via fallback" part)

- [ ] **Step 3: Add the toast part**

In `onIdle` (`:101-115`), after the `skipped` part is pushed and before the toast dispatch, read the accumulated count and add a part:

```ts
      onIdle: ({ done, total, skipped, failures }) => {
        const fellBack = (store.getState() as CastDesignRootState).castDesign.active?.fallbacks.length ?? 0;
        dispatch(castDesignActions.settle({ bookId, lastTickAt: Date.now() }));
        if (total > 0) {
          const failed = failures.length;
          const parts = [`Designed ${done}`];
          if (fellBack > 0) parts.push(`${fellBack} via fallback (lower fidelity)`);
          if (failed > 0) parts.push(`${failed} failed`);
          if (skipped > 0) parts.push(`${skipped} skipped`);
          dispatch(
            notificationsActions.pushToast({
              kind: failed > 0 ? 'error' : 'info',
              message: `${parts.join(' · ')}.`,
              dedupeKey: `cast-design-done:${bookId}`,
            }),
          );
        }
        /* …existing clear-after-linger block unchanged… */
      },
```

> Read `fellBack` BEFORE `settle` (settle doesn't touch `fallbacks`, but reading first is robust against future changes). `CastDesignRootState` is already imported/defined in this file (`:39-41`); extend its inline type if needed so `.active.fallbacks` typechecks — or cast as the file already does for `currentNameFor`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/store/cast-design-stream-middleware.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add src/store/cast-design-stream-middleware.ts src/store/cast-design-stream-middleware.test.ts
git commit -m "feat(frontend): show design-voice fallback count in the completion summary"
```

---

## Task 11: Full verify + plan/docs housekeeping

**Files:**
- Modify: `docs/features/INDEX.md` (if a plan/feature entry belongs there), `docs/BACKLOG.md` (srv-52 row), the spec's `status:` + Ship notes.

- [ ] **Step 1: Update the spec status + ship notes**

In `docs/superpowers/specs/2026-06-24-srv-52-mint-variant-design-voice-fallback-design.md`, fill the **Ship notes** section with the date + merge SHA once merged; leave `status: active` until shipped.

- [ ] **Step 2: Update the backlog**

Remove the srv-52 row from `docs/BACKLOG.md` per the "When you ship a backlog item" rule, and confirm `#1091` is referenced by the PR (`Closes #1091`).

- [ ] **Step 3: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. (Sidecar pytest runs via `test:sidecar` — ensure the venv is bootstrapped, else it SKIPs and you must run it directly per Tasks 1-3.)

- [ ] **Step 4: Commit any doc updates**

```bash
cd C:/Claude/Projects/Audiobook-Generator-wt-srv52
git add docs/
git commit -m "docs(docs): advance srv-52 spec + backlog on ship"
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "feat(server,sidecar,frontend): srv-52 mint-variant design-voice fallback" --body "<summary + test plan + Closes #1091>"
```

---

## Self-Review

**Spec coverage:**
- Sidecar `_qwen_base17_weights_present` + `/health` → Task 1. ✓
- `Base17UnavailableError` + `_ensure_base17_for_mint` (classify not-installed/corrupt/OOM) + narrow catch (H3) + ordering (H4) + route 503 (M-A) → Task 2. ✓
- design-voice provenance fields (mintMethod/fallbackFor) → Task 3. ✓
- Server health forwarding → Task 4. ✓
- `SidecarDesignError` + `postDesignAndCache` per-call abort/liveness + cleanup-ownership (H5/M6) → Task 5. ✓
- Fallback control flow, no-retry, OOM-no-fallback, persona resolution + decline (C1), return shape → Task 6. ✓
- Bulk `variant_designed` viaFallback → Task 7. ✓
- Frontend payload → Task 8; snapshot `fallbacks[]` + reducer + middleware (H-A) → Task 9; render note (H-A) → Task 10. ✓
- OOM-as-recoverable (not poison) is encoded by Task 2 re-raising the OOM unchanged (route → 500), nothing routes it to poison. ✓
- remint upgrade path needs no code (existing `remint-anchored-variants.mjs` selects `mintMethod !== 'anchored-icl-instruct'`) — no task, by design. ✓

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". Two intentional `grep`-to-locate steps (Task 10 render site, Task 9 name-lookup) carry the exact command + fallback behaviour, not a vague instruction.

**Type consistency:** `Base17UnavailableError.reason`, `SidecarDesignError.{status,code,reason}`, the `{ fellBackToDesignVoice, fallbackReason }` return, the `variant_designed.viaFallback` event, `onVariantDesigned` payload, `variantFellBack` action payload, and `CastDesignSnapshot.fallbacks: CastDesignFallback[]` are consistent across Tasks 2/5/6/7/8/9/10. `mintMethod: 'design-voice-fallback'` string is identical in the server fallback body (Task 6) and the sidecar manifest write (Task 3).
