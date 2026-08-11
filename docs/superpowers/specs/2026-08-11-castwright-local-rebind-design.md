# One-click `castwright.local` re-bind + a longer device-token lifetime

**Date:** 2026-08-11
**Status:** approved (design, revision 5)
**Area:** `frontend` + `server` (LAN device auth)

## Problem

Browsing the app at `https://castwright.local` returns a dead-end error —
_"Couldn't load your library / Library scan failed (401): {"error":"Missing or
invalid LAN access token."}"_ — every time the host browser's device token
lapses.

1. **It expires on a 30-day clock.** `POST /api/pair/redeem-browser` mints with
   `ttl()` days (`lan.deviceTokenTtlDays`, default 30) and sets `__Host-cw_lan`
   with a matching `maxAge` (`server/src/routes/pairing.ts:163-172`).
2. **The failing origin cannot fix itself.** `__Host-cw_lan` is **host-scoped**
   (the `__Host-` prefix forces `Secure`, `Path=/`, and no `Domain`; cookies
   ignore port), so only a response served from `castwright.local` can set it.
   Minting requires loopback (`POST /api/devices/pair-session`) or an
   already-authenticated friendly-host request (`mayStartPairingSession`,
   `lan-auth.ts:138`). An expired browser on `castwright.local` is neither.

The host's own browser is genuinely non-loopback on the `:443` path: the
forwarder presents peer IP `127.0.0.2`, deliberately excluded from the loopback
allowlist (`lan-auth.ts:103`, rationale at `:133-136`). Not revisited here.

## What already exists

Account → LAN access → type a device name → **Authorize a device** → QR →
small link _"Open pairing link on castwright.local"_
(`src/components/lan-access-card.tsx:70-77`) → `castwright.local/#/pair?c=CODE`
→ **Authorize** (`src/views/pair.tsx`) → `POST /api/pair/redeem-browser` sets
the cookie. A typed label and four clicks through a phone-shaped flow, with no
pointer to it from the screen that fails.

## Revision history

**Revision 1** proposed sliding `expiresAt` forward in `touchLastSeen`. Killed:
`res.cookie('__Host-cw_lan', …)` at `pairing.ts:166` is the *only* `Set-Cookie`
in the server and `touchLastSeen` never sees a `Response`, so the browser kept
dropping its cookie on schedule; and the write closure
(`device-tokens.ts:535-542`) runs inside `enqueueWrite` with no validity
re-check, so a token lapsing between check and write would have been refreshed.

**Revision 2** replaced that with a TTL default change, but under-scoped the
self-bind marker (it needed a wire-format change across four files), held three
incompatible models of when the button is visible, and deferred a new
unauthenticated endpoint to "the plan".

**Revision 3** removed scope rather than adding it: the revoke-prior-record
behaviour and the `friendlyUrl` emitter change were both dropped as follow-ups,
making Component 2 frontend-only.

**Revision 4 (this one) fixes precision, not shape.** The design has been stable
since revision 2 — button, recovery link, longer lifetime. What kept breaking
was this document's accuracy about *which files and tests are involved*: a third
review found the button placed in a branch the card hides in exactly the target
scenario, a prescribed parity test that could never fail, and a `Max-Age`
assertion contradicted by an existing mock. All three are corrected below. The
remaining risk is now the kind TDD catches during implementation, not the kind a
fourth spec review would.

**Revision 5 folds the plan-level `assumption-checker` round.** That prediction
held only partly: the *shape* survived untouched, but the round found two design
questions the spec had never named — the clamp's behaviour below its floor, and
whether the mock registry is meant to mirror the server in full. Both are
resolved in the table below. Everything else it found was plan-level precision
(wrong test-helper names, a code block that would have erased an existing
regression suite) and is recorded in the plan's own review history, not here.

## Decisions taken

