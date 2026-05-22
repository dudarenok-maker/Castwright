/* GpuSemaphore — single-instance FIFO arbitration around heavy-GPU work.
   Two parallel Claude Code sessions on the same dev box can both kick off
   `/analyse` (Ollama) or `/synthesize` (TTS sidecar) at once; on an 8 GB
   GPU the second op spills into shared system RAM and BOTH runs slow by
   5-10x. Serialising at the Node layer keeps the GPU saturated by one op
   at a time and lets the waiting session show a "Queued (N ahead)" pill
   instead of silently thrashing.

   Hand-rolled (no p-limit / p-queue dep) — 40 lines isn't worth a new
   transitive tree, and the contract is small: acquire returns a release
   function the caller invokes in `finally`. FIFO order is preserved by
   shift()-ing the queue head when a release fires while waiters are
   pending. Concurrency cap reads from `GPU_CONCURRENCY` at module load,
   matching `rate-limit.ts`'s env-at-load idiom — bump it only after
   measuring VRAM headroom on the target GPU.

   Wired into:
     - server/src/analyzer/ollama.ts  — wraps the /api/chat fetch.
     - server/src/tts/sidecar.ts      — wraps the /synthesize fetch +
                                        arrayBuffer() read so a single
                                        release covers the full GPU op.
     - server/src/routes/gpu-queue.ts — exposes inFlight + depth to the
                                        frontend pill via GET /api/gpu/queue. */

type Waiter = { resolve: (release: () => void) => void };

export class GpuSemaphore {
  private current = 0;
  private readonly max: number;
  private readonly queue: Waiter[] = [];

  constructor(max: number) {
    /* Clamp to >= 1 — a max of 0 would deadlock every caller, and
       negative values are nonsensical. Defensive against bad env vars. */
    this.max = Math.max(1, Math.floor(max));
  }

  /** Acquire one GPU slot. Resolves with a single-use release function;
      the caller MUST invoke it (typically inside a `finally`) so a
      waiter — or, if none are queued, the counter — can advance. */
  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current += 1;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push({ resolve: (release) => resolve(release) });
    });
  }

  /** Build a fresh single-use release function for the slot that just
      went in-flight. When invoked, either hands the slot to the next
      waiter (with their own fresh release) or decrements the counter
      so the next `acquire()` call can short-circuit. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        /* Slot stays in-flight — `current` doesn't change. Hand the
           waiter a NEW release function so they get their own
           single-use semantics. */
        next.resolve(this.makeRelease());
      } else {
        this.current -= 1;
      }
    };
  }

  /** Number of acquires waiting in the FIFO queue. Drives the
      "Queued (N ahead) ·" pill prefix in the frontend layout. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Number of acquires currently holding a slot (capped at `max`).
      Exposed so the gpu-queue route can surface the full triple
      (depth, inFlight, max) for diagnostics. */
  get inFlight(): number {
    return this.current;
  }

  /** Configured concurrency cap. */
  get maxConcurrency(): number {
    return this.max;
  }
}

/* Singleton — both call sites (analyzer + sidecar) import this so a
   queue depth of 1 in the analyzer is visible to a sidecar caller and
   vice versa. `GPU_CONCURRENCY` env var lets an operator bump the cap
   once they've measured the GPU can survive two ops simultaneously;
   default 1 is the conservative pick for an 8 GB box. */
const RAW_MAX = Number(process.env.GPU_CONCURRENCY ?? '1');
export const gpuSemaphore = new GpuSemaphore(
  Number.isFinite(RAW_MAX) && RAW_MAX > 0 ? RAW_MAX : 1,
);
