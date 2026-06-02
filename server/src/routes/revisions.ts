/* GET /api/books/:bookId/revisions
   Reads each chapter's `<slug>.segments.json` and diffs the captured
   character snapshots against the current cast.json. Emits drift events
   for hard signals (voice / engine / gender / ageRange changed) and for
   meaningful tone deltas (warmth/pace/authority/emotion). Dismissed event
   ids — persisted under `revisions.json` by the frontend's dismissDrift
   reducer — are filtered out so a poll after a dismiss doesn't re-surface
   the same event.

   `pending` revisions (regen-modal-driven A/B diffs) are not produced by
   this detector. They're written to `revisions.json` by the regen flow on
   the frontend and surfaced verbatim. Keeping the two streams separate
   means a chapter with a severe drift event doesn't automatically queue a
   regen — the user still chooses. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { castJsonPath, revisionsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findBookByBookId } from '../workspace/scan.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { pickVoiceForEngine } from '../tts/voice-mapping.js';
import { toVoiceLike, buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import type { TtsEngine } from '../tts/index.js';
import { loadSegmentsFiles, type CharacterSnapshot } from '../audio/segments-io.js';

/* CastCharacter is imported from synthesise-chapter.ts (plan 108 R5) so the
   resolved-voice drift comparison below can reuse toVoiceLike +
   buildHintFromCast on the live cast row — it needs the override / evidence /
   ttsEngine fields the old narrow local shape lacked. */

interface RevisionsPersisted {
  pending?: unknown[];
  drift?: unknown[];
  /** Drift event ids the user has dismissed. Persisted by the frontend so
      a dismiss survives a reload. The detector treats them as a denylist —
      a dismissed event will not be re-emitted even if the underlying signal
      still holds. To "un-dismiss", the user regenerates the chapter (which
      will eventually overwrite the snapshot via a future synthesis). */
  dismissed?: string[];
}

interface DriftEvent {
  id: string;
  /** Book the event belongs to. Stamped at emit time from the route
      param so the Drift Report modal can group events from multiple
      concurrently-active books in a single flat list. */
  bookId: string;
  characterId: string;
  chapterId: number;
  /** Chapter title embedded at emit time. Lets the Drift Report modal
      label rows without joining against the frontend's chapters slice
      (single-book-scoped, but drift may span books). Falls back to the
      chapter-scan title and finally to "Chapter N". */
  chapterTitle: string;
  severity: 'mild' | 'moderate' | 'severe';
  factor: string;
  factorLabel: string;
  description: string;
  /** True when severity === 'severe'. Drives the Drift Report's
      one-click "Auto-regen now" affordance — the frontend bypasses the
      regen-modal confirmation and dispatches regenerateCharacter
      directly. Stays optional / absent on moderate + mild events. */
  autoQueueable?: boolean;
  metrics?: { current: number; expected: number; unit: string };
  /** The CharacterSnapshot recorded at chapter-render time. Diffed by
      the modal against `current` to render a side-by-side "When
      rendered / Now" comparison. Mirrors the on-disk snapshot. */
  snapshot: CharacterSnapshot;
  /** The live cast profile for the character at poll time. Carried on
      the event so the modal can render comparison cards even for
      events belonging to non-active books (whose cast isn't in the
      frontend's cast slice). */
  current: {
    name?: string;
    voiceId?: string;
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
    attributes?: string[];
  };
  detected: string;
  suggestedAction: string;
}

/* Tone-metric thresholds (matches the plan's "balanced" sensitivity). The
   user-confirmed cut: anything below 25 is noise; 25–40 is a meaningful
   drift the listener might notice; >40 is a rewrite. Hard signals (voice /
   engine / gender / ageRange) are always severe — those listen as a
   different person regardless of magnitude. */
const TONE_MODERATE = 25;
const TONE_SEVERE = 40;

const TONE_KEYS = ['warmth', 'pace', 'authority', 'emotion'] as const;
type ToneKey = (typeof TONE_KEYS)[number];

