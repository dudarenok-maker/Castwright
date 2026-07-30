/* fs-38 Wave 3b2, Task 2 — total consent-scoped erasure for a cloned Qwen
   voice. Both the revoke-consent flow (keep the voice-library entry, wipe
   the engine artifacts) and the delete-entry flow (wipe everything,
   including the entry dir) route through here, so neither can partially
   erase a clone and leave an orphaned artifact — the ad-hoc cleanup this
   replaces used to miss the `__1.7b.pt` variant for exactly that reason.

   Files are removed FIRST, the sidecar cache-evict LAST (best-effort): if
   the evict fails the artifacts are still gone; doing it the other way
   round risks the sidecar lazily reloading a "deleted" voice from disk
   between the evict and the unlink. */

import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
// Review I5 — qwenVoicePtPath now comes from paths.js, its actual home
// (alongside its qwenVoiceSidecarPath/qwenVoiceWavPath siblings), not from
// routes/qwen-voice.js. That route module re-exports it only for its own
// legacy call sites; pulling it from there dragged an Express router — and
// transitively synthesise-chapter.ts — into the workspace layer for what is
// just a path.join. No cycle exists today, but this removes a latent one.
import {
  qwenVoicePtPath,
  qwenVoiceSidecarPath,
  qwenVoiceWavPath,
  qwenVoicesDir,
  xttsVoiceDeriveSrcTmpWavPath,
  xttsVoiceLatentsPath,
  xttsVoiceSidecarPath,
  xttsVoicesDir,
} from './paths.js';
import { entryDir, removeEntryDir, updateEntry } from './voice-library.js';
import { djb2, purgeVoiceSamples } from '../tts/voice-sample-cache.js';
import { CLONE_ENGINE_LIST, cloneStorageKey } from '../tts/clone-engines.js';
import { getResolvedSidecarUrl } from './user-settings.js';

/** Review I-2 — a single file's best-effort unlink. `force: true` already
    swallows "doesn't exist" (the common case — most callers only have SOME
    of these artifacts); a `.catch` firing here means the file exists but
    couldn't be removed (e.g. Windows EBUSY/EPERM because the sidecar has it
    open mid-`torch.load`). For a contract whose whole promise is *total*
    erasure, that must not be swallowed silently — log it loudly and report
    the path back to the caller instead.

    GATE 1 fix (C2) — also RETURNS whether the file is now gone, so a caller
    that mirrors an unlink into persisted state (the `deleteMasterClip`
    branch below, which clears the manifest's `master` pointer) can only do
    so once the file it points at is actually gone. `true` covers
    "already absent" too — `force: true` makes a missing file a success, and
    that is exactly right for a pointer-clearing caller. */
async function unlinkTracked(f: string, voiceUuid: string, failed: string[]): Promise<boolean> {
  try {
    await rm(f, { force: true });
    return true;
  } catch (err) {
    failed.push(f);
    console.warn(
      `[purge-clone-artifacts] failed to erase "${f}" for voice "${voiceUuid}" — artifact may still be on disk:`,
      err,
    );
    return false;
  }
}

