"""Hold nearly all of cuda:1's free VRAM until killed. Arg 1 = MB to leave free."""
import sys
import time
import torch

leave_mb = int(sys.argv[1]) if len(sys.argv) > 1 else 120
free, total = torch.cuda.mem_get_info(1)
hold = free - leave_mb * 1024 * 1024
t = torch.empty(hold, dtype=torch.uint8, device="cuda:1")
torch.cuda.synchronize()
free2, _ = torch.cuda.mem_get_info(1)
print(f"held {hold / 2**20:.0f} MiB on cuda:1; free now {free2 / 2**20:.0f} MiB", flush=True)
while True:
    time.sleep(5)

torch.cuda.synchronize()
free2, _ = torch.cuda.mem_get_info(1)
print(f"held {hold / 2**20:.0f} MiB on cuda:1; free now {free2 / 2**20:.0f} MiB", flush=True)
while True:
    time.sleep(5)
