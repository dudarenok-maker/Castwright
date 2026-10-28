/* #3084 wave 5 — import-free leaf. errors.ts needs ReasoningLevel and reasoning.ts already imports
   (soon a VALUE import, Task 5.4) from errors.ts, so ReasoningLevel cannot live in reasoning.ts
   itself without closing a cycle back through errors.ts. Both files import this leaf instead. */
export const REASONING_LEVELS = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
