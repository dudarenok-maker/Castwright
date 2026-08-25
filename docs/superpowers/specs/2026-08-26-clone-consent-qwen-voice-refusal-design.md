---
status: draft
---

# `qwen-voice.ts` clone-consent refusal: write-time re-check (part of #2006 / srv-81)

Sibling to `2026-08-22-clone-consent-voices-override-refusal-design.md`, which
resolves the `voices.ts`/`single-design.ts` gate. **This spec resolves the third
gate: `persistEmotionVariant` (`server/src/routes/qwen-voice.ts:144-209`),
shared by the JSON `design-voice` route and the SSE bulk "Design full cast"
job.** It does not touch `cast-design.ts`'s base-voice path
(`applyOverrideToCastFiles`), `cast-link-prior.ts`, or the `voiceUuid`
double-mint — those remain exactly as open as #2006's history already
recorded them.

## The problem, restated after reading the current code

The issue as filed frames this as one TOCTOU gap (read-then-decide in one
scope, write in another). Reading the code surfaces a second, independent gap
in the same function that the write-time fix below closes for free:

1. **TOCTOU.** Both callers check `characterHasClonedSlot` once, before the
   (slow) GPU design call, then call `persistEmotionVariant` afterward with no
   re-check. A clone can land on the character during GPU synthesis and the
   stale decision persists anyway.
2. **Propagation never checks clone status per target book at all.**
   `persistEmotionVariant`'s `seriesFilter` branch propagates the variant to
   every linked-cast character across the series via
   `forEachMatchingCastCharacter`'s mutate closure (`qwen-voice.ts:186-188`),
   unconditionally. Only the *originating* book's character was ever checked
   (once, by the caller, upfront) — a sibling book where the same linked
   character carries its own independent cloned slot gets the variant applied
   regardless.

A per-book write-time predicate re-check, done the way the `voices.ts` sibling
does it, fixes both: it closes the TOCTOU window, and because it runs inside
the walker's mutate closure it naturally re-evaluates *each* target book's own
current clone status rather than the source's.

## The decision this spec finalizes

**Signal shape: return-value tracking, not a thrown error** — matching the
`voices.ts` sibling exactly, for the same reason: neither caller needs to
unwind normal control flow to react to a refusal, and a new error class would
be one more entry in this file's already-dense error-mapping surface.

`persistEmotionVariant` changes from `Promise<void>` to:

```ts
Promise<{ applied: boolean; skippedClone: boolean }>
```

`applied`/`skippedClone` reflect **only the caller's own `(bookDir,
characterId)`** — not the aggregate across the whole series propagation. This
mirrors the `single-design.ts` sibling's collapse-to-single-book approach:
neither caller here has (or needs) infrastructure to report per-linked-book
detail; each only acts on its own book's outcome.

**Bulk-job skip channel: reused, not new.** When the SSE job's write-time
re-check catches a clone that appeared during GPU synthesis, it reports
through the *exact same* channel as today's upfront skip —
`job.skipped += 1; job.clonedSkips.push({characterId, name}); broadcast(job,
{type: 'character_skipped', characterId, name, reason: 'already_cloned'})` —
not a new reason or counter. The user-visible meaning ("this character kept
its clone, no variant applied") is identical whether the clone was caught
before or after the wasted GPU work.

## Mechanism

### Book-scoped branch (no `seriesFilter`, `qwen-voice.ts:200-208`)

Already re-reads fresh inside its own `withCastLock`. Add a
`characterHasClonedSlot(freshCharacter)` re-check immediately before
`addVariant`. On a positive: skip the write entirely (no idempotent-rewrite
concern here, unlike the shared-walker branch below — there is no walker
forcing an unconditional write in this branch), and return `{applied: false,
skippedClone: true}`.

### Series branch (`forEachMatchingCastCharacter`, `qwen-voice.ts:168-189`)

Do **not** change `forEachMatchingCastCharacter`'s shared signature — same
reasoning as the `voices.ts` sibling: it is also used by
`applyOverrideToCastFiles` and `ensureCharacterVoiceUuid`'s `stamp`, neither of
which has anything to do with clone-consent, and round 2 of that sibling's
review found a `guard`-parameter approach on the shared walker entangled
those unrelated callers.

Wrap the mutate closure passed into the walker:

```ts
const skipped: Array<{ bookDir: string; characterId: string; reason: string }> = [];
await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c, bookDir) => {
  if (characterHasClonedSlot(c)) {
    skipped.push({ bookDir, characterId: c.id, reason: 'already_cloned' });
    return c; // unchanged — harmless idempotent rewrite, same as the voices.ts sibling
  }
  return addVariant(c, baseVoiceId);
});
```

(Note: `forEachMatchingCastCharacter`'s mutate signature is currently
`(character: CastCharacter) => CastCharacter` and does not pass `bookDir` to
the closure. This spec's closure needs it to build the `skipped` entries. The
implementation task must check whether the closure can capture `bookDir` from
its own enclosing loop some other way, or whether the walker needs a minimal,
backward-compatible signature extension — e.g. an optional second callback
parameter — that the two *other* callers can simply ignore. Either resolution
is acceptable; picking one is implementation, not a design decision, since it
doesn't change either caller's observable behaviour.)

After the walk, `persistEmotionVariant` determines its own return value by
checking whether `(bookDir, characterId)` — its own parameters — appear in
`skipped`:

```ts
const own = skipped.find((s) => s.bookDir === bookDir && s.characterId === characterId);
return { applied: !own, skippedClone: !!own };
```

### JSON route (`qwen-voice.ts:683`)

```ts
const result = await persistEmotionVariant(bookDir, characterId, emotion, voiceId, seriesInfo ?? undefined);
if (result.skippedClone) {
  return res.status(409).json({ error: clonedVariantRefusal(character.name ?? characterId), code: 'clone_protected' });
}
```

Same message/code as the existing upfront check at line 612 — this makes it
reachable at write time too, instead of the current silent no-recheck.

### SSE bulk job (`cast-design.ts:555`)

```ts
const result = await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
if (result.skippedClone) {
  job.skipped += 1;
  job.clonedSkips.push({ characterId, name: character.name ?? characterId });
  broadcast(job, { type: 'character_skipped', characterId, name: character.name ?? characterId, reason: 'already_cloned' });
} else {
  job.done += 1;
  broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
    ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
}
```

## What this does not claim

- No cross-book atomicity for the propagation as a whole. A concurrent
  redesign of the *source* character between `persistEmotionVariant`'s
  unlocked outer read (`qwen-voice.ts:185`, `baseVoiceId`) and a given target
  book's write still propagates the OLD key — this is the existing `I4`
  staleness window, already tracked on #2006, not addressed here.
- Does not address `cast-design.ts`'s base-voice path
  (`applyOverrideToCastFiles`), `cast-link-prior.ts`, or the `voiceUuid`
  double-mint.
- Does not change `#2000` §3.2's lock-granularity decision.

