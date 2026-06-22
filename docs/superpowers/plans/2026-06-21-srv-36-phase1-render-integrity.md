# srv-36 Phase 1 — Render-Integrity Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an acoustic render-integrity QA gate that embeds each stochastic-engine render with ECAPA, scores it against the character's own voice centroid, surfaces voice-mismatch issues, and (behind a flag) auto-regenerates severe misfires — calibrated on real on-box audio.

**Architecture:** A new CPU-only `SpeakerEngine` + `POST /embed` in the Python sidecar (mirrors the existing `WhisperEngine`/`/transcribe` *special* path — NOT the synth `ENGINES` map). The Node server embeds each rendered group inline (piggybacking the ASR-QA pass, PCM already in memory), stores 192-float vectors in a `<slug>.embeddings.json` sibling, then a post-pass aggregator builds per-character centroids (hybrid: in-book clean renders, audition-sample fallback), scores 3-tier per-character, and writes a tiny `<slug>.render-integrity.json` verdict sibling the book outline derives from. Auto-fix adds an acoustic candidate source + accept-check inside the existing `chapter-qa-repair.ts` route.

**Tech Stack:** Python 3.12 + FastAPI + SpeechBrain ECAPA-TDNN (sidecar); Node 20 + TypeScript + Vitest (server); the spike's pure helpers `embed.py`/`metrics.py` as the math base.

**Source spec:** `docs/superpowers/specs/2026-06-21-srv-36-phase1-render-integrity-design.md` (read §1.1 "Reuse reality" before starting — six "mirror/reuse" claims were corrected against real code).

## Global Constraints

- **Stochastic engines only** — Qwen + Coqui. Kokoro (deterministic) is skipped at the embed step; it cannot drift.
- **CPU-only in v1** — `SPK_DEVICE=cpu`, zero VRAM, no semaphore, no watchdog. The cuda path is Phase 2 (do NOT wire `gpu.weight.spk` / VRAM cost).
- **Advisory only** — verdicts never gate `done`; auto-fix is opt-in via a default-off flag.
- **`speechbrain` + an explicit `huggingface_hub` pin** go in a NEW shared `requirements/speaker-qa.txt` fragment `-r`-included by `cpu.txt`/`nvidia-cuda.txt`/`amd-rocm.txt` — **never** `base.txt` (the torch-free layer). Torch already exists (`cpu.txt:16`, `nvidia-cuda.txt:22`).
- **Verdict naming** must avoid the `AsrVerdict` `'drift'` literal (`segment-asr-qa.ts:31`). Use `'voice-match' | 'voice-mismatch' | 'inconclusive'`.
- **Two stores, split:** 192-float vectors → `<slug>.embeddings.json`; tiny verdict (enum+cosine+join) → `<slug>.render-integrity.json`. The book-outline derive reads ONLY the verdict files.
- **Settings group** = `qa-gates`; `apply` modes from `config/types.ts:6` (`live` | `restart-sidecar`).
- **TDD, frequent commits, DRY, YAGNI.** Commit message convention: `<type>(<scope>): <subject>` (validated by husky). Scopes used here: `sidecar`, `server`, `docs`.
- **Tests SKIP cleanly** when the venv/weights are absent (the sidecar runs on boxes without ECAPA weights).

## Pre-flight (execution setup, not a task)

This plan is implemented on a **feature branch**, not the docs branch the spec lives on. At execution time:

```bash
# from a fresh worktree off origin/main (the docs branch already holds the spec):
git switch -c feat/sidecar-srv-36-phase1 origin/main
git restore --source docs/docs-srv-36-phase1-spec -- docs/superpowers/specs/2026-06-21-srv-36-phase1-render-integrity-design.md docs/superpowers/plans/2026-06-21-srv-36-phase1-render-integrity.md
git add docs/ && git commit -m "docs(docs): srv-36 phase-1 spec + plan onto the feature branch"
```

## File Structure

**Sidecar (Python):**
- Modify `server/tts-sidecar/main.py` — add `SpeakerEngine` class + `SPK` singleton + `POST /embed` + `/health` `spk_*` fields.
- Create `server/tts-sidecar/requirements/speaker-qa.txt` — `speechbrain` + `huggingface_hub` pins.
- Modify `server/tts-sidecar/requirements/{cpu,nvidia-cuda,amd-rocm}.txt` — `-r speaker-qa.txt`.
- Create `server/tts-sidecar/tests/test_speaker_embed.py`.

**Server (Node) — new files:**
- `server/src/tts/embed-client.ts` — `/embed` HTTP client (raw-body transport).
- `server/src/audio/render-integrity/constants.ts` — `EMBEDDINGS_VERSION`, `MIN_DURATION_SEC` (shared).
- `server/src/audio/render-integrity/embeddings-io.ts` — `<slug>.embeddings.json` read/write (vectors).
- `server/src/audio/render-integrity/verdicts-io.ts` — `<slug>.render-integrity.json` read/write + book-derive (verdicts).
- `server/src/audio/render-integrity/centroids-io.ts` — `<book>.centroids.json` read/write (per-character centroid + spread; read by the repair route).
- `server/src/audio/render-integrity/centroid.ts` — hybrid centroid builder (pure).
- `server/src/audio/render-integrity/score.ts` — 3-tier per-character scoring (pure) + named cutoff constants + `cosineToCentroid`.
- `server/src/audio/render-integrity/aggregate.ts` — post-pass orchestrator (build+persist centroids → score → write verdicts).

