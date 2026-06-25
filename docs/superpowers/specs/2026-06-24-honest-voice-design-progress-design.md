---
title: Honest streamed-phase progress for single voice design
date: 2026-06-24
status: draft
area: cast / voice-design
---

# Honest streamed-phase progress for single voice design

## Problem

A single base-voice design takes ~120s on the 8 GB box (measured from
`tts.err.log`: 1.7B VoiceDesign cold load ~10s + design forward + 0.6B distil +
0.6B audition ~65s + base load / Kokoro-evict ~20-30s). The cast-drawer progress
UI lies about this in three independent ways:

1. **Magnitude.** `src/components/design-progress.tsx` hardcodes *"about 15s"*
   and eases the fill to ~92% over 15s. The remaining ~105s sits at 92%.
2. **False alarm.** Past `SLOW_AFTER_MS = 20_000` it flips to *"Taking longer
   than usual — the GPU may be busy with another job."* A ~120s design is now
   the **normal** case, so this contention warning fires on essentially every
   design.
3. **Fake phases.** A single design is **one blocking sidecar call**
   (`/qwen/design-voice` runs load → design-forward → distil → audition → encode
   internally). `server/src/routes/single-design.ts:106-114` emits `'designing'`
   *before* the call and `'rendering'` *after it returns* — its own comment says
   *"the core doesn't expose that seam yet … for v1 we emit 'rendering'
   immediately before persist."* So the UI shows `'designing'` for ~99% of the
   wall-clock, then a blink of `'rendering'`.

The sidecar knows the real phase boundaries — it just never reports them. The
per-phase timing instrumentation shipped in `bff9ff54` (`design_voice` /
`mint_variant` → `qwen voice design:` / `qwen mint variant:` log lines) sits
exactly on those boundaries and is the substrate this feature streams from.

## Goals

- Drive the single-design progress bar from **real** phase transitions emitted
  by the sidecar, not a client-side timer.
- Show an honest ETA and honest phase labels; keep the bar moving smoothly
  *within* a long phase via a calibrated sub-fill.
- Only surface a "GPU may be busy" / slow warning on a **real** overage.

## Non-goals

- Making the design *faster*. That is a separate perf effort, unblocked by the
  same instrumentation once we have on-box numbers.
- The bulk "Design full cast" per-character progress — already honest
  (done/total per character via `cast-design-slice`). This feature only changes
  the per-design bar *inside* one character's design.
- The 1.7B-Base mint fallback robustness fix — tracked as a **separate** branch
  + issue + test (see "Related work").

## Architecture

### Transport: sidecar → server progress callback

The design/mint sidecar calls stay **synchronous** and keep returning PCM as
their response body. A new best-effort progress side-channel reports phases:

1. When the server starts a single-design job (`single-design.ts`) it generates
   a short-lived **progress token**, stores `token → job` in an in-memory Map,
   and passes the token + a server callback URL into
   `designQwenVoiceForCharacter` → into the `/qwen/design-voice` (or
   `/qwen/mint-variant`) request body (`progressToken`, `progressUrl`).
2. The sidecar route handler builds a `report_progress(phase)` closure and
   passes it into `design_voice` / `mint_variant`. At each timing seam (the
   `perf_counter` boundaries already in place) the function calls
   `report_progress(phase)`, which fires a **fire-and-forget, short-timeout**
   POST to `progressUrl` with `{token, phase}` from a daemon thread (never
   blocks the synth; all errors swallowed — progress must never fail a design).
3. The server's internal route `POST /api/internal/design-progress` (localhost
   only; the token itself is the shared secret) looks up the job by token and
   `broadcast(job, { type: 'phase', phase })` onto the **existing** single-design
   SSE. On job end the token is deleted from the Map.

**Why callback POST and not a streaming response (corrected after adversarial
review):** the original rationale ("streaming is invasive to the locked core")
was wrong — `design_voice` takes a `report_progress` callback either way and is
identical in both designs; only the route-level plumbing differs. The *real*
reason: the design route returns **raw binary PCM** as its response body
(`server/src/routes/qwen-voice.ts` reads `upstream.arrayBuffer()` +
`X-Sample-Rate`), and that response is consumed by **three** callers (bulk
full-cast, the REST endpoint, the single-design job). A streaming response would
force reframing that binary contract (base64-inflate the audio or a multipart
trailer) and gating it for all three callers. The callback is purely **additive
and opt-in** — only the single-design job passes a token; the other two callers
pass nothing and get the unchanged PCM response.

### Phase taxonomy

Replaces today's `'designing' | 'rendering'` union. Real events:

