---
status: draft
date: 2026-08-05
---

# Device-Token Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every device token a `scope` of `'full' | 'companion'`, enforce
it on the **read** path, and restrict a companion token to the nine method+path
pairs the Android app actually calls — closing #898's scope half. The TTL half
shipped in `74fb2901` and is not re-opened.

**Architecture:** Two PRs in a fixed order. **A** is Dart-only
(`apps/android/**` → the `app.yml` lane) and closes two latent client defects
*before* the server can produce the responses that trigger them. **B** is
server-only (`server/**` → `verify.yml`'s `server` scope,
`.github/workflows/verify.yml:158`) and adds the enum, the read-path rejection,
the pure allowlist module, and the middleware enforcement.

**Tech Stack:** TypeScript (Node 20, Express 5) + Vitest for the server; Dart /
Flutter + `flutter test` for the companion.

**Design of record:**
[`docs/superpowers/specs/2026-08-05-device-token-scope-design.md`](../specs/2026-08-05-device-token-scope-design.md)

**Verification note against the spec.** Every `file:line` in this plan was
re-opened against `main` @ `447eb522` while the plan was written. Four spec
statements did not survive; each is corrected inline and listed in
[§Corrections to the spec](#corrections-to-the-spec). Nothing in the design was
changed — the corrections are to citations, to the collateral inventory, and to
one testability assumption that adds a step (A-T1 Step 1).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **PR A merges before PR B, and an updated APK is installed on the acceptance
  phone between them.** See [§The PR split](#the-pr-split). This ordering is
  load-bearing; inverting it strands offline-first users.
- **Default deny.** An unmatched method+path is denied for `companion` scope.
  A new server route is unreachable from the phone until a row is added.
- **The load-bearing guard is on the READ path**, inside `findValidDevice`
  (`server/src/workspace/device-tokens.ts:52-65`) — not on the mint path. A
  required `createDevice` parameter is a prompt, not the guarantee: it cannot
  constrain `server/src/routes/pairing.test.ts:66`'s untyped 2-arity `vi.mock`,
  a hand-edited `device-tokens.json`, or a merge conflict.
- **Match `req.originalUrl`, never `req.path`.** The guard is mounted on an
  **array** path (`server/src/app.ts:122`,
  `app.use(['/api', '/workspace'], requireLanToken)`), so Express presents
  `path=/info` for **both** `/api/info` and `/workspace/info`. Patterns written
  against `req.path` punch a hole through the other mount.
- **Patterns are anchored (`^…$`), method-aware, and matched RAW** — no
  percent-decoding, no case folding. `makeBookId` (`server/src/workspace/paths.ts:117-118`)
  composes ids from the Unicode-preserving `slug` (`paths.ts:110-112`), so every
  non-Latin book yields a percent-encoded `bookId` in flight on all nine rows.
- **These five invariants must survive, each with a test:**
  1. Loopback always bypasses (`server/src/lan-auth.ts:209`) — the host UI is never scope-checked.
  2. The guard stays off unless LAN mode **and** a token are both set (`lan-auth.ts:203-204`, `:208`).
  3. The shared secret `LAN_AUTH_TOKEN` keeps full access (`lan-auth.ts:213-214`).
  4. The `lastSeenAt` touch keeps firing (`device-tokens.ts:132-136`) **including for a request that is then scope-denied**.
  5. A companion token can never reach `POST /api/pair/session` (`server/src/routes/pairing.ts:50`, mounted post-guard at `app.ts:142`) or `POST /api/devices/pair-session` (`server/src/routes/devices.ts:54`, mounted `app.ts:141`). Either on the allowlist restores full access via a `full`-scope browser mint at `pairing.ts:145`.
- **Every guard ships with a named mutation that turns something RED, and the
  mutation must be red under the DEFAULT config.** `server/vitest.config.ts`
  carries a suite-wide `retry: 1` (see its own header, `:66-107`). A mutation
  that only goes red under `--retry=0` is a finding, not a pass — report it.
- **No `openapi.yaml` change**, therefore no `src/lib/api-types.ts` regen.
  Measured: zero `'401':` entries; the two `'403':` entries (`openapi.yaml:1173`,
  `:2661`) are route-level cloned-voice consent denials, a different kind of
  thing from a middleware-level cross-cutting status.
- **No new registry knob, no new env var**, so no `config:sync` and no
  Advanced-Settings row.
- **Do not touch `redactDevice`** (`device-tokens.ts:67-76`). Adding `scope` to
  `PublicDevice` breaks the exact-match `toEqual` at
  `server/src/workspace/device-tokens.pure.test.ts:55-61` and is not asked for.
  File it as a follow-up instead (Task B-T5).
- Commit convention `<type>(<scope>): <subject>`; scopes are `app` (PR A) and
  `server` (PR B). Branch shape `<type>/<scope>-<slug>`.

---

## The PR split

**Two PRs, and they must be two, not one.**

| PR | Branch | Tree | CI lane | Issue link |
|---|---|---|---|---|
| **A** | `fix/app-device-token-scope-client` | `apps/android/**` only | `.github/workflows/app.yml` (path filter `:10-16`) | `Refs #898` |
| **B** | `feat/server-device-token-scope` | `server/**` only | `verify.yml` `server` scope (`:158`) | `Closes #898` |

### Why A before B

1. **Row 5 (the audio file) is a livelock.** `player_controller.dart:435-436`
   is `if (status == 401 || status == 403) { cfg.onRepairNeeded(); }`, and
   `onRepairNeeded` is wired to `_openPairing()` (`apps/android/lib/main.dart:258`,
   `:301`). B makes a 403 reachable on the stream path; without A, deny →
   re-pair prompt → the user re-pairs → `pairing.ts:118` mints a *fresh
   companion-scoped* token → identical denial → forever.
2. **B makes legacy records 401, and without A that 401 reads as "server
   offline".** `probeReachable` (`apps/android/lib/src/data/companion_runtime.dart:229-236`)
   wraps `api.getJson('/api/info')` (`:231`) in a bare `catch (_) { return false; }`.
   An offline-first user with a fully downloaded library **never streams**, so
   they never reach `player_controller.dart:436` — the only `onRepairNeeded`
   invocation site in the tree. They see a permanently unreachable server, with
   no prompt to re-pair, indefinitely.

### Why they cannot be one PR

The APK ships as a **separate artifact** — `release.yml` publishes a standalone
`castwright-vX.Y.Z.apk` and `npm run apk:companion` stamps an
auto-incrementing `versionCode` so builds update-install on their own schedule.
A single PR puts the client fix and the server enforcement on `main` at the same
instant, which is precisely the state that has no safe window: an installed APK
in the field still runs the pre-A client while the server denies. Two PRs create
the window — merge A, build and install the APK on the acceptance phone,
*then* merge B.

They touch disjoint trees and disjoint CI lanes, so they cannot conflict.

### What breaks if the order is inverted

B-then-A: every companion in the field enters the livelock on the first
streamed chapter, and every offline-first companion holding a legacy
(scope-less) record reports the server permanently offline with no recovery path
from the phone. Both are unrecoverable **from the device** — the only fix is a
desktop-side revoke plus a manual re-pair the user has no prompt to perform.

### #2144

**Recommended first, not a dependency.** This design has no migration argument
(unscoped records are rejected, not grandfathered), so nothing here rests on the
TTL being unconditional. What is real is a textual collision: #2144 rewrites
`device-tokens.ts:60` and B inserts adjacent to it, and both add rows to
`device-tokens.pure.test.ts`. If #2144 has not merged when B is cut, proceed —
just rebase B onto it if it lands mid-flight.

---

## File Structure

| File | PR | Responsibility |
|---|---|---|
| `apps/android/lib/src/data/companion_runtime.dart` | A | extract + fix the reachability probe (`:229-236`) |
| `apps/android/lib/src/data/player_controller.dart` | A | 401/403 split at `:435` |
| `apps/android/lib/src/data/api_client.dart` | A | the `:91-92` message |
| `apps/android/test/data/companion_runtime_test.dart` | A | M18 |
| `apps/android/test/data/player_controller_test.dart` | A | M10 |
| `apps/android/test/data/api_client_test.dart` | A | R2's nine per-call-site pins |
| `server/src/device-scope.ts` | B | **new** — pure leaf: the nine-row allowlist + `companionAllows` + `pathnameOf` |
| `server/src/device-scope.test.ts` | B | **new** — R1 exact-equality pin + allow/deny cases |
| `server/src/workspace/device-tokens.ts` | B | `DeviceScope`, schema 3, read-path rejection, `authenticateDeviceToken`, 3-arity `createDevice` |
| `server/src/lan-auth.ts` | B | scope enforcement + denial log in `requireLanToken` (`:207-219`) |
| `server/src/lan-auth.test.ts` | B | mock rewrite, `mkReq` extension, enforcement cases |
| `server/src/lan-auth.invariants.test.ts` | B | the static `createDevice` call-site guard |
| `server/src/routes/pairing.ts` | B | `'companion'` at `:118`, `'full'` at `:145` |
| `server/src/routes/devices.ts` | B | `'full'` at `:46` |
| `server/src/routes/pairing.test.ts` | B | 3-arity mock + `lastCall?.[2]` assertions |
| `server/src/workspace/device-tokens.pure.test.ts` | B | `rec()` gains `scope`; three inline literals; new rejection cases |
| `server/src/workspace/device-tokens.test.ts` | B | six 2-arity `createDevice` calls + three record literals + two `isValidDeviceToken` assertions |
| `server/src/routes/devices.test.ts` | B | three 2-arity `createDevice` calls — **and one behavioural trap, see B-T1 Step 5** |
| `docs/testing/onbox-acceptance-register.md` + `…-live-view.html` | A, B | one row each |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | A, B | one entry each, per PR |

---

## Collateral inventory — everything the change breaks

The spec names three sites. **There are ten.** Every one below was opened. A
task that does not fix all of them leaves `npm run typecheck` red.

### Compile errors from `scope` becoming non-optional on `DeviceTokenRecord`

| Site | Shape | Fix |
|---|---|---|
| `device-tokens.pure.test.ts:14-24` | `rec()` — explicitly typed `: DeviceTokenRecord` return, **no `...over` spread** ⇒ TS2741 | add `scope: over.scope ?? 'companion'` — the **restrictive** default, so an under-specified test fails rather than passes |
| `device-tokens.pure.test.ts:65` | inline `const d = { id, label, tokenHash, createdAt, expiresAt }` → `findValidDevice([d], …)` | add `scope: 'companion'` |
| `device-tokens.pure.test.ts:70` | same shape (the legacy-`expiresAt` case) | same |
| `device-tokens.pure.test.ts:75` | same shape (the injected-`now` case) | same |
| `device-tokens.test.ts:44` | `const fresh = {…}` → `shouldTouchLastSeen(fresh, now)` | add `scope: 'companion'` |
| `device-tokens.test.ts:46` | `const never = {…}` → same | same (`stale` at `:45` spreads `fresh`, so it inherits) |

### Compile errors from `createDevice` gaining a required 3rd parameter

`server/src/routes/pairing.test.ts:66`'s mock is the **one real bypass** — a
2-arity function is assignable where 3 are expected, so it does *not* error.
Every other call site does:

| Site | Fix |
|---|---|
| `devices.test.ts:141` | `createDevice('Phone', 30, 'full')` — **must be `'full'`, see the trap below** |
| `devices.test.ts:154` | `'full'` (revoked before use; either value works, keep it uniform) |
| `devices.test.ts:246` | `'full'` (label-capping test, scope irrelevant) |
| `device-tokens.test.ts:53` | `'full'` |
| `device-tokens.test.ts:58` | `'full'` |
| `device-tokens.test.ts:63` | `'full'` |

> **The trap.** `devices.test.ts:140-151` ("the LAN guard accepts a minted
> device token from a non-loopback client") drives the **real, un-mocked**
> `requireLanToken` (`devices.test.ts:84-86` imports it via `vi.importActual`)
> against `mkReq` (`devices.test.ts:51-59`), which supplies `ip`, `socket`,
> `headers`, `query` — and **no `method`, `url`, `originalUrl` or `path`**. If
> that mint passes `'companion'`, the guard reads `undefined` for method and
> path, denies, and the test goes RED for a reason that has nothing to do with
> what it tests. Pass `'full'`.

### Breakage from renaming `isValidDeviceToken` → `authenticateDeviceToken`

| Site | Shape | Fix |
|---|---|---|
| `lan-auth.test.ts:8-10` | `vi.mock('./workspace/device-tokens.js', …)` exporting **only** `isValidDeviceToken` — once `lan-auth.ts` imports a different name, the mock supplies nothing and **every test in the file** fails | rewrite the factory (B-T3 Step 1) |
| `device-tokens.test.ts:59` | `expect(dt.isValidDeviceToken(token)).toBe(true)` | `expect(dt.authenticateDeviceToken(token)).not.toBeNull()` |
| `device-tokens.test.ts:73` | same | same |

### Not collateral — verified

- `server/src/routes/devices.test.ts:31`, `:84`, `:95` and
  `device-tokens.test.ts:34` are **comments** naming `isValidDeviceToken`.
  Update the prose for accuracy; nothing compiles against them.
- The frontend never calls the mint. Measured (`grep -rn "api/devices" src/`):
  the only three call sites are `src/lib/api.ts:7055` (pair-session),
  `:7062` (list) and `:7067` (revoke), plus generated types at
  `src/lib/api-types.ts:2240`, `:2268`. No `POST /api/devices` consumer exists
  in this repo.

---

# PHASE A — the Dart client (Refs #898)

Branch: `fix/app-device-token-scope-client`, worktree off `main`.
Every file is under `apps/android/**`, so `app.yml` is the only CI lane that
fires (`app.yml:10-16` path-filters `apps/android/**`; **no** `verify.yml`
scope regex anchors on `apps/` — measured against all nine, `verify.yml:146`,
`:158`, `:159`, `:160`, `:161`, `:170`, `:171`, `:179`, `:182`).

Run all Dart commands from `apps/android/`.

---

### Task A-T1: A handshake 401 must reach `onRepairNeeded` (M18)

**Files:**
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (`:229-236`)
- Test: `apps/android/test/data/companion_runtime_test.dart`

**Interfaces:**
- Produces: a top-level, testable `probeServerReachable(...)`.
- Consumes: nothing.

> **Why Step 1 exists — the spec's M18 is not writable as specified.** The
> probe is a closure inside `CompanionRuntime.forConnection`
> (`companion_runtime.dart:133`), a `static Future<CompanionRuntime>` factory
> that calls `getApplicationDocumentsDirectory()`, `LibraryDatabase.open()` and
> `DiskFileStore()`. Its only callers are `main.dart:255` and `:301`, and
> `companion_runtime_test.dart:520-521` states in-tree that
> "`CompanionRuntime.forConnection` itself stays device-glue (path_provider,
> real sockets, connectivity) and is exercised on-device, not here." There is
> no way to reach the closure from a test. The probe must be extracted first.

- [ ] **Step 1: Extract the probe to a testable top-level function**

In `companion_runtime.dart`, above the `CompanionRuntime` class, add:

```dart
/// The AutoSyncService reachability handshake — GET /api/info.
///
/// Extracted from [CompanionRuntime.forConnection] so it can be tested:
/// the factory itself is device-glue (path_provider, real sockets) and is
/// exercised on-device only.
///
/// A 401 means the token no longer authenticates — expired, revoked, or (since
/// #898) a legacy record with no `scope`. Swallowing it as "offline" strands an
/// offline-first user forever: they have a downloaded library, so they never
/// stream, so they never reach the ONE other onRepairNeeded site
/// (player_controller.dart:436). They must be sent to the pairing screen.
///
/// A 403 must NOT re-pair. It is an AUTHORIZATION failure — re-pairing mints a
/// fresh token with the SAME scope, so the prompt would loop forever. Report
/// unreachable and let the server-side denial log carry the diagnosis.
Future<bool> probeServerReachable(
  ApiClient api, {
  required void Function() onRepairNeeded,
}) async {
  try {
    await api.getJson('/api/info');
    return true;
  } on ApiException catch (e) {
    if (e.statusCode == 401) onRepairNeeded();
    return false;
  } catch (_) {
    return false;
  }
}
```

Then replace the `probeReachable:` argument at `companion_runtime.dart:229-236`
with:

```dart
      probeReachable: () =>
          probeServerReachable(api, onRepairNeeded: onRepairNeeded ?? () {}),
```

`ApiException` is thrown for both 401 and 403 by `getJson`
(`api_client.dart:91-92`) and declares `implements Exception`
(`api_client.dart:42`), so the untyped `catch (_)` below it still catches every
transport failure.

Verify: `flutter analyze` is clean.

- [ ] **Step 2: Write the three tests**

Add to `apps/android/test/data/companion_runtime_test.dart` a new group. Use a
fake `ApiClient` (or a fake transport injected into a real one — match whatever
`api_client_test.dart` already does) whose `getJson` throws on demand.

```dart
group('probeServerReachable', () {
  test('401 -> reports unreachable AND asks for a re-pair', () async {
    var repairs = 0;
    final api = _ThrowingApi(ApiException(401, 'Not authorised'));
    expect(await probeServerReachable(api, onRepairNeeded: () => repairs++), isFalse);
    expect(repairs, 1);
  });

  // A 403 is an AUTHORIZATION failure. Re-pairing mints a token with the same
  // scope, so the prompt would loop forever — the exact livelock #898's client
  // half exists to close, one endpoint over from the stream path.
  test('403 -> reports unreachable and does NOT ask for a re-pair', () async {
    var repairs = 0;
    final api = _ThrowingApi(ApiException(403, 'scope-denied'));
    expect(await probeServerReachable(api, onRepairNeeded: () => repairs++), isFalse);
    expect(repairs, 0);
  });

  // probeReachable runs on EVERY network change. An over-broad fix that
  // re-paired on any failure would open the pairing screen every time the
  // phone leaves Wi-Fi.
  test('a transport failure -> unreachable, no re-pair', () async {
    var repairs = 0;
    final api = _ThrowingApi(const SocketException('no route'));
    expect(await probeServerReachable(api, onRepairNeeded: () => repairs++), isFalse);
    expect(repairs, 0);
  });

  test('success -> reachable, no re-pair', () async {
    var repairs = 0;
    final api = _OkApi();
    expect(await probeServerReachable(api, onRepairNeeded: () => repairs++), isTrue);
    expect(repairs, 0);
  });
});
```

- [ ] **Step 3: Run**

Run: `flutter test test/data/companion_runtime_test.dart`
Expected: PASS, 4 new tests.

- [ ] **Step 4: Prove each test can fail — three mutations**

| Mutation | Expected RED |
|---|---|
| **M18** — delete the `on ApiException catch` clause, leaving only `catch (_) { return false; }` | the 401 test (`repairs` is 0, expected 1) |
| widen to `if (e.statusCode == 401 \|\| e.statusCode == 403)` | the 403 test |
| move `onRepairNeeded()` into the bare `catch (_)` | the transport-failure test **and** the 403 test |

Run each, record the failing test name, revert. **All three must be red under
plain `flutter test`** — no retry flag exists on this lane, so the default
config is the only config.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/companion_runtime.dart apps/android/test/data/companion_runtime_test.dart
git commit -m "fix(app): a handshake 401 opens the pairing screen instead of reading as offline"
```

---

### Task A-T2: A 403 on the stream path must not force a re-pair (M10)

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart:435`
- Test: `apps/android/test/data/player_controller_test.dart`

**Interfaces:**
- Consumes: `LoopbackProxy.lastUpstreamStatus` (`loopback_proxy.dart:31`, set at `:100`).
- Produces: nothing new — routes 403 into the existing `_notifyDownloadToPlay()` channel (`player_controller.dart:442-444`).

- [ ] **Step 1: Write the failing test**

`player_controller_test.dart` already has the 401 cases at `:899` and `:969`,
built through the `FakeProxy()..lastUpstreamStatus = …` helper (`:901`, `:972`)
and the controller factory at `:810` which takes an `onRepair` callback.
Measured: **no 403 case exists** (`grep -n "403" player_controller_test.dart`
returns nothing). Add one next to `:899`, mirroring its arrange/act:

```dart
// #898: a 403 is a SCOPE denial. Re-pairing mints a token with the same
// scope, so routing it to onRepairNeeded is an infinite loop. The honest
// outcome is the existing "download to play" channel.
test('errorStream with lastUpstreamStatus 403 -> download prompt, NOT onRepairNeeded',
    () async {
  var repairs = 0;
  final proxy = FakeProxy()..lastUpstreamStatus = 403;
  // …same wiring as the 401 case at :899, with onRepair: () => repairs++
  expect(repairs, 0, reason: 'a scope denial must never re-pair');
  expect(downloadToPlayEvents, contains(<the chapter uuid>));
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `flutter test test/data/player_controller_test.dart`
Expected: FAIL — `repairs` is 1. Record the message; this is the fails-before
evidence.

- [ ] **Step 3: Make the change**

`player_controller.dart:435`, inside `_handleStreamFailure`:

```dart
    // 401 = authentication: the token is expired/revoked/legacy, and a re-pair
    // genuinely fixes it. 403 = authorization (#898 scope denial): a fresh
    // token carries the SAME scope, so a re-pair prompt loops forever. Route it
    // to the honest outcome — this chapter cannot be streamed, download it.
    if (status == 401) {
      cfg.onRepairNeeded();
    } else {
      _notifyDownloadToPlay();
    }
```

Also update the doc comment at `:426-427`, which currently reads "either
re-pairs (fresh 401/403)".

- [ ] **Step 4: Run to verify it PASSES, and that 401 still re-pairs**

Run: `flutter test test/data/player_controller_test.dart`
Expected: PASS — the new 403 test **and** the pre-existing `:899` / `:969` 401
tests, unchanged.

- [ ] **Step 5: Prove the mutations**

| Mutation | Expected RED |
|---|---|
| **M10** — restore `if (status == 401 \|\| status == 403)` | the new 403 test |
| narrow to `if (status == 403)` | the two pre-existing 401 tests (`:899`, `:969`) |

The second mutation is what proves the 401 tests are still doing work after the
split — without it, "401 still re-pairs" is an untested assumption.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/test/data/player_controller_test.dart
git commit -m "fix(app): a 403 on the LAN stream offers download-to-play, not an endless re-pair"
```

---

### Task A-T3: Stop telling a 403 to "re-pair the device"

**Files:**
- Modify: `apps/android/lib/src/data/api_client.dart:91-92`
- Test: `apps/android/test/data/api_client_test.dart`

- [ ] **Step 1: Write the failing tests**

```dart
test('a 401 still says re-pair', () async {
  // …fake transport returning 401…
  await expectLater(api.getJson('/api/info'),
      throwsA(isA<ApiException>()
          .having((e) => e.statusCode, 'statusCode', 401)
          .having((e) => e.message, 'message', contains('re-pair'))));
});

// A 403 is a scope denial (#898). Telling the user to re-pair is wrong advice
// — a fresh token carries the same scope.
test('a 403 does NOT say re-pair', () async {
  await expectLater(api.getJson('/api/books/x/cover'),
      throwsA(isA<ApiException>()
          .having((e) => e.statusCode, 'statusCode', 403)
          .having((e) => e.message, 'message', isNot(contains('re-pair')))));
});
```

- [ ] **Step 2: Run to verify the 403 case FAILS**

Expected: FAIL — the message is `'Not authorised — re-pair the device.'`.

- [ ] **Step 3: Split the message**

`api_client.dart:91-92`:

```dart
    if (res.statusCode == 401) {
      throw ApiException(401, 'Not authorised — re-pair the device.');
    }
    if (res.statusCode == 403) {
      // #898: the token authenticated but its scope does not cover this
      // endpoint. Re-pairing mints the same scope, so do not suggest it.
      throw ApiException(403, 'Not permitted for this device.');
    }
```

- [ ] **Step 4: Run to verify PASS** — both tests green.

- [ ] **Step 5: Prove the mutation**

Mutation: collapse both back to the single
`if (res.statusCode == 401 || res.statusCode == 403)` throw with the re-pair
message. Expected RED: the 403 test. Revert.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/data/api_client.dart apps/android/test/data/api_client_test.dart
git commit -m "fix(app): a 403 no longer advises a re-pair that cannot help"
```

---

### Task A-T4: Pin the nine call sites on the Dart side (R2)

**Files:**
- Test only: `apps/android/test/data/api_client_test.dart`

The server-side allowlist (Task B-T2) and this list are coupled across two
languages with no mechanical link — deliberately, per spec §Q1. These
assertions are the Dart half: nine literals, each named, so widening either
side is a reviewed diff.

- [ ] **Step 1: Add the nine assertions**

Over an injected fake transport that **records** every `(method, path)`. Pin the
**live caller**, not the convenience wrapper, where they differ:

| # | Pin | Live caller | Note |
|---|---|---|---|
| 1 | `GET /api/info` | `companion_runtime.dart:231` (now `probeServerReachable`) | **not** `ApiClient.info()` (`api_client.dart:106`) — dead production code: its only callers in the tree are `api_client_test.dart:26`, `:35`, `:43`, `:60` (measured) |
| 2 | `GET /api/library/sync-manifest` | `api_client.dart:113`, `:120` | both the index and the `?bookId=` detail |
| 3 | `GET /api/books/{id}/cover` | `companion_runtime.dart:198` via `getBytes` (`api_client.dart:134`) | a GET |
| 4 | `GET /api/books/{id}/chapters/{cid}/audio` | `api_client.dart:155` (`getChapterPeaks`, signature `:153`) | JSON waveform peaks |
| 5 | `GET /api/books/{id}/chapters/{cid}/audio.{mp3\|m4a\|ogg}` | server-generated (`server/src/workspace/sync-manifest.ts:159`), resolved at `sync_controller.dart:105`, `sync_engine.dart:138`, `player_controller.dart:400`; literal only in the offline fallback `sync_controller.dart:150` and `demo/demo_data.dart:258` | pin the **offline-fallback literal** — it is the only Dart-side statement of the shape |
| 6 | `GET /api/books/{id}/listen-progress` | `api_client.dart:169` | |
| 7 | `PUT /api/books/{id}/listen-progress` | `api_client.dart:192` (`client.putUrl`) | |
| 8 | `PUT /api/books/{id}/listen-stats` | `api_client.dart:257` (`client.putUrl`) | |
| 9 | `POST /api/books/{id}/shelf-status` | `api_client.dart:233` (`client.postUrl` at `:232`) | the one row that already `Uri.encodeComponent`s |

Each assertion carries the comment
`// Coupled to server/src/device-scope.ts — change both or the phone 403s.`

- [ ] **Step 2: Add the anti-vacuity floor**

A fake transport that records nothing makes all nine assertions pass over an
empty list. Assert the recorder is non-empty **and** has exactly nine distinct
method+path shapes:

```dart
test('anti-vacuity: the recorder actually saw every call', () {
  expect(recorded, hasLength(9));
});
```

- [ ] **Step 3: Run** — `flutter test test/data/api_client_test.dart`, PASS.

- [ ] **Step 4: Prove the mutations**

| Mutation | Expected RED |
|---|---|
| **M2 (Dart half)** — change row 8's send from `client.putUrl` to `client.postUrl` | row 8's assertion |
| change row 1's literal to `/api/version` | row 1's assertion |
| make the fake transport discard its recording | the anti-vacuity floor |

- [ ] **Step 5: Commit**

```bash
git add apps/android/test/data/api_client_test.dart
git commit -m "test(app): pin the nine companion endpoints the server allowlist mirrors"
```

---

### Task A-T5: Register row, release notes, and PR A

- [ ] **Step 1: Add on-box row F2**

`docs/testing/onbox-acceptance-register.md`, **Group F — a real Android
device** (currently one row, F1, at `:2300-2332`).

> **Pick the row ID against `origin/main`, not your worktree.** Two branches
> have previously picked the same register ID and git auto-merged them into a
> duplicate. Run `git fetch && git grep -n "^### F" origin/main -- docs/testing/onbox-acceptance-register.md`
> immediately before writing the heading.

Row content:

```markdown
### F2 · A handshake 401 opens the pairing screen instead of reporting the server offline ([#898](https://github.com/dudarenok-maker/Castwright/issues/898), PR A) · **a real Android phone + the desktop server in LAN HTTPS mode**

`probeServerReachable` (`companion_runtime.dart`) now routes a 401 from
`GET /api/info` to `onRepairNeeded`. Nothing automated can prove the *user-visible*
consequence: the pairing screen actually opening, on a device whose library is
already downloaded and which therefore never streams.

**Observe, concretely:**
1. Pair a phone; download at least one book fully; confirm offline playback works.
2. On the desktop, revoke that device (Account → devices → revoke) so its token 401s.
3. Put the phone back on the LAN and let auto-sync fire (toggle Wi-Fi off/on).
4. **The pairing screen opens.** Before this change it reported the server
   unreachable and stayed that way indefinitely, with no prompt.
5. Re-pair. Library, downloads and listening positions survive.
6. Negative control: with the phone off-Wi-Fi entirely, the pairing screen must
   **not** open — an ordinary transport failure is still just "offline".

*Needs* a real Android phone with the post-PR-A APK installed, and the desktop
server reachable on LAN HTTPS (`npm run dev:lan` or `npm run start:lan`) with
`LAN_AUTH_TOKEN` set. Batchable with F1 and F3.
```

- [ ] **Step 2: Update the glance table and the total**

`docs/testing/onbox-acceptance-register.md:159-175`. Group **F** goes from 1 to
2; the bold total goes up by one. **Recompute both from the file you are
editing — do not copy the numbers in this plan** (the register moves under other
branches; it read 55 owed when this plan was written).

Verify: `npm run check:onbox-register` — green.

- [ ] **Step 3: Move the live view**

Edit `docs/testing/onbox-acceptance-register-live-view.html` — the tracked,
**hand-authored** page. Add the F2 row, and recompute its derived figures (owed
count, per-group counts, oldest debt) by hand; the check verifies the owed
total, per-group counts and row IDs, but **not** oldest-debt or the
blocked/unconfirmed tallies.

Verify: `npm run check:onbox-register` — green.

- [ ] **Step 4: Publish it, following the register's own four-step procedure**

`docs/testing/onbox-acceptance-register.md:24-60` and `:95-116`. In short:
fetch the page currently live at the canonical URL to a local file, run
`npm run check:onbox-register -- --against-published <file>`, stop if it
disagrees, then publish **the `.html`** with that URL passed as `url`.
**Never publish the `.md` to that URL** — it keeps the URL and destroys the
page. That has happened four times.

- [ ] **Step 5: Release notes — both files**

`docs/release-notes-next.md` (technical register, marker
`release-notes-next-version: 1.15.0`) — a bullet under the appropriate themed
section, PR-refed.

`RELEASE_NOTES.md` — a brand-voice line in the **`# Castwright 1.15.0`**
section at the top. Describe the shipped end state, not the diff. Suggested:

> **Your phone stops saying the computer is offline when it just needs
> re-pairing.** If Castwright's permission for your phone expires or is
> revoked, the app now takes you straight to the pairing screen — even if your
> whole library is downloaded and you never stream anything. And when a chapter
> genuinely can't be streamed, it offers to download it rather than asking you
> to pair again and again.

- [ ] **Step 6: Run the branch gate and open PR A**

```bash
cd apps/android && flutter analyze && flutter test && cd ../..
npm run verify:fast:branch
git push -u origin fix/app-device-token-scope-client
```

PR title: `fix(app): close two client defects device-token scope would activate`

> **The issue trailer.** PR A is a **partial** delivery: its body says
> `Refs #898`. Crucially, **no commit message on this branch may carry a
> `Closes #898` trailer** — a `Closes` trailer in a *commit* closes the issue at
> merge regardless of what the PR body says. Before pushing, run
> `git log origin/main..HEAD --format=%B | grep -in "closes"` and confirm it is
> empty.

PR body must also state: *"On-box acceptance: F2 added. PR B (server
enforcement) follows and must not merge until an APK built from this branch is
installed on the acceptance phone."*

- [ ] **Step 7: The mandatory `code-review` gate**

Not a docs-only PR, single-scope `fix` ⇒ **medium** effort, Premium tier. Fold
findings before merge.

---

# PHASE B — the server (Closes #898)

Branch: `feat/server-device-token-scope`, cut from `main` **after PR A has
merged and an APK from it is installed on the acceptance phone**.

---

### Task B-T1: `DeviceScope`, schema 3, and the read-path rejection (M7, M8)

**Files:**
- Modify: `server/src/workspace/device-tokens.ts`
- Test: `server/src/workspace/device-tokens.pure.test.ts`
- Fix collateral: `server/src/workspace/device-tokens.test.ts`, `server/src/routes/devices.test.ts`

**Interfaces:**
- Produces: `export type DeviceScope = 'full' | 'companion'`; `DeviceTokenRecord.scope` (**required**); `createDevice(label, ttlDays, scope)`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

In `device-tokens.pure.test.ts`, next to the existing expiry cases at `:64-78`:

```ts
// #898: the load-bearing guard. A required createDevice parameter is a
// compile-time constraint on PRODUCTION call sites; it cannot reach a mock
// (pairing.test.ts:66), a hand-edited device-tokens.json, a partial migration,
// or a merge conflict. The property actually wanted is a RUNTIME one: no token
// lacking a valid scope ever authenticates.
it('rejects a record with no scope (legacy → re-pair)', () => {
  const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: future };
  expect(findValidDevice([d as never], 'tok')).toBeNull();
});

it('rejects a record with an unknown scope', () => {
  const d = rec({ tokenHash: hashToken('tok'), scope: 'admin' as never });
  expect(findValidDevice([d], 'tok')).toBeNull();
});

// The mirror case — without it, a guard of `if (d.scope !== 'full') continue`
// would pass both tests above while 403-ing every phone.
it.each(['full', 'companion'] as const)('accepts scope %s', (scope) => {
  const d = rec({ tokenHash: hashToken('tok'), scope });
  expect(findValidDevice([d], 'tok')?.id).toBe('id1');
});
```

- [ ] **Step 2: Run to verify FAILURE**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts`
Expected: the two rejection cases FAIL (a scope-less record still authenticates).

- [ ] **Step 3: Add the type, the field, and the guard**

`device-tokens.ts`:

```ts
/** Two kinds of client, one of which is a fixed nine-endpoint program.
 *  Not a capability grammar — see the design of record. */
export type DeviceScope = 'full' | 'companion';
```

`DeviceTokenRecord` (`:20-29`) gains, after `createdAt`:

```ts
  /** REQUIRED. Absent or unrecognised ⇒ the record does not authenticate
   *  (#898). Same fail-closed choice `expiresAt` above already makes. */
  scope: DeviceScope;
```

`DeviceTokensFile.schema` (`:42`) widens `1 | 2` → `1 | 2 | 3`; `persist`
(`:101`) writes `schema: 3`.

> **The schema number is documentation, not enforcement, and must not be
> mistaken for it.** `loadSync` (`:87-98`) reads only `f.devices` and never
> inspects `f.schema`. The enforcement is entirely the guard below.

In `findValidDevice` (`:52-65`), immediately after the `revoked` check at `:59`
and **before** the expiry check at `:60`:

```ts
    if (d.scope !== 'full' && d.scope !== 'companion') continue;
```

`createDevice` (`:142-159`) gains a required third parameter and stamps it:

```ts
export async function createDevice(
  label: string,
  ttlDays: number,
  scope: DeviceScope,
): Promise<{ device: PublicDevice; token: string }> {
```

…with `scope,` added to the `record` literal at `:149-155`.

- [ ] **Step 4: Run to verify PASS**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts`
Expected: PASS. The pre-existing `rec()`-based cases will still be red until
Step 5 — that is expected, fix them there.

- [ ] **Step 5: Fix every collateral site**

Work the [collateral inventory](#collateral-inventory--everything-the-change-breaks)
table top to bottom. Notably:

- `device-tokens.pure.test.ts:14-24` — `rec()` gains
  `scope: over.scope ?? 'companion'`. **`'companion'`, not `'full'`** — the
  restrictive default, so an under-specified future scope test fails rather
  than silently passing against a full-scope record.
- `device-tokens.pure.test.ts:65`, `:70`, `:75` — three inline literals gain `scope: 'companion'`.
- `device-tokens.test.ts:44`, `:46` — two record literals gain `scope: 'companion'`.
- `device-tokens.test.ts:53`, `:58`, `:63` and `devices.test.ts:141`, `:154`, `:246` — six `createDevice` calls gain a third argument.
- **`devices.test.ts:141` must pass `'full'`.** It drives the real
  `requireLanToken` against `mkReq` (`devices.test.ts:51-59`), which supplies no
  `method` or `originalUrl`; a `'companion'` mint would be scope-denied and the
  test would go red for an unrelated reason.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. A remaining TS2741/TS2345 means a collateral site was missed —
the error names the file and line; add it to the table.

- [ ] **Step 7: Prove the mutations**

| Mutation | Expected RED |
|---|---|
| **M7/M8** — delete the `if (d.scope !== 'full' && d.scope !== 'companion') continue;` line | the two rejection cases |
| narrow it to `if (d.scope !== 'full') continue;` | the `it.each` `'companion'` case |
| widen it to `if (d.scope === undefined) continue;` | the unknown-scope case only |

All three must be red under plain `npm run test:server` (which carries
`retry: 1`).

- [ ] **Step 8: Commit**

```bash
git add server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.pure.test.ts server/src/workspace/device-tokens.test.ts server/src/routes/devices.test.ts
git commit -m "feat(server): device tokens carry a required scope, enforced on the read path"
```

---

### Task B-T2: `server/src/device-scope.ts` — the pure allowlist (M2–M6, M16, M17)

**Files:**
- Create: `server/src/device-scope.ts`
- Create: `server/src/device-scope.test.ts`

**Interfaces:**
- Produces:
  - `export const COMPANION_ALLOWLIST: readonly { method: 'GET' | 'PUT' | 'POST'; pattern: RegExp }[]`
  - `export function pathnameOf(originalUrl: string): string`
  - `export function companionAllows(method: string | undefined, pathname: string): boolean`
- Consumes: **nothing.** No imports, no IO — a leaf, so it cannot participate in
  an import cycle (cf. the `server/src/gpu/` leaf-gate convention in
  `CLAUDE.md`). Verify with
  `npx madge --circular --extensions ts server/src`, which must stay at its
  15-cycle baseline.

- [ ] **Step 1: Write the failing tests**

Create `server/src/device-scope.test.ts`.

**R1 — the exact-equality pin.** Not a subset check: widening the companion's
authority must be impossible without a visible diff to a test whose expected
value is spelled out.

```ts
// R1: EXACT equality, never a subset. The expectation is the literal itself,
// so this cannot pass having examined nothing.
it('the allowlist is exactly these nine rows', () => {
  expect(COMPANION_ALLOWLIST.map((r) => [r.method, r.pattern.source])).toEqual([
    ['GET', '^/api/info$'],
    ['GET', '^/api/library/sync-manifest$'],
    ['GET', '^/api/books/[^/]+/cover$'],
    ['GET', '^/api/books/[^/]+/chapters/[0-9]+/audio$'],
    ['GET', '^/api/books/[^/]+/chapters/[0-9]+/audio\\.(mp3|m4a|ogg)$'],
    ['GET', '^/api/books/[^/]+/listen-progress$'],
    ['PUT', '^/api/books/[^/]+/listen-progress$'],
    ['PUT', '^/api/books/[^/]+/listen-stats$'],
    ['POST', '^/api/books/[^/]+/shelf-status$'],
  ]);
});
```

**Allow cases — nine**, each using a **percent-encoded** bookId, because that is
the normal case for any non-Latin book (`paths.ts:110-118`), not an edge one:

```ts
const BOOK = '%D0%BB%D1%83%D0%BA%D1%8C%D1%8F%D0%BD%D0%B5%D0%BD%D0%BA%D0%BE__x__y';
it.each([
  ['GET', '/api/info'],
  ['GET', '/api/library/sync-manifest'],
  ['GET', `/api/books/${BOOK}/cover`],
  ['GET', `/api/books/${BOOK}/chapters/12/audio`],
  ['GET', `/api/books/${BOOK}/chapters/12/audio.mp3`],
  ['GET', `/api/books/${BOOK}/chapters/12/audio.m4a`],
  ['GET', `/api/books/${BOOK}/chapters/12/audio.ogg`],
  ['GET', `/api/books/${BOOK}/listen-progress`],
  ['PUT', `/api/books/${BOOK}/listen-progress`],
  ['PUT', `/api/books/${BOOK}/listen-stats`],
  ['POST', `/api/books/${BOOK}/shelf-status`],
])('allows %s %s', (m, p) => expect(companionAllows(m, p)).toBe(true));

// Express routes HEAD to the GET handler and a HEAD cannot return more than
// its GET, so accepting it costs no authority and removes a skew class.
it('allows HEAD wherever GET is allowed', () => {
  expect(companionAllows('HEAD', '/api/info')).toBe(true);
});
```

**Deny cases**, each named for the fail-open shape it closes:

```ts
it.each([
  // (a) method-blindness. /api/books/:id/cover carries three verbs:
  // GET (cover.ts:97), POST (:65), DELETE (:127). A path-only rule would hand
  // the phone cover deletion and replacement.
  ['DELETE', `/api/books/${BOOK}/cover`],
  ['POST', `/api/books/${BOOK}/cover`],
  // M5: dropping the $ anchors. info.ts:118 is GET /; :148 is
  // POST /dismiss-whats-new on the same router.
  ['POST', '/api/info/dismiss-whats-new'],
  // Adjacent to the allowlisted audio rows: chapter-audio.ts:377 / :400.
  ['DELETE', `/api/books/${BOOK}/chapters/12/audio/previous`],
  ['POST', `/api/books/${BOOK}/chapters/12/audio/previous/restore`],
  // M6: the cross-mount collision. requireLanToken is mounted on an ARRAY
  // (app.ts:122) and Express presents path=/info for BOTH of these.
  ['GET', '/workspace/info'],
  ['GET', '/workspace/books/x/cover'],
  // M16: Express routing is case-insensitive by default, so /API/INFO ROUTES
  // to the info handler while this lowercase pattern does not match — the
  // request is denied. That is the safe direction, but safe by accident: a
  // future "normalise case before matching" change would silently convert it
  // into a match. This test makes that a visible diff.
  ['GET', '/API/INFO'],
  // M17 / invariant 9: neither pairing-session route may EVER be allowlisted.
  // mayStartPairingSession (lan-auth.ts:138-140) admits any request under the
  // LAN-token guard arriving via the friendly hostname, and such a session is
  // redeemable at pairing.ts:145 for a FULL-scope browser token.
  ['POST', '/api/devices/pair-session'],
  ['POST', '/api/pair/session'],
  ['POST', '/api/devices'],
  ['DELETE', '/api/devices/abc'],
  // chapterId is [0-9]+, not [^/]+ — api_client.dart:153 types it int, the
  // manifest emits c.id (sync-manifest.ts:159), and the server does
  // Number.parseInt (chapter-audio.ts:380).
  ['GET', `/api/books/${BOOK}/chapters/../audio`],
  ['GET', `/api/books/${BOOK}/chapters/x/audio`],
])('denies %s %s', (m, p) => expect(companionAllows(m, p)).toBe(false));

it('denies a request with no method', () => {
  expect(companionAllows(undefined, '/api/info')).toBe(false);
});
```

**`pathnameOf`:**

```ts
it.each([
  ['/api/info?x=1', '/api/info'],
  ['/api/info#frag', '/api/info'],
  ['/api/info?a=b#c', '/api/info'],
  ['/api/info', '/api/info'],
])('pathnameOf(%s) === %s', (i, o) => expect(pathnameOf(i)).toBe(o));

// A trailing slash routes (Express is non-strict) but does not match the
// anchored pattern → denied. Safe direction, pinned so it can't flip silently.
it('denies a trailing slash', () => {
  expect(companionAllows('GET', '/api/info/')).toBe(false);
});
```

- [ ] **Step 2: Run to verify FAILURE**

Run: `cd server && npx vitest run src/device-scope.test.ts`
Expected: FAIL — `Cannot find module './device-scope.js'`.

- [ ] **Step 3: Implement**

Create `server/src/device-scope.ts`. A pure leaf: **no imports.**

The nine rows, with their server routes:

| # | Method | Pattern | Server route |
|---|---|---|---|
| 1 | GET | `^/api/info$` | `routes/info.ts:118` (mounted `app.ts:137`) |
| 2 | GET | `^/api/library/sync-manifest$` | `routes/library-sync-manifest.ts:47` (mounted `app.ts:145`) |
| 3 | GET | `^/api/books/[^/]+/cover$` | `routes/cover.ts:97` (mounted `app.ts:152`) |
| 4 | GET | `^/api/books/[^/]+/chapters/[0-9]+/audio$` | `routes/chapter-audio.ts:239-240` (mounted `app.ts:180`) |
| 5 | GET | `^/api/books/[^/]+/chapters/[0-9]+/audio\.(mp3\|m4a\|ogg)$` | `routes/chapter-audio.ts:366-368` |
| 6 | GET | `^/api/books/[^/]+/listen-progress$` | `routes/book-state.ts:1463` (mounted `app.ts:150`) |
| 7 | PUT | `^/api/books/[^/]+/listen-progress$` | `routes/book-state.ts:1486` |
| 8 | PUT | `^/api/books/[^/]+/listen-stats$` | `routes/book-state.ts:1643` |
| 9 | POST | `^/api/books/[^/]+/shelf-status$` | `routes/book-state.ts:1600` |

Rows 4 and 5 are **two different routes** — `/audio` is the JSON waveform-peaks
meta, `/audio.mp3|m4a|ogg` is the file; `urlSuffix` is a closed union
(`server/src/workspace/chapter-audio-file.ts:25`). A single `{suffix}` pattern
would either miss the peaks route or over-grant.

`pathnameOf` splits at the **first** `?` or `#`; it does **not** decode.
`companionAllows` uppercases the method, maps `HEAD` → `GET`, and returns
`false` for a missing method.

The module carries a header comment stating the correctness criterion:

```ts
/* The correctness criterion is the UNION of endpoint sets over every SUPPORTED
   APK version — not the set derived from HEAD. Installed clients are not
   upgraded in lockstep: release.yml publishes a standalone APK and
   apk:companion's auto-incrementing versionCode means field devices update on
   their own schedule.

   Rows are ADDED when a new client ships, and REMOVED only when the last APK
   that used them is out of support. Do NOT edit this table to track HEAD.

   Coupled to apps/android/test/data/api_client_test.dart's nine pins. There is
   deliberately no mechanical link (see the design of record, §Q1): a Dart
   parser here would not run — no verify.yml scope regex anchors on apps/ — and
   its failure mode is silent green. */
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd server && npx vitest run src/device-scope.test.ts`
Expected: PASS.

Run: `npx madge --circular --extensions ts server/src`
Expected: still 15 cycles.

- [ ] **Step 5: Prove the mutations**

| # | Mutation | Expected RED |
|---|---|---|
| **M2** | change row 8's method `PUT` → `POST` | R1 **and** row 8's allow case |
| **M3** | delete row 5 from the table | R1 **and** rows 5's three allow cases |
| **M4** | add `{ method: 'DELETE', pattern: /^\/api\/books\/[^/]+\/cover$/ }` | R1 (exact equality, not subset) **and** the `DELETE cover` deny case |
| **M5** | drop the `$` anchors from every pattern | the `POST /api/info/dismiss-whats-new` deny case |
| **M16** | lowercase the pathname before matching | the `GET /API/INFO` deny case |
| **M17** | add `POST ^/api/devices/pair-session$` | R1 **and** the invariant-9 deny case |
| — | widen row 4's `[0-9]+` to `[^/]+` | the `chapters/x/audio` deny case |
| — | make `pathnameOf` return its input unchanged | the query-string `pathnameOf` cases **and** — once B-T3 lands — every `?`-bearing allow case |

Run each, record the failing test names, revert. All red under plain
`npm run test:server`.

- [ ] **Step 6: Commit**

```bash
git add server/src/device-scope.ts server/src/device-scope.test.ts
git commit -m "feat(server): the nine-endpoint companion allowlist as a pure leaf module"
```

---

### Task B-T3: Enforce in `requireLanToken` (M1, M6, M9, M14, M15) + the denial log (R3)

**Files:**
- Modify: `server/src/workspace/device-tokens.ts` (`isValidDeviceToken` → `authenticateDeviceToken`)
- Modify: `server/src/lan-auth.ts` (`:216`)
- Modify: `server/src/lan-auth.test.ts` (mock factory `:8-10`, `mkReq` `:20-33`)

**Interfaces:**
- Produces: `authenticateDeviceToken(raw: string): DeviceTokenRecord | null`.
- Consumes: `companionAllows`, `pathnameOf` from B-T2.

> **It must return the record, not a `{ scope }` projection.** The denial log
> needs the device `label` and `id`, and a second lookup to fetch them would be
> a second timing-sensitive hash compare.

- [ ] **Step 1: Rewrite the test-file scaffolding first**

Both are prerequisites; without them every scope test reads `undefined`.

`lan-auth.test.ts:8-10` — the mock currently exports **only**
`isValidDeviceToken`, so the rename alone fails every test in the file:

```ts
// Default is a FULL-scope record so the pre-existing srv-20 cases (which use
// mkReq without a url) keep passing unchanged. Scope tests override it.
let mockScope: 'full' | 'companion' = 'full';
vi.mock('./workspace/device-tokens.js', () => ({
  authenticateDeviceToken: (t: string) =>
    t === 'goodtoken'
      ? { id: 'd1', label: 'Anna phone', tokenHash: 'h', createdAt: '', expiresAt: '', scope: mockScope }
      : null,
}));
```

`mkReq` (`:25-32`) supplies `ip`, `socket`, `headers`, `query` and **no
`method`, `url`, `originalUrl` or `path`**. Extend `ReqOpts` and the returned
object with `method` (default `'GET'`), `originalUrl` (default `'/api/info'`)
and `path`, keeping `ip`'s `'203.0.113.5'` default at `:26` untouched.

Verify: `cd server && npx vitest run src/lan-auth.test.ts` — the pre-existing
srv-20 cases pass unchanged.

- [ ] **Step 2: Write the failing enforcement tests**

```ts
// ── ANTI-VACUITY, asserted rather than commented ─────────────────────────
// A supertest request arrives as ::ffff:127.0.0.1, which is in LOOPBACK
// (lan-auth.ts:103) and returns next() at :209 BEFORE any token check. And
// without LAN_HTTPS + LAN_AUTH_TOKEN, :208 returns next() too. Both
// short-circuits produce exactly what an allow case asserts. These two tests
// pin the short-circuits POSITIVELY so the deny suite below is provably
// exercising the token path.
it('invariant 1: loopback bypasses scope entirely', () => {
  // companion token, a DENIED route, but ip = ::ffff:127.0.0.1
  expect(passed).toBe(true);
});
it('invariant 2: with the guard off, a denied route still passes', () => {
  // LAN_AUTH_TOKEN unset
  expect(passed).toBe(true);
});

// ── M1 / M9: the denial ──────────────────────────────────────────────────
it('a companion token on a non-allowlisted route is 403 scope-denied', () => {
  // DELETE /api/books/x/cover, ip 203.0.113.5, scope 'companion'
  expect(res._res.statusCode).toBe(403);
  expect(res._res.body).toEqual({ error: 'scope-denied', scope: 'companion' });
  expect(nextCalled).toBe(false);
});

// Nine allow cases, one per row, driven through the real requireLanToken.
it.each(NINE_ROWS)('a companion token reaches %s %s', (method, originalUrl) => {
  expect(passed).toBe(true);
});

// M6: the cross-mount case, at the middleware level. req.path is /info for
// BOTH mounts (measured on Express 5.2.1 with this exact array mount:
// originalUrl=/api/info, path=/info, baseUrl=/api; /workspace/info also
// presents path=/info).
it('a companion token is denied /workspace/info even though req.path is /info', () => {
  // mkReq({ method: 'GET', originalUrl: '/workspace/info', path: '/info' })
  expect(res._res.statusCode).toBe(403);
});

// Invariant 3 — srv-20 deployments are unaffected.
it('the shared secret keeps full access to a non-allowlisted route', () => {
  expect(passed).toBe(true);
});

// Guards against Q3's rejected "default to companion" alternative sneaking
// back and 403-ing every LAN browser session (pairing.ts:145 mints browser
// tokens).
it('a full-scope token reaches a non-allowlisted route', () => {
  expect(passed).toBe(true);
});

// R3: eight of the nine client dispositions fail SILENTLY on the phone, so
// this log is the only signal a scope miss happened at all — not a backstop.
it('a denial logs method, pathname and device label exactly once', () => {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0].join(' ')).toContain('DELETE');
  expect(warn.mock.calls[0].join(' ')).toContain('/api/books/x/cover');
  expect(warn.mock.calls[0].join(' ')).toContain('Anna phone');
});
```

Invariant 5 (the `lastSeenAt` touch) is asserted in
`device-tokens.test.ts`, not here — see Step 6.

- [ ] **Step 3: Run to verify FAILURE**

Expected: the denial, log and `/workspace` cases FAIL (everything currently
`next()`s).

- [ ] **Step 4: Implement `authenticateDeviceToken`**

`device-tokens.ts:127-138` — rename and return the record, **preserving the
`lastSeenAt` touch at `:132-136` unchanged**:

```ts
/** Sync token check used by the LAN guard (cache-backed). Returns the RECORD
 *  so the guard can read `scope` and the denial log can name the device. */
export function authenticateDeviceToken(rawToken: string): DeviceTokenRecord | null {
  const now = Date.now();
  const device = findValidDevice(loadSync(), rawToken, now);
  if (!device) return null;
  // Best-effort touch — must not throw on the sync guard path. Fires BEFORE
  // any scope decision: the device DID present a valid token, and losing that
  // signal would make the admin list lie.
  if (shouldTouchLastSeen(device, now)) { /* …unchanged… */ }
  return device;
}
```

- [ ] **Step 5: Implement the guard**

`lan-auth.ts` — add `import { companionAllows, pathnameOf } from './device-scope.js';`
and replace `:216`:

```ts
    /* … or an individually-revocable per-device token (srv-33), now scoped
       (#898). Match req.originalUrl, NEVER req.path: this middleware is
       mounted on an ARRAY path (app.ts:122) and Express presents path=/info
       for both /api/info and /workspace/info. */
    const device = authenticateDeviceToken(provided);
    if (device !== null) {
      if (device.scope === 'full') return next();
      const pathname = pathnameOf(req.originalUrl ?? '');
      if (companionAllows(req.method, pathname)) return next();
      console.warn(
        `[lan-auth] scope-denied companion device "${device.label}" (${device.id}): ` +
          `${req.method} ${pathname}`,
      );
      res.status(403).json({ error: 'scope-denied', scope: 'companion' });
      return;
    }
```

**Everything else in `requireLanToken` is untouched**: the not-enforced
early-return (`:208`), the loopback bypass (`:209`), token extraction (`:210`
via `extractToken` at `:180-193`), the shared-secret branch (`:213-214`), and
the 401 fallthrough (`:218`). 401 would be the wrong status here — the token
*authenticated*; and two other 403s already exist on this mount
(`csrf-origin.ts:109`, `devices.ts:40`), so the machine-readable `error`
discriminator is what lets a client tell them apart.

- [ ] **Step 6: Add the invariant-5 test**

In `device-tokens.test.ts`, alongside `:52-60`: a companion-scoped device that
is scope-denied still gets its `lastSeenAt` stamped. Drive it through
`requireLanToken` with a denied route and assert `listDevices()[0].lastSeenAt`
is defined after `_flushPendingWritesForTests()`.

- [ ] **Step 7: Run to verify PASS**

Run: `cd server && npx vitest run src/lan-auth.test.ts src/workspace/device-tokens.test.ts src/routes/devices.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove the mutations**

| # | Mutation | Expected RED |
|---|---|---|
| **M1** | `if (device !== null) return next();` — drop the scope branch | every deny case + the log case |
| **M9** | `res.status(401)` instead of `403` | the denial-shape case (status **and** body) |
| **M6** | `pathnameOf(req.path ?? '')` instead of `req.originalUrl` | the `/workspace/info` deny case |
| — | scope the shared-secret branch (`:213-214`) too | the invariant-3 case |
| — | delete the `console.warn` | the denial-log case |
| — | delete the loopback bypass (`:209`) | the invariant-1 case |
| — | delete the not-enforced return (`:208`) | the invariant-2 case |
| — | move the `lastSeenAt` touch after the scope check | the invariant-5 case |
| **M14** *(inverted)* | flip the deny tests' default ip to `::ffff:127.0.0.1` | **every** deny assertion |
| **M15** *(inverted)* | unset `LAN_AUTH_TOKEN` in the deny tests' env | **every** deny assertion |

**M14 and M15 do not break production code — they break the test's own
premise.** If either leaves the suite green, the suite is a placebo and *that*
is the finding. Run both, record what went red, revert.

- [ ] **Step 9: Commit**

```bash
git add server/src/lan-auth.ts server/src/lan-auth.test.ts server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.test.ts
git commit -m "feat(server): requireLanToken enforces companion scope and logs every denial"
```

---

### Task B-T4: The three mint sites and the static call-site guard (M11, M12, M13)

**Files:**
- Modify: `server/src/routes/pairing.ts:118`, `:145`
- Modify: `server/src/routes/devices.ts:46`
- Modify: `server/src/routes/pairing.test.ts:66`, `:147`, `:156`
- Modify: `server/src/lan-auth.invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

`pairing.test.ts` — the mock at `:66` is untyped and 2-arity, so it is the one
real bypass of a required parameter; widen it to 3-arity and assert index 2.
Today only `lastCall?.[0]` is asserted (`:147`, `:156`), so *which* scope each
site passes would otherwise be untested — and the two sites pass **different**
values, which is the whole point:

```ts
// M11: the Android companion gets the restricted scope.
expect(vi.mocked(createDevice).mock.lastCall?.[2]).toBe('companion');
// M12: redeem-browser mints for a LAN BROWSER running the full desktop UI
// (pairing.ts:146-152 sets the __Host-cw_lan cookie). 'companion' here would
// 403 the entire web app.
expect(vi.mocked(createDevice).mock.lastCall?.[2]).toBe('full');
```

`lan-auth.invariants.test.ts` — this file already exists and is exactly this
shape (it reads `./app.ts` source at `:5` and asserts mount ordering at
`:15-20`). Add the **M13** static guard there:

```ts
// The exact set of createDevice call sites in production source, and the scope
// literal each passes. Review-forcing, not correctness-proving: it cannot judge
// whether a NEW site picked the right value, only make adding one a deliberate
// act. Asserted as an EXACT set, never a floor.
//
// NOTE: this reads source at RUNTIME, so the pin is inert under
// `vitest --changed`. verify.yml's `server` scope (:158) covers server/src/**,
// so a real PR touching a mint site does run it.
it('createDevice has exactly three production call sites, with these scopes', () => {
  const sites = [
    ['routes/pairing.ts', "createDevice(label, ttl(), 'companion')"],
    ['routes/pairing.ts', "createDevice(result.label ?? 'Device', ttlDays, 'full')"],
    ['routes/devices.ts', "createDevice(label, ttl, 'full')"],
  ];
  // …scan server/src/**/*.ts excluding *.test.ts for /createDevice\(/ and
  // compare the collected (file, call-text) pairs to `sites` with toEqual.
});
```

- [ ] **Step 2: Run to verify FAILURE**

Expected: `lastCall?.[2]` is `undefined`; the static guard finds two-argument
calls.

- [ ] **Step 3: Make the three sites state their intent**

- `pairing.ts:118` → `createDevice(label, ttl(), 'companion')` — the Android companion (`POST /api/pair/redeem`; `apps/android/lib/src/data/pairing_service.dart:96` is its only client).
- `pairing.ts:145` → `createDevice(result.label ?? 'Device', ttlDays, 'full')` — **a LAN web browser running the full Castwright UI**, delivered as the `__Host-cw_lan` cookie (`pairing.ts:146-152`). This is the site that makes "device tokens get companion scope" wrong.
- `devices.ts:46` → `createDevice(label, ttl, 'full')` — loopback-only (`devices.ts:39` 403s a non-loopback caller), so reaching it already means physical desktop access. It takes no `scope` request parameter: every real companion token comes from the QR flow, so a knob here would be a second way to do a thing that already has one.

- [ ] **Step 4: Run to verify PASS**, then `npm run typecheck` — clean.

- [ ] **Step 5: Prove the mutations**

| # | Mutation | Expected RED |
|---|---|---|
| **M11** | `pairing.ts:118` mints `'full'` | the redeem `lastCall?.[2]` assertion **and** the static guard |
| **M12** | `pairing.ts:145` mints `'companion'` | the redeem-browser assertion **and** the static guard |
| **M13** | add a 4th `createDevice(` call site anywhere in `server/src` (non-test) | the static guard |
| — | change the static guard's `toEqual` to a "contains" check, then apply M13 | the guard must go **green** — proving it was an exact set, not a floor. Revert both. |

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/pairing.ts server/src/routes/devices.ts server/src/routes/pairing.test.ts server/src/lan-auth.invariants.test.ts
git commit -m "feat(server): each mint site declares its scope, pinned by a static call-site guard"
```

---

### Task B-T5: Follow-up issues, register row, release notes, and PR B

- [ ] **Step 1: File the two follow-up issues, in this round**

Neither clears the fix-now bar (each needs a judgement or an interface
decision), so each is a filed issue, not a widened diff:

1. **`ApiClient.info()` is dead production code.** `api_client.dart:106`; its
   only callers in the tree are `api_client_test.dart:26`, `:35`, `:43`, `:60`
   (measured). Deleting a public client method is a judgement call.
   Labels: `type:chore`, `area:app`.
2. **Advertise the granted scope in `GET /api/info`.** The right eventual home
   for skew diagnosis, deferred here because nothing in the client would read
   it this wave and `/api/info` is a contract surface (an `openapi.yaml` edit
   stales `src/lib/api-types.ts`). Labels: `type:feature`, `area:srv` — and
   **re-run `npm run backlog:sync`** so its row lands in `docs/BACKLOG.md`.
   (The chore needs no BACKLOG row; `type:chore` issues never render there.)

Consider a third if `redactDevice` exposing `scope` is wanted for the admin
device list — see Global Constraints.

- [ ] **Step 2: Add on-box row F3**

Same ID-collision precaution as A-T5 Step 1: `git fetch` and re-check the
highest `F` heading on `origin/main` first.

```markdown
### F3 · Companion scope enforcement end to end, including the offline-first legacy case ([#898](https://github.com/dudarenok-maker/Castwright/issues/898), PR B) · **a real Android phone + the desktop server in LAN HTTPS mode with `LAN_AUTH_TOKEN` set**

Every companion token is now `scope: 'companion'` and reaches nine method+path
pairs; a record with no scope does not authenticate at all. Unit tests drive
`requireLanToken` against a mocked request; they cannot prove the phone↔desktop
path over real LAN HTTPS, and §Q2 of the design shows eight of the nine rows
fail **silently** on the client — no banner, no toast — so a wrong allowlist row
is close to invisible from the phone.

**Observe, concretely:**
1. Pair a fresh phone (QR flow). Confirm the mint wrote `"scope":"companion"` into `device-tokens.json` and `"schema":3`.
2. Library list populates, **cover art appears** (row 3 — a miss shows a placeholder with no error), a book downloads, and a chapter plays offline.
3. Stream an undownloaded chapter over LAN (row 5). It must play. A denial here would previously have looped the pairing screen forever.
4. The **waveform** renders on the player (row 4 — a miss shows a plain bar with no error).
5. Listening position round-trips: play, background the app, confirm the desktop's Listen view moves (rows 6/7), and finishing a book updates its shelf status (row 9).
6. Desktop server log shows **zero** `[lan-auth] scope-denied` lines for the whole session. Any line here is a missing allowlist row — that log is the only signal, and it is on the desktop, not where the user is looking.
7. **The legacy case unit tests cannot reach.** Before upgrading the server, pair a phone and download a book fully. Upgrade the server to the scope-enforcing build (the phone's existing record now has no `scope`, so it 401s). Put the phone on the LAN with the app closed, then open it. It must reach the **pairing screen** — not report the server offline. This user never streams, so they never hit the one stream-path re-pair trigger; PR A's handshake fix is the only thing that saves them.
8. Re-pair once. Everything in steps 2–5 works again. It must be **one** re-pair, not a loop.
9. Negative control: from a LAN **browser** on `https://castwright.local`, redeem a browser pairing and confirm the full desktop UI still works — `pairing.ts:145` mints `full`, and a regression to `companion` would 403 the entire web app.

*Needs* a real Android phone with the post-PR-A APK installed, the desktop
server on LAN HTTPS (`npm run dev:lan` / `npm run start:lan`) with
`LAN_AUTH_TOKEN` set, and — for step 7 — a `device-tokens.json` written by a
pre-scope build. No GPU, sidecar, analyzer or real book needed. Batchable with
F1 and F2.
```

- [ ] **Step 3: Glance table, total, live view, publish**

Identical to A-T5 Steps 2–4. Group **F** 2 → 3; total +1; recompute the live
view's derived figures by hand; `npm run check:onbox-register` green; then the
four-step `--against-published` publish procedure, publishing the **`.html`**
with the canonical `url`.

- [ ] **Step 4: Release notes — both files**

`docs/release-notes-next.md`: a technical entry naming the enum, the read-path
rejection, the nine-row allowlist, the 403 `scope-denied` shape, the schema-3
bump and the forced one-time re-pair, PR-refed.

`RELEASE_NOTES.md`, `# Castwright 1.15.0`. This one has a **user-visible upgrade
cost** and must say so plainly:

> **A paired phone can now only do the things a phone needs to do.** Until now,
> the access you hand a phone when you pair it opened the entire app — it could
> have deleted cover art or rewritten your cast just as easily as it played a
> chapter. A phone's access is now limited to the handful of things the
> companion app actually asks for: your library, covers, chapters, and your
> listening position. Nothing else. **One thing to know: this takes effect the
> first time you run this version, so every phone and browser you have already
> paired needs pairing once more.** Your downloads and listening positions are
> untouched.

- [ ] **Step 5: Run the branch gate**

```bash
npm run typecheck
npm run verify:fast:branch
```

- [ ] **Step 6: Open PR B**

PR title: `feat(server): scope device tokens and enforce the companion allowlist`

Body: `Closes #898`. Also declare, per CLAUDE.md, the incidental fixes carried
here (the ten collateral sites) and the two follow-up issues filed. State
explicitly: *"PR A (#…) merged on <date>; an APK built from it was installed on
the acceptance phone before this branch was cut."*

Before pushing, run
`git log origin/main..HEAD --format=%B | grep -in "closes\|refs"` and confirm
the only issue trailers are the ones you intend — a `Closes` in a commit fires
regardless of the PR body.

- [ ] **Step 7: The mandatory `code-review` gate**

Not docs-only, single-scope `feat` ⇒ **medium** effort, Premium tier. Triage and
fold findings before merge.

---

## Mutation index

Every mutation this plan specifies, with the task that owns it. A test whose
mutation is not in this table does not exist.

| # | Mutation | Goes red with | Task |
|---|---|---|---|
| M1 | `requireLanToken` `next()`s for companion unconditionally | every deny case + the log case | B-T3 |
| M2 | row 8's method PUT→POST (server) / `putUrl`→`postUrl` (Dart) | R1 + row 8 allow; row 8 Dart pin | B-T2, A-T4 |
| M3 | delete row 5 from the table | R1 + row 5's allow cases | B-T2 |
| M4 | add `DELETE ^/api/books/[^/]+/cover$` | R1 (exact, not subset) + the deny case | B-T2 |
| M5 | drop the `$` anchors | `POST /api/info/dismiss-whats-new` deny | B-T2 |
| M6 | match `req.path` instead of `originalUrl`'s pathname | `/workspace/info` deny (unit **and** middleware) | B-T2, B-T3 |
| M7 | `findValidDevice` accepts `scope: undefined` | legacy-record rejection | B-T1 |
| M8 | `findValidDevice` accepts `scope: 'admin'` | unknown-scope rejection | B-T1 |
| M9 | denial returns 401 | denial-shape case (status **and** `error`) | B-T3 |
| M10 | restore `status == 401 \|\| status == 403` at `player_controller.dart:435` | the 403-must-not-re-pair test | A-T2 |
| M11 | `pairing.ts:118` mints `'full'` | `lastCall?.[2]` redeem + static guard | B-T4 |
| M12 | `pairing.ts:145` mints `'companion'` | `lastCall?.[2]` redeem-browser + static guard | B-T4 |
| M13 | add a 4th `createDevice` call site | the static call-site guard | B-T4 |
| M14 | *(inverted)* deny tests' ip → `::ffff:127.0.0.1` | **all** deny assertions | B-T3 |
| M15 | *(inverted)* unset `LAN_AUTH_TOKEN` in the deny tests | **all** deny assertions | B-T3 |
| M16 | case-fold the path before matching | `GET /API/INFO` deny | B-T2 |
| M17 | allowlist `POST ^/api/devices/pair-session$` | R1 + invariant-9 deny | B-T2 |
| M18 | `probeServerReachable` swallows a 401 | handshake-401 → `onRepairNeeded` | A-T1 |
| — | narrow `player_controller` to `status == 403` | the two pre-existing 401 tests | A-T2 |
| — | `probeServerReachable` re-pairs on any failure | the transport-failure + 403 tests | A-T1 |
| — | fake transport records nothing | the Dart anti-vacuity floor | A-T4 |
| — | delete `lan-auth.ts:209` / `:208` | invariant 1 / invariant 2 | B-T3 |
| — | scope the shared secret | invariant 3 | B-T3 |
| — | move the `lastSeenAt` touch after the scope check | invariant 5 | B-T3 |
| — | delete the denial `console.warn` | the denial-log case | B-T3 |
| — | static guard `toEqual` → contains, then M13 | guard must go **green** (proves exactness) | B-T4 |
| — | `pathnameOf` returns its input | query-string cases | B-T2 |
| — | row 4 `[0-9]+` → `[^/]+` | `chapters/x/audio` deny | B-T2 |

---

## Corrections to the spec

Found while verifying against `main` @ `447eb522`. None changes a design
decision.

1. **§The allowlist's `/workspace` absence claim is false as stated.** The spec
   says "grep of all 71 files under `apps/android/lib/**` for `/workspace`:
   zero hits". There is **one** hit —
   `apps/android/lib/src/domain/sync_manifest.dart:2`, a doc comment
   referencing `server/src/workspace/sync-manifest.ts`. The substantive
   conclusion (no Dart file constructs a `/workspace` URL) holds, and the
   71-file count is exact. The correct statement is "one hit, in a doc comment,
   not a URL". Invariant 8's `/workspace` denial is unaffected.
2. **M18 is not writable where the spec puts it.** The probe lives inside
   `CompanionRuntime.forConnection` (`companion_runtime.dart:133`), device-glue
   with no test entry point (`companion_runtime_test.dart:520-521` says so
   in-tree; only callers are `main.dart:255`, `:301`). Task A-T1 Step 1 adds the
   extraction the spec's PR-A contents assume already exists.
3. **The collateral list is one third complete.** The spec names three sites;
   ten exist. Six are compile errors the spec does not mention
   (`device-tokens.pure.test.ts:65/70/75`, `device-tokens.test.ts:44/46`, and
   six 2-arity `createDevice` calls across `device-tokens.test.ts` and
   `devices.test.ts`), and one — `devices.test.ts:141` — is a *behavioural*
   trap: it drives the real `requireLanToken` against a `mkReq`
   (`devices.test.ts:51-59`) with no `method`/`originalUrl`, so a `'companion'`
   mint there turns the test red for an unrelated reason.
4. **Two line drifts, non-load-bearing.** `getBytes` is declared at
   `api_client.dart:134`, not `:130-146`. The `probeReachable` block is
   `companion_runtime.dart:229-236`, not `:230-235` — though `:231` for the
   `getJson('/api/info')` call itself is exact.

**Everything else spot-checked was exact**, including all nine allowlist route
citations, all nine `verify.yml` scope-regex line numbers and the fact that none
anchors on `apps/`, `app.yml:10-16`, `app.ts:105/122/125/137/141/142`,
`lan-auth.ts:103/138-140/180-193/203-219`, `device-tokens.ts:26/42/52-65/79-81/85-98/101/127-138`,
`pairing.ts:50/118/145/146-152`, `devices.ts:39/40/46/54`,
`openapi.yaml:1173/2661` plus zero `'401':`, `registry.ts:1164` (`min: 1`, no
`max`), `paths.ts:105-118`, `csrf-origin.ts:92-94/109`,
`player_controller.dart:435-436/442-444`, the single `onRepairNeeded`
invocation site, `companion_runtime.dart:198/231`, `ApiClient.info()` being dead
production code, `src/lib/api.ts:7055/7062/7067`, 79 Dart test files, zero
`scope` occurrences in the three server files, and `server/src/device-scope.ts`
not existing.

## What this plan could not establish

1. **The Express 5.2.1 crafted-URL probe was not re-run.** The spec reports 18
   shapes all failing closed. This plan takes that on trust and does not depend
   on it: the allowlist is default-deny, so an encoding oddity can only cause a
   denial. M16 pins the one accidental safety property (case-insensitive routing
   vs. a case-sensitive pattern) as a permanent test regardless.
2. **The true Express route count behind the guard.** 123 operations is the
   `openapi.yaml` figure and a floor; the real registration count is larger. The
   over-grant ratio stays "9 of at least 123", stated as a floor.
