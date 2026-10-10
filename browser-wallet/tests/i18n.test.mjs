import assert from "node:assert/strict";
import test from "node:test";
import { localize, safeUiError } from "../src/i18n.js";

test("known wallet validation errors translate without changing recovery words", () => {
  assert.equal(localize(safeUiError(new Error("Нужны 24 правильных английских слова")), "en"),
    "Enter 24 valid English recovery words");
  assert.equal(localize("abandon ability able", "en"), "abandon ability able");
});

test("unknown internal error is hidden behind a localized generic message", () => {
  const message = safeUiError(new Error("internal secret path /private/vault.json"));
  assert.equal(message, "Не удалось выполнить действие");
  assert.equal(localize(message, "en"), "Could not complete the action");
  assert.equal(safeUiError({ message: "untrusted payload" }), "Не удалось выполнить действие");
});