| Decision | Choice |
|---|---|
| Lifetime | Raise the `lan.deviceTokenTtlDays` **default**, and add an upper bound; no renewal machinery |
| Recovery | One-click self-bind button + a way out at the 401 |
| Self-bind confirm screen | **Auto-redeem** on the self-bind hop; confirm stays for QR devices |
| Button visibility | **Unconditional**; failure is explained post-click |
| Duplicate device rows | Accepted for v1 — see Component 2 |
| `:443` forwarder trust | Unchanged |
| **Clamp below the floor** (r5) | **Clamp to `1`, not to the default.** `clampTtlDays` maps any out-of-range *integer* to the nearest bound; only a non-integer falls back to `365` |
| **Mock parity guard scope** (r5) | **Intersection of both catalogues**, not all groups — the mock is a documented 98-of-115 subset |

**Why the clamp floor changed.** The old shape returned the default for anything
`< 1`, so an operator hand-editing a stored override to `0` — the one path the
clamp exists to guard, since `resolveKnobInner` returns overrides unvalidated —
was trying to *shorten* the lifetime and silently got the *longest* one. That
was a curiosity at 30 days. At 365 it is a 12× footgun, and a function named
*clamp* mapping one bound to the nearest value and the other to a default is
incoherent besides. Symmetric clamping costs one line and the paired test states
the intent.

**Scrub-before-redeem is scoped to the self-bind path** (r5). Component 3 moves
the URL scrub ahead of the redeem call so a failed attempt cannot leave a live
code in history. Applying that unconditionally would also capture the manual QR
click handler, where today's scrub-on-success means a phone user whose redeem
failed can still refresh and retry — so an unconditional move would import this
feature's own dead-end into the one flow this spec says it does not touch.

## Component 1 — Longer default lifetime, with a ceiling (server + mock)

Change the default from `30` to `365`, and add `max: 400` to the descriptor
plus a matching upper clamp in `clampTtlDays`.

**The upper bound is not optional.** Chrome has capped cookie `Max-Age` at 400
days since M104; WebKit shipped no equivalent cap, so this is Chrome-specific
rather than universal — but on Chrome, a value above 400 gives a server record
valid for years against a cookie truncated at 400 days, which is the original
bug with a longer fuse.

**Why the clamp is still needed once `max: 400` exists** — the obvious
justification is wrong and a reviewer will cut the clamp if the spec repeats it.
`max` is **enforced**, not advisory: `coerceAndValidate`
(`server/src/config/resolver.ts:168`) rejects `n > knob.max` on *both* write
paths — the env path (`parseEnv` → `coerceAndValidate`, called from
`resolveKnobInner:19`) and the Settings PUT (`server/src/routes/config.ts:101`).
So `LAN_DEVICE_TTL_DAYS=1000` is already rejected and warned, and after this
change no Settings edit can exceed 400 either. The one path that reaches a read
site **unvalidated** is a stored override: `resolveKnobInner` returns
`{ effective: raw, source: 'override' }` (`resolver.ts:32-55`) with no
re-validation, so a hand-edited `user-settings.json` is what the clamp actually
guards. State that reason, not the Settings-edit one.

Note also that `clampTtlDays` has **no tests at all** today — the only hit is a
mock reimplementation at `pairing.test.ts:85`. `docs/features/225-lan-browser-device-auth.md:46`
claims `device-tokens.pure.test.ts` / `device-tokens.test.ts` cover it; that
claim is false and the file is already moving in this diff, so correct it there.

**Every site that bakes in 30** — the inventory, because Component 1 is
otherwise a two-line change and the search *is* the risk:

| Site | What it is |
|---|---|
| `server/src/config/registry.ts:1261` | the default |
| `server/src/workspace/device-tokens.ts:86` | `clampTtlDays` fallback |
| **`src/lib/api.ts:9446`** | **mock registry mirror — see below** |
| **`src/lib/api.ts:7363`** | `mockRedeemBrowserPair`'s hardcoded `30 * 86_400_000` expiry |
| **`server/src/routes/pairing.test.ts:59`** | `vi.mock('../config/resolver.js', () => ({ configValue: () => 30 }))` — see Testing |
| `server/src/routes/pairing.test.ts:85` | test-local `clampTtlDays` reimplementation |
| `server/src/config/registry.test.ts:78-88` | existing assertion **and its title** ("…with a 30-day default") — an *edit* |
| `docs/wiki/Advanced-Settings.md:363` | the row's default **and** its Constraints cell (`integer, min 1` → add `max 400`) |

