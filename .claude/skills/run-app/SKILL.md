---
name: run-app
description: Launch and drive the Audiobook Generator app to verify a change works in the real browser (Vite + React frontend, Node/Express server, Python TTS sidecar). Use when asked to run/start/verify the app, confirm a change works in the real app (not just tests), or screenshot a view.
---

# Running & verifying the Audiobook Generator app

The app is a Vite + React SPA (`src/`) talking to a Node/Express server
(`server/`) that owns a Python TTS sidecar. The frontend can run **standalone
in mock mode** (`VITE_USE_MOCKS`, set in `.env.development`) with no server or
sidecar — that's the fastest way to verify a frontend/stack change.

## STEP 0 — after pulling or switching branches: reinstall FIRST

**This is the #1 gotcha.** A running `npm run dev` does NOT reinstall
`node_modules` or restart Vite. If `package.json` changed (a dep bump, a branch
switch, a `git pull`), the live server keeps serving the OLD stack — you'll see
old versions even though the source on disk is new ("why is it running on the
old stack?"). Relaunching is not reinstalling.

```bash
npm install                 # root deps
npm install --prefix server # server deps (separate tree)
```

Confirm the stack actually flipped before trusting a run:

```bash
node -e "for (const m of ['react','vite','vitest','react-router-dom','typescript']) console.log(m, require(\`./node_modules/\${m}/package.json\`).version)"
```

Current stack (post plan 167, 2026-06-02): React 19, Vite 8 (Rolldown), Vitest 4,
react-router-dom 7, TypeScript 6.

## STEP 1 — launch

| Goal | Command | Ports |
|---|---|---|
| Frontend only (mock mode — best for a quick verify) | `npm run dev:frontend` | Vite `:5173` |
| Full dev (frontend + server + sidecar) | `npm run dev` | `:5173` + `:8080` |
| Production bundle smoke | `npm run build && npm run preview` | preview port |

In a worktree, `scripts/wt-new.mjs` assigns per-worktree ports (e.g. `:5193`/`:8100`)
via `.env.local` — check the wt-new output. The primary checkout uses `:5173`/`:8080`.

Launch in the background and wait for ready:

```bash
npm run dev:frontend > /tmp/dev.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:5173/ && { echo ready; break; }; sleep 1; done
```

## STEP 2 — DRIVE it in a real browser (don't just curl)

`curl` only returns the empty `index.html` shell — it can't tell you whether
React rendered or threw. Drive it with the project's Playwright chromium.

**Write the driver script and its screenshot to the OS temp directory, NEVER
the repo root.** A repo-root scratch file dirties `git status --porcelain`
and trips the PR review gate's own tree check (see
`.claude/skills/pr-review-gate/references/reviewer-brief.md`'s "Post your own
findings" section, which hits the identical trap). `mktemp -d` is the
documented temp path in this repo's Git-Bash-on-Windows environment — it
resolves under Windows' own temp root (confirmed: `/tmp/tmp.XXXXXXXXXX` maps
to `%TEMP%`), unlike `$TMPDIR`, which Git Bash leaves unset here.

```bash
VERIFY_DIR="$(mktemp -d)"
cat > "$VERIFY_DIR/verify-drive.mjs" <<'EOF'
import { chromium } from '@playwright/test';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && errors.push('console.error: ' + m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=/Welcome back|Your audiobooks|New book/i', { timeout: 20000 }); // boot rendered
const heading = await page.locator('h1,h2').first().innerText();
try { await page.getByRole('button', { name: /^Voices$/ }).click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(800);
await page.screenshot({ path: process.env.VERIFY_SCREENSHOT });
console.log('HEADING=' + heading, '| NAV_URL=' + page.url(), '| ERRORS=' + errors.length);
errors.forEach((e) => console.log('  ' + e));
await browser.close();
EOF
# --input-type=module + stdin, run from the repo root: Node resolves bare
# imports (`@playwright/test`) against the CWD's node_modules, not the
# script's own (temp-dir) location — a plain `node "$VERIFY_DIR/…mjs"` would
# throw ERR_MODULE_NOT_FOUND instead.
# `export` (not a bare prefix assignment) so VERIFY_SCREENSHOT survives as a
# shell variable for the cygpath calls below, not just inside node's own env.
export VERIFY_SCREENSHOT="$VERIFY_DIR/verify-screenshot.png"
node --input-type=module < "$VERIFY_DIR/verify-drive.mjs"
# Print the ABSOLUTE WINDOWS paths now, in THIS shell. Each Bash tool call is
# a fresh shell — $VERIFY_DIR will be GONE by the next step, so this is the
# only chance to hand the path forward. Print, don't rely on the variable.
echo "VERIFY_DIR_WIN=$(cygpath -w "$VERIFY_DIR")"
echo "VERIFY_SCREENSHOT_WIN=$(cygpath -w "$VERIFY_SCREENSHOT")"
```

Then **Read the `VERIFY_SCREENSHOT_WIN` path printed above** — e.g.
`C:\Users\...\AppData\Local\Temp\tmp.XXXXXXXXXX\verify-screenshot.png` — and
LOOK at it. Use that Windows-style path, not the Git-Bash POSIX form
(`/tmp/tmp.XXXXXXXXXX/verify-screenshot.png`): the POSIX form resolves fine
*inside* Git Bash itself, but the Read tool runs outside Git Bash and measures
it as "File does not exist" — only the `cygpath -w` output works there.

**What a healthy run looks like** (this is the regression net for the plan-167 stack):
- Heading renders (`Welcome back, Mike` on `#/`, or the view's heading) — proves
  **redux-persist rehydrated** (the Rolldown CJS-interop bug made `storage.getItem`
  undefined and broke boot; fixed by importing `redux-persist/es/storage`).
- Clicking a nav tab moves `NAV_URL` to `#/voices` etc. — proves **hash-router
  navigation** works (react-router 6 dropped `navigate()` from effects under
  React 19; react-router 7 fixed it).
- `ERRORS=0`.
- The footer reads `<version> · <gitSha> · <branch> · <time>` — confirm the
  `gitSha` matches the commit you expect (catches a stale, never-restarted process).

A blank frame, a missing heading, a `storage.getItem is not a function` console
error, or a `NAV_URL` that never leaves `#/` = a failed verify. Look at the
screenshot — don't trust the exit code alone.

## STEP 3 — clean up

```bash
# stop a stray Vite holding :5173 (PowerShell — taskkill on the bash PID misses the node child)
# Get-NetTCPConnection -LocalPort 5173 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }

# This is a FRESH shell — $VERIFY_DIR from STEP 2 is unset here. Paste the
# VERIFY_DIR_WIN value STEP 2 printed (the directory, not the screenshot):
VERIFY_DIR_WIN="C:\Users\...\AppData\Local\Temp\tmp.XXXXXXXXXX"   # <- paste STEP 2's printed VERIFY_DIR_WIN
if [ -z "$VERIFY_DIR_WIN" ]; then
  echo "VERIFY_DIR_WIN is empty -- refusing to rm -rf" >&2
else
  rm -rf "$VERIFY_DIR_WIN"   # unconditional once non-empty — a failed run (the case you're cleaning up FOR) must not skip this
fi
```
