# Wave 5 step 2 — A45: `speaker-qa.txt` reqHash fix drives a one-time `pip-in-place` reinstall

Issue: Castwright#2614 (wave 5 of the on-box register campaign, #2435; step 2 of #2606). Track: sidecar venv only, no GPU needed.

Worktree: `wt-2606-onbox-wave5` @ branch `docs/docs-2606-onbox-wave5`.

## Path chosen

**Path A — Pinokio Update (`.venv-stamp.json`)**, driven directly through `bootstrap-venv.mjs`'s real `classifyVenvState`/`decideVenvAction` logic (the same module `pinokio-scripts/update.js` calls into). Path A was picked over Path B because it needs only a Node CLI invocation against `SIDECAR_VENV_DIR` — an existing, already-tested env-var override point — with no in-app zip-upload UI flow required. The row's own criteria say one path is sufficient; both exercise the same decision core.

## Box-safety setup — throwaway venv copy, never the live one

**Before, baseline (PowerShell, recursive file count + total size):**
```
Count = 56542
Sum bytes = 6483355726
.venv-stamp.json: {"pythonTag":"cp312","profile":"nvidia","reqHash":"0c9201fe777769dd2902a688d364258cb7d18e030aba5b9475917da0854d93f9","builtVersion":"1.9.0"}
```

Copied `C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv` to a scratch path with `robocopy /E /COPY:DAT /MT:16`. Robocopy summary:
```
Dirs :      6087      6087         1         0         0         0
Files :     56542     56542         0         0         0         0
Bytes :   6.038 g   6.038 g         0         0         0         0
```
0 mismatches, 0 failures. Post-copy verification on the copy matched baseline exactly (`Count = 56542`, `Sum = 6483355726`).

All reinstall runs below were pointed at the copy via `SIDECAR_VENV_DIR` (`bootstrap-venv.mjs`'s own documented override — `process.env.SIDECAR_VENV_DIR ?? join(REPO_ROOT, 'server', 'tts-sidecar', '.venv')`). The live venv was never opened for write.

## Seeding a genuine pre-#2588 stamp

The row's own note is load-bearing: on a venv with **no** prior `.req-hash`/stamp at all, any non-null hash triggers a reinstall regardless of whether `speaker-qa.txt` is in it — that would prove nothing. So the copy's `.venv-stamp.json` was overwritten with a **real, computed** pre-#2588 2-file hash, not a fresh/absent one:

```js
// computeReqHash from venv-migration.mjs, against this worktree's actual requirement files
oldHash (overlay + base only)            = 064ba5e99bf0235d4948128ffbb3be997a5c60ebc4461e0004b251a1d96a3c47
newHash (overlay + base + speaker-qa.txt) = 118368d28f6120e6e6e8b80924abcd18c4345a689571e7e96b809443752e2929
```

Seeded copy stamp (pythonTag/profile unchanged, so `decideVenvAction` classifies strictly on the reqHash mismatch, per the row's own instruction):
```json
{
  "pythonTag": "cp312",
  "profile": "nvidia",
  "reqHash": "064ba5e99bf0235d4948128ffbb3be997a5c60ebc4461e0004b251a1d96a3c47",
  "builtVersion": "1.9.0"
}
```

(Note: this seeded hash is unrelated to the live venv's own actual stamp value — the live venv already carries a newer requirements state from other work. The seed only needs to be a genuine pre-#2588 2-file hash so the run under test is a real hash-mismatch, which it is.)

## Run 1 — `node bootstrap-venv.mjs` against the seeded copy (`SIDECAR_VENV_DIR` set)

Launched detached, output redirected, polled to exit.

```
[bootstrap-venv] pre-installing torch from the nvidia index (https://download.pytorch.org/whl/cu128)
...
[bootstrap-venv] installing requirements (nvidia overlay; this can take several minutes)
...
[bootstrap-venv] swapping ONNX runtime → the nvidia GPU build
[bootstrap-venv] done
```

stderr: only pip's own "new release available" notices — no errors.

**Action taken: `pip-in-place`** (not `noop`, not a rebuild) — confirmed by the log sequence itself: `classifyVenvState` only reaches the torch-preinstall/pip-install/ORT-swap sequence on the `pip-in-place` branch of `bootstrap-venv.mjs`'s `main()`; the `needs-reinstall` branch prints a FAIL message and exits 1 without running pip at all, and `noop` prints a single "up to date" line (exactly what Run 2, below, produced). `pythonTag`/`profile` were unchanged from the seed, so per the module's own logic this classification came strictly from the `reqHash` mismatch.

Post-run stamp on the copy:
```
"reqHash": "118368d28f6120e6e6e8b80924abcd18c4345a689571e7e96b809443752e2929"
```
This is exactly the `newHash` computed above (3-file hash including `speaker-qa.txt`) — the stamp now records the new hash.

Post-run package check on the copy:
```
$ .venv-copy/Scripts/python.exe -m pip show speechbrain huggingface_hub
Name: speechbrain          Version: 1.1.0
Name: huggingface_hub      Version: 0.36.2
```
Both match `speaker-qa.txt`'s current pins (`speechbrain==1.1.0`, `huggingface_hub==0.36.2`).

## Run 2 — same copy, same command, no changes in between

```
[bootstrap-venv] venv up to date — nothing to do
```
stderr: empty.

**Action taken: `noop`.** The second run against the now-current stamp performed no pip work at all — confirming the reinstall is genuinely one-time, not repeated on every run.

## Verdict on the one-time claim

**Confirmed one-time.** Run 1 (mismatched stamp) → `pip-in-place`, real pip install, stamp updated to the new 3-file hash. Run 2 (matching stamp, no other change) → `noop`, no pip work. A fix that reinstalled every time would have produced `pip-in-place` again on Run 2; it did not.

## Cleanup / box-safety verification

- Throwaway venv copy deleted (`Remove-Item -Recurse -Force`) after Run 2 completed.
- Live venv byte-verified unchanged, before this run and after cleanup (identical method, PowerShell recursive file count + total size):
  ```
  Before: Count=56542  Sum=6483355726
  After:  Count=56542  Sum=6483355726
  ```
  `.venv-stamp.json` on the live venv is byte-identical before and after (`reqHash` still `0c9201fe...93f9`, untouched by anything in this run — the seeded/updated hashes above only ever existed on the throwaway copy).
- No other register row touched. No source file edited — `venv-migration.mjs`, `bootstrap-venv.mjs`, `accelerator-profile.mjs` were read, not modified.
- No book/workspace data touched.
- `git status` on the worktree is clean except this new evidence file.

## Verdict

**A45: DISCHARGED**, via Path A's four bullets:
1. `pip-in-place` (not `noop`, not a full rebuild) — confirmed from the run's own log sequence and action classification.
2. `speaker-qa.txt`'s pins (`speechbrain==1.1.0`, `huggingface_hub==0.36.2`) present afterward — confirmed via `pip show`.
3. `.venv-stamp.json` now records the new 3-file hash — confirmed byte-for-byte against the independently computed `newHash`.
4. A second run is a `noop` — confirmed live (Run 2).

The claim under test — that the `speaker-qa.txt` reqHash fix drives a **one-time** `pip-in-place` reinstall, not a repeated one — is verified against a real venv through the real `bootstrap-venv.mjs`/`venv-migration.mjs` code path, not synthetic stamps or a source read.
