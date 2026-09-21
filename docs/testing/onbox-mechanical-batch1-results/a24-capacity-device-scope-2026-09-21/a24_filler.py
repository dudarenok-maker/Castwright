"""Hold cuda:1 VRAM down to argv[2] MB free (default 250) by taking owned 256 MB
chunks; top-up if anything frees memory; heartbeat a log line every 2 s; release
after argv[1] seconds (default 200) so a dead driver can never strand the card."""
import sys
import time
import torch

hold_s = int(sys.argv[1]) if len(sys.argv) > 1 else 200
free_target_mb = int(sys.argv[2]) if len(sys.argv) > 2 else 250
chunk_mb = 256
t_end = time.time() + hold_s
torch.cuda.init()
torch.cuda.synchronize(1)
hold = []
# Phase 1: squeeze down to target.
while time.time() < t_end:
    free, _ = torch.cuda.mem_get_info(1)
    if free // 2**20 > free_target_mb:
        try:
            take = min(chunk_mb, int(free // 2**20) - free_target_mb)
            if take <= 0:
                take = 64
            hold.append(torch.empty(take * 1024 * 1024, dtype=torch.uint8, device="cuda:1"))
            continue
        except RuntimeError:
            pass
    break
# Phase 2: STATIC hold — never top-up. The sidecar's admission reclaim ladder
# calls empty_cache() and re-sizes its own cached segments; a top-up loop would
# win that race for the sidecar. Holding the already-allocated tensors fixed
# keeps real free memory pinned so /transcribe genuinely hits noCapacity.
while time.time() < t_end:
    free, _ = torch.cuda.mem_get_info(1)
    print(f"HOLD chunks={len(hold)} free={free // 2**20}MiB rem={t_end - time.time():.0f}s", flush=True)
    time.sleep(2)
print("FILLER_TTL_EXPIRED releasing", flush=True)
print("FILLER_TTL_EXPIRED releasing", flush=True)

