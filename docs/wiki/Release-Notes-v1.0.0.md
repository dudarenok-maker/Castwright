# Castwright v1.0.0

Released 2026-05-17. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.0.0).

---

# Castwright 1.0.0

**Initial release.** The full v1 pipeline takes a manuscript from upload to a
chaptered audiobook on disk: parse, attribute each line to a character, audition
voices, generate per-chapter audio via a local TTS sidecar, listen / revise, and
export to M4B or MP3 zip with cover artwork and chapter atoms.

---

## ✨ Headline features

### 📖 Manuscript → audiobook pipeline (new)
- **Ingest** — upload accepts `.md` / `.txt` / `.epub` / `.pdf`; chapter names are
  extracted at parse time; parse-only import lets the user confirm metadata
  (author / series / standalone) before the book lands on disk (plans 02, 12).
- **Analysis pipeline** — cast detection runs through one of three analyser modes:
  Gemini cloud (default for hosted, free-tier rate-limited), local Ollama (default
  for self-host, auto-falls back to Gemini when the daemon is unreachable), or
  manual file-drop coworking. Sticky analysis survives leaving the analysing view
  (plans 06, 29, 32).
- **Generation stream** — per-chapter SSE (`progress` / `chapter_complete` /
  `chapter_failed` / `idle`); sticky generation survives every navigation except an
  explicit Stop or queue drain, with Pause / Resume via `POST /pause` (plans 16, 32).

### 🎙️ Local TTS sidecar + voice library (new)
- **Sidecar** — a local Python FastAPI sidecar hosting two engines: Coqui XTTS v2
  (zero-shot cloning) and Kokoro v1 (English-only, eager-loaded, ~1 GB VRAM). The
  analyser and Coqui auto-evict each other to free VRAM with an inline banner
  (plans 14, 14a, 30).
- **Voice library** — per-engine catalogs, family grouping (`af_*` / `am_*` /
  `bf_*` / `bm_*`), drag-to-assign onto cast members, per-character overrides scoped
  per-engine so a Coqui ↔ Kokoro switch preserves assignments, sample playback
  against a user-editable line, and compare-two-cast-members (plan 22a).

### 🎧 Revisions, export & persistence (new)
- **Revisions and drift** — A/B audio audition before accept / reject; rollback
  preserves the prior MP3 as `<slug>.previous.mp3` so it's non-destructive; a
  pending-revisions pill + full diff view (plan 20).
- **Audiobook export** — M4B (embedded cover, per-chapter `chap` atoms, optional
  `desc` / `ldes` metadata), MP3 zip (chaptered MP3s for Smart AudioBook Player /
  Audiobookshelf), and sync-folder save (drops the M4B into a sync directory). A
  LAN download tile generates a QR for sideloading; jobs can be cancelled /
  retried (plans 32, 33, 39).
- **Workspace persistence** — per-book on-disk state (`cast.json`,
  `manuscript-edits.json`, `revisions.json`, `change-log.json`, audio renders),
  round-tripped through atomic JSON writes with `renameWithRetry` for Windows /
  OneDrive races (plan 27).

---

## 🏗️ Under the hood

- **Five-tier test harness** — Vitest frontend + server, pytest sidecar, Pester
  for PowerShell helpers, Playwright e2e in mock mode; one-shot via `npm run
  verify` (plan 37).
- **Three-tier commit gate** (husky v9) — `commit-msg` Conventional-Commits
  validator, `pre-commit` `verify:fast`, `pre-push` full `verify` (plan 38).
- **OpenAPI as the single source of truth** at `openapi.yaml`; `src/lib/api-types.ts`
  generated via `npm run openapi:types` (plan 24).
- **Mock mode** round-trips against an in-memory map for jsdom tests + design
  fixtures (`VITE_USE_MOCKS=true`).

**Full changelog:** initial release
