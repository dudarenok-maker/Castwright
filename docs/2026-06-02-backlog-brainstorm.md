# 2026-06-02 backlog brainstorm — snapshot

A one-pass brainstorm that added **29 net-new backlog items** (issues
[#458](https://github.com/dudarenok-maker/AudioBook-Generator/issues/458)–[#486](https://github.com/dudarenok-maker/AudioBook-Generator/issues/486))
across five lenses. Every item was checked as **net-new or an explicit extension** of an
existing backlog item before filing — nothing here re-lists something already queued.

**Status (updated 2026-06-02):** the whole-backlog **priority pass ran in this same PR**.
The 29 items are now distributed into their real MoSCoW slots in
[`docs/BACKLOG.md`](BACKLOG.md) (8 → Should, 21 → Could; `side-13`→Could gates the sharing
cluster), with their GitHub `moscow:` labels updated to match. The same pass promoted
`side-11`→Must and `srv-2`→Should and demoted `fe-1`/`fe-5`→Could. **`docs/BACKLOG.md` is
now authoritative for bucket + rank** — this snapshot is **superseded** and kept only as
the lens-grouped rationale + dependency-ordering record for the sharing cluster (E1–E5).

Size key: **S** ≈ ½–1 day · **M** ≈ one PR · **L** ≈ its own plan (filed with `needs-plan`).

## Verified code facts behind the listener items

Confirmed against live code during the brainstorm, to keep the items honest:

- **`fe-23` (auto-advance)** — `src/components/mini-player.tsx` `onEnded` only calls
  `setPlaying(false)`; playback genuinely stops at every chapter boundary today.
- **`fe-24` (skip)** — the `IconRewind`/`IconForward` controls are whole-chapter
  prev/next (`onPrev`/`onNext`); there is no intra-chapter ±15s/±30s seek.
- **`fe-25` (volume)** — the `IconVolume` button renders with **no `onClick`** — a dead
  placeholder.
- The mini-player **already has** playback speed (0.75–2.0×), a sleep timer
  (countdown + end-of-chapter), markers, and a rebindable play/pause key — so those are
  deliberately **not** proposed.

## The 29 items by lens

### A — Listener experience
| ID | Item | Size | Issue |
|----|------|------|-------|
| fe-23 | Auto-advance / continuous playback | S | #458 |
| fe-24 | Skip forward/back (±15s / ±30s) | S | #459 |
| fe-25 | Wire (or remove) the volume control | S | #460 |
| fe-26 | Marker export + shareable notes | S | #461 |
| fs-15 | Continue listening: global cross-book resume | M | #462 |
| fs-16 | Listening-stats dashboard | M | #463 |
| fs-17 | Read-along: sentence highlight synced to audio | L | #464 |

### B — Reliability & quality
| ID | Item | Size | Issue |
|----|------|------|-------|
| srv-27 | Post-synthesis audio QA gate | M | #465 |
| srv-28 | Pre-flight disk-space guard | S | #466 |
| ops-11 | Golden-audio regression harness | M | #467 |
| fs-18 | One-click diagnostics / health board | M | #468 |
| fs-19 | Structured failure taxonomy + remediation | M | #469 |
| fs-20 | Per-run resource telemetry log + trend view | M | #470 |

### C — Distribution & onboarding
| ID | Item | Size | Issue |
|----|------|------|-------|
| fe-27 | In-app update notifier | S | #471 |
| fe-28 | Onboarding empty states + first-run checklist | S | #472 |
| fe-29 | In-app help / troubleshooting panel | S | #473 |
| fs-21 | First-run setup wizard | L | #474 |
| fs-22 | Bundled demo book (real, generate-able) | S | #475 |
| fs-23 | In-app model manager | M | #476 |

### D — Net-new capabilities
| ID | Item | Size | Issue |
|----|------|------|-------|
| fe-30 | Voice-actor (multi-narrator) view | M | #477 |
| fs-24 | Per-character pronunciation lexicon | M | #478 |
| fs-25 | Per-quote expressive / emotion synthesis | L | #479 |
| fs-26 | Line-level re-record / splice | L | #480 |
| fs-27 | Chapter recaps / "previously…" summaries | M | #481 |

### E — Voice & cast sharing (build bottom-up)
| ID | Item | Size | Issue |
|----|------|------|-------|
| fs-28 | Voice export/import bundle (**foundation**) | M | #482 |
| fs-29 | Cast/profile pack sharing | M | #483 |
| fs-30 | Whole voice-library export/import | M | #484 |
| side-13 | Import safety + provenance (**gate**) | M | #485 |
| fs-31 | Community voice registry / share-by-link | L | #486 |

**Dependency order for E:** `side-13` (safe-load gate) → `fs-28` (bundle format) →
`fs-29` / `fs-30` → `fs-31` (externally-facing, needs a hosting + licensing/abuse
design). Constraint baked into every item: scoped to **synthetic/designed** voices with
a consent/licensing note — never framed as cloning a real person's voice.

## Signal for the priority pass (not a decision)

- **Quick verified wins first:** `fe-23` / `fe-24` / `fe-25` are small, and two of them
  fix things currently broken/unfinished in live code.
- **Foundation before flashy (sharing):** `side-13` + `fs-28` must precede the rest of E.
- **Reliability (`srv-27` / `srv-28` / `fs-18` / `fs-19`)** pays back fastest given the
  recent generation/VRAM firefighting history.
- **Park the L-sized bets** (`fs-17`, `fs-21`, `fs-25`, `fs-26`, `fs-31`) as their own
  plans rather than mixing into a quick-win round; each carries `needs-plan`.
- Several S-sized listener/quick-win items are realistically `could`, not `should` — the
  `should` label is a placeholder pending this pass.
