---
status: stable
shipped: 2026-05-23
owner: null
---

# 105 — Multer 1.x → 2.x security upgrade (server file uploads)

> Status: stable
> Key files: `server/package.json`, `server/src/routes/cover.ts`, `server/src/routes/import.ts`, `server/src/routes/manuscripts.ts`, `server/src/routes/exports-portable.ts`
> URL surface: `POST /api/books/:bookId/cover/upload`, `POST /api/import`, `POST /api/manuscripts`, `POST /api/import/portable`
> OpenAPI ops: the four multipart upload endpoints above (contract unchanged by this bump)

## Benefit / Rationale

- **User:** no behavioural change — uploads work exactly as before. The win is invisible-but-real: the server's only known-vulnerable direct dependency is gone.
- **Technical:** closes the `multer@1.4.5-lts.x` deprecation warning that fired on every `npm install --prefix server`, and removes a string of CVEs that the 1.x line never patched (it is EOL). Multer 2.x patches `CVE-2025-47935`, `CVE-2025-47944`, `CVE-2025-48997`, `CVE-2025-7338`, plus the 2.1.x-line advisories `CVE-2026-2359`, `CVE-2026-3304`, and `CVE-2026-3520`.
- **Architectural:** keeps the server-side dependency tree audit-clean ahead of LAN HTTPS mode (plan 81) and any future hosted deployment, where a multipart-upload DoS or busboy-abort bug would have a wider blast radius than the local-only path has today.

## Architectural impact

