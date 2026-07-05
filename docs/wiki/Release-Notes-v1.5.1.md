Released 2026-06-01. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.5.1).

---

# Castwright 1.5.1

**A stability + hardening release.** The bulk of this release hardens the Qwen3-TTS default from v1.5.0: it drives long-run sidecar memory pressure down to a survivable, self-recovering state, makes a Qwen→Kokoro fallback loud instead of silent, finishes the reused-voice / persona consistency work, and closes a default-mode LAN exposure. No data migration required.

---

## ✨ Headline features

### 🔌 Default-bind to loopback (new)
A security fix that closes the 2026-05-31 review's top findings.

- In default mode the server now binds `127.0.0.1` only, so the unauthenticated API and the `/workspace` static mount (manuscripts, audio, `state.json` / `cast.json`) are **no longer reachable from other machines** on a shared Wi-Fi. The opt-in `npm run start:lan` mobile flow is unchanged; `BIND_HOST=0.0.0.0` restores all-interface HTTP.

### ▶️ Resume generation (new)
- A one-click way to continue a book whose run was interrupted (queued chapters left over, nothing in flight). Opening a book still never auto-starts generation — this is the explicit recovery affordance.

---

## 🔊 Generation reliability

- **Long Qwen runs climbed host RAM until the server was OOM-killed mid-book.** Now bounded by host-RAM reclaim on model unload, an RSS / committed watchdog, a `/debug/memory` readout, and a process-recycle keyed on committed-private memory.
- **A crashed sidecar used to drop the in-flight book.** Now it respawns on unexpected exit, the readiness gate polls *through* a respawn instead of failing fast, and the in-flight + queued chapters started during a recycle drain are recovered. The server is authoritative for queue completion.
- **Recycles interrupted a chapter mid-render.** Now crossing the memory soft-threshold drains and recycles cleanly *between* chapters, so a long book rides out the pressure without a dropped chapter.
- **A Qwen book could silently downgrade to Kokoro.** Now a `/health` handshake plus a loud per-chapter fallback gate (with a resident-model pill showing every loaded model) means a fallback is always visible, never silent.
- **A local Qwen timeout was misreported as "Gemini rate-limited"** and halted the whole book. Now a stalled chapter waits on the readiness gate and re-renders, then skips non-fatally if it can't recover.
- **Non-narration chapters** no longer queue or hang the parallel synth tail.
- **CUDA-fragmentation OOM** fixed via `expandable_segments`.

## 🎙️ Voice & cast

- **Reused characters lost their designed voice / persona.** Now reused characters keep their bespoke voice and persona — the voice / `voiceStyle` are denormalised at the link and auto-match write sites, and the designed persona is shown for reused characters.

## 🎧 Listening & recovery

- **A failed chapter forgot its state on reload.** Now it shows "Failed · reason" with Retry after a reload, plus a per-row "Generate this chapter" escape hatch and a "Generated <time>" line on done rows.
- **Per-book `state.json` auto-backup** — a scheduled background sweep snapshots each book's `state.json` (daily / weekly, newest-N retained) with a manual restore picker in Account.
- **Crash diagnostics** — FATAL crashes and unhandled rejections are captured; a startup port collision now prints an actionable message instead of a cryptic stack.
- Assorted dark-mode contrast and cast-row layout fixes.

## 🏗️ Under the hood

- **Qwen performance** — token-budget batch packing is now the default (cap 32 / budget 3600) plus TF32 + high fp32-matmul precision; an overnight full-book run held aggregate RTF ≈ 1.04 (~realtime).
- **Pre-commit scope filter + GPU-contention throttle** — a staged-diff scope filter skips out-of-scope test legs, and a soft `nvidia-smi` probe lowers test concurrency when a run is hammering the box.
- **Test reliability** — broke a `tts/index` ↔ provider import cycle that intermittently failed the cross-OS gate; pinned with a re-export identity guard. Per-chapter RTF history table in the developer Worktrees view.
- Archived 56 shipped feature plans; filed a security review and its follow-up backlog.

**Full changelog:** `v1.5.0...v1.5.1`
