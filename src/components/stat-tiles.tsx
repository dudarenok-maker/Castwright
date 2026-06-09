/* Plan 89 C5 — Stat and StatTile primitives extracted from the route-leaf
   views so they can be imported by sibling components without dragging the
   entire view into the static-import graph. Both were previously declared
   in `src/views/voices.tsx` and `src/views/generation.tsx` respectively
   and re-imported by `src/components/library/library-{chrome,grid}.tsx`,
   which defeated the React.lazy split — Vite's rollup-side warning was:
   "X is dynamically imported by routes/index.tsx but also statically
   imported by library-chrome.tsx, dynamic import will not move module
   into another chunk."

   Visual contract is preserved 1:1 from the original implementations. */

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div
      className="bg-white rounded-2xl border border-ink/10 p-4"
      data-testid={`stat-tile-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-ink tabular-nums mt-1">{value}</p>
    </div>
  );
}

export function Stat({
  label,
  value,
  danger,
  small,
}: {
  label: string;
  value: number | string;
  danger?: boolean;
  small?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-1">{label}</p>
      <p
        className={`${small ? 'text-base' : 'text-2xl'} font-bold tabular-nums ${danger && typeof value === 'number' && value > 0 ? 'text-magenta' : 'text-ink'}`}
      >
        {value}
      </p>
    </div>
  );
}
