import { buildInfo, formatBuildStamp } from '../lib/build-info';

// Plan 124 — in-flow footer showing the running build. Mounted once in the app
// shell (layout.tsx) so it renders at the bottom of every `ui.stage`. Content
// switches on the build kind: verbose in dev (version · sha* · branch · time),
// minimal in prod (version (sha)). The single top-level <footer> is the page's
// only `contentinfo` landmark; `aria-label` keeps it landmark-unique-safe and
// names the otherwise-cryptic stamp for screen readers.
export function BuildStamp() {
  const stamp = formatBuildStamp(buildInfo, { dev: import.meta.env.DEV });
  return (
    <footer
      aria-label={stamp}
      data-testid="build-stamp"
      className="px-4 py-3 text-center text-xs text-ink/55 select-text"
    >
      {stamp}
    </footer>
  );
}
