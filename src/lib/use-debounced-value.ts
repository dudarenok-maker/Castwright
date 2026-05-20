/* Tiny debounce hook for input → derived-state lag. Returns a deferred
   copy of `value` that only updates `delayMs` milliseconds after the
   most recent change. Used by the library search input so typing
   doesn't refilter on every keystroke (plan 73).

   Intentionally no leading edge / no flush — keystrokes are the only
   driver and the user always wants the trailing-edge result. If a
   future consumer needs cancel/flush, lift to a generic
   `useDebouncedCallback`. */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
