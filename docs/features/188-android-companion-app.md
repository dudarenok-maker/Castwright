---
status: draft
shipped: null
owner: null
---

# 188 — Android (Flutter) companion app

> Status: draft (epic / initiative umbrella — the `app-*` items each ship under their own plan)
> Key files (to be created): `apps/android/` (Flutter project), `server/src/routes/` (the `srv-32` sync-manifest route)
> URL surface: native app — pairs to the server over LAN HTTPS; no new web URL
> OpenAPI ops: **new** `GET /api/library/sync-manifest` (`srv-32`); **extends** `PUT /api/books/{id}/listen-progress` (optional `listenedAt`, `srv-34`) + the `GET /api/export/lan` / pairing payload (`token` + `caFingerprint`, `srv-20`); **reuses** `GET /api/library`, `GET /api/books/{id}/chapters/{cid}/audio(.mp3)`, `GET /api/books/{id}/listen-progress`, `GET /api/books/{id}/cover`, `GET /api/info`, `GET /cert/root.crt`

This is the **umbrella spec** for a native, Android-first listening companion app. It
is the durable home for the architecture, the cross-cutting iOS-readiness principles,
the full backlog decomposition (`srv-32` + `app-1..14`), the v1 definition-of-done, and
the wave-sequenced delivery roadmap. Each backlog item lands under its own branch + plan
per CLAUDE.md; this doc is what they hang off.

---

## Benefit / Rationale

The web app *already* works on an Android phone today over LAN HTTPS (plan 81 —
responsive, touch-equivalent, QR/cert install), so "use it on a phone" is solved. The
companion's value-add is the stuff a browser tab can't do well, and specifically the
one thing the existing export → sideload → third-party-listener-app flow handles badly:
**incremental sync of a constantly-regenerated library.**

- **User:** Fix one chapter's attribution, add an emotion variant, or upgrade a voice on
  the server, and today you must re-export and re-copy the *entire* M4B to your phone.
  The companion re-pulls **only the one changed chapter**. It also flows your in-car
  listening position back to the server (today resume is one-way), and gives seamless
  offline + Bluetooth/lock-screen playback for the car without a per-change full resync.
- **Technical:** A delta-sync client built on **per-chapter audio files** (each
  independently addressable + HTTP-range-capable) instead of monolithic exports — so a
  regenerated chapter costs a one-file re-pull, never a whole-book rebuild.
- **Architectural:** Establishes the **`app` surface** (`apps/android/`, prefix `app`,
  commit scope `app`) and a server-side **sync-manifest contract** (`srv-32`) that any
  future client (incl. iOS) consumes. Chosen Flutter so iOS is a near-free follow-up.

## The killer feature (why this exists)

Today's pain, in the user's words: the library is **alive** — chapters get re-recorded
(attribution fixes, per-character splices, QA re-records, loudness renorm), emotion
variants get added, voices get upgraded — and every such change forces a full-book
re-export + re-sync into whatever third-party player they sideloaded to. The companion
makes the phone a **delta-sync mirror** of the server's per-book audio: on each home-LAN
reconnect it pulls only what changed and pushes back where you listened. That is the
differentiator vs. the existing listener-app handoffs (`fe-3`/`fs-7`/`fs-8`).

## Architecture

- **Product shape:** native listening client (not a PWA, not a WebView wrapper) that
  **pairs to the server**.
- **Tech stack:** **Flutter** (`just_audio` + `audio_service`), cross-platform so iOS is
  an incremental follow-up ("Android **initially**").
- **Code location & IDs:** monorepo at **`apps/android/`** (the Flutter project is
  multi-platform; the iOS target lives in the same project). New permanent BACKLOG prefix
  **`app`** + new commit scope **`app`**.
- **Core design principle:** a **delta-sync mirror of each book's per-chapter audio + a
  two-way resume sync**, offline-first. Sync **per-chapter `…/audio.mp3` files**, NOT
  M4B exports — a regenerated chapter = one-file re-pull.
- **Reachability model:** sync happens on the home LAN (LAN HTTPS, mkcert-trusted);
  playback is offline and works anywhere. **No internet exposure / tunneling in v1.**

