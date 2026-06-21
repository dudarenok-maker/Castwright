import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { IconCheck, IconRefresh } from '../lib/icons';
import { SectionLabel, MixedHeading, Avatar, Pill, PrimaryButton } from '../components/primitives';
import type { Character, Voice, CharColor } from '../lib/types';
import { useAppSelector } from '../store';
import { engineForModelKey } from '../lib/tts-models';
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
import { QwenStatusNotice } from '../components/qwen-status-notice';

interface OverrideArgs {
  sourceCharacterId: string;
  targetBookId: string;
  targetCharacterId: string;
}

interface Props {
  characters: Character[];
  library: Voice[];
  title?: string | null;
  /** Open the shared ProfileDrawer for this character. Wired by ConfirmRoute
      to dispatch setOpenProfileId — same drawer the ready-stage Cast view
      uses, so identity edits at the confirmation step land in the same
      character record and survive into generation. */
  onOpenProfile: (id: string) => void;
  onConfirm: () => void;
  onReanalyse: () => void;
  /** Push the current book's richer profile back onto the matched library
      record. Called by the view *before* onConfirm for each character whose
      "Update library profile from this manuscript" checkbox is on. The
      parent route binds sourceBookId from its own context; the view only
      needs the per-character identifiers. Optional so existing call sites
      (and mock-mode tests) can keep working without it — the override
      checkbox simply won't render if it isn't provided. */
  onOverrideLibrary?: (args: OverrideArgs) => Promise<void>;
}

type Decision = 'match' | 'generate';

/* Bulk-apply auto-ticks the "Sync profile" checkbox only for matches
   whose confidence is strictly below this threshold. A high-quality
   match (≥ 0.9) means the library record is already a good fit for
   this character; merging this manuscript's profile back into the
   library record stays a deliberate per-card opt-in. Undefined
   confidence is treated as low-confidence (defensive — older
   voice-match payloads omitted the field). The Reuse-decision flip
   is unchanged: every eligible row still gets `decisions[id] = 'match'`
   on bulk apply regardless of confidence. */
const SYNC_AUTO_THRESHOLD = 0.9;

