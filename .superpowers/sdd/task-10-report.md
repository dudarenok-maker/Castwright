# Task 10 Report — per-character 1.7B Quality-tier selection + synth routing

**Commit:** `dfc205c4`
**Branch:** `feat/sidecar-fs55-anchored-variants`

## Files changed

- `openapi.yaml` — added `qwen3-tts-1.7b` to ALL model-key enums (VoiceSampleRequest, VoiceSample, Character.ttsModelKey, Chapter.audioModelKey, and all inline per-endpoint enums); added `ttsModelKey` field to the Character schema.
- `src/lib/api-types.ts` — regenerated from openapi.yaml; `TtsModelKey` now includes `'qwen3-tts-1.7b'`.
- `server/src/tts/synthesise-chapter.ts` — added `ttsModelKey?: TtsModelKey | null` to `CastCharacter`; added `canonicalModelKeyForEngine` import from `./model-keys.js`; updated `routeFor` to apply `canonicalModelKeyForEngine('qwen', c.ttsModelKey)` when the resolved engine is `'qwen'` and `c.ttsModelKey` is set, covering both the `resolveForEngine` path (mixed-engine chapters) and the same-engine default path.
- `server/src/tts/synthesise-chapter.test.ts` — 3 new tests in `describe('fs-56 — per-character 1.7B Quality-tier model key routing')`: character with `ttsModelKey:'qwen3-tts-1.7b'` → provider call has `modelKey:'qwen3-tts-1.7b'`; character without `ttsModelKey` → `'qwen3-tts-0.6b'`; non-Qwen character with `ttsModelKey` → run-default key unchanged.
- `src/components/voice-engine-picker.tsx` — added `qwen17bAvailable?`, `charModelKey?`, `onCharModelKeyChange?` props; renders a "Higher quality (1.7B)" checkbox (`data-testid="qwen-1.7b-toggle"`) when `(value === 'qwen' || lockedToQwen) && qwen17bAvailable && onCharModelKeyChange`.
- `src/components/voice-engine-picker.test.tsx` — 6 new tests in `describe('VoiceEnginePicker — fs-56 1.7B Quality-tier toggle')`: show when available, hide when not, hide when not Qwen, checked state, toggle-on callback, toggle-off callback.
- `src/modals/profile-drawer.tsx` — added `qwen17bAvailable?: boolean` prop; local `charModelKey` state (seeded from `character.ttsModelKey`); passes both to `VoiceEnginePicker`; saves `ttsModelKey: charModelKey ?? null` on Save (null for non-Qwen characters).
- `src/components/layout.tsx` — passes `qwen17bAvailable={ttsLifecycle.qwen1_7b.state === 'ready'}` to ProfileDrawer.
- `docs/superpowers/plans/...fs55...md` — pre-existing uncommitted Step 1b plan annotation included.

## Test results

```
server/src/tts/synthesise-chapter (4 files, 98 tests): ALL PASS
  - 3 new fs-56 routing tests: PASS (1 was the TDD red→green test)
Frontend voice-engine-picker: 10 tests PASS (6 new)
Frontend full suite: 239 files, 3050 tests — ALL PASS
Server full suite: 306 files, 3221 tests — ALL PASS (1 known tinypool flake on first run, clean on second)
Typecheck: CLEAN (frontend + server, exit 0)
```

## TDD steps completed

1. Failing test written (`ttsModelKey:'qwen3-tts-1.7b'` → expected `'qwen3-tts-1.7b'`, got `'qwen3-tts-0.6b'`) ✓
2. Run → fail confirmed ✓
3. Implementation applied ✓
4. Run → pass confirmed (98/98) ✓
5. Commit `dfc205c4` ✓

## Concerns / notes

1. **OpenAPI enum churn:** `qwen3-tts-1.7b` was added to every model-key enum in `openapi.yaml` (13 sites). These were all literal inline enums, not $ref'd — bulk sed replacement was safe. Any future model key addition will need the same sweep; worth considering a $ref'd reusable enum in the spec.

2. **Non-Qwen `ttsModelKey` silently ignored:** A character with `ttsEngine: 'kokoro'` and `ttsModelKey: 'qwen3-tts-1.7b'` will have `ttsModelKey` persisted to `cast.json` but silently ignored at synth (the `routeFor` guard is `charEngine === 'qwen'`). This is correct behaviour by design — the field is only meaningful for Qwen. The picker only shows the toggle when Qwen is selected, so the UI can't create this state; old data with a stale `ttsModelKey` on a non-Qwen character degrades gracefully.

3. **`qwen17bAvailable` is `false` in mock mode:** The mock `loadSidecar` doesn't track a `qwen_base17_loaded` flag, so the toggle is always hidden in development (`VITE_USE_MOCKS=true`). The picker test covers this path directly. In production (real sidecar), the health poll updates `qwen1_7b.state` and the toggle appears when the 1.7B-Base is loaded.

4. **Profile-drawer `charModelKey` state type:** Narrowed to `'qwen3-tts-1.7b' | null` (not the full `TtsModelKey | null`) because the only writable value from the toggle is `'qwen3-tts-1.7b'`; null clears it. The `onCharModelKeyChange` callback on the picker accepts `TtsModelKey | null` to keep the interface general (future: could support other per-character keys).
