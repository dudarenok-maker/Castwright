/* Pure client-side helpers over a ModelsStatus runtime. Splits the two runtime
   axes the setup Voice step cares about: whether the runtime is a real setup
   BLOCKER (installed-on-disk truth) vs. a transient liveness note (the process
   is starting) that self-resolves and must NOT read as an amber blocker. */
import type { ModelsStatus } from '../../lib/api';

type Runtime = ModelsStatus['runtime'];

/** Installed-on-disk is the real setup gate; a transient 'starting' process is
    NOT a blocker (it self-resolves). 'down'/'crashed' are. */
export function runtimeIsBlocking(r: Runtime): boolean {
  if (!r.installedOnDisk) return true;
  return r.process === 'down' || r.process === 'crashed';
}

export function runtimeLivenessPill(
  r: Runtime,
): { tone: 'neutral' | 'alarm'; label: string } | null {
  if (!r.installedOnDisk) return null; // the card, not a pill, tells the "set up" story
  if (r.process === 'starting') return { tone: 'neutral', label: 'Voice engine starting…' };
  if (r.process === 'down') return { tone: 'alarm', label: 'Voice engine not running' };
  if (r.process === 'crashed') return { tone: 'alarm', label: 'Voice engine crashed' };
  return null; // ready → no pill
}
