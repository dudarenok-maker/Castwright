---
status: active
shipped: null
owner: dudarenok-maker
---

# Qwen3-TTS as the default engine ("Qwen-preferred, Kokoro fallback")

> Status: active
> Key files: `server/src/workspace/user-settings.ts` (`getResolvedTtsModelKey`, install-state cache), `server/src/tts/qwen-install-detect.ts`, `server/src/tts/synthesise-chapter.ts` (`applyQwenFallback`), `server/src/routes/generation.ts` (`qwenUnavailable`, snapshot stamp), `server/src/tts/qwen-install-bootstrap.ts`, `server/src/routes/qwen-install.ts`, `server/src/tts/spawn-sidecar.ts` (PRELOAD), `server/tts-sidecar/main.py` (`_qwen_install_state`), `src/components/qwen-install.tsx`, `src/components/qwen-status-notice.tsx`, `src/lib/voice-status.ts`, `src/views/account.tsx`, `src/views/cast.tsx`, `src/views/confirm-cast.tsx`
> URL surface: `#/account` (installer), `#/cast` + confirm-cast (promo/warning); no new view
> OpenAPI ops: `UserSettings.resolvedTtsModelKey` / `defaultTtsModelKeyExplicit` (read-model); `/api/qwen/{detect,install,install/:id,install/:id/recheck}` (install management, not in the spec — matches the Ollama install endpoints' convention)

Successor to [108 — Qwen3-TTS coexistence](archive/108-qwen-coexistence.md): 108 added Qwen as an opt-in bespoke engine; this makes it the **default when installed** while keeping the out-of-box "upload → generate" path working via Kokoro.

## Benefit / Rationale

- **User:** new books default to Qwen3-TTS's bespoke per-character voices the moment Qwen is installed — no per-book engine switch. A one-click in-app installer (Account → Models) replaces the copy-paste CLI. Books still generate immediately on a box without Qwen (Kokoro), and a character with no designed Qwen voice renders in Kokoro instead of failing.
- **Technical:** the default is resolved LIVE (`getResolvedTtsModelKey`) from a cached Qwen install-state — no per-book engine field, no migration. The synth path gains a single graceful-fallback seam so an undesigned/unavailable Qwen never hard-fails a chapter.
- **Architectural:** Qwen-preferred is a resolver + a render-time fallback, not a hardcode — fully reversible (uninstall Qwen → default reverts to Kokoro; an explicit user pick is honoured forever).

## Architectural impact

- **Install-state probe (phase 0).** `server/tts-sidecar/main.py` `/health` reports `qwen_install_state` (`not-installed | weights-missing | ready | loaded`) via `_qwen_install_state` (side-effect-free: `importlib.util.find_spec` + HF-cache weight scan, no torch import). The sidecar-health proxy normalises a missing field to `'not-installed'` (old-sidecar safety) and feeds a module-level cache in `user-settings.ts`.
- **Live default (phase 1).** `getResolvedTtsModelKey()` = explicit user choice → else Qwen if install-state ready/loaded → else factory Kokoro. A Node-side boot probe (`qwen-install-detect.ts`) seeds the cache before the sidecar is up so a Qwen box hot-preloads Qwen (`PRELOAD_QWEN=1`) while Kokoro stays lazy (`PRELOAD_KOKORO=0`) — Kokoro warms on demand as the fallback. The settings GET surfaces a read-only `resolvedTtsModelKey`; the stored `defaultTtsModelKey` is never mutated by the resolver. `defaultTtsModelKeyExplicit` latches when the Account picker saves a value other than the resolved default (and server-side on any genuine change).
- **Per-character fallback (phase 2).** `synthesiseChapter`'s single `resolveGroup` seam (and the title beat) reroute a Qwen group to Kokoro when the voice is undesigned (`pickVoiceForEngine('qwen')===''`) or `qwenUnavailable`. Because `resolveGroup` is the one resolution point the batch partition reads, a fallen-back group automatically leaves the Qwen batch and renders as a Kokoro single. The engine actually used is stamped on the segment + `characterSnapshots[id].renderedFallbackEngine`.
- **In-app installer (phase 3).** `QwenInstallBootstrap` mirrors the Ollama installer: spawns `install-qwen3.mjs` (piped stdio, step-based progress), re-probes on exit, syncs the resolver cache on success. Routes under `/api/qwen`.
- **UI (phase 4).** `resolveVoiceStatus` gains a `'Fallback (Kokoro)'` pill (render-time fact outranks design lifecycle). `QwenStatusNotice` warns + promotes Qwen on the cast screens only when it's not installed.
- **Invariants preserved:** OpenAPI source-of-truth (24) for the new settings read-model fields (regenerated `api-types.ts`); no `BookStateJson` schema change; mocks behind `VITE_USE_MOCKS` unchanged.
- **Reversibility:** uninstall Qwen → resolver returns Kokoro; revert the diff to drop the whole feature.

## Invariants to preserve

- `getResolvedTtsModelKey` (`user-settings.ts`) never returns the STORED key on the non-explicit branch — it returns factory `'kokoro-v1'` so a GET→PUT round-trip of the stored key can't strand a non-explicit user on an uninstalled Qwen.
- A missing `qwen_install_state` from `/health` → `'not-installed'` (`sidecar-health.ts` `normaliseQwenInstallState`); a cold boot before the first probe defaults to Kokoro.
- The Qwen→Kokoro fallback lives ONLY in `resolveGroup`/`applyQwenFallback` (`synthesise-chapter.ts`) so the batch partition and the synth call agree on the post-fallback engine.
- `spawn-sidecar.ts`: when the resolved default is `qwen3-tts-0.6b`, `PRELOAD_QWEN=1` and `PRELOAD_KOKORO=0` (Kokoro lazy, warmed on demand at the first fallback render).

## Test plan

### Automated coverage

- Pytest (`server/tts-sidecar/tests/test_qwen_install_state.py`) — the 4-state derivation + HF-cache weight scan + `/health` field surfacing.
- Vitest server (`server/src/routes/sidecar-health.test.ts`) — `qwenInstallState` mapping + missing/garbage → `'not-installed'`.
- Vitest server (`server/src/workspace/user-settings.test.ts`) — `getResolvedTtsModelKey` across install-states + explicit-pin + no-op-round-trip-stays-implicit.
- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — `PRELOAD_QWEN=1`/`PRELOAD_KOKORO=0` on a Qwen default.
- Vitest server (`server/src/tts/qwen-install-detect.test.ts`) — the Node-side disk probe's 3 states.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — undesigned-Qwen → Kokoro + segment stamp; designed+available → no fallback; designed+`qwenUnavailable` → fallback; non-Qwen never stamped.
- Vitest server (`server/src/tts/qwen-install-bootstrap.test.ts` + `server/src/routes/qwen-install.test.ts`) — the install state machine + routes offline.
- Vitest frontend (`src/store/ui-slice.test.ts`) — session seeds from `resolvedTtsModelKey`.
- Vitest frontend (`src/lib/voice-status.test.ts`) — `'Fallback (Kokoro)'` pill.
- Vitest frontend (`src/components/qwen-install.test.tsx`, `src/components/qwen-status-notice.test.tsx`) — installer + notice state machines.
- Playwright (`e2e/account-dual-model.spec.ts`) — the Account installer card renders.

### Manual acceptance walkthrough

1. **No-Qwen box, fresh book** → defaults to Kokoro; generation runs; the cast + confirm-cast screens show the `QwenStatusNotice` warning/promo; Account → Models shows the "Install Qwen3-TTS" card.
2. **Install via the card** → progress steps stream; on success the card flips to "installed" and new books default to Qwen.
3. **Qwen box, generate a chapter where one character has no designed voice** → that character renders in Kokoro ("Fallback (Kokoro)" status), the rest in Qwen; the MP3 assembles cleanly (`ffprobe`).
4. **Explicitly pick Kokoro in Account on a Qwen box** → saved; new books stay on Kokoro (explicit pin honoured).

## Out of scope

- Threading `renderedFallbackEngine` from the segments file into the live cast-row Status pill — the resolver supports it + it's stamped on disk, but the cast view doesn't yet load per-chapter render metadata. Follow-up.
- Bundling the ~5 GB Qwen weights into the release zip (download-on-demand via the installer instead).
- Auto-designing every character's voice on first generate (declined — graceful Kokoro fallback covers the gap).

## Ship notes

(Filled on ship: date + merge SHA. Eligible for archive once stable.)