## Noted, not fixed here — a gap in the `voices.ts` sibling design

`applyOverrideToCastFiles` (`voices.ts:875`, current signature
`Promise<number>`) has a **third call site** the sibling design doc
(`2026-08-22-clone-consent-voices-override-refusal-design.md`) does not
account for: `cast-design.ts:544`, the SSE bulk job's own base-voice path. That
doc lists only `voices.ts:731` and `single-design.ts:179` as call sites needing
the signature-change update. When that sibling spec is implemented,
`cast-design.ts:544` will need the same `{updated, skipped}`-aware handling
this spec gives `persistEmotionVariant`'s call sites — otherwise it silently
narrows to reading a stale `number` shape (or a type error, depending on how
the signature changes). Flagging here since this design pass is what surfaced
it; the sibling spec's author should decide whether to amend that document or
handle it as an implementation-time addendum.

## Testing

Paired tests for `persistEmotionVariant`:

1. Book-scoped, no clone — `applied: true`, `skippedClone: false`, variant
   slot recorded.
2. Book-scoped, clone injected between the function's entry and its own
   `withCastLock` re-read (direct cast.json manipulation inside the lock
   window, not before the call starts) — `applied: false, skippedClone: true`,
   no field mutation.
3. Series-scoped, two+ linked books, no clones — both get the variant,
   `applied: true` for the caller's own book.
4. Series-scoped, clone injected into a **different** linked book (not the
   caller's own) between the walk's start and that book's own write — that
   book's write is skipped (verify via direct read of that book's cast.json
   after the call), while the caller's own book still gets `applied: true` —
   proves the per-book independence gap (problem #2 above) is closed, not just
   the TOCTOU window.
5. Series-scoped, clone injected into the caller's OWN linked book — `applied:
   false, skippedClone: true` for the caller.
6. Mutation-verified: deleting the write-time predicate re-check in either
   branch must turn tests 2/4/5 red (the clone gets silently overwritten
   instead of skipped), with the observed failure output captured.

Paired tests for the two call sites:

7. JSON route: mock `persistEmotionVariant` to return `skippedClone: true` —
   assert 409 `clone_protected` with the existing `clonedVariantRefusal`
   message.
8. SSE bulk job: mock the same — assert `job.skipped` incremented,
   `job.clonedSkips` gains the entry, and the broadcast event matches the
   existing upfront-skip shape exactly (same `type`/`reason` fields) so the
   frontend's existing handling (`src/store/cast-design-stream-middleware.ts`)
   needs no changes.
