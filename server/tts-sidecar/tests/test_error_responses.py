# server/tts-sidecar/tests/test_error_responses.py
import sys, os, json, logging, re, tempfile
SIDECAR_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SIDECAR_ROOT not in sys.path:
    sys.path.insert(0, SIDECAR_ROOT)
import main  # noqa: E402
from exception_text_guard import check_exception_text_in_file, report_violations  # noqa: E402

def test_error_response_hides_exception_detail():
    resp = main.error_response(ValueError("secret-path /home/user/x"), logging.getLogger("t"))
    body = json.loads(bytes(resp.body).decode())
    assert "secret-path" not in json.dumps(body)
    assert body["status"] == "error"
    assert body["error"]

def test_no_exception_text_reaches_a_response():
    """Integration test: scan main.py for exception text in response bodies.

    Uses the AST-based guard to detect any exception variables (from except...as
    handlers) being stringified and passed to JSONResponse or included in response
    dictionaries. Lines with '# exc-text-safe: <reason>' markers are excluded.
    """
    main_py = os.path.join(SIDECAR_ROOT, "main.py")
    violations = check_exception_text_in_file(main_py)

    # Report any violations
    assert len(violations) == 0, f"Found exception text leaks:\n{report_violations(violations)}"

def test_guard_catches_fstring_and_attribute_patterns():
    """Test the AST-based guard against synthetic code snippets.

    Verifies the guard correctly catches:
    1. Direct f-strings with exception variables in JSONResponse calls
    2. Exception attribute access in response contexts
    3. str()/repr() calls on exceptions in responses
    4. Identifier-agnostic matching (e, exc, err, exception, ex, etc.)

    And correctly ignores lines marked with '# exc-text-safe:'.
    """

    test_cases = [
        # Test case 0: direct f-string in JSONResponse should CATCH
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except Exception as e:
        return JSONResponse({"detail": f"{e}"})
""", True, "direct f-string in JSONResponse"),

        # Test case 1: exception attribute access should CATCH
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except ValueError as exc:
        return JSONResponse({"error": f"Failed: {exc.reason}"})
""", True, "exception attribute in f-string"),

        # Test case 2: str() of exception in response should CATCH
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except RuntimeError as err:
        return JSONResponse(content={"detail": str(err)})
""", True, "str() of exception in response"),

        # Test case 3: marked as safe should IGNORE
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except Exception as e:
        return JSONResponse({"detail": f"{e}"})  # exc-text-safe: test
""", False, "marked with exc-text-safe"),

        # Test case 4: exception text outside response should IGNORE
        ("""
import asyncio
from fastapi.responses import JSONResponse
import re

async def test_case():
    try:
        await asyncio.sleep(0)
    except Exception as e:
        result = re.search("pattern", f"{e}")
        return JSONResponse({"ok": True})
""", False, "exception text used for pattern matching"),

        # Test case 5: different variable names (exception) should CATCH
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except RuntimeError as exception:
        return JSONResponse({"detail": f"{exception}"})
""", True, "variable name 'exception'"),

        # Test case 6: different variable names (ex) should CATCH
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    try:
        await asyncio.sleep(0)
    except OSError as ex:
        return JSONResponse({"detail": f"{ex}"})
""", True, "variable name 'ex'"),

        # Test case 7: non-exception variables should IGNORE
        ("""
import asyncio
from fastapi.responses import JSONResponse

async def test_case():
    error_msg = "some error"
    return JSONResponse({"detail": f"{error_msg}"})
""", False, "non-exception variable"),
    ]

    for test_code, should_violate, description in test_cases:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(test_code)
            temp_file = f.name

        try:
            violations = check_exception_text_in_file(temp_file)

            if should_violate:
                assert len(violations) > 0, (
                    f"Case '{description}' should have triggered a violation but didn't.\n"
                    f"Violations: {violations}"
                )
            else:
                assert len(violations) == 0, (
                    f"Case '{description}' should NOT have triggered a violation but did:\n"
                    f"Violations: {report_violations(violations)}"
                )
        finally:
            os.unlink(temp_file)