| design_voice    | mint_variant    | UI label                       | seam (perf_counter) |
|-----------------|-----------------|--------------------------------|---------------------|
| `freeing-vram`  | `freeing-vram`  | "Freeing GPU memory…"          | before Kokoro evict (only if resident) |
| `loading-model` | `loading-model` | "Loading the design model…"    | before `_ensure_*_loaded` (`load_ms`) |
| `designing`     | `anchoring`     | "Designing the voice…" / "Anchoring to the base voice…" | before forward (`design_fwd_ms` / `icl_ms`) |
| —               | `performing`    | "Performing the emotion…"      | before `_icl_instruct_synth` (`instruct_ms`) |
| `distilling`    | `distilling`    | "Distilling the voice…"        | before 0.6B clone-prompt (`distil_ms`) |
| `rendering`     | `rendering`     | "Rendering the 12s audition…"  | before audition synth (`audition_ms`) |

`loading-model` is emitted **unconditionally** at its seam (`_ensure_*_loaded`
is always called; it's a near-instant no-op when the model is warm). Only
`freeing-vram` is conditional — emitted just before the `_VD_KOKORO.design()`
arbiter is entered, and only when Kokoro is resident, so the arbiter's
drain-and-evict wait is visible rather than hidden inside the `with`. A phase
that turns out instantaneous (warm model) is superseded by the next real event
arriving early — the client snaps forward rather than waiting out its budget.

### Per-phase calibration

The bar advances to a phase on its real event, then eases a **sub-fill** within
that phase from `elapsed-in-phase / expected-phase-budget`. Expected budgets are
constants seeded from the on-box `qwen voice design:` line (**owed** — see Open
items). Placeholder estimates until measured: `freeing-vram` ~1s,
`loading-model` ~10s (cold) / ~0 (warm), `designing` ~55s, `distilling` ~5s,
`rendering` ~10s; mint adds `anchoring` ~5s + `performing` ~60s.

Honest total ETA = sum of remaining phase budgets. The "taking longer than
usual" message appears only when **total elapsed > expected_total × 2** OR the
current phase has run past `budget × N` with no new event — never on a normal
~120s design.

## Component changes

- **`server/tts-sidecar/main.py`** — `design_voice` / `mint_variant` accept an
  optional `report_progress` callback; call it at each existing seam. Add a
  small helper to POST `{token, phase}` (daemon thread, ~1s timeout, swallow
  errors). The FastAPI route handlers read `progressToken` / `progressUrl` from
  the body and build the closure.
- **`server/src/routes/single-design.ts`** — token Map; pass token + callback
  URL through; internal `POST /api/internal/design-progress` route; broadcast
  the richer phase; delete token on `endJob`.
- **`server/src/routes/qwen-voice.ts`** — `designQwenVoiceForCharacter` threads
  `progressToken` / `progressUrl` into the sidecar request body.
- **`src/lib/api.ts`** — widen the `phase` union on the single-design SSE event,
  callbacks, and `SingleDesignStatus`; map the new phases in
  `readCastDesignStream`. Extend `mockStartSingleDesign` to emit the richer
  phase sequence (so e2e and the drawer dev path exercise it).
- **`src/store/cast-design-slice.ts`** — widen the `phase` union; reducer stores
  the latest phase (`designSinglePhaseAdvanced`).
- **`src/components/design-progress.tsx`** — rebuilt: take the richer phase + a
  per-phase budget map; real-event-driven advance with calibrated sub-fill;
  honest ETA; real-overage-only slow warning; drop the hardcoded "about 15s".
- **`src/components/voice-engine-picker.tsx`**, **`src/modals/profile-drawer.tsx`**
  — pass the richer phase through to `DesignProgress`.
- **`openapi.yaml`** — document the new internal progress route + the widened
  phase enum; regen `src/lib/api-types.ts`.

## Error handling

- **Callback POST fails / sidecar can't reach the server** — ignored. Progress
  degrades to the last known phase with a time-estimated sub-fill; the design
  still completes and the SSE `done`/`preview_ready` event drives the snap to
  100%.
- **Phase stall** (no new event past `budget × N`) — indeterminate shimmer on
  the current phase, *not* the GPU-busy message, until the total-overage
  threshold trips.
- **Abort / cancel** — unchanged (existing single-design abort flow).
- **Sidecar down / recycle** — unchanged: the existing `DESIGN_ABSOLUTE_MAX_MS`
  liveness path in `qwen-voice.ts` still owns the hard timeout + error surface.

## Testing

- **Sidecar (pytest):** `report_progress` is invoked with the expected phase
  sequence for `design_voice` and `mint_variant` (mock callback, GPU-free fakes,
  mirrors `test_design_kokoro_exclusion.py`).
- **Server (vitest):** a `POST /api/internal/design-progress` with a valid token
  broadcasts the matching SSE phase; an unknown token is rejected; the token is
  deleted on job end.
- **Client (vitest):** `cast-design-slice` reducer stores each new phase;
  `DesignProgress` renders the right label per phase, eases the sub-fill, shows
  an honest ETA, and does **not** show the slow warning before the real-overage
  threshold.
- **E2E (Playwright):** the mock single-design path emits the richer phase
  sequence; a spec asserts the phase labels appear in order in the drawer.

## Related work

- **A. Timing instrumentation** — shipped `bff9ff54` (this branch).
- **C. 1.7B-Base mint fallback** — separate branch/PR (issue + paired test, no
  spec doc): when an emotion variant is requested but the 1.7B-Base is not
  installed or fails to load, reroute server-side to `/qwen/design-voice` with
  `persona + EMOTION_INSTRUCT[emotion]` (the old path), logged not silent.
  Detection via the sidecar `/health` capability for the 1.7B-Base.

## Adversarial review (2026-06-24)

Findings from stress-testing the spec against the code. All verified; the
transport decision survived (corrected rationale above) and these become
must-handle plan items.

- **AR1 — sidecar has no HTTP client.** No `requests`/`httpx`/`aiohttp` is
  imported or in `requirements/`. The progress POST MUST use stdlib
  `urllib.request` — adding a dependency for a fire-and-forget POST isn't
  justified.
- **AR2 — LAN mode is HTTPS-only on :8443 (the reverse-callback wrinkle).**
  `server/src/index.ts` listens plain HTTP on :8080 normally but HTTPS-only on
  :8443 (mkcert cert) when `LAN_HTTPS` is set. The server must compute and pass
  its own **loopback** callback URL matching what it's actually listening on
  (`http://127.0.0.1:<PORT>` or `https://127.0.0.1:<LAN_HTTPS_PORT>`), and the
  sidecar's `urllib` POST must use an **unverified SSL context** for the https
  loopback (`ssl._create_unverified_context()`) — it's the same host. This is
  the one part that only breaks on the LAN box, never in tests; the plan must
  cover both modes.
- **AR3 — internal route must be loopback-gated, not token-only.** The progress
  relay route rejects any non-loopback `req.ip`, requires the token, and the
  token is valid only while its job is in-flight. Belt-and-suspenders against
  the LAN-exposed https surface.
- **AR4 — `designQwenVoiceForCharacter` has 3 callers.** Bulk full-cast
  (`cast-design.ts`), the REST endpoint (`qwen-voice.ts`), and the single job
  (`single-design.ts`). The new `progressToken`/`progressUrl` params are
  **optional**; bulk + REST pass nothing → the sidecar skips the POST. Verified
  backward compatible.
- **AR5 — client phase monotonicity.** Phase POSTs can arrive late, duplicated,
  or out of order. The slice treats phase as a monotonic ordinal and **ignores a
  phase whose rank is ≤ the current** — a delayed POST can never rewind the bar.
- **AR6 — completion snap on every terminal event.** `DesignProgress.complete`
  must be driven by `done` (first design) AND `preview_ready` /
  `ready-to-compare` (redesign) AND `error` (stop, show error) — not just
  `done`. Confirm the slice maps all terminal events to a non-running state.
- **AR7 — abort / job-replacement / late POSTs.** On cancel the server aborts
  the fetch and `endJob` deletes the token; later sidecar POSTs find no job →
  no-op. A fresh job for the same book gets a new token, so a prior design's
  stale POSTs can't drive the new bar. (The sidecar synth may run to completion
  after an abort — its POSTs are harmless no-ops.)
- **AR8 — warm/cold calibration variance.** `loading-model` is ~10s cold but
  ~0 warm (model stays warm across back-to-back designs); `designing` dominates.
  Per-phase budgets are guides: the sub-fill never passes ~92% within a phase
  before the next real event, and snaps on early arrival, so a warm-skipped
  `loading-model` leaves no visible stall.
- **AR9 — e2e is order-only.** The mock single-design path fakes timing, so the
  Playwright spec asserts phase-label **order**, not durations. Real timing is
  covered by the on-box run + the sidecar/server unit tests. Not oversold.

## Open items

- **On-box numbers (owed).** Run one real design and read the `qwen voice
  design:` line to seed the per-phase budgets. Until then the placeholder
  estimates above are used; the architecture does not depend on them.
