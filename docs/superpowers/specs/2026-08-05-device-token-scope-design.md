---
status: draft
date: 2026-08-05
---

# Device-token scope: a two-value enum enforced on the read path

Design for the **scope** half of **#898** (srv-41). The TTL half shipped in
`74fb2901`; this spec does not re-open it.

> **Provenance.** Written against `main` @ `d1b5d81a`. Every `file:line` below
> was opened and read for this document. Where it contradicts the issue's
> triage comment, the text says so and shows the evidence. Two of the
> triage's citations are wrong and one of its central conclusions (the
> #2144 prerequisite) does not survive the design chosen here.
>
> **Revision 2.** Through one round of the mandatory Premium-tier
> `assumption-checker` gate. The core architecture and all five design
> decisions survived; three load-bearing corrections and six minors were
> folded, each re-verified against the tree first. §Review findings records
> them, including one minor that was itself wrong.

## Problem

`requireLanToken` (`server/src/lan-auth.ts:207-219`) is all-or-nothing. Once a
token authenticates, the request proceeds to the whole guarded surface:

```ts
// server/src/lan-auth.ts:216
if (isValidDeviceToken(provided)) return next();
```

It is mounted at `server/src/app.ts:122` as
`app.use(['/api', '/workspace'], requireLanToken)`. Behind that mount,
`openapi.yaml` declares **111 paths / 123 operations** (counted by parsing the
`paths:` block; the real Express surface is larger, so treat 123 as a floor).

The Android companion needs **nine** method+path pairs. So a token that exists
to let a phone stream audio and post a bookmark can also delete covers, mutate
cast, and reach every admin route on the box.

`isValidDeviceToken` (`server/src/workspace/device-tokens.ts:127-138`) returns
a **boolean** — it resolves the record and then throws it away. There is
nowhere for a scope to be read even if one existed. Zero occurrences of
`scope` in `lan-auth.ts`, `routes/pairing.ts`, or `workspace/device-tokens.ts`.

### The fact that shapes the whole design

**Device tokens are not only companion tokens.** There are exactly three
`createDevice` call sites in production code, and they serve two different
kinds of client:

| # | Site | Endpoint | Client | Delivery |
|---|---|---|---|---|
| 1 | `server/src/routes/pairing.ts:118` | `POST /api/pair/redeem` | **the Android companion** | JSON `{token}` |
| 2 | `server/src/routes/pairing.ts:145` | `POST /api/pair/redeem-browser` | **a LAN web browser running the full Castwright UI** | `__Host-cw_lan` cookie (`pairing.ts:146-152`) |
| 3 | `server/src/routes/devices.ts:46` | `POST /api/devices` | operator, **loopback-only** (`devices.ts:39`) | JSON, shown once |

Site 2 is the one that matters. A design of the form "device tokens get
companion scope" would 403 the entire LAN browser UI. Any scope decision must
be made **per mint site**, never per credential type.

The triage comment lists these three sites but does not note that site 2 is a
browser. That omission is what makes the naive design look safe.

## Decisions

1. **A two-value enum, not a capability grammar.** `'full' | 'companion'`.
   There are two kinds of client and one of them is a fixed, enumerable
   nine-endpoint program. A grammar would be speculative.
2. **Enforce on the read path, not the mint path.** The load-bearing guard
   rejects a record whose scope is not one of the two literals, inside
   `findValidDevice`. §Q4 explains why this defeats bypasses a required
   constructor parameter cannot.
3. **No migration.** A record without a valid `scope` does not authenticate.
   Schema bumps to 3. §Q3 justifies this against the alternative.
4. **Match on `req.originalUrl`, anchored, method-aware.** §Design explains
   the two fail-open shapes this avoids.
5. **The Dart client changes in this wave**, because scope enforcement
   activates a latent re-pair livelock. §Q2.
6. **No Dart-parsing CI gate.** §Q1 replaces it with three mechanisms, none
   of which can report green having examined nothing.

## Design

### The scope value

```ts
// server/src/workspace/device-tokens.ts
export type DeviceScope = 'full' | 'companion';

export interface DeviceTokenRecord {
  …
  scope: DeviceScope;   // REQUIRED — absent/unknown ⇒ the record is invalid
}
```

`createDevice(label, ttlDays, scope)` gains a third **required** parameter, so
the three sites above become compile errors until each states its intent:

- `pairing.ts:118` → `'companion'`
- `pairing.ts:145` → `'full'`
- `devices.ts:46` → `'full'`

**Why `devices.ts:46` is `'full'`.** It is loopback-only (`devices.ts:39`
rejects non-loopback with 403), so reaching it already means physical desktop
access. Its shipped consumers are the operator by hand — the frontend calls
only `GET /api/devices` (`src/lib/api.ts:7062`), `DELETE /api/devices/:id`
(`:7067`) and `POST /api/devices/pair-session` (`:7055`), never the mint. It
takes no `scope` request parameter: every real companion token comes from the
QR flow at `pairing.ts:118` (`apps/android/lib/src/data/pairing_service.dart:96`
is the only client of `/api/pair/redeem`), so a knob here would be a second way
to do a thing that already has one.

### Enforcement

`isValidDeviceToken` currently returns `boolean`
(`device-tokens.ts:127-138`). It becomes record-returning —
`authenticateDeviceToken(raw): DeviceTokenRecord | null` — preserving the
existing `lastSeenAt` touch behaviour at `:132-136` unchanged.

**It must return the record, not just the scope.** The denial log below needs
the device `label` and `id`; a `{ scope }` projection cannot supply them, and
a second lookup to fetch them would be a second timing-sensitive hash compare.

