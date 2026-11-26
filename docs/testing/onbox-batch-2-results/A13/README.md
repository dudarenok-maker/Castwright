# A13 on-box evidence (2026-11-27, #4711 / #4699)

Single card: RTX 4070 Laptop 8 GB, `CUDA_VISIBLE_DEVICES=0`, 0 MiB used at start and at end.
Sidecar run directly from this worktree on :9050 (`uvicorn main:app`), driven over HTTP; Node server not started.

- `bullet2-sidecar-run1-trimmed.log` - NEGATIVE CONTROL: Qwen op arrived <30 s after Coqui load -> HTTP 503
  `{"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}`, Coqui NOT freed (still inside TTL). Second try
  33 s after load -> `Coqui model freed (idle).` + `admission ladder (qwen): evicted step coqui on cuda:0`.
- `bullet2-sidecar-run2-trimmed.log` - clean restart: Coqui load 09:00:14, Qwen op 09:00:57 (43 s idle) ->
  `Coqui model freed (idle).` 09:00:57.486, Qwen Base loaded 09:01:08. The Qwen FORWARD never finished (see register note).
- `bullet4-sidecar-log.txt`, `sidecar-run3-bullet4-full.err.log` - Stop on Coqui mid-synth: pre-unload inflight=1,
  `/unload` -> 200 `{"status":"idle"}` after 13.86 s, synth -> 200, 1,059,456 bytes in 17.82 s, poisoned=false,
  log line `Coqui model unloaded.` 09:09:22.568, no AttributeError.
- Cold Coqui load measured 3x on this box: 18.6 s, ~20 s, ~20 s (weights on disk).