`server/.env.example:683` also carries the value but is generated by
`config:sync` and mechanically gated by `config:check` in
`verify:fast:branch`, so it cannot be forgotten. `docs/wiki/` is **mirrored**,
not generated (`scripts/sync-wiki.mjs:1-9` — the repo copy is the source of
truth), so the hand edit is correct and will not be clobbered. `openapi.yaml`
has no pairing paths and `apps/android/` has no TTL reference — no sites there.

The mock mirror is the dangerous one, and the fix revisions 2-3 prescribed was
itself a placebo. The parity guard (`src/lib/api.config.test.ts:305-361`)
compares `.map(d => d.key).sort()` plus group blurbs, for two groups, neither of
them `lan-access` — and `lan-access` holds exactly **one** knob
(`registry.ts:1257`), so a keys-only comparison over it can never catch a
30-vs-365 drift. There is also no group named `default`; that word meant the
*field*. The guard must therefore compare a **projected object per knob —
`{key, default, min, max}`** — not keys, and not whole descriptors:
`MOCK_CONFIG_DESCRIPTORS` (`src/lib/api.ts:8306`) omits `env`, so a
whole-descriptor `toEqual` fails for unrelated reasons.

**Revision 5 narrows that guard from "all groups" to the intersection**, after
the plan review found the wider version unshippable. `MOCK_CONFIG_DESCRIPTORS`
is `const` and **not exported** (reach it via `mockGetConfig()`), and the mock
is a **deliberate subset** — `src/lib/api.config.test.ts:311-313` says so, and
the split is 115 registry knobs to 98 mock ones, with 2 mock-only UI entries
that are not registry keys at all. An all-groups `toEqual` therefore cannot
pass without adding 19 descriptors and deleting 2, which is a separate PR. The
guard compares knobs present in **both** catalogues, with a non-emptiness floor
so it cannot decay into `[] === []`. Two genuine drifts on shared keys
(`tts.preload.kokoro`, `analyzer.gemini.model`) surface and are fixed here as
incidental findings; the 19 missing descriptors are filed, not fixed.

Three consequences to state plainly:

- **New mints only.** Existing records keep their stored `expiresAt`. Today's
  expired browser picks up the longer lifetime by re-binding once.
- **A saved Settings override wins forever.** `resolveKnobInner`
  (`server/src/config/resolver.ts:31-55`) consults stored overrides *before*
  `knob.default`, so an install where the user ever saved that row keeps 30 and
  is unaffected by this change. Say so in the release note.
- **The knob's `help` text is now misleading.** *"How long a browser/device
  authorization stays valid before it must be re-paired"* reads as applying to
  devices already paired; at 365 that ambiguity costs a year. Reword it to say
  the lifetime applies to **newly authorized** devices — the "new mints only"
  fact belongs where the user sees it, not only in this spec.

## Component 2 — One-click self-bind (frontend only)

**File:** `src/components/lan-access-card.tsx`

A second button, **"Authorize this browser"**, beside the existing device flow.
It calls `api.createDevicePairSession({ label: 'This computer' })` and, on a
response carrying `friendlyUrl`, navigates there with `self=1` appended.

**Where it renders — precisely.** The card already gates its whole device flow
on a 401 from `listDevices()`: `manageHint ? <p>Manage devices from the desktop
app.</p> : <>…</>` (`lan-access-card.tsx:24`, `:55-58`). The button goes in the
**authorized branch**, alongside the existing flow.

That is not a limitation, it is the constraint from the Problem section
restated: on `castwright.local` with a lapsed cookie the button could not work
anyway — `POST /api/devices/pair-session` sits behind the guard, and
`mayStartPairingSession` (`lan-auth.ts:138`) refuses a non-loopback caller whose
token has expired. **The self-bind button serves the loopback origin; the 401
branch is served by Component 4's recovery text, not by this button.** Revisions
2 and 3 both said "renders unconditionally", which is wrong in opposite
directions and is what made the visibility model incoherent — the honest rule is
that visibility follows authorization, and the *unauthorized* case is a
different component's job.