const TONE_LABELS: Record<ToneKey, string> = {
  warmth: 'Warmth',
  pace: 'Pace',
  authority: 'Authority',
  emotion: 'Emotion',
};

export const revisionsRouter = Router();

/* Plan 83 — per-book revisions computation, extracted from the single-book
   route so both that route AND the new bulk `GET /api/revisions?bookIds=...`
   endpoint can share one codepath. Returns `null` when the book doesn't
   exist on disk (caller decides whether to 404 or skip it in a fan-out). */
export async function getRevisionsForBook(
  bookId: string,
): Promise<{ pending: never[]; drift: DriftEvent[] } | null> {
  const located = await findBookByBookId(bookId);
  if (!located) return null;
  const { bookDir, state } = located;

  const castFile = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
  const cast: CastCharacter[] = castFile?.characters ?? [];
  if (cast.length === 0) {
    // No cast confirmed yet — nothing to compare against.
    return { pending: [], drift: [] };
  }
  const castById = new Map(cast.map((c) => [c.id, c]));

  const persisted = await readJson<RevisionsPersisted>(revisionsJsonPath(bookDir));
  const dismissed = new Set(Array.isArray(persisted?.dismissed) ? persisted!.dismissed! : []);

  const segmentsByChapter = await loadSegmentsFiles(bookDir, state.chapters);
  /* Build a chapterId -> scan title fallback map once. `seg.chapterTitle`
     wins when populated (older segments files may omit it); state.chapters
     is the next-best source; "Chapter N" is the floor. */
  const scanTitleById = new Map<number, string>();
  for (const ch of state.chapters) scanTitleById.set(ch.id, ch.title);
  const drift: DriftEvent[] = [];

  for (const seg of segmentsByChapter) {
    const chapterTitle =
      seg.chapterTitle?.trim() ||
      scanTitleById.get(seg.chapterId)?.trim() ||
      `Chapter ${seg.chapterId}`;
    const snapshots = seg.characterSnapshots ?? {};
    for (const [characterId, snapshot] of Object.entries(snapshots)) {
      const current = castById.get(characterId);
      if (!current) continue; // character removed from cast — nothing actionable here
      const detectedAt = seg.synthesizedAt ?? new Date().toISOString();
      const ctx = {
        bookId,
        chapterId: seg.chapterId,
        chapterTitle,
        characterId,
        snapshot,
        current,
        detectedAt,
      };
      /* Engine drift (plan 108): the character's resolved engine changed since
         this chapter rendered (e.g. Maerin moved from Kokoro to Qwen). Use the
         rendered engine as the fallback default so a character with no explicit
         ttsEngine and an unchanged engine doesn't false-fire. */
      const renderedEngine = (snapshot.voiceEngine as TtsEngine | undefined) ?? 'kokoro';
      const currentEngine = resolveCharacterEngine(current, renderedEngine);
      if (snapshot.voiceEngine) {
        pushHardDrift(drift, ctx, 'engine', 'Engine', snapshot.voiceEngine, currentEngine);
      }
      /* Voice drift: prefer the resolved voice NAME (catches an override-only
         change that keeps voiceId constant — the rebaseline / per-character
         picker case), falling back to voiceId for pre-108 snapshots that have
         no resolvedVoiceName. */
      if (snapshot.resolvedVoiceName) {
        const currentName = pickVoiceForEngine(
          currentEngine,
          toVoiceLike(current),
          buildHintFromCast(current),
        );
        pushHardDrift(drift, ctx, 'voice', 'Voice', snapshot.resolvedVoiceName, currentName);
      } else {
        pushHardDrift(drift, ctx, 'voice', 'Voice', snapshot.voiceId, current.voiceId);
      }
      pushHardDrift(drift, ctx, 'gender', 'Gender', snapshot.gender, current.gender);
      pushHardDrift(drift, ctx, 'ageRange', 'Age range', snapshot.ageRange, current.ageRange);
      for (const key of TONE_KEYS) {
        pushToneDrift(drift, ctx, key);
      }
      pushAttributesDrift(drift, ctx);
    }
  }

  const filtered = drift.filter((d) => !dismissed.has(d.id));
  return { pending: [], drift: filtered };
}