### Server facts (verified — grounds the items)

| Need | Status | What it means |
|---|---|---|
| Cover image **bytes** | **EXISTS** — `GET /api/books/:id/cover` (range, cacheable JPEG) | App caches covers offline; no server work. |
| Version/capability **handshake** | **EXISTS** — `GET /api/info` (`appVersion` + `schemas` map) | Reuse for compat-gating; no new endpoint. App checks the server is new enough for the sync manifest via a `schemas` bump. |
| LAN **root CA** for trust | **EXISTS** — `GET /cert/root.crt` (mkcert CA PEM); `GET /api/export/lan` returns `{ urls, port, protocol }` only (no token/fingerprint **yet**) | **Key iOS unlock:** app fetches the CA at pairing and **pins it in its own Dart `SecurityContext`** — trusting the server **without** an OS cert install (removes the iOS ATS/MDM blocker; identical on Android). **Hardening from secondary review:** the pairing QR must also carry the `srv-20` token + the CA's SHA-256 so the app *auto-verifies* the fetched CA (no manual hex compare) — a small extension to the LAN/pairing payload (`srv-20`). |
| Per-chapter **fingerprint** | **PARTIAL** — `audioRenderedAt` + `audioModelKey` + file size change on regen; no content hash | Manifest = reshape of existing `scan.ts` data (cheap). **Catch:** every audio-mutating path must bump the stamp (see `srv-32` acceptance). |
| Listen-progress scope | **PER-BOOK ONLY** (confirmed) | Cross-book "continue listening" is client-side (app sorts books by `listen-progress.updatedAt`). Ties to `fs-15`. |
| `GET /api/library` cost | **GAP** — O(books) walk, no `?since`/pagination | Manifest needs a **`?since=` delta** from day one to stay cheap on big libraries. Deletions can't use server tombstones (a stateless filesystem scan has no memory of deleted folders) — instead every response carries the **full active book/chapter ID set** and the client evicts what's missing (see `srv-32`). |

### Cross-cutting iOS-readiness principles (enforced per item)

1. **App-managed TLS trust, not OS trust — auto-verified.** The pairing QR carries
   `{ url, token, caFingerprint }`. At pair time the app fetches `/cert/root.crt` over a
   **one-shot, validation-bypassing** HTTP client (the self-signed cert isn't trusted
   yet), asserts the fetched CA's SHA-256 **equals the scanned `caFingerprint`**
   (automated MitM check — never a manual 64-char hex compare), then **discards the
   bootstrap client** and pins the verified CA in the main client's `SecurityContext`.
   No per-OS root-cert install — the single biggest iOS blocker, removed.
2. **In-car is cross-platform from the start.** The in-car item is **Android Auto *and*
   CarPlay** over one `audio_service`-backed media-browser; Android ships first, CarPlay
   is the sibling, not a rewrite.
3. **Dual-platform plugins, isolated native code.** `just_audio`/`audio_service`
   (background audio, both OSes), a background-download plugin wrapping Android
   WorkManager **and** iOS background `URLSession`, `flutter_secure_storage`
   (Keystore/Keychain). Keep the sync/store/domain layer **pure Dart** (sqlite/drift or
   Isar) with zero platform assumptions.
4. **CI compiles the iOS target early.** Reuse the GitHub-hosted macOS runner in
   `.github/workflows/cross-os.yml` for an unsigned iOS build (`flutter build ios
   --no-codesign`) of the Flutter app from `app-1` on, so divergence is caught long
   before iOS is a shipping target.

### Secondary review (2026-06-06) — incorporated

An external technical review pressure-tested this design; the verified-and-adopted
changes are folded into the items below. Summary of what moved:

1. **Auto-verified pairing** (`app-2` + `srv-20`): the QR carries `{ url, token,
   caFingerprint }`; the app fetches the CA over a one-shot bad-cert-bypass client and
   asserts its hash == the scanned fingerprint, then pins — replacing error-prone manual
   hex comparison.