Within the authorized branch there is no pre-flight: `friendlyUrl` exists only
in the endpoint's response (`devices.ts:107-110`), and the `409 not-lan-https` /
`409 lan-auth-not-enforced` cases are likewise replies *to the click*
(`devices.ts:84-95`). So every failure is explained inline afterwards, including
`friendlyUrl === undefined` → *"castwright.local isn't reachable right now —
use the QR flow, or check that the app is running in production LAN mode."*

**Two things deliberately NOT done in v1:**

- **No revoke of the prior self-bind record.** Marking a record as self-bound
  means carrying a marker on the pairing *session* — the mint happens on a
  different request (`/redeem-browser`, whose body is only `{ code }`) — which
  needs signature changes across `pairing-sessions.ts`, `pairing.ts`,
  `device-tokens.ts` and `devices.ts`, plus a careful non-nesting
  `enqueueWrite` composition (`device-tokens.ts:499-507`: a function running
  inside `enqueueWrite` must never call another that does — *permanent
  deadlock, no timeout, no diagnostic*). Taking the marker off the redeem body
  instead is refused: it is client-controlled and would let any LAN redeemer
  revoke another device's credential. The cost of skipping this is cosmetic —
  repeat binds leave extra "This computer" rows, each revocable by hand. **File
  a follow-up issue** rather than growing this PR.
- **No change to the `friendlyUrl` emitter.** Re-binding would also work over
  `https://castwright.local:8443`, but the emitter collapses "mDNS alive" and
  "forwarder bound" into one boolean in `server/src/index.ts:360-362`, so
  splitting them is an `index.ts` contract change. On a box where `:443` is
  bound — the shipped configuration — this costs nothing. Follow-up issue.

The existing QR flow is untouched.

## Component 3 — Auto-redeem on the self-bind hop (frontend)

**File:** `src/views/pair.tsx`

With `self=1`, redeem on mount instead of waiting for a click.

**Scrub the code from the URL before the redeem call, not after.** Today
`pair.tsx:19` calls `replaceState` inside the `try`, only on success, so a
failed redeem leaves `#/pair?c=CODE&self=1` live in history for the rest of the
code's TTL — armed to re-fire on a tab restore or Back. With auto-redeem that
is an unattended side effect.

**Capture the code in a ref before scrubbing — do not rely on it surviving.**
The app uses `createHashRouter` (`src/routes/index.tsx:1128`), whose history
listens on `popstate`/`hashchange`; `replaceState` fires neither, so
`params.get('c')` keeps returning the code only because react-router's location
is now *stale*. An implementer who scrubs the idiomatic way instead —
`navigate('/', { replace: true })` — updates the router, `code` becomes `''`,
and Retry is dead. Hold the code in a `useRef`/lazy `useState` so correctness
does not depend on which scrub idiom is chosen.

**The scrub creates a retry obligation.** `pair.tsx:8` reads `code` from
`useSearchParams()`; once scrubbed, the captured code is the only reliable
copy, while the session remains valid server-side (the 403 path returns before
`redeemPairingSession`, and the 503 path calls `restorePairingSession`,
`pairing.ts:148-151`, `:177`). The error copy invites a retry, so the component
must own an **in-place Retry button reusing the closured code** — otherwise the
user refreshes, lands on `#/`, and hits the exact 401 dead end this design
exists to remove.

Security argument, corrected: the gate is the one-time code — single-use,
rate-limited to 5/min per IP (`pairing.ts:90-100`), 80 bits of entropy, and
expiring in **5 minutes** (`TTL_MS`, `pairing-sessions.ts:11`; the third
argument to `createPairingSession(label, undefined, 10)` is `bytes`, i.e. code
length, **not** minutes — revision 1 misread this). `self=1` is
client-controlled and is not a trust signal. What it trades away is the
accidental-navigation guard, which is exactly why scrub-before-redeem is a
requirement of this component rather than a nicety.

## Component 4 — A way out at the failure site (frontend)

**Files:** `src/lib/api.ts`, `src/store/library-slice.ts`,
`src/components/layout.tsx`, `src/views/book-library.tsx`,
`src/components/lan-access-card.tsx`