**Renaming it breaks every LAN-auth test.** `lan-auth.test.ts:8-10` mocks
`./workspace/device-tokens.js` with a factory exporting **only**
`isValidDeviceToken`; once `lan-auth.ts` imports a different name the mock
supplies nothing and the whole file fails. Updating that factory is part of
the same change, not a follow-up.

```ts
// server/src/lan-auth.ts — replacing :216
const device = authenticateDeviceToken(provided);
if (device !== null) {
  if (device.scope === 'full') return next();
  if (companionAllows(req.method, pathnameOf(req.originalUrl))) return next();
  res.status(403).json({ error: 'scope-denied', scope: 'companion' });
  return;
}
```

Everything else in `requireLanToken` is untouched: the not-enforced
early-return (`:208`), the loopback bypass (`:209`), token extraction
(`:210`, via `extractToken` at `:180-193`), the shared-secret branch
(`:213-214`), and the 401 fallthrough (`:218`).

**The shared secret keeps full access.** `LAN_AUTH_TOKEN` (`lan-auth.ts:21-24`)
is an operator-configured secret for the whole surface, not a device
credential. Scoping it would break every existing srv-20 deployment and it has
no mint site to attach an intent to.

### The allowlist

A new pure leaf module, `server/src/device-scope.ts` — no imports, no IO, so
it is unit-testable and cannot participate in an import cycle (cf. the
`server/src/gpu/` leaf-gate convention in CLAUDE.md).

| # | Method | Anchored pattern | Server route |
|---|---|---|---|
| 1 | GET | `^/api/info$` | `routes/info.ts:118` |
| 2 | GET | `^/api/library/sync-manifest$` | `routes/library-sync-manifest.ts:47` |
| 3 | GET | `^/api/books/[^/]+/cover$` | `routes/cover.ts:97` |
| 4 | GET | `^/api/books/[^/]+/chapters/[0-9]+/audio$` | `routes/chapter-audio.ts:239` |
| 5 | GET | `^/api/books/[^/]+/chapters/[0-9]+/audio\.(mp3\|m4a\|ogg)$` | `routes/chapter-audio.ts:366-368` |
| 6 | GET | `^/api/books/[^/]+/listen-progress$` | `routes/book-state.ts:1463` |
| 7 | PUT | `^/api/books/[^/]+/listen-progress$` | `routes/book-state.ts:1486` |
| 8 | PUT | `^/api/books/[^/]+/listen-stats$` | `routes/book-state.ts:1643` |
| 9 | POST | `^/api/books/[^/]+/shelf-status$` | `routes/book-state.ts:1600` |

Client sources, each verified: row 1 `companion_runtime.dart:231` — **not**
`api_client.dart:106`, see §Q1 R2; row 2 `:113`,
`:120`; row 3 `companion_runtime.dart:198` via `getBytes`
(`api_client.dart:130-146`, a GET); row 4 `:155`; row 5 — see below; row 6
`:169`; row 7 `:192` (`client.putUrl`); row 8 `:257` (`client.putUrl`); row 9
`:233` (`client.postUrl`).

**`HEAD` is accepted wherever `GET` is.** Express routes HEAD to the GET
handler, and a HEAD cannot return more than its GET. Accepting it costs no
authority and removes a skew class. The companion does not currently need it
— its upstream fetch is unconditionally `client.getUrl(url)`
(`api_client.dart:404`) and `LoopbackProxy` answers local HEADs itself
(`loopback_proxy.dart:27,31,93,100` hold the upstream status side-channel).

**Rows 4 and 5 are two different routes.** `/audio` is the JSON waveform-peaks
meta (`chapter-audio.ts:239`, consumed by `getChapterPeaks` at
`api_client.dart:155`); `/audio.mp3|m4a|ogg` is the file
(`chapter-audio.ts:366-368`). `urlSuffix` is a closed union
(`workspace/chapter-audio-file.ts:25`). A single `{suffix}` pattern would
either miss the peaks route or over-grant.

**Row 5's production URL is server-generated.** `sync-manifest.ts:159` emits
`` `/api/books/${bookId}/chapters/${c.id}/${audio.urlSuffix}` ``; the client
consumes it opaquely via `_resolveUrl(c.audioUrl!)`
(`sync_controller.dart:105`), `_resolve(c.audioUrl!)` (`sync_engine.dart:138`)
and `cfg.urlResolver(audioUrl)` (`player_controller.dart:400`). It appears as
a Dart literal only in the **offline-fallback** synthesis
(`sync_controller.dart:150`) and the demo fixture (`demo/demo_data.dart:258`).
This is the row any mechanical extractor is worst at, and §Q2 shows it is also
the only row wired to a forced re-pair.

**`chapterId` is `[0-9]+`, not `[^/]+`.** `getChapterPeaks(String bookId, int
chapterId)` (`api_client.dart:153`) types it as an int, the manifest emits
`c.id` (a number, `sync-manifest.ts:159`), and the server does
`Number.parseInt(req.params.chapterId, 10)` (`chapter-audio.ts:380`). The
tighter class is free.

**`/workspace` is entirely denied to companion scope.** No Dart file
constructs a `/workspace` URL (grep of all 71 files under
`apps/android/lib/**` for `/workspace`: zero hits).

#### The allowlist covers a version range, not HEAD

**The correctness criterion is the union of endpoint sets over every supported
APK version — not the set derived from HEAD.** This matters because installed
clients are not upgraded in lockstep with the server: `gh release list` shows
**17** releases and `v1.14.0` ships a standalone `castwright-v1.14.0.apk`
asset, so APKs predating this work certainly exist in the field, and
`apk:companion`'s auto-incrementing `versionCode` means they update-install on
their own schedule.

Today the criterion is satisfied trivially: the `/api/` literal set in
`api_client.dart` is **identical at `v1.9.0`, `v1.14.0`, and HEAD** (compared
via `git show <tag>:apps/android/lib/src/data/api_client.dart`). So no
released build calls anything the HEAD-derived table omits.

