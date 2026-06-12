/* Post-stage-2 normalisation: fold "background-only" characters into
   two generic buckets — `unknown-male` and `unknown-female` — so the
   cast roster doesn't accumulate a one-off voice profile per
   "Unknown Jogger" / "Unknown Intruder" / throwaway named bystander.

   Two trigger conditions, OR-combined:
     - Name matches a descriptor-as-name pattern (see `isDescriptorName`).
       The Stage-1 prompt tells the model to use "Unknown <descriptor>"
       for nameless speakers, but in practice the model also slips in
       descriptor forms it wasn't told to ("The Jogger", "Drooly Boy",
       "Old Man"). Treat all of these as the same kind of background
       speaker — they have no proper name, so they don't warrant their
       own voice slot.
     - Attributed line count is below `minLines`. Even a named character
       who speaks once or twice doesn't warrant its own voice profile —
       bake them into a generic bucket so library matching and voice-clone
       budget go to characters who actually carry the book.

   Bucket selection by `gender`:
     - 'female' → `unknown-female`
     - anything else (male / neutral / missing) → `unknown-male`
   Folded characters are NEVER rolled into the narrator — the user wants
   background speakers to keep their own (shared) voice, not be read as
   prose. Gender-ambiguous folds default to `unknown-male`; the user can
   re-merge to the female bucket manually if the gender call was wrong.

   Narrator itself is NEVER folded regardless of line count.

   The function is pure: it returns the rewritten character list +
   sentence list. The analysis route runs it on the assembled
   stage-1 + sentence outputs just before composing the AnalyseResponse,
   so the cache (which holds the unfolded ground truth) is untouched and
   the fold rules can be tuned without invalidating in-flight progress. */

import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';
import { taggedSpeakerIds } from './recover-tagged-lines.js';

export interface FoldOptions {
  /** A character whose attributed line count is strictly below this
      number is folded. Default 3 — i.e. anyone with 0, 1, or 2 lines
      becomes part of the bucket. The user's framing in CLAUDE.md was
      "no point creating a voice profile for someone who may only say 2
      things in the whole book". */
  minLines?: number;
  /** When true, only the descriptor-name trigger fires; the line-count
      threshold and the zero-line drop are both skipped. Used at the
      interim-cast write before stage-2 attribution exists — without
      sentence data, every character has 0 lines and would otherwise
      fall through to either the bucket or the drop set, neither of
      which is correct mid-Phase-0. The final post-stage-2 pass runs
      without this flag to apply the full set of rules. */
  nameOnly?: boolean;
  /** Roles whose narrator-only-detected characters are exempt from the
      line-count fold AND the zero-line drop. Default
      `PROTECTED_ROLES_DEFAULT`. Match is case-insensitive substring —
      `'Goblin Bodyguard'` matches the `'Bodyguard'` entry, `'Family
      Member (mother)'` matches `'Family Member'`. The protection only
      fires when `c.detectionSource === 'narrator-mention'` AND the
      role matches, so a chatty bodyguard with `detectionSource:
      'dialogue'` + 1 line still folds (the protection is targeted at
      narrator-mention characters, not blanket role-keep). Reason for
      the protection: bodyguards / mentors / family who are mentioned
      heavily in narration but rarely quote dialogue (e.g. Sela and
      Garrow in Lost Cities Saltgrave — see
      docs/features/archive/97-narrator-only-named-characters.md) would
      otherwise be silently dropped or bucketed into
      unknown-male/female. */
  protectedRoles?: string[];
}

export interface FoldResult {
  characters: CharacterOutput[];
  sentences: SentenceOutput[];
  /** Old character-id → new character-id for every fold applied. */
  rewrites: Record<string, string>;
  /** Human-readable summary of what was folded, for the analysing-view log. */
  summary: { foldedCount: number; intoMale: number; intoFemale: number; droppedSilent: number };
  /** Characters dropped entirely (not folded) because they have zero
      attributed sentences after stage 2. These are typically pets,
      animals, or non-speaking entities the per-chapter detection prompt
      slipped onto the roster. Names are returned so the route layer can
      log what got pruned. */
  dropped: string[];
}

const MIN_LINES_DEFAULT = 3;

