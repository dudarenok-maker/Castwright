/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
function parseDuration(s) { const [m, sec] = s.split(":").map(Number); return m*60 + sec; }
function formatTime(totalSec) { const m = Math.floor(totalSec/60); const s = Math.floor(totalSec%60); return `${m}:${String(s).padStart(2,"0")}`; }

function parseRuntime(s) {
  const m = s.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
  if (!m) return 0;
  return (parseInt(m[1]||"0") * 60) + parseInt(m[2]||"0");
}
function formatHours(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}


Object.assign(window, { parseDuration, formatTime, parseRuntime, formatHours });
