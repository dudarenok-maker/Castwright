# fs-38 Wave 3b2 — cloned-voice resolver + lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an assigned **cloned** voice either render as itself or fail the chapter loud — never a silent substitution — by adding an async per-chapter resolver pre-pass, transparent orphan re-derive, revocation-at-render, and consent-scoped artifact erasure, on the Qwen engine.

**Architecture:** A new `clone-voice-resolver.ts` module holds a pure state classifier (`Healthy | Repairable | Broken`) plus an async orchestrator. `synthesiseChapter` calls that orchestrator as a **pre-pass** — after `groups`/`castById` are built (line 998) but before any synth fires (line 1076) — over only the cloned voices whose `characterId`s actually appear in this chapter. Repairable voices are re-derived from their retained `master.wav` (the sidecar rewrites the `.pt`, now atomically); Broken voices abort the whole chapter through a structured `UnresolvableClonedVoiceError`, surfaced via the existing `chapter_failed` failure-taxonomy channel. Revoke/delete gain a single `purgeCloneArtifacts(uuid)` that erases every consent-scoped artifact (base `.pt`, `__1.7b.pt`, `.json`, preview, sample cache).

**Tech Stack:** TypeScript (Node/Express server, Vitest), Python (FastAPI TTS sidecar, pytest), React/RTK (Vitest + RTL), Playwright.

## Global Constraints

_Every task's requirements implicitly include this section. Values copied from the umbrella spec `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md` §5–§7 and the post-3b1 `main` seams._