/* Default roles that are exempt from the line-count fold + zero-line drop
   when detectionSource === 'narrator-mention'. See FoldOptions.protectedRoles
   for the matching rule (case-insensitive substring). Kept narrow on
   purpose: roles that are canonical scene presence but produce minimal
   dialogue. Extending this list adds protected categories — only add when
   real corpus data shows a class of character being silently erased. */
export const PROTECTED_ROLES_DEFAULT = ['Bodyguard', 'Mentor', 'Family Member'];

export const MALE_BUCKET_ID = 'unknown-male';
export const FEMALE_BUCKET_ID = 'unknown-female';
const NARRATOR_ID = 'narrator';

/* Returns true if `role` matches any entry in `protectedRoles` via
   case-insensitive substring. `'Goblin Bodyguard'` matches `'Bodyguard'`;
   `'Family Member (mother)'` matches `'Family Member'`. Empty list or
   missing role yields false. Exported for the test. */
export function matchesProtectedRole(role: string | undefined, protectedRoles: string[]): boolean {
  if (!role) return false;
  const normalised = role.toLowerCase();
  return protectedRoles.some((protectedRole) => normalised.includes(protectedRole.toLowerCase()));
}

/* Generic-role nouns that, when they appear as the LAST word of a
   character name preceded by at least one other word, indicate a
   descriptor rather than a proper name: "Drooly Boy", "Old Man",
   "Tall Woman". A bare "Boy" / "Man" alone is also descriptive but
   rarely emitted by the model — those would be caught by the
   line-count threshold downstream. Kept narrow on purpose: a future
   "<adj> Doctor" / "<adj> Captain" extension is easy if observed in
   real runs. */
const GENERIC_ROLE_TAIL = new Set([
  'boy',
  'girl',
  'man',
  'woman',
  'guy',
  'lady',
  'kid',
  'person',
  'figure',
  'stranger',
  'voice',
]);

/* Decides whether a character's `name` reads as a descriptor rather
   than a proper name. The three patterns we catch in order:
     1. `^Unknown\b...` — the Stage-1 contract ("Unknown <descriptor>"
        for nameless speakers). Stable across analyzer engines.
     2. `^The <Word>($| <Word>$)` — definite-article-led descriptor.
        Models routinely emit "The Jogger", "The Stranger", "The
        Shopkeeper" in spite of the Stage-1 instruction. Capped at
        two words after "The" so multi-word proper titles
        ("The Council of Twelve", "The Forbidden Cities") don't get
        folded — those are usually places, not speakers, and the
        skill drops them anyway.
     3. Trailing generic-role word ("Drooly Boy", "Old Man",
        "Ponytail Girl"). Requires at least one word before the
        role tail so a bare proper name that happens to be a role
        ("Boy" used as a nickname) doesn't get folded.
   Trim + lowercase normalisation up front so the model's casing
   choices don't matter. */
export function isDescriptorName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (/^unknown\b/i.test(trimmed)) return true;
  if (/^the\s+\S+(\s+\S+)?$/i.test(trimmed)) return true;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1].toLowerCase();
    if (GENERIC_ROLE_TAIL.has(tail)) return true;
  }
  return false;
}

function pickBucket(c: CharacterOutput): string {
  /* Female only when the analyzer explicitly tagged it; everything else
     (male, neutral, missing) goes to the male bucket. The user wants
     two distinct background characters with no narrator fallback, so
     ambiguous folds bias toward male; a manual merge can flip them. */
  return c.gender === 'female' ? FEMALE_BUCKET_ID : MALE_BUCKET_ID;
}

export function makeBucket(id: string, gender: 'male' | 'female'): CharacterOutput {
  const label = gender === 'male' ? 'male' : 'female';
  const title = gender === 'male' ? 'Unknown male' : 'Unknown female';
  return {
    id,
    name: title,
    role: 'background',
    color: 'narrator',
    gender,
    description:
      `Composite voice covering one-off ${label} bystanders, ` +
      `intruders, joggers, and similar background speakers who only have ` +
      `a handful of lines. Folded automatically at analysis time so they ` +
      `share a single generic voice instead of consuming one cast slot each.`,
    aliases: [],
  };
}

