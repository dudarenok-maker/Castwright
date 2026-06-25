"""1.7B live-instruct golden-audio regression (#1099) — REAL model, opt-in.

Marked `@pytest.mark.golden` so the fast `test:sidecar` tier (`-m "not golden"`)
never loads a model. Run via `npm run test:golden-audio` (Suite A) on a box with
the Qwen 1.7B-Base weights. Triple-gated SKIP (venv / pytest handled by the
runner; Qwen-weights+CUDA handled here) so a box without weights is a clean SKIP.

What it locks on the 1.7B **live-instruct** path (the path the Quality tier uses
when `liveInstruct` is on — emotion delivered live via per-sentence `instruct`,
NOT via anchored emotion variants; the variant path is the 0.6B tier and is
covered by `test_qwen3.test_minted_variant_holds_base_identity`):

  - **Identity stability across instructs** — render one fixed probe line under
    each emotion's instruct and assert the ECAPA speaker-embedding cosine
    (neutral vs each emotion) stays within a calibrated tolerance. The spike
    measured ~0.0139; the blessed tolerance carries headroom over the on-box
    measurement.
  - **Audible delivery deltas** — the per-emotion output gain (`_LIVE_INSTRUCT_
    GAIN`: whisper 0.35 / sad 0.6 / neutral 1.0 / excited 1.15 / angry 1.7) must
    produce the expected loudness ordering (whisper quietest, angry loudest) and
    each emotion's measured loudness must stay within tolerance of the blessed
    value.
  - **Batched-RTF baseline** — render the whole 15-sentence mixed-emotion
    passage as ONE batched live-instruct forward and assert its rtf
    (gen_ms / audio_ms) stays under the blessed ceiling. Replaces the parent
    spike's non-reproducible RTF 0.67 with a committed, reproducible number
    (measure post-reboot, warm).

Bless: `GOLDEN_BLESS=1` (the `--bless` flag) records `instruct-baseline.json`
(measured identity cosines, per-emotion loudness, batched rtf, calibrated
tolerances) instead of asserting. Commit the result. The model load happens
inside the test body (never at import) so the normal suite collects this file
safely.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]  # server/tts-sidecar
REPO_ROOT = Path(__file__).resolve().parents[4]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

pytestmark = pytest.mark.golden

GOLDEN_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = GOLDEN_DIR / "expressive_passage.json"
BASELINE_PATH = GOLDEN_DIR / "instruct-baseline.json"

# The committed designed voice used for the golden (Coalfall narrator). Its .pt
# carries a ref_code, so the 1.7B-native prompt re-derives from it (the same
# voice instruct_smoke.py uses). Copied into a temp voices dir per-run so the
# derived `__1.7b.pt` sibling never pollutes the committed samples tree.
VOICE_ID = "qwen-8434989a52184d08be265"
SAMPLE_VOICE_DIR = REPO_ROOT / "samples" / "the-coalfall-commission" / "voices" / "qwen"

# A fixed identity probe line: same text under every instruct so the cosine
# measures instruct-induced drift, not text difference.
PROBE_TEXT = "The harbor fell silent as the fog rolled in, swallowing the lanterns one by one."

# Mirror server/src/tts/emotion-instruct.ts PHRASES (the derived-from-emotion
# instruct). neutral -> "" (NEUTRAL_INSTRUCT). Used for the identity probe so it
# reflects what the live path actually sends when no explicit instruct exists.
PHRASES = {
    "neutral": "",
    "whisper": "in a soft, breathy whisper",
    "angry": "in an angry, raised voice",
    "excited": "with bright, energetic excitement",
    "sad": "in a subdued, downcast tone",
}
EMOTION_ORDER = ["neutral", "whisper", "sad", "excited", "angry"]


def _qwen_weights_present() -> bool:
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _pcm_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def _rms_dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(np.square(x.astype(np.float64)))))
    return 20.0 * math.log10(r) if r > 0 else -120.0


def _make_engine(tmp_voices: Path):
    """Build a QwenEngine pointed at an isolated temp voices dir holding only the
    committed probe voice, skipping the module when weights are absent."""
    import main  # noqa: PLC0415

    src_pt = SAMPLE_VOICE_DIR / f"{VOICE_ID}.pt"
    src_json = SAMPLE_VOICE_DIR / f"{VOICE_ID}.json"
    if not src_pt.is_file():
        pytest.skip(f"committed probe voice .pt absent at {src_pt}")
    tmp_voices.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_pt, tmp_voices / src_pt.name)
    if src_json.is_file():
        shutil.copy2(src_json, tmp_voices / src_json.name)

    os.environ["QWEN_VOICES_DIR"] = str(tmp_voices)
    engine = main.QwenEngine()
    engine._voices_dir = str(tmp_voices)
    return engine


def _render(engine, *, texts, instructs, emotions):
    """One batched live-instruct forward. Returns (per_item_float, sr, rtf)."""
    items = [
        {"voice": VOICE_ID, "text": t, "instruct": ins, "emotion": e}
        for t, ins, e in zip(texts, instructs, emotions)
    ]
    res = engine.synthesize_batch("1.7b", items, live_instruct=True)
    floats = [_pcm_to_float(p) for p in res.pcms]
    rtf = (res.gen_ms / res.audio_ms) if res.audio_ms > 0 else 0.0
    return floats, res.sample_rate, rtf


def _measure(engine) -> dict:
    """Render the identity probe + the full passage and return raw measurements."""
    # 1. Identity probe — same text, the five emotion instructs, ONE batch.
    p_floats, p_sr, _ = _render(
        engine,
        texts=[PROBE_TEXT] * len(EMOTION_ORDER),
        instructs=[PHRASES[e] for e in EMOTION_ORDER],
        emotions=EMOTION_ORDER,
    )
    probe = dict(zip(EMOTION_ORDER, p_floats))
    anchor = probe["neutral"]
    identity = {
        e: round(engine.speaker_distance(anchor, p_sr, probe[e], p_sr), 4)
        for e in EMOTION_ORDER
        if e != "neutral"
    }

    # 2. Full passage — rich per-sentence instruct (the shipped path), ONE batch.
    fixture = _load_json(FIXTURE_PATH)
    sents = fixture["sentences"]
    f_floats, _f_sr, rtf = _render(
        engine,
        texts=[s["text"] for s in sents],
        instructs=[s.get("instruct") or "" for s in sents],
        emotions=[s["emotion"] for s in sents],
    )
    by_emotion: dict[str, list[float]] = {}
    for s, w in zip(sents, f_floats):
        by_emotion.setdefault(s["emotion"], []).append(_rms_dbfs(w))
    loudness = {e: round(sum(v) / len(v), 2) for e, v in by_emotion.items()}

    return {"identity": identity, "loudness_dbfs": loudness, "rtf": round(rtf, 4)}


def _bless(measured: dict) -> None:
    baseline = _load_json(BASELINE_PATH)
    id_max = max(measured["identity"].values())
    baseline["tolerances"] = {
        # Calibrated ceilings with headroom over the on-box measurement.
        "identity_cosine_max": round(max(0.15, id_max + 0.10), 3),
        "loudness_dbfs_abs": 4.0,
        "rtf_max": round(max(1.0, measured["rtf"] * 1.5), 2),
    }
    baseline["identity"] = {"anchor": "neutral", "cosine": measured["identity"], "max": round(id_max, 4)}
    baseline["loudness_dbfs"] = measured["loudness_dbfs"]
    baseline["rtf"] = {"batched": measured["rtf"]}
    # blessed_at left for the committer to stamp — the harness has no clock.
    BASELINE_PATH.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")


def test_live_instruct_golden():
    if not _qwen_weights_present():
        pytest.skip("Qwen weights / CUDA absent — run on a box with the 1.7B-Base weights.")

    with tempfile.TemporaryDirectory(prefix="instruct_golden_") as td:
        engine = _make_engine(Path(td) / "voices")
        try:
            measured = _measure(engine)
        finally:
            # Leave the GPU clean for the next golden (mirrors test_qwen3's
            # explicit unload — the idle watchdog doesn't run under pytest).
            try:
                engine.unload_base17()
            except Exception:
                pass

    if os.environ.get("GOLDEN_BLESS") in ("1", "true", "TRUE"):
        _bless(measured)
        pytest.skip("GOLDEN_BLESS set — recorded instruct-baseline.json (not asserting this run).")

    baseline = _load_json(BASELINE_PATH)
    if not baseline.get("identity"):
        pytest.skip(
            "instruct-baseline.json is unblessed. Bless on a GPU box: "
            "npm run test:golden-audio -- --bless --sidecar-only"
        )

    tol = baseline["tolerances"]
    failures: list[str] = []

    # --- Identity stability across instructs ---------------------------------
    id_ceiling = float(tol["identity_cosine_max"])
    for e, dist in measured["identity"].items():
        if dist > id_ceiling:
            failures.append(f"identity[{e}]: cosine {dist:.4f} > {id_ceiling} (voice drifted under instruct)")

    # --- Delivery loudness: directional gain guards (robust to sampling) -----
    L = measured["loudness_dbfs"]
    if "whisper" in L and "neutral" in L and not (L["whisper"] < L["neutral"]):
        failures.append(f"loudness: whisper ({L['whisper']}) not quieter than neutral ({L['neutral']})")
    if "sad" in L and "neutral" in L and not (L["sad"] < L["neutral"]):
        failures.append(f"loudness: sad ({L['sad']}) not quieter than neutral ({L['neutral']})")
    if "angry" in L and "neutral" in L and not (L["angry"] > L["neutral"]):
        failures.append(f"loudness: angry ({L['angry']}) not louder than neutral ({L['neutral']})")

    # --- Delivery loudness: per-emotion drift vs blessed ---------------------
    dbfs_abs = float(tol["loudness_dbfs_abs"])
    base_L = baseline["loudness_dbfs"]
    for e, val in L.items():
        if e in base_L and abs(val - base_L[e]) > dbfs_abs:
            failures.append(f"loudness[{e}]: {val} dBFS drifted > {dbfs_abs} dB from blessed {base_L[e]}")

    # --- Batched RTF baseline ------------------------------------------------
    rtf_max = float(tol["rtf_max"])
    if measured["rtf"] > rtf_max:
        failures.append(f"rtf: batched {measured['rtf']:.3f} > ceiling {rtf_max} (throughput regressed)")

    assert not failures, "Live-instruct golden mismatches:\n  " + "\n  ".join(failures)
