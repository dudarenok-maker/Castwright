/* Human-readable byte sizes for the Model Manager inventory (fs-23). Binary
   units (1024) since these are on-disk model weights, matching how the OS
   reports them. `null` → an em dash placeholder. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  /* One decimal under 10 (e.g. 3.6 GB), whole numbers above (e.g. 346 MB). */
  const text = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${text} ${units[unit]}`;
}
