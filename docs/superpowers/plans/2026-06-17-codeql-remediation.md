# CodeQL Alert Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive GitHub code-scanning (CodeQL) from 146 open alerts to ~0 by writing real defensive code (path containment, rate limiting, generic sidecar errors, URL guards) plus a bounded, justified dismissal set — and fold in the same-class `srv-22` write-probe hardening.

**Architecture:** Three code scopes — A (server), B (sidecar), C (frontend) — are non-overlapping **across** scopes, so B and C run in their own worktrees/branches in parallel with A. **Scope A is internally SEQUENTIAL** (A1 creates `safe-path.ts`, which A2–A6 import; **A3/A5** both edit `paths.ts`, **A9/A10** both edit `voice-sample-cache.ts`, **A3/A11/A12** all edit `epub.ts`). A sequential Scope D (integrator-only) adds the CodeQL config, updates docs, and runs the merge→scan→dismiss→confirm sequence. CodeQL JS barriers are in-CFG branching guards that dominate the sink **in the same function** — so every path-containment guard is applied at the `fs` sink site, never buried in a returning helper.

**Branch topology (for subagent execution):** each scope commits to its own branch off `main`, reconciled by D3 — **A → `fix/server-codeql`**, **B → `fix/sidecar-codeql`**, **C → `fix/frontend-codeql`**; Scope D commits onto the **`integration/2026-06-18-codeql`** branch (created in Setup). Each branch lives in its own git worktree (junction `node_modules` for root + `server/` before running anything). **Task A6 is an integrator/judgment task** (an audit, not a mechanical edit) — run it from the orchestrating session on the Scope-A branch, not as a blind task subagent.

