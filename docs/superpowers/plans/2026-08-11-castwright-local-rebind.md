# One-click `castwright.local` re-bind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make re-binding this computer's browser to `https://castwright.local` a one-click action, give the 401 dead-end a way out, and raise the device-token lifetime so neither is needed often.

**Architecture:** Four independent slices. The server slice is a config-default change with a new upper bound. The three frontend slices add a self-bind button on the loopback origin, auto-redeem on the hop it navigates to, and an `ApiError` status seam so the library's 401 panel can render a recovery link instead of raw JSON. No new endpoints; the pairing mechanism already exists and is reused unchanged.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-11-castwright-local-rebind-design.md` (revision 4)
**Issue:** #2247 (srv-90)

## Global Constraints

- Branch `feat/frontend-lan-rebind`, worktree `C:\Claude\Projects\wt-lan-rebind`. Never commit to `main`.
- New TTL default: **365**. New ceiling: **400** (Chrome's cookie `Max-Age` cap since M104). Both values exact.
- The self-bind label is exactly `'This computer'`.
- The self-bind query flag is exactly `self=1`.
- **Never** treat `self=1` as a trust signal — the gate is the one-time code.
- **Never** string-match `/\(401\)/` on an error message; branch on a status field.
- Every task ends green on `npm test` (frontend) or `npm run test:server`, and commits.
- Commit subjects follow `<type>(<scope>): <subject>` — scopes here are `server`, `frontend`, `docs`.

---

### Task 1: Raise the TTL default and add a ceiling

**Files:**
- Modify: `server/src/config/registry.ts:1254-1263`
- Modify: `server/src/workspace/device-tokens.ts:84-87`
- Test: `server/src/config/registry.test.ts:78-84` (edit existing)
- Test: `server/src/workspace/device-tokens.pure.test.ts` (add — `clampTtlDays` has **no** tests today)

**Interfaces:**
- Consumes: nothing.
- Produces: `clampTtlDays(raw: unknown): number` — unchanged signature, now clamping both bounds; registry knob `lan.deviceTokenTtlDays` with `default: 365, min: 1, max: 400`.

- [ ] **Step 1: Write the failing tests**

In `server/src/workspace/device-tokens.pure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clampTtlDays } from './device-tokens.js';

describe('clampTtlDays', () => {
  it('falls back to 365 for a non-integer', () => {
    expect(clampTtlDays('nonsense')).toBe(365);
    expect(clampTtlDays(undefined)).toBe(365);
    expect(clampTtlDays(1.5)).toBe(365);
  });
  it('clamps below the lower bound', () => {
    expect(clampTtlDays(0)).toBe(365);
    expect(clampTtlDays(-1)).toBe(365);
  });
  it('clamps above the ceiling to 400', () => {
    expect(clampTtlDays(401)).toBe(400);
    expect(clampTtlDays(100_000)).toBe(400);
  });
  it('passes an in-range value through', () => {
    expect(clampTtlDays(30)).toBe(30);
    expect(clampTtlDays(400)).toBe(400);
  });
});
```

In `server/src/config/registry.test.ts`, edit the existing block (rename the
title — it currently says "30-day default"):

```ts
  it('registers the device-token TTL knob with a 365-day default and a 400-day ceiling', () => {
    const k = KNOBS.find((x) => x.key === 'lan.deviceTokenTtlDays');
    expect(k).toMatchObject({
      env: 'LAN_DEVICE_TTL_DAYS',
      group: 'lan-access',
      type: 'integer',
      min: 1,
      max: 400,
      default: 365,
      apply: 'live',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts src/config/registry.test.ts`
Expected: FAIL — `clampTtlDays(401)` returns `401`, and the knob has `default: 30` with no `max`.

- [ ] **Step 3: Implement**

`server/src/workspace/device-tokens.ts` — note the doc comment must change too;
it currently says "fall back to the 30-day default":

```ts
/** Clamp a configured TTL to a sane integer in [1, 400]; fall back to the
 *  365-day default. The ceiling mirrors Chrome's 400-day cookie Max-Age cap
 *  (M104): above it the server record would outlive the cookie, which is the
 *  divergence this bound exists to prevent. `max` in the registry already
 *  rejects out-of-range env and Settings writes (config/resolver.ts:168); this
 *  clamp guards the one unvalidated path — a stored override, returned raw by
 *  resolveKnobInner (config/resolver.ts:32-55). */
export function clampTtlDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 365;
  return Math.min(raw, 400);
}
```

`server/src/config/registry.ts` — in the `lan.deviceTokenTtlDays` descriptor,
set `default: 365`, add `max: 400`, and reword `help` so the "new mints only"
fact reaches the user:

```ts
    help: 'How long a NEWLY authorized browser or device stays valid. Changing this does not extend authorizations that already exist — re-authorize a device to give it the new lifetime.',
    type: 'integer', min: 1, max: 400,
    default: 365,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts src/config/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate the env example**

Run: `npm run config:sync`
Then: `npm run config:check` — must exit 0. This rewrites the managed block in
`server/.env.example` (the `LAN_DEVICE_TTL_DAYS` line near `:683`).

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
- Modify: `src/lib/api.ts:9437-9446` (mock registry mirror), `src/lib/api.ts:7363` (`mockRedeemBrowserPair`)
- Test: `src/lib/api.config.test.ts:305-361` (extend)

**Interfaces:**
- Consumes: Task 1's registry values.
- Produces: a parity guard that compares `{key, default, min, max}` for **every** knob, so no future default can drift silently.

**Why the obvious test is a placebo:** the existing guard compares
`.map(d => d.key).sort()` for two groups, neither of them `lan-access` — and
`lan-access` holds exactly one knob, so a keys-only comparison over it can never
catch a 30-vs-365 drift. Compare projected values across all groups instead.
Do **not** compare whole descriptors: `MOCK_CONFIG_DESCRIPTORS` omits `env`.

- [ ] **Step 1: Write the failing test**

In `src/lib/api.config.test.ts`:

```ts
it('mock descriptors match the server registry on default/min/max for every knob', async () => {
  const { KNOBS } = await import('../../server/src/config/registry.js');
  const project = (d: { key: string; default?: unknown; min?: number; max?: number }) => ({
    key: d.key, default: d.default, min: d.min, max: d.max,
  });
  const mock = MOCK_CONFIG_DESCRIPTORS.map(project).sort((a, b) => a.key.localeCompare(b.key));
  const real = KNOBS.map(project).sort((a, b) => a.key.localeCompare(b.key));
  expect(mock).toEqual(real);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/api.config.test.ts`
Expected: FAIL — the mock still says `default: 30` while the server says `365`.

If it fails instead on *unrelated* knobs, that is pre-existing drift this guard
just exposed. Fix the mock to match the server for those too, and note each one
in the commit body — do not weaken the assertion to hide them.

- [ ] **Step 3: Implement**

In `src/lib/api.ts`, the `lan.deviceTokenTtlDays` mock descriptor (`:9437`):

```ts
    key: 'lan.deviceTokenTtlDays',
    group: 'lan-access',
    label: 'Device authorization lifetime (days)',
    help: 'How long a NEWLY authorized browser or device stays valid. Changing this does not extend authorizations that already exist — re-authorize a device to give it the new lifetime.',
    type: 'integer', min: 1, max: 400,
    default: 365,
```

And `mockRedeemBrowserPair` (`:7363`), so mock mode stops reporting a 30-day expiry:

```ts
const mockRedeemBrowserPair = async (_b: { code: string }) =>
  ({ label: 'This browser', expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/api.config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.config.test.ts
git commit -m "test(frontend): pin mock config defaults to the server registry"
```

---

### Task 3: Assert the cookie's `Max-Age`, not just the record

**Files:**
- Modify: `server/src/routes/pairing.test.ts:59` (the `configValue` mock), `:85` (the local `clampTtlDays`)
- Test: `server/src/routes/pairing.test.ts:227-239` (extend the `Set-Cookie` assertions)

**Interfaces:**
- Consumes: Task 1.
- Produces: nothing consumed downstream.

**Why this task exists:** revision 1 of the design failed because the server
record and the browser cookie can disagree, and *no test asserts `Max-Age`
today*. Be clear what this proves: that `maxAge` tracks `ttl()`. Task 1's
literal-`365` assertion is what proves the default. Neither alone is enough.

- [ ] **Step 1: Update the file-level mocks**

`pairing.test.ts:59` currently hardwires the TTL, which would make any `Max-Age`
assertion meaningless:

```ts
vi.mock('../config/resolver.js', () => ({ configValue: (_key: string) => 365 }));
```

And `:85`'s local reimplementation must match Task 1's real clamp:

```ts
    clampTtlDays: (v: unknown) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, 400) : 365,
```

- [ ] **Step 2: Write the failing assertion**

Extend the existing `Set-Cookie` test near `:227`:

```ts
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('__Host-cw_lan=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=31536000'); // 365 days — must track ttl()
```

- [ ] **Step 3: Run it**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS once Step 1 landed (the assertion fails with `Max-Age=2592000` if
the mock at `:59` was left at 30 — that failure is the point of Step 1).

- [ ] **Step 4: Commit**

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

- [ ] **Step 1: Write the failing tests**

```tsx
it('navigates to the friendly URL with self=1 when authorizing this browser', async () => {
  vi.mocked(api.createDevicePairSession).mockResolvedValue({
    url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
    friendlyUrl: 'https://castwright.local/#/pair?c=ABC',
  });
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  render(<LanAccessCard />);
  await userEvent.click(screen.getByRole('button', { name: /authorize this browser/i }));
  expect(api.createDevicePairSession).toHaveBeenCalledWith({ label: 'This computer' });
  expect(assign).toHaveBeenCalledWith('https://castwright.local/#/pair?c=ABC&self=1');
});

it('explains when castwright.local is not reachable instead of navigating', async () => {
  vi.mocked(api.createDevicePairSession).mockResolvedValue({
    url: 'https://192.168.1.5:8443/#/pair?c=ABC', code: 'ABC', expiresAt: Date.now() + 300_000,
  }); // no friendlyUrl
  render(<LanAccessCard />);
  await userEvent.click(screen.getByRole('button', { name: /authorize this browser/i }));
  expect(await screen.findByText(/castwright\.local isn't reachable/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: FAIL — no such button.

- [ ] **Step 3: Implement**

Add state and a handler beside the existing `authorize`:

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
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/lan-access-card.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): add a one-click Authorize this browser action"
```

---

### Task 5: Auto-redeem on the self-bind hop

**Files:**
- Modify: `src/views/pair.tsx`
- Test: `src/views/pair.test.tsx`

**Interfaces:**
- Consumes: `api.redeemBrowserPair({ code })`.
- Produces: nothing consumed downstream.

**Two hard requirements**, both from the spec:
1. **Capture the code in a ref, then scrub the URL BEFORE calling redeem.** The
   app uses `createHashRouter`, so `replaceState` fires no event and
   `params.get('c')` only keeps working because the router location is stale —
   an implementer who scrubs with `navigate('/', { replace: true })` would break
   Retry. The ref removes that dependency.
2. **Offer Retry on `503` only** — not on `429` (fixed 60s window, so an
   immediate retry just fails) and not on `403` (an off-LAN caller never
   succeeds).

- [ ] **Step 1: Write the failing tests**

```tsx
it('redeems on mount when self=1, scrubbing the code before the call', async () => {
  const order: string[] = [];
  const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => { order.push('scrub'); });
  vi.mocked(api.redeemBrowserPair).mockImplementation(async () => {
    order.push('redeem');
    return { label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' };
  });
  renderAt('#/pair?c=ABC&self=1');
  await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenCalledWith({ code: 'ABC' }));
  expect(order).toEqual(['scrub', 'redeem']);
  spy.mockRestore();
});

it('does not auto-redeem without self=1', async () => {
  renderAt('#/pair?c=ABC');
  await new Promise((r) => setTimeout(r, 20));
  expect(api.redeemBrowserPair).not.toHaveBeenCalled();
});

it('offers Retry after a 503 and reuses the captured code', async () => {
  vi.mocked(api.redeemBrowserPair)
    .mockRejectedValueOnce(new ApiError('degraded', 503))
    .mockResolvedValueOnce({ label: 'This browser', expiresAt: '2099-01-01T00:00:00.000Z' });
  renderAt('#/pair?c=ABC&self=1');
  const retry = await screen.findByRole('button', { name: /try again/i });
  await userEvent.click(retry);
  await waitFor(() => expect(api.redeemBrowserPair).toHaveBeenNthCalledWith(2, { code: 'ABC' }));
});

it('does not offer Retry after a 429', async () => {
  vi.mocked(api.redeemBrowserPair).mockRejectedValueOnce(new ApiError('rate', 429));
  renderAt('#/pair?c=ABC&self=1');
  expect(await screen.findByText(/wait a minute/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/views/pair.test.tsx`
Expected: FAIL — no auto-redeem, and the scrub happens after the await.

- [ ] **Step 3: Implement**

```tsx
export function PairShell() {
  const [params] = useSearchParams();
  const codeRef = useRef(params.get('c') ?? '');   // captured once — survives the scrub
  const isSelf = params.get('self') === '1';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);

  const authorize = useCallback(async () => {
    setBusy(true); setError(null); setCanRetry(false);
    // Scrub FIRST: a failed redeem must not leave a live code in history where a
    // tab restore or Back could re-fire it unattended.
    window.history.replaceState(null, '', '#/');
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

  useEffect(() => { if (isSelf && codeRef.current) void authorize(); }, [isSelf, authorize]);
```

Render the Retry button when `canRetry`:

```tsx
        {canRetry && (
          <PrimaryButton variant="dark" onClick={authorize} disabled={busy} icon={false}>
            Try again
          </PrimaryButton>
        )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/views/pair.test.tsx`
Expected: PASS.

- [ ] **Step 5: Extend the e2e spec**

In `e2e/lan-device-auth.spec.ts`, add a case navigating to
`#/pair?c=MOCKCODEMOCKCODE&self=1` and asserting it lands on the library without
a click. (The button half of the flow is not e2e-testable: it navigates to an
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
- Modify: `src/lib/api.ts:1943-1946`, `src/store/library-slice.ts:76`, `src/components/layout.tsx:581`, `src/views/book-library.tsx:246` and `:396-403`, `src/components/lan-access-card.tsx:55-56`
- Test: `src/store/library-slice.test.ts:188`, `src/views/book-library.test.tsx:823`, `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `ApiError` from `src/lib/api.ts`.
- Produces: `hydrateError` now takes `{ message: string; status?: number }`.

**Both dispatchers must move.** There are exactly two — `layout.tsx:581` (first
load) and `book-library.tsx:246` (**the Retry handler on this very panel**).
Fixing only the first makes the recovery link vanish the moment the user
presses Retry.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders a recovery pointer on a 401 library error', () => {
  renderWithState({ library: { error: { message: 'Library scan failed (401)', status: 401 } } });
  expect(screen.getByText(/authorize this browser/i)).toBeInTheDocument();
  expect(screen.queryByText(/Missing or invalid LAN access token/)).not.toBeInTheDocument();
});

it('keeps the recovery pointer after Retry fails again with 401', async () => {
  vi.mocked(api.getLibrary).mockRejectedValue(new ApiError('nope', 401));
  renderWithState({ library: { error: { message: 'x', status: 401 } } });
  await userEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByText(/authorize this browser/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/views/book-library.test.tsx`
Expected: FAIL — the panel prints the raw message.

- [ ] **Step 3: Implement**

`src/lib/api.ts` — throw a typed error:

```ts
async function realGetLibrary(): Promise<LibraryResponse> {
  const res = await fetch('/api/library');
  if (!res.ok)
    throw new ApiError(`Library scan failed (${res.status}): ${(await res.text()) || res.statusText}`, res.status);
  return res.json();
}
```

`src/store/library-slice.ts` — widen the action:

```ts
    hydrateError: (s, a: PayloadAction<{ message: string; status?: number }>) => {
      s.error = a.payload;
      s.loading = false;
    },
```

Both dispatchers become:

```ts
dispatch(libraryActions.hydrateError({
  message: e instanceof Error ? e.message : String(e),
  status: e instanceof ApiError ? e.status : undefined,
}));
```

`src/views/book-library.tsx` — in the error panel, branch on the status. Derive
the address from the hostname, never a hardcoded port:

```tsx
const recoveryHint = (): string => {
  const h = window.location.hostname;
  const onHost = h === 'localhost' || h === '127.0.0.1' || h === 'castwright.local';
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
Expected: PASS. `library-slice.test.ts:188` and `book-library.test.tsx:823` need
updating to the new payload shape — that is expected, not collateral damage.

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
- Modify: `docs/features/INDEX.md`, `docs/features/225-lan-browser-device-auth.md:46,:53`, `docs/wiki/Advanced-Settings.md:363`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/testing/onbox-acceptance-register.md` + its live view

- [ ] **Step 1: Write the regression plan** at `docs/features/283-castwright-local-rebind.md` from `docs/features/TEMPLATE.md`, `status: active`, linking issue #2247 and the spec.

- [ ] **Step 2: Correct plan 225.** Line `:53` says the knob's default is 30 — now 365 with a 400 ceiling. Line `:46` claims `device-tokens.pure.test.ts` / `device-tokens.test.ts` cover `clampTtlDays`; that was false until Task 1, so restate it as true-as-of-now rather than deleting it.

- [ ] **Step 3: Update the wiki row** at `docs/wiki/Advanced-Settings.md:363` — both the default cell (`30` → `365`) and Constraints (`integer, min 1` → `integer, min 1, max 400`). This file is mirrored, not generated (`scripts/sync-wiki.mjs:1-9`), so the hand edit is correct.

- [ ] **Step 4: Release notes**, both files. User-facing line for `RELEASE_NOTES.md`, e.g. *"Re-link this computer to castwright.local in one click, and authorizations now last a year instead of a month."* Mention in the technical register that **existing** authorizations keep their old expiry, and that an install which ever saved the Settings row keeps its stored value.

- [ ] **Step 5: On-box acceptance row.** `friendlyUrl` requires the mDNS responder **and** the `:443` forwarder, both gated to `NODE_ENV === 'production'`, so `npm run dev:lan` can never render a working button — the local production route is `npm run build && npm run start:lan`, which needs elevation to bind `:443`. Record: a cleared-cookie browser recovers in one click, and a fresh bind shows `expires` ~a year out. Follow the register's four-step live-view publish procedure.

- [ ] **Step 6: File the two deferred follow-ups** as `type:chore`, `area:srv`, linked to #2247:
  1. Revoke the prior self-bind record (needs a self-bind marker on the pairing session across `pairing-sessions.ts`, `pairing.ts`, `device-tokens.ts`, `devices.ts`, plus a non-nesting `enqueueWrite` composition — see `device-tokens.ts:499-507`).
  2. Emit `friendlyUrl` with the bound port when the `:443` forwarder is down but mDNS is alive (needs splitting the single boolean at `server/src/index.ts:360-362`).

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(docs): plan 283, release notes, and register row for the re-bind"
```

---

### Task 8: Ship

- [ ] **Step 1:** `npm run verify:fast:branch`
- [ ] **Step 2:** Push and open the PR — title `feat(server,frontend): one-click castwright.local re-bind`, body containing `Closes #2247`.
- [ ] **Step 3:** Run the mandatory `pr-review-gate` pass (multi-scope `feat` → effort `high`). Triage and fold findings before merge.
- [ ] **Step 4:** Merge with the merge-commit button; tear the worktree down (junctions first).

## Self-Review

**Spec coverage.** Component 1 → Tasks 1-3. Component 2 → Task 4. Component 3 →
Task 5. Component 4 → Task 6. Repo obligations → Task 7. Both deferrals become
issues in Task 7 Step 6. No spec section is unimplemented.

**Placeholder scan.** No TBDs; every code step carries real code; the two
"explain inline" strings are quoted verbatim.

**Type consistency.** `hydrateError` takes `{ message, status? }` in Task 6 and
is dispatched that way at both sites. `clampTtlDays(raw: unknown): number` keeps
its signature. `friendlyUrl` is `string | undefined` throughout. The label
`'This computer'` and the flag `self=1` are identical in Tasks 4 and 5.