- **API-compatible bump, not a rewrite.** Multer 2.x is a security/maintenance major: the only declared breaking change in the 2.0.0 release is the Node floor moving to `>=10.16.0` (we run Node 20+). The request-handler surface this codebase uses — `multer.memoryStorage()`, `upload.single(field)`, `req.file` (`{ buffer, mimetype, originalname, size }`), and the `multer.MulterError` class with its `.code` / `.field` properties — is preserved verbatim. The `MulterError` code strings (`LIMIT_FILE_SIZE`, `LIMIT_UNEXPECTED_FILE`, …) are byte-identical between 1.x and 2.x (`lib/multer-error.js`).
- **Types stay external.** Multer 2.x does **not** bundle its own TypeScript declarations (no `types` field in its `package.json`), so `@types/multer` remains a devDependency — bumped `^1.4.11` → `^2.1.0` to match the runtime major (DefinitelyTyped maps `ts5.4` → `@types/multer@2.1.0`).
- **One route owns explicit upload-error handling.** Only `cover.ts` wraps `upload.single('image')` in an error-forwarding closure that maps the error to an HTTP status. That branch was hardened from a bare `(err as {code?}).code === 'LIMIT_FILE_SIZE'` check to a proper `err instanceof multer.MulterError` guard (so a non-multer middleware error can't masquerade as an upload-limit response), with an explicit `LIMIT_UNEXPECTED_FILE` → 400 branch added alongside the existing `LIMIT_FILE_SIZE` → 413 branch.
- **The other three routes mount `upload.single(field)` as plain middleware** with no bespoke error branch — a `MulterError` there propagates to Express's error chain unchanged under 2.x (no code change required; behaviour is identical to 1.x).
- **Reversibility:** revert the two `server/package.json` lines + the `cover.ts` middleware diff + `npm install --prefix server`. No on-disk data shape, no state.json, no openapi.yaml change.

## Invariants to preserve

- The four upload routes all use `multer.memoryStorage()` (in-RAM buffer, no temp files on disk) — `server/src/routes/{cover,import,manuscripts,exports-portable}.ts`. Buffers are validated/persisted by the route, not multer.
- `cover.ts` upload-error mapping: oversize (`LIMIT_FILE_SIZE`) → **413** with `{ kind: 'oversize' }`; unexpected field (`LIMIT_UNEXPECTED_FILE`) → **400** with `{ kind: 'unexpected_field' }`; any other multipart error → 400 generic (`server/src/routes/cover.ts`, the `uploadMw.single('image')` closure).
- Per-route `fileSize` limits unchanged: cover `MAX_UPLOAD_BYTES` = 10 MiB (`server/src/cover/upload.ts:24`); import 50 MiB; manuscripts 20 MiB; portable-import 50 MiB.
- `@types/multer` stays a devDependency (multer 2.x ships no bundled types).

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/cover.test.ts`) — two new cases pin the 2.x `MulterError` paths through the route's explicit handler:
  - oversize upload (11 MiB buffer > 10 MiB `MAX_UPLOAD_BYTES`) → **413** with `body.kind === 'oversize'` (`LIMIT_FILE_SIZE`).
  - file attached under an unexpected field name (`wrongField` vs the configured `image`) → **400** with `body.kind === 'unexpected_field'` (`LIMIT_UNEXPECTED_FILE`).
- Vitest server (`server/src/routes/import.test.ts`) — one new case asserts a file riding an unexpected field name does NOT 200 (multer 2.x still raises `LIMIT_UNEXPECTED_FILE` so the route never sees a valid `req.file`); the request is rejected (≥400).
- Playwright e2e (`e2e/binary-upload.spec.ts`) — existing regression that drives EPUB / PDF / MOBI / AZW3 multipart uploads through `POST /api/import`; stays green under multer 2.x (the happy-path `upload.single('file')` contract is unchanged).
- The other ~30 server route tests that exercise multipart uploads (cover upload happy path, portable import) all stay green — multer 2.x preserves the `req.file` shape they assert against.

### Manual acceptance walkthrough

1. `npm install --prefix server` → no `multer@…` deprecation warning printed (the remaining `node-domexception` warning is the `@google/genai` chain, tracked separately under backlog `srv-4` — not multer's).
2. `npm ls multer --prefix server` → `multer@2.1.1`. `npm ls @types/multer --prefix server` → `@types/multer@2.1.0`.
3. In the running app (`npm start`), upload a local cover JPEG via the listen-header Cover picker → still writes `cover.jpg`, patches `state.json` with `source: 'local'`.
4. Attempt to upload a >10 MiB cover → 413 with the "Cover must be under …" message and the gradient stays.
5. Upload a manuscript (`.epub` / `.txt`) via the upload view → parses and lands on the analysing/confirm stage as before.

## Out of scope

- The `@google/genai` → `node-domexception@1.0.0` deprecation chain — still on `@google/genai` major 2 (no v3); tracked in backlog `srv-4` (jsdom · archiver · @google/genai). No server-side change here.
- ESLint 8 → 10 flat-config migration + jsdom/archiver bumps — Cluster A of this round (root deps), separate branch.

## Ship notes

Shipped 2026-05-23 on branch `fix/server-multer-2-upgrade`.

- `server/package.json`: `multer` `^1.4.5-lts.1` → `^2.1.1`; `@types/multer` `^1.4.11` → `^2.1.0`. Resolved to `multer@2.1.1` + `@types/multer@2.1.0`.
- Confirmed via the upstream CHANGELOG that 2.x is API-compatible for this codebase's usage (the only declared breaking change is the Node `>=10.16.0` floor); `MulterError` codes and the `multer.MulterError` / `memoryStorage` / `upload.single` / `req.file` surface are unchanged. The upstream `UPGRADING.md` referenced by the BACKLOG entry no longer exists in the repo (the migration is documented in the CHANGELOG + README instead).
- `cover.ts` error branch hardened to `err instanceof multer.MulterError` + explicit `LIMIT_UNEXPECTED_FILE` → 400. The other three routes needed no change (they forward multer errors to Express unchanged).
- `npm install --prefix server` no longer prints a multer deprecation warning. `npm run test:server` (1263 passed / 8 skipped) + `npm run test:server-slow` (156 passed) green; the 3 new MulterError test cases pass.
