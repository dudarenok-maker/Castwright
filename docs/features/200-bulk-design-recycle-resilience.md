---
status: active
shipped: null
owner: null
---

# Bulk voice-design recycle resilience

> Status: active
> Key files: `server/src/routes/cast-design.ts`, `server/tts-sidecar/start.ps1`,
> `server/tts-sidecar/sidecar-restart-policy.ps1`, `server/src/tts/spawn-sidecar.ts`,
> `server/tts-sidecar/main.py` (`/health`)
> URL surface: indirect — the "Design full cast" pill (see `195-design-full-cast.md`)
> OpenAPI ops: `POST /api/books/{bookId}/cast/design` (SSE)

## Benefit / Rationale

"Design full cast" (plan 195) ran a back-to-back bulk of Qwen VoiceDesign jobs.
It failed almost every time — succeed on voice 1, then halt on every voice
after. Root-caused live (8 GB card, 63 GB box):

- **The failing runs ran against a sidecar started with the WRONG memory
  ceiling.** A sidecar launched without this server's `server/.env` computes the
  AUTO committed-RAM ceiling (`0.70 × RAM`) instead of the configured 48500 MB.
  On the incident the auto value resolved to ~14 GB (`14135 ≈ 0.70 × ~20 GB`),
  so the sidecar self-recycled (code 43) after ~3 designs. This is the
  "dev sidecar adopted/served by prod" trigger.
- **A recycle then broke the run two ways:** `start.ps1` only relaunched on the
  CUDA-poison code 42, not the planned-recycle code 43, so it logged
  `not restarting`; and `cast-design.ts` treated the respawn-gap
  "unreachable" error as a *catastrophic halt* of the whole job.
- Manual one-by-one designs always worked because the minutes between them let
  the 120 s idle watchdog free VoiceDesign + reclaim host RAM; bulk never got
  that breather, so committed RAM climbed (~160 MB/voice — harmless under the
  CORRECT 48.5 GB ceiling: ~140 voices to the soft threshold).

- **User:** bulk design completes a whole cast even across the recycles a long
  run is statistically guaranteed to hit; a mis-configured leftover sidecar can
  no longer silently sabotage it.
- **Technical:** code 43 finally does what it was designed for (relaunch); the
  bulk job is recycle-tolerant; the spawn-gate detects config drift.
- **Architectural:** a config-consistency handshake (alongside the existing
  protocol-version handshake) — the server refuses to adopt a sidecar whose
  effective recycle ceilings disagree with its own config.

## Architectural impact

Reserved VRAM is NOT the bottleneck for design (it holds flat at ~5.8 GB:
Base 0.6B + VoiceDesign 1.7B at bf16 + CUDA context). The pressure is
committed host RAM (the side-11 variable-length-generation leak), governed by
the committed/VRAM recycle ceilings in `main.py`. The fix keeps the recycle as
the pressure-relief valve but makes the whole path *self-healing* instead of
*fatal*.

## Invariants to preserve

- `start.ps1`'s supervisor loop relaunches uvicorn on BOTH 42 (poison) and 43
  (recycle); every other exit code breaks the loop (no tight respawn cycle).
  Decision lives in `sidecar-restart-policy.ps1` (`Test-SidecarShouldRestart`).
- `cast-design.ts` rides out an "unreachable"-class design error up to
  `MAX_RECYCLE_RIDEOUTS` (2): wait for the respawn (`ensureSidecarEngineReady`)
  and retry the SAME character. Only after the budget is exhausted (genuinely
  dead sidecar) does it stop with `sidecar_unavailable`. Persona generation runs
  once, before the ride-out loop (a retry re-renders the voice, not the persona).
- `/health` exposes `mem_restart_mb` / `vram_restart_mb` (the EFFECTIVE ceilings;
  `None` when disabled/unreadable).
- The spawn-gate (`spawnSidecar`) treats a live sidecar whose effective ceilings
  disagree with the server's configured ceilings as UNFIT → kill + respawn (A1).
  It only compares dimensions where BOTH an explicit (non-default) config AND a
  reported value exist, so it never false-fires on auto/auto or an older sidecar
  that omits the fields — preserving the dev HMR adopt fast-path.

## Test plan

Automated (all green locally):

- `server/src/routes/cast-design.test.ts` — rides out a recycle and completes
  (retries the character; no `error` event); halts with `sidecar_unavailable`
  only after `MAX_RECYCLE_RIDEOUTS` retries are exhausted.
- `scripts/tests/sidecar-restart-policy.Tests.ps1` — `Test-SidecarShouldRestart`
  table: 42→restart, 43→restart, 0/1/130→stop. Existing `sidecar-start.Tests.ps1`
  still green (dot-source placed after the venv check).
- `server/src/tts/spawn-sidecar.test.ts` — a ceiling-mismatch sidecar is replaced
  (even in dev); a matching-ceiling sidecar is still adopted (no false replace).
- `server/tts-sidecar/tests/test_smoke.py` — `/health` reports
  `mem_restart_mb` / `vram_restart_mb`.

Manual / live-GPU acceptance (owed): on the 8 GB box, with the sidecar started
via `start-prod.bat` (correct `.env`), "Design full cast" over a multi-voice
cast completes end to end; a forced `/recycle` mid-run is ridden out (the pill
shows progress through the respawn, the run finishes). Reproduction harness used
during root-cause: sequential `POST /qwen/design-voice` while sampling `/health`
`committed_mb`/`vram_reserved_mb` (8/8 succeeded on a correctly-configured
sidecar).

## Out of scope

- Reducing the VoiceDesign host-RAM leak itself (the recycle is the accepted
  relief valve; this plan makes the relief non-fatal).
- Sequencing Base/VoiceDesign to avoid co-residence, or quantizing below bf16
  (would add headroom but is a larger engine change; not needed once the recycle
  path is self-healing).

## Ship notes

_Pending._ Builds on `108-qwen-coexistence.md` (VRAM coexistence) and the
voice-design contention robustness work (PR #685,
`docs/superpowers/specs/2026-06-09-voice-design-contention-robustness-design.md`).
Pairs with `195-design-full-cast.md`.
