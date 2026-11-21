---
status: active
shipped: null
owner: null
---

# Node loopback-connect crash guard (Windows)

> Status: KNOWN: operational dependency
> Key files: `package.json`, `.nvmrc`, `pinokio-scripts/install.js`, `pinokio-scripts/update.js`, `server/src/index.ts`
> URL surface: none (server start-up only)
> OpenAPI ops: none

Parent: #4443. This plan is written by step 1 (#4491) and read by the later steps: #4492, #4493, #4495 and the final `[verify]` child #4494.

## Benefit / Rationale

- **User:** on Windows the server stops dying with exit 3221226505 (0xC0000409) on the first connection to 127.0.0.1. A known-bad Node now gets a clear refusal that says which Node to install.
- **Technical:** one list of bad release ranges, written once here and copied by every surface that needs it.
- **Architectural:** the guard is the single place that knows which releases are bad. `engines` and the Pinokio pin follow the same floor.

## Problem

In libuv's `deps/uv/src/win/tcp.c`, `uv__is_fast_loopback_fail_supported()` calls `RtlGetVersion(&os_info)` on a stack `OSVERSIONINFOW` whose `dwOSVersionInfoSize` is never set. It runs on every TCP connect to 127.0.0.1. When the garbage value matches, Windows writes past the struct and the process fail-fasts with 0xC0000409.

- Bug: libuv#5106. Fix: libuv#5107 (merged 2026-04-02, `aabb765`; it touches only `src/win/tcp.c`).
- Node cherry-pick: nodejs/node#62561, first shipped in v24.16.0. User report: nodejs/node#63620.
- Only `tcp.c` has the bug. The only other `RtlGetVersion` caller, `util.c:1580-1583` in `uv_os_uname`, sets `dwOSVersionInfoSize` first (read at v24.15.0).

**Owner decision (2026-11-20), binding.** Drop Node 22 on Windows. No fixed 22.x exists, so on Windows the guard refuses every 22.x and requires >=24.16.0. **Amended 2026-11-20 (owner):** Node 22 support is dropped everywhere, not only on Windows. `engines.node` is exactly `>=24.16.0` (a plain floor, no union, no upper bound), which admits the still-affected Node 25.0 to 25.9 and 26.0.0; the Windows guard still refuses those. Pinokio's pin is `nodejs>=24.16.0,<25`. The PR refs #4442 but does not close it: #4442's recorded crash ran on Node v24.22.3, a release this plan marks as fixed, so it has a different or additional cause.

## Affected-release table

Read from raw source at each tag. Base URL: `https://raw.githubusercontent.com/nodejs/node/<tag>/deps/uv/src/win/tcp.c`.

