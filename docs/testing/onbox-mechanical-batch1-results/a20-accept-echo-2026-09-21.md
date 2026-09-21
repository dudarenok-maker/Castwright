# A20 evidence — accept-path echo, three bless runs, 2026-09-21

Agent: `cline-qwen-cloud` (Castwright#3303). Box: this dev box, RTX 4060 Laptop
(8 GB) + RTX 3060 desktop-class card, two-GPU, Windows 11. Worktree
`C:\Claude\Projects\wt-onbox-batch-1` @ `7b339ff9`, branch
`chore/ops-onbox-batch-1`.

Command (all three runs, run-dir = this file's directory):

```powershell
Set-Location 'C:\Claude\Projects\wt-onbox-batch-1'
$env:GOLDEN_BLESS='1'
# run2 additionally: $env:GOLDEN_REBLESS_THRESHOLDS='1'
# run3 additionally: $env:GOLDEN_REBLESS_THRESHOLDS='1'; $env:GOLDEN_REBLESS_MEASUREMENTS='1'
& node scripts/run-powershell.mjs server/tts-sidecar/run-golden-tests.ps1 -s
```

(equivalent to `npm run test:golden-audio -- --bless --sidecar-only` plus the
missing `-- -s`; argv reached pytest as
`tests/golden -m golden --tb=short -q -rs -s -k not qwen_duration`.)

## Run 1 — 18:06:14 → 18:13:10 local, exit 1

Routine, unflagged. Kokoro bless wrote through silently (transcript comma
ASR-noise diff again, byte-for-byte the 2026-09-06 finding, plus three
whisper-lineage metadata fields). Instruct bless REFUSED on
`tolerances.rtf_max` (epsilon 0.0): 1.0 → 1.55, i.e. measured `rtf` ≈ 1.033
against blessed 0.5089. Verbatim refusal in `pytest-output-run1.log`.

## Run 2 — ~18:16 → 18:19 local, exit 1

`GOLDEN_REBLESS_THRESHOLDS=1`. Tolerances gate passed; REFUSED next on
`loudness_dbfs` beyond epsilon 0.4 (angry 2.68, whisper 1.91, excited 1.15,
neutral 0.77, sad 0.18 dB). Instruct baseline not written (refusal precedes
write). Identity was never reprimanded → within 0.005.

## Run 3 — 18:21:44 → ~18:27 local, exit 0 — CLEAN ACCEPT

`GOLDEN_REBLESS_THRESHOLDS=1` + `GOLDEN_REBLESS_MEASUREMENTS=1`. Guard wrote,
test SKIPped as designed (bless path), run clean. Echo lines, verbatim
(`-s`, printed after write + flush):

```text
[golden-bless] tolerances moved BEYOND epsilon 0.0 (FORCED by GOLDEN_REBLESS_THRESHOLDS) -- rtf_max: +/-1.4000
[golden-bless] identity moved within epsilon 0.005 (noise -- reference unchanged) -- cosine.sad: +/-0.0014, cosine.excited: +/-0.0009, cosine.angry: +/-0.0004, cosine.whisper: +/-0.0001, max: +/-0.0001
[golden-bless] loudness_dbfs moved BEYOND epsilon 0.4 (FORCED by GOLDEN_REBLESS_MEASUREMENTS) -- angry: +/-3.5000, excited: +/-1.6500, neutral: +/-1.6300, sad: +/-1.1700, whisper: +/-0.9200
```

Forced re-bless wrote `instruct-baseline.json`: `rtf.batched` 0.5089 → 1.5841,
`rtf_max` 1.0 → 2.4, loudness e.g. angry −17.3 → −13.8 dBFS; identity block
UNCHANGED in the file (within epsilon → echoed, not rewritten). All baseline
changes reverted before commit — `git status` clean at commit time apart from
this row's docs edit.

Contention note: a sibling on-box agent (other heartbeats in this batch) had
GPU compute processes resident during all three windows (python 5.5 GB
resident since 12:10; further python at 18:07/18:11). rtf/loudness figures
above are therefore not "uncontended" values; identity deltas are.

Files: `pytest-output-run1.txt`, `pytest-output-run2.txt`,
`pytest-output-run3.txt` (raw captured stdout+stderr of the three runs).