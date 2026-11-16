/* refuseUnderVitest (#3712). Wraps the DEFAULT of an injectable real-process
 * dependency (spawn, Python lookup, download) so a test that forgets to inject
 * a stub fails loudly instead of spawning a real process.
 *
 * Call-time rule: process.env.VITEST is read when the wrapper is CALLED, never
 * at wrap time, module load or in a constructor, so vi.resetModules() and
 * re-imports cannot freeze a stale answer. Leaf file: imports nothing, so it
 * cannot close an import cycle. Wrap only defaults, never injected functions. */

export function refuseUnderVitest<A extends unknown[], R>(
  real: (...args: A) => R,
  message: string,
): (...args: A) => R {
  return (...args: A): R => {
    if (process.env.VITEST) throw new Error(message);
    return real(...args);
  };
}