2. **Offline-correct resume ordering** (new **`srv-34`** + `app-6`): the verified bug —
   `book-state.ts:1171` stamps `updatedAt` at *receive* time, so a late-arriving offline
   push silently overwrites a newer position made elsewhere. Fix: the PUT accepts an
   optional client `listenedAt` (server sanity-bounds it: not future / not absurd) and
   uses it for ordering.
3. **Stateless deletion** (`srv-32` + `app-3`): drop the self-contradictory "server
   tombstones"; the manifest returns the full active-ID set and the client diffs to evict.
4. **Atomic chapter swap** (`app-3`/`app-5`): download to `.tmp`, verify, atomic rename;
   defer the swap if the player has the file open.
5. **Frequent local autosave** (`app-5`): persist position to local DB every ~5–10 s
   (cheap, local) so an OS background-kill never loses progress — decoupled from the
   debounced server push.
6. **Media-key safety** (`app-5`/`app-13`): default Bluetooth/notification skip buttons to
   **±30 s / ±15 s seek**, not next/prev *chapter* (an accidental steering-wheel press
   shouldn't skip a whole chapter); a setting flips to chapter-skip.
7. **Storage policies** (`app-4`/`app-13`): concrete eviction — auto-delete finished
   chapters (keep metadata + progress) and least-recently-listened book eviction at the cap.

---

## The item decomposition

IDs are permanent. Priority = position. MVP block first, follow-ups after.

### Server prerequisites

#### `srv-32` — Per-chapter sync-manifest endpoint (delta-friendly)

- **What:** `GET /api/library/sync-manifest` returning, per book + chapter, a
  **fingerprint** (`audioRenderedAt` + file size; content hash optional) plus
  `durationSec`/`lufs`/format, book metadata + `coverImageUrl`, and per-book
  `listen-progress.updatedAt`. Supports **`?since=<iso>`** for deltas. **Deletion stays
  server-stateless:** every response also carries the **full set of currently-active
  book/chapter IDs**, so the client evicts anything in its local store absent from that
  set — a filesystem-scan server can't emit tombstones for already-deleted folders (it
  has no memory of them), and this keeps the "no new on-disk state" property. Reuses
  `server/src/workspace/scan.ts` data.
- **Acceptance highlight:** the fingerprint MUST change on **every** audio-mutating path
  — full regen, per-character splice (`fs-26`), QA re-record (plan 179), loudness renorm
  — or the companion silently misses updates. Ships a test asserting each path bumps it.
  A `?since` response still includes the full active-ID set (IDs only — cheap).
- **Benefit (architectural/user):** the one change that makes delta sync possible; also
  feeds `fs-15`. **Depends on:** nothing.

*(No separate version-handshake item — the companion gates compatibility off the existing
`GET /api/info` `schemas` map, which `srv-32` bumps.)*

#### `srv-34` — Listen-progress PUT accepts a client `listenedAt` (offline-correct ordering)

- **What:** extend `PUT /api/books/:id/listen-progress` (`server/src/routes/book-state.ts`
  + `openapi.yaml` + the `ListenProgressFile` shape) to accept an **optional client
  `listenedAt`** timestamp. When present and sane, the server uses it as `updatedAt`
  instead of receive-time; it **sanity-bounds** it (reject future-dated beyond a small
  skew; clamp absurd values) so a misconfigured device clock can't poison ordering.
  Additive + backward-compatible (legacy callers that omit it keep server-stamp behaviour).
- **Why:** verified bug — today `book-state.ts:1171` stamps `updatedAt = now()` at
  *receive* time, so a phone that listened offline 1–2 pm and reconnects at 3 pm
  **overwrites** a newer 2:30 pm position made on the web client. The fix makes
  last-write-wins reflect *when the user actually listened*, not when the network
  delivered the write.
- **Benefit (user/technical):** correct cross-device resume; unblocks `app-6`'s two-way
  sync. **Depends on:** nothing (consumed by `app-6`).

### `app-*` — MVP block (first usable, installable Android deployment)

#### `app-1` — Flutter app scaffold in `apps/android/`

