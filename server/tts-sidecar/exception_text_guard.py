"""
AST-based guard to detect exception text leaking into response bodies.

Catches patterns where exception variables (from except...as handlers) are
converted to strings (via f-strings, str(), repr()) and passed to JSONResponse
or included in response dictionaries.

Allows opt-out via '# exc-text-safe: <reason>' markers on the same or adjacent line
when the exception text is used only for classification/logging, not responses.
"""

import ast
import re
from typing import List, Tuple, Optional


class ExceptionTextChecker(ast.NodeVisitor):
    """AST visitor to find exception variables used in response contexts."""

    def __init__(self, source_lines: List[str]):
        self.source_lines = source_lines
        self.violations: List[Tuple[int, str, str]] = []  # (line_no, line_text, reason)
        self.current_except_var: Optional[str] = None
        self.except_var_stack: List[Optional[str]] = []

    def visit_ExceptHandler(self, node: ast.ExceptHandler):
        """Track exception handler variable names."""
        self.except_var_stack.append(self.current_except_var)
        self.current_except_var = node.name
        self.generic_visit(node)
        self.current_except_var = self.except_var_stack.pop()

    def visit_Call(self, node: ast.Call):
        """Check JSONResponse() calls for exception text."""
        if self._is_json_response_call(node):
            self._check_node_for_exception_text(node)
        self.generic_visit(node)

    def _is_json_response_call(self, node: ast.Call) -> bool:
        """Check if this is a JSONResponse(...) call."""
        if isinstance(node.func, ast.Name) and node.func.id == "JSONResponse":
            return True
        if isinstance(node.func, ast.Attribute) and node.func.attr == "JSONResponse":
            return True
        return False

    def _check_node_for_exception_text(self, node: ast.Call):
        """Recursively check node arguments for exception text patterns."""
        # Check all positional and keyword arguments
        for arg in node.args:
            self._check_for_exception_string(arg)
        for keyword in node.keywords:
            self._check_for_exception_string(keyword.value)

    def _check_for_exception_string(self, node: ast.expr):
        """Recursively check if a node contains stringified exception."""
        if not self.current_except_var:
            return

        if isinstance(node, ast.JoinedStr):  # f-string
            if self._fstring_contains_exception(node):
                self._report_violation(node, f"f-string contains exception variable")
        elif isinstance(node, ast.Call):
            if self._is_stringification_call(node):
                if self._call_stringifies_exception(node):
                    self._report_violation(node, "str()/repr() of exception variable")
            else:
                # Recursively check nested calls (e.g., JSONResponse(content={"detail": f"{e}"}))
                for arg in node.args:
                    self._check_for_exception_string(arg)
                for keyword in node.keywords:
                    self._check_for_exception_string(keyword.value)
        elif isinstance(node, ast.Dict):
            # Check dictionary values for exception text
            for value in node.values:
                if value is not None:
                    self._check_for_exception_string(value)
        elif isinstance(node, ast.List):
            # Check list elements
            for elt in node.elts:
                self._check_for_exception_string(elt)

    def _fstring_contains_exception(self, node: ast.JoinedStr) -> bool:
        """Check if an f-string (JoinedStr) references the exception variable."""
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                if self._expr_references_exception(value.value):
                    return True
        return False

    def _call_stringifies_exception(self, node: ast.Call) -> bool:
        """Check if a str()/repr() call has the exception as its argument."""
        if not self._is_stringification_call(node):
            return False
        if node.args and self._expr_references_exception(node.args[0]):
            return True
        return False

    def _is_stringification_call(self, node: ast.Call) -> bool:
        """Check if this is a str() or repr() call."""
        if isinstance(node.func, ast.Name):
            return node.func.id in ("str", "repr")
        return False

    def _expr_references_exception(self, node: ast.expr) -> bool:
        """Check if an expression references the current exception variable."""
        if isinstance(node, ast.Name):
            return node.id == self.current_except_var
        elif isinstance(node, ast.Attribute):
            # Check if the base object is the exception variable
            return isinstance(node.value, ast.Name) and node.value.id == self.current_except_var
        return False

    def _report_violation(self, node: ast.expr, reason: str):
        """Report a violation at the given AST node."""
        line_no = node.lineno
        if line_no > 0 and line_no <= len(self.source_lines):
            line_text = self.source_lines[line_no - 1]
            self.violations.append((line_no, line_text, reason))


def check_exception_text_in_file(filepath: str) -> List[Tuple[int, str, str]]:
    """
    Check a Python file for exception text leaking into responses.

    Returns a list of (line_no, line_text, reason) tuples for violations.
    Lines marked with '# exc-text-safe:' are automatically skipped.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()

    source_lines = source.splitlines()

    # Parse the entire file as AST
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [(e.lineno or 0, "", f"SyntaxError: {e}")]

    # Run the visitor
    checker = ExceptionTextChecker(source_lines)
    checker.visit(tree)

    # Filter out violations that have exc-text-safe markers
    violations = []
    for line_no, line_text, reason in checker.violations:
        # Check this line and adjacent lines for the marker
        is_marked_safe = False
        for check_line in [line_no - 1, line_no, line_no + 1]:
            if 0 < check_line <= len(source_lines):
                if "exc-text-safe" in source_lines[check_line - 1]:
                    is_marked_safe = True
                    break

        if not is_marked_safe:
            violations.append((line_no, line_text, reason))

    return violations


def report_violations(violations: List[Tuple[int, str, str]]) -> str:
    """Format violations as a human-readable report."""
    if not violations:
        return "No exception text leaks found."

    lines = ["Found exception text leaks in response bodies:"]
    for line_no, line_text, reason in violations:
        lines.append(f"  Line {line_no}: {reason}")
        lines.append(f"    {line_text.strip()}")

    return "\n".join(lines)
