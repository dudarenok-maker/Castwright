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

  # length-bucketing A/B (plan 128) — same sentences, batch composition differs:
  python scripts/bench-tts.py --engine qwen --voice <id> --batch 16 --bucket 0
  python scripts/bench-tts.py --engine qwen --voice <id> --batch 16 --bucket 1
  #   compare the "sidecar compute RTF" lines; bucket 1 should be lower.

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

# High-variance prose for the length-bucketing benchmark (plan 128): a wide
# spread from one-word beats to long multi-clause sentences. A batched forward
# decodes for as many steps as its LONGEST item, so mixing these in one batch
# wastes most of the decode padding the short ones. --bucket 1 sorts the pool
# by length before slicing (similar lengths share a batch → tight max-length);
# --bucket 0 interleaves short/long for the worst-case spread. Same sentences
# either way, so the only variable is batch composition.
HIGH_VARIANCE_SENTENCES = [
    "Yes.",
    "No.",
    "Run!",
    "Wait.",
    "She stopped.",
    "He looked back once.",
    "The corridor was longer than she remembered.",
    "Somewhere below, a door closed with a sound like a held breath.",
    "He had spent the better part of a decade learning to ignore exactly "
    "the kind of warning his instincts were now screaming at him.",
    "She had always known, somewhere beneath the certainty she wore like "
    "armour, that the answer would cost her far more than she had ever once "
    "been willing to admit she might be prepared to pay.",
    "The map was wrong in a dozen small ways, each one survivable on its "
    "own, but together they added up to a route that led somewhere no one "
    "in the expedition had ever intended, or wanted, to go.",
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


def synth_batch_once(url: str, engine: str, model: str, items: list[dict]):
    """POST one /synthesize-batch call (N items in ONE batched forward — the
    real Qwen production path). Parses the length-prefixed binary frame
    (`{"sampleRate","lengths","genMs","audioMs"}\\n<pcm…>`).

    Returns (wall_s, audio_s, rtf, gen_ms, audio_ms): `rtf` is the END-TO-END
    HTTP wall ÷ produced audio; `gen_ms`/`audio_ms` are the sidecar's own
    forward-compute timing from the frame header, so `gen_ms/audio_ms` is the
    PURE-COMPUTE RTF (no HTTP / queue / dispatch-gap overhead) for comparison."""
    payload = json.dumps({"engine": engine, "model": model, "items": items}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        frame = resp.read()
    wall_s = time.perf_counter() - t0
    nl = frame.index(b"\n")
    header = json.loads(frame[:nl].decode("utf-8"))
    rate = int(header.get("sampleRate", 24000))
    lengths = header.get("lengths", [])
    audio_s = (sum(lengths) / 2) / rate if rate > 0 else 0.0
    rtf = wall_s / audio_s if audio_s > 0 else 0.0
    return wall_s, audio_s, rtf, float(header.get("genMs", 0.0)), float(header.get("audioMs", 0.0))


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
        "(GPU_VRAM_BUDGET) still caps real concurrency. In --batch mode this "
        "is the number of concurrent /synthesize-batch calls = the queue's "
        "`generationWorkers` analogue (post-thread-safety-fix the Qwen forward "
        "serialises, so >1 should NOT raise aggregate throughput — that's the "
        "test).",
    )
    p.add_argument(
        "--batch", type=int, default=0,
        help="Qwen ONLY: items per /synthesize-batch call (the real production "
        "path). 0 (default) = single /synthesize mode. e.g. --batch 8 / 16 to "
        "sweep QWEN_BATCH_SIZE. Draws from the high-variance pool and slices it "
        "into --repeat batches (see --bucket).",
    )
    p.add_argument(
        "--bucket", type=int, default=0, choices=(0, 1),
        help="Qwen --batch mode ONLY (plan 128 length-bucketing): 0 (default) "
        "interleaves short/long sentences for the worst-case per-batch length "
        "spread; 1 sorts the pool by length before slicing so each batch is "
        "length-tight. Run both and compare the sidecar compute RTF — the gap "
        "is the padding waste bucketing removes. Mirrors QWEN_BATCH_BUCKET.",
    )
    args = p.parse_args(argv)

    model = args.model or DEFAULT_MODELS[args.engine]
    jobs = [s for _ in range(args.repeat) for s in DEFAULT_SENTENCES]
    print(
        f"bench: engine={args.engine} model={model} voice={args.voice} "
        f"sentences={len(DEFAULT_SENTENCES)} repeat={args.repeat} "
        f"concurrency={args.concurrency} batch={args.batch} bucket={args.bucket} "
        f"url={args.url}"
    )

    # ── batch mode: the real Qwen production path (/synthesize-batch) ─────────
    if args.batch >= 1:
        batch_url = args.url.replace("/synthesize", "/synthesize-batch")
        ncalls = args.repeat  # in batch mode --repeat = number of batched calls

        # Build a pool of `batch * ncalls` high-variance sentences, then order
        # it per --bucket and slice into `ncalls` batches of `batch` items.
        total = args.batch * ncalls
        sentence_pool = [
            HIGH_VARIANCE_SENTENCES[i % len(HIGH_VARIANCE_SENTENCES)] for i in range(total)
        ]
        if args.bucket:
            # Bucketed: similar lengths adjacent → each contiguous slice is tight.
            sentence_pool.sort(key=len)
        else:
            # Anti-bucketed: interleave shortest/longest so every slice straddles
            # the full length range (the worst case bucketing fixes).
            by_len = sorted(sentence_pool, key=len)
            lo, hi = 0, len(by_len) - 1
            woven = []
            while lo <= hi:
                woven.append(by_len[lo])
                lo += 1
                if lo <= hi:
                    woven.append(by_len[hi])
                    hi -= 1
            sentence_pool = woven
        batches = [sentence_pool[i * args.batch : (i + 1) * args.batch] for i in range(ncalls)]
        spreads = [max(map(len, b)) - min(map(len, b)) for b in batches]
        print(f"  batch: {args.batch} items/call x {ncalls} call(s) -> {batch_url}")
        print(
            f"  per-batch char-length spread (max-min): "
            f"mean={statistics.mean(spreads):.0f} min={min(spreads)} max={max(spreads)} "
            f"({'bucketed' if args.bucket else 'interleaved'})"
        )

        def run_batch(i: int):
            items = [{"voice": args.voice, "text": t} for t in batches[i]]
            try:
                return synth_batch_once(batch_url, args.engine, model, items)
            except urllib.error.HTTPError as e:
                print(f"  HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
                return None
            except urllib.error.URLError as e:
                print(f"  connection failed: {e}. Is the sidecar running at {batch_url}?")
                return None

        wall0 = time.perf_counter()
        if args.concurrency <= 1:
            results = [run_batch(i) for i in range(ncalls)]
        else:
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                results = list(pool.map(run_batch, range(ncalls)))
        total_wall = time.perf_counter() - wall0

        ok = [r for r in results if r is not None]
        if not ok:
            print("no successful batch calls — aborting.")
            return 1
        e2e = [r[2] for r in ok]
        walls = [r[0] for r in ok]
        total_audio = sum(r[1] for r in ok)
        gen_ms = sum(r[3] for r in ok)
        aud_ms = sum(r[4] for r in ok)
        compute_rtf = (gen_ms / aud_ms) if aud_ms > 0 else 0.0
        print(
            f"\n  batched calls={len(ok)}/{ncalls}  items/call={args.batch}  "
            f"per-call wall: mean={statistics.mean(walls):.1f}s median={statistics.median(walls):.1f}s"
        )
        print(
            f"  end-to-end RTF (wall/audio): mean={statistics.mean(e2e):.2f} "
            f"median={statistics.median(e2e):.2f} min={min(e2e):.2f} max={max(e2e):.2f}"
        )
        print(f"  sidecar compute RTF (sum-genMs/sum-audioMs): {compute_rtf:.2f}")
        print(
            f"  throughput: {total_audio:.1f}s audio in {total_wall:.1f}s wall "
            f"= {total_audio / total_wall:.2f}x realtime aggregate (concurrency={args.concurrency})"
        )
        return 0

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
