"""A19 probe helper: hold N MiB of VRAM on cuda:0 from a FOREIGN process
(torch CUDA context + 128 MB chunks until target or allocation failure).
Stands in for the real-world full-card condition ("any other op that would
otherwise be rejected on a full card"). Sleeps until killed."""
import sys
import time

import torch

target_mb = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
CHUNK = 128 * 1024 * 1024  # bytes held as float32 elements below
held = []
try:
    x = torch.zeros(1, device="cuda")  # initialize context first
    del x
    allocated = 0
    while allocated < target_mb * 1024 * 1024:
        try:
            held.append(torch.zeros(CHUNK // 4, dtype=torch.float32, device="cuda"))
            allocated += CHUNK
            print(f"filler: held {allocated // (1024*1024)} MiB", flush=True)
        except RuntimeError:
            print("filler: allocation failed at target, holding what we have", flush=True)
            break
    print(f"filler: READY held_mib={allocated // (1024*1024)}", flush=True)
    while True:
        time.sleep(5)
except KeyboardInterrupt:
    pass