`realGetLibrary` (`api.ts:1943-1946`) throws a plain `Error`, not `ApiError`;
the status never reaches the view. So: throw `ApiError` (as
`realCreateDevicePairSession` at `:7298` already does), widen `hydrateError`
from `PayloadAction<string>` (`library-slice.ts:76`) to carry the status, and
branch on 401 in the panel at `book-library.tsx:396-403`.

**Both dispatchers must move.** There are two:
`layout.tsx:581` (first load) and **`book-library.tsx:246` (the Retry handler
on this very panel)**. Fixing only the first makes the recovery link vanish the
moment the user presses Retry — the most likely interaction on that screen.
Widening the action also moves `library-slice.test.ts:188` and
`book-library.test.tsx:823`.

**Do not string-match `/\(401\)/`** — a test asserting that is circular.

Also fix the second dead end: on `castwright.local` with a lapsed cookie the
Account LAN card renders only "Manage devices from the desktop app."
(`lan-access-card.tsx:55-56`). It gets the same recovery text.

**The link address — all three branches, because two of them are wrong if
unhandled.** No new endpoint (revision 2's other option was a new
unauthenticated route on a LAN-exposed server — a blast-radius decision, not a
plan detail), and no new hardcoded `:8443`:

| Failing page | `location.port` | What to render |
|---|---|---|
| `castwright.local` via the `:443` forwarder — **the shipped config** | `''` | Copy naming the computer, **no port promised**. `location.port` is empty for default ports, so a derived `https://localhost:` is a broken link |
| `castwright.local:8443` direct | `'8443'` | Exact link — `https://localhost:8443` is loopback-exempt and cert-covered |
| A bare LAN IP (a phone) | `'8443'` | **Must not say `localhost`** — on a phone that resolves to the phone. Copy points at the computer running Castwright |

Host-vs-remote is decided by hostname, not port: `localhost` and
`castwright.local` mean the host, a bare private IPv4 means another device
(the same split `lan-auth.ts:169`'s `PRIVATE_V4` and the client-side
`_isPrivateIpv4Host` already make). Note `lan-access-card.tsx:35` and
`PAIRING_ORIGIN_HINT` (`lan-auth.ts:144-145`) already hardcode
`https://localhost:8443`; this design does not add a third such promise, and
does not rewrite those two — out of scope.

## Data flow

```
loopback page (https://localhost:<bound port>)
  └─ POST /api/devices/pair-session          → { url, code, expiresAt, friendlyUrl? }
     └─ navigate https://castwright.local/#/pair?c=CODE&self=1
        └─ scrub code from history
           └─ POST /api/pair/redeem-browser  → createDevice(label, ttlDays)
              └─ Set-Cookie __Host-cw_lan    (pairing.ts:166)
                 └─ redirect '/' → library loads
```

The redeem hop is gated by `isPrivateNetworkRequest` + `isLanTokenEnforced`
(`pairing.ts:148-155`) — **not** `mayStartPairingSession`, which governs the
loopback `pair-session` call and passes trivially there. `PRIVATE_V4`
(`lan-auth.ts:169`) matches the LAN IP mDNS resolves to.

CSRF is a non-issue and the spec says so rather than omitting it:
`pairRedeemRouter` mounts at `app.ts:106`, **before** `requireSameOrigin` at
`:126`, and `csrf-origin.ts:52-55` allowlists both `https://castwright.local`
and the ported form anyway.

## Error handling

| Condition | Response | Surfaced as |
|---|---|---|
| LAN HTTPS not active | `409 not-lan-https` | Inline: LAN mode isn't on |
| Guard not enforced | `409 lan-auth-not-enforced` | Inline: same |
| No `friendlyUrl` in response | — | Inline: castwright.local not reachable |
| Off-LAN redeem | `403` | Own message (new branch) |
| Stale / reused code | `401` / `410` | "This code expired — generate a new one." |
| Rate cap (5/min per IP) | `429` | "Too many attempts — wait a minute." **No Retry button** |
| Device store degraded | `503` | Own message, transient + **Retry button** |

The code survives all three, so Retry is mechanically sound where offered: the
403 path returns *before* `redeemPairingSession` (`pairing.ts:148-151`), the
`429` is rejected by middleware so the handler never runs (`pairing.ts:143`),
and the 503 path calls `restorePairingSession` (`:177`). Retry is nonetheless
withheld on `429` — the limiter is a fixed 60-second window
(`pairing.ts:89-91`), so a button offered immediately would simply fail again;
the copy tells the user to wait instead. It is withheld on `403` because an
off-LAN caller will never succeed.