revisionsRouter.get('/:bookId/revisions', async (req: Request, res: Response) => {
  try {
    const result = await getRevisionsForBook(req.params.bookId);
    if (!result) return res.status(404).json({ error: 'Book not found.' });
    res.json(result);
  } catch (e) {
    console.error('[revisions] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to compute revisions.' });
  }
});

/* Plan 83 — bulk endpoint for background-drift fan-out across non-active
   books. Frontend's two-tier poller (active book on 30s tick, non-active
   books on 120s tick) calls this with the cross-book id list; the response
   is keyed by bookId so the slice's applyPoll cascade fires per-book. Skips
   bookIds that don't exist on disk (no 404 — just omitted from response) so
   one removed book doesn't take down the whole poll. Lives on its own
   Router instance because it's mounted at `/api` (not `/api/books`). */
export const revisionsBulkRouter = Router();
revisionsBulkRouter.get('/revisions', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.bookIds ?? '');
    const bookIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (bookIds.length === 0) {
      return res.status(400).json({ error: 'bookIds query param is required (comma-separated)' });
    }
    if (bookIds.length > 50) {
      return res.status(400).json({ error: 'Up to 50 bookIds per request' });
    }
    const entries = await Promise.all(
      bookIds.map(async (id) => [id, await getRevisionsForBook(id)] as const),
    );
    const byBookId: Record<string, { pending: never[]; drift: DriftEvent[] }> = {};
    for (const [id, result] of entries) {
      if (result) byBookId[id] = result;
    }
    res.json({ byBookId });
  } catch (e) {
    console.error('[revisions] bulk GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to compute bulk revisions.' });
  }
});

interface DriftContext {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  characterId: string;
  snapshot: CharacterSnapshot;
  current: CastCharacter;
  detectedAt: string;
}

/* Projection of the comparison context shared by every emit site so the
   modal renders a self-sufficient side-by-side card. Built once per
   emit; helpers spread it into the event. */
function comparisonFields(
  ctx: DriftContext,
): Pick<DriftEvent, 'bookId' | 'chapterTitle' | 'snapshot' | 'current'> {
  return {
    bookId: ctx.bookId,
    chapterTitle: ctx.chapterTitle,
    snapshot: ctx.snapshot,
    current: {
      name: ctx.current.name,
      voiceId: ctx.current.voiceId,
      gender: ctx.current.gender,
      ageRange: ctx.current.ageRange,
      tone: ctx.current.tone,
      attributes: ctx.current.attributes,
    },
  };
}

/* Severe drift = the listener will hear "different person". The frontend
   surfaces these with a one-click "Auto-regen now" button. Keep the
   `severity === 'severe'` rule in this one helper so future severity
   tweaks update both the emit sites and the autoQueueable flag at the
   same time. */
function autoQueueableFor(severity: DriftEvent['severity']): boolean | undefined {
  return severity === 'severe' ? true : undefined;
}

function pushHardDrift(
  out: DriftEvent[],
  ctx: DriftContext,
  factor: 'voice' | 'engine' | 'gender' | 'ageRange',
  factorLabel: string,
  before: string | undefined,
  after: string | undefined,
): void {
  /* Skip when either side is absent: a missing snapshot field means the
     synthesis run didn't capture it (older segments file), and a missing
     current value means the cast doesn't carry it (e.g. ageRange unset).
     We can't honestly call that drift. */
  if (before === undefined || after === undefined) return;
  if (before === after) return;
  out.push({
    id: driftId(ctx, factor),
    characterId: ctx.characterId,
    chapterId: ctx.chapterId,
    severity: 'severe',
    factor,
    factorLabel,
    description: `${factorLabel} changed from "${before}" to "${after}" after this chapter rendered.`,
    autoQueueable: autoQueueableFor('severe'),
    detected: ctx.detectedAt,
    suggestedAction: 'regenerate_chapter',
    ...comparisonFields(ctx),
  });
}

