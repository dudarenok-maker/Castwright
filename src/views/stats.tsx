/* fs-16 — listening-stats dashboard. F2 ships this stub; F3 builds the
   real Reading-column Tufte view. */

export interface StatsViewProps {
  today?: string;
}

export function StatsView(_props: StatsViewProps = {}) {
  return (
    <main className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <h1 className="font-serif text-3xl text-ink">Listening stats</h1>
    </main>
  );
}