**That is true by accident, and the accident is the risk.** The moment a
release adds a companion endpoint, the nine-row table describes only the newest
client, and every older installed APK becomes a client the server denies. Rows
are therefore **added when a new client ships and removed only when the last
APK that used them is out of support** — not edited to track HEAD.

#### Two fail-open shapes the matching rules exist to close

**(a) Method-blindness would over-grant on a path the companion legitimately
reads.** `/api/books/:bookId/cover` carries three verbs:
GET (`cover.ts:97`), **POST** (`cover.ts:65`) and **DELETE**
(`cover.ts:127`). A path-only allowlist would hand the phone cover deletion
and replacement. Same shape at `/api/info` (`routes/info.ts:118`, mounted
`app.ts:137`), whose router also serves
`POST /api/info/dismiss-whats-new` (`routes/info.ts:148`), and around
`chapter-audio.ts` which carries a `DELETE .../audio/previous` (`:377`) and a
`POST .../audio/previous/restore` (`:400`) adjacent to the allowlisted rows.

**(b) `req.path` is the wrong input.** The guard is mounted with an **array**
mount path (`app.ts:122`), and Express strips a matched mount prefix from
`req.url`/`req.path` inside the middleware. Patterns written against `req.path`
would therefore be `/info`-shaped — and would match `/workspace/info` just as
well as `/api/info`, silently punching a hole through the other mount. The
design uses `req.originalUrl`, which is never rewritten, split at the first
`?` or `#`.

> **Named as unverified:** I did not execute code to confirm Express 5's exact
> prefix-stripping behaviour for an *array* mount path. The design is written
> so the answer does not matter — `originalUrl` is untouched either way — and
> §Testing pins the `/workspace` cross-mount case with an explicit test (M6)
> rather than relying on my reading.

**Anchored, and no pre-decoding.** Patterns are `^…$`. The path is matched
**raw**, not percent-decoded, so `[^/]+` must admit `%`.

Percent-encoded `bookId`s are the **normal** case, not an edge one, and on all
nine rows rather than just the one that calls `Uri.encodeComponent`
(`api_client.dart:233`). `makeBookId` (`workspace/paths.ts:117-118`) composes
the id from `slug()` (`:110-112`), which is deliberately **Unicode-preserving**
— per its own comment at `paths.ts:105-109`, plan 219 changed it precisely so
a Cyrillic title yields a distinct slug instead of collapsing every Russian
book to `untitled__standalones__untitled`. So every non-Latin book produces a
bookId that is percent-encoded in flight on every row that carries one.

Matching raw keeps the string the guard inspects identical to the string
Express routes on. Because the list is default-deny, an encoding oddity can
only cause a denial, never a grant — confirmed empirically, see §Testing.

### Denial shape

**403**, body `{ error: 'scope-denied', scope: 'companion' }`.

401 would be wrong: the token authenticated. The machine-readable `error`
discriminator matters because two other 403s already exist on the same mount —
`requireSameOrigin` (`csrf-origin.ts:109`, `'Cross-origin request rejected.'`)
and the loopback-only mint (`devices.ts:40`) — so a client cannot distinguish
by status alone.

**No `openapi.yaml` change.**

> **Revision 2 correction.** Revision 1 stated "zero `401:` and zero `403:`".
> The 401 half is right; the 403 half was a bad grep (`^ *403:` misses the
> quoted `'403':` form actually used). There are **two** `'403':` entries,
> `openapi.yaml:1173` and `:2661`.