`pair.tsx:22-26` currently funnels everything but 401/410/429 into a generic
message. With auto-redeem the user took no action to explain a failure, so 403
and 503 need their own branches. `PAIRING_ORIGIN_HINT` is **not** what
`/redeem-browser` returns — it only reaches the loopback card
(`lan-access-card.tsx:34-35`).

## Testing

**Server.** Three assertions, and it matters which proves what:

1. **The registry default is `365`, as a literal** — the only assertion that can
   fail before the change. `clampTtlDays`'s fallback equals it, but an
   equality-only assertion is a no-op (it passes at 30===30, at 365===365, and
   if the change is never made), so at least one side must be a literal.
   `clampTtlDays` also gets its **first real tests**: both bounds, and the
   non-integer fallback.
2. **`max: 400` is present and rejects 401** through `coerceAndValidate`.
3. **The `Set-Cookie` carries `Max-Age`** — `pairing.test.ts:227-239` asserts
   `HttpOnly` / `SameSite` / `Secure` and *no* `Max-Age` today, and revision 1
   died precisely because the record and the cookie can disagree. **This test
   cannot be written as revision 3 stated it:** `pairing.test.ts:59` mocks
   `configValue` to a hardcoded `30`, so the route emits `Max-Age=2592000`
   regardless of the registry. Change that mock to `365` and assert
   `Max-Age=31536000` — but be clear what it proves: that `maxAge` tracks
   `ttl()`, **not** that the default is 365. Assertion 1 is what proves the
   default. Neither is sufficient alone; the spec asks for both because
   revision 1's failure mode lived exactly in the gap between them.

**Frontend:** the button mints with the fixed label and navigates to
`friendlyUrl` with `self=1` (`window.location` stubbed); an absent
`friendlyUrl` renders the inline explanation; `#/pair?self=1` redeems on mount
while bare `#/pair` waits for a click; the scrub happens **before** the redeem
resolves (assert ordering — this fails against today's `pair.tsx:19`); after a
failed auto-redeem the hash is `#/` **and** a Retry affordance is present; a 401
library error renders the recovery link via the `ApiError` status **from both
dispatch paths, including Retry**; `403`/`503` render their own messages;
`api.config.test.ts` covers `lan-access` defaults.

**E2E** (`e2e/lan-device-auth.spec.ts`): only the `#/pair?c=…&self=1` half is
reachable — the button navigates to an absolute `castwright.local` URL that
Playwright's mock server on :5174 cannot resolve. Note
`mockCreateDevicePairSession` (`api.ts:7341-7347`) always returns a port-less
`friendlyUrl`, so mock mode cannot exercise the absent case.

**On-box acceptance:** `friendlyUrl` needs the mDNS responder and forwarder,
both gated to `NODE_ENV === 'production'` (`lan-port-forwarder.ts:40-43`), so
`npm run dev:lan` can never render a working button. The local production route
is `npm run build && npm run start:lan` — which needs elevation to bind `:443`.
The row confirms a cleared-cookie browser recovers in one click on the real box
and that a fresh bind shows `expires` ~a year out.

## Repo obligations

- GitHub issue + implementation-brief comment; `Closes #NN` in the PR body.
- `docs/features/225-lan-browser-device-auth.md` (`active`) documents the 30-day
  default at `:53` (only — `:33` carries no `30`), and falsely claims
  `clampTtlDays` test coverage at `:46`. Both move in the same diff.
- `docs/wiki/Advanced-Settings.md` row (published by `npm run wiki:sync`).
- `npm run config:sync` to regenerate `server/.env.example`.
- Release notes in **both** `docs/release-notes-next.md` and `RELEASE_NOTES.md`.
- Follow-up issues for the two deferrals in Component 2.

## Out of scope

- Widening the loopback allowlist to `127.0.0.2`.
- Re-issuing the cookie from the LAN guard (revision 1's approach).
- Any change to QR pairing for phones and tablets.
