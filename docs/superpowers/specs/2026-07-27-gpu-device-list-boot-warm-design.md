# Device-knob resolution: deterministic sidecar env + codec knob parity

Design for [#1857](https://github.com/dudarenok-maker/Audiobook-Generator/issues/1857).
Branch `fix/1857-gpu-device-cache-boot-warm`.

> **Revision note.** An earlier version of this spec proposed warming the GPU
> device-list cache from a server-owned boot loop, as #1857 suggests. Two
> independent Fable reviews killed that approach — warming makes the *spawn* path
> strictly worse, and once the spawn path is fixed properly no consumer needs a
> boot-warmed cache at all. The review trail is preserved in "Rejected: the boot
> warm" below, because the reasoning is the most useful thing in this document.

## Summary

Two changes:

1. **`buildSidecarEnv` always emits the raw `cuda-uuid:<uuid>` literal** for a
   device knob, instead of sometimes emitting a translated `cuda:N` depending on
   whether the cache happens to be warm. The sidecar resolves the literal against
   live enumeration on every spawn.
2. **`QWEN_CODEC_DEVICE` resolves a `cuda-uuid:` pin**, with an explicit `cpu`
   fallback when the pinned card is gone.

Change 1 fixes a nondeterminism bug neither #1857 nor the first draft of this
spec named. Change 2 fixes the one genuine misrouting.

## Premise correction

#1857's stated harm does not occur, and its acceptance criteria assert a
behaviour the sidecar was deliberately built not to need.

The issue is mechanically correct that with a cold cache `buildSidecarEnv`
(`server/src/tts/spawn-sidecar.ts:472-480`) injects `String(st.effective)`, so a
raw `cuda-uuid:<uuid>` literal reaches the sidecar. It is wrong that this
misroutes the engine.

`main.py:1873` `_read_device_env()` runs every `*_DEVICE` read through
`_resolve_uuid_to_index()` (`main.py:1858`), which enumerates live torch devices
and maps `cuda-uuid:<uuid>` → `cuda:N`. All three engine device knobs go through
it, at six call sites:

| Knob | Env | Python read sites | Resolves UUID |
|---|---|---|---|
| `tts.coqui.device` | `COQUI_DEVICE` | `main.py:1124` | yes |
| `tts.kokoro.device` | `KOKORO_DEVICE` | `main.py:1444` | yes |
| `tts.qwen.device` | `QWEN_DEVICE` | `main.py:2860`, `2656`, `2669`, `6233` | yes |
| `tts.qwen.codecDevice` | `QWEN_CODEC_DEVICE` | `main.py:2996` — bare `os.environ.get` | **no** |

That Python-side resolution exists *because* the Node cache is cold at the boot
spawn. `_enumerate_cuda_devices`'s docstring (`main.py:1843-1847`) says so:

> the Node-side spawn-time cache in `getLastKnownGpuDevices()` is empty before
> the frontend's first GET `/api/gpu/devices` poll, so `buildSidecarEnv` passes
> the RAW `'cuda-uuid:...'` string through unresolved on a fresh server boot,
> not the pre-resolved `'cuda:N'` form a warm cache would produce

So the raw literal is a **supported input** at that boundary — the designed one.

## What is actually broken

### B1. `buildSidecarEnv` is nondeterministic

`resolveKnob` (`server/src/config/resolver.ts:35-49`) translates a stored
`cuda-uuid:` override to `cuda:N` **only when the device cache is warm**. The
cache is warmed exclusively by request-scoped paths — `GET /api/config`,
`GET /api/gpu/devices`, and a `PUT /api/config` device write — all dispatched
from `src/views/advanced.tsx`.

`buildSidecarEnv` reads through that same `resolveKnob`. So the env handed to the
sidecar depends on **whether the user opened Advanced settings during this server
session**:

| Cache state | `QWEN_DEVICE` handed to the sidecar |
|---|---|
| Cold (nobody opened Advanced) | `cuda-uuid:GPU-…` — sidecar resolves live |
| Warm (Advanced was opened) | `cuda:1` — frozen at warm time |

Same config, same box, two different spawn envs. Worse, the warm branch is the
dangerous one, and `buildOpts` re-runs `buildSidecarEnv` on **every respawn**
(`sidecar-supervisor.ts:234`):

- **Card vanishes after warm** (the documented eGPU "GPU is lost" mode on this
  dual-GPU box), then a recycle: the sidecar receives `QWEN_DEVICE=cuda:1` with
  one card visible → `_validate_cuda_index` (`main.py:2602-2612`) raises → the
  Qwen load fails, and fails again on every retry. The cold-cache path would have
  degraded to `auto` with a warning and kept generating.
- **Renumbering without a count change** (driver reload, `CUDA_DEVICE_ORDER`):
  the frozen index silently lands on the **wrong card**.

This is precisely the failure this spec's own rejected-alternatives section uses
against `nvidia-smi` enumeration — *a confidently wrong index is worse than a
literal the sidecar resolves correctly* — applied to a rival data source but not,
until this revision, to our own cache across time.

### B2. `QWEN_CODEC_DEVICE` does not resolve a UUID pin

`tts.qwen.codecDevice` is `type: 'device'` (`registry.ts:589`), so
`PUT /api/config` uuid-ifies it on write (`routes/config.ts:100` gates on
`knob.type === 'device'`) and the frontend offers it the card dropdown
(`override-row.tsx:366`). A user pinning the codec to a card gets
`cuda-uuid:<uuid>` on disk.

At load, `main.py:2996` reads it with a bare `os.environ.get`. It then *passes*
validation rather than being rejected by it: `_parse_device` (`main.py:1801`)
lowercases, matches `p.startswith("cuda")`, partitions on `:`, finds `"gpu-…"` is
not a digit, and returns `("cuda", None)`. `_validate_cuda_index` raises only when
`index is not None`, so it no-ops. The literal reaches
`_move_codec_to_device(model, codec_device, torch)` (`main.py:3064`), fails inside
torch's `.to()`, and is caught at `main.py:431` and rolled back to CPU with
`"Could not move Qwen codec to %s (%s) -- rolling back to cpu."`.

Impact: the codec ends up on CPU instead of the pinned card. Warned, not silent,
and it hits the **first** spawn as well as respawns.

## Design

### Change 1 — deterministic device env

`server/src/config/resolver.ts` grows a second entry point that resolves a knob
*without* the device-uuid reconciliation, sharing one implementation:

```ts
/** Effective value for the SIDECAR ENV. Deliberately does NOT reconcile a
    'cuda-uuid:' override to an index — see the docblock for why. */
export function resolveKnobForSidecarEnv(knob: ConfigKnob): KnobValueState
```

`buildSidecarEnv` (`spawn-sidecar.ts:474`) calls it instead of `resolveKnob`.
Every other caller of `resolveKnob` — `resolveAll`, `configValue`, the config
routes — is untouched, so the Advanced UI keeps seeing translated values and its
`staleReason: 'uuid_unresolved'` badge keeps working.

Result: the sidecar always receives the UUID form, and resolves it against live
enumeration on every spawn and respawn. Self-healing across renumbering, and a
vanished card degrades to `auto` with a warning instead of hard-failing the load.

**The general argument, stated once.** Node's uuid↔idx mapping is *derived from
the sidecar* — the cache is populated only from the sidecar's own `/devices`
(`gpu-uuid.ts:41-43`, `gpu-devices.ts:23`) — and the child inherits
`CUDA_VISIBLE_DEVICES` through `buildSidecarEnv`'s `...process.env` spread, so
both sides enumerate the same cards in the same order. Node's copy can therefore
only be *staler* than the sidecar's live view, never better informed. Translating
in Node is strictly a downgrade: it substitutes an older snapshot for a fresh
lookup, and there is no scenario in which it can be more correct.

**Version skew can't arise.** A spawned sidecar comes from `repoRoot`, so it is
always in lockstep with the Node code building its env. The only sidecar that
could be older is an *adopted* external one (`spawn-sidecar.ts:566`) — and we
never hand env to a process we didn't spawn.

**This is the opposite of what #1857 asks for, and it is the correct direction.**
The issue treats the raw literal as the bug; it is the fix.

### Change 2 — `QWEN_CODEC_DEVICE` parity, with a `cpu` fallback

A named helper beside `_resolve_codec_device`, so it is reachable from tests —
the call site is inside `_load_qwen_model`, which needs real weights and a GPU:

```python
def _codec_device_pref() -> str:
    raw = os.environ.get("QWEN_CODEC_DEVICE")
    if not raw or not raw.strip():
        return "cpu"
    resolved = _resolve_uuid_to_index(raw)
    if resolved is None:
        log.warning(
            "QWEN_CODEC_DEVICE=%s did not match any visible GPU -- leaving the codec on cpu.", raw,
        )
        return "cpu"
    return resolved
```

**Why this deliberately does not use `_read_device_env`.** That helper degrades an
unresolvable pin to `"auto"`, which is right for the three engine knobs but wrong
here: `_resolve_codec_device("auto", model_device)` means "follow the model"
(`main.py:401-402`), so a vanished card would silently move the codec **onto the
model's card**. The only reason to pin the codec to a specific card is to spread
VRAM across cards; degrading that to "share the model's card" adds pressure to
exactly the card the user was trying to protect. `_move_codec_to_device`'s
rollback (`main.py:431-437`) only fires if the `.to()` itself raises — a
*successful* move that eats a tight card's headroom and OOMs a later decode never
rolls back, and this repo has documented co-residency OOM history on the 8 GB
card. `cpu` is the knob's registry default and is VRAM-neutral.

Behaviour, before and after:

| `QWEN_CODEC_DEVICE` | Before | After |
|---|---|---|
| unset / `""` | `cpu` → no move | `cpu` → no move |
| `cpu` / `auto` / `cuda:N` / `mps` | pass-through | pass-through |
| `cuda-uuid:<visible>` | passes validation, torch `.to()` raises → rolled back to CPU | → `cuda:N`, codec on the pinned card |
| `cuda-uuid:<vanished>` | passes validation, torch `.to()` raises → rolled back to CPU | → `cpu`, with a warning naming the knob |

The vanished row lands on the same device as today; the difference is that it gets
there deliberately, with an accurate log line, instead of via a torch exception.

**Adjacent latent trap, named so it stays dormant.** `_parse_device` classifies
`cuda-uuid:<uuid>` as family `cuda` with *no index*. Any path that treats
`("cuda", None)` as "plain cuda → card 0" and receives a raw UUID would silently
use the wrong card. Today's only consumer at risk, `_engine_env_pin`
(`main.py:1898`), is safe solely because it routes through `_read_device_env`
first. Change 2 makes the codec path the fourth reader to depend on that
invariant: *every* `*_DEVICE` read resolves the UUID before `_parse_device` sees
it.

## Rejected: the boot warm (#1857's own suggestion)

Warming the device-list cache at boot was the first design. It is rejected on
three independent grounds, two found by review after the design was written.

**It cannot warm before the first spawn anyway.** The only source of the uuid↔idx
mapping is the sidecar's `GET /devices` (`main.py:6505`). At the initial boot
spawn that process does not exist. The issue's acceptance bullet — "closes the
initial-spawn case too" — is unachievable by warming.

**It makes respawns worse, not better.** A warm cache is exactly what turns the
self-healing raw literal into a frozen `cuda:N` — B1 above. Warming *causes* the
harm; it does not prevent it.

**Once B1 is fixed, no consumer needs a warm cache without a request.**
`engine-device.ts:36` tests `raw.startsWith('cuda')`, satisfied by the UUID form.
`staleReason` and the translated display are only ever surfaced through routes,
which warm on demand. `buildSidecarEnv` was the one consumer running without a
request, and Change 1 takes it off the cache deliberately. Request-scoped warming
turns out to be correct rather than accidental.

The cost avoided is real: a long-lived concurrent writer to shared state, up to
48 fetches over ~3.6 minutes per boot, and — because `/devices` calls
`mem_get_info` per card (`main.py:1820`) — CUDA primary-context initialisation on
**every visible card** on every boot, including cards the sidecar will never use.

Two further defects the review found in that design, recorded so it is not
re-proposed unchanged: its stop condition conflated "sidecar reported zero cards"
with "the fetch timed out", so one aborted `/devices` probe on a GPU box would log
*"sidecar reports no CUDA cards"* and exit cold. And its no-downgrade rule made
`staleReason: 'uuid_unresolved'` unreachable for the eGPU-drop case it was named
for, with no mechanism by which a warm cache could ever learn cards went to zero.

## Testing

- **`server/src/tts/sidecar-env.test.ts`** — `buildSidecarEnv` emits
  `QWEN_DEVICE=cuda-uuid:GPU-1` under a **warm** cache and under a **cold** cache.
  The warm case is the regression test for B1: it fails against today's code.
- **`server/src/config/resolver.test.ts`** — `resolveKnob` still translates to
  `cuda:N` against a warm cache and still reports `staleReason: 'uuid_unresolved'`
  for a vanished pin, i.e. Change 1 did not disturb the UI path.
- **`server/tts-sidecar/tests/test_device_parse.py`** — `_codec_device_pref()`
  resolves a visible UUID to `cuda:N`, returns `cpu` for a vanished one, returns
  `cpu` when unset or empty, and passes `cpu`/`auto`/`cuda:N` through unchanged.

No GPU is required by any of these.

## Out of scope

- Warming the device-list cache outside a request — see Rejected above.
- Cache staleness generally. With `buildSidecarEnv` off the cache, a stale entry
  can only affect what the Advanced UI displays until its next poll.
- `qa.asr.device` / `qa.speaker.device`, which also read `os.environ` bare
  (`main.py:4754`, `4907`). Both are `type: 'string'` (`registry.ts:373`, `362`),
  so `routes/config.ts:100` never writes them a `cuda-uuid:` value. Noted so the
  asymmetry is not re-discovered as a bug.

## Acceptance

Replaces #1857's acceptance criteria.

1. `buildSidecarEnv` emits the raw `cuda-uuid:` literal for a device knob under
   **both** a warm and a cold device cache — the spawn env no longer depends on
   whether Advanced settings was opened.
2. A supervisor respawn after the pinned card's index changes still reaches the
   correct card, because the sidecar re-resolves the UUID on each spawn.
3. `QWEN_CODEC_DEVICE=cuda-uuid:<visible-uuid>` places the Qwen codec on the
   pinned card. An unresolvable pin leaves it on `cpu` with a warning naming the
   knob, never on the model's card.
4. `GET /api/config` still translates a valid pin to `cuda:N` and still flags a
   vanished one as `uuid_unresolved` — the UI path is unchanged.
