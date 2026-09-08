# Step 7 — E11: Pinokio Install/Update CRLF requirements normalization (Castwright#2961)

Parent #2950, campaign #2435. Discharged register row **E11**
(`docs/testing/onbox-acceptance-register.md:4683-4714`, #2596, PR #2799) —
`renormalizeRequirementsCrlf()` (`pinokio-scripts/lib/resolve-release.js`,
landed as `d6d54114`), including the documented one-update-lag behaviour.

## Operator-approved documented substitute (release gap)

Same gap as step 6/E7: the CRLF fix (`d6d54114`, 2026-08-29) has never
shipped in a published release (`releases/latest` still returns v1.14.0,
2026-07-23) and no local tag past v1.14.0 exists either — `resolve-release`'s
real or fallback resolution can never reach it today. Operator decision
(2026-09-08, on issue #2961): **documented substitute**, same mechanism as
E7 — `LATEST_URL` patched to an unreachable host in the throwaway's own
local, never-pushed copy of `resolve-release.js`, paired with a local-only
`vX.Y.Z` tag so the **unmodified** fallback-resolution code picks it up.

### A confound found and fixed along the way

The first substitute tag pointed at current `main` tip. For E7 that's fine
(the fix is server-side, decoupled from release content), but for E11 it
is **not**: `main` tip's `requirements/*.txt` files have genuinely drifted
from v1.14.0's (unrelated dependency bumps — fastapi/uvicorn, kokoro-onnx,
etc. — confirmed via `git diff --ignore-space-at-eol v1.14.0 main --
server/tts-sidecar/requirements/`). Checking out a tag with **any** real
content difference rewrites the files regardless of the CRLF fix, which
would have manufactured a false-positive "it normalized!" result for the
wrong reason. Fixed by isolating: a local-only commit built as v1.14.0 +
**only** `d6d54114`'s own diff (`pinokio-scripts/lib/resolve-release.js`),
plus its two undeclared same-era dependencies pulled in the same way once
each gap surfaced — `scripts/git-env.mjs` (required by the `require()` at
the top of the fixed file, added later in `953a4d1`) and the
`.gitattributes` `eol=lf` pin for `requirements/*.txt` itself (added by
`ddcf3c2a`, the mechanism `renormalizeRequirementsCrlf`'s re-checkout
actually depends on to materialize LF — without it, the re-checkout step
just writes CRLF right back, since `git checkout --` respects the
*target* commit's own attributes, not the working file's history).
Verified `git diff --ignore-space-at-eol v1.14.0 v1.15.0 --
server/tts-sidecar/requirements/` is empty before trusting any result below
— the substitute changes nothing but the fix mechanism itself.

## Precondition confirmed real (not assumed)

Per the row's own text. Throwaway `castwright-e11-throwaway` (`pterm
download`), pinned to **v1.14.0** — genuinely predates `requirements/*.txt`'s
`eol=lf` pin (added 2026-08-21, `ddcf3c2a`, five weeks after v1.14.0
shipped), so a real Windows checkout with `core.autocrlf=true` (confirmed:
`git config --global core.autocrlf` → `true`) materializes it CRLF-mangled
on disk even though the blob itself is LF-only. Confirmed via `file`:

```
requirements/amd-rocm.txt:    ... with CRLF line terminators
requirements/base.txt:        ... with CRLF line terminators
requirements/cpu.txt:         ... with CRLF line terminators
requirements/nvidia-cuda.txt: ... with CRLF line terminators
requirements/speaker-qa.txt:  ASCII text (no CRLF — short file, no effect)
```

`xxd` on `base.txt` (offset 0x00–0x2f) — plain, no `\r`, confirming this is
autocrlf materialization of an LF blob, not a content difference:
`# Vendor-neutral sidecar dependencies (Phase 1 l[...]`. Baseline venv built
in full (conda env + `npm ci` ×2 + `npm build` + `bootstrap-venv.mjs`);
stamp `reqHash: d70adb3c5d478b...`, `builtVersion: "1.14.0"`.

## One-update-lag, exactly as documented in the fix's own comment

`update.js`'s own comment (and `resolve-release.js`'s, on
`renormalizeRequirementsCrlf`): "Pinokio loads THIS file from the currently
checked-out release... a user updating FROM a release that predates this
function will run the old version... The fix only takes effect starting
with their NEXT update." Reproduced both halves:

**Update #1** (OLD, pre-fix `resolve-release.js` — the one physically on
disk at v1.14.0 — is what actually runs): resolves via the substitute
fallback, checks out the fix-containing commit successfully (HEAD now has
the fix on disk), **but the currently-*executing* code doesn't call
`renormalizeRequirementsCrlf` at all**, so:

```
requirements/*.txt: still CRLF-mangled after Update #1
.venv-stamp.json:   reqHash UNCHANGED (d70adb3c5d478b...) — noop branch
```

**Update #2** (the fix-containing `resolve-release.js` is now the one that
loads and runs): same target, but this time the executing code *does* call
`renormalizeRequirementsCrlf` after its own checkout:

```
requirements/*.txt: normalized to LF (grep -c $'\r' → 0, all five files)
```

## Idempotency

Ran `resolve-release.js` a third time on the now-normalized tree: `md5sum
-c` against the post-Update-#2 hashes reports `OK` for all five files —
unchanged, confirming the normalizer reports "already normalized" behaviour
rather than re-touching stable files.

## No spurious *ongoing* reinstall (criterion 5)

The CRLF→LF conversion is a genuine raw-byte change (reqHash is
byte-based, not content-normalized, per the `.gitattributes` comment
itself), so the **one-time** rebuild after Update #2 legitimately re-hashed
(`reqHash` moved from `d70adb3c...` to `d35ddc80...`) and reinstalled —
that is not spurious, it is the expected one-time cost of a legacy CRLF
install catching up. What matters is the **steady state** afterward:
running the full update sequence again on the now-LF tree reports
`[bootstrap-venv] venv up to date — nothing to do` — confirming
`classifyVenvState` sees a stable, matching `reqHash` and takes the noop
branch, exiting before `runInstall`, exactly as the row asks.

## Fresh Install (criterion 6)

Second throwaway `castwright-e11-fresh`, plain `pterm download` (no
substitute needed for this half — a real fresh clone lands on `main`
directly, which already has both the fix code and the `eol=lf` pin, so it
never has stale bytes to begin with — `file` confirms plain LF
immediately post-clone). Ran `resolve-release.js` directly against this
tree (same substitute technique, tagged at `main` itself, to exercise the
exact code path rather than assume it): completed cleanly, no error,
requirements stayed LF throughout — confirming the fix's re-checkout step
is a safe no-op when there is nothing stale to fix, i.e. `install.js`
"proceeds with the normal install flow" as the row asks.

## Not in scope

E1's macOS half. E7 (separate step, step 6, its own evidence file). Any
register edit (step 9 is the sole writer).
