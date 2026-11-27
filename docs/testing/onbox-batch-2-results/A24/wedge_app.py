# Test harness (NOT repo code): imports the real sidecar app, then lets a test
# claim/release QwenEngine._design_in_flight to emulate a wedged design thread.
import sys, os, threading
sys.path.insert(0, r"C:\Claude\Projects\wt-onbox-batch-2\server\tts-sidecar")
os.chdir(r"C:\Claude\Projects\wt-onbox-batch-2\server\tts-sidecar")
import main
from fastapi.responses import JSONResponse
app = main.app
_held = {}
@app.post("/_test/wedge")
async def wedge():
    q = main.ENGINES["qwen"]
    cm = q._design_in_flight.claim(); cm.__enter__(); _held["cm"] = cm
    return JSONResponse({"busy": q._design_in_flight.busy})
@app.post("/_test/unwedge")
async def unwedge():
    q = main.ENGINES["qwen"]
    _held.pop("cm").__exit__(None, None, None)
    return JSONResponse({"busy": q._design_in_flight.busy})
