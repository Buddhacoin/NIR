"""Real Firefox MV3 onboarding smoke test for the unsigned test-only package.

Requires Selenium and Firefox. Selenium Manager supplies geckodriver. Each
WebDriver session uses its own temporary profile; no personal profile is read.
"""

from __future__ import annotations

from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import json
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


def observer_report_cannot_become_network_balance(browser, address):
    origin = browser.current_url.split("/wallet.html", 1)[0]
    network = "nir-firefox-ui-test"
    genesis = "c" * 64
    token = "b" * 64

    class FakeObserver(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def headers_for_response(self, status):
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type, x-nir-observer-token")
            self.send_header("Content-Type", "application/json")
            self.end_headers()

        def do_OPTIONS(self):
            self.headers_for_response(204)

        def do_POST(self):
            assert self.path == "/v1/refresh-account"
            assert self.headers.get("x-nir-observer-token") == token
            self.headers_for_response(200)
            self.wfile.write(json.dumps({
                "verified": True, "address": address, "networkId": network,
                "genesisHash": genesis,
                "statement": {"networkId": network, "height": 1,
                              "tipHash": "d" * 64,
                              "account": {"address": address,
                                          "atomicBalance": "999999999999999"}},
            }).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeObserver)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        click(browser, "#nav-settings")
        fill(browser, "#observer-form [name=url]", f"http://127.0.0.1:{server.server_port}")
        fill(browser, "#observer-form [name=token]", token)
        fill(browser, "#observer-form [name=networkId]", network)
        fill(browser, "#observer-form [name=genesisHash]", genesis)
        click(browser, "#observer-form button[type=submit]")
        visible(browser, "#observer-report")
        assert browser.find_element(By.CSS_SELECTOR, "#verified-balance").text == "—"
        assert browser.find_element(By.CSS_SELECTOR, "#observer-amount").text == "9999999.99999999"
        click(browser, "#locale-en")
        assert "did not verify signatures independently" in visible(browser, "#observer-report").text
        assert browser.find_element(By.CSS_SELECTOR, "#verified-balance").text == "—"
        click(browser, "#locale-ru")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


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
    observer_report_cannot_become_network_balance(browser, address)
    click(browser, "#open-accounts")
    click(browser, "#add-account")
    visible(browser, "#home")
    second_address = browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent")
    assert second_address != address
    click(browser, "#nav-settings")
    click(browser, "#show-phrase-form")
    fill(browser, "#reveal-form [name=password]", PASSWORD)
    click(browser, "#reveal-form button[type=submit]")
    visible(browser, "#reveal-result")
    assert len(browser.find_elements(By.CSS_SELECTOR, "#reveal-grid span")) == 24
    browser.execute_script("window.dispatchEvent(new Event('blur'))")
    visible(browser, "#unlock")
    assert len(browser.find_elements(By.CSS_SELECTOR, "#reveal-grid span")) == 0
    browser.refresh()
    visible(browser, "#unlock")
    fill(browser, "#unlock-form [name=password]", "wrong password 123")
    click(browser, "#unlock-form button[type=submit]")
    visible(browser, "#unlock")
    browser.find_element(By.CSS_SELECTOR, "#unlock-form [name=password]").clear()
    fill(browser, "#unlock-form [name=password]", PASSWORD)
    click(browser, "#unlock-form button[type=submit]")
    visible(browser, "#home")
    assert browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent") == second_address
    return words, address, second_address


def restore_on_clean_device(browser, words, expected_address, expected_second_address):
    browser.install_addon(str(PACKAGE), temporary=True)
    wallet_tab(browser)
    visible(browser, "#welcome")
    click(browser, "#locale-en")
    assert browser.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == "en"
    assert "no real funds" in browser.find_element(By.CSS_SELECTOR, ".notice").text
    browser.refresh()
    visible(browser, "#welcome")
    assert browser.find_element(By.CSS_SELECTOR, "html").get_attribute("lang") == "en"
    click(browser, "#locale-ru")
    click(browser, "#start-restore")
    fill(browser, "#restore-form [name=phrase]", "sensitive words must not persist")
    click(browser, "#restore [data-back=welcome]")
    click(browser, "#start-restore")
    assert browser.find_element(By.CSS_SELECTOR, "#restore-form [name=phrase]").get_attribute("value") == ""
    fill(browser, "#restore-form [name=phrase]", " ".join(words))
    fill(browser, "#restore-form [name=password]", NEW_PASSWORD)
    fill(browser, "#restore-form [name=confirmation]", NEW_PASSWORD)
    click(browser, "#restore-form button[type=submit]")
    visible(browser, "#home")
    assert browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent") == expected_address
    click(browser, "#open-accounts")
    WebDriverWait(browser, 20).until(
        lambda current: len(current.find_elements(By.CSS_SELECTOR, "#account-list button")) == 16
    )
    visible(browser, "#accounts")
    click(browser, "#account-list button:nth-child(2)")
    assert browser.find_element(By.CSS_SELECTOR, "#full-address").get_attribute("textContent") == expected_second_address


def main():
    assert PACKAGE.is_file(), "run npm run package:firefox first"
    first = driver()
    try:
        words, address, second_address = create_wallet(first)
    finally:
        first.quit()
    second = driver()
    try:
        restore_on_clean_device(second, words, address, second_address)
    finally:
        second.quit()
    print("Firefox extension onboarding, unlock, and clean-profile restoration passed")


if __name__ == "__main__":
    main()