export function foldMinorCast(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  opts: FoldOptions = {},
): FoldResult {
  const minLines = opts.minLines ?? MIN_LINES_DEFAULT;
  const nameOnly = opts.nameOnly === true;
  const protectedRoles = opts.protectedRoles ?? PROTECTED_ROLES_DEFAULT;

  /* Count attributed lines per character id. In nameOnly mode the count
     is unused (line-count rules are off) — keep the map empty rather
     than walking the sentence list. */
  const lineCount = new Map<string, number>();
  if (!nameOnly) {
    for (const s of sentences) {
      lineCount.set(s.characterId, (lineCount.get(s.characterId) ?? 0) + 1);
    }
  }

  /* Speakers the prose explicitly tags (`"…," Behnam noted.`). A 0-line such
     speaker is a stage-2 attribution failure, NOT a non-speaker — keep them
     instead of dropping (#537), so a roster-recovered character that couldn't
     get its quote flipped still persists in the cast. nameOnly mode skips the
     zero-line drop entirely, so the scan isn't needed there. */
  const proseTagged = nameOnly ? new Set<string>() : taggedSpeakerIds(sentences, characters);

  /* Decide who folds, who drops, and where. Narrator is exempt from both.
     A character with zero attributed sentences in this run is dropped
     entirely — they never speak, so the narrator covers any narration
     that references them. This is the backstop against the per-chapter
     detection prompt slipping pets, animals, or other non-speakers onto
     the roster. Characters with 1..(minLines-1) lines still fold into
     the unknown-male/female buckets (existing behaviour) so a single
     one-off bystander doesn't get its own voice profile. In nameOnly
     mode neither the line-count fold nor the zero-line drop fires —
     only the descriptor-name fold remains active.

     Protected-role exemption: when `c.detectionSource === 'narrator-mention'`
     AND `c.role` matches `protectedRoles`, the character bypasses BOTH the
     zero-line drop and the <minLines fold — the descriptor-name fold still
     applies (a "Tall Bodyguard" with detectionSource: narrator-mention
     still reads as a descriptor and folds). Reason: canonical-but-rarely-
     quoted bodyguards / mentors / family otherwise get silently erased.
     The protection is targeted, not blanket: a bodyguard with
     detectionSource: 'dialogue' + 1 line still folds, because that's
     a real dialogue character who genuinely has too few lines for a
     voice profile. */
  const rewrites: Record<string, string> = {};
  const foldedSources: CharacterOutput[] = [];
  const droppedIds = new Set<string>();
  const droppedNames: string[] = [];
  for (const c of characters) {
    if (c.id === NARRATOR_ID) continue;
    if (c.id === MALE_BUCKET_ID || c.id === FEMALE_BUCKET_ID) continue;
    const isDescriptor = isDescriptorName(c.name);
    const lines = lineCount.get(c.id) ?? 0;
    const isProtected =
      (c.detectionSource === 'narrator-mention' &&
        matchesProtectedRole(c.role, protectedRoles) &&
        !isDescriptor) ||
      /* A speaker the prose explicitly tags (`"…," Behnam noted.`) is a real
         named speaker — keep their own slot even at a low/zero line count
         (stage-2 may have stranded their quote on narrator, #537). Descriptors
         ("The Jogger") still fold. */
      (proseTagged.has(c.id) && !isDescriptor);
    if (!nameOnly && lines === 0 && !isDescriptor && !isProtected) {
      droppedIds.add(c.id);
      droppedNames.push(c.name);
      continue;
    }
    if (isProtected) continue;
    const triggered = isDescriptor || (!nameOnly && lines < minLines);
    if (!triggered) continue;
    const target = pickBucket(c);
    if (target === c.id) continue;
    rewrites[c.id] = target;
    foldedSources.push(c);
  }

  /* A bucket-id row carrying a non-canonical name is a drift (a real
     character that ended up wearing `unknown-male`/`unknown-female` via an
     old merge / voice-match / manual edit). When present we skip the no-op
     shortcut so the canonicalisation in `withCounts` below runs and restores
     the bucket's generic name — closing "named character wearing a bucket id"
     (plan 122). */
  const hasDriftedBucket = characters.some(
    (c) =>
      (c.id === MALE_BUCKET_ID && c.name !== 'Unknown male') ||
      (c.id === FEMALE_BUCKET_ID && c.name !== 'Unknown female'),
  );

  /* No folds and no drops (and no drifted bucket) → no-op, preserve
     referential identity. */
  if (foldedSources.length === 0 && droppedIds.size === 0 && !hasDriftedBucket) {
    return {
      characters,
      sentences,
      rewrites: {},
      summary: { foldedCount: 0, intoMale: 0, intoFemale: 0, droppedSilent: 0 },
      dropped: [],
    };
  }

  /* Rewrite sentence character ids. */
  const rewrittenSentences = sentences.map((s) =>
    rewrites[s.characterId] ? { ...s, characterId: rewrites[s.characterId] } : s,
  );

  /* Determine which buckets actually received folds. */
  const targets = new Set(Object.values(rewrites));
  const needMale = targets.has(MALE_BUCKET_ID);
  const needFemale = targets.has(FEMALE_BUCKET_ID);

  /* Existing characters minus folded ones AND dropped ones, narrator
     preserved in place. */
  const survivors = characters.filter((c) => !(c.id in rewrites) && !droppedIds.has(c.id));

  /* Synthesise missing buckets (or re-use if already present in the input). */
  const survivorById = new Map(survivors.map((c) => [c.id, c]));
  if (needMale && !survivorById.has(MALE_BUCKET_ID)) {
    const bucket = makeBucket(MALE_BUCKET_ID, 'male');
    survivors.push(bucket);
    survivorById.set(bucket.id, bucket);
  }
  if (needFemale && !survivorById.has(FEMALE_BUCKET_ID)) {
    const bucket = makeBucket(FEMALE_BUCKET_ID, 'female');
    survivors.push(bucket);
    survivorById.set(bucket.id, bucket);
  }

  /* Roll folded source names + any existing aliases into the target's
     aliases array — same contract as the manual merge endpoint, so the
     future voice matcher can recognise a folded background voice across
     books in a series. Dedup case-insensitively, don't include the
     bucket's own name. */
  for (const src of foldedSources) {
    const target = survivorById.get(rewrites[src.id]);
    if (!target) continue;
    const seen = new Set<string>([
      target.name.toLowerCase(),
      ...(target.aliases ?? []).map((a) => a.toLowerCase()),
    ]);
    const next = [...(target.aliases ?? [])];
    const add = (name: string) => {
      const norm = name.toLowerCase().trim();
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      next.push(name);
    };
    add(src.name);
    for (const a of src.aliases ?? []) add(a);
    target.aliases = next;
  }

  /* Recompute lines/scenes on every surviving character from the rewritten
     sentence list — buckets need accurate counts, and folded-source counts
     have to roll up. */
  const lines = new Map<string, number>();
  const scenes = new Map<string, Set<number>>();
  for (const s of rewrittenSentences) {
    lines.set(s.characterId, (lines.get(s.characterId) ?? 0) + 1);
    let set = scenes.get(s.characterId);
    if (!set) {
      set = new Set();
      scenes.set(s.characterId, set);
    }
    set.add(s.chapterId);
  }
  const withCounts = survivors.map((c) => {
    const base = {
      ...c,
      lines: lines.get(c.id) ?? c.lines ?? 0,
      scenes: scenes.get(c.id)?.size ?? c.scenes ?? 0,
    };
    /* Invariant (plan 122): a bucket id ALWAYS carries the canonical generic
       name + gender — never a real character's name. A drifted entry
       ({ id: 'unknown-male', name: 'Lord Vane' }) is normalised back to
       the bucket here; its aliases / voiceId / overrides are preserved (the
       drifted NAME is deliberately NOT kept as an alias, so the matcher won't
       re-bind that character to the bucket). */
    if (base.id === MALE_BUCKET_ID) {
      return { ...base, name: 'Unknown male', gender: 'male' as const, role: base.role || 'background' };
    }
    if (base.id === FEMALE_BUCKET_ID) {
      return { ...base, name: 'Unknown female', gender: 'female' as const, role: base.role || 'background' };
    }
    return base;
  });

  /* Summary counters for the log line. */
  let intoMale = 0,
    intoFemale = 0;
  for (const target of Object.values(rewrites)) {
    if (target === MALE_BUCKET_ID) intoMale++;
    else if (target === FEMALE_BUCKET_ID) intoFemale++;
  }

  return {
    characters: withCounts,
    sentences: rewrittenSentences,
    rewrites,
    summary: {
      foldedCount: foldedSources.length,
      intoMale,
      intoFemale,
      droppedSilent: droppedIds.size,
    },
    dropped: droppedNames,
  };
}