**Server (Node) — modified files:**
- `server/src/config/registry.ts` — three `qa.speaker.*` settings.
- `server/src/tts/synthesise-chapter.ts` — inline `spk` embed pass (clone of the `asr` pass); `embeddings` on `ChapterSynthesisResult`.
- `server/src/audio/finalize-chapter-write.ts` — optional `embeddings` input → write the embeddings sibling after the segments write.
- `server/src/routes/generation.ts` — pass `result.embeddings` to finalize (`:1387`, inside `processOneChapter`); invoke the score pass at the per-chapter-done hook (`:1401-1428`). **Note the path: `routes/generation.ts`, not `src/generation.ts`.**
- `server/src/audio/segments-io.ts` — extend the per-segment read-view type (`:50`) to surface `renderedFallbackEngine` (today it's typed away); the aggregator needs it per-segment.
- `server/src/routes/chapter-qa-repair.ts` — thread the optional finalize `embeddings` param (`:345`); acoustic candidate source + accept-check (~6 edits per spec §5).

**Calibration (on-box harness):**
- `server/tts-sidecar/spikes/srv36/calibrate.py` — productionized cutoff-fitting over a real book (reuses spike helpers).
- `server/tts-sidecar/spikes/srv36/listen_set.py` — emits the held-out listen-set for the operator.

---

## Phase 1 — Sidecar: SpeakerEngine + /embed

### Task 1: Dependency fragment + SpeakerEngine class

**Files:**
- Create: `server/tts-sidecar/requirements/speaker-qa.txt`
- Modify: `server/tts-sidecar/requirements/cpu.txt`, `nvidia-cuda.txt`, `amd-rocm.txt` (add one `-r` line each)
- Modify: `server/tts-sidecar/main.py` (add `SpeakerEngine` + `SPK` singleton near the `ASR = WhisperEngine()` line, ~`:1931`)
- Test: `server/tts-sidecar/tests/test_speaker_embed.py`

**Interfaces:**
- Produces: `SpeakerEngine.embed(pcm: bytes, sample_rate: int) -> list[float]` (192-dim, L2-normalized); module singleton `SPK`.

- [ ] **Step 1: Write the dependency fragment**

Create `server/tts-sidecar/requirements/speaker-qa.txt`:

```
# srv-36 render-integrity (ECAPA speaker embedding). CPU-only in v1.
# Placed here (NOT base.txt) because speechbrain needs torch, which lives in the
# vendor overlays. huggingface_hub is pinned EXPLICITLY because it is otherwise
# unpinned and speechbrain co-constrains it with transformers>=4.45,<5.0.
speechbrain==1.0.2
huggingface_hub>=0.23,<0.26
```

- [ ] **Step 2: Wire the fragment into each vendor overlay**

Append `-r speaker-qa.txt` to each of `cpu.txt`, `nvidia-cuda.txt`, `amd-rocm.txt` (a single line at the end of each).

- [ ] **Step 3: Write the failing test**

Create `server/tts-sidecar/tests/test_speaker_embed.py`:

```python
import numpy as np
import pytest

speechbrain = pytest.importorskip("speechbrain")  # weights-bound → SKIP if absent


def _sine_pcm(freq, sr=16000, secs=2.0):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * 8000).astype("<i2").tobytes()


def test_embed_is_unit_norm_and_192d():
    from main import SPK
    emb = SPK.embed(_sine_pcm(180), 16000)
    assert len(emb) == 192
    assert abs(float(np.linalg.norm(emb)) - 1.0) < 1e-4


def test_self_cosine_is_one():
    from main import SPK
    from spikes.srv36.metrics import cosine
    pcm = _sine_pcm(180)
    assert cosine(SPK.embed(pcm, 16000), SPK.embed(pcm, 16000)) > 0.999
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_speaker_embed.py -v`
Expected: FAIL with `ImportError: cannot import name 'SPK' from 'main'` (or SKIP if the venv lacks speechbrain — bootstrap it first with `pip install -r requirements/cpu.txt`).

- [ ] **Step 5: Implement `SpeakerEngine`**

In `server/tts-sidecar/main.py`, near `ASR = WhisperEngine()` (~`:1931`), add. **Mirror the Whisper load/lock idiom (`:1821-1826`); do NOT use `functools.lru_cache` (it double-loads under `to_thread`). Resample with `numpy`, not `torchaudio`:**

```python
class SpeakerEngine:
    """ECAPA-TDNN speaker embedding (srv-36). CPU-only, NOT in the synth ENGINES
    map — like WhisperEngine, it consumes audio and emits a vector."""
    TARGET_SR = 16000

    def __init__(self):
        self._model = None
        self._load_lock = asyncio.Lock()
        self._infer_lock = threading.Lock()
        self.device = os.environ.get("SPK_DEVICE", "cpu")

    async def ensure_loaded(self):
        if self._model is not None:
            return
        async with self._load_lock:
            if self._model is not None:
                return
            from speechbrain.inference.speaker import EncoderClassifier
            self._model = await asyncio.to_thread(
                EncoderClassifier.from_hparams,
                source="speechbrain/spkrec-ecapa-voxceleb",
                run_opts={"device": self.device},
            )

    def embed(self, pcm: bytes, sample_rate: int) -> list[float]:
        import torch
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if sample_rate != self.TARGET_SR:  # numpy resample (no torchaudio dep)
            n = int(round(len(audio) * self.TARGET_SR / sample_rate))
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        t = torch.from_numpy(audio).unsqueeze(0)
        with self._infer_lock, torch.no_grad():
            emb = self._model.encode_batch(t).squeeze().cpu().numpy().astype(np.float32)
        norm = float(np.linalg.norm(emb))
        return (emb / norm if norm > 0 else emb).tolist()


SPK = SpeakerEngine()
```

Ensure `import threading` and `import asyncio`/`import os`/`import numpy as np` are present near the top (Whisper already imports them — verify).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_speaker_embed.py -v`
Expected: PASS (or SKIP on a box without weights — both are green).

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/requirements/ server/tts-sidecar/main.py server/tts-sidecar/tests/test_speaker_embed.py
git commit -m "feat(sidecar): srv-36 SpeakerEngine (ECAPA, CPU, Whisper-idiom loader)"
```

### Task 2: POST /embed endpoint (raw-body transport)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add the route near `/transcribe` ~`:3395`; add `spk_*` to `/health` ~`:2899`)
- Test: `server/tts-sidecar/tests/test_speaker_embed.py`

**Interfaces:**
- Produces: `POST /embed` — request body = raw int16 LE PCM, header `X-Sample-Rate`; response `{ "embedding": float[192], "dim": 192, "sample_rate": 16000 }`.

- [ ] **Step 1: Write the failing test** (append to `test_speaker_embed.py`)

```python
def test_embed_endpoint_raw_body(monkeypatch):
    from fastapi.testclient import TestClient
    import main
    monkeypatch.setattr(main.SPK, "embed", lambda pcm, sr: [0.0] * 192)
    monkeypatch.setattr(main.SPK, "ensure_loaded", _noop_async)
    client = TestClient(main.app)
    r = client.post("/embed", content=_sine_pcm(180), headers={"X-Sample-Rate": "16000"})
    assert r.status_code == 200
    body = r.json()
    assert body["dim"] == 192 and len(body["embedding"]) == 192
```

Add the `_noop_async` helper at the top of the file:

```python
async def _noop_async(*a, **k):
    return None
```

- [ ] **Step 2: Run to verify it fails** — Run: `... -m pytest tests/test_speaker_embed.py::test_embed_endpoint_raw_body -v` → FAIL (404, route missing).

- [ ] **Step 3: Implement the route** in `main.py`, modelled on `/transcribe` (`:3395-3437`) — raw body + header, `to_thread` offload, the poison/recycle fences copied from `/transcribe`:

```python
@app.post("/embed")
async def embed(req: Request):
    sr = req.headers.get("X-Sample-Rate")
    if not sr:
        raise HTTPException(status_code=400, detail="X-Sample-Rate header required")
    pcm = await req.body()
    await SPK.ensure_loaded()
    embedding = await asyncio.to_thread(SPK.embed, pcm, int(sr))
    return {"embedding": embedding, "dim": len(embedding), "sample_rate": SPK.TARGET_SR}
```

- [ ] **Step 4: Add `/health` fields** — in the `/health` handler (~`:2899`, beside `asr_loaded`/`asr_device`) add `"spk_loaded": SPK._model is not None, "spk_device": SPK.device`.

- [ ] **Step 5: Run to verify it passes** — Run: `... -m pytest tests/test_speaker_embed.py -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_speaker_embed.py
git commit -m "feat(sidecar): srv-36 POST /embed (raw-body, to_thread offload)"
```

---

## Phase 2 — Server: settings, embed client, inline embed + storage

### Task 3: Settings registry

**Files:**
- Modify: `server/src/config/registry.ts` (add three keys beside `qa.asr.enabled` ~`:194`)
- Test: `server/src/config/registry.test.ts` (or the registry's existing test file)

**Interfaces:**
- Produces: config keys `qa.speaker.enabled` (env `SEG_SPK_ENABLED`), `qa.speaker.device` (env `SPK_DEVICE`), `qa.speaker.autoRepair` (env `SEG_SPK_AUTO_REPAIR`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { registry } from './registry.js';
describe('qa.speaker settings', () => {
  it('registers three qa-gates keys with correct apply modes', () => {
    const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
    expect(byKey['qa.speaker.enabled']).toMatchObject({ group: 'qa-gates', apply: 'live', default: false });
    expect(byKey['qa.speaker.device']).toMatchObject({ apply: 'restart-sidecar', default: 'cpu' });
    expect(byKey['qa.speaker.autoRepair']).toMatchObject({ apply: 'live', default: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `cd server && npm run test -- registry` → FAIL.

- [ ] **Step 3: Implement** — add to `registry.ts` (copy the `qa.asr.enabled` entry shape at `:194` exactly; the device enum mirrors no existing key — it is the first device key in `qa-gates`):

```ts
{ key: 'qa.speaker.enabled', env: 'SEG_SPK_ENABLED', group: 'qa-gates',
  label: 'Render-integrity QA (voice match)',
  help: 'When on, each rendered line of a stochastic-engine character is embedded '
      + '(ECAPA speaker model) and checked for acoustic match against the '
      + "character's voice centroid, flagging misfires. Off by default. CPU (zero VRAM).",
  type: 'boolean', default: false, apply: 'live', risk: 'low' },
{ key: 'qa.speaker.device', env: 'SPK_DEVICE', group: 'qa-gates',
  label: 'Voice-QA device',
  help: '"cpu" (default) uses zero VRAM and never competes with synthesis. '
      + '"cuda" is Phase 2. Changing the device restarts the sidecar.',
  type: 'enum', options: ['cpu', 'cuda'], default: 'cpu', apply: 'restart-sidecar', risk: 'medium' },
{ key: 'qa.speaker.autoRepair', env: 'SEG_SPK_AUTO_REPAIR', group: 'qa-gates',
  label: 'Auto-fix voice mismatches',
  help: 'When on, severe voice-mismatch lines are re-rendered and replaced if the '
      + 'fresh take matches. Off until calibration confirms a low false-positive rate.',
  type: 'boolean', default: false, apply: 'live', risk: 'medium' },
```

- [ ] **Step 4: Run to verify it passes** — Run: `cd server && npm run test -- registry` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 qa.speaker.* settings"`

### Task 4: Embed client (`/embed` over raw body)

**Files:**
- Create: `server/src/tts/embed-client.ts`
- Test: `server/src/tts/embed-client.test.ts`

**Interfaces:**
- Consumes: the sidecar `POST /embed` (Task 2).
- Produces: `embedSegment(pcm: Buffer, sampleRate: number) -> Promise<Float32Array>` (length 192). Reads the sidecar base URL the same way `transcribe-client.ts` does (copy its URL resolution — it reads from user-settings, NOT env; see `transcribe-client.ts`).

- [ ] **Step 1: Write the failing test** — mock `fetch`, assert the request uses `content-type: audio/L16`, an `x-sample-rate` header, the raw body, and returns a `Float32Array(192)`. (Mirror `transcribe-client.test.ts` if present.)

```ts
import { describe, it, expect, vi } from 'vitest';
import { embedSegment } from './embed-client.js';
describe('embedSegment', () => {
  it('posts raw PCM with X-Sample-Rate and parses the vector', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ embedding: Array(192).fill(0.1), dim: 192, sample_rate: 16000 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const out = await embedSegment(Buffer.alloc(64000), 24000);
    expect(out).toHaveLength(192);
    expect(calls[0].init.headers['x-sample-rate']).toBe('24000');
    expect(calls[0].init.headers['content-type']).toContain('audio/L16');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `cd server && npm run test -- embed-client` → FAIL.
- [ ] **Step 3: Implement** `embed-client.ts`. **The sidecar URL resolver is `getResolvedSidecarUrl()` from `../workspace/user-settings.js`** (NOT a `sidecarBaseUrl()` in transcribe-client.ts — that does not exist; `transcribe-client.ts:23,68` imports `getResolvedSidecarUrl` and strips the trailing slash). Copy that exactly:

```ts
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export async function embedSegment(pcm: Buffer, sampleRate: number): Promise<Float32Array> {
  const base = getResolvedSidecarUrl().replace(/\/+$/, '');
  const res = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'audio/L16', 'x-sample-rate': String(sampleRate) },
    body: pcm,
  });
  if (!res.ok) throw new Error(`/embed ${res.status}`);
  const body = (await res.json()) as { embedding: number[] };
  return Float32Array.from(body.embedding);
}
```

(The `/transcribe` client additionally uses `undiciFetch` with a zero-timeout `Agent` so a busy sidecar never aborts a long call. A CPU ECAPA embed is sub-second, so bare `fetch` is acceptable here; switch to the undici Agent only if embed latency surprises in the Task 16 benchmark.)

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 /embed client (raw-body)"`

### Task 5: Embeddings + verdict sibling IO

**Files:**
- Create: `server/src/audio/render-integrity/constants.ts`, `embeddings-io.ts`, `verdicts-io.ts`
- Test: `server/src/audio/render-integrity/embeddings-io.test.ts`, `verdicts-io.test.ts`

**Interfaces:**
- Produces (constants): `EMBEDDINGS_VERSION = 'spk-ecapa-v1'`; `MIN_DURATION_SEC = 3.0` (the duration floor, shared by the embed pass (Task 6) and scoring (Task 8) so there is no forward reference). These are the single source of truth.
- Produces (embeddings-io): re-exports `EMBEDDINGS_VERSION` from `constants.ts` for convenience; `EmbeddingRow = { characterId: string; sentenceIds: number[]; vec: Float32Array }`; `writeEmbeddings(path, rows, version): Promise<void>` (base64 Float32, atomic via `writeJsonAtomic`); `readEmbeddings(path): Promise<{ version: string; rows: EmbeddingRow[] } | null>` (null when missing — torn-write tolerant).
- Produces (verdicts-io): `Verdict = 'voice-match'|'voice-mismatch'|'inconclusive'`; `VerdictRow = { characterId; sentenceIds; verdict: Verdict; cosine: number; severity: 'severe'|'inconclusive'|null; fixable: boolean; expectedEngine: string; renderedEngine: string; referenceKind: 'in-book'|'audition'|'too-short'; windowed: boolean }`; `writeVerdicts(path, rows): Promise<void>`; `readVerdicts(path): Promise<VerdictRow[] | null>`.

- [ ] **Step 1: Write the failing test** (embeddings-io): round-trip a row through write→read, assert vector equality and base64 packing; assert `readEmbeddings('missing')` returns `null` (torn-write tolerance) and a version mismatch is reported as stale.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEmbeddings, readEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

describe('embeddings-io', () => {
  it('round-trips a vector and tolerates a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-'));
    const p = join(dir, 'ch1.embeddings.json');
    await writeEmbeddings(p, [{ characterId: 'c1', sentenceIds: [1, 2], vec: Float32Array.from([0.5, -0.25]) }], EMBEDDINGS_VERSION);
    const back = await readEmbeddings(p);
    expect(back?.version).toBe(EMBEDDINGS_VERSION);
    expect(Array.from(back!.rows[0].vec)).toEqual([0.5, -0.25]);
    expect(await readEmbeddings(join(dir, 'nope.json'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** both modules. Use the existing `writeJsonAtomic` from `server/src/workspace/state-io.ts` (the same primitive `finalize-chapter-write.ts:199` uses). Pack vectors as base64 of the Float32 buffer. `readEmbeddings` returns `null` on ENOENT (do not throw). Stamp `{ version, rows }`.
- [ ] **Step 4: Run to verify it passes** → PASS. Then add a `verdicts-io` round-trip test + implementation the same way.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 embeddings + verdict sibling IO"`

### Task 6: Inline embed pass + sibling write on finalize

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (clone the `asr` pass at `:1320-1376` as a `spk` pass; collect `{ segmentIndex|sentenceIds, characterId, vec }`)
- Modify: `server/src/audio/finalize-chapter-write.ts` (after the segments write `:199`, write the embeddings sibling)
- Test: `server/src/tts/synthesise-chapter.spk.test.ts`

**Interfaces:**
- Consumes: `embedSegment` (Task 4), `writeEmbeddings` (Task 5).
- Produces: an `<slug>.embeddings.json` sibling alongside the segments file, containing one row per stochastic-engine group of ≥-floor duration.
- **Note (benchmark robustness):** this inline embed is an *optimization* that pre-populates the sibling (PCM in hand, no re-decode). `scoreBook` (Task 9) only READS the sibling — so if the Task 16 CPU benchmark shows inline embedding slows generation, this task is disabled and `scoreBook` instead embeds by re-decoding the chapter audio. Keep the embed call behind a one-line `embedGroupInline` seam so that switch is a config flip, not a rewrite. **Known limitation:** a book generated with the gate OFF has no embeddings sibling, so Node-side scoring/auto-fix can't run on it retroactively — retroactive scoring of old books is the Python calibration harness's job (Task 14).

- [ ] **Step 1: Write the failing test** — drive `synthesiseChapter` (or the extracted `spk` helper) with a mocked `embedSegment` and two groups, one Qwen and one Kokoro; assert only the Qwen group produces an embedding row (Kokoro skipped — the stochastic-only filter), and the per-group `sampleRate` is passed to `embedSegment`.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — clone the optional `asr` block (`:1320-1376`). Guard each group on **configured engine ∈ {qwen, coqui}** (skip Kokoro — Global Constraint) and on raw `pcmDurationSec(r.pcm.length, r.sampleRate)` ≥ `MIN_DURATION_SEC` — note `pcmDurationSec` takes the **byte length** (`pcm.ts:9`, `pcmDurationSec(pcmBytes: number, sampleRate)`), NOT the Buffer. Call `embedSegment(r.pcm, r.sampleRate)` — **per-group sampleRate**, not the chapter anchor. Accumulate `EmbeddingRow[]` and add an `embeddings` field to `ChapterSynthesisResult` (additive — both callers destructure named fields, so this won't break them). Add an **optional** `embeddings?: EmbeddingRow[]` to `FinalizeChapterAudioInput` (`finalize-chapter-write.ts:57-80`); after `writeJsonAtomic(segPath, …)` (`:199`), `if (input.embeddings) await writeEmbeddings(embPath, input.embeddings, EMBEDDINGS_VERSION)` — a SEPARATE atomic write (no shared transaction). **Thread the new field at BOTH finalize call sites** — `routes/generation.ts:1387` (pass `result.embeddings`) and `chapter-qa-repair.ts:345` (pass `undefined`/omit; optional, so the splice path compiles untouched).
- [ ] **Step 4: Run to verify it passes** → PASS. Gate the whole pass behind `configValue('qa.speaker.enabled')` so it's inert by default.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 inline embed pass + embeddings sibling"`

---

## Phase 3 — Server: scoring (centroid, verdict, aggregate)

### Task 7: Hybrid centroid builder (pure)

**Files:**
- Create: `server/src/audio/render-integrity/centroid.ts`
- Test: `server/src/audio/render-integrity/centroid.test.ts`

**Interfaces:**
- Produces: `buildCentroid(eligible: Float32Array[], opts): { centroid: Float32Array; kind: 'in-book'|'too-thin'; bimodal: boolean }`. `eligible` = anchor-eligible vectors (caller pre-filters gate-passing AND `renderedFallbackEngine` unset). Returns `kind: 'too-thin'` when `eligible.length < N`. Uses a **deterministic iterate-to-converge trimmed mean** (drop lowest-cosine fraction α, re-centroid, until shift < ε or M iters). Detects bimodality (a gap in the sorted cosine-to-provisional-centroid distribution). Constants `CENTROID_MIN_N=10`, `TRIM_ALPHA=0.1`, `TRIM_EPS=1e-3`, `TRIM_MAX_ITERS=5` exported.

- [ ] **Step 1: Write the failing test** — (a) a tight cluster of 20 near-identical vectors → centroid ≈ their mean, `bimodal:false`; (b) 18 clean + 2 far outliers → trimming pulls the centroid to the clean cluster; (c) 12 clean + 8 forming a second mode → `bimodal:true`; (d) 6 vectors → `kind:'too-thin'`. Assert determinism (same input → identical centroid across two calls).
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** using the spike's `metrics.centroid`/`cosine` math (port to TS, numbers in `Float64`). Iterate: centroid = renormalized mean; cosines; drop lowest `TRIM_ALPHA`; repeat until the centroid shift (1 − cosine(prev,next)) < `TRIM_EPS` or `TRIM_MAX_ITERS`. Bimodality = largest gap between consecutive sorted cosines exceeds a threshold AND splits the set into two non-trivial groups.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 hybrid centroid (deterministic robust trim + bimodal detect)"`

### Task 8: 3-tier per-character scoring (pure) + cutoff constants

**Files:**
- Create: `server/src/audio/render-integrity/score.ts`
- Test: `server/src/audio/render-integrity/score.test.ts`

**Interfaces:**
- Consumes: `buildCentroid` (Task 7).
- Consumes: `MIN_DURATION_SEC` from `constants.ts` (Task 5).
- Produces: `CUTOFFS = { severeEdgePctl: 6, bandUpperPctl: 10, minDurationSec: MIN_DURATION_SEC }` (named, calibration-tuned, pinned by this test); `scoreSegment(cosine, spread, durationSec): { verdict: Verdict; severity }` where `spread = { p_severe, p_band }` are the character's own percentile cutoffs (E < U). `cosine < E → voice-mismatch/severe`; `E ≤ cosine < U → inconclusive`; `≥ U → voice-match`; `durationSec < CUTOFFS.minDurationSec → inconclusive` regardless. `percentile(sorted, pctl)` helper. Also exports `cosineToCentroid(vec: number[], centroid: number[]): number` (the spike's `cosine`, ported) — used by the aggregate (Task 9) and the auto-fix accept-check (Task 13). The **auto-fix accept rule** is "cos ≥ the character's `cleanMean`" (a re-render must beat the voice's clean centre, not merely clear U) — there is no separate magic number, so `ACCEPT_MARGIN` is this documented rule against `cleanMean`, not a standalone constant.

- [ ] **Step 1: Write the failing test** — pin `CUTOFFS`; assert the three bands + the sub-floor-duration → inconclusive override, using a synthetic clean spread (E=0.47, U=0.60): cosine 0.40 → severe; 0.55 → inconclusive; 0.70 → match; (0.70, dur 1s) → inconclusive.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** `score.ts`.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 3-tier per-character scoring + pinned cutoffs"`

### Task 9: Centroid persistence + aggregate orchestrator

**Files:**
- Create: `server/src/audio/render-integrity/centroids-io.ts`, `aggregate.ts`
- Test: `server/src/audio/render-integrity/aggregate.test.ts`

**Interfaces:**
- Consumes: `readEmbeddings` (Task 5), `buildCentroid` (Task 7), `scoreSegment` + `CUTOFFS` (Task 8), `writeVerdicts` (Task 5), and the persisted segments file.
- **DATA MODEL — read carefully (verified against the real `<slug>.segments.json`):** the **configured engine is NOT per-segment.** `voiceEngine` lives only on the per-character `characterSnapshots` map (`character-snapshots.ts:39`). `renderedFallbackEngine` **is** per-segment on the raw `segments[]` entries (`synthesise-chapter.ts:1405`) — *and also* per-character on `characterSnapshots` (collapsed to "fell back somewhere"; do NOT use that one). So the aggregator must parse BOTH and join on `characterId`:
  - configured engine for the **stochastic-only filter** → `characterSnapshots[seg.characterId].voiceEngine` (per-character join).
  - **fallback exclusion (C1)** → each segment's own `segments[i].renderedFallbackEngine` (per-segment, so a single fallback line is excluded — NOT all of a character's lines). Extend the `segments-io.ts` read-view type (`:50`) to surface it; do NOT use `collectRenderedFallbackEngines` (per-character-collapsed → over-excludes).
- Produces (centroids-io): `CharacterCentroid = { characterId; centroid: number[]; cleanMean: number; pSevere: number; pBand: number; referenceKind: 'in-book'|'audition'|'too-short' }`; `writeCentroids(bookDir, rows)` → `<book>.centroids.json`; `readCentroids(bookDir): Promise<Record<string, CharacterCentroid> | null>`.
- Produces (aggregate): `scoreBook(bookDir, chapters): Promise<void>` — for each character: gather anchor-eligible vectors (gate-passing AND `renderedFallbackEngine` unset AND stochastic engine), `buildCentroid`; if `too-thin` or `bimodal` → Option-B audition centroid (Task 10); compute the clean spread (`pSevere`=E, `pBand`=U via `percentile`) + `cleanMean`; **persist all per-character centroids via `writeCentroids`** (so the repair route reads them — Task 13); score every segment (fallback ones included, as candidates); write one `<slug>.render-integrity.json` per chapter. **Idempotent** — safe to re-run as more chapters complete (Task 12 invokes it per-chapter-done). Skips Kokoro-configured characters entirely. `fixable = severity==='severe' && configuredEngine ∈ {qwen,coqui}` (the availability probe is applied at repair time, Task 13).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreBook } from './aggregate.js';
import { readVerdicts } from './verdicts-io.js';
import { readCentroids } from './centroids-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// helper: a 2-d unit vector at angle θ, padded to length 8 (test vectors are small)
const vec = (θ: number) => Float32Array.from([Math.cos(θ), Math.sin(θ), 0, 0, 0, 0, 0, 0]);

describe('scoreBook', () => {
  it('flags a drifted segment + a fallback segment, passes the rest, and persists centroids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-book-'));
    // 12 clean Qwen segments clustered at θ≈0, one drifted at θ=1.2 rad, one fallback (kokoro) at θ≈0
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'hero', sentenceIds: [i], vec: vec(0.02 * i) });
    rows.push({ characterId: 'hero', sentenceIds: [99], vec: vec(1.2) });      // drifted
    rows.push({ characterId: 'hero', sentenceIds: [100], vec: vec(0.01) });    // fallback render
    await writeEmbeddings(join(dir, 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    // REAL shape: voiceEngine lives ONLY on characterSnapshots (per-character);
    // renderedFallbackEngine is per-segment on the segments[] entries.
    writeFileSync(join(dir, 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({
        characterId: 'hero', sentenceIds: r.sentenceIds,
        renderedFallbackEngine: r.sentenceIds[0] === 100 ? 'kokoro' : null,
      })),
      characterSnapshots: { hero: { voiceEngine: 'qwen', renderedFallbackEngine: 'kokoro' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'ch1.render-integrity.json'));
    const bySent = Object.fromEntries(verdicts!.map((v) => [v.sentenceIds[0], v.verdict]));
    expect(bySent[99]).toBe('voice-mismatch');   // drifted
    expect(bySent[100]).toBe('voice-mismatch');  // fallback caught acoustically
    expect(bySent[0]).toBe('voice-match');
    const centroids = await readCentroids(dir);
    expect(centroids!['hero'].referenceKind).toBe('in-book');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `cd server && npm run test -- aggregate` → FAIL.
- [ ] **Step 3: Implement** `centroids-io.ts` (round-trip via `writeJsonAtomic`) then `scoreBook` per the interface.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 aggregate + persisted per-character centroids"`

### Task 10: Option-B audition centroid + terminal blind spot

**Files:**
- Modify: `server/src/audio/render-integrity/aggregate.ts` (the `too-thin`/`bimodal` branch)
- Create: `server/src/audio/render-integrity/audition-centroid.ts`
- Test: `server/src/audio/render-integrity/audition-centroid.test.ts`

**Interfaces:**
- Consumes: `selectTtsProvider(modelKey)` from `tts/index.ts` → `provider.synthesize({ text, voiceName, modelKey, signal? }): Promise<{ pcm, sampleRate }>` (a plain importable library call — NOT the `voice-sample.ts` route; `chapter-qa-repair.ts` already calls these from library depth). `buildSampleText(voice, hint?)` from `voice-sample-cache.ts:64` supplies the sample text. `embedSegment` (Task 4), `buildCentroid`.
- Produces: `auditionCentroid(character, opts): Promise<{ centroid: Float32Array; kind: 'audition'|'too-short' } | null>` — render the character's audition sample K times, embed, centroid. If a render is under the duration floor, extend with the next evidence quote (bounded, once); if still short → `kind:'too-short'`. `CENTROID_K=12` exported.

- [ ] **Step 1: Write the failing test** — mock `provider.synthesize` + `embedSegment`; assert K renders → a centroid; assert the under-floor → `too-short` terminal path; assert a `too-short` character's segments all become `inconclusive` and are named in the derived report.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — `const provider = selectTtsProvider(modelKey); const { pcm, sampleRate } = await provider.synthesize({ text: buildSampleText(voice, hint), voiceName, modelKey });` × K, embed each (`embedSegment(pcm, sampleRate)`), `buildCentroid`. Cache the centroid keyed by voice-config hash + an `evidence-exhausted` marker.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 Option-B audition centroid + too-short blind spot"`

### Task 11: Book-outline derive (cheap, verdict-only)

**Files:**
- Modify: `server/src/audio/render-integrity/verdicts-io.ts` (add `deriveBookOutline`)
- Test: `server/src/audio/render-integrity/verdicts-io.test.ts`

**Interfaces:**
- Produces: `deriveBookOutline(bookDir, chapters): Promise<{ issues: VerdictRow[]; counts: { suspect: number; fixable: number; uncheckedCharacters: string[] } }>` — scans ONLY the per-chapter `<slug>.render-integrity.json` files (never the embeddings), mirroring `loadSegmentsFiles` (`segments-io.ts:85`, read at `revisions.ts:128`).

- [ ] **Step 1: Write the failing test** — two chapter verdict files → assert the rollup counts (suspect = voice-mismatch count, fixable subset, uncheckedCharacters = the `too-short` set) and that no embeddings file is read (spy on `readEmbeddings` → not called).
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** `deriveBookOutline`.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 cheap book-outline derive (verdict files only)"`

### Task 12: Wire the score pass into generation completion

**Files:**
- Modify: `server/src/routes/generation.ts` (the per-chapter-done hook `:1401-1428`, right after `finalizeChapterAudioWrite` returns, inside `processOneChapter`). **Path is `routes/generation.ts`.**
- Test: `server/src/routes/generation-spk.test.ts`

**Interfaces:**
- Consumes: `scoreBook` (Task 9).
- Produces: after each chapter finalizes, `scoreBook(bookDir, fullBookChapters)` runs (idempotent, single-flight per book), gated on `configValue('qa.speaker.enabled')`, non-fatal. **`fullBookChapters` MUST be `state.chapters.map(c => ({ id: c.id, slug: c.slug }))` — the WHOLE book** (in scope at the hook), NOT `targetChapters` (the one just-finished chapter) and NOT `chapter`. Feeding one chapter builds the centroid from one chapter — silently wrong.

- [ ] **Step 1: Write the failing test** — extract a thin `afterChapterFinalized(ctx)` helper (unit-testable without a full generation run); assert it calls `scoreBook(bookDir, chapters)` only when enabled, and that two concurrent same-book calls coalesce into ONE `scoreBook` run (single-flight). Mock `scoreBook` + `configValue`.

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../audio/render-integrity/aggregate.js', () => ({ scoreBook: vi.fn(async () => {}) }));
import { scoreBook } from '../audio/render-integrity/aggregate.js';
import { afterChapterFinalized } from './generation.js';
import * as cfg from '../config/resolver.js';

describe('afterChapterFinalized', () => {
  it('runs the score pass only when enabled, and single-flights per book', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({ bookId: 'b', bookDir: '/b', chapters: [{ id: 1, slug: 'ch1' }] });
    expect(scoreBook).toHaveBeenCalledWith('/b', [{ id: 1, slug: 'ch1' }]);
    vi.mocked(scoreBook).mockClear();
    // two concurrent same-book invocations → coalesce to one run
    await Promise.all([
      afterChapterFinalized({ bookId: 'b', bookDir: '/b', chapters: [{ id: 1, slug: 'ch1' }] }),
      afterChapterFinalized({ bookId: 'b', bookDir: '/b', chapters: [{ id: 1, slug: 'ch1' }] }),
    ]);
    expect(scoreBook).toHaveBeenCalledTimes(1);
    vi.mocked(scoreBook).mockClear();
    vi.spyOn(cfg, 'configValue').mockReturnValue(false);
    await afterChapterFinalized({ bookId: 'b', bookDir: '/b', chapters: [{ id: 1, slug: 'ch1' }] });
    expect(scoreBook).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `cd server && npm run test -- generation-spk` → FAIL.
- [ ] **Step 3: Implement** — add `afterChapterFinalized` with a per-`bookId` single-flight guard, and call it at `routes/generation.ts:1401-1428` passing the FULL book chapter list from `state.chapters`:

```ts
const scoringInFlight = new Map<string, Promise<void>>();

export async function afterChapterFinalized(
  ctx: { bookId: string; bookDir: string; chapters: { id: number; slug: string }[] },
) {
  if (!configValue('qa.speaker.enabled')) return;
  // Generation is parallel/worker-based with NO single "book done" seam (verified), so we
  // re-score on every chapter-done. Single-flight per book so concurrent same-book
  // chapter-dones coalesce into one whole-book re-score instead of racing duplicate work +
  // the centroids.json write. Non-fatal: scoring must never break generation.
  if (scoringInFlight.has(ctx.bookId)) return scoringInFlight.get(ctx.bookId);
  const run = scoreBook(ctx.bookDir, ctx.chapters)
    // generation.ts has NO `log`/`logger` symbol — it logs via console.warn throughout.
    .catch((e) => console.warn(`[generation] render-integrity score pass failed: ${String(e)}`))
    .finally(() => scoringInFlight.delete(ctx.bookId));
  scoringInFlight.set(ctx.bookId, run);
  return run;
}
```

At the call site (`:1401-1428`): `await afterChapterFinalized({ bookId, bookDir, chapters: state.chapters.map((c) => ({ id: c.id, slug: c.slug })) });`

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 wire score pass into generation completion"`

---

## Phase 4 — Auto-fix inside the repair route

### Task 13: Acoustic candidate source + accept-check in chapter-qa-repair.ts

**Files:**
- Modify: `server/src/routes/chapter-qa-repair.ts` (~6 edit sites per spec §5; route is already async + best-of-N with `maxRerecords` default 2)
- Test: `server/src/routes/chapter-qa-repair-spk.test.ts`

**Interfaces:**
- Consumes: `readVerdicts` (Task 5, the acoustic candidates), `readCentroids` (Task 9 — the persisted `<book>.centroids.json`; the route is single-chapter and has no book-wide state, so it READS the centroid, never rebuilds it), `cosineToCentroid` + `CUTOFFS.ACCEPT_MARGIN` (Task 8 — see below), `embedSegment` (Task 4).
- Produces: acoustic candidates merged into `flagged[]`; an acoustic term in the `isAcceptable` predicate; the accepted take's new embedding written back to the embeddings + verdict siblings post-finalize.

**Prerequisite (defined in Task 8, referenced here):** add to `score.ts` — `cosineToCentroid(vec, centroid): number` (= the spike's `cosine`), and `ACCEPT_MARGIN` as a field on `CUTOFFS` (the accept threshold expressed as "≥ the character's `cleanMean` from `<book>.centroids.json`" — a re-render must beat the voice's clean centre, not merely clear U). If Task 8 is already done, add these in this task and back-fill its pin test.

- [ ] **Step 1: Write the failing test** — drive the repair route (supertest, dry-run) with a fixture chapter whose `<slug>.render-integrity.json` flags one `voice-mismatch`/`fixable` segment + a fixture `<book>.centroids.json`; assert the dry-run `qa_scan` lists the acoustic candidate. Then a non-dry-run with a mocked re-record + mocked `/embed` returning a high-cosine (≥ cleanMean) take → assert it's accepted, `qa_repair_complete.repaired` includes it, and the embeddings/verdict rows are rewritten.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement the ~6 edits** (anchors confirmed against the route):
  1. After the scan loop (`:194`): read the chapter's `<slug>.render-integrity.json` (`readVerdicts`), filter `verdict==='voice-mismatch' && fixable`, map to the candidate shape `{ segmentIndex, characterId, sentenceIds, reasons: ['voice-mismatch cosine … < E …'], acoustic: true }`. **On dedupe by `segmentIndex`: if a signal/ASR candidate already covers that segment, UNION — set `acoustic: true` on the existing one (so the acoustic accept term still applies) — do NOT drop the acoustic flag.** Gate this acoustic candidate source on `configValue('qa.speaker.autoRepair')` (detection surfacing is independent — it comes from the verdict files via Task 11, not this route).
  2. Before re-rendering a fixable acoustic candidate, **probe the configured engine is available**; skip + mark `inconclusive` "engine unavailable" if not (a structural fallback won't be fixed by a retry). Also skip (defensively) if `readCentroids` returns no entry for the character or `referenceKind === 'too-short'` — there's no usable centroid to score the re-render against (this shouldn't happen, since too-short characters never produce a `severe`/`fixable` verdict, but guard rather than crash on a stale `centroids.json`).
  3. Load the character centroid once via `readCentroids(bookDir)` and add `bestCosine` to the running best-state triple (`:286-288`).
  4. The re-render runs inside the `buildSynthReplacements({ synth: async (seg) => {...} })` callback (`:277-330`). After the existing ASR `await` (`:312`) in that callback: `const cos = cosineToCentroid(Array.from(await embedSegment(r.pcm, r.sampleRate)), centroids[seg.characterId].centroid);` — embed the **pre-resample/pre-loudnorm `r.pcm`** (consistent with the generation-time embed).
  5. Extend `isAcceptable(v, a)` → `isAcceptable(v, a, cos, candidate)`. **The acoustic term is CONDITIONAL on candidate origin** — `isAcceptable` is shared with the signal/ASR candidates, so a pure signal-QA repair must NOT be rejected because its cosine is below the character's mean (and a character without a centroid must not be gated at all). Apply the acoustic term **only when `candidate.acoustic === true` AND a centroid exists for the character**: then additionally require `cos ≥ centroids[characterId].cleanMean` (beat the clean centre, not merely `≥ U`). For non-acoustic candidates the predicate is unchanged. Feed into the existing `better`/early-break machinery.
  6. Capture `{segmentIndex → newEmbedding}` in the outer scope (the callback already pushes to `repaired`/`stillSuspect` arrays there). After `finalizeChapterAudioWrite` returns (`:358`): write the accepted takes' new embeddings into `<slug>.embeddings.json` and updated verdicts into `<slug>.render-integrity.json`.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): srv-36 acoustic auto-fix in audio-qa-repair route"`

---

## Phase 5 — Calibration (on-box harness + operator listen)

> The BUILD tasks below are autonomous + TDD. The **operator listen + recording FP/FN + flipping the `autoRepair` default** is an explicit manual step (Task 16 checklist), NOT an autonomous task — per spec §6.

### Task 14: Calibration harness (cutoff fitting over a real book)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/calibrate.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_calibrate.py`

**Interfaces:**
- Consumes: the spike helpers (`embed`, `metrics`, `segments_io`, `gates`), a book's on-disk renders.
- Produces: `fit_cutoffs(per_char_clean_cosines, labelled_clips) -> { severe_edge_pctl, band_upper_pctl, min_duration_sec, N, K }`; a JSON report of per-character spreads + the chosen constants.

- [ ] **Step 1: Write the failing test** — synthetic per-character cosine distributions + a small labelled set → assert `fit_cutoffs` returns the percentile that best separates the labelled drift (the F3/F4 logic), and that the min-duration floor is derived from cosine-variance-vs-clip-length.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** `fit_cutoffs` + a CLI entry that embeds a book (reusing `probe_real_library.py`) and writes the report. Re-key on `sentenceIds` (NOT timestamps — the owed Phase-0 fix folds in here).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): srv-36 calibration harness (cutoff fitting)"`

### Task 15: Held-out listen-set generator

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/listen_set.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_listen_set.py`

**Interfaces:**
- Produces: `emit_listen_set(book_dir, cutoffs, out_dir) -> manifest` — for a held-out book, extract the flagged tail + the straddle band (~15–20 clips) as wav + a manifest (character, chapter, cosine, predicted verdict), the operator listens.

- [ ] **Step 1: Write the failing test** — a fixture set of scored segments → assert the emitted set is the lowest-cosine flagged + the band straddlers, capped at ~20, with a manifest row each.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** (reuse `extract_listen.py` from the spike).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): srv-36 held-out listen-set generator"`

### Task 16: Run the calibration + operator validation (MANUAL — operator-gated)

**Not an autonomous task.** Checklist, run on-box:

- [ ] Bootstrap the venv with the new deps: `pip install -r requirements/cpu.txt` (pulls `speaker-qa.txt`); record the resolved `speechbrain` + `huggingface_hub` versions.
- [ ] Embed + fit on **Scepter** (`C:/AudiobookWorkspace/books/Derek Landy/Skulduggery Pleasant/Scepter of the Ancients/audio/`) via `calibrate.py`; capture the per-character spreads + chosen `CUTOFFS`.
- [ ] Apply (never tune) on the held-out sets — **Unlocked** (FN signal) + **The Coalfall Commission** (clean → FP signal). Emit listen-sets via `listen_set.py`.
- [ ] **Record the checked-coverage %** from `calibrate.py`. **If coverage is below bar (too many sub-floor lines `inconclusive`), windowing is required** (spec §4.2): file a follow-up task to window consecutive same-speaker short lines into one ≥-floor query — and **estimate the per-character spread on windowed units too** (symmetric windowing, or E/U mis-scale). If coverage is fine, windowing is not built (YAGNI).
- [ ] **Operator listens** (~15–20 clips/book) and judges; record out-of-sample **FP/FN** + the **F4 residual-value fraction**.
- [ ] Write the chosen `CUTOFFS` back into `score.ts` (Task 8) + update the pinned regression test; document Coqui as uncalibrated.
- [ ] **If FP is low → flip `qa.speaker.autoRepair` default consideration** (still ships default-off; the flip is a follow-up decision). If FP is high → re-tune → re-listen (bounded follow-up; detection still ships).
- [ ] Fill the spec's **Ship notes** (date · SHA · N/K · severe-edge pctl · band width · min duration · coverage % · held-out FP/FN · residual-value · `/embed` latency · resolved pins).

---

## Self-Review

- [ ] **Spec coverage:** Unit 1 (Tasks 1–2) · Unit 2 embed+storage (Tasks 4–6) · Unit 3 score (Tasks 7–11) · score-pass wiring (Task 12) · Unit 4 auto-fix (Task 13) · Calibration (Tasks 14–16) · Settings (Task 3) · the upsell event shape (the `VerdictRow` in Task 5 + `deriveBookOutline` in Task 11 carry `fixable`/`severity`/`referenceKind` for fs-51/com-1). The fs-51 UI + com-1 gate are explicitly out of scope.
- [ ] **CPU `/embed` benchmark** (spec §2 acceptance) — run as part of Task 16's on-box pass (latency × a real book's segment count) to confirm the inline-vs-post-pass choice; recorded in Ship notes.
- [ ] **No placeholders:** every code step shows code; commands are exact. `cosineToCentroid`/`ACCEPT_MARGIN` (Task 8), `CharacterCentroid`/`readCentroids` (Task 9), `afterChapterFinalized` (Task 12), `scoreBook` (Task 9) are all defined before their first use in Task 13.
- [ ] **Type consistency:** `Verdict`, `VerdictRow`, `EmbeddingRow`, `CharacterCentroid`, `buildCentroid`, `scoreSegment`, `cosineToCentroid`, `CUTOFFS`, `embedSegment`, `scoreBook`, `readCentroids`, `EMBEDDINGS_VERSION` are defined once (Tasks 5/7/8/9) and referenced consistently downstream.
