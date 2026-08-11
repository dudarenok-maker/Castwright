# One-click `castwright.local` re-bind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make re-binding this computer's browser to `https://castwright.local` a one-click action, give the 401 dead-end a way out, and raise the device-token lifetime so neither is needed often.

**Architecture:** Four independent slices. The server slice is a config-default change with a new upper bound. The three frontend slices add a self-bind button on the loopback origin, auto-redeem on the hop it navigates to, and an `ApiError` status seam so the library's 401 panel can render a recovery link instead of raw JSON. No new endpoints; the pairing mechanism already exists and is reused unchanged.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-11-castwright-local-rebind-design.md` (revision 4)
**Issue:** #2247 (srv-90)
**Plan revision:** 2 — one `assumption-checker` round folded (6 `Critical`+`Contradicted`). See "Review history" at the foot.

## Global Constraints

- Branch `feat/frontend-lan-rebind`, worktree `C:\Claude\Projects\wt-lan-rebind`. Never commit to `main`.
- New TTL default: **365**. New ceiling: **400** (Chrome's cookie `Max-Age` cap since M104). Both values exact.
- The self-bind label is exactly `'This computer'`.
- The self-bind query flag is exactly `self=1`.
- **Never** treat `self=1` as a trust signal — the gate is the one-time code.
- **Never** string-match `/\(401\)/` on an error message; branch on a status field.
- Every task ends green on `npm test` (frontend) or `npm run test:server`, and commits.
- Commit subjects follow `<type>(<scope>): <subject>` — scopes here are `server`, `frontend`, `docs`.

## Read this before writing any test

A review round found that **every** frontend test helper the first draft of this
plan invented does not exist, and one code block would have destroyed an
existing regression suite. The real scaffolding, verified on disk:

| File | Helper that EXISTS | Notes |
|---|---|---|
| `src/views/pair.test.tsx` | `renderPair(search = '/pair?c=ABC')` | Feeds **MemoryRouter `initialEntries`** — a router path, **no `#` prefix**. Its `vi.mock` factory exports `api.redeemBrowserPair` **and** a hand-rolled `ApiError` class. Uses `fireEvent`. |
| `src/views/book-library.test.tsx` | `renderView({ loaded, authors })` | Hardcodes `error: null`, so it **cannot** inject an error. The pattern to copy is the inline `configureStore` at `:823-845`. Its `vi.mock` factory exports only `getWorkspaceInfo`, `getContinueListening`, `setShelfStatus` — **no `getLibrary`, no `ApiError`**. |
| `src/components/lan-access-card.test.tsx` | — | Uses `vi.mock(..., importOriginal)` and spreads the real module, so `ApiError` **is** importable (already imported at `:4`). Uses `fireEvent`, not `userEvent`. `beforeEach` is `vi.clearAllMocks()`, which clears calls but **not** implementations. |
| `server/src/workspace/device-tokens.pure.test.ts` | — | **EXISTS: 160 lines, 15 tests** covering `hashToken`, `findValidDevice` (incl. the #2144 malformed-`expiresAt` arms) and `redactDevice`. **APPEND** a `describe` block. Authoring this file from a snippet erases the #2144/#2149 coverage silently — the remaining tests still pass, so nothing goes red. |

There are **no** helpers named `renderAt` or `renderWithState`. Do not call them.

---

### Task 1: Raise the TTL default and add a ceiling

**Files:**
- Modify: `server/src/config/registry.ts:1254-1263`
- Modify: `server/src/workspace/device-tokens.ts:84-87`
- Test: `server/src/config/registry.test.ts:78-88` (edit the existing block)
- Test: `server/src/workspace/device-tokens.pure.test.ts` (**APPEND** — the file exists; `clampTtlDays` is the one export in it with no coverage)

**Interfaces:**
- Consumes: nothing.
- Produces: `clampTtlDays(raw: unknown): number` — unchanged signature, now clamping **both** bounds to the nearest bound; registry knob `lan.deviceTokenTtlDays` with `default: 365, min: 1, max: 400`.

**Behaviour decision (locked by the user, 2026-08-11).** `clampTtlDays` clamps
**symmetrically**: a value below the floor becomes `1`, not the default. The old
shape mapped everything `< 1` to the default, so an operator hand-editing `0` to
*shorten* the lifetime silently got the *longest* one — a curiosity at 30 days,
a 12× footgun at 365. Only a non-integer falls back to `365`.

- [ ] **Step 1: Write the failing tests**

**Append** to `server/src/workspace/device-tokens.pure.test.ts` (the file already
has its imports; add `clampTtlDays` to the existing import from `./device-tokens.js`):

```ts
describe('clampTtlDays', () => {
  it('falls back to the 365-day default for a non-number or non-integer', () => {
    expect(clampTtlDays('nonsense')).toBe(365);
    expect(clampTtlDays(undefined)).toBe(365);
    expect(clampTtlDays(null)).toBe(365);
    expect(clampTtlDays(1.5)).toBe(365);
    expect(clampTtlDays(Number.NaN)).toBe(365);
  });

  // Clamps to the NEAREST bound, both directions. An operator hand-editing a
  // stored override to 0 is trying to shorten the lifetime; returning the
  // default would hand them the longest one instead.
  it('clamps below the floor up to 1, not to the default', () => {
    expect(clampTtlDays(0)).toBe(1);
    expect(clampTtlDays(-1)).toBe(1);
    expect(clampTtlDays(-100_000)).toBe(1);
  });

  it('clamps above the ceiling down to 400', () => {
    expect(clampTtlDays(401)).toBe(400);
    expect(clampTtlDays(100_000)).toBe(400);
  });

  it('passes an in-range value through untouched', () => {
    expect(clampTtlDays(1)).toBe(1);
    expect(clampTtlDays(30)).toBe(30);
    expect(clampTtlDays(365)).toBe(365);
    expect(clampTtlDays(400)).toBe(400);
  });

  // Links the two literal 365s that now live in different files. Paired with
  // registry.test.ts's literal assertion below, this is not a tautology: one
  // side is pinned to a literal there, so a future default change that misses
  // this fallback fails here.
  it('its fallback equals the registry default', async () => {
    const { KNOBS } = await import('../config/registry.js');
    const knob = KNOBS.find((k) => k.key === 'lan.deviceTokenTtlDays');
    expect(clampTtlDays('not-a-number')).toBe(knob?.default);
  });
});
```

In `server/src/config/registry.test.ts`, edit the existing block at `:78-88`
(rename the title — it currently says "30-day default"). Note the existing
`toMatchObject` field order is `env, group, type, default, min, apply`:

```ts
  it('registers the device-token TTL knob with a 365-day default and a 400-day ceiling', () => {
    const k = KNOBS.find((x) => x.key === 'lan.deviceTokenTtlDays');
    expect(k).toMatchObject({
      env: 'LAN_DEVICE_TTL_DAYS',
      group: 'lan-access',
      type: 'integer',
      default: 365,
      min: 1,
      max: 400,
      apply: 'live',
    });
  });

  // The spec's Testing §Server item 2 requires the ceiling to REJECT, not just
  // to be present. `coerceAndValidate` is already imported at :3.
  it('rejects a TTL above the 400-day ceiling', () => {
    const k = KNOBS.find((x) => x.key === 'lan.deviceTokenTtlDays')!;
    expect(coerceAndValidate(k, '401').ok).toBe(false);
    expect(coerceAndValidate(k, '400').ok).toBe(true);
    expect(coerceAndValidate(k, '0').ok).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts src/config/registry.test.ts`

Expected: FAIL. Specifically — `clampTtlDays(0)` returns `30`, `clampTtlDays(401)`
returns `401`, the knob has `default: 30` and no `max`, and `coerceAndValidate(k, '401')`
returns `ok: true` because no ceiling exists yet. The 15 pre-existing tests in
`device-tokens.pure.test.ts` must stay **green** throughout — if any of them
turns red, the file was overwritten instead of appended to. Stop and restore.

- [ ] **Step 3: Implement**

`server/src/workspace/device-tokens.ts:84-87`. Current text, for reference:

```ts
/** Clamp a configured TTL to a sane positive integer; fall back to the 30-day default. */
export function clampTtlDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 30;
}
```

Replace with:

```ts
/** Clamp a configured TTL to an integer in [1, 400]; fall back to the 365-day
 *  default only when the value is not an integer at all. Out-of-range integers
 *  clamp to the NEAREST bound — an operator who hand-edits a stored override to
 *  `0` is shortening the lifetime, and returning the default would hand them
 *  the longest one instead.
 *
 *  The 400 ceiling mirrors Chrome's cookie Max-Age cap (M104): above it the
 *  server record would outlive the cookie, which is the divergence this bound
 *  exists to prevent. `max` in the registry already rejects out-of-range env
 *  and Settings writes (config/resolver.ts:168); this clamp guards the one
 *  unvalidated path — a stored override, returned raw by resolveKnobInner
 *  (config/resolver.ts:32-55). */
export function clampTtlDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 365;
  return Math.min(Math.max(raw, 1), 400);
}
```

`server/src/config/registry.ts` — in the `lan.deviceTokenTtlDays` descriptor,
set `default: 365`, add `max: 400`, and reword `help` so the "new mints only"
fact reaches the user. Current text is
`help: 'How long a browser/device authorization stays valid before it must be re-paired.'`,
`type: 'integer', min: 1,`, `default: 30,`, `apply: 'live', risk: 'low',`:

```ts
    help: 'How long a NEWLY authorized browser or device stays valid. Changing this does not extend authorizations that already exist — re-authorize a device to give it the new lifetime.',
    type: 'integer', min: 1, max: 400,
    default: 365,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts src/config/registry.test.ts`
Expected: PASS, with the 15 pre-existing pure tests still green.

- [ ] **Step 5: Regenerate the env example**

Run: `npm run config:sync`
Then: `npm run config:check` — must exit 0. This rewrites the managed block in
`server/.env.example` (the `# LAN_DEVICE_TTL_DAYS=30` line at `:683`).

- [ ] **Step 6: Commit**

```bash
git add server/src/config/registry.ts server/src/workspace/device-tokens.ts \
        server/src/workspace/device-tokens.pure.test.ts \
        server/src/config/registry.test.ts server/.env.example
git commit -m "feat(server): raise the device-token lifetime to 365 days with a 400-day ceiling"
```

---

### Task 2: Stop the mock registry drifting from the server

**Files:**
- Modify: `src/lib/api.ts:9437-9446` (the `lan.deviceTokenTtlDays` mock descriptor), `:7362-7363` (`mockRedeemBrowserPair`), `:8986` (`tts.preload.kokoro` default), the `analyzer.gemini.model` mock default
- Test: `src/lib/api.config.test.ts:305-361` (extend)

**Interfaces:**
- Consumes: Task 1's registry values.
- Produces: a parity guard comparing `{key, default, min, max}` for every knob **present in both** catalogues.

**Scope decision (locked by the user, 2026-08-11).** The first draft prescribed
full-catalogue parity. That is unshippable here and the plan mis-scoped it:

- `MOCK_CONFIG_DESCRIPTORS` is `const` at `src/lib/api.ts:8306` and is **not
  exported**. Reach descriptors through `await mockGetConfig()`, already imported
  at `src/lib/api.config.test.ts:7`.
- The mock is a **deliberate subset** — `src/lib/api.config.test.ts:311-313`
  says so in a comment. Registry has **115** knobs, the mock **98**. A full
  `toEqual` fails on 19 registry knobs absent from the mock and 2 mock-only
  entries (`KOKORO_SAMPLE_RATE` at `:8308`, `ANALYZER_STAGE1_PROMPT` at `:8322`)
  that are not registry keys at all.

So the guard compares the **intersection**. Two genuine drifts on shared keys
surface and **are fixed in this PR** as incidental findings (declare them in the
PR body — an unannounced fix reads as scope creep):

| Key | Registry | Mock | Why |
|---|---|---|---|
| `tts.preload.kokoro` | `false` (`registry.ts:762`) | `true` (`api.ts:8986`) | Registry flipped at fs-60; the mock never followed. **This changes mock-mode behaviour** — a demo run stops preloading Kokoro. That is the correct behaviour; the mirror exists so mock-mode screenshots stay honest. |
| `analyzer.gemini.model` | `'gemini-3.5-flash-lite'` | `'gemma-4-31b-it'` | The mock's value was retired by #2179. |

The 19 missing descriptors are a real gap but a design question of their own
(does the mock want full parity?) — **file it, do not fix it here** (Task 7 Step 6).

- [ ] **Step 1: Write the failing test**

`src/lib/api.config.test.ts` already imports `mockGetConfig` at `:7` and has a
static, extensionless registry import at `:16`
(`import { knobsInGroup, GROUPS } from '../../server/src/config/registry';`) —
add `KNOBS` to that existing import rather than adding a dynamic one.

```ts
it('mock descriptors match the server registry on default/min/max for every shared knob', async () => {
  const { descriptors } = await mockGetConfig();
  const real = new Map(KNOBS.map((k) => [k.key, k]));
  const project = (d: { key: string; default?: unknown; min?: number; max?: number }) => ({
    key: d.key, default: d.default, min: d.min, max: d.max,
  });

  // Intersection only: the mock is a documented subset (see :311-313), and it
  // carries two UI-only entries that are not registry keys.
  const shared = descriptors.filter((d) => real.has(d.key));
  expect(shared.length).toBeGreaterThan(90); // guards against the filter silently emptying

  expect(shared.map(project)).toEqual(shared.map((d) => project(real.get(d.key)!)));
});
```

Note `expect(shared.length).toBeGreaterThan(90)`: without it, a future rename
that empties the intersection turns this guard into a vacuous `[] === []`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/api.config.test.ts`
Expected: FAIL on **exactly three** keys — `lan.deviceTokenTtlDays`
(30 vs 365, and `max` undefined vs 400), `tts.preload.kokoro`, and
`analyzer.gemini.model`. If it names any *other* key, that is further
pre-existing drift this guard just exposed: fix the mock to match the server,
add it to the PR-body list, and do **not** weaken the assertion to hide it.

- [ ] **Step 3: Implement**

In `src/lib/api.ts`, the `lan.deviceTokenTtlDays` mock descriptor (`:9437-9446`):

```ts
    key: 'lan.deviceTokenTtlDays',
    group: 'lan-access',
    label: 'Device authorization lifetime (days)',
    help: 'How long a NEWLY authorized browser or device stays valid. Changing this does not extend authorizations that already exist — re-authorize a device to give it the new lifetime.',
    type: 'integer', min: 1, max: 400,
    default: 365,
```

`mockRedeemBrowserPair` (`:7362-7363`), so mock mode stops reporting a 30-day expiry:

```ts
const mockRedeemBrowserPair = async (_b: { code: string }) =>
  ({ label: 'This browser', expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() });
```

`tts.preload.kokoro` (`:8986`): `default: true` → `default: false`, and bring its
`help` text into line with `registry.ts:762`.

`analyzer.gemini.model`: `default: 'gemma-4-31b-it'` → `default: 'gemini-3.5-flash-lite'`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/api.config.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite**

Run: `npm test`
Expected: PASS. The `tts.preload.kokoro` flip changes a mock-mode default; if a
settings or GPU test asserted `true`, update it — that is the point of the fix,
not collateral damage.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api.config.test.ts
git commit -m "fix(frontend): pin mock config defaults to the server registry"
```

Commit body must list the two incidental drift fixes and why.

---

### Task 3: Assert the cookie's `Max-Age`, not just the record

**Files:**
- Modify: `server/src/routes/pairing.test.ts:59` (the `configValue` mock), `:85` (the local `clampTtlDays`), `:227-239` (the `Set-Cookie` assertions)

**Interfaces:**
- Consumes: Task 1.
- Produces: nothing consumed downstream.

**Why this task exists:** revision 1 of the design failed because the server
record and the browser cookie can disagree, and *no test asserts `Max-Age` today*.

**Be precise about what this can and cannot prove.** `pairing.test.ts:65-87`
mocks the **entire** `../workspace/device-tokens.js` module, `clampTtlDays`
included, and `:59` mocks `configValue`. So this test proves only that
`maxAge: ttlDays * 86_400_000` at `server/src/routes/pairing.ts:171` tracks
`ttl()`. It **cannot** regress on the registry default — reverting Task 1's
`default: 365` leaves this test green. Task 1's literal-`365` assertion is what
proves the default. Both are needed; neither is sufficient.

- [ ] **Step 1: Write the failing assertion FIRST, against the unmodified mocks**

Do **not** touch `:59` or `:85` yet — that ordering is what makes this a real
red phase rather than a booked one. Extend the existing `Set-Cookie` test at
`:227-239`, keeping its established `String(... ?? '')` + `toMatch` style and its
`=tok_test` binding:

```ts
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/__Host-cw_lan=tok_test/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Max-Age=31536000/); // 365 days — must track ttl()
```

- [ ] **Step 2: Run it and OBSERVE the red**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: **FAIL** with `Max-Age=2592000` (30 days) in the received value.
Record that number — it is the evidence this assertion can fail.

- [ ] **Step 3: Update the file-level mocks to the new values**

`pairing.test.ts:59`, currently `configValue: (_key: string) => 30`:

```ts
vi.mock('../config/resolver.js', () => ({ configValue: (_key: string) => 365 }));
```

`:85`'s local reimplementation, currently falling back to `30`, must match
Task 1's real clamp — including the symmetric floor:

```ts
    clampTtlDays: (v: unknown) =>
      typeof v === 'number' && Number.isInteger(v) ? Math.min(Math.max(v, 1), 400) : 365,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pairing.test.ts
git commit -m "test(server): assert the LAN cookie Max-Age tracks the configured TTL"
```

---

### Task 4: The "Authorize this browser" button

**Files:**
- Modify: `src/components/lan-access-card.tsx`
- Test: `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `api.createDevicePairSession({ label })` → `{ url, code, expiresAt, friendlyUrl?: string }`.
- Produces: nothing consumed downstream.

**Placement is load-bearing.** The card gates its whole device flow on
`manageHint` (`:24`, `:55-58`), set by a 401 from `listDevices()`. The button
goes in the **authorized (`else`) branch**. On `castwright.local` with a lapsed
cookie the button could not work anyway — `pair-session` sits behind the guard —
and that case is Task 6's job.

**Three scaffolding facts** (all verified; the first draft got all three wrong):
1. `lan-access-card.tsx:21-26` fires `api.listDevices()` in `useEffect(refresh, [])`.
   The mock is a bare `vi.fn()` returning `undefined`, and `beforeEach` uses
   `vi.clearAllMocks()`, which clears **calls, not implementations**. Every test
   must stub `listDevices` itself or it passes only on leftover state from an
   earlier test in the file — flaky by construction, green by file ordering.
2. The file uses **`fireEvent`**, not `userEvent`. Match it.
3. `{ ...window.location }` spreads to `{}` under jsdom (Location's members are
   prototype accessors), and `vitest.config.ts` sets no `unstubGlobals`, so a
   `vi.stubGlobal('location', …)` **persists for the rest of the file**. Stub the
   fields explicitly and add `vi.unstubAllGlobals()` to an `afterEach`.

- [ ] **Step 1: Write the failing tests**

```tsx
afterEach(() => vi.unstubAllGlobals());

it('navigates to the friendly URL with self=1 when authorizing this browser', async () => {
  vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
  vi.mocked(api.createDevicePairSession).mockResolvedValue({
    url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
    friendlyUrl: 'https://castwright.local/#/pair?c=ABC',
  });
  const assign = vi.fn();
  vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
  render(<LanAccessCard />);
  fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
  await waitFor(() =>
    expect(api.createDevicePairSession).toHaveBeenCalledWith({ label: 'This computer' }),
  );
  expect(assign).toHaveBeenCalledWith('https://castwright.local/#/pair?c=ABC&self=1');
});

it('explains when castwright.local is not reachable instead of navigating', async () => {
  vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
  vi.mocked(api.createDevicePairSession).mockResolvedValue({
    url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
  }); // no friendlyUrl
  const assign = vi.fn();
  vi.stubGlobal('location', { hostname: 'localhost', port: '8443', assign });
  render(<LanAccessCard />);
  fireEvent.click(await screen.findByRole('button', { name: /authorize this browser/i }));
  expect(await screen.findByText(/castwright\.local isn't reachable/i)).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: FAIL — no such button (`findByRole` times out).

- [ ] **Step 3: Implement**

`ApiError` is already imported at `:4`. Add state and a handler beside the
existing `authorize`:

```tsx
  const [selfErr, setSelfErr] = useState<string | null>(null);

  const authorizeThisBrowser = async () => {
    setSelfErr(null);
    try {
      const s = await api.createDevicePairSession({ label: 'This computer' });
      if (!s.friendlyUrl) {
        setSelfErr("castwright.local isn't reachable right now — use the QR flow above, or check the app is running in production LAN mode.");
        return;
      }
      window.location.assign(`${s.friendlyUrl}&self=1`);
    } catch (e) {
      setSelfErr(e instanceof ApiError && e.status === 409
        ? 'LAN mode is not active on this server, so there is nothing to authorize against.'
        : e instanceof Error ? e.message : String(e));
    }
  };
```

Render it inside the `else` branch, after the existing authorize row:

```tsx
          <div className="mt-3">
            <PrimaryButton variant="dark" onClick={authorizeThisBrowser} icon={false}>
              Authorize this browser
            </PrimaryButton>
            <p className="mt-1 text-xs text-ink/55">
              Re-links this computer to https://castwright.local. No QR needed.
            </p>
            {selfErr && <p className="mt-2 text-sm text-rose-700">{selfErr}</p>}
          </div>
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: PASS, with the file's pre-existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/components/lan-access-card.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): add a one-click Authorize this browser action"
```

---

### Task 5: Auto-redeem on the self-bind hop

**Files:**
- Modify: `src/views/pair.tsx` (incl. `:37`'s `disabled=` expression)
- Test: `src/views/pair.test.tsx`

**Interfaces:**
- Consumes: `api.redeemBrowserPair({ code })`.
- Produces: nothing consumed downstream.

**Four hard requirements:**

1. **Capture the code in a ref, then scrub the URL BEFORE calling redeem — on
   the `self=1` path only.** The app uses `createHashRouter`, so `replaceState`
   fires no event and `params.get('c')` only keeps working because the router
   location is stale; the ref removes that dependency. **Scoping the scrub to
   the self path is a correction, not an accident:** moving it unconditionally
   to the top of `authorize` would also hit the manual QR click handler, so a
   phone user whose redeem failed and who then refreshed would land on `#/`
   with no code — reintroducing the dead-end this feature exists to remove, in
   the one flow the spec says is untouched.
2. **Offer Retry on `503` only** — not on `429` (fixed 60s window, so an
   immediate retry just fails) and not on `403` (an off-LAN caller never succeeds).
3. **Guard against a double fire with a `didRun` ref.** Pairing codes are
   single-use (`redeemPairingSession`), so a second effect run returns 401 and
   tells the user "This code expired" immediately after a *successful* bind.
   Latent today (no `StrictMode` anywhere in `src/main.tsx` / `src/routes/index.tsx`),
   but it is one `useNavigate`-identity change away and costs one line.
4. **`:37` currently reads `disabled={busy || !code}`.** Replacing `code` with a
   ref without updating it breaks `src/views/pair.test.tsx:72-75`
   (`disables the button when no code is present`).

**Scaffolding:** the helper is `renderPair(search)`, taking a **MemoryRouter path
with no `#`**. `ApiError` comes from the file's own `vi.mock` factory — existing
tests reach it via `const { ApiError } = await import('../lib/api');` inside the
test body (`:53`, `:63`). Follow that idiom. The file uses `fireEvent`.

- [ ] **Step 1: Write the tests**

```tsx
it('redeems on mount when self=1, scrubbing the code before the call', async () => {
  const order: string[] = [];
  const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => { order.push('scrub'); });
  vi.mocked(api.redeemBrowserPair).mockImplementation(async () => {
    order.push('redeem');
    return { label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' };
  });
  renderPair('/pair?c=ABC&self=1');
  await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenCalledWith({ code: 'ABC' }));
  expect(order).toEqual(['scrub', 'redeem']);
  spy.mockRestore();
});

// REGRESSION GUARD, not a red-phase test — see Step 2.
it('does not auto-redeem without self=1', async () => {
  renderPair('/pair?c=ABC');
  await new Promise((r) => setTimeout(r, 20));
  expect(api.redeemBrowserPair).not.toHaveBeenCalled();
});

it('auto-redeems exactly once', async () => {
  vi.mocked(api.redeemBrowserPair).mockResolvedValue({
    label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const { rerender } = renderPair('/pair?c=ABC&self=1');
  await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenCalledTimes(1));
  rerender(<div />);
  expect(api.redeemBrowserPair).toHaveBeenCalledTimes(1);
});

it('offers Retry after a 503 and reuses the captured code', async () => {
  const { ApiError } = await import('../lib/api');
  vi.mocked(api.redeemBrowserPair)
    .mockRejectedValueOnce(new ApiError('degraded', 503))
    .mockResolvedValueOnce({ label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' });
  renderPair('/pair?c=ABC&self=1');
  fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
  await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenNthCalledWith(2, { code: 'ABC' }));
});

it('does not offer Retry after a 429', async () => {
  const { ApiError } = await import('../lib/api');
  vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('rate', 429));
  renderPair('/pair?c=ABC&self=1');
  expect(await screen.findByText(/wait a minute/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and check the red phase honestly**

Run: `npx vitest run src/views/pair.test.tsx`

Expected: **4 fail, 1 passes.** The passing one is `does not auto-redeem without
self=1` — today `pair.tsx` only redeems on click, so it passes against the
unmodified file. That is correct and intended: it is a **regression guard**, not
a red-phase test. Do **not** "fix" it. The other four fail because no auto-redeem
exists (`findBy*` / `waitFor` time out).

- [ ] **Step 3: Implement**

```tsx
export function PairShell() {
  const [params] = useSearchParams();
  const codeRef = useRef(params.get('c') ?? '');   // captured once — survives the scrub
  const isSelf = params.get('self') === '1';
  const didRun = useRef(false);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);

  const authorize = useCallback(async (scrubFirst = false) => {
    setBusy(true); setError(null); setCanRetry(false);
    // Self-bind only: a failed redeem must not leave a live code in history
    // where a tab restore or Back could re-fire it unattended. The QR path
    // keeps its existing scrub-on-success so a phone user can still refresh.
    if (scrubFirst) window.history.replaceState(null, '', '#/');
    try {
      await api.redeemBrowserPair({ code: codeRef.current });
      navigate('/');
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401 || status === 410) setError('This code expired — generate a new one on the desktop.');
      else if (status === 429) setError('Too many attempts — wait a minute, then start again from the desktop.');
      else if (status === 403) setError('Pairing only works from your own network.');
      else if (status === 503) { setError('Castwright could not save the authorization just now. This is usually temporary.'); setCanRetry(true); }
      else setError('Could not authorize this browser.');
      setBusy(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!isSelf || !codeRef.current || didRun.current) return;
    didRun.current = true;
    void authorize(true);
  }, [isSelf, authorize]);
```

`:37`'s disabled expression must move off the removed `code` binding:

```tsx
        <PrimaryButton variant="dark" onClick={() => authorize()} disabled={busy || !codeRef.current} icon={false}>
```

Render the Retry button when `canRetry`:

```tsx
        {canRetry && (
          <PrimaryButton variant="dark" onClick={() => authorize(true)} disabled={busy} icon={false}>
            Try again
          </PrimaryButton>
        )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/views/pair.test.tsx`
Expected: PASS, including the pre-existing `:72-75` disabled-button test.

- [ ] **Step 5: Extend the e2e spec**

`e2e/lan-device-auth.spec.ts` exists (55 lines, 2 tests); the
`#/pair?c=MOCKCODEMOCKCODE` case is at `:34-54` and that code matches
`mockCreateDevicePairSession` (`src/lib/api.ts:7341-7347`). Add a case navigating
to `#/pair?c=MOCKCODEMOCKCODE&self=1` and asserting it lands on the library
without a click. (The button half is not e2e-testable: it navigates to an
absolute `castwright.local` URL the mock server on :5174 cannot resolve.)

Run: `npm run test:e2e -- lan-device-auth`

- [ ] **Step 6: Commit**

```bash
git add src/views/pair.tsx src/views/pair.test.tsx e2e/lan-device-auth.spec.ts
git commit -m "feat(frontend): auto-redeem the self-bind pairing hop"
```

---

### Task 6: A way out of the 401

**Files:**
- Modify: `src/lib/api.ts:1942-1947`, `src/store/library-slice.ts:11-15` **and** `:76`, `src/components/layout.tsx:581`, `src/views/book-library.tsx:23` + `:246` + `:396-403`, `src/components/lan-access-card.tsx:55-56`
- Test: `src/store/library-slice.test.ts:188`, `src/views/book-library.test.tsx:24-32` (the module mock) + `:823`, `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `ApiError` from `src/lib/api.ts` (exported at `:7290-7291`, `readonly status: number`).
- Produces: `LibraryState.error` becomes `{ message: string; status?: number } | null`; `hydrateError` takes that same object.

**Both dispatchers must move.** There are exactly two — `layout.tsx:581` (first
load) and `book-library.tsx:246` (**the Retry handler on this very panel**).
Fixing only the first makes the recovery link vanish the moment the user presses
Retry.

**The state type must widen too, and the reducer body is not what the first draft
said.** Verified current text at `src/store/library-slice.ts`:

```ts
  error: string | null;            // :15 — must widen
...
    hydrateError: (s, a: PayloadAction<string>) => {
      s.loaded = true;             // :77 — NOT `s.loading = false`; there is no `loading` field
      s.error = a.payload;
    },
```

**Scaffolding:** there is no `renderWithState`. `renderView({ loaded, authors })`
at `:56` hardcodes `error: null`. Copy the inline `configureStore` at `:823-845`
(reducers `account`, `library`, `tour`, `continueListening`; `preloadedState.library`
needs the full shape `{ loaded, error, authors, books, pausedSnapshots }`). The
module mock at `:24-32` exports only `getWorkspaceInfo`, `getContinueListening`,
`setShelfStatus` — add `getLibrary: vi.fn()` and re-export `ApiError` via
`importOriginal` (the idiom `lan-access-card.test.tsx:6-9` already uses).

- [ ] **Step 1: Write the failing tests**

Add a local helper to `book-library.test.tsx` modelled on `:823-845`:

```tsx
function renderWithLibraryError(error: { message: string; status?: number } | null) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, library: librarySlice.reducer,
               tour: tourSlice.reducer, continueListening: continueListeningSlice.reducer },
    preloadedState: {
      library: { loaded: true, error, authors: [], books: [], pausedSnapshots: {} },
    },
  });
  return render(<Provider store={store}><BookLibrary /></Provider>);
}

it('renders a recovery pointer on a 401 library error', () => {
  renderWithLibraryError({ message: 'Library scan failed (401): Missing or invalid LAN access token.', status: 401 });
  expect(screen.getByText(/authorize this browser/i)).toBeInTheDocument();
  // The raw server text must not reach the user.
  expect(screen.queryByText(/Missing or invalid LAN access token/)).not.toBeInTheDocument();
});

it('still shows the raw message for a non-401 error', () => {
  renderWithLibraryError({ message: 'Library scan failed (500): boom', status: 500 });
  expect(screen.getByText(/boom/)).toBeInTheDocument();
  expect(screen.queryByText(/authorize this browser/i)).not.toBeInTheDocument();
});

it('keeps the recovery pointer after Retry fails again with 401', async () => {
  const { ApiError } = await import('../lib/api');
  vi.mocked(api.getLibrary).mockRejectedValue(new ApiError('nope', 401));
  renderWithLibraryError({ message: 'x', status: 401 });
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByText(/authorize this browser/i)).toBeInTheDocument();
});
```

Note the first test's suppression assertion now uses a fixture message that
**actually contains** the raw string — the first draft asserted the absence of
text that was never in its fixture, which passes no matter what the panel does.

`recoveryHint()` has three branches and jsdom pins one origin, so stub the
hostname per branch:

```tsx
it.each([
  ['localhost', '8443', /https:\/\/localhost:8443/],
  ['castwright.local', '', /Open Castwright on the computer running it/],
  ['192.168.1.9', '8443', /Open Castwright on the computer running it/],
])('addresses the %s case', (hostname, port, expected) => {
  vi.stubGlobal('location', { hostname, port });
  renderWithLibraryError({ message: 'x', status: 401 });
  expect(screen.getByText(expected)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/views/book-library.test.tsx`
Expected: FAIL — the panel prints the raw message and `error` is still a string.

- [ ] **Step 3: Implement**

`src/lib/api.ts:1942-1947` — throw a typed error:

```ts
async function realGetLibrary(): Promise<LibraryResponse> {
  const res = await fetch('/api/library');
  if (!res.ok)
    throw new ApiError(`Library scan failed (${res.status}): ${(await res.text()) || res.statusText}`, res.status);
  return res.json();
}
```

`src/store/library-slice.ts` — widen the state **and** the action, keeping
`s.loaded = true`:

```ts
  /** Non-null when the most recent library fetch failed. Carries the HTTP
   *  status so the books view can offer a recovery path for a 401 instead of
   *  printing the server's raw text. Cleared on a successful hydrate. */
  error: { message: string; status?: number } | null;
...
    hydrateError: (s, a: PayloadAction<{ message: string; status?: number }>) => {
      s.loaded = true;
      s.error = a.payload;
    },
```

Both dispatchers (`layout.tsx:581`, `book-library.tsx:246`) become:

```ts
dispatch(libraryActions.hydrateError({
  message: e instanceof Error ? e.message : String(e),
  status: e instanceof ApiError ? e.status : undefined,
}));
```

`src/views/book-library.tsx:23` currently imports `{ api, type WorkspaceInfo }` —
add `ApiError`. In the error panel, branch on the status. Derive the address from
the hostname, never a hardcoded port:

```tsx
const recoveryHint = (): string => {
  // `castwright.local` is the mDNS name — EVERY device on the LAN resolves it,
  // so it is not evidence the user is sitting at the host. Only true loopback is.
  const h = window.location.hostname;
  const onHost = h === 'localhost' || h === '127.0.0.1';
  if (!onHost) return 'Open Castwright on the computer running it and use “Authorize this browser”, then reload here.';
  // location.port is '' on the :443 forwarder path — never promise a port we don't know.
  return window.location.port
    ? `Open https://localhost:${window.location.port} on this computer and use “Authorize this browser”.`
    : 'Open Castwright on this computer and use “Authorize this browser” under Account → LAN access.';
};
```

and render `error.status === 401 ? <>This browser is no longer authorized for Castwright on your network. {recoveryHint()}</> : error.message`.

Apply the same text to `lan-access-card.tsx:55-56`'s `manageHint` branch.

- [ ] **Step 4: Run the full frontend suite**

Run: `npm test`
Expected: PASS. `library-slice.test.ts:188` (`hydrateError('boom')`) and
`book-library.test.tsx:823` (which sets `error: 'Network'`) need updating to the
new payload shape — that is expected, not collateral damage. `npm run typecheck`
must also pass; the widened state type surfaces every other reader of
`library.error`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/store/library-slice.ts src/components/layout.tsx \
        src/views/book-library.tsx src/components/lan-access-card.tsx \
        src/store/library-slice.test.ts src/views/book-library.test.tsx \
        src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): give the 401 library dead-end a way out"
```

---

### Task 7: Documentation, obligations, and follow-ups

**Files:**
- Create: `docs/features/283-castwright-local-rebind.md`
- Modify: `docs/features/INDEX.md`, `docs/features/225-lan-browser-device-auth.md:46,:53`, `docs/wiki/Advanced-Settings.md:363`, `docs/wiki/Troubleshooting.md:344`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/testing/onbox-acceptance-register.md` + its live view

- [ ] **Step 1: Write the regression plan** at `docs/features/283-castwright-local-rebind.md` from `docs/features/TEMPLATE.md`, `status: active`, linking issue #2247 and the spec.

- [ ] **Step 2: Correct plan 225.** Line `:53` says the knob's default is 30 — now 365 with a 400 ceiling. Line `:46` claims `device-tokens.pure.test.ts` / `device-tokens.test.ts` cover `clampTtlDays`; that was **false** until Task 1 (verified: zero hits in either file), so restate it as true-as-of-now rather than deleting it.

- [ ] **Step 3: Update the wiki rows.**
  - `docs/wiki/Advanced-Settings.md:363` — currently `| Device authorization lifetime (days) | How long a browser/device authorization stays valid before re-pairing | 30 | integer, min 1 | live | low |`. Update the default cell (`30` → `365`), Constraints (`integer, min 1` → `integer, min 1, max 400`), and the description to match the reworded `help`.
  - `docs/wiki/Troubleshooting.md:344` quotes the exact 401 string Task 6 replaces (*"Couldn't load your library — Library scan failed (401): Missing or invalid LAN access token."*). Rewrite it to describe the new panel and the one-click recovery.

  Both files are mirrored, not generated (`scripts/sync-wiki.mjs:1-9`), so hand edits are correct.

- [ ] **Step 4: Release notes**, both files. User-facing line for `RELEASE_NOTES.md`, e.g. *"Re-link this computer to castwright.local in one click, and authorizations now last a year instead of a month."* The technical register must state that **existing** authorizations keep their old expiry, that an install which ever saved the Settings row keeps its stored value, and that mock mode no longer preloads Kokoro (Task 2's incidental fix).

- [ ] **Step 5: On-box acceptance row.** `friendlyUrl` requires the mDNS responder **and** the `:443` forwarder, both gated to `NODE_ENV === 'production'`, so `npm run dev:lan` can never render a working button — the local production route is `npm run build && npm run start:lan`, which needs elevation to bind `:443`. Record: a cleared-cookie browser recovers in one click, and a fresh bind shows `expires` ~a year out. Follow the register's four-step live-view publish procedure.

- [ ] **Step 6: File three follow-ups** as `type:chore`, `area:srv` (the third `area:fe`), linked to #2247:
  1. Revoke the prior self-bind record (needs a self-bind marker on the pairing session across `pairing-sessions.ts`, `pairing.ts`, `device-tokens.ts`, `devices.ts`, plus a non-nesting `enqueueWrite` composition — see `device-tokens.ts:499-507`).
  2. Emit `friendlyUrl` with the bound port when the `:443` forwarder is down but mDNS is alive (needs splitting the single boolean at `server/src/index.ts:360-362`).
  3. **New (from the plan review):** decide whether the frontend mock registry should mirror the server registry in full. It is currently a documented 98-of-115 subset with 2 UI-only entries (`KOKORO_SAMPLE_RATE`, `ANALYZER_STAGE1_PROMPT`); 19 registry knobs have no mock descriptor. Task 2's guard covers only the intersection, so a knob missing from the mock is still invisible to it. List the 19 in the issue body.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(docs): plan 283, release notes, and register row for the re-bind"
```

---

### Task 8: Ship

- [ ] **Step 1:** `npm run verify:fast:branch`
- [ ] **Step 2:** Push and open the PR — title `feat(server,frontend): one-click castwright.local re-bind`, body containing `Closes #2247`. The body must declare Task 2's two incidental drift fixes ("Also fixed, found in passing: …").
- [ ] **Step 3:** Run the mandatory `pr-review-gate` pass (multi-scope `feat` → effort `high`). Triage and fold findings before merge.
- [ ] **Step 4:** Merge with the merge-commit button; tear the worktree down (junctions first).

## Self-Review

**Spec coverage.** Component 1 → Tasks 1-3. Component 2 → Task 4. Component 3 →
Task 5. Component 4 → Task 6. Repo obligations → Task 7. The spec's Testing
§Server item 2 (`max: 400` **rejects** 401 through `coerceAndValidate`) is now a
named assertion in Task 1 Step 1 — the first draft asserted only the descriptor
shape. The spec's Component 4 three-branch requirement is now three test cases in
Task 6 Step 1 rather than one. Both deferrals plus the new mock-parity question
become issues in Task 7 Step 6. No spec section is unimplemented.

**Placeholder scan.** No TBDs; every code step carries real code; the
"explain inline" strings are quoted verbatim.

**Type consistency.** `hydrateError` takes `{ message, status? }` in Task 6 and
is dispatched that way at both sites, and `LibraryState.error` widens to match.
`clampTtlDays(raw: unknown): number` keeps its signature. `friendlyUrl` is
`string | undefined` throughout. The label `'This computer'` and the flag
`self=1` are identical in Tasks 4 and 5. `codeRef` replaces `code` at every
reader in `pair.tsx`, `:37` included.

**Red-phase honesty.** Every "Expected: FAIL" now names the concrete failure and
the observed value where one exists (Task 3 records `Max-Age=2592000`). The one
test that legitimately passes before its change — Task 5's `does not auto-redeem
without self=1` — is labelled a regression guard, and Step 2 states the expected
split as 4 fail / 1 pass so an implementer does not "fix" it. Task 2's guard
carries a non-emptiness floor so it cannot degrade into `[] === []`.

## Review history

**Round 1 — `assumption-checker`, 2026-08-11.** 18 assumptions audited against
the files on disk. 6 rated `Critical` + `Contradicted`, 6 `Significant` +
`Contradicted`. All folded into revision 2. The load-bearing ones:

- `device-tokens.pure.test.ts` **exists** (160 lines, 15 tests incl. the #2144
  malformed-`expiresAt` arms); the plan's full-file snippet would have erased it
  **silently** — the surviving tests still pass, so nothing goes red.
- `MOCK_CONFIG_DESCRIPTORS` is not exported, and the mock is a **documented
  subset** (115 vs 98). Task 2's full-parity guard could neither be written nor
  pass; it also carried a scope trapdoor that would have flipped mock-mode
  Kokoro preload inside a `test(frontend):` commit.
- `renderAt` and `renderWithState` **do not exist**. The real helpers are
  `renderPair` (MemoryRouter path, no `#`) and `renderView` (cannot inject an
  error). `book-library.test.tsx`'s module mock exports neither `getLibrary` nor
  `ApiError`, so Task 6's headline Retry test could not have run.
- `LibraryState.error` is `string | null` and was never widened, so Task 6 would
  not compile; the reducer body is `s.loaded = true`, not the `s.loading = false`
  the draft wrote (no `loading` field exists).
- `clampTtlDays(0)` returned the **default**, so raising it to 365 turned a
  30-day curiosity into a 12× footgun — and the draft pinned it in a test.
- `castwright.local` is the **mDNS** name every LAN device resolves, so it is not
  evidence the user is at the host; the draft's `recoveryHint` gave a phone
  instructions for a machine it is not on.
- Task 3's red phase was **booked, not run** ("Expected: PASS" on a failing-test
  step), and Task 5's Step 2 claimed 4/4 red when one test passes today.

Confirmed and unchanged: `pair.tsx` genuinely uses react-router
(`useSearchParams`/`useNavigate` + `createHashRouter`), `PrimaryButton` takes
`variant="dark"`/`icon={false}`, `ApiError` is exported with `readonly status`,
exactly two `hydrateError` dispatchers exist, and every cited docs/wiki line is
accurate.
