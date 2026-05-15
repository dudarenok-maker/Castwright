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

import { Router, type Request, type Response } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { audioDir, castJsonPath, revisionsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findBookByBookId } from '../workspace/scan.js';

interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  /** Attribute list captured at synthesis time, sorted by
      generation.ts. Compared against the current cast's attributes —
      any non-empty symmetric difference fires a moderate-severity drift
      event because attributes drive prebuilt-voice selection. */
  attributes?: string[];
}

interface SegmentsFile {
  chapterId: number;
  chapterTitle?: string;
  synthesizedAt?: string;
  characterSnapshots?: Record<string, CharacterSnapshot>;
}

interface CastCharacter {
  id: string;
  name?: string;
  voiceId?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  attributes?: string[];
}

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
  characterId: string;
  chapterId: number;
  severity: 'mild' | 'moderate' | 'severe';
  factor: string;
  factorLabel: string;
  description: string;
  metrics?: { current: number; expected: number; unit: string };
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
type ToneKey = typeof TONE_KEYS[number];

const TONE_LABELS: Record<ToneKey, string> = {
  warmth: 'Warmth',
  pace: 'Pace',
  authority: 'Authority',
  emotion: 'Emotion',
};

export const revisionsRouter = Router();

revisionsRouter.get('/:bookId/revisions', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const castFile = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
    const cast: CastCharacter[] = castFile?.characters ?? [];
    if (cast.length === 0) {
      // No cast confirmed yet — nothing to compare against.
      return res.json({ pending: [], drift: [] });
    }
    const castById = new Map(cast.map(c => [c.id, c]));

    const persisted = await readJson<RevisionsPersisted>(revisionsJsonPath(bookDir));
    const dismissed = new Set(Array.isArray(persisted?.dismissed) ? persisted!.dismissed! : []);

    const segmentsByChapter = await loadSegmentsFiles(bookDir, state.chapters);
    const drift: DriftEvent[] = [];

    for (const seg of segmentsByChapter) {
      const snapshots = seg.characterSnapshots ?? {};
      for (const [characterId, snapshot] of Object.entries(snapshots)) {
        const current = castById.get(characterId);
        if (!current) continue;          // character removed from cast — nothing actionable here
        const detectedAt = seg.synthesizedAt ?? new Date().toISOString();
        const ctx = { chapterId: seg.chapterId, characterId, snapshot, current, detectedAt };
        /* No engine-drift factor: engine isn't stored in cast.json (it's per-
           generation, set on the Generate view), so there's no current value
           to compare against. A voiceId swap covers the cross-engine case in
           practice — voice ids are engine-scoped. */
        pushHardDrift(drift, ctx, 'voice', 'Voice',
          snapshot.voiceId, current.voiceId);
        pushHardDrift(drift, ctx, 'gender', 'Gender',
          snapshot.gender, current.gender);
        pushHardDrift(drift, ctx, 'ageRange', 'Age range',
          snapshot.ageRange, current.ageRange);
        for (const key of TONE_KEYS) {
          pushToneDrift(drift, ctx, key);
        }
        pushAttributesDrift(drift, ctx);
      }
    }

    const filtered = drift.filter(d => !dismissed.has(d.id));
    res.json({ pending: [], drift: filtered });
  } catch (e) {
    console.error('[revisions] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to compute revisions.' });
  }
});

interface DriftContext {
  chapterId: number;
  characterId: string;
  snapshot: CharacterSnapshot;
  current: CastCharacter;
  detectedAt: string;
}

function pushHardDrift(
  out: DriftEvent[],
  ctx: DriftContext,
  factor: 'voice' | 'gender' | 'ageRange',
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
    detected: ctx.detectedAt,
    suggestedAction: 'regenerate_chapter',
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
  const after  = ctx.current.attributes;
  if (!Array.isArray(before) || !Array.isArray(after)) return;   // no signal
  const beforeSet = new Set(before.map(s => s.trim().toLowerCase()).filter(Boolean));
  const afterSet  = new Set(after.map(s => s.trim().toLowerCase()).filter(Boolean));
  const added: string[]   = [];
  const removed: string[] = [];
  for (const s of afterSet)  if (!beforeSet.has(s)) added.push(s);
  for (const s of beforeSet) if (!afterSet.has(s))  removed.push(s);
  if (added.length === 0 && removed.length === 0) return;
  const parts: string[] = [];
  if (added.length)   parts.push(`added ${formatList(added)}`);
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
  });
}

function formatList(items: string[]): string {
  if (items.length === 1) return `"${items[0]}"`;
  if (items.length === 2) return `"${items[0]}" and "${items[1]}"`;
  return items.slice(0, -1).map(s => `"${s}"`).join(', ') + `, and "${items[items.length - 1]}"`;
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
    metrics: { current: after, expected: before, unit: 'points' },
    detected: ctx.detectedAt,
    suggestedAction: 'regenerate_chapter',
  });
}

function driftId(ctx: { chapterId: number; characterId: string }, factor: string): string {
  return `drift:${ctx.chapterId}:${ctx.characterId}:${factor}`;
}

async function loadSegmentsFiles(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<SegmentsFile[]> {
  const root = audioDir(bookDir);
  if (!existsSync(root)) return [];
  const filesOnDisk = new Set<string>();
  try {
    for (const f of readdirSync(root)) {
      if (f.endsWith('.segments.json')) filesOnDisk.add(f);
    }
  } catch { return []; }

  const out: SegmentsFile[] = [];
  for (const ch of chapters) {
    const fileName = `${ch.slug}.segments.json`;
    if (!filesOnDisk.has(fileName)) continue;
    const seg = await readJson<SegmentsFile>(`${root}/${fileName}`).catch(() => null);
    if (seg && typeof seg.chapterId === 'number') out.push(seg);
  }
  return out;
}
