import { IconWaveform } from '../lib/icons';

interface Props {
  onClick: () => void;
  /** When true, drops the icon and shortens label — for tight toolbars. */
  compact?: boolean;
  /** Disables the button and shows this reason beside it (the server refuses a
      restructure while an analysis runs). */
  disabledReason?: string;
}

/* Shared "Restructure chapters" entry point. Mounted in Listen view header
   (post-generation entry) and Manuscript view header (pre-generation entry,
   plan 70b). Same hash-route destination either way: dispatches
   uiActions.changeView('restructure'). */
export function RestructureChaptersButton({ onClick, compact = false, disabledReason }: Props) {
  return (
    <>
      {disabledReason && (
        <p data-testid="open-restructure-reason" className="basis-full text-xs text-ink/60">
          {disabledReason}
        </p>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={!!disabledReason}
        title={disabledReason}
        data-testid="open-restructure"
        className="shrink-0 px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <IconWaveform className="w-4 h-4" />
        {compact ? 'Restructure' : 'Restructure chapters'}
      </button>
    </>
  );
}
