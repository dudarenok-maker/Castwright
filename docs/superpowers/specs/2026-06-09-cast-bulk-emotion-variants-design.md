# Per-book bulk emotion-variant design + cast-table variant glyphs

> Status: draft — design approved 2026-06-09. Reframes backlog item `fe-32`
> (#512) from the series-wide rebaseline modal to the **per-book** "Design full
> cast" flow, which is where the user actually voices a book. Implementation
> plan to follow via writing-plans.

## Problem

Bulk voice design for a book exists (plan 195, the "Design full cast" SSE job +
third top-bar pill), but it designs **base voices only**. Two gaps remain:

1. **No bulk emotion-variant design.** A character's tagged emotions
   (`whisper`/`angry`/`excited`/`sad`) each need a designed Qwen variant or the
   line silently falls back to the base voice — rendering the wrong emotion.
   Today the only way to design variants is one character at a time in the
   profile drawer (`EmotionVariantDesigner`).
2. **The cast table only shows counts.** A `VariantsBadge` count and an "N tags
   need a variant" text hint tell you *how many*, never *which* of the four
   emotions are designed vs missing. The user's words: "useful, but not
   informative."

These are the **floor for voicing a book** — demand-driven (only the emotions a
character's lines actually use), not capability-driven (all four for everyone).
Full-capability design stays a later layer.

## Goals / non-goals

**Goals**
- Per-emotion variant status in the cast table, legible at a glance.
- One-action bulk design of every *needed-but-missing* variant across a book's
  cast, reusing the existing reload-resilient server-owned job.
- Keep the base-voice flow unchanged; bulk variants are an opt-in scope.

**Non-goals**
- The series-wide rebaseline modal (`fe-32`'s original home) — out of scope;
  this is the per-book reframe. The rebaseline modal stays base-only.
- Capability-driven "design all four for everyone" — demand-driven only.
- Any change to the synth path, `Sentence.emotion`, or the
  `overrideTtsVoices.qwen.variants` data model — all already exist (fs-25).
- New top-bar pills or buttons — **one** button, a scope picker (user
  constraint: "no need to have multiple buttons").

## Design

### Part A — Cast-table variant glyphs (visibility)

A **demand-driven glyph strip** on a **second line of the Status column**
(desktop table + mobile card). It supersedes the `VariantsBadge` count *and* the
"N tags need a variant" text hint — the glyphs convey both, so this is a net
simplification of the row, not added clutter.

- **Line 1 (unchanged):** lifecycle `Pill` + `Reused` badge.
- **Line 2 (new):** one glyph per emotion the character's quotes use
  (`usedEmotionsByCharacter`), in a fixed emotion order. Each glyph carries:
  - **designed** → green halo + a small green check badge;
  - **needed** → amber halo + a small amber alert badge.
- **Hover** any glyph → native `title` tooltip naming the emotion + state
  (e.g. "Excited — needs a variant", "Angry — designed").
- **Quiet states** (no glyph strip, faint hint or nothing):
  - non-Qwen-effective character → nothing (variants are Qwen-only);
  - Qwen character with no emotion tags → faint "no emotion tags";
  - Qwen character still needing its **base** voice → faint "design base voice
    first" (a variant can't exist without a base).
  - all demanded variants designed → a compact "✓ variants complete".

**Icon-quality requirement (explicit):** the check / alert badges are rendered
as **crisp inline SVG icons** sized to the badge ring with a border cut-out
against the row background — *not* emoji-text glyphs (those render cramped and
inconsistent across platforms at ~12px). The emotion glyphs themselves
(whisper/angry/excited/sad) use the project's icon set or a deliberate emoji
choice settled during implementation; the **status badges** must be SVG.

The "Needs variants" cast filter chip and the `statusFilterKeys` logic are
already wired (fs-34) and stay as-is — they keep counting demand-driven missing
variants.

### Part B — Bulk variant design (the action)

**Trigger — one button, scope picker (option 3).** The existing "Design full
cast" button opens a small popover instead of starting immediately. Three rows,
each annotated with its **live work count** so GPU cost is visible up front:

| Scope | Work count | Action |
|---|---|---|
| **Base voices** | characters with lifecycle `Needs voice` | design bases (today's behaviour) |
| **Emotion variants** | Σ demanded-but-missing variants across Qwen cast | design each missing variant |
| **Both** | bases + their needed variants | bases first, then variants |

- A scope with zero work → **disabled** row with a green "all done".
- A small estimate + reassurance line ("~N designs · one at a time on the GPU ·
  safe to close — the pill keeps it going").
- Picker dismisses on outside-click / Escape; selecting a scope starts the job.

**Dependency rule.** A variant needs its base. Under **Emotion variants**, a
character still missing its base is skipped (and surfaced in the count as not
applicable). **Both** resolves the dependency by designing a character's base
*then* its variants in sequence.

**Work-list computed on the frontend, passed to the server.** Demand already
lives frontend-side (`usedEmotionsByCharacter` + `countMissingVariants` over
`sentences`). Rather than re-derive emotion tags server-side, the picker sends
the server job an explicit task list, mirroring how it sends `characterIds`
today:

```
POST /api/books/:bookId/cast/design
{
  modelKey,
  scope: 'bases' | 'variants' | 'both',
  characterIds: string[],                 // bases to design (as today)
  variantTasks?: { characterId: string; emotions: Emotion[] }[]  // demanded-missing
}
```

The server **re-validates freshness** each iteration (it already re-reads
`cast.json` per character): skip a base that now exists, skip a variant that now
exists or whose base is (still) missing. Demand (which emotions) is stable from
manuscript tags, so passing it from the client is safe; designed-state is
re-checked server-side to avoid clobbering concurrent work.

**Execution reuses everything.** The bulk loop (`cast-design.ts`) already
serializes through `withDesignLock` + `gpuSemaphore` and is reload-resilient
(in-memory job survives subscriber disconnect; cold-boot re-subscribe). Variant
design adds:
- per task, call `designQwenVoiceForCharacter({ …, emotion })` — the helper
  already designs under `<baseVoiceId>__<emotion>` (qwen-voice.ts:198) — then
  persist the `qwen.variants[emotion]` slot;
- the persistence **scope matches the base** in this job: series-scoped for a
  series book (so a series-shared voice keeps its variants series-shared),
  workspace/book-scoped for a standalone. A shared persistence helper extracted
  from the single-variant route (`qwen-voice.ts` ~L442) avoids divergence.
- `job.total` counts bases + variant tasks; the pill copy becomes
  "Designing voices & variants… (k of N)".

**Mutual exclusion (unchanged).** The job holds the per-book design lock, so
single-design and re-analysis stay mutually exclusive with it, exactly as today.

### Data flow

```
Cast view ── usedEmotionsByCharacter(sentences) ─┐
            countMissingVariants per Qwen char    │  (demand)
                                                   ▼
  "Design full cast" button → scope picker (counts) → designAllRequested({scope, characterIds, variantTasks})
                                                   ▼
  cast-design-slice / stream-middleware → POST …/cast/design (SSE)
                                                   ▼
  runDesignJob: for each task → withDesignLock + gpuSemaphore →
     base:    designQwenVoiceForCharacter(...)        → applyOverrideToCastFiles(base)
     variant: designQwenVoiceForCharacter(...emotion) → persist qwen.variants[emotion] (same scope)
                                                   ▼
  cast.json updated per task (idempotent) → SSE progress → third pill → cast rows re-resolve glyphs
```

## Error handling

- **Per-task failure** is isolated (as today): record the failure, broadcast
  `character_failed`, continue. A variant failure leaves that emotion in the
  "needed" (amber) state.
- **Sidecar-wide failure** (`unreachable` / `did not complete` / `stopped
  responding`) fast-fails the whole job (existing regex guard) instead of
  grinding N timeouts.
- **Base missing under `variants` scope** → skip the variant task, not a
  failure; the row keeps its "design base voice first" hint.
- **Cancel / reload** → unchanged: Cancel aborts the controller; reload
  re-attaches via the bare POST and the pill resumes.

## Testing

- **Frontend unit (Vitest + RTL):**
  - glyph strip renders correct designed/needed state per demanded emotion;
    quiet states (non-Qwen, no-tags, needs-base, complete) render correctly;
    `VariantsBadge` count + text hint removed.
  - scope picker: live counts, disabled "all done" rows, dependency annotation;
    selecting a scope dispatches `designAllRequested` with the right payload.
  - work-list builder: `{characterId, emotions[]}` matches
    `countMissingVariants`; bases excluded from variant tasks; needs-base chars
    excluded from `variants` scope but present under `both`.
- **Server (Vitest + node):**
  - `cast/design` accepts `scope` + `variantTasks`; runs base then variant for
    `both`; freshness-skips an already-designed variant and a missing-base
    variant; persists `qwen.variants[emotion]` at the correct scope
    (series vs standalone); `job.total` and progress counts include variants.
  - sidecar-wide failure still fast-fails; per-task failure isolates.
- **E2E (Playwright, mock mode):** one spec — open cast view, open the scope
  picker, pick "Emotion variants", assert the pill runs and a row's glyph flips
  from needed→designed. (UI-visible, crosses redux/SSE/layout seams.)

## Open implementation details (resolve in plan, not blocking design)

- Exact glyph set for the four emotions (project icons vs chosen emoji) — the
  **status badges are SVG** regardless.
- Whether the picker is a popover vs a tiny menu component, and its mobile
  placement (bottom-sheet vs anchored).
- Shared variant-persistence helper signature (extract from `qwen-voice.ts`).

## References

- Backlog: `fe-32` (#512); origin fs-25 Wave 6b.
- Existing: `server/src/routes/cast-design.ts` (bulk job), `qwen-voice.ts`
  (`designQwenVoiceForCharacter`, `buildVariantInstruct`, variant persistence),
  `src/components/emotion-variant-designer.tsx` (single-char variant UI),
  `src/lib/voice-status.ts` (`usedEmotionsByCharacter`, `countMissingVariants`),
  `src/views/cast.tsx` (`StatusPill`, `needsVoiceIds`, `onDesignFullCast`).
- Plan 195 archive: `docs/features/archive/...-design-full-cast` (job/pill/slice).
- fs-25 archive: `docs/features/archive/177-fs25-per-quote-emotion.md`.
