"""#4961 — the real-import probe the server runs before spawning the sidecar to
decide whether a pre-1.15 Coqui install needs the text-splitting packages."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import text_split_deps  # noqa: E402


def _importer(broken: set):
    def _fn(name: str):
        if name in broken:
            raise ImportError(f"No module named {name!r}")
        return object()

    return _fn


def test_all_importable_reports_nothing_missing():
    assert text_split_deps.missing_text_split_modules(_importer(set())) == []


def test_reports_each_missing_module_by_import_name():
    got = text_split_deps.missing_text_split_modules(_importer({"spacy", "sudachidict_core"}))
    assert got == ["spacy", "sudachidict_core"]


def test_present_but_unimportable_counts_as_missing():
    # A half-installed package (native extension fails to load) raises something
    # other than ImportError — it must still read as missing, not crash the probe.
    def _fn(name: str):
        if name == "sudachipy":
            raise OSError("DLL load failed")
        return object()

    assert text_split_deps.missing_text_split_modules(_fn) == ["sudachipy"]


def test_required_set_covers_spacy_and_sudachi():
    # The #2017 (spacy) + #2038 (SudachiPy + dict) packages the installer's third step adds.
    assert set(text_split_deps.REQUIRED_TEXT_SPLIT_MODULES) == {
        "spacy",
        "sudachipy",
        "sudachidict_core",
    }


def test_script_exit_code_and_stdout_when_a_module_is_missing():
    # Run the real script with spacy blocked from importing: exit 1, names on stdout.
    code = (
        "import sys, runpy\n"
        "sys.modules['spacy'] = None\n"  # None in sys.modules => ImportError on import
        f"sys.argv = [{str(SIDECAR_ROOT / 'text_split_deps.py')!r}]\n"
        f"runpy.run_path({str(SIDECAR_ROOT / 'text_split_deps.py')!r}, run_name='__main__')\n"
    )
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert res.returncode == 1
    assert "spacy" in res.stdout.split()
