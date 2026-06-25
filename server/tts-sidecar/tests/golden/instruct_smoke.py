"""Committed reproducible smoke: 1.7B-Base free-text instruct + codec-compat.

Run:
    server/tts-sidecar/.venv/Scripts/python.exe \
        server/tts-sidecar/tests/golden/instruct_smoke.py

When weights are ABSENT (no qwen_tts / torch / CUDA) this script prints a
SKIP banner and exits 0. When weights are present it:

  1. Decodes a designed voice's ref_code on the 1.7B-Base (codec-compat proof
     that a .pt designed on the 0.6B-Base decodes cleanly on the larger model).
  2. Re-builds a 1.7B ICL clone prompt from the decoded clip.
  3. Synthesises the same line under three emotion variants via free-text
     `instruct_ids` passed to `generate_voice_clone`:
       - neutral  (no instruct)
       - angry    ("Delivered angrily, with raised intensity and edge.")
       - whisper  ("Delivered in a soft, hushed whisper.")
  4. Writes output WAVs under a timestamped sub-dir of /tmp (or %TEMP%).
  5. Prints ECAPA cosine distance(neutral, variant) for each emotion —
     the operator's signal that identity holds while emotion varies.

The script is SELF-CONTAINED: it does not import QwenEngine or any helper
from main.py. Only stdlib is needed for the SKIP path; GPU libs load only
after the gate check passes.

fs-55 Task 0 — R2-C1 reproducible replacement for the deleted spike.
"""
from __future__ import annotations

import sys
import os
import tempfile
import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# SKIP gate — must work with stdlib only so CI venvs always exit 0 cleanly.
# ---------------------------------------------------------------------------

SIDECAR_ROOT = Path(__file__).resolve().parents[2]  # server/tts-sidecar


def _qwen_weights_present() -> bool:
    """Mirror of conftest._qwen_weights_present — inlined so the script needs
    no pytest import at the top level."""
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False


if not _qwen_weights_present():
    print(
        "[instruct_smoke] SKIP - qwen_tts or torch not importable, "
        "or no CUDA device. Run on a box with Qwen3-TTS weights installed.",
        flush=True,
    )
    sys.exit(0)

# ---------------------------------------------------------------------------
# Past the gate: GPU + qwen_tts are available.
# ---------------------------------------------------------------------------

import numpy as np
import soundfile as sf
import torch

# Add sidecar root to path so 'import qwen_tts' resolves the installed lib.
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from qwen_tts import Qwen3TTSModel  # type: ignore[import]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The 1.7B-Base is the model under test (the 0.6B-Base is the production
# resident; the 1.7B-Base carries the same codec so codes are cross-compatible,
# and it supports free-text instruct — the property this smoke proves).
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"

# Designed voice .pt to reuse (must be produced by design_voice with 0.6B-Base).
# Using the narrator voice from The Coalfall Commission sample set.
VOICE_PT = (
    Path(__file__).resolve().parents[4]
    / "samples"
    / "the-coalfall-commission"
    / "voices"
    / "qwen"
    / "qwen-8434989a52184d08be265.pt"
)
# Ref text stored in the voice manifest (same text used at design time).
REF_TEXT = (
    "The quick brown fox jumps over the lazy dog, "
    "and she wondered what tomorrow would bring."
)

# Line to synthesise under each emotion variant.
SYNTH_TEXT = (
    "The harbor fell silent as the fog rolled in, swallowing the last of the "
    "lanterns one by one."
)
LANGUAGE = "English"

# Production instruct phrases (mirror the server's emotionToInstruct,
# server/src/tts/emotion-instruct.ts) so this golden reflects what generation
# actually sends on the live-instruct path.
INSTRUCTS: dict[str, str | None] = {
    "neutral": None,
    "whisper": "in a soft, breathy whisper",
    "angry": "in an angry, raised voice",
    "excited": "with bright, energetic excitement",
    "sad": "in a subdued, downcast tone",
}

# Per-emotion output gain on the live-instruct path (mirrors main.py
# _LIVE_INSTRUCT_GAIN -- the loudness lever: whisper quiet, angry loud).
_LIVE_INSTRUCT_GAIN: dict[str, float] = {"whisper": 0.35, "angry": 1.7, "sad": 0.6, "excited": 1.15}

