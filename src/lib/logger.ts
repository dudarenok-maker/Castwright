/* Browser mirror of server/src/logger.ts. Same shape — boot-time
   monkey-patch on console.* prefixing each line with a
   YYYY-MM-DD HH:mm:ss.SSS local-time stamp. Stamps both DevTools console
   output and the redirected logs/frontend.log captured by start-app.ps1. */

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

const PATCHED_FLAG = '__timestampPatched';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1, 2);
  const dd = pad(date.getDate(), 2);
  const hh = pad(date.getHours(), 2);
  const mi = pad(date.getMinutes(), 2);
  const ss = pad(date.getSeconds(), 2);
  const ms = pad(date.getMilliseconds(), 3);
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

export function installTimestamps(): void {
  const target = console as unknown as Record<string, unknown>;
  if (target[PATCHED_FLAG]) return;
  for (const method of METHODS) {
    const original = (console[method] as (...args: unknown[]) => void).bind(console);
    console[method] = ((...args: unknown[]) => {
      original(formatTimestamp(new Date()), ...args);
    }) as typeof console[typeof method];
  }
  target[PATCHED_FLAG] = true;
}
