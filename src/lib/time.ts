export function parseDuration(s: string): number {
  const [m, sec] = s.split(':').map(Number);
  return m * 60 + sec;
}

export function formatTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** MM:SS or HH:MM:SS — matches the server's state.json convention so a
    live `chapter_assembling` tick renders identically to a chapter
    hydrated from disk on the next reload. */
export function formatDuration(totalSec: number): string {
  const total = Math.max(0, Math.round(totalSec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function parseRuntime(s: string): number {
  const m = s.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
  if (!m) return 0;
  return parseInt(m[1] || '0') * 60 + parseInt(m[2] || '0');
}

export function formatHours(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
