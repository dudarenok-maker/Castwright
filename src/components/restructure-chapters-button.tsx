import { IconWaveform } from '../lib/icons';

interface Props {
  onClick: () => void;
  /** When true, drops the icon and shortens label — for tight toolbars. */
  compact?: boolean;
}

/* Shared "Restructure chapters" entry point. Mounted in Listen view header
   (post-generation entry) and Manuscript view header (pre-generation entry,
   plan 70b). Same hash-route destination either way: dispatches
   uiActions.changeView('restructure'). */
export function RestructureChaptersButton({ onClick, compact = false }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="open-restructure"
      className="shrink-0 px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
    >
      <IconWaveform className="w-4 h-4" />
      {compact ? 'Restructure' : 'Restructure chapters'}
    </button>
  );
}