- **What:** project structure (incl. the iOS target), a pure-Dart domain/store layer
  (sqlite/drift or Isar) with a **migration discipline**, lint, a widget+unit test
  harness, a **debug/sideload APK** build, and a CI lane running `flutter analyze` +
  tests **and an unsigned iOS compile** (`flutter build ios --no-codesign` — avoids
  provisioning-profile/signing failures on the hosted runner without Apple certs) on the
  macOS cross-os runner. Registers the `app` scope + BACKLOG prefix (done in this doc's
  landing pass).
- **Benefit (technical):** the foundation + test + cross-platform-CI harness everything
  builds on. **Depends on:** nothing.

#### `app-2` — Pairing, app-managed TLS trust, and generated API client

- **What:** scan-QR / enter-URL onboarding. The QR carries `{ url, token, caFingerprint }`
  (`srv-20`). Pairing flow: (1) fetch `/cert/root.crt` over a **one-shot bad-cert-bypass**
  client; (2) assert the fetched CA's SHA-256 == the scanned `caFingerprint`; (3) **discard
  the bootstrap client** and build the main client with the CA **pinned in its
  `SecurityContext`**; (4) store the `srv-20` token in `flutter_secure_storage`. Plus a
  Dart client generated from `openapi.yaml`, reachability detection, and a coherent
  **error model** (unreachable / token-rejected / **fingerprint-mismatch** → refuse to
  pair).
- **Benefit (user):** one-time, *cryptographically auto-verified* pairing that "just
  works" on Android *and* iOS — no OS cert install, no manual hex compare.
  **Depends on:** `app-1`, **`srv-20`** (must surface token + CA fingerprint in the QR).

#### `app-3` — Delta sync engine

- **What:** fetch the `srv-32` manifest (`?since`), diff vs the local store, pull only
  changed/new chapters via `…/audio.mp3` with **resumable range downloads + retry/backoff
  + integrity check** (size/stamp). **Atomic swap:** write each download to `<chapter>.tmp`,
  verify, then atomic-rename over the live file — and **defer the swap if the player has
  that file open** (apply on next stop). **Deletion:** evict any local book/chapter absent
  from the manifest's active-ID set (no server tombstones). Re-pull a single regenerated
  chapter, never the whole book.
- **Benefit (user):** the killer feature — no full-book resync when one chapter is
  fixed/improved; an in-progress chapter never corrupts mid-listen. **Depends on:**
  `app-2`, `srv-32`.

#### `app-4` — Offline library store

- **What:** local per-chapter audio + metadata + cover persistence, storage accounting,
  delete/evict a book, **disk-full handling**, and **auto-eviction policies** driven by
  `app-13` settings — (a) **auto-delete finished chapters** (drop the `.mp3` once listened,
  keep metadata + progress pointer) and (b) **least-recently-listened book eviction** when
  the storage cap is hit (keep the N most-recently-played books). Evicted audio re-syncs
  on demand.
- **Benefit (user):** listen anywhere; the cache never silently fills the phone.
  **Depends on:** `app-3`.

#### `app-5` — Native audio player

- **What:** `just_audio` + `audio_service`: background playback, lock-screen/notification
  + **Bluetooth** controls (covers driving via car Bluetooth), speed, skip-silence,
  chapter nav, resume; **stale-while-listening** handling (a chapter superseded
  mid-listen swaps cleanly on next play, position preserved — see `app-3` atomic swap).
- **Acceptance highlights:**
  - player state is **per-book** — switching the active book preserves each book's
    chapter+position (backed by the local store + `listen-progress`), so the user can hop
    between several in-progress books freely;
  - **frequent local autosave** — persist position to the local DB every **~5–10 s** during
    playback (cheap, local) so an OS background-kill never loses progress; the server push
    stays debounced/on-reconnect (`app-6`);
  - **media-key safety** — default the Bluetooth/notification skip buttons (and
    steering-wheel/headset keys) to **seek ±30 s / ±15 s**, NOT next/prev *chapter*, so an
    accidental press doesn't skip a whole chapter (toggle to chapter-skip in `app-13`).
