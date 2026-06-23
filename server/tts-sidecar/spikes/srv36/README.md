# srv-36 Phase-0 Stochastic Spike

## Setup

Install speechbrain:

```bash
pip install speechbrain
```

Note: The fixture's designed Qwen/Coqui voices must be in the workspace for testing.

## ECAPA-TDNN Embedding Wrapper

The `embed.py` module provides:

- `load_encoder()` — cached loader for speechbrain ECAPA-TDNN encoder
- `embed_pcm(pcm: bytes, sample_rate: int) -> np.ndarray` — embeds PCM audio into a 192-dim L2-normalised vector

## Test (pure helpers — run anywhere)

```bash
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v
```

Expected: all pure tests PASS; `test_embed.py` PASS (speechbrain installed) or SKIP (not).

## On-box runbook (Tasks 8–9 — needs a GPU box)

Prereqs: GPU box, sidecar venv + `pip install speechbrain`, `ffmpeg` on PATH, and
the fixture book's **designed Qwen/Coqui voices** present in the workspace.

**1. Over-generate the fixture with the real gates ON (Task 8 — the F2 harvest).**
Drift is rare, so do **M = 30–50** runs. There is no one-command harness;
generation is `POST /api/books/:bookId/generation`. Start the server with
`SEG_ASR_ENABLED=1` (audio-QA is on by default), set `BOOK=<fixture id>`, then:

```bash
for i in $(seq 1 30); do
  curl -fsS -X POST "http://localhost:8080/api/books/$BOOK/generation" \
    -H 'content-type: application/json' -d '{"chapters":"all"}'
  # wait for generation to finish (poll book-state / watch scripts/monitor-generation.mjs)
  mkdir -p server/tts-sidecar/spikes/srv36/results/runs/$i
  cp "$WORKSPACE/$BOOK/.audiobook/"*.segments.json     server/tts-sidecar/spikes/srv36/results/runs/$i/
  cp "$WORKSPACE/$BOOK/.audiobook/audio/"*.mp3          server/tts-sidecar/spikes/srv36/results/runs/$i/
done
```
Copy artifacts out BETWEEN runs (each regen overwrites in place). Adjust the curl
body / workspace paths to the box's real route + layout. Confirm some segments
carry `asr.verdict=="drift"` / `suspect`; if zero, raise M.

**2. Analyze (Task 7 driver — F1/F3/F5 + the F4 listen-set).**
```bash
cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.analyze
```
Writes `results/f1.json`, `f3.json`, `f5.json`, `f4_pending.json`, and
`results/f4_listen/*.pcm` (the lines ECAPA flagged that ASR + audio-QA did NOT).

**3. F4 human confirm (the decisive gate — Task 9).**
Listen to each `results/f4_listen/*.pcm`. Count how many are *actually* drifted
voice (real residual value) vs false positives. Write `results/f4.json`:
```json
{ "residual_fraction": <confirmed_real / total_acoustic_flagged>, "confirmed_real": <N> }
```
(`total_acoustic_flagged` is in `f4_pending.json`.) Note the metric's exact
meaning: **fraction of ALL acoustic flags that are human-confirmed real drift** —
not purely "drift the gates missed." Phrase FINDINGS accordingly.

**4. Findings + recommendation.**
```bash
cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.synthesize
```
Writes `FINDINGS.md` with the `{go|no-go}` recommendation. **go** iff F1 floor
tight AND F3 separable AND F4 residual ≥ 0.15 AND F5 coverage ≥ 0.50. An empty /
all-false-positive F4 set is a valid **no-go** (acoustic adds nothing over the
existing gates) — record it; do not fabricate positives.

**5. Act (spec §2.2 / §8).** no-go → close #665 wont-fix-acoustic, mark the spec
superseded, confirm fs-51 unaffected. go → open the Phase-1 plan seeded by the
measured floor / EER / K / coverage; re-file #665 `type:chore → type:feature`.