**Execution model:** run **Scope A inline in the main (orchestrating) session** (A is sequential and A6 requires inline judgment); **dispatch B and C as two concurrent worktree subagents** at the start (`isolation: "worktree"`, per the project's parallel-agent convention); reconcile all three in D3. Do the **Setup** block below before anything else.

## Setup (do first)

- [ ] Create the four worktrees + branches off the latest `main`, and junction `node_modules` (root + `server/`) into each (PowerShell `New-Item -ItemType Junction`, the project pattern — git-bash `mklink` does not apply):
  - `git worktree add -b fix/server-codeql <path>/codeql-server main` (Scope A, driven inline)
  - `git worktree add -b fix/sidecar-codeql <path>/codeql-sidecar main` (Scope B subagent)
  - `git worktree add -b fix/frontend-codeql <path>/codeql-frontend main` (Scope C subagent)
  - `git worktree add -b integration/2026-06-18-codeql <path>/codeql-integration main` (Scope D; D1/D2/D3 all commit here)

  (All four are **new** branches, so each needs `-b <branch> <path> main` — `git worktree add <path> <branch>` without `-b` fails with `invalid reference` for a branch that doesn't exist yet.)
- [ ] In each worktree, junction `node_modules` and `server/node_modules` from the primary checkout so `vitest`/`tsc`/`verify` resolve. (Sidecar worktree also needs the sidecar venv reachable for `npm run test:sidecar` — it falls back to a SKIP banner if absent.)

**Tech Stack:** Node 20 / TypeScript / Express 5.2.1, Vitest 4, Python 3.12 / FastAPI / pytest, React 18, GitHub CodeQL (`build-mode: none`), `express-rate-limit` v7.

**Source spec:** `docs/superpowers/specs/2026-06-17-codeql-remediation-design.md` (read it first).

## Global Constraints

- **CodeQL barrier shape (load-bearing):** in the sink's own function — `const resolved = path.resolve(ROOT, seg); const rel = path.relative(ROOT, resolved); if (rel.startsWith('..') || path.isAbsolute(rel)) throw …`. Use the **raw** `path.relative` return; never refactor into a boolean-returning cross-function helper.
- **`safeSegment` is a Unicode deny-list, never an ASCII allowlist** — allow `\p{L}\p{N}`, `-`, single `_`, `__`, `.` mid-name. Reject only separators, NUL, `.`/`..`, absolute/drive.
- **No `rejectUnauthorized:false` and no `NODE_TLS_REJECT_UNAUTHORIZED` anywhere.**
- **Sidecar error responses reference the exception object zero times** (no `str(e)`, `repr(e)`, `type(e).__name__`, `e.args`); log it server-side only.
- **Unit tests cannot prove a CodeQL alert clears** — they prove behavior. The alert-clearing gate is the **post-merge re-scan in Task D3**. Several fixes here (loop-bound clamps, the `path.relative` shape, replace-until-stable) are CodeQL-*shape* fixes whose unit tests assert behavior/stability, not alert state. That is expected; D3 is the real gate.
- **Commit convention** (husky `commit-msg`): `<type>(<scope>): <subject>`; allowed scopes: `frontend | server | sidecar | app | scripts | e2e | mocks | openapi | docs | deps | ci`. **Every commit body MUST end with** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` — use `git commit -F -` with a heredoc, not `-m`, so the trailer is included.
- **Pre-commit gate is scope-granular, not file-granular:** staging any `server/src/**` file makes the pre-commit hook run the **entire** `npm run test:server` battery (not just the changed file). So each task's commit must leave the *whole* server suite green. `test:server-slow` (which holds `gemini.test.ts`) is **not** in pre-commit — A12's paired test only gates at pre-push; run it manually before committing A12.
- **Worktree setup:** B/C and the Scope-D integration worktree each need `node_modules` linked (PowerShell junction for root + `server/`, per the project pattern) before `vitest`/`tsc`/`verify` will run.
- **Verify before merge:** `npm run verify` green on the integration branch.

---

## File structure

| File | Responsibility | Scope/Task |
|---|---|---|
| `server/src/util/safe-path.ts` (+`.test.ts`) | `safeSegment` / `assertContained` / `safeJoin` | A1 |
| `server/src/routes/samples.ts`, `store/analysis-cache.ts` | id-sink guards (highest value, tested) | A2 |
| `server/src/routes/qwen-voice.ts`, `workspace/paths.ts`, `routes/book-state.ts`, `parsers/epub.ts` | remaining id-sink guards (tested) | A3 |
| `server/src/analyzer/ollama.ts`, `analyzer/gemini.ts`, `handoff/protocol.ts` | analyzer-write guards | A4 |
| `server/src/workspace/paths.ts` (`bookDirByDisplay`) | display-string sanitizer at the chokepoint | A5 |
| `server/src/workspace/{state-io,atomic-rename}.ts`, `cover/store.ts` + `docs/security/codeql-dismissal-residue.md` (new) | composed-path call-boundary asserts + residue record | A6 |
| `server/src/middleware/rate-limit.ts` (+`.test.ts`), `server/src/index.ts` | global limiter (test-skipped) | A7 |
| `server/src/routes/queue.ts`, `routes/voice-style.ts` | `%s` log args | A8 |
| `server/src/tts/voice-mapping.ts`, `tts/voice-sample-cache.ts` | loop clamps | A9 |
| `server/src/util/text-match.ts`, `tts/voice-sample-cache.ts`, `parsers/text.ts` | ReDoS rewrites | A10 |
| `server/src/parsers/html-utils.ts`, `parsers/epub.ts`, `scripts/bump-version.mjs` | replace-until-stable | A11 |
| `server/src/parsers/epub.ts` (`decodeEntities`) | double-escape order | A12 |
| `server/src/analyzer/gemini.ts` | stream-accumulator cap | A13 |
| `scripts/start-app-prod.mjs` | cert rootCA probe (inline CA lookup) | A14 |
| `server/src/routes/user-settings.ts` | srv-22 `lstat`-first | A15 |
| `server/tts-sidecar/main.py` (+ `tests/test_error_responses.py`) | generic error helper (all shapes) | B1 |
| `src/lib/safe-url.ts` (+`.test.ts`), 5 img sites, `components/mini-player.tsx` | URL guard + crypto id | C1, C2 |
| `.github/codeql/codeql-config.yml` (new), `.github/workflows/codeql.yml`, `docs/security/2026-05-31-security-review.md`, `docs/features/INDEX.md` | config + docs | D1, D2 |
| (process) | reconcile, re-scan, dismiss, confirm | D3 |

---

# Scope A — Server (SEQUENTIAL: A1 → A2 → … → A15, single worktree)

### Task A1: `safe-path.ts` containment utility

**Files:** Create `server/src/util/safe-path.ts`, `server/src/util/safe-path.test.ts`
**Interfaces — Produces:** `class PathContainmentError extends Error`; `safeSegment(seg: string): string`; `assertContained(root: string, resolved: string): void`; `safeJoin(root: string, ...segments: string[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/util/safe-path.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { safeSegment, assertContained, safeJoin, PathContainmentError } from './safe-path.js';

describe('safeSegment', () => {
  it('accepts Unicode letters/numbers and allowed punctuation', () => {
    for (const ok of [
      'война__standalones__война', 'qwen-война__angry-preview',
      'mns_aB3_xY', 'a__b__c', 'cover.jpg', '.audiobook',
    ]) expect(safeSegment(ok)).toBe(ok);
  });
  it('rejects separators, NUL, dot-segments and absolute/drive paths', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\x00b', '/etc', 'C:\\x'])
      expect(() => safeSegment(bad)).toThrow(PathContainmentError);
  });
});

describe('assertContained / safeJoin', () => {
  const root = path.resolve('/srv/workspace');
  it('accepts a contained path', () => {
    expect(() => assertContained(root, path.join(root, 'books', 'x.json'))).not.toThrow();
    expect(safeJoin(root, 'books', 'x.json')).toBe(path.join(root, 'books', 'x.json'));
  });
  it('rejects an escaping path', () => {
    expect(() => assertContained(root, path.resolve(root, '..', 'evil'))).toThrow(PathContainmentError);
    expect(() => safeJoin(root, '..', 'evil')).toThrow(PathContainmentError);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/util/safe-path.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/util/safe-path.ts
import path from 'node:path';

export class PathContainmentError extends Error {
  constructor(message: string) { super(message); this.name = 'PathContainmentError'; }
}

/* Deny-list, NOT an allowlist: a safe segment may contain any Unicode
   letter/number plus `-`, `_`, `.` mid-name (plan-219 Cyrillic + nanoid ids
   survive). The load-bearing check is assertContained; this is a pre-filter. */
export function safeSegment(seg: string): string {
  if (seg === '' || seg === '.' || seg === '..')
    throw new PathContainmentError(`Unsafe path segment: "${seg}"`);
  if (/[/\\\x00]/.test(seg))                      // separators or NUL
    throw new PathContainmentError(`Path segment contains a separator or NUL`);
  if (path.isAbsolute(seg) || /^[A-Za-z]:/.test(seg))
    throw new PathContainmentError(`Path segment is absolute: "${seg}"`);
  return seg;
}

/** Throw unless `resolved` is inside `root`. CodeQL-recognized barrier
    (RelativePathStartsWithSanitizer) — keep the raw relative string. */
export function assertContained(root: string, resolved: string): void {
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new PathContainmentError(`Path escapes root: ${resolved}`);
}

export function safeJoin(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments.map(safeSegment));
  assertContained(root, resolved);
  return resolved;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run src/util/safe-path.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/util/safe-path.ts server/src/util/safe-path.test.ts
git commit -F - <<'EOF'
feat(server): add safe-path containment utility

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A2: Containment at the two highest-value id sinks (samples, analysis-cache)

**Files:** Modify `server/src/routes/samples.ts`, `server/src/store/analysis-cache.ts`; tests in `server/src/routes/samples.test.ts` (extend) + `server/src/store/analysis-cache.test.ts` (create).
**Interfaces — Consumes:** `safeSegment` from A1.

The samples route wraps its body in a `try/catch` that returns **500**, and an `existsSync→404` precheck runs first — so the guard must be an explicit 400 **before** the precheck. `cachePath` is currently **not exported**.

- [ ] **Step 1: Write failing tests**

```ts
// server/src/routes/samples.test.ts (extend the existing file; it builds `app` inline already)
it('rejects a traversal slug with 400 before the existsSync precheck', async () => {
  const res = await request(app).post('/api/samples/..%2f..%2fevil/load');
  expect(res.status).toBe(400);
});
```

```ts
// server/src/store/analysis-cache.test.ts (create; pure unit, no app)
import { describe, it, expect } from 'vitest';
import { cachePath } from './analysis-cache.js';
describe('cachePath', () => {
  it('throws on a traversal manuscriptId', () => {
    expect(() => cachePath('../../evil')).toThrow();
  });
  it('accepts a normal nanoid manuscriptId', () => {
    expect(() => cachePath('mns_aB3_xY')).not.toThrow();
  });
});
```

> Reuse the inline-`express()` harness already at the top of `samples.test.ts` (the repo has **no** shared `test-utils/app`). If the existing file names the app differently, match it.
>
> **On the 400 assertion:** Express 5.2.1 captures `..%2f..%2fevil` as a single `:slug` and decodes `req.params.slug` to `../../evil` → `safeSegment` throws → the explicit 400 fires. The decode-then-reject behavior of `safeSegment` itself is **authoritatively** covered by `safe-path.test.ts` (A1). If a future Express change routes the encoded slug to a 404 instead, the guard is still correct — do **not** "fix" it; assert the guard by calling the handler with a pre-decoded `slug` (`../../evil`) instead.

- [ ] **Step 2: Run to verify they fail** — `cd server && npx vitest run src/routes/samples.test.ts src/store/analysis-cache.test.ts` → FAIL (cachePath not exported → TypeError; samples returns 404/500 not 400).

- [ ] **Step 3: Apply the guards**

- `samples.ts` — right after `const slug = req.params.slug;` (inside the handler, before the `existsSync` precheck) add an explicit 400 guard, and guard the bundle filename before its copy:
  ```ts
  try { safeSegment(slug); } catch { return res.status(400).json({ error: 'Invalid sample slug.' }); }
  ```
  Then, after `const { author, series, title, manuscriptFile } = bundleState;`, before `copyFile(join(src, manuscriptFile), …)`:
  ```ts
  try { safeSegment(manuscriptFile); } catch { return res.status(400).json({ error: 'Invalid bundle manuscript file.' }); }
  ```
  Import `safeSegment` from `'../util/safe-path.js'`.
- `analysis-cache.ts` — add `export` to `function cachePath(manuscriptId: string)` and make its first line `safeSegment(manuscriptId);` (import from `'../util/safe-path.js'`). Note this sink's root is the handoff cache dir, not `WORKSPACE_ROOT` — `safeSegment` on the id is the correct guard (no `assertContained` needed for a single fixed-root join).

- [ ] **Step 4: Run to verify they pass** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/samples.ts server/src/store/analysis-cache.ts server/src/routes/samples.test.ts server/src/store/analysis-cache.test.ts
git commit -F - <<'EOF'
fix(server): contain samples slug and analysis-cache id against traversal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A3: Containment at the remaining id sinks (qwen-voice, paths, book-state, epub upload)

**Files:** Modify `server/src/routes/qwen-voice.ts` (`qwenVoicePtPath`, `:183`), `server/src/workspace/paths.ts` (`qwenVoiceSidecarPath`), `server/src/routes/book-state.ts` (`:999-1001`), `server/src/parsers/epub.ts` (`:61`); tests in `server/src/parsers/epub.test.ts` (extend) + a unit test for the qwen path fn.
**Interfaces — Consumes:** `safeSegment` from A1.

- [ ] **Step 1: Write failing tests**

```ts
// server/src/parsers/epub.test.ts (add — exercises the upload-filename basename guard)
it('basenames + rejects a traversal upload filename', async () => {
  // call the epub parse entry with opts.fileName = '../../evil.epub' and assert it does not
  // write outside the temp dir — match the file's existing parse-call signature.
});
```

> `qwenVoicePtPath` is a **local** function in `routes/qwen-voice.ts:183` (NOT in paths.ts). If it isn't exported, add a tiny exported wrapper or test it via the route; otherwise add `export` and a unit test:
```ts
// server/src/routes/qwen-voice.test.ts (create or extend)
import { qwenVoicePtPath } from './qwen-voice.js'; // export it
it('rejects a poisoned voice name', () => {
  expect(() => qwenVoicePtPath('../../evil')).toThrow();
});
```

- [ ] **Step 2: Run to verify they fail** — `cd server && npx vitest run src/parsers/epub.test.ts src/routes/qwen-voice.test.ts` → FAIL.

- [ ] **Step 3: Apply the guards**

- `qwen-voice.ts:183` `qwenVoicePtPath(name)` — first line `safeSegment(name);` (export the fn for the test). Do the same inside `qwenVoiceSidecarPath(name)` in `paths.ts`.
- `book-state.ts` — before `unlink(join(bookDir, oldFile))` (~`:1001`) **and** before the manuscript `writeFile(join(bookDir, newFile))` (~`:999`), add `safeSegment(oldFile);` / `safeSegment(newFile);` (`oldFile` is `state.manuscriptFile`, persisted/bundle-derived; `newFile` is a literal but guarding is cheap and consistent).
- `epub.ts:61` — `epub.ts` currently imports only `{ join }` from `node:path`, so **add `basename` to that import** (`import { join, basename } from 'node:path'`). Change `opts.fileName ?? 'book.epub'` to `basename(opts.fileName ?? 'book.epub')`, and add `safeSegment(basename(opts.fileName ?? 'book.epub'));` before the `writeFile`.

- [ ] **Step 4: Run to verify they pass + the slow-tier book-state suite** — `cd server && npx vitest run src/parsers/epub.test.ts src/routes/qwen-voice.test.ts && npm run test:server-slow` → PASS. (`book-state.test.ts` is **slow-tier**, excluded from pre-commit `test:server` — a source edit that breaks it would otherwise only surface at pre-push.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts server/src/workspace/paths.ts server/src/routes/book-state.ts server/src/parsers/epub.ts server/src/parsers/epub.test.ts
git commit -F - <<'EOF'
fix(server): contain qwen-voice, book-state and epub-upload path sinks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A4: Containment at analyzer-write sinks (in the sink functions)

**Files:** Modify `server/src/analyzer/ollama.ts` (`:353`, `:406`), `server/src/analyzer/gemini.ts` (the `rawAttemptPath(...)` write), `server/src/handoff/protocol.ts` (`writeInbox`, `:56-70`); test `server/src/handoff/protocol.test.ts` (create).
**Interfaces — Consumes:** `safeSegment` from A1. `writeInbox(manuscriptId: string, key: HandoffKey, body: string)` — `HandoffKey` is a string union (`'1' | …`), so test args use **`'1'`**, not `1`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/handoff/protocol.test.ts (create)
import { describe, it, expect } from 'vitest';
import { writeInbox } from './protocol.js';
describe('writeInbox', () => {
  it('rejects a traversal manuscriptId before writing', async () => {
    await expect(writeInbox('../../evil', '1', 'payload')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/handoff/protocol.test.ts` → FAIL.

- [ ] **Step 3: Add the guards in the sink functions**

In `protocol.ts` `writeInbox` first line: `safeSegment(manuscriptId);`. Then guard `manuscriptId` immediately before each analyzer write, **in that function**:
- `ollama.ts` — both `writeFile` sites (~`:353`, `:406`).
- `gemini.ts` — before the `errorPath(manuscriptId, key)` writes (`:272-273`, `:299-300`) **and** the `outboxPath(manuscriptId, key)` write (`:1164`). (There is **no** `rawAttemptPath` in gemini.ts — that helper is sunk in ollama.ts.)

`manuscriptId` is the in-scope variable name in all of these (confirmed). Import `safeSegment` at the correct relative depth in each file.

- [ ] **Step 4: Run to verify it passes + the slow-tier gemini suite** — `cd server && npx vitest run src/handoff/protocol.test.ts && npm run test:server-slow` → PASS. (`gemini.test.ts` is **slow-tier**; a `gemini.ts` source edit that breaks it would otherwise only surface at pre-push.)

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/handoff/protocol.ts server/src/handoff/protocol.test.ts
git commit -F - <<'EOF'
fix(server): contain analyzer handoff write sinks in their own functions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A5: `bookDirByDisplay` sanitizer (inside the builder chokepoint)

**Files:** Modify `server/src/workspace/paths.ts` (`bookDirByDisplay`, `:92`); test `server/src/workspace/paths.test.ts` (extend/create).
**Interfaces — Consumes:** `assertContained` from A1.

The sanitizer must live **inside** `bookDirByDisplay` (scan/samples/find all call it; sanitizing elsewhere would un-find books). It must **not** corrupt normal names — only strip path-hostile characters, **never** spaces or hyphens.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/workspace/paths.test.ts (add)
import path from 'node:path';
import { bookDirByDisplay, BOOKS_ROOT } from './paths.js'; // BOOKS_ROOT is an exported const (string), not a fn
it('sanitizes traversal to a contained folder', () => {
  const dir = bookDirByDisplay('..\\..\\evil', 'Series', 'Title');
  expect(path.relative(BOOKS_ROOT, dir).startsWith('..')).toBe(false);
});
it('preserves spaces and hyphens in normal display names', () => {
  const dir = bookDirByDisplay('Jane Doe', 'Sci-Fi', 'The Fall');
  const parts = path.relative(BOOKS_ROOT, dir).split(path.sep);
  expect(parts).toEqual(['Jane Doe', 'Sci-Fi', 'The Fall']);
});
it('never collapses a level when a field sanitizes to empty', () => {
  const dir = bookDirByDisplay('...', 'Series', 'Title');
  expect(path.relative(BOOKS_ROOT, dir).split(path.sep).length).toBe(3);
});
```

> `BOOKS_ROOT` (`paths.ts:33`) and `STANDALONES_SERIES` (`paths.ts:73`) are the real exported names — both verified.

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/workspace/paths.test.ts` → FAIL.

- [ ] **Step 3: Implement the sanitizer inside `bookDirByDisplay`**

```ts
function sanitizeDisplaySegment(s: string): string {
  const cleaned = s
    .replace(/[/\\:*?"<>|\x00]/g, '_') // path-hostile chars ONLY — keep spaces & hyphens
    .replace(/\.{2,}/g, '_')           // collapse any `..` run
    .replace(/[. ]+$/g, '')            // Windows: no trailing dot/space
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : '_'; // never a level-collapsing empty segment
}
```

Apply to each field, then assert containment before returning:
```ts
const dir = join(BOOKS_ROOT,
  sanitizeDisplaySegment(author),
  sanitizeDisplaySegment(series || STANDALONES_SERIES),
  sanitizeDisplaySegment(title));
assertContained(BOOKS_ROOT, dir);
return dir;
```
(Use the file's actual `BOOKS_ROOT` / standalones identifiers.)

- [ ] **Step 4: Run to verify it passes + the cross-directory callers (round-trip)** — `cd server && npx vitest run src/workspace && npm run test:server` → PASS. (`bookDirByDisplay` is called by `scan.ts`/`samples.ts`/`findBookBy…`/import; the new `assertContained` throws on escape, so run the full server suite to catch any caller that fed a weird display name expecting a path back, not a throw.)

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/paths.ts server/src/workspace/paths.test.ts
git commit -F - <<'EOF'
fix(server): sanitize bookDirByDisplay at the path chokepoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A6: Composed-path call-boundary asserts + residue record

**Files:** Modify the routes that compose paths into `workspace/state-io.ts` / `workspace/atomic-rename.ts` / `cover/store.ts` where a single-function call boundary exists; Create `docs/security/codeql-dismissal-residue.md` (this task OWNS the file; later tasks only append).

**Integrator/judgment task — run from the orchestrating session on the `fix/server-codeql` branch, not as a blind task subagent** (the audit half requires tracing data flow and deciding guard-vs-dismiss per sink). This task has an audit half (reasoning) and an apply half (mechanical).

- [ ] **Step 1: Audit (reasoning)** — for each `writeFile`/`rename`/`download` in `state-io.ts`, `atomic-rename.ts`, `cover/store.ts`, trace the path to the composing route. Classify each sink: **(G) guardable** = the route composes the path from an id in one function → add `assertContained(WORKSPACE_ROOT, composedPath)` there; **(D) dismiss** = path built from a slugged/contained id with no single-function boundary. Write the classification into the residue doc (Step 3).

- [ ] **Step 2: Apply guards to the (G) sinks + paired tests**

For each (G) sink, add `assertContained(WORKSPACE_ROOT, composedPath)` at the route, and a traversal-rejection test mirroring A2's style (inline-`express()` harness, assert 400/throw). Run: `cd server && npx vitest run src/workspace src/cover` → PASS.

- [ ] **Step 3: Write the residue doc**

```md
<!-- docs/security/codeql-dismissal-residue.md -->
# CodeQL path-injection composed-path residue (for dismissal)

Sinks composed from already-contained/slugged inputs, with no single-function
call boundary to host an in-CFG containment guard. Dismissed in Task D3.

| file:line | rule | justification |
|---|---|---|
| … | js/path-injection | composed from slugged bookId; voiceSampleFilePath is safe via its `-<modelKey>-<hash>.mp3` suffix (not asciiFileScope); auto-backup gated by findBookByBookId + STAMP_RE — never exploitable |
```

(Record the **correct** justification per the spec — do NOT credit `asciiFileScope` for `voiceSampleFilePath`'s safety; it is the filename suffix. Bound the total at ≤ ~6.)

- [ ] **Step 4: Commit** (enumerate files — never `git add server/src`)

```bash
git add server/src/workspace/state-io.ts server/src/workspace/atomic-rename.ts server/src/cover/store.ts docs/security/codeql-dismissal-residue.md <the route files + tests you touched>
git commit -F - <<'EOF'
fix(server): assert containment at composed-path call boundaries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A7: Rate-limit middleware (unconditional mount, test-skipped runtime)

**Files:** Create `server/src/middleware/rate-limit.ts`, `server/src/middleware/rate-limit.test.ts`; Modify `server/package.json` (+`express-rate-limit`), `server/src/index.ts` (mount after body parsers).
**Interfaces — Produces:** `makeApiLimiter(overrides?): RequestHandler`; `apiLimiter: RequestHandler`.

CodeQL credits a route only if the limiter middleware **unconditionally** dominates it — so mount it unconditionally and disable it at runtime under test via `skip` (a runtime `skip` does NOT un-credit the route). This keeps the full server suite green (otherwise bursty/header-asserting tests break) while clearing the alerts.

- [ ] **Step 1: Add the dependency** — `cd server && npm install express-rate-limit@^7` → present in `server/package.json`.

- [ ] **Step 2: Write the failing test**

```ts
// server/src/middleware/rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeApiLimiter } from './rate-limit.js';

function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('makeApiLimiter', () => {
  it('passes under cap with standard headers', async () => {
    const res = await request(appWith(makeApiLimiter({ skip: () => false }))).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });
  it('429s past the cap', async () => {
    const app = appWith(makeApiLimiter({ max: 1, skip: () => false }));
    await request(app).get('/ping');
    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `cd server && npx vitest run src/middleware/rate-limit.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// server/src/middleware/rate-limit.ts
import rateLimit, { type Options } from 'express-rate-limit';

/* Anti-DoS + scanner-clearing only — NOT an auth control (single-user, no-auth
   by design). 1000/min sits far above the app's worst legitimate burst. Skipped
   under test so the server suite's request bursts/header asserts stay green; the
   mount is still unconditional so CodeQL credits route dominance. */
export function makeApiLimiter(overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 60_000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !!process.env.VITEST, // Vitest sets VITEST=true; it does NOT set NODE_ENV='test' in this repo
    ...overrides,
  });
}

export const apiLimiter = makeApiLimiter();
```

- [ ] **Step 5: Mount unconditionally, after the body parsers, before `/audio`**

In `server/src/index.ts`, immediately after line 126 (`app.use(express.urlencoded(...))`) and before line 131 (`app.use('/audio', …)`):

```ts
import { apiLimiter } from './middleware/rate-limit.js';
app.use(apiLimiter);
```

This dominates `/audio`, `/api/pair`, `/workspace`, `/api/health`, and every router below.

- [ ] **Step 6: Run tests + the full server suite + typecheck** — `cd server && npx vitest run src/middleware/rate-limit.test.ts && npm run typecheck && npm run test:server` → PASS (no existing suite regresses; the runtime `skip` keeps them unthrottled).

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/middleware/rate-limit.ts server/src/middleware/rate-limit.test.ts server/src/index.ts
git commit -F - <<'EOF'
feat(server): add global API rate limiter (unconditional mount, test-skipped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A8: Tainted format strings → `%s`

**Files:** Modify `server/src/routes/queue.ts` (`:125`), `server/src/routes/voice-style.ts` (`:119`); test `server/src/routes/queue.test.ts` (extend).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/routes/queue.test.ts (add)
import { vi, it, expect } from 'vitest';
it('logs the engine-stamp failure with the id as a %s arg, not interpolated', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // …trigger the catch path through the existing harness with a known id…
  expect(warn).toHaveBeenCalledWith('[queue] engine-stamp failed for "%s"', expect.any(String), expect.anything());
  warn.mockRestore();
});
```

> If the catch path is awkward to reach in a unit test, extract the log into a one-line `logStampFailure(id, e)` and unit-test its call shape — that is the deterministic path; prefer it over trying to force the catch.

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/routes/queue.test.ts` → FAIL.

- [ ] **Step 3: Apply**
- `queue.ts:125`: `console.warn('[queue] engine-stamp failed for "%s"', input.id, e);`
- `voice-style.ts:119`: `console.error('[voice-style] book=%s character=%s failed', bookId, c.id, e);`

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/queue.ts server/src/routes/voice-style.ts server/src/routes/queue.test.ts
git commit -F - <<'EOF'
fix(server): pass tainted log values as %s args

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A9: Loop-bound clamps

**Files:** Modify `server/src/tts/voice-mapping.ts` (`stableHash`, loop `:459`), `server/src/tts/voice-sample-cache.ts` (`djb2`, `:82`); test `server/src/tts/voice-sample-cache.test.ts` (extend).

> Do **not** touch `parsers/audio-tags.ts:58` — dismissal budget. This is a CodeQL-shape fix; the unit test asserts stable hashing on short ids (the clamp at 4096 never affects a real id). Alert-clearing is gated by D3's re-scan.

- [ ] **Step 1: Write the test (characterization — real ids unchanged)**

```ts
// server/src/tts/voice-sample-cache.test.ts (add)
import { djb2 } from './voice-sample-cache.js';
it('djb2 is stable for realistic ids', () => {
  expect(djb2('qwen-wren__angry')).toBe(djb2('qwen-wren__angry'));
  expect(typeof djb2('x')).toBe('number');
});
```

- [ ] **Step 2: Run** — `cd server && npx vitest run src/tts/voice-sample-cache.test.ts` → PASS (documents current behavior; the clamp must preserve it for short ids).

- [ ] **Step 3: Clamp the loop bound to a constant in both functions**

`djb2`: `const n = Math.min(s.length, 4096); for (let i = 0; i < n; i++) …`. `voice-mapping.ts:459` `stableHash`: identically cap with `Math.min(len, 4096)`. (Ids are short; 4096 never truncates one but makes the loop bound constant, breaking the taint flow CodeQL flags.)

- [ ] **Step 4: Run** — same command → PASS (short-id hashes unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/voice-mapping.ts server/src/tts/voice-sample-cache.ts server/src/tts/voice-sample-cache.test.ts
git commit -F - <<'EOF'
fix(server): clamp short-hash loop bounds to a constant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A10: ReDoS rewrites

**Files:** Modify `server/src/util/text-match.ts` (`normaliseForMatch`, `:13`), `server/src/tts/voice-sample-cache.ts` (`stripQuoteMarks`, `:57`), `server/src/parsers/text.ts` (`FILENAME_RE` `:140`, `SERIES_FROM_TITLE_RE` `:184`); tests in `server/src/parsers/text.test.ts` + `server/src/util/text-match.test.ts`. The filename parser is `parseFilenameMetadata` (NOT `parseFromFileName`); `parseSeriesFromTitle` is the other.

- [ ] **Step 1: Characterization tests (pin current parse behavior first)**

```ts
// server/src/parsers/text.test.ts (add — run GREEN against the current regexes)
import { parseFilenameMetadata, parseSeriesFromTitle } from './text.js';
it('parseFilenameMetadata characterization', () => {
  expect(parseFilenameMetadata('Jane Doe - Neverseen 2 - The Fall.epub'))
    .toEqual({ author: 'Jane Doe', series: 'Neverseen', seriesPosition: 2, title: 'The Fall' });
});
it('parseSeriesFromTitle characterization', () => {
  expect(parseSeriesFromTitle('The Fall (Neverseen Book 2)'))
    .toEqual({ title: 'The Fall', series: 'Neverseen', seriesPosition: 2 });
});
```

- [ ] **Step 2: Rewrite the cleanly-linearizable trims**
- `text-match.ts:13` — split the two-sided alternation: `.replace(/^[\s"'`]+/, '').replace(/[\s"'`]+$/, '')`.
- `voice-sample-cache.ts:57` `stripQuoteMarks`: `return s.replace(/^[“”"'‘’\s]+/, '').replace(/[“”"'‘’\s]+$/, '').trim();`.

- [ ] **Step 3: Attempt to linearize `FILENAME_RE`/`SERIES_FROM_TITLE_RE`; if characterization breaks, revert + dismiss**

Try replacing the adjacent lazy `.+?` groups with delimiter-anchored negated classes. Re-run Step 1's tests. **If green:** keep. **If red** (likely — authors/titles contain `-`): **revert the regex change** and append `parsers/text.ts:140` (+`:184`) to `docs/security/codeql-dismissal-residue.md` with justification: "filename-stem input, server-side, not attacker-streamed; no linear rewrite preserves parse identity." (This fork is deterministic — gated by the characterization tests.)

- [ ] **Step 4: Run** — `cd server && npx vitest run src/parsers/text.test.ts src/util/text-match.test.ts src/tts/voice-sample-cache.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
# Stage the residue doc ONLY if Step 3 took the dismiss branch (reverted FILENAME_RE + appended a row).
git add server/src/util/text-match.ts server/src/tts/voice-sample-cache.ts server/src/parsers/text.ts server/src/parsers/text.test.ts server/src/util/text-match.test.ts
# if dismissed: git add docs/security/codeql-dismissal-residue.md
git commit -F - <<'EOF'
fix(server): linearize ReDoS-prone trims; dismiss filename regex if unrewritable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A11: Incomplete sanitization

**Files:** Modify `server/src/parsers/html-utils.ts` (tag strips at `:40` AND `:63` — `incomplete-multi-character-sanitization`), `server/src/parsers/epub.ts` (`htmlBodyOnly` script/style strip, `:356` — `incomplete-multi-character-sanitization`), `scripts/bump-version.mjs` (shell-quote escape, `:206` — `incomplete-sanitization`); test `server/src/parsers/html-utils.test.ts` (extend).

Two distinct fixes: **(a)** the `<…>` tag strips → replace-until-stable; **(b)** the bump-version shell-quote escape → escape backslash **before** quote.

> **Surgical check first:** the only sites the CodeQL inventory definitely flags are `html-utils.ts:40` (`incomplete-multi-character-sanitization`), `epub.ts:356`, and `bump-version.mjs` (`incomplete-sanitization`). The second html-utils strip (`:63`, in `extractFirstHeading`) may **not** be flagged — confirm it appears in the alert list (cross-check the rule/path/line from the inventory `gh api … code-scanning/alerts`) before touching it; if it isn't flagged, leave it (surgical-changes rule) and drop it from this task. (a) is a CodeQL-*shape* fix — the single-pass `<[^>]+>` is flagged regardless of a constructible bypass, so its test asserts behavior is preserved + idempotence, and **D3's re-scan is the alert-clearing gate** (like A9). (b) has a real fail-before.

- [ ] **Step 1: Write the tests**

```ts
// server/src/parsers/html-utils.test.ts (add — behavior-preservation + idempotence)
import { stripHtml } from './html-utils.js';
it('still strips tags and is idempotent', () => {
  const once = stripHtml('<p>a <em>b</em></p>');
  expect(once).not.toMatch(/<[^>]+>/);          // tags removed
  expect(stripHtml(once)).toBe(once);            // fixed point (no second-pass change)
});
```

```js
// scripts test: bump-version's arg-quoting must escape backslashes before quotes.
// If bump-version.mjs has no test harness, assert inline in this task by hand
// (node -e) — the fix is the deterministic gate:
//   `a\"b`  must escape the backslash too, not just the quote.
```

- [ ] **Step 2: Run the html-utils test** — `cd server && npx vitest run src/parsers/html-utils.test.ts` → it documents current behavior (the `<[^>]+>` shape has no constructible fail-before; proceed to add the loop, which the re-scan gates).

- [ ] **Step 3a: Make the tag strips replace-until-stable**

In `html-utils.ts`, replace `.replace(/<[^>]+>/g, '')` (`:40`) — and `.replace(/<[^>]+>/g, ' ')` (`:63`) **only if the surgical check above confirms `:63` is flagged** — with a loop to a fixed point, e.g.:
```ts
function stripTagsStable(s, repl) { let prev; do { prev = s; s = s.replace(/<[^>]+>/g, repl); } while (s !== prev); return s; }
```
and call `stripTagsStable(x, '')` / `stripTagsStable(x, ' ')` at the two sites. Apply the same loop to the `<(script|style)…>` strip at `epub.ts:356`.

- [ ] **Step 3b: Fix the bump-version shell-quote escape**

`scripts/bump-version.mjs:206` is `a.replace(/"/g, '\\"')` — incomplete (a pre-existing `\` isn't escaped). Escape backslashes **first**:
```js
.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : a))
```

- [ ] **Step 4: Run to verify** — `cd server && npx vitest run src/parsers/html-utils.test.ts` → PASS (tags still stripped, idempotent).

- [ ] **Step 5: Commit**

```bash
git add server/src/parsers/html-utils.ts server/src/parsers/epub.ts scripts/bump-version.mjs server/src/parsers/html-utils.test.ts
git commit -F - <<'EOF'
fix(server,scripts): replace-until-stable tag strips + backslash-first shell escape

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A12: Double-escaping in `decodeEntities`

**Files:** Modify `server/src/parsers/epub.ts` (`decodeEntities`, `:486` — add `export`); test `server/src/parsers/epub.test.ts` (extend).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/parsers/epub.test.ts (add)
import { decodeEntities } from './epub.js'; // add `export` to the fn
it('decodes &amp; last so &amp;amp;lt; -> &lt; not <', () => {
  expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  expect(decodeEntities('&amp;amp;lt;')).toBe('&amp;lt;');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/parsers/epub.test.ts` → FAIL (current order decodes `&amp;` second, before `&lt;`).

- [ ] **Step 3: Reorder** — move the `.replace(/&amp;/g, '&')` to be the **final** replacement in `decodeEntities`.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/parsers/epub.ts server/src/parsers/epub.test.ts
git commit -F - <<'EOF'
fix(server): decode &amp; last to avoid double-unescaping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A13: Resource-exhaustion — cap the Gemini stream accumulator

**Files:** Modify `server/src/analyzer/gemini.ts` (`:524` `let buf = ''`, `:559` `buf += text`); test `server/src/analyzer/gemini.test.ts` (slow tier).

> Slow-tier file — **not** in pre-commit. Run its test manually before committing (`cd server && npx vitest run --config vitest.config.slow.ts src/analyzer/gemini.test.ts`); it gates at pre-push.

- [ ] **Step 1: Write the failing test (deterministic seam first)**

**Primary (fast, deterministic):** factor the cap into a tiny exported helper `appendBounded(buf: string, text: string, max = MAX_RESPONSE_BYTES): string` (throws when `buf.length + text.length > max`, else returns `buf + text`), and unit-test it directly — this is a clean in-CFG barrier site and avoids the slow-tier streaming mock:

```ts
// in gemini.test.ts (or a fast sibling) — assert the bound, not the whole stream
import { appendBounded } from './gemini.js';
it('appendBounded throws past the ceiling', () => {
  expect(() => appendBounded('x'.repeat(8 * 1024 * 1024), 'y')).toThrow(/maximum size/);
  expect(appendBounded('a', 'b')).toBe('ab');
});
```

(Only fall back to driving the full SSE mock if you choose not to extract the helper — slower, slow-tier.)

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run --config vitest.config.slow.ts src/analyzer/gemini.test.ts` → FAIL.

- [ ] **Step 3: Add `appendBounded` and use it at the accumulator**

```ts
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function appendBounded(buf: string, text: string, max = MAX_RESPONSE_BYTES): string {
  if (buf.length + text.length > max) throw new Error('Analyzer response exceeded the maximum size.');
  return buf + text;
}
```
Then at `:559` replace `buf += text;` with `buf = appendBounded(buf, text);` (an in-CFG guard dominating the accumulation, in the same function).

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/gemini.ts server/src/analyzer/gemini.test.ts
git commit -F - <<'EOF'
fix(server): cap the Gemini stream accumulator size

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A14: Cert-validation — probe with the mkcert rootCA (inline lookup)

**Files:** Modify `scripts/start-app-prod.mjs` (`probeServed`, `:115-132`).

The script is plain ESM and **cannot import the compiled server module** (its own comment says so). So **replicate** `resolveRootCaPath`'s 3-step lookup inline — do not import from `dist/`. Not unit-testable; verified by D3's re-scan + a manual `start:lan` smoke. **Note:** a `scripts/`-only commit matches no pre-commit test leg, so the commit passes the hook trivially — the manual smoke is the *only* gate; don't read the green commit as verification.

- [ ] **Step 1: Replace the global TLS-disable + fetch with a CA-trusting `node:https` probe**

```js
import https from 'node:https';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Inline mirror of server resolveRootCaPath() — keep in sync with cert-root.ts:
// env MKCERT_CAROOT -> `mkcert -CAROOT` -> per-OS default (honoring LOCALAPPDATA / XDG_DATA_HOME).
function findRootCa() {
  const tryDir = (dir) => (dir && existsSync(path.join(dir, 'rootCA.pem')) ? path.join(dir, 'rootCA.pem') : null);
  if (process.env.MKCERT_CAROOT) { const p = tryDir(process.env.MKCERT_CAROOT); if (p) return p; }
  try { const out = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim(); const p = tryDir(out); if (p) return p; } catch { /* mkcert absent */ }
  let def;
  if (process.platform === 'win32')
    def = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mkcert');
  else if (process.platform === 'darwin')
    def = path.join(os.homedir(), 'Library', 'Application Support', 'mkcert');
  else
    def = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'mkcert');
  return tryDir(def);
}

function probeHttp(scheme, port, agent) {
  const lib = scheme === 'https' ? https : http;
  return new Promise((resolve) => {
    const req = lib.get({ host: 'localhost', port, path: '/api/health', agent, timeout: 4000, servername: 'localhost' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function probeServed(port, useHttps) {
  if (!useHttps) return probeHttp('http', port);
  const ca = findRootCa();
  if (!ca) return probeHttp('http', port);            // mkcert absent -> plain HTTP loopback, never TLS-disable
  const agent = new https.Agent({ ca: readFileSync(ca), rejectUnauthorized: true });
  return probeHttp('https', port, agent);
}
```

**Delete** every `NODE_TLS_REJECT_UNAUTHORIZED` line. (`localhost` is in the cert SAN, so CA-trust validates.)

- [ ] **Step 2: Manual smoke** — `npm run build && npm run start:lan` (separately); confirm the readiness probe reports health over HTTPS with no TLS warning; `grep -rn NODE_TLS_REJECT_UNAUTHORIZED scripts/start-app-prod.mjs` returns nothing. Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add scripts/start-app-prod.mjs
git commit -F - <<'EOF'
fix(scripts): probe LAN health with the mkcert root CA, not a TLS bypass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A15: `srv-22` — `sync-folder/test` `lstat`-first

**Files:** Modify `server/src/routes/user-settings.ts` (`/sync-folder/test`, `:129-153`); test `server/src/routes/user-settings.test.ts` (extend the existing file — it already builds `app` inline at `:48`).

- [ ] **Step 1: Write the failing test (append to the existing suite)**

```ts
// server/src/routes/user-settings.test.ts (add — reuse the file's existing `app`)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
it('refuses to create a non-existent sync folder', async () => {
  const res = await request(app).post('/api/user/settings/sync-folder/test')
    .send({ path: path.join(tmpdir(), 'does-not-exist-xyz', 'deep') });
  expect(res.body).toEqual({ ok: false, code: 'ENOENT' });
});
it('probes an existing dir and leaves no file behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'probe-'));
  const res = await request(app).post('/api/user/settings/sync-folder/test').send({ path: dir });
  expect(res.body.ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/routes/user-settings.test.ts` → FAIL (current code `mkdir`-creates the path).

- [ ] **Step 3: Replace `mkdir(recursive)` with an `lstat`-first guard**

```ts
import { lstat, writeFile, unlink } from 'node:fs/promises';
// …in the handler, replacing the mkdir+writeFile block:
let st;
try { st = await lstat(parsed.path); } catch { return res.json({ ok: false, code: 'ENOENT' }); }
if (!st.isDirectory()) return res.json({ ok: false, code: 'ENOENT' }); // lstat: symlink reports false here
const probePath = join(parsed.path, '.audiobook-write-probe');
try {
  await writeFile(probePath, 'ok');
  await unlink(probePath).catch(() => {});
  return res.json({ ok: true });
} catch (err) {
  await unlink(probePath).catch(() => {});
  return res.json({ ok: false, code: (err as { code?: string }).code, message: (err as Error).message });
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Update plan 79 + commit**

Add a one-line note to `docs/features/archive/79-exports-in-book-folder-and-voice-fixes.md` that the probe now requires an existing folder.

```bash
git add server/src/routes/user-settings.ts server/src/routes/user-settings.test.ts docs/features/archive/79-exports-in-book-folder-and-voice-fixes.md
git commit -F - <<'EOF'
fix(server): sync-folder probe requires an existing dir (srv-22)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

# Scope B — Sidecar (own worktree, parallel with A/C)

### Task B1: Generic error responses (all response shapes)

**Files:** Modify `server/tts-sidecar/main.py`; Create `server/tts-sidecar/tests/test_error_responses.py`.
**Interfaces — Produces:** `def error_response(e: Exception, log, status: int = 500) -> JSONResponse`.

`main.py` has **three** leaking shapes, not one: `{"status":"error","error":str(e)}` (e.g. `:3024,:3047,:3073`), `{"detail": str(e) or repr(e)}` (`:3213`), and `err_str = str(e)` locals fed into responses (`:3328,:3425,:3518`). All must be converted.

- [ ] **Step 1: Write the failing pytest (with the sidecar sys.path bootstrap)**

```python
# server/tts-sidecar/tests/test_error_responses.py
import sys, os, json, logging, re
SIDECAR_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SIDECAR_ROOT not in sys.path:
    sys.path.insert(0, SIDECAR_ROOT)
import main  # noqa: E402

def test_error_response_hides_exception_detail():
    resp = main.error_response(ValueError("secret-path /home/user/x"), logging.getLogger("t"))
    body = json.loads(bytes(resp.body).decode())
    assert "secret-path" not in json.dumps(body)
    assert body["status"] == "error"
    assert body["error"]

def test_no_exception_text_reaches_a_response():
    src = open(os.path.join(SIDECAR_ROOT, "main.py"), encoding="utf-8").read()
    for ln in src.splitlines():
        code = ln.split("#", 1)[0]  # ignore comments
        # (a) no str(e)/repr(e) directly on a response-building line …
        if "JSONResponse" in code or '"error"' in code or '"detail"' in code:
            assert "str(e)" not in code and "repr(e)" not in code, ln
        # (b) … and no `err_str = str(e)` / `= repr(e)` local that later feeds a body
        assert not re.search(r"=\s*(str|repr)\(e\)", code), ln
```

- [ ] **Step 2: Run to verify it fails** — `npm run test:sidecar` (or the venv python `-m pytest …/test_error_responses.py -v`) → FAIL.

- [ ] **Step 3: Add the helper + convert ALL sites**

```python
def error_response(e: Exception, log, status: int = 500):
    log.exception("request failed")            # full traceback server-side only
    return JSONResponse({"status": "error", "error": "Internal error."}, status_code=status)
```

- `{"status":"error","error":str(e)}` sites → `return error_response(e, log, status=…)`.
- `{"detail": str(e) or repr(e)}` (`:3213`) → log `e` and `return JSONResponse({"detail": "Internal error."}, status_code=…)`.
- `err_str = str(e)` locals (`:3328,:3425,:3518`) → remove the `str(e)` from the response; `log.exception(...)` and put a generic constant in the body.

Then confirm: `grep -nE "str\(e\)|repr\(e\)" server/tts-sidecar/main.py` shows none inside a response body (the Step-1 source test enforces this).

- [ ] **Step 4: Run to verify it passes** — `npm run test:sidecar` → PASS (new tests green; existing sidecar tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_error_responses.py
git commit -F - <<'EOF'
fix(sidecar): return generic errors across all response shapes, log server-side

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

# Scope C — Frontend (own worktree, parallel with A/B)

### Task C1: `safeImageSrc` URL guard + wrap the img sites

**Files:** Create `src/lib/safe-url.ts`, `src/lib/safe-url.test.ts`; Modify `src/components/listen/listen-header.tsx` (`:90`, `imageUrl`), `src/components/library/library-table.tsx` (`:303`, `effectiveCoverUrl`), `src/components/library/library-grid.tsx` (`:207`, `effectiveCoverUrl`), `src/modals/cover-picker.tsx` (`:453` `c.coverUrl` + `:603` `coverUrl`).
**Interfaces — Produces:** `safeImageSrc(url: string | null | undefined): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/safe-url.test.ts
import { describe, it, expect } from 'vitest';
import { safeImageSrc } from './safe-url';
describe('safeImageSrc', () => {
  it('passes http/https and same-origin relative paths', () => {
    expect(safeImageSrc('https://x/y.jpg')).toBe('https://x/y.jpg');
    expect(safeImageSrc('/api/books/abc/cover')).toBe('/api/books/abc/cover');
  });
  it('strips javascript:, data:, blob:', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBe('');
    expect(safeImageSrc('data:image/svg+xml,<svg onload=alert(1)>')).toBe('');
    expect(safeImageSrc('blob:https://x/123')).toBe('');
    expect(safeImageSrc(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/safe-url.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/safe-url.ts
/** Allow only http(s) and same-origin relative paths for <img src>. Covers are
    always a server path (/api/books/:id/cover) or a remote http(s) search URL —
    never data:/blob:. Returns '' for anything else (notably javascript:). */
export function safeImageSrc(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Wrap the five img sites** — `src={safeImageSrc(imageUrl)}` / `src={safeImageSrc(effectiveCoverUrl)}` (×2) / `src={safeImageSrc(c.coverUrl)}` (`:453`) / `src={safeImageSrc(coverUrl)}` (`:603`). Import `safeImageSrc` in each file.

- [ ] **Step 5: Run tests + typecheck** — `npx vitest run src/lib/safe-url.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/safe-url.ts src/lib/safe-url.test.ts src/components/listen/listen-header.tsx src/components/library/library-table.tsx src/components/library/library-grid.tsx src/modals/cover-picker.tsx
git commit -F - <<'EOF'
fix(frontend): guard cover <img> src with a scheme allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task C2: Insecure randomness — crypto session id

**Files:** Modify `src/components/mini-player.tsx` (`:99-103`); test `src/components/mini-player.test.tsx` (extend/create).

- [ ] **Step 1: Extract + test a `makeSessionId()` helper**

```ts
// exported from mini-player.tsx
export function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return 'ss_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return 'ss_' + Date.now().toString(36); // final fallback: NO Math.random
}
```

```ts
// src/components/mini-player.test.tsx (add)
import { makeSessionId } from './mini-player';
it('mints a non-empty session id without Math.random', () => {
  expect(makeSessionId()).toMatch(/^(ss_|[0-9a-f-]{36})/i);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/mini-player.test.tsx` → FAIL (not exported).

- [ ] **Step 3: Replace the inline `Math.random` fallback** at the `useRef` init (`:99-103`) with `makeSessionId()`.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mini-player.tsx src/components/mini-player.test.tsx
git commit -F - <<'EOF'
fix(frontend): mint session id via crypto, not Math.random

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

# Scope D — Integration, config & dismissals (integrator, SEQUENTIAL, runs last)

> **All of D1/D2/D3 run on the `integration/2026-06-18-codeql` worktree** (created in Setup). D1 (CodeQL config) and D2 (docs) commit there directly; D3 then merges the three scope branches into it, verifies, and merges to `main`. The config + docs must be present on the integration branch **before** the post-merge re-scan so `paths-ignore` takes effect.

### Task D1: CodeQL config + workflow wiring

**Files:** Create `.github/codeql/codeql-config.yml`; Modify `.github/workflows/codeql.yml` (init step `:35-38`).

- [ ] **Step 1: Create the config**

```yaml
# .github/codeql/codeql-config.yml
name: castwright-codeql
paths-ignore:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - 'e2e/**'
```

- [ ] **Step 2: Reference it from the init step** — add to the `github/codeql-action/init` step's `with:` block (alongside `languages` + `build-mode: none`):

```yaml
          config-file: ./.github/codeql/codeql-config.yml
```

- [ ] **Step 3: Commit**

```bash
git add .github/codeql/codeql-config.yml .github/workflows/codeql.yml
git commit -F - <<'EOF'
ci(ci): exclude test files from CodeQL to prevent future noise

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

> `paths-ignore` is **not retroactive** — the 2 existing `cover.test.ts` alerts are dismissed in D3, not cleared here.

---

### Task D2: Docs — threat-model correction, INDEX, residue link

**Files:** Modify `docs/security/2026-05-31-security-review.md`, `docs/features/INDEX.md`.

- [ ] **Step 1: Correct the stale framing + record the pass** in the security-review doc: note that since `srv-19` the default bind is loopback-only; add a dated "2026-06 CodeQL remediation" subsection summarizing code-fixed vs. dismissed, linking this plan + `docs/security/codeql-dismissal-residue.md`.

- [ ] **Step 2: Add an INDEX entry** under the security area of `docs/features/INDEX.md` pointing at the spec + this plan (cross-cutting security work per the before-shipping checklist).

- [ ] **Step 3: Commit**

```bash
git add docs/security/2026-05-31-security-review.md docs/features/INDEX.md
git commit -F - <<'EOF'
docs(docs): correct stale bind framing + index the CodeQL remediation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task D3: Reconcile → verify → merge → re-scan → dismiss → confirm

- [ ] **Step 1: Resolve the srv-22 issue number** — `gh issue list --search "srv-22" --state open` → note `#NN` for the PR body.

- [ ] **Step 2: Reconcile + verify** — on the `integration/2026-06-18-codeql` worktree (created in Setup; D1/D2 already committed here), merge `fix/server-codeql`, `fix/sidecar-codeql`, `fix/frontend-codeql` one at a time, running `npm run verify` between merges. Final `npm run verify` green.

- [ ] **Step 3: Merge to `main`** (PR, "Create a merge commit"); PR body `Closes #NN` (srv-22) + fix/dismissal summary.

- [ ] **Step 4: Re-scan** — `gh workflow run codeql.yml --ref main`; wait a few seconds, then capture the dispatched run id (don't bare-`gh run watch`, which can attach to a stale run): `gh run list --workflow=codeql.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId'`, then `gh run watch <id>` (a long, attended ~5–15 min step). Code-fix alerts auto-clear; the dismissal-budget alerts reappear **open**.

- [ ] **Step 5: List → map → dismiss** — enumerate the still-open alerts and map each to the budget:

```bash
gh api repos/dudarenok-maker/Castwright/code-scanning/alerts --paginate \
  -q '.[] | select(.state=="open") | "\(.number)\t\(.rule.id)\t\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
```

For each alert that matches the **expected budget** (below), PATCH-dismiss it:

```bash
gh api repos/dudarenok-maker/Castwright/code-scanning/alerts/<n> -X PATCH \
  -f state=dismissed -f dismissed_reason="won't fix" \
  -f dismissed_comment="<file:line> — <reason>; see docs/security/2026-05-31-security-review.md"
```

**Gate:** if a still-open alert is **not** in the expected budget, it means a code fix did not clear (likely a mis-placed guard) — **re-fix it, do NOT dismiss**. Do not expand the budget to force the count to zero.

- [ ] **Step 6: Confirm** — `gh api …/code-scanning/alerts --paginate -q '[.[] | select(.state=="open")] | length'` → `0`. `srv-22` closure is verified by its A15 test, not the dashboard.

---

## Expected dismissal budget (for D3 Step 5)

- 4 × `xss-through-dom` (the 4 flagged cover `<img>` sites) — server-controlled provenance; `<img src>` not a script sink; wrapper not CodeQL-recognized.
- 2 × `incomplete-url-substring-sanitization` (`cover.test.ts:103,106`) — test file; not retroactively cleared by D1.
- 1 × `loop-bound-injection` (`audio-tags.ts:58`) — legitimate O(n) manuscript scan.
- ≤ ~6 × `path-injection` composed-path residue — per `docs/security/codeql-dismissal-residue.md` (A6).
- 0–1 × `polynomial-redos` (`text.ts` `FILENAME_RE`) — only if A10 found no parse-preserving rewrite.
- 0–1 × `disabling-certificate-validation` — only if mkcert absent AND the plain-HTTP fallback is unavailable.

Any other still-open alert → re-fix (Step 5 gate), never dismiss.

---

## Self-review notes

- **Spec coverage:** every inventory bucket maps to a task — path-injection → A1–A6; rate-limiting → A7; format-string → A8; loop-bound → A9; redos → A10; sanitization → A11; double-escaping → A12; resource-exhaustion → A13; cert → A14; srv-22 → A15; stack-trace → B1; xss+randomness → C1/C2; config+doc+dismissals → D1–D3.
- **Sequencing:** Scope A is internally sequential (A1 first); B and C parallelize in their own worktrees; D runs last. The residue doc is created by A6 and only appended by A10.
- **Test efficacy caveat:** A9/A11 (and the `path.relative` shape in A1) are CodeQL-*shape* fixes — their unit tests assert behavior/stability, and **D3's re-scan is the alert-clearing gate**, with an explicit "re-fix not dismiss" guard for any unexpected open alert.
- **Type consistency:** `safeSegment`/`assertContained`/`safeJoin` (A1) consumed verbatim in A2–A6; `makeApiLimiter`/`apiLimiter` (A7) mounted in `index.ts`; `safeImageSrc` (C1) and `makeSessionId` (C2) names match their tests; `error_response` (B1) signature matches its pytest; `writeInbox(id, '1', body)` uses a valid `HandoffKey`.