- **Benefit (user):** table-stakes listening UX that survives backgrounding and car
  controls. **Depends on:** `app-4`.

#### `app-6` — Two-way resume sync

- **What:** pull server `listen-progress` on sync; queue local position offline; push
  back on reconnect supplying the client **`listenedAt`** (the wall-clock time the user
  actually listened — see `srv-34`), so **last-write-wins reflects listen time, not
  network-delivery time**. Server sanity-bounds `listenedAt`; the app records it at each
  local autosave. *(Open nuance for the `app-6` plan: position isn't monotonic in time —
  consider "furthest position" vs "latest `listenedAt`" when they disagree; LWW-by-listen-
  time is the v1 default.)*
- **Benefit (user):** in-car progress flows back without clobbering a newer position made
  elsewhere while the phone was offline. **Depends on:** `app-2`, `app-5`, **`srv-34`**.

#### `app-7` — Hierarchical library browse + management

- **What:** navigate the library the way the server already structures it — **by author →
  by series → by book** (series ordered by `seriesPosition`, collapsible groups), with
  search/filter by title/author and pinned books surfaced. Maps directly to the
  `GET /api/library` / `srv-32` tree — **no new server work**. Each book shows its state
  pill (not-downloaded / downloading / downloaded / **update-available**) with
  download/remove, sync status + errors, and storage usage.
- **Benefit (user):** find any book fast in a large, multi-series library.
  **Depends on:** `app-3`, `app-5`.

#### `app-14` — Home shelf + multi-book switching

- **What:** the primary day-to-day surface — a **"Continue listening"** shelf of
  in-progress books (sorted by `listen-progress.updatedAt`) plus recently-added /
  recently-updated rails. Tap any book to **switch the now-playing book seamlessly**;
  each resumes at its own saved position (per-book player state from `app-5` + `app-6`).
- **Benefit (user):** the "listen to multiple books and switch as required" workflow as a
  first-class home screen. **Depends on:** `app-5`, `app-6`, `app-7`.

#### `app-8` — Auto-sync on reconnect

- **What:** detect home-network reachability; background auto-pull deltas + flush the
  resume queue (Wi-Fi-only / charging constraints via the cross-platform background-task
  plugin).
- **Benefit (user):** the "sync as you reconnect" ask — fixes + new chapters appear with
  no manual action. **Depends on:** `app-3`, `app-6`.

#### `app-13` — Playback & download settings (incl. sleep timer)

