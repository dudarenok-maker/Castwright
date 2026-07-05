Released 2026-05-19. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.3.1).

---

# Castwright 1.3.1

**The biggest single step since the analysis pipeline was rebuilt in phases.**
New capabilities across listening, voice, cast and onboarding; dark mode
stabilised; the install path is now end-to-end in-app for the alpha audience;
restructure + TTS hardened for long structured manuscripts.

---

## ✨ Headline features

### 🎧 Listening surface overhaul (new)
- **Playback speed picker** (0.75×–2×) persisted per book, user-placed markers
  (note / rerecord) with a sidebar, and a **sleep timer** with countdown presets +
  end-of-chapter mode (plan 53).
- **True RMS waveform peaks** computed at encode time and persisted (plan 56);
  per-book resume bookmarks (plan 47); collapsible editorial **Notes** card (plan 67).
- **Share a 30-second clip** of any chapter as MP3 (`ffmpeg -ss / -t / -c copy`,
  no re-encode) (plan 69); mint a slugged **streaming link** for the whole book's
  M4B (plan 68); M4B + MP3-ZIP download tiles (plan 57).

### 🛠️ In-app multi-model management (new)
Install Ollama, pull a model, and pre-fetch Coqui XTTS without a terminal
(Account → Models card, plan 61).

- Per-platform install state machine (idle → detecting → downloading → installing
  → installed); model-pull consumes Ollama's NDJSON progress stream; bootstraps are
  dependency-injectable so tests run offline. New `install-coqui.{sh,ps1}`.

### 🔌 Cross-tab state sync (new)
- Open the same book in two tabs and the analysis / generation pills update in
  lockstep via `BroadcastChannel`, with two-layer echo suppression and a narrow
  broadcast scope (only `activeStream` slots) preserving the single-user contract (plan 63).

---

## 🎙️ Voice & cast

- **Per-candidate "Play sample"** inside the profile drawer — audition voices
  against a user-editable sample line, no commit until Save (plan 64).
- **Same-book Compare** lifted to the global Voices tab; cross-book pairs remain
  disabled (plan 65).
- **Revision history timeline** — a read-only chronological log of accept / reject
  events per chapter via the A/B player modal (plan 55).
- The drift modal's **Listen** button opens the A/B compare player directly;
  bulk-apply on confirm-cast ticks both Reuse and Sync in one click.

## 📖 Ingest & themes

- **EPUB series auto-extracted** from title parentheticals; **MOBI / AZW3** upload
  covered by real-binary e2e fixtures; cast-view book cards show a title + series
  metadata strip below the cover.
- **Dark mode reached `stable`** after a three-pass contrast bundle — full
  per-utility override coverage across the white / amber / red / rose ladders + their
  alpha + hover variants, a bespoke `floating-pill-inverse` utility, and corrected
  match-detail drawer z-index (plan 42).

## 🔊 Generation & restructure fixes

- **A structural edit (merge / split / reorder) forced a full re-analysis** —
  Generate halted on "No analysed sentences cached. Re-run analysis first",
  burning quota and destroying manual cast tweaks. Now the restructure path
  re-derives the cache from `manuscript-edits.json` in place and the generation
  route auto-heals an empty cache. No re-analysis required (plan 70c).
- **Long single-speaker chapters froze on the "Worker has gone quiet" banner** —
  the TTS path folded consecutive same-speaker sentences into one giant synth call
  that ran past the watchdog. Now one call per sentence, so the caption advances
  continuously and same-speaker prosody drift disappears (plan 70d).
- **Bracketed audio tags like `[empathic]` were spoken aloud literally** — no
  engine in this app interprets bracket markup. Now the closed-vocabulary tag list
  is stripped at the TTS boundary; arbitrary bracketed prose is preserved (plan 70d).
- **Sequential merges on long manuscripts dropped orphaned sentences**, surfaced
  empty `0 sentences · 00:00` rows, and left stale "Chapter N" titles. Now orphans
  are recovered onto the nearest preceding chapter, empty rows auto-pruned, and
  generic titles re-derived (plan 70a).
- **Several dark-mode surfaces were unreadable** — the Halted pill / panel
  (red-on-red), the Analysing connection pill + profile-drawer engine tabs
  (near-white on near-white `bg-white/{40,60,70,95}`), the voice-drift banner, the
  cast-view selection bar, and the confirm-metadata inputs. All now legible (plan 42).
- **The match-detail drawer opened underneath the profile drawer.** Now it stacks
  correctly in both themes.
- **A cover-bearing card hid its title + series** (gated on the no-cover
  fallback). Now an always-visible metadata strip below the artwork.
- **Editorial notes were dropped on save** (missing `description` on the
  `bookMeta/commitDraft` rule). Now both fields round-trip (plan 67).
- **The generation pill counters froze** when navigating to a different book
  mid-run, then flipped to "Stalled" on a healthy run. Now they update cross-book.

## 🏗️ Under the hood

- **GitHub Actions runs `npm run verify` on every PR** targeting `main`, the same
  gate the pre-push hook runs locally (plan 62).
- **Parallel-session worktrees** — `scripts/wt-new.mjs` / `wt-list.mjs` spawn
  worktrees with non-colliding dev-server ports (plan 59).
- **`src/views/listen.tsx` decomposed** 1136 → 319 lines into three orchestrated
  sub-components under `src/components/listen/`, zero spec files modified (plan 60).
- **TTS sidecar starts with the server** — per-user `autoStartSidecar` (default
  on); `npm start` brings up frontend + server + sidecar in one shot (plan 43).
- Verify-cache `--steps=<csv>` subset selection; de-flaked e2e suites
  (flakes-per-run 3–5 → 0).

**Full changelog:** `v1.2.2...v1.3.1`
