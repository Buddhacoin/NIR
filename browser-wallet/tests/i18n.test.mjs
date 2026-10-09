import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { hasEnglishTranslation, supportedLanguages, translate } from "../src/i18n.js";

test("wallet UI copy has complete English translations in extension and web builds", () => {
  assert.deepEqual(supportedLanguages, ["ru", "en"]);
  const exceptions = new Set(["Language / Язык", "Русский", "Адрес 1"]);
  for (const file of ["../dist/wallet.html", "../dist-web/index.html"]) {
    const html = readFileSync(resolve(import.meta.dirname, file), "utf8");
    for (const fragment of html.split(/<[^>]*>/u)) {
      const source = fragment.trim();
      if (/[А-Яа-яЁё]/u.test(source) && !exceptions.has(source)) {
        assert.ok(hasEnglishTranslation(source), `${file}: missing translation for ${source}`);
        assert.ok(!/[А-Яа-яЁё]/u.test(translate(source, "en")), `${file}: untranslated Cyrillic in ${source}`);
      }
    }
  }
});
