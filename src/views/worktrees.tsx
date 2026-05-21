/* Plan 86 — Live worktree dashboard. Shows every git worktree visible to
   `git worktree list --porcelain` with its branch, ports (from .env.local),
   and a TCP probe against the dev server's VITE_PORT. Auto-refreshes
   every 10 s. Dev-only — production builds hide the top-bar entry and
   the server route 404s.

   Click a row → opens that worktree's dev URL in a new tab. */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  ports: Record<string, string>;
  vitePort: number;
  alive: boolean;
}

export function WorktreesView() {
  const [rows, setRows] = useState<WorktreeRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () =>
      api
        .getWorktrees()
        .then((res) => {
          if (cancelled) return;
          setRows(res.worktrees);
          setLoadError(null);
          setLoaded(true);
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setLoadError(e.message);
          setLoaded(true);
        });
    fetchOnce();
    const t = setInterval(fetchOnce, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h2 className="text-2xl md:text-3xl font-medium leading-[1.1] tracking-tight text-ink mb-4">
        Worktrees
      </h2>
      <p className="text-sm text-ink/60 mb-6">
        Active git worktrees plus their port assignments and a live TCP probe of each VITE_PORT.
        Click a row with a green dot to open that worktree&apos;s dev URL in a new tab.
        Auto-refresh every 10 s. Dev-only.
      </p>
      {!loaded && <p className="text-sm text-ink/50">Loading…</p>}
      {loadError && (
        <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
          Failed to load worktrees: {loadError}
        </p>
      )}
      {loaded && !loadError && rows.length === 0 && (
        <p className="text-sm text-ink/50">No worktrees found. (Are you on a git checkout?)</p>
      )}
      {loaded && rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
          {rows.map((r) => (
            <button
              key={r.path}
              onClick={() => {
                if (r.alive) {
                  window.open(`http://localhost:${r.vitePort}`, '_blank');
                }
              }}
              className={`w-full text-left px-4 py-3 hover:bg-ink/[0.03] flex items-center gap-3 transition-colors ${
                r.alive ? 'cursor-pointer' : 'cursor-default opacity-60'
              }`}
              data-testid={`worktree-row-${r.branch ?? 'detached'}`}
              disabled={!r.alive}
            >
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  r.alive ? 'bg-green-500' : 'bg-ink/30'
                }`}
                aria-label={r.alive ? 'Dev server alive' : 'Dev server not responding'}
              />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-sm truncate">{r.branch ?? '(detached)'}</p>
                <p className="text-xs text-ink/50 truncate">{r.path}</p>
              </div>
              <div className="text-xs text-ink/60 hidden sm:block">
                VITE_PORT {r.vitePort}
              </div>
              <div className="text-xs text-ink/50 font-mono hidden md:block">
                {r.head?.slice(0, 8) ?? ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