Re-argued from the true measurement, the conclusion survives but for a
different reason. Both documented 403s are **route-level business logic** —
cloned-voice consent denials (`:1174` "This cloned voice has no valid consent
and cannot be played"; `:2662` "consent has been revoked"). The relevant
precedent for a **middleware-level** response is `'401':`, which
`requireLanToken` has returned from `lan-auth.ts:218` since srv-20 and which
appears **zero** times despite applying to every one of the 123 operations.
The scope 403 is the same kind of thing: cross-cutting, emitted before
routing, applicable to every path rather than to nine. Documenting it
per-path would mean touching all 123 operations and regenerating
`src/lib/api-types.ts`; documenting it on nine would misdescribe it.

### Server-side denial logging

Every scope denial emits one structured `console.warn` naming method, raw
pathname, and the device label. A denial in production becomes a one-line
diagnosis rather than an inference from a phone's behaviour. This is the only
mechanism here that observes real traffic, and it cannot be vacuously green
because it fires only on an actual denial.

## The five open questions

### Q1 — How is the allowlist kept correct over time?

**Drop the Dart-parsing gate. It cannot work here, and three cheaper things
cover what it was for.**

Why it fails, all verified:

1. **It would not run.** `verify.yml`'s `detect` job defines nine scope
   regexes — frontend `:146`, server `:158`, sidecar `:159`, e2e `:160`,
   scripts `:161`, hooks `:170`, pinokio `:171`, openapi `:179`, shared
   `:182`. None anchors on `apps/` or contains `android`. `verify-cache.mjs`
   agrees: the `test:server` step's globs are `['server/src/**']` (`:163`) and
   no step's globs mention `apps/android`. A Dart-only PR runs no leg that
   could contain such a test.
2. **Wiring it collides with in-flight work.** The two artifacts that would
   need editing are exactly the two that
   `docs/superpowers/specs/2026-08-05-verify-scope-map-unification-design.md`
   is mid-flight replacing — it makes `STEPS[]` the single source of truth and
   adds a `←` assertion (`§The trap per-step derivation creates`) that turns
   any new `STEPS[]` entry red until `verify.yml` is wired to it. Adding a
   Dart-scanning step now adds a fifth map to a document whose thesis is that
   there are already too many.
3. **The extraction is structurally unreliable.** The method never sits at the
   URL literal: it is in the helper name (`getJson('/api/info')`,
   `api_client.dart:106`) or a line away from the path
   (`client.postUrl(` at `:232` / the URL at `:233`). And row 5's production
   URL is server-generated (`sync-manifest.ts:159`), appearing in Dart only in
   an offline fallback (`sync_controller.dart:150`) and a demo fixture
   (`demo_data.dart:258`).
4. **Its failure mode is silent green.** An extractor that yields zero URLs
   reports "every companion URL is allowlisted". No Node/TS code in this repo
   reads Dart source today, so there is no existing harness to inherit
   robustness from.

**What replaces it — three mechanisms, each non-vacuous by construction:**

**R1. The allowlist is pinned by exact equality, not by a subset check.** A
server test declares the nine rows literally and asserts the shipped table
*equals* them. Widening the companion's authority is then impossible without a
visible diff to a test whose expected value is spelled out. It cannot pass
having examined nothing, because the expectation is the literal itself.

**R2. A Dart-side assertion in the tree whose CI actually covers it.**
`.github/workflows/app.yml:10-16` path-filters on `apps/android/**` and runs
`flutter analyze` + `flutter test`. That is the **only** CI lane that fires on
a Dart-only change. `apps/android/test/data/api_client_test.dart` already
exists (79 Dart test files under `apps/android/test/`). Add one test per
call site asserting the exact method+path it emits, over an injected
fake transport, with a comment naming `server/src/device-scope.ts`. Nine small
assertions, each naming a literal — a change-detector, deliberately, on the
Dart side of the coupling.

> **Pin the live caller, not the convenience wrapper.** For row 1 that is
> `companion_runtime.dart:231` (`api.getJson('/api/info')`). `ApiClient.info()`
> (`api_client.dart:106`) is **dead production code** — its only callers in the
> repo are `api_client_test.dart:26`, `:35`, `:43`, `:60`. Pinning `info()`
> would assert against code no shipped path executes while leaving the real
> caller unguarded. *(Reported as an incidental finding, not fixed here:
> deleting a public client method is a judgement call, not an obvious fix.)*

**R3. The denial log** (above). Not a backstop — per §Q2, eight of the nine
rows fail *silently* on the client, so this is the **only** signal that a scope
miss has happened at all.

**What this honestly does not do:** it does not mechanically prove the two
lists agree. Cross-language coupling between a Dart client and a TS server is
not worth a parser here. The design instead makes both sides explicit literals,
makes widening either one a reviewed diff, and makes a miss loud at runtime. I
prefer stating that plainly to shipping a mechanism whose green means nothing.

### Q2 — What happens when a denial reaches the client?

`ApiException` is thrown at `api_client.dart:91-92` for 401 **and** 403, with
the message `'Not authorised — re-pair the device.'`.

> **Revision 2 correction.** Revision 1 derived the taxonomy below from "the
> only `on ApiException catch` in the tree is `api_client.dart:176`". That grep
> is true and the inference from it was wrong: untyped `catch (_)`,
> `.catchError((_) {})` and `on Exception` all catch `ApiException` too
> (`ApiException implements Exception`, `api_client.dart:42`), and they are
> everywhere. The corrected table is materially worse for the design, so it is
> the one that matters.

Per row, each disposition verified at the cited handler:

| # | Row | What the user sees on a denial |
|---|---|---|
| 1 | `GET /api/info` | `probeReachable` returns **false** — *"server offline"* (`companion_runtime.dart:230-235`) |
| 2 | sync-manifest | silent offline fallback (`sync_controller.dart:131-133`, `library_home_screen.dart:172-174`) |
| 3 | cover | placeholder, no error (`library_home_screen.dart:136-138`) |
| 4 | audio peaks | plain bar, no waveform (`api_client.dart:160-162`) |
| 5 | **audio file** | **forced re-pair** (`player_controller.dart:435-436`) |
| 6, 7 | listen-progress | swallowed (`player_pane.dart:169-171`) |
| 8 | listen-stats | swallowed, rows retained for retry (`listen_stats_service.dart:49-59`) |
| 9 | shelf-status | swallowed (`companion_runtime.dart:53`, `:66`, `library_home_screen.dart:238`) |

**Eight of nine rows fail silently.** No banner, no log, no toast — a missing
cover, an absent waveform, stats that never flush, and a server that reports
itself unreachable. **This makes the §Design denial log the only signal that a
scope miss has occurred, not a backstop** — and it lives on the desktop, which
is not where the user is looking. That is a deliberate, stated cost of
default-deny, and it is the strongest argument for R1's exact-equality pin:
the allowlist has to be right up front, because being wrong is close to
invisible.

**Row 5 is the one loud row.** The stream goes through `LoopbackProxy`, which
records the upstream status (`loopback_proxy.dart:100`);
`player_controller.dart:433` reads it and `:435-436` is:

```dart
if (status == 401 || status == 403) {
  cfg.onRepairNeeded();
}
```

`onRepairNeeded` has exactly one invocation site (`player_controller.dart:436`);
it is wired to `_openPairing()` at `main.dart:258` and `:301`.

**So a 403 on row 5 is a livelock.** Deny → re-pair prompt → user re-pairs →
`pairing.ts:118` mints a *fresh companion-scoped* token → identical denial →
forever. Choosing 401 instead does not dodge it; the condition covers both.

**This is a pre-existing defect that scope enforcement would activate.**
Re-pairing can only ever fix an *authentication* failure — expired, revoked,
server re-minted its secret. It can never fix an *authorization* failure,
because the new token carries the same scope. Conflating the two is wrong
today; it is merely unreachable today.

**Decision: the Dart client changes in this wave**, and the change is small:

- `player_controller.dart:435` → re-pair on **401 only**; 403 routes to
  `_notifyDownloadToPlay()` (the existing "download to play" channel,
  `:442-444`), which is the honest user-facing outcome — this chapter cannot
  be streamed, download it.
- `api_client.dart:91-92` → keep the throw, but stop asserting "re-pair the
  device" for a 403.
- **`companion_runtime.dart:230-235` → a 401 on the handshake must reach
  `onRepairNeeded`, not `probeReachable → false`.** See §Q3 — without this,
  the legacy-record recovery story does not work for the offline-first user,
  who is the user this app is built for.

This clears the CLAUDE.md "defect the request exposed" bar: it is in code the
change already forces us to reason about, has one defensible fix, needs no
interface decision, and is coverable by a test in the same wave —
`apps/android/test/data/player_controller_test.dart` exists and `app.yml` runs it.

**Version skew, and the resulting ship order.** `apk:companion` auto-increments
`versionCode` so builds update-install, and `release.yml` publishes a
standalone APK, so *phone newer than desktop server* is a normal steady state.
In that direction the phone is the one that added an endpoint, so the phone is
the one carrying the fix — the livelock closes provided **the Dart fix ships no
later than the server enforcement**. That ordering is a hard requirement, not a
preference. See §PR shape.

**Deferred: advertising the granted scope in `GET /api/info`.** The triage
proposes it, and it is the right eventual home. But nothing in the client would
read it in this wave, `/api/info` is a contract surface (an `openapi.yaml` edit
stales `src/lib/api-types.ts`), and the 403 discriminator plus R3 already make
skew diagnosable. Adding a field nothing consumes is the speculative
flexibility CLAUDE.md rules out. File as a follow-up.

### Q3 — What scope does a legacy record get?

**None. A record without a valid `scope` does not authenticate.**

The file schema bumps to 3 — `DeviceTokensFile.schema` widens from `1 | 2`
(`device-tokens.ts:42`) and `persist` writes `schema: 3` instead of the
hardcoded `2` (`:101`). **This is documentation, not enforcement, and must not
be mistaken for it:** `loadSync` (`:87-98`) reads only `f.devices` and never
inspects `f.schema` at all, so the number gates nothing. The enforcement is
entirely the read-path check below.

The alternatives and why they lose:

- **Grandfather to `'full'`.** Every already-minted companion token keeps the
  whole API. The usual defence — "it self-heals within the TTL" — **does not
  hold**, and this is the claim to check before assuming a bound:
  `clampTtlDays` (`device-tokens.ts:79-81`) is
  `raw >= 1 ? raw : 30` — a floor and a default, **not an upper clamp** — and
  the knob `lan.deviceTokenTtlDays` (`config/registry.ts:1164`) declares
  `type: 'integer', min: 1` with **no `max`**. An operator who set `3650` has
  ten-year tokens. #2144 removes even that: a malformed `expiresAt` never
  expires at all. So grandfathering is unbounded in time.
- **Default to `'companion'`.** Instantly 403s every LAN browser session,
  because `pairing.ts:145` mints browser tokens. Non-starter.

Rejecting is also **the decision this codebase already made, one field over**.
`device-tokens.ts:26` comments `expiresAt?: string; // ISO; absent on legacy
schema-1 records → rejected`, and `:60` rejects rather than grandfathers. The
TTL work chose fail-closed deliberately; matching it keeps one rule instead of
two.

**The cost is one re-pair per device — but the recovery does NOT happen by
itself, and revision 1 was wrong to claim it did.** A rejected record makes
`findValidDevice` return `null`, so `requireLanToken` falls through to the
**401** at `:218`. Revision 1 argued that 401 is "exactly the code the client
already handles by re-pairing". It is not, for the user this app targets:

- `onRepairNeeded` fires from **one** place, `player_controller.dart:436` —
  the LAN-stream failure path.
- A 401 on the startup handshake is caught by `probeReachable`'s bare
  `catch (_)` (`companion_runtime.dart:230-235`) and reported as **"server
  offline"**.
- An **offline-first user whose library is already downloaded never streams**,
  so they never reach `player_controller.dart:436`. They see a server that is
  permanently unreachable, with no prompt to re-pair, indefinitely.

So reject-don't-grandfather remains right — the arguments above are untouched
— but it is only *safe* if PR A also routes a handshake 401 to
`onRepairNeeded`. That is now a required part of PR A, not a nicety.
Browsers are unaffected: they recover via `redeem-browser` on the next load.

This also removes the migration argument entirely — which is the part of the
previous attempt that adversarial review kept attacking.

### Q4 — How do you stop a future mint site creating unscoped tokens?

The triage proposes a required `createDevice` parameter and notes two bypasses.
**Only one of them is real** — revision 1 repeated both without checking:

- `server/src/routes/pairing.test.ts:66` — **real.** An untyped `vi.mock`
  factory whose `createDevice` is 2-arity. A 2-arity function is assignable
  where 3 are expected, so adding the parameter does not break it and the
  scope argument goes untested.
- `server/src/workspace/device-tokens.pure.test.ts:14` — **not a bypass.**
  Its `rec()` helper (`:14-24`) is an explicitly-typed
  `: DeviceTokenRecord` return listing every field, with **no `...over`
  spread**. Once `scope` is non-optional the returned literal is a compile
  error (TS2741), not a silent unscoped record.

  The related risk is real but different: `rec()` must then *gain* a scope
  field, and if it is written `over.scope ?? 'full'` every future scope test
  is silently authored against a full-scope record. The helper should default
  to `'companion'` — the restrictive value — so an under-specified test fails
  rather than passes.

**Does it matter? Yes — and it shows the guard is in the wrong place.** A
required constructor parameter is a *compile-time* constraint on *production
call sites*. It cannot constrain a mock or a hand-built literal, because those
are precisely the things that opt out of the constructor. The property actually
wanted is a **runtime** one: *no token lacking a valid scope ever
authenticates*.

So the design puts the load-bearing guard on the **read** path:

```ts
// server/src/workspace/device-tokens.ts — inside findValidDevice
if (d.scope !== 'full' && d.scope !== 'companion') continue;
```

This is immune to the real bypass, because the read path is the thing under
test rather than the thing mocked away: `pairing.test.ts`'s factory replaces
`createDevice` wholesale, so it never exercises the guard at all — which is
fine, because the guard is not on the mint path. It also covers what no
constructor signature can reach: a record hand-edited into
`device-tokens.json`, a partial migration, or a merge conflict — the same
input class #2144 is about.

Three supporting measures, in decreasing weight:

1. **`scope` is non-optional on `DeviceTokenRecord`** and required by
   `createDevice`, so the three production sites are compile errors until
   updated. Cheap; keep it. It is a prompt, not the guarantee.
2. **`pairing.test.ts` gains `lastCall?.[2]` assertions.** Today it asserts
   only `lastCall?.[0]` (`:147`, `:156`), so *which* scope each pairing site
   passes would otherwise be untested — and sites 1 and 2 pass **different**
   values, which is the whole point.
3. **A static call-site guard** asserting the exact set of `createDevice(`
   call sites in `server/src` and the scope literal each passes. Its value is
   review-forcing, not correctness-proving — it cannot judge whether a new
   site picked the right value, only make adding one a deliberate act. This
   mirrors the static guard the cast-lock sweep shipped for the analogous
   cast.json invariant. Asserted as an **exact set**, never a floor.

### Q5 — Relationship to #2144

**Not a hard prerequisite. Recommended first for merge hygiene only.**

The triage calls it a prerequisite because "any migration argument resting on
'legacy records expire' needs that closed first." That is sound *against the
design the triage assumed*. **This design has no migration argument** — Q3
rejects unscoped records rather than grandfathering them, so nothing here rests
on the TTL being unconditional. The dependency evaporates with the assumption
that created it.

The relationship actually runs the other way: #898 **reduces** #2144's blast
radius. A record with a malformed `expiresAt` still authenticates forever, but
once it carries `scope: 'companion'` the damage is bounded to nine read-mostly
endpoints instead of 123 operations. Neither issue makes the other worse.

What is real is a **textual collision**: both edit `findValidDevice`
(`device-tokens.ts:52-65`, a six-line loop — #2144 rewrites `:60`, this work
inserts adjacent to it) and both add rows to
`device-tokens.pure.test.ts`. #2144 is a one-line fix with a table-driven test.
Landing it first costs nothing and avoids a conflict in a security-critical
function. That is a scheduling preference, and it should be stated as one
rather than dressed as a dependency.

## Invariants to preserve

1. **Loopback always bypasses** (`lan-auth.ts:209`). The host UI is never
   scope-checked.
2. **The guard stays off unless LAN mode + a token are both set**
   (`lan-auth.ts:203-204`, `:208`).
3. **The shared secret keeps full access** (`lan-auth.ts:213-214`) — srv-20
   deployments are unaffected.
4. **`requireLanToken` stays synchronous.** The in-memory cache
   (`device-tokens.ts:85-98`) exists for this; scope is read from the same
   cached record, adding no IO.
5. **The `lastSeenAt` touch keeps firing on the hot path**
   (`device-tokens.ts:132-136`), including for a request that is subsequently
   scope-denied — the device *did* present a valid token, and losing that
   signal would make the admin list lie.
6. **CSRF stays orthogonal.** `requireSameOrigin` (`app.ts:125`,
   `csrf-origin.ts:92-94`) only engages on a mutating method *with* the
   `__Host-cw_lan` cookie; the companion sends `Bearer`, so it is unaffected.
7. **`POST /api/pair/redeem` stays outside the guard** (`app.ts:105`, mounted
   pre-guard) — it precedes the token it mints.
8. **Default deny.** An unmatched method+path is denied for companion scope.
   New routes are unreachable until explicitly added.
9. **A companion token can never bootstrap a full-scope token.** Neither
   `POST /api/pair/session` (`pairing.ts:50`, mounted **post-guard** at
   `app.ts:142`) nor `POST /api/devices/pair-session` (`devices.ts:54`,
   mounted `app.ts:141`) is on the allowlist, and neither may be added.

   This is not merely hygiene — it closes a live escalation path.
   `mayStartPairingSession` (`lan-auth.ts:138-140`) admits any request that is
   under the LAN-token guard *and* arrives via the friendly hostname, which
   today a companion token satisfies. Such a session can be redeemed at
   `pairing.ts:145` for a **`full`-scope browser token**. Scope is what makes
   the pairing surface unreachable from the phone; putting either route on the
   allowlist would silently restore full access to every companion token.

## Testing

Every guard below ships with a named mutation that turns it **red**.

### Two anti-vacuity preconditions, asserted first

The harness can silently prove nothing in two ways, both live in this file:

- **The loopback short-circuit.** A supertest request arrives as
  `::ffff:127.0.0.1`, which is in `LOOPBACK` (`lan-auth.ts:103`) and returns at
  `:209` **before any token check**. The existing suite defeats this by mocking
  a request on a documentation-range IP (`lan-auth.test.ts:26`:
  `const ip = opts.ip ?? '203.0.113.5';`).
- **The not-enforced short-circuit.** Without `LAN_HTTPS` *and*
  `LAN_AUTH_TOKEN`, `:208` returns `next()` and every assertion passes.

Both get an explicit inverted mutation (M14, M15) rather than a comment.

**`mkReq` must be extended.** As written (`lan-auth.test.ts:25-32`) it supplies
`ip`, `socket`, `headers`, `query` and **no `method`, `url`, `originalUrl` or
`path`**. A scope test needs the first two; a scope test written against
today's helper would read `undefined` for both.

### Mutation table

| # | Mutation | Must go red with |
|---|---|---|
| M1 | `requireLanToken` returns `next()` for companion scope unconditionally | the per-row **deny** cases (a sample of non-allowlisted routes incl. `DELETE /api/books/x/cover`) |
| M2 | Change row 8's method PUT→POST | R1 exact-table test **and** row 8's allow case |
| M3 | Delete row 5 from the table | R1 **and** row 5's allow case |
| M4 | Add `DELETE ^/api/books/[^/]+/cover$` to the table | R1 (exact equality, not subset) |
| M5 | Drop the `$` anchors | `POST /api/info/dismiss-whats-new` deny case |
| M6 | Match `req.path` instead of `req.originalUrl`'s pathname | the `/workspace/info` cross-mount deny case |
| M7 | `findValidDevice` accepts `scope: undefined` | legacy-record rejection case |
| M8 | `findValidDevice` accepts `scope: 'admin'` | unknown-scope rejection case |
| M9 | Denial returns 401 instead of 403 | denial-shape case (status **and** `error: 'scope-denied'`) |
| M10 | Dart: restore `status == 401 \|\| status == 403` at `player_controller.dart:435` | Dart test: a 403 upstream must **not** call `onRepairNeeded` |
| M11 | `pairing.ts:118` mints `'full'` | `pairing.test.ts` `lastCall?.[2]` assertion (redeem) |
| M12 | `pairing.ts:145` mints `'companion'` | the same assertion for redeem-browser |
| M13 | Add a 4th `createDevice` call site | static call-site guard |
| M14 | Flip the deny tests' IP to `::ffff:127.0.0.1` | **all** deny assertions — proves they exercise the token path, not the loopback bypass |
| M15 | Unset `LAN_AUTH_TOKEN` in the deny tests' env | **all** deny assertions — proves the guard is enforcing |
| M16 | Case-fold the path before matching | `GET /API/INFO` deny case (see below) |
| M17 | Allowlist `POST ^/api/devices/pair-session$` | invariant-9 escalation case |
| M18 | Dart: `probeReachable` swallows a 401 | handshake-401 → `onRepairNeeded` case (§Q3) |

M14 and M15 are inverted mutations: they do not break the production code, they
break the *test's own premise*. If either leaves the suite green, the suite is
a placebo and the finding is the point.

### Crafted-URL behaviour — measured, not assumed

The adversarial review pass ran a real Express **5.2.1** app with this spec's
exact array mount and probed **18** crafted shapes — `//api/info`,
`/api//info`, `/api/../api/info`, `%2F` and `..%2f` inside `bookId`, matrix
params (`;a=b`), trailing slashes, and case variants. **Every mismatch failed
closed; no over-grant was found.**

One result needs a permanent test rather than a note. Express routing is
case-insensitive and non-strict by default, so `GET /API/INFO` **routes** to
the info handler while the anchored lowercase pattern does **not** match — the
request is denied. That is the safe direction, but it is safe by accident: a
future "let's normalise case before matching" change would silently convert
this into a match, and nothing would notice. M16 makes that a visible diff.

The same probe run resolved the array-mount question revision 1 could not:
`GET /api/info` presents the middleware `originalUrl=/api/info`, `path=/info`,
`baseUrl=/api`; `GET /workspace/info` also presents `path=/info`. **The
cross-mount collision described in §Design is real**, and `originalUrl` is the
correct input.

### Coverage owed beyond the table

- **Nine allow cases**, one per row, driven through the real `requireLanToken`
  with a companion-scoped record.
- **A `full`-scope regression**: a browser-minted token still reaches a
  non-allowlisted route (guards against Q3's rejected alternative sneaking back).
- **Dart**: R2's per-method URL assertions in
  `apps/android/test/data/api_client_test.dart`, and M10's re-pair test in
  `apps/android/test/data/player_controller_test.dart`. Both run on the
  `app.yml` lane (`:10-16`), which is the only CI that fires on a Dart-only diff.

### On-box acceptance

Nothing here needs real hardware — no GPU, sidecar, analyzer, or real book. The
one thing tests cannot prove is the end-to-end phone↔desktop path over real LAN
HTTPS. Per CLAUDE.md that converts to a row in
`docs/testing/onbox-acceptance-register.md`: *pair a real phone against a
scope-enforcing server; confirm library sync, cover art, chapter download,
LAN streaming and resume-bookmark write all succeed; that a legacy
pre-schema-3 token prompts exactly one re-pair rather than looping; and — the
case §Q2 shows the unit tests cannot reach — that a phone holding a **legacy
token and a fully downloaded library**, which therefore never streams, still
reaches the pairing screen rather than reporting the server offline forever.*

## PR shape

**Two PRs, in this order.** #2144 ideally lands before either (Q5 — hygiene,
not dependency).

| PR | Contents | Scope |
|---|---|---|
| **A** | Dart: 401/403 split at `player_controller.dart:435`; **handshake 401 → `onRepairNeeded` at `companion_runtime.dart:230-235`**; the `api_client.dart:91-92` message; R2's per-call-site assertions; M10 + M18 | `apps/android/**` only → the `app.yml` lane |
| **B** | Server: `DeviceScope`, schema 3, read-path rejection, `device-scope.ts` + allowlist, `requireLanToken` enforcement, the three mint sites, R1, R3, the static guard, `pairing.test.ts` assertions | `server/**` → the `verify.yml` server scope (`:158`) |

**A before B is load-bearing**, not cosmetic, for two independent reasons:

1. B is what makes a 403 reachable, and A is what stops that 403 becoming a
   re-pair livelock on row 5.
2. B is what makes legacy records 401, and A's handshake fix is what turns
   that 401 into a re-pair prompt instead of a permanently "offline" server
   (§Q3). **Without A, B strands every offline-first user with a downloaded
   library** — the app's core use case.

Shipping B first opens a window in which both failures are unrecoverable from
the phone. The two touch disjoint trees, so they cannot conflict.

## Out of scope

- **Renew-on-LAN / TTL refresh.** The TTL half shipped (`74fb2901`). #898's
  framing of offline-first vs. expiry is resolved in practice by a long
  clamped default plus revocation. If renew-on-LAN is still wanted it is a
  separate ask.
- **Advertising scope in `GET /api/info`** — deferred with reasons (Q2).
- **Scoping the shared secret** (`LAN_AUTH_TOKEN`) — invariant 3.
- **A `scope` parameter on `POST /api/devices`** — loopback-only; the QR flow
  is the shipped path for phones.
- **Any capability/permission grammar**, per-book scoping, or scope
  inheritance. Two values, one program.
- **Fixing #2144** — independent, one-line, its own PR.
- **`openapi.yaml` / `api-types.ts`** — the guard's existing middleware-level
  401 is undocumented (measured: zero `'401':` entries); the two documented
  `'403':` entries (`:1173`, `:2661`) are route-level consent denials, a
  different kind of thing. See §Denial shape.
- **Wiring `apps/android/**` into `verify.yml` / `verify-cache.mjs`** — that
  is the scope-map unification spec's territory, and colliding with it mid-flight
  is how a fifth map gets created.

## What I could not establish

*(Revision 1 listed two more. Both were resolved by the review pass and are
now recorded as established — see §Crafted-URL behaviour for the Express
array-mount semantics, and §The allowlist covers a version range for the
released-APK question. Neither is an open item.)*

1. **The true Express route count behind the guard.** 123 operations is the
   `openapi.yaml` figure and a floor — the real registration count is larger.
   The over-grant ratio is therefore "9 of at least 123", stated as a floor.
2. **Whether `POST /api/devices` has any consumer at all** beyond a human with
   curl. The frontend does not call it (`src/lib/api.ts:7055`, `:7062`, `:7067`
   are pair-session, list, and revoke). I inferred operator use from
   `devices.ts:35-37`'s comment.

## Review findings

Revision 1 went through the mandatory Premium-tier `assumption-checker` gate.
44 of 47 citations were exact. **Every one of the five design decisions
survived attack** — read-path enforcement, `originalUrl` matching,
method-aware anchored rows, reject-don't-grandfather, and #2144-not-a-
prerequisite. Findings folded, each re-verified here before acceptance:

| Finding | Severity | Disposition |
|---|---|---|
| §Q2 taxonomy derived from a too-narrow grep — untyped `catch (_)` / `.catchError` / `on Exception` catch `ApiException` too | **Critical** | table re-derived per row; 8 of 9 rows are silent; denial log promoted from backstop to sole signal |
| §Q3 self-heal false for the offline-first user — a handshake 401 reads as "server offline", and `onRepairNeeded` fires only from the stream path | **Critical** | PR A widened to route handshake 401 → `onRepairNeeded`; M18 |
| "zero `403:` in `openapi.yaml`" — bad grep, there are two (`:1173`, `:2661`) | Major | measurement corrected; conclusion re-argued from the 401 precedent, which is the true middleware-level analogue |
| "could not establish whether released APKs predate PR A" — establishable, and yes | Major | §The allowlist covers a version range; correctness criterion restated as the union over supported versions |
| `authenticateDeviceToken(): { scope }` cannot supply the denial log's device label | Minor | returns `DeviceTokenRecord \| null` |
| `routes/info.ts:3` is a doc comment | Minor | corrected to `:118` (handler) / `:148` (the sibling POST) |
| "schema bumps to 3" is inert — `loadSync` never reads it | Minor | stated as documentation, not enforcement |
| `lan-auth.test.ts:8-10` mocks only `isValidDeviceToken`; renaming breaks every test | Minor | folded into the same change |
| R2 would pin `ApiClient.info()`, which is dead production code | Minor | pin `companion_runtime.dart:231`; dead method reported, not fixed |
| `[^/]+` justified only from `Uri.encodeComponent` at row 9 | Minor | widened to `makeBookId`/`slug` (`paths.ts:110-118`) — every non-Latin book, all nine rows |

**One minor was itself wrong and is rejected.** The review held that
`device-tokens.pure.test.ts:14`'s `rec()` helper is a bypass of a required
`scope`. It is not: `:14-24` is an explicitly-typed `: DeviceTokenRecord`
return with no `...over` spread, so a missing `scope` is a compile error
(TS2741). Revision 1 had repeated that claim from the triage without checking
it; both are corrected in §Q4, which now leans on the `pairing.test.ts:66`
bypass alone — that one is real.

**Two open items were closed in the spec's favour** and moved out of §What I
could not establish: the Express 5.2.1 array-mount probe confirmed the
cross-mount collision is real and `originalUrl` is correct, and 18
crafted-URL shapes all failed closed. The one accidental safety property found
there — case-insensitive routing vs. a case-sensitive pattern — gained M16 so
it cannot be undone silently.

## Benefit

*Benefit (architectural / security):* converts the post-mint defence from a
single layer — manual revocation — into defence in depth. A leaked or
compromised companion token reaches nine read-mostly endpoints instead of at
least 123 operations, and cannot delete a cover, mutate cast, touch
`/workspace`, or — per invariant 9 — mint itself a full-scope browser token
through the pairing surface, which it can today. It also closes two latent
client defects before enforcement makes them reachable (403 → infinite
re-pair on the stream path; a handshake 401 misreported as "server offline"),
and replaces an unbounded legacy-credential window with a single re-pair.
