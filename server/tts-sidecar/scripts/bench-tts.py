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

  # side-11 host-leak slope A/B — drive MANY variable-shape batches, sampling
  # /debug/memory after each, and print the committed-private slope (MB/batch).
  # The variable-input-shape host leak (pytorch/pytorch #32596): committed RAM
  # climbs unbounded on variable-length generation but holds flat on fixed
  # shapes, while CUDA stays flat. Run OFF then ON to prove a candidate fix:
  #   python scripts/bench-tts.py --engine qwen --voice <id> --batch 16 \
  #       --mem-sample --batches 200                       # flag OFF baseline
  #   $env:SIDECAR_DISABLE_MKLDNN='1'  # restart sidecar, then re-run identically
  #   PASS iff the ON committed slope is ≈ flat (within ±2 MB/batch) vs a clearly
  #   steeper OFF slope. The seeded corpus makes the two runs byte-identical.

  # side-19 Phase 0 — Code2Wav share of batch wall-time (set QWEN_CODEC_TIMING=1
  # in the sidecar env first, restart it, ensure Qwen 0.6B Base is loaded):
  python scripts/bench-tts.py --engine qwen --voice <designedVoiceId> \
      --code2wav-share --batch 32

Stdlib only (urllib + concurrent.futures) so it runs in any venv. Writes nothing
unless --out <csv> is passed.
"""

from __future__ import annotations

import argparse
import json
import random
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


# Small fixed lexicon for the leak-slope corpus. Real-ish words so the model
# tokenizes/synths normally; the only thing that matters for the leak is that
# each batch ends up a DIFFERENT length (→ a new native per-shape workspace).
_LEXICON = (
    "the lantern guttered throwing long shadows across an empty hall while she "
    "paused at the door and listened to the slow understanding that nothing "
    "about the journey ahead would ever be simple or safe or kind to anyone "
    "who had once believed otherwise beneath the certainty they wore like armour"
).split()


def build_variable_corpus(n: int, seed: int, min_len: int, max_len: int) -> list[str]:
    """Deterministically build `n` sentences whose char lengths are spread
    across [min_len, max_len], so consecutive batches see varied max-lengths
    (the variable-shape condition that drives the host leak). Seeded → byte-
    identical between the flag-OFF and flag-ON runs, which is load-bearing for a
    valid A/B (slope deltas must be signal, not corpus noise)."""
    rng = random.Random(seed)
    out: list[str] = []
    for _ in range(n):
        target = rng.randint(min_len, max_len)
        words: list[str] = []
        length = 0
        while length < target:
            w = rng.choice(_LEXICON)
            words.append(w)
            length += len(w) + 1
        out.append(" ".join(words).capitalize() + ".")
    return out


def _slope_mb_per_batch(xs: list[int], ys: list[float]) -> float:
    """Least-squares slope of ys vs xs (MB per batch). 0.0 for <2 points or a
    degenerate x-spread."""
    if len(xs) < 2:
        return 0.0
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    num = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n))
    return num / denom


def codec_share(decode_ms: float, gen_ms: float) -> float:
    """Code2Wav decode-ms as a fraction of the sidecar's batch forward-compute
    ms — the single number side-19 Phase 0's decision table reads. The
    denominator is the header `genMs` (same sidecar clock domain as decode_ms),
    NOT the HTTP round-trip (R2-A). 0.0 when the batch produced no compute time
    (degenerate / error)."""
    return decode_ms / gen_ms if gen_ms > 0 else 0.0


def sample_memory(server_base: str) -> dict:
    """GET /debug/memory → the process/cuda readout (committed-private + rss +
    cuda alloc/reserved). Returns {} on any error so a transient blip doesn't
    abort a long bench."""
    try:
        with urllib.request.urlopen(f"{server_base}/debug/memory") as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError):
        return {}


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


def run_mem_sample(args, model: str) -> int:
    """side-11 leak-slope mode. Drive `args.batches` variable-shape batched
    /synthesize-batch calls, sampling /debug/memory after each, and report the
    committed-private slope (MB/batch) — the metric the hard-recycle keys on. A
    flat slope (≈ the fixed-shape control) means the leak is bound."""
    if args.engine != "qwen":
        print("--mem-sample is Qwen-only (it drives the /synthesize-batch path).")
        return 2
    batch = args.batch if args.batch >= 1 else 16
    batch_url = args.url.replace("/synthesize", "/synthesize-batch")
    server_base = args.url.rsplit("/", 1)[0]

    corpus = build_variable_corpus(batch * args.batches, args.seed, args.min_len, args.max_len)
    if args.bucket:
        corpus.sort(key=len)  # length-tight batches (the fixed-ish control)
    batches = [corpus[i * batch : (i + 1) * batch] for i in range(args.batches)]
    print(
        f"mem-sample: voice={args.voice} batch={batch} x {args.batches} calls "
        f"len=[{args.min_len},{args.max_len}] seed={args.seed} "
        f"{'bucketed' if args.bucket else 'variable'} -> {batch_url}"
    )

    def commit_of(mem: dict) -> float:
        proc = mem.get("process", {}) if mem else {}
        for key in ("committed_mb", "private_mb", "rss_mb"):
            if key in proc:
                return float(proc[key])
        return 0.0

    series: list[dict] = []
    for i in range(args.batches):
        items = [{"voice": args.voice, "text": t} for t in batches[i]]
        try:
            synth_batch_once(batch_url, args.engine, model, items)
        except urllib.error.HTTPError as e:
            print(f"  batch {i}: HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
            return 1
        except urllib.error.URLError as e:
            print(f"  batch {i}: connection failed: {e}. Is the sidecar at {batch_url}?")
            return 1
        mem = sample_memory(server_base)
        proc = mem.get("process", {})
        cuda = mem.get("cuda", {})
        row = {
            "batch": i + 1,
            "committed_mb": commit_of(mem),
            "rss_mb": float(proc.get("rss_mb", 0.0)),
            "cuda_alloc_mb": float(cuda.get("allocated_mb", 0.0)),
            "cuda_reserved_mb": float(cuda.get("reserved_mb", 0.0)),
        }
        series.append(row)
        if (i + 1) % 10 == 0 or i == 0:
            print(
                f"  batch {row['batch']:>4}: committed={row['committed_mb']:8.0f}MB "
                f"rss={row['rss_mb']:8.0f}MB cuda_resv={row['cuda_reserved_mb']:6.0f}MB"
            )

    if not series:
        print("no samples collected — aborting.")
        return 1

    xs = [r["batch"] for r in series]
    commit_slope = _slope_mb_per_batch(xs, [r["committed_mb"] for r in series])
    rss_slope = _slope_mb_per_batch(xs, [r["rss_mb"] for r in series])
    cuda = [r["cuda_reserved_mb"] for r in series]
    cuda_span = max(cuda) - min(cuda)
    commit_delta = series[-1]["committed_mb"] - series[0]["committed_mb"]
    print(
        f"\nLEAK SLOPE: committed {commit_slope:+.2f} MB/batch "
        f"(rss {rss_slope:+.2f} MB/batch); cuda_reserved span ±{cuda_span:.0f} MB; "
        f"committed start->end {series[0]['committed_mb']:.0f}->{series[-1]['committed_mb']:.0f}MB "
        f"(delta {commit_delta:+.0f}MB over {len(series)} batches)"
    )
    print(
        "  PASS bar: committed slope ~ flat (within +/-2 MB/batch of the --bucket "
        "control) with cuda flat. A steep committed slope + flat cuda = the leak."
    )

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            f.write("batch,committed_mb,rss_mb,cuda_alloc_mb,cuda_reserved_mb\n")
            for r in series:
                f.write(
                    f"{r['batch']},{r['committed_mb']:.1f},{r['rss_mb']:.1f},"
                    f"{r['cuda_alloc_mb']:.1f},{r['cuda_reserved_mb']:.1f}\n"
                )
        print(f"  wrote series -> {args.out}")
    return 0


def run_code2wav_share(args, model: str) -> int:
    """side-19 Phase 0 mode: measure the Code2Wav codec decode share of batch
    forward-compute time. Drives a 32-item batch of high-variance sentences
    (cycled from HIGH_VARIANCE_SENTENCES) and reports the codec share + count."""
    if args.engine != "qwen":
        print("--code2wav-share is Qwen-only (it drives the /synthesize-batch path).")
        return 2

    batch_size = 32
    batch_url = args.url.replace("/synthesize", "/synthesize-batch")
    server_base = args.url.rsplit("/", 1)[0]

    # Reset the codec timing counters
    try:
        reset_req = urllib.request.Request(
            f"{server_base}/debug/codec-timing/reset",
            data=b"",
            headers={"Content-Type": "application/json"},
        )
        reset_req.get_method = lambda: "POST"
        with urllib.request.urlopen(reset_req) as resp:
            resp.read()
    except urllib.error.URLError as e:
        print(f"Failed to reset codec timing: {e}. Is the sidecar at {server_base}?")
        return 1

    # Build a batch of 32 items by cycling HIGH_VARIANCE_SENTENCES
    batch_items = [
        {"voice": args.voice, "text": HIGH_VARIANCE_SENTENCES[i % len(HIGH_VARIANCE_SENTENCES)]}
        for i in range(batch_size)
    ]

    # Run the batch
    print(f"code2wav-share: engine={args.engine} model={model} voice={args.voice} "
          f"batch={batch_size} url={batch_url}")
    try:
        wall_s, audio_s, rtf, gen_ms, audio_ms = synth_batch_once(batch_url, args.engine, model, batch_items)
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        return 1
    except urllib.error.URLError as e:
        print(f"  connection failed: {e}. Is the sidecar running at {batch_url}?")
        return 1

    # Read the codec timing snapshot
    try:
        with urllib.request.urlopen(f"{server_base}/debug/codec-timing") as resp:
            snap = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"Failed to read codec timing: {e}")
        return 1

    decode_ms = snap.get("total_ms", 0.0)
    calls = snap.get("calls", 0)
    share = codec_share(decode_ms, gen_ms)

    # Print the result
    print(f"code2wav share: {share:.1%}  (decode {decode_ms:.0f} ms / forward {gen_ms:.0f} ms, {calls} decode calls)")
    if calls == 0:
        print("INVALID: 0 decode calls captured — see Task 3 M1.")

    return 0


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
    p.add_argument(
        "--mem-sample", action="store_true",
        help="side-11 leak mode: drive --batches variable-shape batched calls, "
        "sampling GET /debug/memory after each, and print the committed-private "
        "slope (MB/batch). Implies --batch (defaults to 16 if unset). Run with "
        "SIDECAR_DISABLE_MKLDNN off then on to A/B a candidate fix.",
    )
    p.add_argument(
        "--code2wav-share", action="store_true",
        help="side-19 Phase 0 mode: measure the Code2Wav codec decode share of batch "
        "forward-compute time. Requires QWEN_CODEC_TIMING=1 in the sidecar env. "
        "Drives a --batch 32 batch of high-variance sentences and reports the codec "
        "share + decode-call count.",
    )
    p.add_argument(
        "--batches", type=int, default=200,
        help="--mem-sample mode: number of batched calls to drive (default 200 "
        "≈ 3200 synths at --batch 16, matching the original leak experiment).",
    )
    p.add_argument(
        "--seed", type=int, default=1234,
        help="--mem-sample corpus seed (default 1234). Keep identical across the "
        "OFF/ON A/B runs so the two slopes are comparable.",
    )
    p.add_argument("--min-len", type=int, default=10, help="--mem-sample: min sentence chars (default 10).")
    p.add_argument("--max-len", type=int, default=300, help="--mem-sample: max sentence chars (default 300).")
    p.add_argument(
        "--out", default=None,
        help="--mem-sample: optional CSV path for the per-batch series (the ONLY "
        "file this script writes; omitted = stdout only).",
    )
    args = p.parse_args(argv)

    model = args.model or DEFAULT_MODELS[args.engine]

    # ── side-19 Phase 0 Code2Wav share mode ────────────────────────────────
    if args.code2wav_share:
        return run_code2wav_share(args, model)

    # ── side-11 leak-slope mode: many variable-shape batches, sample memory ──
    if args.mem_sample:
        return run_mem_sample(args, model)

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