export function ConfirmCastView({
  characters,
  library,
  title,
  onOpenProfile,
  onConfirm,
  onReanalyse,
  onOverrideLibrary,
}: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const d: Record<string, Decision> = {};
    for (const c of characters) if (c.matchedFrom) d[c.id] = 'match';
    return d;
  });
  /* Per-character "also update the library record from this manuscript"
     opt-in. Default off so the existing reuse-as-is flow is unchanged. The
     toggle is only meaningful when decision === 'match' AND the matched
     record carries bookId + characterId (older voice-match responses didn't
     and we can't address the library record without them). */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  /* Same engine the cast view + profile drawer use — keeps the previewed
     prebuilt-voice label here matching what the user will actually hear. */
  const ttsEngine = useAppSelector((s) => engineForModelKey(s.ui.ttsModelKey));
  const findVoice = (id?: string) => library.find((v) => v.id === id);
  const matchedCount = characters.filter((c) => c.matchedFrom).length;
  const generatedCount = characters.length - matchedCount;

  /* Plan 41 — bulk-apply matches + library sync. Mirrors the per-card
     `canOverrideLibrary` predicate (the `!!onOverrideLibrary` guard hides
     the pill in mock environments where the per-card checkbox is itself
     hidden). The apply path flips the Reuse decision for every eligible
     card AND ticks the sync-from-library override for low-confidence
     rows (< SYNC_AUTO_THRESHOLD) — high-confidence matches keep the
     sync checkbox as a deliberate per-card opt-in because the library
     record is already a good fit. The per-card sync checkbox only
     renders when `decision === 'match'`, so without the decision flip
     the pill produces no visible effect on cards the user had toggled
     to "Generate". The existing `handleConfirm` batch is still the
     only POST path. */
  const characterById = new Map(characters.map((c) => [c.id, c]));
  const eligibleIds = characters
    .filter((c) => !!onOverrideLibrary && !!c.matchedFrom?.bookId && !!c.matchedFrom?.characterId)
    .map((c) => c.id);
  /* High-confidence rows count as "applied" once their decision is
     'match' (override is irrelevant — apply-all won't write it). Low-
     confidence rows still need override === true to be applied. */
  const shouldAutoSync = (id: string) =>
    (characterById.get(id)?.matchedFrom?.confidence ?? 0) < SYNC_AUTO_THRESHOLD;
  const isApplied = (id: string) =>
    decisions[id] === 'match' && (shouldAutoSync(id) ? !!overrides[id] : true);
  const allApplied = eligibleIds.length > 0 && eligibleIds.every(isApplied);
  /* N is the count of currently-unapplied eligible characters — the size
     of the apply action's effect. After bulk-apply + per-card untick of
     one low-confidence sync, the pill flips back to "Apply 1 match"
     (the user is one click away from fully applied again). */
  const unappliedCount = eligibleIds.filter((id) => !isApplied(id)).length;
  const bulkApplyLabel = allApplied
    ? 'Clear all syncs'
    : `Apply all ${unappliedCount} ${unappliedCount === 1 ? 'match' : 'matches'}`;
  /* Functional updates so a near-simultaneous per-card click can't
     clobber the bulk set. */
  const handleBulkApply = () => {
    if (allApplied) {
      // Clear-syncs path: untick overrides for every eligible row,
      // including any high-confidence rows the user manually ticked.
      // Symmetric with how those rows were ticked manually in the
      // first place. Decisions stay on Reuse (reverting would be
      // destructive — user explicitly picked Reuse).
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of eligibleIds) next[id] = false;
        return next;
      });
      return;
    }
    // Apply-all path: flip decision to Reuse for every eligible row.
    // Auto-tick override ONLY for low-confidence rows; high-confidence
    // rows are not written (any prior manual tick is preserved).
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of eligibleIds) next[id] = 'match';
      return next;
    });
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of eligibleIds) {
        if (shouldAutoSync(id)) next[id] = true;
      }
      return next;
    });
  };

  /* Fire any opted-in library-cast overrides before navigating off the
     confirm view. allSettled so a single failing override (network blip,
     library record renamed mid-flight) doesn't strand the user — the
     primary "cast confirmed" action must still complete. Errors are
     surfaced in the console so a regression is still visible. */
  const handleConfirm = async () => {
    if (onOverrideLibrary) {
      const requests: Promise<unknown>[] = [];
      for (const c of characters) {
        const target = c.matchedFrom;
        if (
          decisions[c.id] === 'match' &&
          overrides[c.id] &&
          target?.bookId &&
          target.characterId
        ) {
          requests.push(
            onOverrideLibrary({
              sourceCharacterId: c.id,
              targetBookId: target.bookId,
              targetCharacterId: target.characterId,
            }).catch((err) => {
              console.error('[confirm-cast] library override failed', c.id, err);
            }),
          );
        }
      }
      if (requests.length) {
        await Promise.allSettled(requests);
      }
    }
    onConfirm();
  };

  return (
    /* Plan 81 wave 3 — phone (375 px) + tablet (834 px) layouts. Outer
       padding shrinks on `<sm:` so the cast cards keep at least 327 px
       of inner room on a 375 px viewport; vertical padding tightens too
       so the header doesn't push the first card below the fold. */
    <div className="relative min-h-[calc(100vh-64px)] py-6 sm:py-12 px-4 sm:px-6">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-40 pointer-events-none" />
      <div className="relative max-w-3xl mx-auto">
        <div className="mb-4">
          <QwenStatusNotice />
        </div>
        <div className="text-center mb-6 sm:mb-10">
          <SectionLabel>Cast confirmation</SectionLabel>
          <div className="mt-5">
            <MixedHeading
              level="h1"
              regular="Meet the cast of"
              bold={title || 'The Northern Star'}
            />
          </div>
          <p className="mt-4 text-ink/70 text-base sm:text-lg">
            <span className="font-semibold text-ink">{characters.length} speaking characters</span>{' '}
            detected ·{' '}
            <span className="font-semibold text-purple-deep">{matchedCount} matched</span> from your
            library · <span className="font-semibold text-ink">{generatedCount} new</span> to
            generate
          </p>
        </div>

        {eligibleIds.length > 0 && (
          <div className="mb-3 flex justify-end">
            <PrimaryButton variant="dark" size="sm" icon={false} onClick={handleBulkApply}>
              {bulkApplyLabel}
            </PrimaryButton>
          </div>
        )}

        <CharacterList
          characters={characters}
          findVoice={findVoice}
          ttsEngine={ttsEngine}
          decisions={decisions}
          setDecisions={setDecisions}
          overrides={overrides}
          setOverrides={setOverrides}
          onOverrideLibrary={onOverrideLibrary}
          onOpenProfile={onOpenProfile}
        />

        {/* Plan 81 wave 3 — on phone (<sm:) the long "Confirm cast and
            review manuscript" button can't share a row with the Re-analyse
            link without overflowing the 375 px viewport. Stack vertically
            with the confirm action on top (primary intent first on touch);
            tablet+ keeps the inline desktop layout. Re-analyse button
            takes a min-h tap target on phone (WCAG 2.5.5). */}
        <div className="mt-10 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
          <button
            onClick={onReanalyse}
            className="text-sm font-medium text-ink/60 hover:text-ink min-h-[44px] sm:min-h-0 self-center sm:self-auto"
          >
            Re-analyse manuscript
          </button>
          <PrimaryButton
            variant="dark"
            onClick={() => {
              void handleConfirm();
            }}
          >
            Confirm cast and review manuscript
          </PrimaryButton>
        </div>

        <p className="text-center text-xs text-ink/40 mt-6 max-w-lg mx-auto">
          We'll start generating chapter audio with these voices. You can refine the cast or
          regenerate any chapter later from inside the app.
        </p>
      </div>
    </div>
  );
}

