import { IconArrowLeft, IconAB, IconSpinner, IconClock, IconWarning } from '../lib/icons';
import { Avatar } from './primitives';
import type { Stage, View } from '../lib/types';

export type GenerationPillState = 'running' | 'stalled' | 'halted';
export interface GenerationPillData {
  state: GenerationPillState;
  done: number;
  total: number;
  percent: number;
  onClick: () => void;
}

interface TopBarProps {
  stage: Stage['kind'];
  view: View | null;
  setView: (v: View) => void;
  projectTitle?: string | null;
  onHome: () => void;
  /** Optional override for the project-title click. When omitted, the title
      acts as a back-to-home shortcut (same as the logo). The cast-confirm
      stage uses this to wire the title to re-analyse. */
  onTitleClick?: () => void;
  pendingRevisionsCount: number;
  onOpenRevisions: () => void;
  onOpenVoices: () => void;
  onOpenChangelog: () => void;
  /** Avatar click → Account view. The avatar shows the user's display name
      (sourced from the account slice in the wrapping component), so it acts
      as the single discoverable entry-point to account settings. */
  onOpenAccount: () => void;
  /** Display name rendered as the avatar's initials. Sourced from the
      account slice — the persisted user-level value, with a built-in
      seed default. */
  userDisplayName: string;
  /** Globally-visible chip surfacing background generation so the user knows
      a run is alive (or stalled / halted) even when they're on Cast, Voices,
      Activity, etc. `null` hides the pill entirely. Clicking routes back to
      the Generate view of the active book. */
  generationPill?: GenerationPillData | null;
}

const TABS: Array<{ id: View; label: string }> = [
  { id: 'manuscript', label: 'Manuscript' },
  { id: 'cast',       label: 'Cast' },
  { id: 'library',    label: 'Voices' },
  { id: 'generate',   label: 'Generate' },
  { id: 'listen',     label: 'Listen' },
  { id: 'log',        label: 'Log' },
];

/* Cross-book destinations available when no book is open (or when the user
   is browsing a global view). Cast/Manuscript/Generate/Listen are inherently
   per-book and only appear in the `ready` tab strip. */
const GLOBAL_NAV: Array<{ id: 'books' | 'voices' | 'changelog'; label: string }> = [
  { id: 'books',     label: 'Books' },
  { id: 'voices',    label: 'Voices' },
  { id: 'changelog', label: 'Change log' },
];

export function TopBar({ stage, view, setView, projectTitle, onHome, onTitleClick, pendingRevisionsCount, onOpenRevisions, onOpenVoices, onOpenChangelog, onOpenAccount, userDisplayName, generationPill }: TopBarProps) {
  const showGlobalNav = stage === 'books' || stage === 'voices' || stage === 'changelog';
  const onGlobal = (id: 'books' | 'voices' | 'changelog') => {
    if (id === 'books')     onHome();
    else if (id === 'voices')    onOpenVoices();
    else                         onOpenChangelog();
  };
  return (
    <header className="sticky top-0 z-40 bg-canvas/85 backdrop-blur-md border-b border-ink/10">
      <div className="max-w-[1500px] mx-auto px-6 h-16 flex items-center gap-8">
        <button onClick={onHome} className="font-bold text-base tracking-tight inline-flex items-center gap-1 hover:opacity-80 transition-opacity">
          audiobook<span className="text-peach">.</span>
        </button>
        {projectTitle && (
          <button onClick={onTitleClick ?? onHome} className="flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors">
            <span className="text-ink/40">/</span>
            <span className="font-medium text-ink">{projectTitle}</span>
            <IconArrowLeft className="w-3.5 h-3.5 text-ink/40"/>
          </button>
        )}
        {stage === 'ready' && (
          <nav className="ml-auto flex items-center gap-1 bg-ink/[0.04] rounded-full p-1">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setView(t.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${view === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60 hover:text-ink'}`}>
                {t.label}
              </button>
            ))}
          </nav>
        )}
        {showGlobalNav && (
          <nav className="ml-auto flex items-center gap-1 bg-ink/[0.04] rounded-full p-1">
            {GLOBAL_NAV.map(t => (
              <button key={t.id} onClick={() => onGlobal(t.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${stage === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60 hover:text-ink'}`}>
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <div className={`flex items-center gap-3 ${stage === 'ready' || showGlobalNav ? '' : 'ml-auto'}`}>
          {generationPill && <GenerationPill data={generationPill}/>}
          {pendingRevisionsCount > 0 && (
            <button onClick={onOpenRevisions} className="relative inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-peach/15 hover:bg-peach/25 text-magenta text-xs font-semibold transition-colors">
              <span className="relative">
                <IconAB className="w-4 h-4"/>
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-magenta pulse-ring"/>
              </span>
              {pendingRevisionsCount} revision{pendingRevisionsCount === 1 ? '' : 's'}
            </button>
          )}
          <button type="button" onClick={onOpenAccount}
            aria-label={`Account — ${userDisplayName || 'unnamed user'}`}
            className={`rounded-full transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-magenta/40 ${stage === 'account' ? 'ring-2 ring-magenta/60' : ''}`}>
            <Avatar name={userDisplayName || 'You'} color="halloran" size={32}/>
          </button>
        </div>
      </div>
    </header>
  );
}

function GenerationPill({ data }: { data: GenerationPillData }) {
  const { state, done, total, percent, onClick } = data;
  const variants: Record<GenerationPillState, { className: string; icon: React.ReactNode; label: string }> = {
    running: {
      className: 'bg-peach/15 hover:bg-peach/25 text-magenta',
      icon:      <IconSpinner className="w-3.5 h-3.5"/>,
      label:     'Generating',
    },
    stalled: {
      className: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
      icon:      <IconClock className="w-3.5 h-3.5"/>,
      label:     'Stalled',
    },
    halted: {
      className: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
      icon:      <IconWarning className="w-3.5 h-3.5"/>,
      label:     'Halted',
    },
  };
  const v = variants[state];
  return (
    <button onClick={onClick}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${v.className}`}>
      {v.icon}
      <span className="tabular-nums">
        {v.label} · {done}/{total}
        {state === 'running' && total > 0 && ` · ${percent}%`}
      </span>
    </button>
  );
}