- **Never silently substitute a cloned voice.** A cloned-provenance voice that cannot render as itself must raise a typed error, never reroute to Kokoro/Coqui/a fallback speaker. This is the invariant the whole wave protects; every resolver test asserts it **directly** (Broken ⇒ raises AND resolves to no other voice — placebo-proof, per spec §8's "guards the placebo trap").
- **Scope is Qwen only.** 3b2 resolves cloned voices on the **Qwen** engine (the only engine 3b1 can clone on). XTTS/coqui cloned voices are 3c. `purgeCloneArtifacts` has **no `voices/xtts/` path to erase** today (no such helper exists) — do not invent one.
- **Additive & reversible.** No `cast.json` shape change. Everything stays gated behind `voices.library.enabled`. Pre-Wave-3 entries (no `master`, no `consent`, `provenance` designed/imported) are untouched.
- **Fail-fast wastes zero GPU.** The pre-pass validates every in-chapter cloned voice **before any synth call**; a Broken voice aborts before the title beat, not mid-render.
- **Consent-scoped erasure is total.** Revoke and delete must erase every artifact from which the voice could be resynthesised: `voices/qwen/qwen-<uuid>.pt`, `voices/qwen/qwen-<uuid>__1.7b.pt` (double underscore, literal `1.7b`), `voices/qwen/qwen-<uuid>.json`, the `-preview` variants, and the sample cache (`purgeVoiceSamples('qwen-<uuid>')`); delete additionally removes the entry dir (`master.wav` + `voice.json`). **The gaps this closes are precise: (a) REVOKE erases *nothing* today** (`routes/voice-library.ts:790-791` only stamps `revokedAt` + `writeEntry`) — a revoked person's `.pt`/`__1.7b.pt` survive on disk; **(b) DELETE's 1.7B removal is best-effort and sidecar-reachability-dependent** — it rides only on the `/qwen/evict-voice` POST (`voice-library.ts:822` → sidecar `_evict_17b_prompt`), so if the sidecar is down at delete time the `__1.7b.pt` is orphaned. `purgeCloneArtifacts` adds a **Node-side direct unlink** so erasure holds regardless of sidecar state, on both paths.
- **Sidecar owns the `.pt`; Node owns the manifest.** `deriveEngineArtifact` does not write any `.pt` — it POSTs PCM to `/qwen/clone-voice` and the **sidecar** writes `voices/qwen/qwen-<uuid>.pt`. "Stat-before-remove" (spec §5.6, absorbing #1804) is therefore an **atomic write on the sidecar side**, plus a **manifest-transactional** re-derive on the Node side (old `.pt` + `master.wav` survive until the new derive succeeds; only then flip `engines.qwen.status`).
- **Windows-safe artifact ordering.** When erasing, remove **files first, sidecar evict last** (the pattern documented at `routes/voice-library.ts:798-806`), so a held sidecar handle can't block the file unlink.
- **OpenAPI-first for any wire shape.** No hand-edited `src/lib/api-types.ts`. (3b2 adds no new HTTP request/response shapes on the Node↔client boundary, so this is a guard, not a step — the resolver is internal, and `engines.qwen.status` / `consent.revokedAt` / `master` already exist in the schema.)
- **No hex colour literals in components.** Use the existing `Pill` tone vocabulary (`success|warning|danger|neutral`).

---

## Design decisions settled before authoring (do not re-litigate mid-implementation)

1. **The resolver lives in its own module** (`server/src/tts/clone-voice-resolver.ts`), not inline in `synthesise-chapter.ts`. Rationale: the classifier must be unit-tested placebo-proof with injected deps; `synthesise-chapter.ts` is 1978 lines and its diff must stay small (one call site).
2. **Cloned→entry mapping is via `overrideTtsVoices.qwen.libraryUuid`** (declared `synthesise-chapter.ts:290`, currently unread). The assign route writes `libraryUuid = voiceUuid`. A cloned qwen slot with **no** `libraryUuid` → Broken (misconfigured).
3. **Engine-mismatch is Broken.** For a cloned qwen voice, if this character's route does **not** resolve to `qwen` (global non-qwen render engine) **or** `qwenUnavailable` → Broken. This closes the engine-mismatch substitution hole alongside the availability one (spec §5.2 "engine unavailable").
4. **Transient vs. permanent derive failure.** A **transient** re-derive failure → Broken **for this run only**; do **not** persist `status:'failed'` (a retry must re-attempt). Transient = **any `SidecarDesignError.status` that is `0` (unreachable), `503` (NoCapacity), or any `5xx`** — the sidecar returns 500/502/504 for genuinely recoverable conditions (CUDA OOM mid-distil, model exception, recycle), so those must **not** brick the voice. **Permanent = only a `4xx`** (the sidecar rejected the clip itself) → persist `engines.qwen.status:'failed'`. This split matters because classification rule 3 (`status==='failed'` → Broken) fires **before** the re-derive rule, so a persisted `'failed'` is terminal until a manual re-clone — a transient outage must never reach it. `qwenUnavailable`/engine-mismatch → Broken, never persisted.
5. **§2.3 (designed-voice clip-persist) is the separable tail (Tasks 11–12), recommended DEFER.** Cloned voices already carry an entry-dir `master.wav` from 3b1, so the resolver's Repairable path needs nothing from §2.3. §2.3 buys designed-voice *consistency across a base-model upgrade* — a quality nicety, not the never-substitute correctness this wave is about — and it forces a second `master` location + a Python WAV writer + a designed-voice re-derive path. Author them last, behind a clear divider, so the branch can ship Tasks 1–10 + 13 without them. **The controlling thread must ask the user which scope to run before dispatching Task 11.**

---

## File Structure

**Sidecar (Python)**
- Modify `server/tts-sidecar/main.py` — atomic base `.pt` write in `clone_voice` (~3857) and `design_voice` (~3767); (§2.3, optional) `design_voice` WAV clip-persist.
- Create `server/tts-sidecar/tests/test_qwen_pt_atomic.py` — the atomic-write regression.

**Server (TypeScript)**
- Create `server/src/tts/clone-voice-resolver.ts` — the classifier + async orchestrator.
- Create `server/src/tts/clone-voice-resolver.test.ts`.
- Create `server/src/workspace/purge-clone-artifacts.ts` — `purgeCloneArtifacts(uuid)`.
- Create `server/src/workspace/purge-clone-artifacts.test.ts`.
- Modify `server/src/tts/synthesise-chapter.ts` — extend `UnresolvableClonedVoiceError`; call the pre-pass.
- Modify `server/src/routes/voice-library.ts` — wire `purgeCloneArtifacts` into revoke + delete; follow-up (a) persist-without-cosine.
- Modify `server/src/routes/failure-taxonomy.ts` + `failure-remediations.ts` — the `cloned-voice-broken` code.
- Test files colocated: `synthesise-chapter-cloned-resolver.test.ts`, `voice-library.test.ts` (extend), `failure-taxonomy.test.ts` (extend).

**Frontend (React/RTK)**
- Modify `src/store/generation-stream-runner.ts` — toast + help-href for the new code.
- Modify `src/components/voices/voice-library-card.tsx` — Broken/Repairable chip.
- Modify `src/mocks/voice-library.ts` — a Broken cloned fixture.
- Test files colocated + `e2e/voice-library.spec.ts` (a new separate `test()`).

**Docs**
- Create `docs/features/268-fs38-wave3b2-resolver.md`; update `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/BACKLOG.md`.

---

## Interfaces (the contracts later tasks rely on)

```ts
// server/src/tts/clone-voice-resolver.ts  (Task 5 — Produces)

export type ClonedVoiceState = 'healthy' | 'repairable' | 'broken';

export interface ClonedVoiceClassification {
  state: ClonedVoiceState;
  /** Present when state==='broken' — user-facing reason. */
  reason?: 'revoked' | 'missing-master' | 'engine-unavailable' | 'derive-failed' | 'misconfigured';
}

export interface ClassifyInput {
  entry: import('../workspace/voice-library.js').VoiceLibraryEntry;
  /** true when this character's effective route is not qwen, or qwen is unavailable this run. */
  engineUnavailable: boolean;
  /** result of stat()-ing voices/qwen/qwen-<uuid>.pt */
  ptExists: boolean;
  /** currentQwenBaseModel() snapshot */
  currentBaseModel: string;
}

/** Pure. No fs, no async. */
export function classifyClonedVoice(input: ClassifyInput): ClonedVoiceClassification;

export interface BrokenClonedVoice { name: string; reason: NonNullable<ClonedVoiceClassification['reason']>; }

export interface ResolveChapterDeps {
  readEntry(uuid: string): Promise<import('../workspace/voice-library.js').VoiceLibraryEntry | null>;
  writeEntry(entry: import('../workspace/voice-library.js').VoiceLibraryEntry): Promise<void>;
  ptExists(storageKey: string): Promise<boolean>;
  deriveEngineArtifact: typeof import('./derive-engine-artifact.js').deriveEngineArtifact;
  readMasterPcm(uuid: string, entry: import('../workspace/voice-library.js').VoiceLibraryEntry): Promise<{ pcm: Buffer; sampleRate: number; refText: string }>;
  currentBaseModel(): string;
  reportProgress?(msg: string): void;
  signal?: AbortSignal;
}

/** For each requested cloned voice: classify, derive Repairable, collect Broken.
 *  Throws UnresolvableClonedVoiceError with the full Broken list if any is Broken. */
export async function resolveClonedVoicesForChapter(
  requests: Array<{ characterName: string; libraryUuid: string | undefined; engineUnavailable: boolean }>,
  deps: ResolveChapterDeps,
): Promise<void>;
```

```ts
// server/src/tts/synthesise-chapter.ts  (Task 4 — Produces the extended error)
export class UnresolvableClonedVoiceError extends Error {
  readonly broken: BrokenClonedVoice[];   // NEW — structured list
  // existing (characterName, detail?) constructor preserved via a static factory + overload
}
```

```ts
// server/src/workspace/purge-clone-artifacts.ts  (Task 2 — Produces)
export async function purgeCloneArtifacts(voiceUuid: string, opts?: { deleteEntryDir?: boolean }): Promise<void>;
```

---

### Task 1: Sidecar — atomic base `.pt` write (absorbs #1804)

**Files:**
- Modify: `server/tts-sidecar/main.py` — `QwenEngine.clone_voice` (~line 3850-3857), `QwenEngine.design_voice` (~line 3764-3767)
- Test: `server/tts-sidecar/tests/test_qwen_pt_atomic.py` (Create)

**Interfaces:**
- Consumes: the existing `_voice_paths(voice_id) -> (pt_path, json_path)` and the fake `torch.save` from `tests/test_qwen3.py`.
- Produces: no signature change — both call sites now write `pt_path` via a temp file + `os.replace` (atomic), matching the existing 1.7B path (`_load_voice_prompt_17b`, ~4204-4211).

**Why:** `deriveEngineArtifact` re-derives by having the sidecar overwrite `qwen-<uuid>.pt`. Today that write is a bare `torch.save(prompt, pt_path)` — a crash/kill mid-write corrupts the live `.pt` (the #1804 class). Making it atomic is the sidecar half of spec §5.6 "stat-before-remove".

**Scope note (M1):** there is a **third** bare `torch.save(prompt, pt_path)` at `main.py:~4011` (`mint_variant`, the emotion-variant clone prompt). It is **off the resolver's re-derive path** (re-derive hits `clone_voice`), so 3b2 correctness does not require it — Task 1 covers **only** `clone_voice` (~3857) and `design_voice` (~3767). If the atomic helper is trivially reusable there, hardening it too is welcome, but it is explicitly **not required** for this task's acceptance.

- [ ] **Step 1: Write the failing test**

```python
# server/tts-sidecar/tests/test_qwen_pt_atomic.py
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from test_qwen3 import fake_qwen_runtime  # noqa: F401  (pytest fixture)


def test_clone_voice_writes_pt_via_atomic_replace(fake_qwen_runtime, monkeypatch):
    """The base .pt must be written to a temp path then os.replace'd, never
    torch.save'd directly onto the live path (corruption window, #1804)."""
    engine = fake_qwen_runtime["engine"]
    saved_paths = []
    real_save = engine_torch_save_spy(engine, saved_paths)  # helper below
    replaced = []
    monkeypatch.setattr("main.os.replace", lambda a, b: (replaced.append((a, b)), real_os_replace(a, b))[1])

    import numpy as np
    engine.clone_voice("clone-atomic", np.zeros(24000, "<i2").astype("float32"), 24000, "hi", None)

    # torch.save target was a temp sibling, and os.replace moved it onto the final .pt
    assert saved_paths, "torch.save was never called"
    assert all(not p.endswith(f"{os.sep}clone-atomic.pt") for p in saved_paths), \
        "torch.save wrote the live .pt directly — no temp file"
    assert any(dst.endswith(f"{os.sep}clone-atomic.pt") for _src, dst in replaced), \
        "os.replace never promoted a temp file onto clone-atomic.pt"
```

_(The implementer writes the two tiny helpers `engine_torch_save_spy` / `real_os_replace` in the test; the point of the assertion is: torch.save targets a temp path, os.replace promotes it. Mirror the existing `test_qwen3.py` fixture use exactly.)_

- [ ] **Step 2: Run it to verify it fails** — `python -m pytest server/tts-sidecar/tests/test_qwen_pt_atomic.py -v` → FAIL (torch.save writes the live path today).

- [ ] **Step 3: Implement the atomic write.** Add a small module-level helper near the other IO helpers and use it at BOTH call sites:

```python
def _atomic_torch_save(obj, pt_path: str) -> None:
    """Write a torch object to pt_path atomically: temp sibling + os.replace,
    matching _load_voice_prompt_17b's persist (#1804 — no corruption window)."""
    d = os.path.dirname(pt_path)
    fd, tmp = tempfile.mkstemp(prefix=".pt-", dir=d)
    os.close(fd)
    try:
        torch.save(obj, tmp)
        os.replace(tmp, pt_path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
```

Replace `torch.save(prompt, pt_path)` at ~3767 (design) and ~3857 (clone) with `_atomic_torch_save(prompt, pt_path)`. (`tempfile` is already imported — it's used by the 1.7B path.)

- [ ] **Step 4: Run tests** — the new test PASSES; `python -m pytest server/tts-sidecar/tests/test_qwen3.py server/tts-sidecar/tests/test_qwen_clone_voice.py -q` stays green (design/clone `.pt` + `.json` still land).

- [ ] **Step 5: Commit** — `fix(sidecar): write qwen base .pt atomically (temp + os.replace)`

---

### Task 2: `purgeCloneArtifacts(uuid)` — total consent-scoped erasure

**Files:**
- Create: `server/src/workspace/purge-clone-artifacts.ts`
- Test: `server/src/workspace/purge-clone-artifacts.test.ts`

**Interfaces:**
- Consumes: `qwenVoicePtPath`/`qwenVoiceSidecarPath` (`routes/qwen-voice.ts` — or the underlying `qwenVoicesDir()` from `workspace/paths.ts`), `removeEntryDir` (`workspace/voice-library.ts:175`), `purgeVoiceSamples`, `getResolvedSidecarUrl`.
- Produces: `export async function purgeCloneArtifacts(voiceUuid: string, opts?: { deleteEntryDir?: boolean }): Promise<void>`.

**What it must erase** (storage key `qwen-<uuid>`, all under `voices/qwen/`): `qwen-<uuid>.pt`, `qwen-<uuid>.json`, **`qwen-<uuid>__1.7b.pt`** (the gap), `qwen-<uuid>-preview.pt`, `qwen-<uuid>-preview.json`, then `purgeVoiceSamples('qwen-<uuid>')`, then best-effort `POST {sidecar}/qwen/evict-voice {voiceId}`. When `opts.deleteEntryDir` (delete flow, not revoke) also `removeEntryDir(voiceUuid)`. **Files first, sidecar evict last.** Each file `rm(..., { force: true }).catch(() => {})`.

- [ ] **Step 1: Write the failing test** — assert that given fabricated files in a temp `voices/qwen/`, `purgeCloneArtifacts('u1')` removes all five artifact files **including `qwen-u1__1.7b.pt`**, calls `purgeVoiceSamples('qwen-u1')`, and does **not** remove the entry dir unless `deleteEntryDir:true`. Mock `getResolvedSidecarUrl`/`fetch` and assert the evict POST fires **after** the unlinks (ordering).

```ts
it('erases the base, 1.7B, manifest, and preview artifacts', async () => {
  // seed voices/qwen/qwen-u1.pt, .json, __1.7b.pt, -preview.pt, -preview.json
  await purgeCloneArtifacts('u1');
  expect(existsSync(ptPath('qwen-u1'))).toBe(false);
  expect(existsSync(pt17bPath('qwen-u1'))).toBe(false);        // the gap this closes
  expect(purgeVoiceSamples).toHaveBeenCalledWith('qwen-u1');
  expect(removeEntryDir).not.toHaveBeenCalled();
});
it('removes the entry dir only when deleteEntryDir is set', async () => {
  await purgeCloneArtifacts('u1', { deleteEntryDir: true });
  expect(removeEntryDir).toHaveBeenCalledWith('u1');
});
```

- [ ] **Step 2: Run it** → FAIL (module absent).

- [ ] **Step 3: Implement** — factor the erasure. The `__1.7b.pt` path is `qwenVoicePtPath('qwen-<uuid>__1.7b')` (the sanitizer leaves `_`/`.`/`-` intact, so the name is exact). Preview paths: `qwenVoicePtPath('qwen-<uuid>-preview')` + `qwenVoiceSidecarPath('qwen-<uuid>-preview')`.

```ts
export async function purgeCloneArtifacts(voiceUuid: string, opts: { deleteEntryDir?: boolean } = {}): Promise<void> {
  const key = `qwen-${voiceUuid}`;
  const files = [
    qwenVoicePtPath(key), qwenVoiceSidecarPath(key),
    qwenVoicePtPath(`${key}__1.7b`),
    qwenVoicePtPath(`${key}-preview`), qwenVoiceSidecarPath(`${key}-preview`),
  ];
  for (const f of files) await rm(f, { force: true }).catch(() => {});
  purgeVoiceSamples(key);
  // TODO(3c): when XTTS clone lands, also erase voices/xtts/xtts-<uuid>.pt here
  //   (spec §5.6). No xtts artifact exists on disk in 3b2, so omit it for now —
  //   but a future xtts clone would be un-erasable via this path if forgotten.
  if (opts.deleteEntryDir) await removeEntryDir(voiceUuid);
  try {
    await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: key }),
    });
  } catch { /* sidecar unreachable — non-fatal */ }
}
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit** — `feat(server): purgeCloneArtifacts erases all consent-scoped qwen artifacts`

---

### Task 3: Wire `purgeCloneArtifacts` into revoke + delete

**Files:**
- Modify: `server/src/routes/voice-library.ts` — `/:voiceUuid/revoke` (~784-796), `eraseLibraryVoiceArtifacts` (~807-831) / `DELETE /:voiceUuid` (~841-865)
- Test: `server/src/routes/voice-library.test.ts` (extend)

**Interfaces:** Consumes `purgeCloneArtifacts` (Task 2). The delete flow **replaces** the inline `eraseLibraryVoiceArtifacts` body with `purgeCloneArtifacts(voiceUuid, { deleteEntryDir: true })` (it currently misses `__1.7b.pt`). Revoke, after stamping `revokedAt` + `writeEntry`, calls `purgeCloneArtifacts(voiceUuid)` (no entry-dir removal — the manifest + `master.wav` are retained; only the resynthesis-capable artifacts are erased).

- [ ] **Step 1: Write the failing tests** — (a) `POST /:uuid/revoke` on a cloned entry stamps `revokedAt` **and** calls `purgeCloneArtifacts(uuid)` (spy) with no `deleteEntryDir`; the entry (voice.json + master.wav) still readable afterward. (b) `DELETE /:uuid?confirm=1` calls `purgeCloneArtifacts(uuid, { deleteEntryDir: true })` and — integration-style against a temp workspace — the `qwen-<uuid>__1.7b.pt` file is gone. **Non-placebo requirement (I2):** the delete test MUST stub `fetch` so the `/qwen/evict-voice` POST fails/no-ops (simulating the sidecar unreachable) — otherwise today's evict-voice path already removes `__1.7b.pt` and the assertion passes against un-fixed code. The test proves the **Node-side** unlink, so the sidecar must be mocked out of the picture.

- [ ] **Step 2: Run** → FAIL (revoke purges nothing; delete misses 1.7B).

- [ ] **Step 3: Implement.** Revoke handler, after `await writeEntry(updated);`:

```ts
await writeEntry(updated); // passes the guard — revokedAt is orthogonal
await purgeCloneArtifacts(voiceUuid); // erase resynthesis-capable artifacts on revoke
return res.status(200).json(updated);
```

Delete: replace the body of `eraseLibraryVoiceArtifacts` with a call to `purgeCloneArtifacts(voiceUuid, { deleteEntryDir: true })` (keep the function name as a thin wrapper, or inline the call — implementer's choice; preserve the existing call site in the DELETE handler).

- [ ] **Step 4: Run tests** → PASS; full `voice-library.test.ts` green.
- [ ] **Step 5: Commit** — `feat(server): erase clone artifacts on revoke, close 1.7B gap on delete`

---

### Task 4: Extend `UnresolvableClonedVoiceError` with a structured broken-list

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (~208-218)
- Test: `server/src/tts/synthesise-chapter-error.test.ts` (Create — small)

**Interfaces:**
- Produces: `UnresolvableClonedVoiceError.broken: BrokenClonedVoice[]` (imported from `clone-voice-resolver.ts` — see Task 5; to avoid a cycle, define `BrokenClonedVoice` in the resolver module and `import type` it here). The existing `(characterName: string, detail?: string)` constructor stays working (the 3b1 `applyQwenFallback` backstop still throws it) — add a **static factory** `UnresolvableClonedVoiceError.fromList(broken)` for the pre-pass.

- [ ] **Step 1: Write the failing test:**

```ts
it('fromList carries the structured broken voices and a readable message', () => {
  const e = UnresolvableClonedVoiceError.fromList([
    { name: 'Marlow', reason: 'revoked' }, { name: 'Reeve', reason: 'missing-master' },
  ]);
  expect(e).toBeInstanceOf(UnresolvableClonedVoiceError);
  expect(e.broken).toHaveLength(2);
  expect(e.message).toContain('Marlow');
  expect(e.message).toContain('Reeve');
});
it('the legacy single-name constructor still works (3b1 backstop)', () => {
  const e = new UnresolvableClonedVoiceError('Marlow');
  expect(e.broken).toEqual([{ name: 'Marlow', reason: 'engine-unavailable' }]);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add `readonly broken: BrokenClonedVoice[]`; the legacy ctor sets `broken = [{ name: characterName, reason: 'engine-unavailable' }]`; `static fromList(broken)` builds a message listing each `"<name>" (<reason>)` and re-enters the ctor path. Keep `name = 'UnresolvableClonedVoiceError'`.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `refactor(server): UnresolvableClonedVoiceError carries structured broken list`

---

### Task 5: The resolver module (classifier + async orchestrator)

**Files:**
- Create: `server/src/tts/clone-voice-resolver.ts`
- Test: `server/src/tts/clone-voice-resolver.test.ts`

**Interfaces:** exactly the block under "Interfaces" above. `classifyClonedVoice` is pure; `resolveClonedVoicesForChapter` takes injected deps (all fs/sidecar/consent access is a dep, so the test needs no real disk).

**Classification rules** (`classifyClonedVoice`), in order:
1. `entry.consent?.revokedAt` → `{ broken, reason: 'revoked' }`
2. `input.engineUnavailable` → `{ broken, reason: 'engine-unavailable' }`
3. `entry.engines.qwen?.status === 'failed'` → `{ broken, reason: 'derive-failed' }`
4. `.pt` missing (`!ptExists`) **or** stale (`qwen.baseModel && qwen.baseModel !== currentBaseModel`) **or** `status === 'stale'` → needs derive. If `entry.master` present → `repairable`; else → `{ broken, reason: 'missing-master' }`.
5. else → `healthy`.

_(Caller maps a cloned qwen slot with no `libraryUuid`, or `readEntry` → null, to `{ broken, reason: 'misconfigured' }` before classify — see Task 6.)_

**Orchestrator** (`resolveClonedVoicesForChapter`): for each request, if `libraryUuid` is falsy → collect Broken `misconfigured` and continue; else `readEntry(libraryUuid)` (null → Broken `misconfigured`); classify; if `repairable` → `reportProgress('Preparing voice "<name>"…')`, `readMasterPcm`, `deriveEngineArtifact(uuid, 'qwen', { masterPcm, sampleRate, refText })`, on success `writeEntry({ ...entry, engines: { ...entry.engines, qwen: { status: 'ready', baseModel: currentBaseModel() } } })`; on derive throw → **transient** (`status === 0 || status >= 500`) collects Broken `derive-failed` **without** persisting; **permanent** (`status >= 400 && status < 500`) persists `engines.qwen.status:'failed'` then collects Broken `derive-failed`. Collect all Broken; **after the loop**, if `broken.length` → `throw UnresolvableClonedVoiceError.fromList(broken)`.

- [ ] **Step 1: Write the failing tests (placebo-proof).** Table over `classifyClonedVoice`: revoked→broken/revoked; engineUnavailable→broken/engine-unavailable; status failed→broken/derive-failed; pt-missing+master→repairable; pt-missing+no-master→broken/missing-master; stale-baseModel+master→repairable; healthy→healthy. Then orchestrator tests with fake deps:
  - **the invariant, direct:** one revoked voice (fixture genuinely sets `entry.consent.revokedAt` — **not** a `readEntry`→null, which would throw `misconfigured` and pass this assertion vacuously wrt the *revoked* path, M3) ⇒ `resolveClonedVoicesForChapter` **rejects** with `UnresolvableClonedVoiceError`, `deriveEngineArtifact` was **never called** (spy asserts `not.toHaveBeenCalled`), no other voice produced.
  - repairable ⇒ `deriveEngineArtifact` called once, `writeEntry` stamps `status:'ready'` + current baseModel, resolves (no throw).
  - **transient** derive failure — cover **both** `{ status: 0 }` (unreachable) **and** `{ status: 500 }` (server error, I1) ⇒ Broken, `writeEntry` **not** called with `'failed'` (state left intact for retry). This is the anti-brick case: a 5xx must not persist `failed`.
  - **permanent** derive failure (`{ status: 422 }`) ⇒ Broken, `writeEntry` called with `status:'failed'`.
  - two Broken ⇒ the thrown error's `.broken` has both names.

- [ ] **Step 2: Run** → FAIL (module absent).
- [ ] **Step 3: Implement `clone-voice-resolver.ts`** per the rules. Import `UnresolvableClonedVoiceError` from `./synthesise-chapter.js` (Task 4) — or, to avoid an import cycle (synthesise-chapter will import the resolver), move `UnresolvableClonedVoiceError` **into** `clone-voice-resolver.ts` and re-export it from `synthesise-chapter.ts`. **Decision: define the error in the resolver module, re-export from synthesise-chapter** (keeps the 3b1 public import path `from './synthesise-chapter.js'` working for existing importers — grep and update none-to-few). Verify no existing importer breaks.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): cloned-voice resolver (classify + per-chapter derive/broken)`

---

### Task 6: Wire the pre-pass into `synthesiseChapter`

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (insert between ~998 and the title beat ~1076)
- Test: `server/src/tts/synthesise-chapter-cloned-resolver.test.ts` (Create)

**Interfaces:** Consumes `resolveClonedVoicesForChapter` (Task 5), `routeFor` (in-scope, line 931), `castById` (997), `groups` (998), `qwenUnavailable` (opt), `currentQwenBaseModel` (`./model-paths.js`). Builds the request list:

```ts
// after `const groups = buildSentenceGroups(sentences);`  (~998)
const inChapter = new Set(groups.map((g) => g.characterId));
// M2 — the title beat is narrated by the narrator but has no SentenceGroup, so a
// cloned narrator used ONLY for the title would escape the readiness gate. Union
// the narrator id in when a title beat will actually fire.
if (titleText) inChapter.add(narratorCharacterId);
const clonedRequests = cast
  .filter((c) => inChapter.has(c.id) && c.overrideTtsVoices?.qwen?.provenance === 'cloned')
  .map((c) => {
    const routedEngine = routeFor(c).engine;
    return {
      characterName: c.name ?? c.id,
      libraryUuid: c.overrideTtsVoices?.qwen?.libraryUuid,
      engineUnavailable: routedEngine !== 'qwen' || qwenUnavailable,
    };
  });
if (clonedRequests.length > 0) {
  await resolveClonedVoicesForChapter(clonedRequests, {
    readEntry, writeEntry, ptExists,          // ptExists: stat qwenVoicePtPath(`qwen-${uuid}`)
    deriveEngineArtifact, readMasterPcm,
    currentBaseModel: currentQwenBaseModel,
    reportProgress: (m) => onHeartbeat?.(m),  // reuse the existing progress channel
    signal,
  });
}
```

`readMasterPcm(uuid, entry)`: read `join(entryDir(uuid), entry.master.clipFile)` → decode WAV to s16le PCM (reuse `decodeAudioToPcm`) → `{ pcm, sampleRate: entry.master.sampleRate, refText: entry.master.transcript }`. Put `readMasterPcm`/`ptExists` as small local helpers or a tiny `clone-master-io.ts` (implementer's choice; keep them injectable so Task 5's tests stay pure). A misconfigured slot (`libraryUuid` undefined) is handled inside the orchestrator: `readEntry(undefined)`→null→Broken/misconfigured (add that guard in Task 5's orchestrator: `if (!libraryUuid) collect misconfigured`).

- [ ] **Step 1: Write the failing integration test** — drive `synthesiseChapter` with a two-sentence chapter, one character cast to a cloned qwen voice, faking the sidecar synth + the resolver deps. Cases:
  - a **revoked** cloned voice ⇒ `synthesiseChapter` **rejects** with `UnresolvableClonedVoiceError`, and the fake synth backend recorded **zero** calls (no title beat, no group synth) — fail-fast before GPU.
  - a cloned voice whose `characterId` is **not** in this chapter's groups ⇒ does **not** fail the chapter (readiness gate; per spec §5.4).
  - a **repairable** cloned voice ⇒ derive fires once, then the chapter synthesises normally.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the insertion + helpers; make the deps injectable enough for the test (e.g. accept an optional `__resolverDepsOverride` on `SynthesiseChapterOpts` for tests, or factor the dep-assembly so the test can seed a temp workspace — prefer the temp-workspace route to avoid a test-only opt if feasible).
- [ ] **Step 4: Run** → PASS; existing `synthesise-chapter*.test.ts` (incl. the 3b1 `-cloned-exemption` test) stay green.
- [ ] **Step 5: Commit** — `feat(server): per-chapter cloned-voice resolver pre-pass in synthesiseChapter`

---

### Task 7: Failure taxonomy — `cloned-voice-broken`

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` (union ~28-47, signatures ~93-279), `server/src/routes/failure-remediations.ts` (~160-165 as template)
- Test: `server/src/routes/failure-taxonomy.test.ts` (extend)

**Interfaces:** Consumes an `UnresolvableClonedVoiceError` thrown from `synthesiseChapter`; the generation route's existing catch (`routes/generation.ts:~2095`) already calls `classifyFailure(err, engine)` and broadcasts `chapter_failed { errorReason, errorCode, remediation }`. Add code `'cloned-voice-broken'` to the `FailureCode` union, a `FAILURE_SIGNATURES` entry matching `err.name === 'UnresolvableClonedVoiceError'` (or the message), and a `FAILURE_REMEDIATIONS['cloned-voice-broken']` entry: userMessage e.g. `A cloned voice in this chapter can't be used.`, remediation `Re-upload the voice's sample or reassign the character, then generate again.`

- [ ] **Step 1: Write the failing test** — `classifyFailure(UnresolvableClonedVoiceError.fromList([{name:'Marlow',reason:'revoked'}]), 'qwen')` returns `{ code: 'cloned-voice-broken', … }` and the remediation is defined.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — union member + signature (place it BEFORE any broad generic signature so first-match wins) + remediation copy.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): classify UnresolvableClonedVoiceError as cloned-voice-broken`

---

### Task 8: Frontend — chapter-failed toast + help link for the new code

**Files:**
- Modify: `src/store/generation-stream-runner.ts` (~358-394), the `helpHrefForFailureCode` map (find it — referenced from `views/generation.tsx:~1754`)
- Test: `src/store/generation-stream-runner.cloned.test.ts` (Create) or extend the existing runner test

**Interfaces:** Consumes the `chapter_failed` event with `errorCode:'cloned-voice-broken'`. Generalise the existing `'voice-not-designed'` immediate-toast branch (386-393) to also fire for `'cloned-voice-broken'` (same dedupe-key shape), and add a help anchor in `helpHrefForFailureCode`.

- [ ] **Step 1: Write the failing test** — dispatch a `chapter_failed` tick with `errorCode:'cloned-voice-broken'` + a chapterId; assert an error toast is pushed with a per-chapter dedupeKey, and `chapters-slice` records `generationErrorCode`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — widen the branch condition to a set `{ 'voice-not-designed', 'cloned-voice-broken' }`; add the help href.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): surface cloned-voice-broken chapter failure as a toast + help link`

---

### Task 9: Frontend — Broken/Repairable card chip + mock fixture

**Files:**
- Modify: `src/components/voices/voice-library-card.tsx` (`ProvenanceMarker` ~244-273; engine chip row ~134-140), `src/mocks/voice-library.ts` (`MOCK_VOICE_LIBRARY_ENTRIES` ~20-91)
- Test: `src/components/voices/voice-library-card.broken.test.tsx` (Create)

**Interfaces:** A cloned entry is **Broken** when `consent?.revokedAt` is set OR `master` is absent OR `engines.qwen?.status === 'failed'`; **Repairable** when `engines.qwen?.status === 'stale'` (self-heals at next render). Render a `Pill` — Broken → tone `danger` label `Needs attention`, Repairable → tone `warning` label `Will re-derive` — in the cloned `ProvenanceMarker` branch, with testid `voice-library-card-clonestate-<uuid>`. No new action button (repair is automatic at render; Broken tells the user to re-upload/reassign via the existing Revoke/Delete affordances). Add one Broken cloned fixture (`lib-cloned-revoked`, `consent.revokedAt` set) to the mock seed.

- [ ] **Step 1: Write the failing test** — render the card for a revoked cloned entry → the `danger` "Needs attention" chip shows; render a healthy cloned entry → it does not.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the derived state + chip + fixture. Keep the existing 'Cloned' badge + consent summary; add the chip beside them. No hex literals — use `Pill` tones.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): Broken/Repairable state chip on cloned voice-library cards`

---

### Task 10: Follow-up (a) — persist-without-cosine on an ECAPA transport failure

**Files:**
- Modify: `server/src/routes/voice-library.ts` — the `POST /clone` handler (~625, the `assessCloneFidelity` call)
- Test: `server/src/routes/voice-library.clone.test.ts` (extend)

**Interfaces:** `assessCloneFidelity` propagates a **transport** failure (`embedSegment` throws a plain `Error` tagged `{ transient: true }`, no `status`/`name`). Today that throws before `writeEntry`, orphaning the already-sidecar-written `.pt` and leaving the candidate. Wrap the fidelity call: on a `transient` embed error, **proceed** to `writeEntry` recording `sampleMeta.qualityChecks.cloneFidelityUnavailable: true` (and no `cloneCosine`), then `removeCandidate`. A genuine derive failure (upstream `SidecarDesignError`) still aborts as before.

- [ ] **Step 1: Write the failing test** — mock `deriveEngineArtifact` to succeed and `assessCloneFidelity` to reject with `Object.assign(new Error('embed down'), { transient: true })`; `POST /clone` returns **200** with a persisted entry whose `sampleMeta.qualityChecks.cloneFidelityUnavailable === true` and **no** `cloneCosine`; the candidate is removed. A second test: a real `SidecarDesignError` from `assessCloneFidelity` still 502s and persists nothing.
- [ ] **Step 2: Run** → FAIL (transport throw currently 502s and orphans).
- [ ] **Step 3: Implement** — `try { fidelity = await assessCloneFidelity(...) } catch (e) { if ((e as any)?.transient) { fidelityUnavailable = true } else throw e }`; thread the flag into the `qualityChecks` written at ~660.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(server): persist a clone without cosine when the ECAPA embed is unreachable`

---

## §2.3 — Designed-voice clip-persist (OPTIONAL TAIL — confirm scope before starting)

> **STOP.** Tasks 11–12 implement spec §2.3 (designed voices also retain a `master.wav` for consistent orphan-repair across a base-model upgrade). This is **quality, not the never-substitute correctness** Tasks 1–10 deliver, and cloned voices do not depend on it. The controlling thread must confirm with the user whether to include §2.3 in this PR or defer it before dispatching Task 11. If deferred, file it as a backlog item and skip to Task 13.

### Task 11 (optional): Sidecar — `design_voice` persists its reference clip as WAV

**Files:** Modify `server/tts-sidecar/main.py` (`design_voice`, insert near the `_atomic_torch_save(prompt, pt_path)` at ~3767); Create `server/tts-sidecar/tests/test_design_clip_persist.py`.

**Decision (location):** write the reference clip to `voices/qwen/qwen-<uuid>__master.wav` (sidecar-local, keyed like the other artifacts — keeps `design_voice`'s HTTP response unchanged, strictly additive). The reference clip is the live float waveform `ref_audio` + `ref_sr` (both still in scope at 3767). Add a minimal WAV writer (float→int16 via the existing `_float_audio_to_int16_le`, wrapped in a `wave` header). `purgeCloneArtifacts` (Task 2) must then also erase `qwen-<uuid>__master.wav` — add it to the file list.

- [ ] Steps: failing pytest (`design_voice(...)` writes `<uuid>__master.wav`, and it's the same clip that was distilled — assert against `engine._base.prompt_calls[-1][0]`) → implement the WAV writer + write → green; extend `purge-clone-artifacts` to erase it → commit `feat(sidecar): retain designed-voice reference clip as master.wav`.

### Task 12 (optional): designed-voice orphan self-heal from the retained clip

**Files:** Modify `server/src/tts/clone-voice-resolver.ts` (or a sibling) + wiring so a **designed** voice whose `.pt` is orphaned/stale re-derives from `qwen-<uuid>__master.wav` via a sidecar re-distil, instead of drifting. Scope carefully — designed voices are not consent-gated and CAN render from a stale base today, so this is self-heal-for-consistency only. **If Task 11 is deferred, Task 12 is moot.**

- [ ] Steps: failing test → implement → green → commit.

---

### Task 13: Docs — regression plan 268 + release notes + INDEX + BACKLOG

**Files:**
- Create: `docs/features/268-fs38-wave3b2-resolver.md` (from `docs/features/TEMPLATE.md`; `status: active`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md` (in-progress version section), `docs/BACKLOG.md`

**Content:** 268 documents the invariants (never-substitute; fail-fast readiness gate intersected to in-chapter characters; transient-vs-permanent derive; total artifact erasure incl. `__1.7b.pt`; atomic base `.pt`), the automated coverage map, and the owed on-box acceptance (a real revoked voice fails a live render loud; a base-bumped voice re-derives identically; the 1.7B artifact is gone after revoke). Release-notes: a technical line in `release-notes-next.md` (Refs #624) and a brand-voice user line in `RELEASE_NOTES.md`. If §2.3 deferred, file its backlog row here.

- [ ] **Step 1:** Write 268 from TEMPLATE; fill Benefit/Invariants/Test-plan.
- [ ] **Step 2:** Add the INDEX entry under fs-38; append both release-notes lines; add/adjust the BACKLOG row.
- [ ] **Step 3: Commit** — `docs(docs): fs-38 Wave 3b2 resolver regression plan + release notes`

---

## Self-Review

**Spec coverage:** §5.2 resolver pre-pass → T5/T6; transparent re-derive/orphan self-heal → T5/T6; revocation-at-render → T5 (revoked→Broken) + T6; §5.4 fail-fast + readiness gate (in-chapter intersection) → T6; §5.5 1.7B allowed + consent-scoped → T2 (`__1.7b.pt` erasure) — no new gating added, per decision; §5.6 stat-before-remove → T1 (sidecar atomic) + T5 (manifest-transactional); `purgeCloneArtifacts` → T2/T3; §7 atomicity/status-preservation → unchanged from 3b1 + T10; §2.3 → T11/T12 (optional); follow-up (a) → T10; follow-up (b) consent-revoked-at-render → T5/T6 (revoked→Broken). Failure surfacing (spec §5.4 named list) → T7/T8/T9.

**Placeholder scan:** none — every code step carries real code or a precise, testable assertion.

**Type consistency:** `ClonedVoiceState`, `BrokenClonedVoice`, `ClassifyInput`, `ResolveChapterDeps` defined once (Task 5) and consumed by Tasks 4/6; `UnresolvableClonedVoiceError.broken` typed against `BrokenClonedVoice`; `FailureCode` extended once (Task 7) and consumed by Task 8. The import-cycle risk (synthesise-chapter ↔ resolver) is resolved by defining the error in the resolver and re-exporting.