interface CardProps {
  character: Character;
  voice: Voice | undefined;
  ttsEngine: 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';
  decision: Decision | undefined;
  onDecision: (d: Decision) => void;
  /** Current state of the "Update library profile from this manuscript"
      checkbox; only renders when canOverrideLibrary is true and the user
      has picked the Reuse decision. */
  overrideLibrary: boolean;
  /** Whether the override checkbox is even available for this character.
      False when the parent didn't pass onOverrideLibrary (mock environments)
      or when matchedFrom is missing the bookId/characterId handle (older
      voice-match cache without the cross-book identifiers). */
  canOverrideLibrary: boolean;
  onToggleOverride: (v: boolean) => void;
  /** Card-level click handler. Whole card is clickable; the DecisionTile
      column stops propagation so picking match/generate doesn't also pop
      the drawer. Mirrors the ready-stage Cast view's row click behavior. */
  onOpenProfile: () => void;
}

/* Plan 93 — virtualise the character list above a 40-row threshold.
   Below it, the flat-render path keeps the simple DOM tree (no extra
   wrapper divs, no measureElement reads); above it the windowed render
   keeps DOM-node count bounded regardless of cast size. Uses
   `useWindowVirtualizer` because the confirm-cast page scrolls at the
   document level, not in an internal container. */
function CharacterList({
  characters,
  findVoice,
  ttsEngine,
  decisions,
  setDecisions,
  overrides,
  setOverrides,
  onOverrideLibrary,
  onOpenProfile,
}: {
  characters: Character[];
  findVoice: (id: string | undefined) => Voice | undefined;
  ttsEngine: 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';
  decisions: Record<string, Decision>;
  setDecisions: (d: Record<string, Decision>) => void;
  overrides: Record<string, boolean>;
  setOverrides: (o: Record<string, boolean>) => void;
  onOverrideLibrary?: (args: OverrideArgs) => Promise<void>;
  onOpenProfile: (id: string) => void;
}) {
  const virtualEnabled = characters.length >= 40;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      setScrollMargin(node.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [characters.length]);
  const virtualizer = useWindowVirtualizer({
    count: virtualEnabled ? characters.length : 0,
    estimateSize: () => 180,
    overscan: 5,
    scrollMargin,
  });

  const renderCard = (c: Character) => (
    <ConfirmCharacterCard
      character={c}
      voice={findVoice(c.voiceId)}
      ttsEngine={ttsEngine}
      decision={decisions[c.id]}
      onDecision={(d) => setDecisions({ ...decisions, [c.id]: d })}
      overrideLibrary={!!overrides[c.id]}
      canOverrideLibrary={
        /* Only meaningful when both the decision is "reuse" and the
           matched record carries the library handle. */
        !!onOverrideLibrary && !!c.matchedFrom?.bookId && !!c.matchedFrom?.characterId
      }
      onToggleOverride={(v) => setOverrides({ ...overrides, [c.id]: v })}
      onOpenProfile={() => onOpenProfile(c.id)}
    />
  );

  if (!virtualEnabled) {
    return (
      <div ref={listRef} className="space-y-3">
        {characters.map((c) => (
          <div key={c.id}>{renderCard(c)}</div>
        ))}
      </div>
    );
  }
  return (
    <div
      ref={listRef}
      data-testid="confirm-cast-virtual-container"
      style={{ position: 'relative', height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const c = characters[virtualItem.index];
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
              paddingBottom: 12,
            }}
          >
            {renderCard(c)}
          </div>
        );
      })}
    </div>
  );
}

