Released 2026-05-18. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.2.2).

---

**MOBI/AZW3 ingest, chapter restructure, listening progress, and release-packaging end-to-end.** User-visible features, fixes and infrastructure since v1.1.0.

> ⚠️ **Upgrade note:** v1.2.0 and v1.2.1 were tagged but never published — the release workflow surfaced cross-platform CI gaps that this release closes.

---

## ✨ Headline features

### 📖 MOBI / AZW3 ingest + chapter restructure (new)
- **MOBI / AZW3 upload** — Kindle / Calibre files drop directly into the upload screen; DRM-protected files are rejected up-front with a clear message rather than failing deep inside the parser (plan 52).
- **Chapter restructure panel** — merge, split and reorder chapters post-import without re-uploading or re-running analysis. Sentences remap via `(chapterId, id)` rewrite so no analyzer quota is spent and manual cast tweaks are preserved (plan 51).

### 📦 Release packaging end-to-end (new)
- **Tag-triggered release** — `node scripts/bump-version.mjs --level minor --notes-file <path>` advances both `package.json`s in lockstep, regenerates lockfiles, commits, and writes the annotated tag; pushing the tag fires `release.yml`, which verifies on Ubuntu / macOS / Windows, builds the zip + SHA-256, and publishes the GitHub Release from the tag annotation (plan 49).

---

## 🎧 Listening & cast

- **Listening progress / resume** — close the app mid-chapter and get a "Resume at H:MM:SS" pill; the mini-player saves with a debounced PUT, refresh rehydrates the seek position (plan 47).
- **Cover Replace / Regenerate** from the listen view; per-chapter queue drawer gains copy / remove on each queued export (plan 18a).
- **Bulk-sync on confirm-cast** — a "Sync N profiles from library" pill collapses N per-card ticks into one click, per-card untick preserved (plan 41).
- **Rollback fsck + mid-flight Reject toast** — a rolled-back revision fsck-walks the audio directory and reports drift; an in-flight Reject surfaces a toast (plan 20).

## 🔔 Cross-cutting toast surface

- Transient stream / export failures now surface as a 6s auto-dismissing notification stack (bottom-right, `role="status"`); repeated errors dedupe by key instead of stacking (plan 48).

## 🎙️ Fixes

- **The Gemini analysis stream could hang forever on an idle / dead-write window** — the analyser pill sat on a stale stream with no progress and no error. Now the stream detects the silence, cancels, and re-issues automatically (plan 06).
- **In dark mode, failed / stale sentence-status badges were nearly invisible** (red / rose on dark), as were the streaming progress pill and several translucent `bg-white/{60,70}` panels. All now legible (plan 42).

## 🏗️ Under the hood

- **Cross-platform release workflow** — installs ffmpeg per-OS (`apt / brew / choco`), `test:scripts` / `test:sidecar` pick `pwsh` / `powershell.exe`; v1.2.0 / v1.2.1 were the dry-runs that surfaced these gaps (plan 49).
- **Production-mode server** — `npm run start:prod` launches API + Vite-built frontend off one process on `:8080` (plan 49).
- **UI-managed Gemini API key** — a writable Account field; `GET /api/user/settings` never echoes the plaintext (redacted `apiKeyStatus`); env-var still wins (plan 49).
- **Verify-cache** for cheap retries (per-step input-hash cached) (plan 50); lint + Prettier + axe-core a11y on four core views (plan 46); PR-title lint + body template, squash / rebase merges disabled (plan 44); `INSTALL.md` deployer one-pager.

**Full changelog:** `v1.1.0...v1.2.2`