/** GATE 1 fix (C5) — erase every file in `dir` that belongs to one of this
    voice's artifact keys, instead of only the fixed, deterministic paths the
    `files` list below names.

    Why a sweep is required: the sidecar's `_atomic_torch_save` /
    `_atomic_wav_save` (main.py) stage each write through
    `tempfile.mkstemp(dir=…, prefix=f"{basename}.", suffix=".tmp")` and only
    unlink that sibling in an `except BaseException` handler — which a hard
    kill skips entirely. `npm start` tears the sidecar down with
    `taskkill /T /F` on Windows, and an OOM kill mid-derive on an 8 GB card is
    a scenario this project has already hit. The leftovers are RANDOMLY named
    (`xtts-<uuid>.pt.<rand>.tmp`, `xtts-<uuid>.derive-src.tmp.wav.<rand>.tmp`,
    and the qwen equivalents), so no addition to a fixed path list can reach
    them: revoke reported clean erasure while the conditioning latents — and
    the real person's raw reference clip — survived on disk indefinitely.
    Property 2 says every artifact the voice can be rebuilt or rendered from
    is destroyed; a stranded `.pt.<rand>.tmp` renames straight back into a
    loadable artifact.

    Matching is ANCHORED on a full artifact key plus a `.` boundary: a name
    either IS the key or begins with `key + '.'`. That is deliberately not a
    bare `startsWith(key)` — uuids are `randomUUID()`/`nanoid()`, so
    `qwen-<uuidA>` can be a genuine prefix of `qwen-<uuidB>`, and an unanchored
    match would erase another person's voice. Keys never contain `.`, so the
    boundary is unambiguous. Each key's own basename is derived FROM the path
    helper (`basename(qwenVoicePtPath(k), '.pt')`) rather than re-sanitised
    here, so the sweep can never drift from the filenames those helpers
    actually produce.

    Exact-case, matching how the fixed paths are computed: the sidecar is only
    ever handed the canonical lower-case key (`cloneStorageKey`), so a
    case-varied temp sibling is not a state it can produce.

    `alreadyAttempted` holds the basenames the caller's fixed `files` list has
    already tried, and they are skipped here. The sweep is strictly ADDITIVE:
    without this, a canonical path whose unlink just failed (EBUSY) would be
    retried by the sweep, and a second attempt that happened to succeed would
    leave the path recorded in `failed` while the file is in fact gone —
    reporting incomplete erasure that did complete, the mirror image of the
    mis-report this module exists to prevent. */
async function sweepKeyPrefixedFiles(
  dir: string,
  keyBasenames: string[],
  voiceUuid: string,
  failed: string[],
  alreadyAttempted: ReadonlySet<string>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    // No voices dir yet — nothing was ever derived, so nothing to erase.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    // Anything else (EPERM, EACCES) means we cannot PROVE the directory is
    // clean. Report it rather than letting an unreadable dir read as total
    // erasure — that is the exact mis-report this fix exists to prevent.
    failed.push(`sweep:${dir}`);
    console.warn(
      `[purge-clone-artifacts] could not scan "${dir}" for stray artifacts of voice ` +
        `"${voiceUuid}" — crash-orphaned temp files may still be on disk:`,
      err,
    );
    return;
  }
  for (const name of names) {
    if (alreadyAttempted.has(name)) continue;
    if (!keyBasenames.some((b) => name === b || name.startsWith(`${b}.`))) continue;
    await unlinkTracked(join(dir, name), voiceUuid, failed);
  }
}

/** Task 14a (fix round 1, MEDIUM-1) — "connection refused" specifically means
    nothing is listening on the sidecar port at all: no process, no
    in-process cache, so a lost evict against a DOWN sidecar has erased
    nothing (erasure genuinely IS total). That is the common case for anyone
    with `autoStartSidecar` off, and treating it identically to a REAL lost
    evict would mean `artifactPurgeIncomplete` fires on every single revoke
    for that user — a signal that cries wolf on the common case trains
    operators to ignore it, including the one time it means a genuine leak.

    Node's fetch surfaces a refused connection as `TypeError: fetch failed`
    with `.cause.code === 'ECONNREFUSED'`; this also matches a bare
    "ECONNREFUSED" string so a plain `Error('ECONNREFUSED')` (as used in
    tests, and as some platforms surface it with no structured cause) is
    recognised too. Deliberately narrow: a timeout (the AbortSignal below
    firing — the sidecar IS running but wedged, so its cache is very much
    still there) and any other network error are NOT treated as
    "nothing to lose" — those stay reported as failures below, because
    unlike a refused connection, they carry no proof the cache is empty. */
function isSidecarNotRunning(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string; message?: string } | undefined;
  if ((e?.cause?.code ?? e?.code) === 'ECONNREFUSED') return true;
  return /ECONNREFUSED/i.test(e?.message ?? '');
}

