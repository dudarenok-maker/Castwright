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
        self.tainted_vars: List[str] = []  # Variables assigned from exception stringification

    def visit_ExceptHandler(self, node: ast.ExceptHandler):
        """Track exception handler variable names."""
        self.except_var_stack.append(self.current_except_var)
        self.current_except_var = node.name
        # Reset tainted vars for this except block
        old_tainted = self.tainted_vars
        self.tainted_vars = []
        self.generic_visit(node)
        self.tainted_vars = old_tainted
        self.current_except_var = self.except_var_stack.pop()

    def visit_Assign(self, node: ast.Assign):
        """Track variables assigned from exception stringifications."""
        if self.current_except_var:
            # Check if this assignment is from an exception stringification
            if self._contains_stringified_exception(node.value):
                # Mark all targets as tainted
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        if target.id not in self.tainted_vars:
                            self.tainted_vars.append(target.id)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        """Check JSONResponse() calls for exception text."""
        if self._is_json_response_call(node):
            self._check_node_for_exception_text(node)
        self.generic_visit(node)

    def _is_json_response_call(self, node: ast.Call) -> bool:
        """Check if this is a JSONResponse(...) or HTTPException(...) call."""
        if isinstance(node.func, ast.Name):
            return node.func.id in ("JSONResponse", "HTTPException")
        if isinstance(node.func, ast.Attribute):
            return node.func.attr in ("JSONResponse", "HTTPException")
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

        # Check if this is a tainted variable (assigned from exception stringification)
        if isinstance(node, ast.Name):
            if node.id in self.tainted_vars:
                self._report_violation(node, f"tainted variable '{node.id}' assigned from exception stringification")
                return

        if isinstance(node, ast.JoinedStr):  # f-string
            if self._fstring_contains_exception(node):
                self._report_violation(node, f"f-string contains exception variable")
        elif isinstance(node, ast.Call):
            if self._is_stringification_call(node):
                if self._call_stringifies_exception(node):
                    self._report_violation(node, "str()/repr() of exception variable")
            elif self._is_format_call(node):
                # Check for .format(e) method calls
                if self._format_call_stringifies_exception(node):
                    self._report_violation(node, ".format() of exception variable")
            else:
                # Recursively check nested calls (e.g., JSONResponse(content={"detail": f"{e}"}))
                for arg in node.args:
                    self._check_for_exception_string(arg)
                for keyword in node.keywords:
                    self._check_for_exception_string(keyword.value)
        elif isinstance(node, ast.BinOp):
            # Check for string concatenation with exception (e.g., "..." + str(e))
            if self._binop_contains_exception_string(node):
                self._report_violation(node, "exception text in binary operation")
        elif isinstance(node, ast.Dict):
            # Check dictionary values for exception text
            for value in node.values:
                if value is not None:
                    self._check_for_exception_string(value)
        elif isinstance(node, ast.List):
            # Check list elements
            for elt in node.elts:
                self._check_for_exception_string(elt)
        elif isinstance(node, ast.Tuple):
            # Check tuple elements
            for elt in node.elts:
                self._check_for_exception_string(elt)
        elif isinstance(node, ast.ListComp):
            # Check list comprehensions
            self._check_for_exception_string(node.elt)
            for generator in node.generators:
                for if_clause in generator.ifs:
                    self._check_for_exception_string(if_clause)
        elif isinstance(node, ast.DictComp):
            # Check dict comprehensions
            self._check_for_exception_string(node.key)
            self._check_for_exception_string(node.value)
            for generator in node.generators:
                for if_clause in generator.ifs:
                    self._check_for_exception_string(if_clause)
        elif isinstance(node, ast.SetComp):
            # Check set comprehensions
            self._check_for_exception_string(node.elt)
            for generator in node.generators:
                for if_clause in generator.ifs:
                    self._check_for_exception_string(if_clause)
        elif isinstance(node, ast.GeneratorExp):
            # Check generator expressions
            self._check_for_exception_string(node.elt)
            for generator in node.generators:
                for if_clause in generator.ifs:
                    self._check_for_exception_string(if_clause)

    def _fstring_contains_exception(self, node: ast.JoinedStr) -> bool:
        """Check if an f-string (JoinedStr) references the exception variable."""
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                if self._expr_references_exception(value.value):
                    return True
        return False

    def _call_stringifies_exception(self, node: ast.Call) -> bool:
        """Check if a str()/repr()/.__str__() call has the exception as its argument."""
        if not self._is_stringification_call(node):
            return False
        # For str() and repr(): check first argument
        if node.args and self._expr_references_exception(node.args[0]):
            return True
        # For __str__() method call: check if called on exception variable
        if isinstance(node.func, ast.Attribute) and node.func.attr == "__str__":
            if self._expr_references_exception(node.func.value):
                return True
        return False

    def _is_stringification_call(self, node: ast.Call) -> bool:
        """Check if this is a str() or repr() call."""
        if isinstance(node.func, ast.Name):
            return node.func.id in ("str", "repr")
        # Also check for __str__() method calls
        if isinstance(node.func, ast.Attribute):
            return node.func.attr == "__str__"
        return False

    def _is_format_call(self, node: ast.Call) -> bool:
        """Check if this is a .format() method call."""
        if isinstance(node.func, ast.Attribute):
            return node.func.attr == "format"
        return False

    def _format_call_stringifies_exception(self, node: ast.Call) -> bool:
        """Check if a .format() call has the exception as its argument."""
        if not self._is_format_call(node):
            return False
        # Check positional arguments
        for arg in node.args:
            if self._expr_references_exception(arg):
                return True
        # Check keyword arguments
        for keyword in node.keywords:
            if self._expr_references_exception(keyword.value):
                return True
        return False

    def _binop_contains_exception_string(self, node: ast.BinOp) -> bool:
        """Check if a binary operation contains stringified exception.

        Detects patterns like:
        - "string" + str(e)
        - "string" % e  (old-style formatting)
        """
        if isinstance(node.op, (ast.Add, ast.Mod)):
            # Check left operand
            if self._contains_stringified_exception(node.left):
                return True
            # Check right operand
            if self._contains_stringified_exception(node.right):
                return True
        return False

    def _contains_stringified_exception(self, node: ast.expr) -> bool:
        """Check if an expression is or contains a stringified exception."""
        if isinstance(node, ast.Call):
            if self._is_stringification_call(node):
                return self._call_stringifies_exception(node)
            if self._is_format_call(node):
                return self._format_call_stringifies_exception(node)
        elif isinstance(node, ast.BinOp):
            # Check for binary operations (e.g., "string" % e or "string" + str(e))
            return self._binop_contains_exception_string(node)
        elif isinstance(node, ast.List):
            # Check list elements
            for elt in node.elts:
                if self._contains_stringified_exception(elt):
                    return True
        elif isinstance(node, ast.Tuple):
            # Check tuple elements
            for elt in node.elts:
                if self._contains_stringified_exception(elt):
                    return True
        elif isinstance(node, ast.ListComp):
            # Check list comprehension - check if the element or generators contain exception
            if self._contains_stringified_exception(node.elt):
                return True
            for generator in node.generators:
                if self._contains_stringified_exception(generator.iter):
                    return True
                for if_clause in generator.ifs:
                    if self._contains_stringified_exception(if_clause):
                        return True
        elif isinstance(node, ast.SetComp):
            # Check set comprehension
            if self._contains_stringified_exception(node.elt):
                return True
            for generator in node.generators:
                if self._contains_stringified_exception(generator.iter):
                    return True
                for if_clause in generator.ifs:
                    if self._contains_stringified_exception(if_clause):
                        return True
        elif isinstance(node, ast.DictComp):
            # Check dict comprehension
            if self._contains_stringified_exception(node.key) or self._contains_stringified_exception(node.value):
                return True
            for generator in node.generators:
                if self._contains_stringified_exception(generator.iter):
                    return True
                for if_clause in generator.ifs:
                    if self._contains_stringified_exception(if_clause):
                        return True
        elif isinstance(node, ast.GeneratorExp):
            # Check generator expression
            if self._contains_stringified_exception(node.elt):
                return True
            for generator in node.generators:
                if self._contains_stringified_exception(generator.iter):
                    return True
                for if_clause in generator.ifs:
                    if self._contains_stringified_exception(if_clause):
                        return True
        elif isinstance(node, ast.Attribute):
            # Check for e.something (attribute access on exception)
            return self._expr_references_exception(node)
        elif isinstance(node, ast.Name):
            # Check if it's just the exception variable
            return self._expr_references_exception(node)
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
