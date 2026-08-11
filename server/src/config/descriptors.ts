/* Projects a ConfigKnob (the registry's internal shape) into the descriptor
   shape GET /api/config sends the frontend. Deliberately drops `env` and
   `pattern` — neither is meant to reach the client. Extracted from the inline
   object literal in routes/config.ts so the frontend mock catalogue
   (src/lib/api.ts) can build itself from the same projection instead of
   hand-copying it (#2259). */

import type { ConfigKnob } from './types.js';
import { allKnobs } from './registry.js';

export function toKnobDescriptor(k: ConfigKnob) {
  return {
    key: k.key,
    group: k.group,
    label: k.label,
    help: k.help,
    type: k.type,
    min: k.min,
    max: k.max,
    step: k.step,
    options: k.options,
    apply: k.apply,
    risk: k.risk,
    isPrompt: k.isPrompt ?? false,
    default: k.default,
  };
}

export function allKnobDescriptors() {
  return allKnobs().map(toKnobDescriptor);
}