/** fs-38 Wave 3c, Task 13 — one sidecar cache-evict POST, shared by the qwen
    base/`-preview` calls and the xtts call below (same shape: `{ voiceId }`
    JSON body). Independently attempted/reported per call so one engine's
    unreachable sidecar can't skip — or hide — another's evict outcome.

    Task 14a — this used to be a bare `catch {}` that discarded the outcome
    entirely, and it never even inspected the response status: a *reached*
    sidecar that answered non-2xx (evict itself failed) read as success
    exactly like a real one. Both failure shapes — non-2xx and
    timeout/rejection — are now returned to the caller instead of dropped,
    because file erasure alone is not "erasure is total" for XTTS: a failed
    evict here leaves the voice's latents resident in
    `CoquiEngine._latents_cache` for the rest of the sidecar process's
    lifetime — unlike the qwen prompt cache, which IS cleared whenever the
    base Qwen model itself unloads, XTTS's latents cache has no TTL/idle
    reclaim of its own to fall back on. Still never retried here — see the
    caller-side note on `purgeCloneArtifacts`'s `failed` accumulator for
    why. The one exception is `isSidecarNotRunning` above (fix round 1,
    MEDIUM-1) — a refused connection reports clean, not failed.

    M24 (review) — `res.ok` on `/xtts/evict-voice` is narrower than it
    reads: main.py's own docstring on that route spells out that `{"ok":
    true}` means only "the cache entry and epoch are updated", NOT "any
    in-flight render for this voice has stopped" (a render already past
    its epoch check when the call lands still completes and returns
    audio). This module reads only the JSON `{ok, evicted}` shape, never
    main.py, so that caveat is otherwise invisible from here — recorded
    at the one Node-side call site both engines' evicts share. */
/* #1951 — exported (was module-private) so the designed-voice self-heal in
   clone-voice-resolver.ts can evict after restoring a manifest. That restore
   puts the designed `language` back on disk while the sidecar's warm
   `_prompt_cache` still holds the "English" the re-derive cached, and
   `/qwen/evict-voice`'s own docstring names the mechanism: "the cache has no
   on-disk mtime check". Without the evict, disk and cache disagree and a
   sidecar RESTART silently changes the audio. The resolver takes it as an
   INJECTED dep, never a direct import — see that module's header. */
