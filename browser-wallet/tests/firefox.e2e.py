"""Real Firefox MV3 onboarding smoke test for the unsigned test-only package.

Requires Selenium and Firefox. Selenium Manager supplies geckodriver. Each
WebDriver session uses its own temporary profile; no personal profile is read.
"""

from __future__ import annotations

from pathlib import Path
import os

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as conditions
from selenium.webdriver.support.ui import WebDriverWait


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "artifacts/firefox/nir-wallet-firefox-preview-0.1.0-unsigned.zip"
PASSWORD = "correct horse battery staple"
NEW_PASSWORD = "a new device password 123"


def driver():
    options = Options()
    options.add_argument("-headless")
    if binary := os.environ.get("NIR_TEST_FIREFOX_BINARY"):
        options.binary_location = binary
    # Firefox 138+ requires this geckodriver flag for moz-extension pages.
    return webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))


def wallet_tab(browser):
    def find(_):
        for handle in browser.window_handles:
            browser.switch_to.window(handle)
            if browser.current_url.startswith("moz-extension://") and browser.current_url.endswith("/wallet.html"):
                return True
        return False

    WebDriverWait(browser, 20).until(find)
    return browser


def visible(browser, selector):
    return WebDriverWait(browser, 20).until(
        conditions.visibility_of_element_located((By.CSS_SELECTOR, selector))
    )


def click(browser, selector):
    WebDriverWait(browser, 20).until(
        conditions.element_to_be_clickable((By.CSS_SELECTOR, selector))
    ).click()


def fill(browser, selector, value):
    visible(browser, selector).send_keys(value)


def create_wallet(browser):
    browser.install_addon(str(PACKAGE), temporary=True)
    wallet_tab(browser)
    visible(browser, "#welcome")
    click(browser, "#start-create")
    fill(browser, "#create-form [name=password]", PASSWORD)
    fill(browser, "#create-form [name=confirmation]", PASSWORD)
    click(browser, "#create-form button[type=submit]")
    visible(browser, "#backup")
    words = [cell.text.split(".", 1)[-1].strip()
             for cell in browser.find_elements(By.CSS_SELECTOR, "#phrase-grid span")]
    assert len(words) == 24 and all(words), "24 recovery words must be shown"
    click(browser, "#backup-next")
    for position in (3, 11, 19):
        fill(browser, f"#confirm-fields [name=word{position}]", words[position])
    click(browser, "#confirm-form button[type=submit]")
    visible(browser, "#home")
    address = browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent")
    assert address.startswith("nir1") and len(address) == 68
    click(browser, "#nav-settings")
    click(browser, "#lock-wallet")
    visible(browser, "#unlock")
    browser.refresh()
    visible(browser, "#unlock")
    fill(browser, "#unlock-form [name=password]", "wrong password 123")
    click(browser, "#unlock-form button[type=submit]")
    visible(browser, "#unlock")
    browser.find_element(By.CSS_SELECTOR, "#unlock-form [name=password]").clear()
    fill(browser, "#unlock-form [name=password]", PASSWORD)
    click(browser, "#unlock-form button[type=submit]")
    visible(browser, "#home")
    assert browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent") == address
    return words, address


def restore_on_clean_device(browser, words, expected_address):
    browser.install_addon(str(PACKAGE), temporary=True)
    wallet_tab(browser)
    visible(browser, "#welcome")
    click(browser, "#start-restore")
    fill(browser, "#restore-form [name=phrase]", " ".join(words))
    fill(browser, "#restore-form [name=password]", NEW_PASSWORD)
    fill(browser, "#restore-form [name=confirmation]", NEW_PASSWORD)
    click(browser, "#restore-form button[type=submit]")
    visible(browser, "#home")
    assert browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent") == expected_address


def main():
    assert PACKAGE.is_file(), "run npm run package:firefox first"
    first = driver()
    try:
        words, address = create_wallet(first)
    finally:
        first.quit()
    second = driver()
    try:
        restore_on_clean_device(second, words, address)
    finally:
        second.quit()
    print("Firefox extension onboarding, unlock, and clean-profile restoration passed")


if __name__ == "__main__":
    main()
