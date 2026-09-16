import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../wallet-ui/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../wallet-ui/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../wallet-ui/style.css", import.meta.url), "utf8");

test("wallet navigation has four interactive destinations", () => {
  for (const destination of ["home", "history", "mine", "settings"]) {
    assert.match(html, new RegExp(`data-nav="${destination}"`));
  }
  assert.match(script, /querySelectorAll\("\[data-nav\]"\)/);
  assert.match(script, /aria-current/);
});

test("visible secondary controls have actions", () => {
  assert.match(html, /class="network" data-action="network"/);
  assert.match(html, /data-action="history">Все/);
  for (const action of ["receive", "send", "mine", "history", "settings", "network"]) {
    assert.match(script, new RegExp(`${action}: \\[`));
  }
});

test("bottom navigation is a compact readable dock", () => {
  assert.match(styles, /nav \{ position: fixed/);
  assert.match(styles, /width: min\(422px, calc\(100% - 24px\)\)/);
  assert.match(styles, /nav button \{[^}]*min-height: 66px/s);
  assert.match(styles, /nav button svg \{[^}]*width: 25px/s);
  assert.match(styles, /nav \.active i \{ background: transparent; color: #111/);
  assert.match(styles, /data-nav="home"\]\.active svg \{ fill: currentColor/);
  assert.match(html, />Главная<\/span>/);
});

test("wallet uses a neutral monochrome interface", () => {
  assert.match(styles, /--bg: #f5f5f7/);
  assert.match(styles, /--bg: #080808/);
  assert.doesNotMatch(styles, /#f47b19|#ff9138|#e76300/);
  assert.match(html, /class="brand-logo" src="nir-coin-icon\.png\?v=18"/);
  assert.match(styles, /\.balance h1 \{[^}]*font-weight: 480/s);
  assert.match(styles, /\.balance \{ padding: 30px 0 26px; text-align: center/);
});

test("wallet pairs with a local bridge without exposing or persisting secrets", () => {
  assert.match(html, /id="bridge-code"[^>]*pattern="\[0-9\]\{8\}"/);
  assert.match(script, /pairBridge\(url, code\)/);
  assert.match(script, /fetch\(`\$\{url\}\/v1\/pair`/);
  assert.match(script, /x-nir-bridge-token/);
  assert.match(script, /bridgeSession = \{ token, url \}/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^,]*(token|bridge)/i);
  assert.doesNotMatch(html + script, /privateKey/);
});

test("wallet reviews and signs before a separate testnet-only broadcast", () => {
  for (const field of ["review-recipient", "review-amount", "review-fee", "review-network"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(script, /\/v1\/fees\?amount=/);
  assert.match(script, /bridgeRequest\("\/v1\/sign"/);
  assert.match(script, /signButton\.disabled = true/);
  assert.match(script, /signButton\.disabled = false/);
  assert.match(html, /id="submit-signed"[^>]*>Отправить в local testnet/);
  assert.match(script, /currentNetwork\.valueMode !== "valueless-devnet"/);
  assert.match(script, /currentNetwork\.networkId !== signedTransaction\.networkId/);
  assert.match(script, /fetch\(`\$\{NODE_URL\}\/v1\/transactions/);
  assert.match(script, /Автоматическая отправка намеренно отключена/);
});

test("wallet reports the local node connection state", () => {
  assert.match(script, /NODE_URL = "http:\/\/127\.0\.0\.1:8787"/);
  assert.match(script, /fetch\(`\$\{NODE_URL\}\/health`/);
  assert.match(script, /networkButton\.classList\.add\("connected"\)/);
  assert.match(script, /networkButton\.classList\.add\("offline"\)/);
  assert.match(styles, /\.network\.connected/);
  assert.match(styles, /\.network\.offline/);
});
