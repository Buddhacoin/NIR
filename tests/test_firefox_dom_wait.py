"""Bounded Firefox DOM-replacement handling used by the real extension drill."""

import importlib.util
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "browser-wallet/tests/firefox_dom_wait.py"
WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/test.yml"
SPEC = importlib.util.spec_from_file_location("firefox_dom_wait", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeWebDriverError(Exception):
    pass


class FirefoxDomWaitTests(unittest.TestCase):
    def test_ci_uses_fixed_browsers_on_both_sides_of_the_failure(self):
        workflow = WORKFLOW.read_text(encoding="utf8")
        self.assertIn('firefox-version: "157.0.1"', workflow)
        self.assertIn('firefox-version: "158.0"', workflow)
        self.assertIn("steps.firefox157.outputs.firefox-path", workflow)
        self.assertIn("steps.firefox158.outputs.firefox-path", workflow)

    def test_deleted_element_is_retried_then_live_element_is_required(self):
        calls = 0

        def find(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise FakeWebDriverError("TypeError: can't access dead object")
            return "live element"

        self.assertFalse(MODULE.retry_dead_object(find, object(), FakeWebDriverError))
        self.assertEqual(MODULE.retry_dead_object(find, object(), FakeWebDriverError), "live element")
        self.assertEqual(calls, 2)

    def test_other_webdriver_failures_are_not_hidden(self):
        def broken(_):
            raise FakeWebDriverError("invalid selector")

        with self.assertRaisesRegex(FakeWebDriverError, "invalid selector"):
            MODULE.retry_dead_object(broken, object(), FakeWebDriverError)


if __name__ == "__main__":
    unittest.main()
