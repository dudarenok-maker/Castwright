# server/tts-sidecar/tests/test_error_responses.py
import sys, os, json, logging, re
SIDECAR_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SIDECAR_ROOT not in sys.path:
    sys.path.insert(0, SIDECAR_ROOT)
import main  # noqa: E402

def test_error_response_hides_exception_detail():
    resp = main.error_response(ValueError("secret-path /home/user/x"), logging.getLogger("t"))
    body = json.loads(bytes(resp.body).decode())
    assert "secret-path" not in json.dumps(body)
    assert body["status"] == "error"
    assert body["error"]

def test_no_exception_text_reaches_a_response():
    src = open(os.path.join(SIDECAR_ROOT, "main.py"), encoding="utf-8").read()
    for ln in src.splitlines():
        code = ln.split("#", 1)[0]  # ignore comments
        # (a) no str(e)/repr(e) directly on a response-building line …
        if "JSONResponse" in code or '"error"' in code or '"detail"' in code:
            assert "str(e)" not in code and "repr(e)" not in code, ln
        # (b) … and no `err_str = str(e)` / `= repr(e)` local that later feeds a body
        assert not re.search(r"=\s*(str|repr)\(e\)", code), ln