# ---------------------------------------------------------------------------
# Inline cosine distance helper (no scipy / sklearn needed).
# ---------------------------------------------------------------------------

def cosine_distance(a: "torch.Tensor", b: "torch.Tensor") -> float:
    """1 - cos_similarity, so 0 = identical, 2 = opposite.
    Both tensors are 1-D speaker embeddings."""
    a_f = a.detach().float().cpu()
    b_f = b.detach().float().cpu()
    cos = torch.nn.functional.cosine_similarity(a_f.unsqueeze(0), b_f.unsqueeze(0))
    return float(1.0 - cos.item())


# ---------------------------------------------------------------------------
# Main smoke procedure
# ---------------------------------------------------------------------------

def run_smoke() -> None:
    out_dir = (
        Path(tempfile.gettempdir())
        / f"instruct_smoke_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[instruct_smoke] Output WAVs -> {out_dir}", flush=True)

    # 1. Load the 1.7B-Base model.
    print(f"[instruct_smoke] Loading {MODEL_ID} ...", flush=True)
    model = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=False,
    )
    # Move inner module to CUDA and resync the wrapper's device cache (same
    # pattern as QwenEngine._load_qwen_model in main.py).
    device = "cuda"
    inner = getattr(model, "model", None)
    if inner is not None and hasattr(inner, "to"):
        inner.to(device)
    else:
        model.to(device)
    try:
        model.device = torch.device(device)
    except Exception:
        pass
    print(f"[instruct_smoke] Model loaded on {model.device}", flush=True)

    # 2. Load the designed voice .pt (weights_only=False — trusted local file).
    if not VOICE_PT.is_file():
        print(
            f"[instruct_smoke] ERROR: voice .pt not found at {VOICE_PT}\n"
            "Run design_voice via POST /qwen/design-voice first.",
            flush=True,
        )
        sys.exit(1)
    prompt_items = torch.load(str(VOICE_PT), weights_only=False)
    # The .pt stores a list[VoiceClonePromptItem] (length 1 per design_voice).
    if not isinstance(prompt_items, list):
        prompt_items = [prompt_items]
    item = prompt_items[0]
    print(
        f"[instruct_smoke] Loaded voice .pt: ref_code shape={item.ref_code.shape}",
        flush=True,
    )

    # 3. Codec-compat proof: decode the 0.6B-designed ref_code on the 1.7B codec.
    print("[instruct_smoke] Decoding ref_code via 1.7B speech_tokenizer ...", flush=True)
    ref_wavs, ref_sr = model.model.speech_tokenizer.decode(
        [{"audio_codes": item.ref_code}]
    )
    ref_audio_np = ref_wavs[0]  # float32 numpy, shape (T,)
    codec_wav_path = out_dir / "ref_decoded.wav"
    sf.write(str(codec_wav_path), ref_audio_np, ref_sr)
    print(
        f"[instruct_smoke] Codec-compat OK - decoded {len(ref_audio_np)/ref_sr:.2f}s "
        f"@ {ref_sr} Hz -> {codec_wav_path}",
        flush=True,
    )

    # 4. Re-derive 1.7B ICL clone prompt from the decoded ref clip.
    #    We resample to the model's expected sr (24kHz) if needed.
    print("[instruct_smoke] Building 1.7B ICL clone prompt from decoded clip ...", flush=True)
    target_sr = 24000
    if ref_sr != target_sr:
        import librosa  # type: ignore[import]
        ref_audio_24k = librosa.resample(
            ref_audio_np.astype(np.float32), orig_sr=ref_sr, target_sr=target_sr
        )
    else:
        ref_audio_24k = ref_audio_np.astype(np.float32)

    prompt_1_7b = model.create_voice_clone_prompt(
        ref_audio=(ref_audio_24k, target_sr),
        ref_text=REF_TEXT,
    )
    print("[instruct_smoke] 1.7B clone prompt ready.", flush=True)

    # 5. Extract speaker embedding from the base (neutral) clip for ECAPA distance.
    spk_sr = model.model.speaker_encoder_sample_rate  # typically 24000
    if ref_sr != spk_sr:
        import librosa as _librosa  # type: ignore[import]
        ref_for_spk = _librosa.resample(
            ref_audio_np.astype(np.float32), orig_sr=ref_sr, target_sr=spk_sr
        )
    else:
        ref_for_spk = ref_audio_np.astype(np.float32)

    with torch.inference_mode():
        base_emb = model.model.extract_speaker_embedding(
            audio=ref_for_spk, sr=spk_sr
        )
    print("[instruct_smoke] Base speaker embedding extracted.", flush=True)

    # 6. Synthesise under each emotion variant.
    results: dict[str, dict] = {}
    for emotion, instruct_text in INSTRUCTS.items():
        print(f"[instruct_smoke] Synthesising emotion={emotion!r} ...", flush=True)

        # PRODUCTION PATH: raw m.generate (the _icl_instruct_synth bypass) at the
        # production instruct temperatures, then the per-emotion output gain.
        # Mirrors QwenEngine._icl_instruct_synth + _LIVE_INSTRUCT_GAIN in main.py
        # (the old generate_voice_clone-at-default-temp path under-applied emotion).
        m = model.model
        items_1_7b = prompt_1_7b if isinstance(prompt_1_7b, list) else [prompt_1_7b]
        vcp = model._prompt_items_to_voice_clone_prompt(items_1_7b)
        input_ids = model._tokenize_texts([model._build_assistant_text(SYNTH_TEXT)])
        ref_ids = [model._tokenize_texts([model._build_ref_text(REF_TEXT)])[0]]
        instruct_ids = model._tokenize_texts([model._build_instruct_text(instruct_text or "")])
        gk = model._merge_generate_kwargs()
        gk["temperature"] = 1.6
        gk["subtalker_temperature"] = 1.8
        gk["top_p"] = 0.90
        with torch.no_grad():
            codes, _ = m.generate(
                input_ids=input_ids, ref_ids=ref_ids, instruct_ids=instruct_ids,
                voice_clone_prompt=vcp, languages=[LANGUAGE],
                non_streaming_mode=True, **gk,
            )
        rcl = vcp.get("ref_code")
        if rcl and rcl[0] is not None and hasattr(codes[0], "shape"):
            cfd = [torch.cat([rcl[i].to(c.device), c], dim=0) for i, c in enumerate(codes)]
        else:
            cfd = codes
        wavs, sr = m.speech_tokenizer.decode([{"audio_codes": c} for c in cfd])
        wav_np = np.asarray(wavs[0], dtype=np.float32)
        if rcl and rcl[0] is not None and hasattr(cfd[0], "shape"):
            total = max(int(cfd[0].shape[0]), 1)
            ref_len = int(rcl[0].shape[0])
            wav_np = wav_np[int(ref_len / total * wav_np.shape[0]):]
        # Per-emotion output gain (the loudness lever; mirrors _LIVE_INSTRUCT_GAIN).
        wav_np = np.clip(wav_np * _LIVE_INSTRUCT_GAIN.get(emotion, 1.0), -1.0, 1.0)

        wav_path = out_dir / f"{emotion}.wav"
        sf.write(str(wav_path), wav_np, sr)

        # ECAPA distance against the neutral reference clip.
        wav_for_spk = wav_np.astype(np.float32)
        if sr != spk_sr:
            import librosa as _librosa  # type: ignore[import]
            wav_for_spk = _librosa.resample(wav_for_spk, orig_sr=sr, target_sr=spk_sr)

        with torch.inference_mode():
            var_emb = model.model.extract_speaker_embedding(
                audio=wav_for_spk, sr=spk_sr
            )

        dist = cosine_distance(base_emb, var_emb)
        results[emotion] = {"wav": wav_path, "dist": dist, "sr": sr}
        print(
            f"  [{emotion}] cosine_distance(neutral_ref, {emotion}) = {dist:.4f}  "
            f"-> {wav_path}",
            flush=True,
        )

    # 7. Summary.
    print("\n[instruct_smoke] -- ECAPA speaker distances --", flush=True)
    for emotion, res in results.items():
        print(f"  {emotion:10s}: {res['dist']:.4f}", flush=True)
    print(
        "\nCodec-compat: PASS (ref_code decoded cleanly on 1.7B codec)\n"
        "Instruct:     see WAVs above — listen to confirm emotion audible\n"
        f"Output dir:   {out_dir}",
        flush=True,
    )


if __name__ == "__main__":
    run_smoke()
