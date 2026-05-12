import { IconArrowLeft, IconAB } from '../lib/icons';
import { Avatar } from './primitives';
import type { Stage, View } from '../lib/types';

interface TopBarProps {
  stage: Stage['kind'];
  view: View | null;
  setView: (v: View) => void;
  projectTitle?: string | null;
  onHome: () => void;
  pendingRevisionsCount: number;
  onOpenRevisions: () => void;
}

const TABS: Array<{ id: View; label: string }> = [
  { id: 'manuscript', label: 'Manuscript' },
  { id: 'cast',       label: 'Cast' },
  { id: 'library',    label: 'Voices' },
  { id: 'generate',   label: 'Generate' },
  { id: 'listen',     label: 'Listen' },
  { id: 'log',        label: 'Log' },
];

export function TopBar({ stage, view, setView, projectTitle, onHome, pendingRevisionsCount, onOpenRevisions }: TopBarProps) {
  return (
    <header className="sticky top-0 z-40 bg-canvas/85 backdrop-blur-md border-b border-ink/10">
      <div className="max-w-[1500px] mx-auto px-6 h-16 flex items-center gap-8">
        <button onClick={onHome} className="font-bold text-base tracking-tight inline-flex items-center gap-1 hover:opacity-80 transition-opacity">
          audiobook<span className="text-peach">.</span>
        </button>
        {projectTitle && (
          <button onClick={onHome} className="flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors">
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
        <div className={`flex items-center gap-3 ${stage === 'ready' ? '' : 'ml-auto'}`}>
          {pendingRevisionsCount > 0 && (
            <button onClick={onOpenRevisions} className="relative inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-peach/15 hover:bg-peach/25 text-magenta text-xs font-semibold transition-colors">
              <span className="relative">
                <IconAB className="w-4 h-4"/>
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-magenta pulse-ring"/>
              </span>
              {pendingRevisionsCount} revision{pendingRevisionsCount === 1 ? '' : 's'}
            </button>
          )}
          <Avatar name="Mike Dudarenok" color="halloran" size={32}/>
        </div>
      </div>
    </header>
  );
}