- **What:** sleep timer (table-stakes for bedtime listening), default speed,
  skip-silence, **skip-button behaviour toggle** (seek ±30/±15 s vs chapter-skip — drives
  `app-5`'s media keys), Wi-Fi-only downloads, **storage cap + the two auto-eviction
  policies** (auto-delete finished chapters; least-recently-listened book eviction — drive
  `app-4`), auto-download policy for in-progress books, and a "copy diagnostic logs"
  affordance (self-service observability).
- **Benefit (user):** the settings a real listening app is expected to have.
  **Depends on:** `app-5`, `app-4`.

### `app-*` — Follow-ups (post-MVP, ranked)

#### `srv-33` — Device pairing + multi-device token management (on top of `srv-20`)

- **What:** per-device tokens + revoke, layered on `srv-20`'s shared-secret primitive.
  *Reconcile, don't absorb:* MVP ships against `srv-20`'s single token; `srv-33` is the
  multi-device refinement.
- **Benefit (user/security):** revocable per-device access. **Depends on:** `srv-20`.

#### `app-9` — In-car support (Android Auto **and** CarPlay)

- **What:** a media-browser service so the library browses + plays on the car head unit,
  designed cross-platform over `audio_service`.
- **Benefit (user):** first-class in-car experience beyond the Bluetooth path in `app-5`.
  **Depends on:** `app-5`.

#### `app-10` — Stream-over-LAN instant play

- **What:** optionally stream `…/audio.mp3` (range) to start a not-yet-downloaded chapter
  on the home network. Deprioritized — the user emphasized offline.
- **Benefit (user):** zero-wait preview before committing a download. **Depends on:**
  `app-2`, `app-5`.

#### `app-11` — Distribution: signed release APK + alpha channel

- **What:** release signing + a versioned APK artifact in the release pipeline (sideload
  for alpha; Play Store later). *(MVP is installable via the `app-1` debug APK; this is
  the proper channel.)*
- **Benefit (user/technical):** testers can actually install it. **Depends on:** `app-1`.

#### `app-12` — iOS build + release

- **What:** the "Android **initially**" follow-through; because of the iOS-readiness
  principles (app-pinned TLS, dual-platform plugins, early iOS CI compile), this should
  be incremental. Filed as a parked **Won't (this round)** backlog row with a clear
  wake-trigger (Android MVP stable + listener demand).
- **Benefit (user):** one codebase, both platforms. **Depends on:** MVP stable.

### Relationships to existing items (reconcile, don't absorb)

- **`srv-20`** — promoted to a hard MVP dependency; annotated in BACKLOG.
- **`fs-15`** (cross-book resume) — `srv-32` manifest + the `app-14` "Continue listening"
  shelf overlap; cross-link both ways, keep distinct.
- **`fe-3` / `fs-7` / `fs-8`** (Apple Books / Plex / PocketBook handoffs) — the companion
  is the user's *own* replacement for the sideload pain, but does **not** obsolete them
  (they still serve users who prefer third-party apps).

---

## v1 scope (definition of done)

v1 = the `srv-32` + `srv-34` server prereqs (+ landing `srv-20`) and the 10-item MVP app
block (`app-1..8, 13, 14`). **v1 is "done" when this single end-to-end scenario passes on
a real Android device against the user's real GPU server:**

> Pair the phone to the server (scan QR — token + CA fingerprint **auto-verified**, no OS
> cert install) → browse the library by author/series/book → download 2 books → play
> offline with
> background + lock-screen + Bluetooth controls + sleep timer → switch between the 2
> books and each resumes at its own position → regenerate one chapter of book A on the
> server → return to the home LAN → the app auto-syncs **only that one chapter** and
> pushes the in-car listening position back to the server.

Out of v1 (follow-ups): Android Auto/CarPlay head-unit UI (`app-9`), LAN streaming
(`app-10`), multi-device tokens (`srv-33`), iOS release (`app-12`). v1 ships an
installable signed APK (`app-11`).

## Path to delivery (waves, ordering, agents)

**Why the spine is serial.** A brand-new Flutter codebase has a young shared spine (DI
container, route table, db/store schema, `main.dart`). Parallel agents on it collide on
those files, so foundations are built **one agent at a time, sequentially**. Genuine
parallelism opens in two windows — the foundation (server work is a different codebase
from the app) and the feature leaves (separable views/services). Parallel waves use
`isolation: "worktree"` agents reconciled via the repo's documented `integration/<date>`
pattern (CONTRIBUTING.md): branch off `main`, merge each agent branch one at a time,
`npm run verify` between merges, **one draft integration PR per wave, verified once**.

**Sizing** is relative effort (S/M/L), not time. Each item still gets its own branch +
plan per CLAUDE.md; the waves are the scheduling layer over them.

| Wave | Items (size) | Agents | Isolation | Gate (must pass before next wave) |
|---|---|---|---|---|
| **0 · Backlog landing** | this doc + BACKLOG rows + register `app` scope/prefix + INDEX; then file 16 issues + issue-map (S) | 1 | shared tree (docs only) | `feat(app):` passes commit-msg hook; rows render; doc linked; (after review) issues filed |
| **1 · Foundations** ∥ | **srv-20**→**srv-32**→**srv-34** (M) ‖ **app-1** scaffold (L) | **2** | 1 worktree each (server vs `apps/android/`) | server: `npm run test:server` green + new manifest / auth (token+fingerprint in QR) / listen-progress-`listenedAt` tests. app: `flutter analyze` + widget tests green, **debug APK builds**, **unsigned iOS compile** (`--no-codesign`) **on the macOS cross-os runner** |
| **2 · Network spine** | **app-2** pairing + TLS-pin + gen API client + secure token + error model (L) | 1 | serial | live pair against `npm run start:lan`; QR token + CA fingerprint **auto-verified** (mismatch refuses to pair); CA pinned in `SecurityContext` (no OS install); integration test hits `/api/info` + `/api/library` |
| **3 · Data spine** | **app-3** delta sync → **app-4** offline store (L, L) | 1 | serial (same track) | sync a real book; regenerate 1 chapter server-side → re-sync pulls **only** that file (atomic `.tmp`→rename); delete a book server-side → client evicts via active-ID diff; storage-cap eviction; resumable download + integrity check |
| **4 · Player** | **app-5** native player + media controls + per-book state (L) | 1 | serial | background + lock-screen + Bluetooth (skip = seek ±30/±15 s default); sleep-timer; **autosave survives an OS kill**; **switch book preserves each position** |
| **5 · Feature leaves** ∥ | **app-7** browse UI ‖ **app-6** resume-sync service ‖ **app-13** settings+sleep-timer (M, M, M) | **3** | 1 worktree each | per-item paired tests; integration PR green; manual verify on emulator. Reconcile order: app-6 → app-7 → app-13 |
| **6 · Integration capstone** | **app-8** auto-sync-on-reconnect → **app-14** home shelf + multi-book switching (M, M) | 1 | serial | the **full v1 end-to-end scenario** above, on a device |
| **7 · Ship** | **app-11** signed release APK + alpha channel (S) | 1 | serial | signed APK installs on the user's phone; real-library acceptance against the GPU server |

**Peak parallelism is 3 agents (Wave 5); most waves are 1.** Total ≈ 7 build sessions,
several of which (waves 2–4) are one continuing agent down the spine.

**One-time prerequisites (gate before the Wave 1 app track):** install the Flutter SDK +
Android SDK/emulator on the dev box; a physical Android phone for real-device acceptance
(waves 6–7); a `git`-trackable `apps/android/` with its own `.gitignore`. The iOS compile
uses the **GitHub-hosted macOS runner** (`cross-os.yml`) — **no local Mac required** for
v1.

**PR strategy:** serial spine items (`app-1/2/3/4/5`, the server prereqs) each open as a
**draft** PR, `gh pr ready` only when locally `verify`-green (one billed CI run each);
the two parallel waves (1 and 5) land as **one integration PR per wave**.

**Top delivery risks + mitigations:**

- *Fingerprint misses a re-record path* → companion silently stale. **Mitigation:**
  `srv-32` ships a test asserting full-regen / splice (`fs-26`) / QA-rerecord (plan 179)
  / loudness-renorm all bump the stamp (Wave 1 gate).
- *Self-signed cert rejected on device* → no pairing. **Mitigation:** app-pinned CA in
  the Dart `SecurityContext` (Wave 2 gate is a live pair, not a unit test).
- *Young-codebase merge churn in Wave 5* → reconcile cost. **Mitigation:** the three
  leaves are scoped to disjoint dirs (browse view / sync service / settings view);
  integration-branch merge order fixed (app-6 → app-7 → app-13).
- *Flutter toolchain not set up* → Wave 1 app track blocked. **Mitigation:** the
  one-time-prereq gate above, surfaced before Wave 1 starts.

---

## Architectural impact

- **New seams / extension points:**
  - **`app` surface** — `apps/android/`, BACKLOG prefix `app`, commit scope `app`,
    a Flutter CI lane (incl. iOS compile on the existing macOS runner).
  - **`srv-32` sync-manifest** — a delta/`?since`-aware contract over the existing
    workspace scan; the stable API any sync client (Android now, iOS later) consumes.
  - **`srv-20` token middleware** — promoted from "optional hardening" to a load-bearing
    auth primitive the companion depends on; its LAN/pairing payload also gains the CA
    `caFingerprint` so pairing auto-verifies.
  - **`srv-34` listen-progress `listenedAt`** — an additive field on the listen-progress
    PUT so conflict ordering reflects listen time, not network-receive time.
- **Invariants preserved:** the server stays **local-first / single-user**; LAN exposure
  stays **opt-in** (`npm run start:lan`); the companion adds **no internet-facing
  surface** in v1 (home-LAN sync + offline playback only). The per-chapter audio + range
  contract (plan 28) is consumed as-is; the listen-progress contract (plan 47) is
  **extended additively** (optional `listenedAt`), never broken.
- **Migration story:** no server data-shape migration for v1 — `srv-32` reshapes existing
  `scan.ts`/`state.json` data and bumps the `GET /api/info` `schemas` map for compat
  gating. Two small **additive, backward-compatible** contract extensions: the
  listen-progress PUT gains optional `listenedAt` (`srv-34`; legacy callers keep
  server-stamp behaviour) and the LAN/pairing payload gains `token` + `caFingerprint`
  (`srv-20`). App-side local DB owns its own migration discipline (`app-1`).
- **Reversibility:** the app is an additive, separate surface — deleting `apps/android/`
  and the `srv-32` route fully reverts. `srv-20` is independently useful (security
  hardening) regardless of the app.

## Invariants to preserve

1. **Per-chapter, not whole-book.** The companion syncs `…/audio.mp3` per chapter; it
   must never depend on the M4B export pipeline for routine sync (defeats delta).
2. **Fingerprint changes on every audio mutation.** `srv-32`'s per-chapter fingerprint
   must move on full regen, per-character splice (`fs-26`), QA re-record (plan 179), and
   loudness renorm — enforced by a `srv-32` test.
3. **App-managed, auto-verified TLS trust.** Device→server trust is established by
   fetching `/cert/root.crt`, asserting its SHA-256 == the QR-scanned `caFingerprint`, and
   pinning it in the app's `SecurityContext` — never an OS cert install, never a manual
   hex compare (keeps iOS parity + closes the MitM gap).
4. **Last-write-wins by client listen-time.** Two-way resume conflict resolution orders by
   the client `listenedAt` (server sanity-bounded, `srv-34`), NOT by network-receive time
   — so an offline listen pushed late can't overwrite a newer position made elsewhere.
5. **Never-cross-language / never-wrong-voice** server invariants (plan 162, plan 108)
   are unaffected — the app only *plays* server-rendered audio, it does not synthesize.

## Test plan

This is an epic; concrete paired tests land per item under each item's own plan. The
load-bearing test obligations:

- **`srv-32`** — Vitest server test asserting the manifest shape + `?since` delta + the
  full active-ID set in every response, and (critically) that every audio-mutating path
  bumps the fingerprint.
- **`srv-34`** — Vitest server test: PUT with a valid client `listenedAt` is stored as
  `updatedAt`; a future-dated/absurd `listenedAt` is rejected/clamped; omitting it keeps
  legacy server-stamp behaviour.
- **`app-1`** — the Flutter widget/unit test harness itself + the CI lane
  (`flutter analyze`, tests, debug APK build, unsigned iOS compile `--no-codesign`) is
  part of the work.
- **`app-2..14`** — each ships Dart unit/widget tests; the sync engine (`app-3`) and
  resume sync (`app-6`) get unit tests against a stubbed server; the v1 end-to-end
  scenario (see "v1 scope") is the manual acceptance gate on a real device.

### Manual acceptance walkthrough

The single v1 end-to-end scenario under **v1 scope (definition of done)** is the
acceptance walkthrough. It is run on a real Android device against the user's GPU server
once Wave 6 completes.

## Out of scope

- **Internet exposure / remote (non-LAN) sync** — v1 is home-LAN sync + offline play.
- **iOS release** (`app-12`) — parked Won't-this-round; the codebase stays iOS-ready.
- **Android Auto / CarPlay head-unit UI** (`app-9`) — v1 covers driving via car
  Bluetooth + lock-screen only.
- **Multi-device token management** (`srv-33`) — v1 rides `srv-20`'s single token.
- **Synthesis / generation on-device** — the app is a listening + sync client only; all
  TTS stays server-side.

## Ship notes

(Filled per item as each ships; the epic flips to `stable` only when the v1
definition-of-done passes on a real device.)