Caveats to state in FINDINGS: F3 EER is in-sample; `FLOOR_SEC=2.0` is fixed (F5
reports variance, doesn't feed back); thin/absent centroids for often-drifting
characters show up as `K_per_char` in `f1.json`.

## Phase-2 per-gate result schema

Each `--gN` measurement writer must emit `spikes/srv36/results/crossbook_gN.json`
with at least the following keys (enforced by `malformed_gates()` in `crossbook.py`).
A file present but missing these keys produces a silent safe-fail default in
`assemble_measured` — the `--report` command now warns on stderr when this happens.

| Gate | File | Required key(s) |
|------|------|-----------------|
| G1 | `crossbook_g1.json` | `genuine_drift_stds` |
| G2 | `crossbook_g2.json` | `central` |
| G3 | `crossbook_g3.json` | `emotion_shift` |
| G4 | `crossbook_g4.json` | `wander_slope`, `residual_fraction` |
| G5 | `crossbook_g5.json` | `fp_rate` |
| G6 | `crossbook_g6.json` | `separation_auc` |

**G2 gotcha:** the `seed_divergence()` helper returns `{"central": ..., "spread": ...}`
and the evaluator key is `g2_divergence` — but the result file key is `central`
(NOT `divergence`). The `--g2` writer must emit `{"central": ..., "spread": ...}`.

## Phase-2 operator run order (on the GPU box)

The `--gN` writers (`crossbook_measure.py`, wired into `crossbook_run.py`) are
implemented — run them in this order from the sidecar root (`server/tts-sidecar`),
with `<BOOKS_ROOT>` pointing at the re-rendered Keeper library:

1. **Re-render** 2 Keeper books through the app (`SEG_SPK_ENABLED=1`) so recurring
   characters carry a `voiceUuid` (series-reuse).
2. **`python -m spikes.srv36.crossbook_run <BOOKS_ROOT>`** — inventory; confirm
   Keeper shows ≥2 books with a recurring `voiceUuid` key (kind `voiceUuid`).
2b. **`… crossbook_run <BOOKS_ROOT> --counts [target]`** (GPU-free, no embed) —
   clean ≥3 s dialogue-segment counts per recurring `voiceUuid` per book, flagged
   `OK`/`THIN` vs `target` (default 20). **Sizing tool: you do NOT need all
   chapters.** Render a bounded matched subset (~5–8 chapters/book to start),
   run `--counts`, and render more only for characters flagged `THIN` (or if no
   keys recur — then re-render the SAME characters in both books).
3. **G0** (needs the live sidecar): prepare `results/g0_keys_cfg.json` =
   `{"<voiceUuid>": {"text": "<audition text>", "voice": "qwen-<voiceUuid>"}}` —
   *confirm the audition-text source + `/synthesize` contract on-box* — then
   `… crossbook_run <BOOKS_ROOT> --g0`. Writes `crossbook_g0.json` (the floor std
   G1 divides by) + `crossbook_audition_centroids.json` (reused by G2).
4. **`--g1`**, **`--g2`**, **`--g6`**, **`--g4`**, **`--g3`** (g3 is a documented
   stub — emotion isn't on-disk; needs a manuscript-emotion join).
5. **G5**: build the blind set from G1/G6 low-cosine candidates + matched controls
   via `blind_listen.build_blind_set` + `extract_listen.extract_clip`, listen blind,
   then `score_blind` → write `crossbook_g5.json` (`{"fp_rate": …}`).
6. **`--report`** → per-axis `{go|no-go}`; copy the numbers into the FINDINGS
   Phase-2 section (the raw `results/*.json` are git-ignored / machine-specific).

The pure scoring is unit-tested (`test_crossbook.py`); this measurement layer is
operator-run (ffmpeg + weights + sidecar) and validated end-to-end on a no-audio
fixture (walk + collect + runners + report), not against real renders.
