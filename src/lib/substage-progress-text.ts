/** Pure formatters for the enriched prosody/script-review substage progress
    text (chapter counts + pace-based ETA). Shared across the Status-popover
    substage row, the Detect-emotions inline chip, and the Review-Script
    inline chip so all three surfaces render identical copy. */

export function formatChapterCount(chapterIndex?: number, totalChapters?: number): string | null {
  if (chapterIndex === undefined || totalChapters === undefined) return null;
  if (totalChapters <= 1) return null;
  return `Chapter ${chapterIndex} of ${totalChapters}`;
}

export function formatEtaClause(estRemainingMs?: number): string | null {
  if (estRemainingMs === undefined) return null;
  const totalSec = Math.round(estRemainingMs / 1000);
  if (totalSec < 60) return 'less than a minute left';
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `~${h}h ${m}m left` : `~${h}h left`;
}

export function formatSubstageDetail(entry: {
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}): string | null {
  const parts = [
    formatChapterCount(entry.chapterIndex, entry.totalChapters),
    formatEtaClause(entry.estRemainingMs),
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : null;
}
