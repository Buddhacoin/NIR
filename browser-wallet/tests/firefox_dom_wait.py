"""Retry only Firefox's transient reference to a DOM node removed by rerender.

The caller's WebDriverWait retains its existing deadline and performs a fresh
element lookup on each poll. Other driver errors remain terminal.
"""


def retry_dead_object(predicate, browser, webdriver_error):
    try:
        return predicate(browser)
    except webdriver_error as error:
        if "can't access dead object" not in str(error):
            raise
        return False