/* Attribute-set drift. Compares lowercase-normalised sets so case-only
   changes don't fire; computes the symmetric difference and surfaces
   one event listing the added + removed terms. Severity is moderate,
   not severe — attributes don't change voiceId outright but DO steer
   the prebuilt-voice picker on future regenerations, so the user
   should be nudged to regenerate if they care about audio matching the
   new description. Severe would be appropriate if every prior attribute
   was wiped out, but in practice the override merges with union
   semantics so total wipes are rare; keep the threshold simple until a
   real false-positive shows up. */
function pushAttributesDrift(out: DriftEvent[], ctx: DriftContext): void {
  const before = ctx.snapshot.attributes;
  const after = ctx.current.attributes;
  if (!Array.isArray(before) || !Array.isArray(after)) return; // no signal
  const beforeSet = new Set(before.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const afterSet = new Set(after.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  for (const s of afterSet) if (!beforeSet.has(s)) added.push(s);
  for (const s of beforeSet) if (!afterSet.has(s)) removed.push(s);
  if (added.length === 0 && removed.length === 0) return;
  const parts: string[] = [];
  if (added.length) parts.push(`added ${formatList(added)}`);
  if (removed.length) parts.push(`removed ${formatList(removed)}`);
  out.push({
    id: driftId(ctx, 'attributes'),
    characterId: ctx.characterId,
    chapterId: ctx.chapterId,
    severity: 'moderate',
    factor: 'attributes',
    factorLabel: 'Attributes',
    description: `Attributes ${parts.join('; ')} after this chapter rendered. Prebuilt-voice picker may now resolve to a different voice on regenerate.`,
    detected: ctx.detectedAt,
    suggestedAction: 'regenerate_chapter',
    ...comparisonFields(ctx),
  });
}

function formatList(items: string[]): string {
  if (items.length === 1) return `"${items[0]}"`;
  if (items.length === 2) return `"${items[0]}" and "${items[1]}"`;
  return (
    items
      .slice(0, -1)
      .map((s) => `"${s}"`)
      .join(', ') + `, and "${items[items.length - 1]}"`
  );
}

function pushToneDrift(out: DriftEvent[], ctx: DriftContext, key: ToneKey): void {
  const before = ctx.snapshot.tone?.[key];
  const after = ctx.current.tone?.[key];
  if (typeof before !== 'number' || typeof after !== 'number') return;
  const delta = Math.abs(after - before);
  if (delta < TONE_MODERATE) return;
  const severity: 'moderate' | 'severe' = delta >= TONE_SEVERE ? 'severe' : 'moderate';
  out.push({
    id: driftId(ctx, key),
    characterId: ctx.characterId,
    chapterId: ctx.chapterId,
    severity,
    factor: key,
    factorLabel: TONE_LABELS[key],
    description: `${TONE_LABELS[key]} drifted ${Math.round(delta)} points (was ${before}, now ${after}).`,
    autoQueueable: autoQueueableFor(severity),
    metrics: { current: after, expected: before, unit: 'points' },
    detected: ctx.detectedAt,
    suggestedAction: 'regenerate_chapter',
    ...comparisonFields(ctx),
  });
}

function driftId(
  ctx: { bookId: string; chapterId: number; characterId: string },
  factor: string,
): string {
  /* bookId in the prefix keeps event ids globally unique across
     concurrently-active books — chapterId+characterId+factor can
     collide for different books with parallel-numbered chapters and
     shared narrator id. */
  return `drift:${ctx.bookId}:${ctx.chapterId}:${ctx.characterId}:${factor}`;
}