function ConfirmCharacterCard({
  character,
  voice,
  ttsEngine,
  decision,
  onDecision,
  overrideLibrary,
  canOverrideLibrary,
  onToggleOverride,
  onOpenProfile,
}: CardProps) {
  const matched = !!character.matchedFrom;
  /* Engine-aware prebuilt-voice pick — shown alongside identity so the user
     can sanity-check before confirming the cast. If the analyzer's gender /
     age guess is wrong, the user can open the profile drawer and edit. */
  const ttsVoice = voice?.ttsVoice ?? resolveTtsVoiceForCharacter(character, ttsEngine);
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open profile for ${character.name}`}
      onClick={onOpenProfile}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenProfile();
        }
      }}
      className={`bg-white rounded-3xl border shadow-card overflow-hidden transition-colors cursor-pointer hover:border-ink/25 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-peach/60 ${matched ? 'border-purple-deep/15' : 'border-ink/10'}`}
    >
      {/* Plan 81 wave 3 — phone (<sm:) stacks the decision-tile column
          below the avatar+info row so the fixed 340 px decision panel
          doesn't overflow a 375 px viewport. The decision panel spans
          both grid columns on phone and returns to the right-hand
          column on tablet+ (`sm:` ≥640 px). Inner padding shrinks on
          phone to claw back another 8 px each side. */}
      <div className="p-4 sm:p-5 grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto] items-start gap-3 sm:gap-5">
        <Avatar name={character.name} color={character.color as CharColor} size={48} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-bold text-ink truncate">{character.name}</h3>
            {matched && character.matchedFrom?.confidence != null && (
              <Pill color="library">
                Carried · {Math.round(character.matchedFrom.confidence * 100)}%
              </Pill>
            )}
          </div>
          <p className="text-sm text-ink/60 truncate">{character.role}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-ink/50">
            <span className="tabular-nums">
              <span className="font-semibold text-ink/70">{character.lines}</span> lines
            </span>
            <span>·</span>
            <span className="tabular-nums">
              <span className="font-semibold text-ink/70">{character.scenes}</span> scenes
            </span>
          </div>
          {/* Identity chips — gender + age range. Only show when present, so
              older cached analyses don't get empty pills. */}
          {(character.gender || character.ageRange) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {character.gender && <Pill color="library">{capitalise(character.gender)}</Pill>}
              {character.ageRange && <Pill color="library">{capitalise(character.ageRange)}</Pill>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {character.attributes?.slice(0, 3).map((a) => (
              <Pill key={a}>{a}</Pill>
            ))}
          </div>
          {/* TTS voice assignment — what the engine will pick for this
              character given current identity. Mirrors the cast table's
              TtsVoiceLine so the same info shows here. */}
          <p
            className="mt-2 text-[11px] truncate"
            title={`${capitalise(ttsVoice.provider)} voice — ${ttsVoice.description}`}
          >
            <span className="text-ink/40">{capitalise(ttsVoice.provider)} · </span>
            <span className="font-semibold text-ink/70">{ttsVoice.name}</span>
            <span className="text-ink/40"> · {ttsVoice.description}</span>
          </p>
        </div>

        {/* Decision tiles own their own clicks — stopPropagation so picking
            match/generate doesn't bubble up to the card-level
            "open profile" handler. Plan 81 wave 3 — on phone the panel
            spans both grid columns (full width under the avatar+info row);
            on tablet+ it returns to a fixed 340 px right-hand column. */}
        {matched ? (
          <div
            className="col-span-2 sm:col-span-1 grid grid-cols-2 gap-2 w-full sm:w-[340px]"
            onClick={(e) => e.stopPropagation()}
          >
            <DecisionTile
              active={decision === 'match'}
              onClick={() => onDecision('match')}
              swatch={voice}
              title={voice?.character || 'Library voice'}
              subtitle={`From ${character.matchedFrom?.bookTitle}`}
              badge={<Pill color="library">Reuse</Pill>}
            />
            <DecisionTile
              active={decision === 'generate'}
              onClick={() => onDecision('generate')}
              swatch={null}
              title="Generate fresh"
              subtitle="Synthesise from this manuscript"
              badge={<Pill color="warning">New</Pill>}
            />
          </div>
        ) : (
          <div
            className="col-span-2 sm:col-span-1 w-full sm:w-[340px]"
            onClick={(e) => e.stopPropagation()}
          >
            <DecisionTile
              active={true}
              swatch={voice}
              title={voice?.character || 'Generated voice'}
              subtitle="Synthesised from this manuscript"
              badge={<Pill color="success">Generated</Pill>}
              readonly
            />
          </div>
        )}
      </div>

      {matched && decision === 'match' && (
        <div
          className="border-t border-ink/5 px-5 py-3 bg-canvas/60 fade-in space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 text-xs text-ink/60">
            <span className="grid place-items-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700">
              <IconCheck className="w-3 h-3" />
            </span>
            <span>
              Continuity preserved —{' '}
              <span className="font-semibold text-ink">{voice?.character}</span> from{' '}
              <span className="font-semibold text-ink">{character.matchedFrom?.bookTitle}</span>{' '}
              will be used.
            </span>
          </div>
          {canOverrideLibrary && (
            /* Symmetric "best-of-both" merge: this book's character and
               the matched library record end up sharing the richer
               profile (longest description, unioned attributes / aliases,
               source wins on identity conflicts). Each side keeps its
               own audio identity, per-book metrics, and evidence quotes.
               Default off so the existing reuse-as-is flow is unchanged. */
            /* Plan 81 wave 3 — `pl-9` indent stays; the whole label is the
               tap target (clicking anywhere on the text toggles the
               checkbox), so the multi-line text already exceeds 44 px on
               every viewport. Min-h on phone is a belt-and-braces guard
               for shorter book titles. */
            <label
              className="flex items-start gap-3 text-xs text-ink/60 pl-9 cursor-pointer select-none min-h-[44px] sm:min-h-0"
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
              }}
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-peach"
                checked={overrideLibrary}
                onChange={(e) => onToggleOverride(e.target.checked)}
                aria-label={`Sync profile with ${character.matchedFrom?.bookTitle}`}
              />
              <span>
                Sync profile with{' '}
                <span className="font-semibold text-ink/60">
                  {character.matchedFrom?.bookTitle}
                </span>
                .
                <span className="text-ink/40">
                  {' '}
                  Description, attributes, and aliases get merged — both books inherit the richer
                  profile. Voices and already-generated chapter audio don't change — but the
                  matched book will surface drift events for any character whose audio is now out
                  of step with the merged profile, to review at your own pace.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </article>
  );
}

interface DecisionTileProps {
  active: boolean;
  onClick?: () => void;
  swatch?: Voice | null;
  title: string;
  subtitle: string;
  badge: ReactNode;
  readonly?: boolean;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function DecisionTile({
  active,
  onClick,
  swatch,
  title,
  subtitle,
  badge,
  readonly,
}: DecisionTileProps) {
  return (
    /* Plan 81 wave 3 — explicit min-h on phone gives the decision tile a
       WCAG 2.5.5 compliant tap target (≥44 px). The existing `p-3` +
       8 px swatch + two text lines already exceeds that on desktop; the
       min-h is a belt-and-braces guarantee for phone. */
    <button
      onClick={onClick}
      disabled={readonly}
      className={`text-left p-3 min-h-[44px] rounded-2xl border transition-all ${active ? 'border-peach bg-peach/6' : 'border-ink/10 hover:border-ink/20'} ${readonly ? 'cursor-default' : 'cursor-pointer'}`}
    >
      <div className="flex items-start gap-3">
        {swatch ? (
          <span
            className="rounded-full shrink-0 shadow-xs"
            style={{
              width: 32,
              height: 32,
              background: `radial-gradient(circle at 30% 30%, ${swatch.gradient[0]}, ${swatch.gradient[1]})`,
            }}
          />
        ) : (
          <span className="w-8 h-8 rounded-full border-2 border-dashed border-ink/20 grid place-items-center shrink-0">
            <IconRefresh className="w-3.5 h-3.5 text-ink/40" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <p className="text-sm font-semibold text-ink truncate">{title}</p>
            {active && !readonly && (
              <span className="w-4 h-4 rounded-full bg-peach grid place-items-center shrink-0">
                <IconCheck className="w-2.5 h-2.5 text-white" />
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink/55 truncate">{subtitle}</p>
          <div className="mt-1.5">{badge}</div>
        </div>
      </div>
    </button>
  );
}
