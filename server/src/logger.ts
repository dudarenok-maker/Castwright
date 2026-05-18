/* Boot-time monkey-patch that prefixes every console.* line with a
   YYYY-MM-DD HH:mm:ss.SSS local-time stamp. Patching at the entry point
   instead of wrapping ~50 call sites keeps the existing `[component]`
   prefix convention intact and also stamps lines from third-party libs
   (express, etc.) that go through console.

   The timestamp is emitted as its own leading argument so non-string args
   (e.g. error objects) still get Node's default pretty-printing — a
   single-string concat would coerce them to "[object Object]". */

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
    }) as (typeof console)[typeof method];
  }
  target[PATCHED_FLAG] = true;
}
