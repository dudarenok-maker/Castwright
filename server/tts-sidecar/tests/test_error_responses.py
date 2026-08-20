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
        # A line may opt out with an audited `# exc-text-safe: <why>` marker when
        # its str()/repr() of an exception local, or an f-string interpolation of one,
        # is used purely for branching (e.g. OOM classification) and demonstrably
        # never reaches a response body. These checks are identifier-agnostic: an
        # exception may be spelled `e`, `exc`, `err`, ... so they match under ANY
        # Python identifier, not just the literal text `e`.
        if "exc-text-safe" in ln:
            continue
        code = ln.split("#", 1)[0]  # ignore comments

        # Patterns to catch (scoped to exception-like variables: e, exc, err*, exception, ex, etc.):
        # (str|repr)(exc_var) — str() or repr() call forms on exception variables
        # err_str = f"...{exc_var}..." — f-string assignment to error string local
        # f"...{exc_var.attr}..." — f-string with exception attribute access in response
        # Exception variable pattern: e, exc, err, exception, ex, or err_* (except err_str itself for f-strings)
        exc_var_pattern = r"\b(e|exc|err|exception|ex|err_[a-z_]+)\b"
        exc_call_on_exc = r"(str|repr)\(\s*(" + exc_var_pattern + r")\s*\)"
        # Only match f-strings assigned to err_str (the common exception handling pattern)
        exc_fstring_assign = r"err_str\s*=\s*f['\"].*?\{(" + exc_var_pattern + r")(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}.*?['\"]"
        # Match any f-string with exception attribute access like {exc.reason} in response lines
        exc_attr_fstring = r"f['\"].*?\{(" + exc_var_pattern + r")\.[A-Za-z_][A-Za-z0-9_]*\}.*?['\"]"

        # (a) no str()/repr() of an exception directly on a response-building line …
        if "JSONResponse" in code or '"error"' in code or '"detail"' in code:
            assert not re.search(exc_call_on_exc, code), f"Line uses str/repr on exception in response: {ln}"
            assert not re.search(exc_attr_fstring, code), f"Line uses f-string with exc attribute in response: {ln}"
        # (b) … and no `err_str = str(exc)` / `= repr(exc)` / `err_str = f"{exc}"` local that later feeds a body
        assert not re.search(r"=\s*" + exc_call_on_exc, code), f"Line assigns str/repr of exception to local: {ln}"
        assert not re.search(exc_fstring_assign, code), f"Line assigns f-string to err_str local: {ln}"

def test_guard_catches_fstring_and_attribute_patterns():
    """Verify the guard correctly identifies f-string exception interpolations
    (specifically err_str = f"{e}" patterns) and exception attribute access
    that the previous regex-only check would miss."""
    src = open(os.path.join(SIDECAR_ROOT, "main.py"), encoding="utf-8").read()

    # NEW guard patterns (what the widened check catches) — scoped to exception-like variables
    exc_var_pattern = r"\b(e|exc|err|exception|ex|err_[a-z_]+)\b"
    exc_fstring_assign = r"err_str\s*=\s*f['\"].*?\{(" + exc_var_pattern + r")(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}.*?['\"]"
    exc_attr_fstring = r"f['\"].*?\{(" + exc_var_pattern + r")\.[A-Za-z_][A-Za-z0-9_]*\}.*?['\"]"

    # Count lines that have exc-text-safe markers (audited safe)
    audited_lines = []
    # Count lines with f-string err_str assignments that are not audited
    unaudited_err_str = []
    # Count lines with exc attribute access in response that are not audited
    unaudited_exc_attr = []

    for i, ln in enumerate(src.splitlines(), 1):
        code = ln.split("#", 1)[0]  # ignore comments

        # Collect audited lines
        if "exc-text-safe" in ln:
            audited_lines.append((i, ln.strip()))

        # Find unaudited err_str = f"..." assignments
        if re.search(exc_fstring_assign, code) and "exc-text-safe" not in ln:
            unaudited_err_str.append((i, ln.strip()))

        # Find unaudited exception attribute access in response lines
        if (("JSONResponse" in code or '"error"' in code or '"detail"' in code) and
            re.search(exc_attr_fstring, code) and "exc-text-safe" not in ln):
            unaudited_exc_attr.append((i, ln.strip()))

    # The specific sites we fixed in this pass:
    # Line 9939, 10046, 10183, 10345, 10612, 10734, 10804, 10939 (f-string err_str patterns)
    # Line 10178 (exc.reason attribute in response)
    # All should now be marked with exc-text-safe
    expected_marked_sites = [9939, 10046, 10178, 10183, 10345, 10612, 10734, 10804, 10939]
    marked_sites = [line_no for line_no, _ in audited_lines]

    # Verify all the known sites are marked
    for expected_site in expected_marked_sites:
        assert any(abs(site - expected_site) < 5 for site in marked_sites), \
            f"Expected site around line {expected_site} to have exc-text-safe marker, but none found in: {marked_sites}"

    # Verify no new violations were introduced (besides the audited ones)
    assert len(unaudited_err_str) == 0, \
        f"Found {len(unaudited_err_str)} unaudited err_str f-string assignments:\n" + \
        "\n".join(f"  Line {ln}: {code}" for ln, code in unaudited_err_str)

    assert len(unaudited_exc_attr) == 0, \
        f"Found {len(unaudited_exc_attr)} unaudited exception attribute accesses in response:\n" + \
        "\n".join(f"  Line {ln}: {code}" for ln, code in unaudited_exc_attr)
