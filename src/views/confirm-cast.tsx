import { useState, type ReactNode } from 'react';
import { IconCheck, IconRefresh } from '../lib/icons';
import { SectionLabel, MixedHeading, Avatar, Pill, PrimaryButton } from '../components/primitives';
import type { Character, Voice, CharColor } from '../lib/types';
import { useAppSelector } from '../store';
import { engineForModelKey } from '../lib/tts-models';
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';

interface Props {
  characters: Character[];
  library: Voice[];
  title?: string | null;
  onConfirm: () => void;
  onReanalyse: () => void;
}

type Decision = 'match' | 'generate';

export function ConfirmCastView({ characters, library, title, onConfirm, onReanalyse }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const d: Record<string, Decision> = {};
    for (const c of characters) if (c.matchedFrom) d[c.id] = 'match';
    return d;
  });
  /* Same engine the cast view + profile drawer use — keeps the previewed
     prebuilt-voice label here matching what the user will actually hear. */
  const ttsEngine = useAppSelector(s => engineForModelKey(s.ui.ttsModelKey));
  const findVoice = (id?: string) => library.find(v => v.id === id);
  const matchedCount = characters.filter(c => c.matchedFrom).length;
  const generatedCount = characters.length - matchedCount;

  return (
    <div className="relative min-h-[calc(100vh-64px)] py-12 px-6">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-40 pointer-events-none"/>
      <div className="relative max-w-3xl mx-auto">
        <div className="text-center mb-10">
          <SectionLabel>Cast confirmation</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Meet the cast of" bold={title || 'The Northern Star'}/>
          </div>
          <p className="mt-4 text-ink/70 text-lg">
            <span className="font-semibold text-ink">{characters.length} speaking characters</span> detected ·{' '}
            <span className="font-semibold text-purple-deep">{matchedCount} matched</span> from your library ·{' '}
            <span className="font-semibold text-ink">{generatedCount} new</span> to generate
          </p>
        </div>

        <div className="space-y-3">
          {characters.map(c => (
            <ConfirmCharacterCard
              key={c.id}
              character={c}
              voice={findVoice(c.voiceId)}
              ttsEngine={ttsEngine}
              decision={decisions[c.id]}
              onDecision={(d) => setDecisions({ ...decisions, [c.id]: d })}
            />
          ))}
        </div>

        <div className="mt-10 flex items-center justify-between gap-3">
          <button onClick={onReanalyse} className="text-sm font-medium text-ink/60 hover:text-ink">Re-analyse manuscript</button>
          <PrimaryButton variant="dark" onClick={onConfirm}>Confirm cast and review manuscript</PrimaryButton>
        </div>

        <p className="text-center text-xs text-ink/40 mt-6 max-w-lg mx-auto">
          We'll start generating chapter audio with these voices. You can refine the cast or regenerate any chapter later from inside the app.
        </p>
      </div>
    </div>
  );
}

interface CardProps {
  character: Character;
  voice: Voice | undefined;
  ttsEngine: 'coqui' | 'gemini' | 'piper' | 'kokoro';
  decision: Decision | undefined;
  onDecision: (d: Decision) => void;
}

function ConfirmCharacterCard({ character, voice, ttsEngine, decision, onDecision }: CardProps) {
  const matched = !!character.matchedFrom;
  /* Engine-aware prebuilt-voice pick — shown alongside identity so the user
     can sanity-check before confirming the cast. If the analyzer's gender /
     age guess is wrong, the user can open the profile drawer and edit. */
  const ttsVoice = voice?.ttsVoice ?? resolveTtsVoiceForCharacter(character, ttsEngine);
  return (
    <article className={`bg-white rounded-3xl border shadow-card overflow-hidden transition-colors ${matched ? 'border-purple-deep/15' : 'border-ink/10'}`}>
      <div className="p-5 grid grid-cols-[auto_1fr_auto] items-start gap-5">
        <Avatar name={character.name} color={character.color as CharColor} size={48}/>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-bold text-ink truncate">{character.name}</h3>
            {matched && character.matchedFrom?.confidence != null && (
              <Pill color="library">Matched · {Math.round(character.matchedFrom.confidence * 100)}%</Pill>
            )}
          </div>
          <p className="text-sm text-ink/60 truncate">{character.role}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-ink/50">
            <span className="tabular-nums"><span className="font-semibold text-ink/70">{character.lines}</span> lines</span>
            <span>·</span>
            <span className="tabular-nums"><span className="font-semibold text-ink/70">{character.scenes}</span> scenes</span>
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
            {character.attributes?.slice(0, 3).map(a => <Pill key={a}>{a}</Pill>)}
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

        {matched ? (
          <div className="grid grid-cols-2 gap-2 w-[340px]">
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
          <div className="w-[340px]">
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
        <div className="border-t border-ink/5 px-5 py-3 bg-canvas/60 flex items-center gap-3 text-xs text-ink/60 fade-in">
          <span className="grid place-items-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700"><IconCheck className="w-3 h-3"/></span>
          <span>Continuity preserved — <span className="font-semibold text-ink">{voice?.character}</span> from <span className="font-semibold text-ink">{character.matchedFrom?.bookTitle}</span> will be used.</span>
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

function DecisionTile({ active, onClick, swatch, title, subtitle, badge, readonly }: DecisionTileProps) {
  return (
    <button onClick={onClick} disabled={readonly}
            className={`text-left p-3 rounded-2xl border transition-all ${active ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'} ${readonly ? 'cursor-default' : 'cursor-pointer'}`}>
      <div className="flex items-start gap-3">
        {swatch ? (
          <span className="rounded-full shrink-0 shadow-sm" style={{ width: 32, height: 32, background: `radial-gradient(circle at 30% 30%, ${swatch.gradient[0]}, ${swatch.gradient[1]})` }}/>
        ) : (
          <span className="w-8 h-8 rounded-full border-2 border-dashed border-ink/20 grid place-items-center shrink-0"><IconRefresh className="w-3.5 h-3.5 text-ink/40"/></span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <p className="text-sm font-semibold text-ink truncate">{title}</p>
            {active && !readonly && <span className="w-4 h-4 rounded-full bg-peach grid place-items-center shrink-0"><IconCheck className="w-2.5 h-2.5 text-white"/></span>}
          </div>
          <p className="text-[11px] text-ink/55 truncate">{subtitle}</p>
          <div className="mt-1.5">{badge}</div>
        </div>
      </div>
    </button>
  );
}
