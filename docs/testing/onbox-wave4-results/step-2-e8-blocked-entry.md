# Step 2 — E8 moves to Blocked, not run

Issue: Castwright#2557 ("wave 4 step 2 — run E8 against a second portable ffmpeg build").

**The owner amended this issue on 2026-08-21, after wave-3 step 7 had already
recorded E8 STILL OWED.** The amendment supersedes the original instructions:
do not download an ffmpeg build, do not modify `PATH`, do not run
`npm run test:golden-audio:assembly`. Nothing was downloaded, installed, or
added to `PATH`; the golden-assembly suite was **not** run in this step.
`git status` in this worktree shows a clean tree before and after this step —
no baseline file, and nothing else, was touched.

**The ruling:** E8 is not runnable on this box. It moves to the register's
"Blocked — hardware not available" section, alongside the AMD/ROCm rows and
the CPU-only `RAM_HEAVY_MODELS` clamp. The row's intent is a genuinely
different *environment* — "one command, a different box" — and this box
cannot supply that. Blocked rather than deleted: the register's design is
that debt must never evaporate silently, and Blocked rows stay visible while
sitting outside the owed total.

Below is the content for the new Blocked entry, written to match the depth of
the two existing entries (AMD GPU support Phase 2 #1335, ORT pip-consistency
marker — AMD box #2192). Step 6 is the sole writer of the register and lifts
this verbatim; this file does not edit `docs/testing/onbox-acceptance-register.md`.

---

## Proposed Blocked entry

### E8 · ops-36 golden-assembly on a second ffmpeg build ([#1880](https://github.com/dudarenok-maker/Castwright/issues/1880), plan [272](../../features/272-golden-assembly-comparison.md))

**1. What is dormant.** The cross-build half of the ops-36 design — whether
L1/L2/L3's hard assertions survive a genuinely different ffmpeg build, and
what L4-loose's RMS-error actually is when the encoder really differs. What
is *not* dormant: the LOOSE branch itself was forced during the ops-36
demonstration with a synthetic banner mismatch plus 2.0 LU of drift and
rejected at 24.79% RMS-error against a 16% tolerance. Only the
genuinely-different-encoder case is unproven.

**2. Why this box cannot reach it.** Verified by wave-3 step 7
(`docs/testing/onbox-wave3-results/step-7-e7-e8.md`): no Docker, no WSL, no
container runtime of any kind on this box, and the only other `ffmpeg.exe`
present (the WinGet package) is the same `8.1.1-full_build-www.gyan.dev`
binary already on `PATH` — not a different build. The tier also sits outside
`verify.yml`, so CI never exercises it either.

**3. What would change that.** A second machine with a different ffmpeg
build (e.g. a BtbN Windows build vs. this box's gyan.dev one, or a clearly
different version), or a CI leg on a runner whose ffmpeg differs from this
box's. This box is single-ffmpeg; this will not move until one of those two
options exists.

**4. Alternative considered and rejected, recorded so it is not
rediscovered.** A portable ffmpeg build unpacked to a scratch directory and
prepended to `PATH` for the duration of one command would change the banner
on *this* box, since every server ffmpeg call spawns the bare string
`'ffmpeg'` (`server/src/export/build-m4b.ts:336`,
`server/src/routes/clip.ts:104`, `server/src/audio/measure-loudness.ts:83`),
which resolves through `PATH`. **The owner ruled on 2026-08-21 that this does
not satisfy the row's intent** — the row means a different environment, not
a different binary on the same one. Recorded here as a neutral decision so a
future reader can reverse it deliberately rather than stumble into it.

---

## Acceptance check for this step

- Nothing downloaded, installed, or added to `PATH`; `npm run test:golden-audio:assembly` not run. ✅ (no network/PATH/npm commands issued in this step)
- Evidence file contains all four items above, at the depth of the existing Blocked entries. ✅
- No golden baseline touched — confirmed with `git status` (clean before and after). ✅
- `docs/testing/onbox-acceptance-register.md`, its live view, and `docs/testing/onbox-sitting-*.md` were **not** edited by this step — that is step 6's job. ✅
