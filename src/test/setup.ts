import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-unused-vars -- T must match vitest's
     own Matchers<R, T> signature exactly (name included) or TS2428 fires;
     this augmentation doesn't otherwise need it. R IS used below, matching
     every other matcher's return type so `.resolves`/`.rejects` chains stay
     correctly typed rather than silently collapsing to `void`. */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > {
    toHaveNoViolations(): R;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
