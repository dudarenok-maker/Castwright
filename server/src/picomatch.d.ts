/* No @types/picomatch is published and the package ships no bundled types.
   Minimal ambient shape for the one call form the ops-30 regression test
   (force-rerun-triggers.test.ts) uses: `picomatch(pattern)(path)`. */
declare module 'picomatch' {
  export default function picomatch(pattern: string): (input: string) => boolean;
}
