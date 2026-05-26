#!/usr/bin/env python3
"""Micro-benchmark for the TTS sidecar /synthesize route.

Measures per-call wall time and real-time factor (RTF = gen-time ÷
audio-seconds; <1 is faster-than-realtime) for one engine, so the
Kokoro-vs-Qwen gap is a measured number rather than a felt one. Also
answers "does more concurrency help?" empirically: --concurrency N fires
the workload through an N-wide thread pool and reports aggregate
throughput, which on a single GPU + single autoregressive model plateaus
fast (see docs/features/112-qwen-synth-quick-wins.md).

NOT wired into CI — it needs the heavy weights resident in a running
sidecar. Run it by hand against a live sidecar:

  # baseline (force eager attention), Qwen, one designed voice, serial:
  #   QWEN_ATTN_IMPL=eager  in the sidecar env, then restart it, then:
  python scripts/bench-tts.py --engine qwen --voice <designedVoiceId>

  # after (default SDPA + prompt cache), and a concurrency sweep:
  python scripts/bench-tts.py --engine qwen --voice <designedVoiceId>
  python scripts/bench-tts.py --engine qwen --voice <id> --concurrency 2
  python scripts/bench-tts.py --engine qwen --voice <id> --concurrency 4

  # Kokoro reference point:
  python scripts/bench-tts.py --engine kokoro --voice af_heart

Stdlib only (urllib + concurrent.futures) so it runs in any venv.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Representative audiobook prose — a short clause, a medium line, and a
# longer multi-clause sentence so RTF isn't skewed by a single length.
DEFAULT_SENTENCES = [
    "He paused at the door.",
    "The lantern guttered, throwing long shadows across the empty hall.",
    "She had always known, somewhere beneath the certainty she wore like "
    "armour, that the answer would cost her more than she wanted to pay.",
    "\"Run,\" he whispered, and the word was the last thing she heard "
    "before the floor gave way.",
    "Morning came grey and reluctant, and with it the slow understanding "
    "that nothing about the journey ahead would be simple.",
]

# Default sidecar model key per engine (matches canonicalModelKeyForEngine
# in server/src/routes/generation.ts). Override with --model.
DEFAULT_MODELS = {
    "kokoro": "kokoro-v1",
    "qwen": "qwen3-tts-0.6b",
    "coqui": "coqui-xtts-v2",
}


def synth_once(url: str, engine: str, model: str, voice: str, text: str):
    """POST one /synthesize call. Returns (wall_s, audio_s, rtf)."""
    payload = json.dumps(
        {"engine": engine, "model": model, "voice": voice, "text": text}
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        pcm = resp.read()
        rate = int(resp.headers.get("X-Sample-Rate", "24000"))
    wall_s = time.perf_counter() - t0
    # 16-bit signed LE mono → 2 bytes/sample.
    audio_s = (len(pcm) / 2) / rate if rate > 0 else 0.0
    rtf = wall_s / audio_s if audio_s > 0 else 0.0
    return wall_s, audio_s, rtf


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", required=True, choices=sorted(DEFAULT_MODELS))
    p.add_argument(
        "--voice",
        required=True,
        help="kokoro: an English voice id (e.g. af_heart); "
        "qwen: a designed voiceId (design it first).",
    )
    p.add_argument("--model", default=None, help="override the sidecar model key")
    p.add_argument("--url", default="http://127.0.0.1:9000/synthesize")
    p.add_argument(
        "--repeat", type=int, default=2,
        help="times to run the sentence set (default 2; first run warms caches)",
    )
    p.add_argument(
        "--concurrency", type=int, default=1,
        help="parallel in-flight requests (default 1 = serial). Use 2/4 to "
        "measure whether more workers help — the global GPU semaphore "
        "(GPU_VRAM_BUDGET) still caps real concurrency.",
    )
    args = p.parse_args(argv)

    model = args.model or DEFAULT_MODELS[args.engine]
    jobs = [s for _ in range(args.repeat) for s in DEFAULT_SENTENCES]
    print(
        f"bench: engine={args.engine} model={model} voice={args.voice} "
        f"sentences={len(DEFAULT_SENTENCES)} repeat={args.repeat} "
        f"concurrency={args.concurrency} url={args.url}"
    )

    def run(text: str):
        try:
            return synth_once(args.url, args.engine, model, args.voice, text)
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
            return None
        except urllib.error.URLError as e:
            print(f"  connection failed: {e}. Is the sidecar running at {args.url}?")
            return None

    wall0 = time.perf_counter()
    if args.concurrency <= 1:
        results = [run(t) for t in jobs]
    else:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            results = list(pool.map(run, jobs))
    total_wall = time.perf_counter() - wall0

    ok = [r for r in results if r is not None]
    if not ok:
        print("no successful calls — aborting.")
        return 1

    rtfs = [r[2] for r in ok]
    per_call_walls = [r[0] for r in ok]
    total_audio = sum(r[1] for r in ok)
    print(
        f"\n  calls={len(ok)}/{len(jobs)}  "
        f"per-call wall: mean={statistics.mean(per_call_walls):.2f}s "
        f"median={statistics.median(per_call_walls):.2f}s"
    )
    print(
        f"  RTF: mean={statistics.mean(rtfs):.2f} "
        f"median={statistics.median(rtfs):.2f} "
        f"min={min(rtfs):.2f} max={max(rtfs):.2f}"
    )
    # Aggregate throughput = audio produced ÷ wall time. This is the number
    # that should rise if concurrency genuinely helps; if it stays flat from
    # --concurrency 1 → 2 → 4, the GPU is already the bottleneck.
    print(
        f"  throughput: {total_audio:.1f}s audio in {total_wall:.1f}s wall "
        f"= {total_audio / total_wall:.2f}x realtime aggregate"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