export async function evictSidecarVoice(
  route: 'qwen' | 'xtts',
  voiceId: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const res = await fetch(`${getResolvedSidecarUrl()}/${route}/evict-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId }),
      // Fix wave (review I-2) — this purge's `deleteMasterClip` branch below
      // runs its OWN `updateEntry` call (not this one — this evict happens
      // after that branch returns); the genuine "caller already holds the
      // per-uuid lock" case is the cloned-resolver's revoked/gone
      // status-stamp mutate, which calls `purgeCloneArtifacts` from INSIDE
      // its own `updateEntry` mutate (see `clone-voice-resolver.ts`). A
      // wedged/OOM'd sidecar that accepts the connection but never responds
      // would otherwise park that uuid's lock indefinitely in that case —
      // including a user-initiated revoke's own SECOND `updateEntry` call,
      // right after this one. Bound it instead of leaving it unbounded.
      //
      // Task 14a correction (Task 14 review) — the 10s figure is NOT sized
      // against a Python-side synth lock. `/qwen/evict-voice` takes only
      // `qwen._cache_lock` around a dict pop; `/xtts/evict-voice` takes
      // only `coqui._latents_lock` around a membership test plus an epoch
      // bump. Neither touches `_synth_lock` or does GPU work, so the
      // sidecar side of this call is cheap — the bound exists purely to
      // protect the NODE-side per-uuid lock above from a wedged/OOM'd
      // process that never responds at all. Three evicts run sequentially
      // per `purgeCloneArtifacts` call (2× qwen + 1× xtts), so the
      // worst-case total wait is 3 × 10s = 30s, not 10s.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, detail: `sidecar responded ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    if (isSidecarNotRunning(err)) return { ok: true };
    // Any other network error, or the 10s AbortSignal firing — the sidecar
    // IS (or might be) running, so its cache state is genuinely unknown.
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Review I-2 — returns the paths (if any) that could NOT be removed, so a
    caller (e.g. the revoke route) can surface a partial-erasure warning
    instead of silently claiming a clean 200.

    Task 14a — `failed` now ALSO carries a failed/timed-out sidecar cache
    evict, marked `sidecar:<qwen|xtts>:<voiceId>` (not a real fs path — this
    is the transport already wired to the caller, and the revoke route only
    ever checks its length/reads it as opaque diagnostic strings). Before
    this, a failed evict was swallowed by a bare `catch {}` with no
    accumulator of its own, so revoke could answer 200 with no
    `artifactPurgeIncomplete` while XTTS's TTL-less latents cache still held
    the voice.

    Deliberately NOT retried: `purgeCloneArtifacts` can be called from
    inside an `updateEntry` per-uuid mutate elsewhere (the cloned-resolver's
    revoked/gone status-stamp, `clone-voice-resolver.ts`), and a retry loop
    would extend that lock hold for a best-effort step — the evict endpoint
    is deliberately lock-free precisely so a slow/wedged sidecar can't block
    it, but a Node-side retry would still serialise onto the SAME per-uuid
    lock this function may already be running inside of. The actual
    security enforcement is the `revokedAt`/entry-deleted state, not sidecar
    cache residency — the resolver classifies a revoked voice as
    unrenderable without ever consulting sidecar cache presence — so
    surfacing the failure (for a human/ops retry via a second revoke call)
    is enough; silently blocking longer on an operation whose own contract
    says "never block" is not. Still best-effort/never-throws for every
    other step — only the per-file and per-evict outcomes are tracked. */
export async function purgeCloneArtifacts(
  voiceUuid: string,
  opts: { deleteEntryDir?: boolean; deleteMasterClip?: boolean } = {},
): Promise<{ failed: string[] }> {
  const key = `qwen-${voiceUuid}`;
  // fs-38 Wave 3c, Task 13 — the canonical `xtts-<uuid>` storage key
  // (cloneStorageKey('coqui', uuid)), same convention Task 24's audition
  // cache will match. Unlike qwen, Coqui/XTTS has no design/preview flow, so
  // there's no `-preview` variant to sweep here.
  const xttsKey = cloneStorageKey('coqui', voiceUuid);
  const files = [
    qwenVoicePtPath(key),
    qwenVoiceSidecarPath(key),
    qwenVoicePtPath(`${key}__1.7b`),
    qwenVoicePtPath(`${key}-preview`),
    qwenVoiceSidecarPath(`${key}-preview`),
    // M2 (review) — the preview's own 1.7B variant, the same gap the base
    // key's `__1.7b.pt` fix (above) closed, just for the `-preview` key.
    qwenVoicePtPath(`${key}-preview__1.7b`),
    // §2.3 (fs-38 Wave 3b2, optional Task 11) — a DESIGNED voice's retained
    // reference clip. No-op (rm force) for a plain clone, which never has one.
    qwenVoiceWavPath(`${key}__master`),
    // Fix wave (consent-erasure gap) — the PREVIEW design also writes its own
    // `<key>-preview__master.wav` (see qwen-voice.ts design-voice with
    // preview:true). Never renamed onto the real key unless promoted (see the
    // promote-voice best-effort rename), so an unpromoted/rejected preview's
    // clip must be erasable here too, mirroring the preview .pt/.json above.
    qwenVoiceWavPath(`${key}-preview__master`),
    // fs-38 Wave 3c, Task 13 — the Coqui/XTTS clone artifact set. THREE
    // paths, not two: `_pt`/`_json` are the durable derived latents +
    // manifest, but `xttsVoiceDeriveSrcTmpWavPath` is the real person's
    // SOURCE audio — `CoquiEngine.clone_voice` (main.py) writes it to derive
    // the latents and deletes it in a `finally` on every testable path, but
    // it survives a hard/external process kill. A leftover copy is exactly
    // the Phase 0 consent-hole class this wave exists to close, so purge
    // must attempt-delete it too (rm force already tolerates not-found).
    xttsVoiceLatentsPath(xttsKey),
    xttsVoiceSidecarPath(xttsKey),
    xttsVoiceDeriveSrcTmpWavPath(xttsKey),
  ];
  const failed: string[] = [];
  for (const f of files) await unlinkTracked(f, voiceUuid, failed);
  /* GATE 1 fix (C5) — then sweep both voices dirs for anything else carrying
     one of this voice's artifact keys, which is how the sidecar's randomly
     named `<basename>.<rand>.tmp` staging siblings get erased (see
     `sweepKeyPrefixedFiles`). The fixed `files` list above is KEPT rather
     than replaced by the sweep: it is what reports the canonical,
     consent-critical paths into `failed` by name even when the directory
     itself cannot be read.

     Both engines, not just xtts: `_atomic_torch_save`/`_atomic_wav_save` back
     the qwen design/clone writes too (main.py), so the qwen dir has the
     identical hole. Fixing only the engine the finding was reported against
     is the exact "applied where found, never swept across its siblings"
     mistake that produced C4.

     Each base is the artifact key's real on-disk basename, taken from the
     path helper so the sanitisation can never drift. */
  const attempted = new Set(files.map((f) => basename(f)));
  await sweepKeyPrefixedFiles(
    qwenVoicesDir(),
    [
      key,
      `${key}__1.7b`,
      `${key}-preview`,
      `${key}-preview__1.7b`,
      `${key}__master`,
      `${key}-preview__master`,
    ].map((k) => basename(qwenVoicePtPath(k), '.pt')),
    voiceUuid,
    failed,
    attempted,
  );
  await sweepKeyPrefixedFiles(
    xttsVoicesDir(),
    [basename(xttsVoiceLatentsPath(xttsKey), '.pt')],
    voiceUuid,
    failed,
    attempted,
  );
  // fs-38 Wave 3c, Task 2 — sweep every audition-cache scope this voice
  // could have been rendered under, not just the canonical `qwen-<uuid>`
  // scope. Two independent gaps closed here:
  //   1. `xtts-<uuid>` — this used to only ever sweep the qwen prefix, so an
  //      XTTS clone's own canonical-scope auditions (voice-library.ts's own
  //      /sample mirror route, once XTTS clone assignment lands) were never
  //      reachable by ANY purge call.
  //   2. `raw-<engine>-<djb2(storageKey)-hash6>` — the cast-view audition
  //      route's raw-speaker bypass (routes/voice-sample.ts:112) caches
  //      under this scope when a client hands a cloned storage key straight
  //      to `rawSpeaker`. It never contains the voiceUuid as a literal
  //      prefix, but it IS fully reconstructable here with no cast/book
  //      context — its hash has no sample-text input, unlike the regular
  //      per-character cache scope below.
  // This does NOT reach the cast-view route's regular (non-raw) per-
  // character scope (`char-<bookId>__<id>` or the character's own voiceId)
  // — that scope folds the sample TEXT into its hash too, which this
  // function has no way to know, so a stale file cached there before a
  // revoke can outlive this sweep. The consent gate in voice-sample.ts is
  // what actually closes that path (checked fresh on every request, cache
  // hit or not) — this sweep is defence in depth on top, not the primary
  // guarantee.
  // Review (minor) — CLONE_CAPABLE_ENGINES is, by its own definition
  // (clone-engines.ts), always exactly {'qwen','coqui'}; a per-iteration
  // isCloneEngine() guard here was therefore unreachable dead code.
  // Fix wave (B2) — CLONE_ENGINE_LIST is the CloneEngine[]-typed sibling of
  // CLONE_CAPABLE_ENGINES (same members, no cast needed to iterate as
  // CloneEngine for cloneStorageKey below).
  for (const engine of CLONE_ENGINE_LIST) {
    const storageKey = cloneStorageKey(engine, voiceUuid);
    purgeVoiceSamples(storageKey);
    const hash6 = djb2(storageKey).toString(36).slice(0, 6);
    purgeVoiceSamples(`raw-${engine}-${hash6}`);
  }
  if (opts.deleteMasterClip && !opts.deleteEntryDir) {
    /* User-directed (revoke must also erase the recording) — this is still
       revoke, not delete: the manifest + entry dir are kept so the card
       stays visible with its revoked state, but the person's actual
       recording is erased right alongside the derived engine artifacts
       above. Read the entry to find the clip's filename (it doesn't follow
       the `qwen-<uuid>*` naming convention the `files` list above uses —
       it's whatever `clipFile` the ingest step wrote), unlink it, then clear
       `master` so the manifest never points at a file that's gone. A plain
       delete (`deleteEntryDir`, moved BELOW the evicts by the GATE 1 C3 fix)
       doesn't need any of this — it removes the whole entry dir, clip
       included, in one shot. No-op when the entry or its `master` field is
       already absent.

       fs-38 Wave 3c, Task 14 — read+clear+write through the shared, per-uuid
       -locked `updateEntry` rather than a bare readEntry/writeEntry pair, so
       a concurrent engine-slot write elsewhere (e.g. an in-flight xtts
       derive) landing between the read and the write can't be clobbered by
       this clearing the `master` field off a stale snapshot. The unlink
       itself runs inside `mutate`, under the same lock, so nothing else can
       observe (or write) this entry between "the clip is gone from disk"
       and "the manifest stops pointing at it".

       GATE 1 fix (C2) — the `master` field is now cleared ONLY when the
       unlink actually succeeded. `unlinkTracked` never throws (it records
       the path in `failed` and returns false), so clearing the pointer
       unconditionally orphaned the person's real recording on disk with
       nothing left naming it: this module's own doc comment tells the
       operator to retry by POSTing /revoke again, but that retry read
       `fresh.master === undefined`, returned early, re-attempted nothing,
       and answered a CLEAN 200 with no `artifactPurgeIncomplete`. The
       documented remedy was guaranteed to mis-report total erasure of a
       file that is still there. Keeping the pointer on failure is what
       makes the retry able to find the clip again. */
    await updateEntry(voiceUuid, async (fresh) => {
      if (!fresh?.master) return null;
      const erased = await unlinkTracked(
        join(entryDir(voiceUuid), fresh.master.clipFile),
        voiceUuid,
        failed,
      );
      if (!erased) return null;
      return { ...fresh, master: undefined };
    });
  }
  // M2 (review) — evict both the base and `-preview` sidecar cache entries so
  // a `-preview` clone-prompt can't linger resident in sidecar memory after
  // "every artifact" was supposedly erased. Each POST is independently
  // best-effort — one failing must not skip the other. Task 14a — each
  // outcome is now recorded into `failed` instead of discarded.
  for (const voiceId of [key, `${key}-preview`]) {
    const result = await evictSidecarVoice('qwen', voiceId);
    if (!result.ok) {
      failed.push(`sidecar:qwen:${voiceId}`);
      console.warn(
        `[purge-clone-artifacts] sidecar evict failed for qwen voice "${voiceId}" ` +
          `(library voice "${voiceUuid}") — it may still be resident in the sidecar's ` +
          `in-process cache:`,
        result.detail,
      );
    }
  }
  // fs-38 Wave 3c, Task 13 — the xtts-<uuid> sidecar cache entry
  // (CoquiEngine._latents_cache), via /xtts/evict-voice (Task 11). No
  // `-preview` variant — see the `xttsKey` comment above.
  const xttsEvictResult = await evictSidecarVoice('xtts', xttsKey);
  if (!xttsEvictResult.ok) {
    failed.push(`sidecar:xtts:${xttsKey}`);
    console.warn(
      `[purge-clone-artifacts] sidecar evict failed for xtts voice "${xttsKey}" ` +
        `(library voice "${voiceUuid}") — XTTS's latents cache has no TTL and may retain ` +
        `the voice until the sidecar process restarts:`,
      xttsEvictResult.detail,
    );
  }
  /* GATE 1 fix (C3) — the manifest dir comes off LAST, and ONLY when every
     other step came back clean. Repo-owner ruling, settled; do not
     re-litigate.

     Why conditional: `voice.json` is what both consent gates read
     (`clonedVoiceLacksConsent` in voice-library.ts, called from
     routes/voice-sample.ts and routes/voice-library.ts's /sample). A `null`
     entry reads as "not blocked". So removing the manifest while an artifact
     survived the purge left that survivor LESS gated after the delete than
     before it — the entry could no longer even be revoked, because there was
     nothing left to stamp `revokedAt` on. Retaining it keeps the card
     visible and the voice recoverable: the user can retry the delete, or
     revoke, and either one can still reach the artifact that stayed behind.

     Why after the evicts (unlike the engine-artifact unlinks, which the
     module header deliberately keeps FIRST): whether the manifest may go at
     all depends on the FULL `failed` set, and a lost sidecar evict leaves the
     voice resident in `CoquiEngine._latents_cache` — a surviving artifact
     that needs gating exactly like a surviving `.pt`. Safe to reorder because
     the sidecar never reads the voice-library entry dir (only
     `voices/{qwen,xtts}`), so the header's "unlink before evict, or the
     sidecar may lazily reload from disk" rationale does not apply to it. */
  if (opts.deleteEntryDir) {
    if (failed.length === 0) {
      await removeEntryDir(voiceUuid);
    } else {
      console.warn(
        `[purge-clone-artifacts] KEEPING the voice-library manifest for "${voiceUuid}" — ` +
          `${failed.length} artifact(s) survived the purge, and removing the manifest would ` +
          `leave them ungated (the consent gates read it). Retry the delete, or revoke:`,
        failed,
      );
    }
  }
  return { failed };
}