| Line | First affected | Last affected | First fixed | libuv | Evidence (raw source) |
|---|---|---|---|---|---|
| 20.x, 21.x | v20.19.5 and v21.7.3 (the tags read) | v20.19.5, v21.7.3 (the last 21.x) | none | not recorded | [v20.19.5](https://raw.githubusercontent.com/nodejs/node/v20.19.5/deps/uv/src/win/tcp.c), [v21.7.3](https://raw.githubusercontent.com/nodejs/node/v21.7.3/deps/uv/src/win/tcp.c): lines 741-745 |
| 22.x (from 22.22.0) | v22.22.0 (the current `engines` floor; earlier 22.x were not read) | v22.23.5 (newest 22.x, every tag read) | none | 1.51.0 | [v22.22.0](https://raw.githubusercontent.com/nodejs/node/v22.22.0/deps/uv/src/win/tcp.c), [v22.23.5](https://raw.githubusercontent.com/nodejs/node/v22.23.5/deps/uv/src/win/tcp.c): lines 753-757 |
| 23.x | v23.0.0 | v23.11.1 (the last 23.x) | none | 1.48.0 (23.0.0), 1.49.2 (23.6.0), 1.50.0 (23.11.1) | [v23.0.0](https://raw.githubusercontent.com/nodejs/node/v23.0.0/deps/uv/src/win/tcp.c) (741-745), [v23.6.0](https://raw.githubusercontent.com/nodejs/node/v23.6.0/deps/uv/src/win/tcp.c) (753-757), [v23.11.1](https://raw.githubusercontent.com/nodejs/node/v23.11.1/deps/uv/src/win/tcp.c) (753-757): `pRtlGetVersion(&os_info)` with no `dwOSVersionInfoSize` |
| 24.x | v24.0.0 | v24.15.0 | v24.16.0 | 1.50.0 (24.0.0-24.1.0), 1.51.0 (to 24.15.0), 1.52.1 (24.16.0+) | [v24.0.0](https://raw.githubusercontent.com/nodejs/node/v24.0.0/deps/uv/src/win/tcp.c), [v24.15.0](https://raw.githubusercontent.com/nodejs/node/v24.15.0/deps/uv/src/win/tcp.c), [v24.16.0](https://raw.githubusercontent.com/nodejs/node/v24.16.0/deps/uv/src/win/tcp.c), [v24.22.3](https://raw.githubusercontent.com/nodejs/node/v24.22.3/deps/uv/src/win/tcp.c) |
| 25.x | v25.0.0 | v25.9.0 (the last 25.x) | none | 1.51.0 | [v25.0.0](https://raw.githubusercontent.com/nodejs/node/v25.0.0/deps/uv/src/win/tcp.c), [v25.9.0](https://raw.githubusercontent.com/nodejs/node/v25.9.0/deps/uv/src/win/tcp.c) |
| 26.x | v26.0.0 | v26.0.0 | v26.1.0 | 1.52.1 (both) | [v26.0.0](https://raw.githubusercontent.com/nodejs/node/v26.0.0/deps/uv/src/win/tcp.c), [v26.1.0](https://raw.githubusercontent.com/nodejs/node/v26.1.0/deps/uv/src/win/tcp.c), [v26.13.1](https://raw.githubusercontent.com/nodejs/node/v26.13.1/deps/uv/src/win/tcp.c) |

Notes:
- The libuv version alone does not decide it. v26.0.0 bundles 1.52.1 and is still affected. v25.9.0 is vulnerable too: nodejs/node#63620 saw it run clean only because the garbage value happened to be benign.
- v24.16.0 through v24.22.3 and v26.1.0 through v26.13.1 (the newest tags read) are fixed.

Boundary excerpts.

Affected (v22.23.5, v24.15.0, v25.9.0, v26.0.0; `tcp.c:753-757`). `dwOSVersionInfoSize` is never set:

```c
static int uv__is_fast_loopback_fail_supported(void) {
  OSVERSIONINFOW os_info;
  if (!pRtlGetVersion)
    return 0;
  pRtlGetVersion(&os_info);
```

Fixed (v24.16.0, `tcp.c:55-61`; v26.1.0 has the same body under the name `minimal_windows10_version1709`):

```c
static int uv__windows10_version1709(void) {
  OSVERSIONINFOW os_info;
  if (!pRtlGetVersion)
    return 0;
  os_info.dwOSVersionInfoSize = sizeof(os_info);
  os_info.szCSDVersion[0] = L'\0';
  pRtlGetVersion(&os_info);
```

## The guard's ranges

On Windows only, the server refuses to start when its Node version is in any of these ranges. Later children copy this list into `package.json`.

```json
[
  {"from": "0.0.0", "toExclusive": "24.16.0"},
  {"from": "25.0.0", "toExclusive": "26.1.0"}
]
```

The first entry reads "every release below 24.16.0": the table shows no fixed 20.x, 21.x, 22.x, 23.x or 24.0 to 24.15, so one low range covers them all (an earlier draft listed only 22.x and 24.x and let 20.x, 21.x and 23.x through). The second entry covers every 25.x and 26.0.x. The first good Windows Node is 24.16.0, then 26.1.0 and up. The matching `engines` floor is `>=24.16.0`.

## conda-forge findings

Source: `https://api.anaconda.org/package/conda-forge/nodejs`, files with `attrs.subdir == "win-64"` and version starting `24.`.

- win-64 24.x builds published: 24.3.0, 24.4.0, 24.4.1, 24.8.0, 24.9.0, 24.10.0, 24.11.1, 24.12.0, 24.13.0, 24.13.1, 24.14.0, 24.14.1, 24.16.0, 24.18.0, 24.19.0, 24.21.0, 24.22.1, 24.22.3.
- Newest: **24.22.3**, at or above the first fixed 24.16.0. A fixed build exists, so the STOP condition does not apply.
- Affected builds that a bare `nodejs=24` could resolve to when the solver cannot reach the newest: 24.3.0, 24.4.0, 24.4.1, 24.8.0, 24.9.0, 24.10.0, 24.11.1, 24.12.0, 24.13.0, 24.13.1, 24.14.0 and 24.14.1. That is every 24.x build below 24.16.0.
- So the Pinokio pin must be `nodejs>=24.16.0,<25` (or an equivalent that excludes every build below 24.16.0), not `nodejs=24`.

## Invariants to preserve

1. The guard's list in `package.json` equals the list above, byte for byte in meaning.
2. The guard runs on Windows only. Linux and macOS start as before.
3. A refusal names the running Node version and one minimum Node that works: the `engines` floor (24.16.0), read from `package.json`, never the matched range's upper bound (that bound can itself be a refused version, e.g. 23.0.0 or 26.1.0 is not the answer for 22.x or 25.x).

4. The in-app "Upgrade & restart" path (owner decision, #4443): `scripts/restart-after-upgrade.mjs` ships in the new release and runs the same guard against it before launching. A Node the new release would refuse (or a failing check) puts `.current-version` back on the previous release, relaunches it, and writes `{ phase: 'error', error }` to `<install>/.upgrade-staging/state.json`, which the app already serves at `/api/upgrade/state`. If no other release exists it still launches the new one.

## Test plan

### Automated coverage

Owned by the later steps: #4492 (a version-range unit test with a mutation) and #4493 (Pinokio script checks). This step is docs-only and adds no tests.

### Manual acceptance walkthrough

1. On a Windows box running Node 24.15.0, `npm start` in `server/` refuses with the version message (after #4492).
2. On Node 24.16.0 or newer it starts.
3. The Pinokio "run Update again" message, two-Update convergence, the in-app upgrade being held back (the previous release relaunched, the reason shown on the upgrade card) and `logs/node-refused.log` can only be proven on a real Windows box: on-box register row E117 owns them. Not run at PR time.

## Pending steps

- [x] #4492 - the start-up guard, reading the range list above.
- [x] #4493 - Pinokio and `engines`: `nodejs>=24.16.0,<25` in `pinokio-scripts/install.js:43` and `pinokio-scripts/update.js:42`, and the `engines` floor.
- [x] #4495 - docs and release notes (`INSTALL.md`, the wiki mirror, `.nvmrc`).
- [ ] #4494 - the final `[verify]` child, which opens the PR.

Out of scope: the thread-pool teardown crash (the "Separate finding" in the #4443 comment).
