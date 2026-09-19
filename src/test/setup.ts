import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-unused-vars -- R/T must match vitest's
     own Matchers<R, T> signature exactly (name included) or TS2428 fires;
     this augmentation doesn't otherwise need them. */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > {
    toHaveNoViolations(): void;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
