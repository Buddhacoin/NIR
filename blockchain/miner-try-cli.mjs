#!/usr/bin/env node
import process from "node:process";

import { tryLocalMining } from "./miner-try.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--details" && args[0] !== "--help")) {
  console.error("Использование: npm run mine:try [-- --details]");
  process.exitCode = 2;
} else if (args[0] === "--help") {
  console.log("npm run mine:try — одна локальная тренировка без монет и подключения к сети.");
  console.log("npm run mine:try -- --details — показать технический результат локального сценария v5.");
} else {
  console.log("NIR · локальная тренировка майнинга");
  console.log("Не подключается к сети, не создаёт кошелёк и не начисляет NIR.");
  const result = tryLocalMining({ root: process.cwd() });
  if (result.reason === "preflight") {
    for (const check of result.checks.filter((item) => !item.ok)) {
      console.error(`Нужно исправить: ${check.message}`);
    }
    process.exitCode = 2;
  } else if (!result.ok) {
    console.error(`Тренировка не завершилась: ${result.detail}`);
    process.exitCode = 1;
  } else {
    console.log("✓ Пример заявки, проверки и ожидания награды выполнен на временной локальной цепочке.");
    console.log("Результат исчез после завершения команды. Реальных наград нет.");
    if (args[0] === "--details") {
      console.log("Технические данные ниже — локальный сценарий v5 с 44 тестовыми NIR, не реальная награда:");
      console.log(result.details);
    }
  }
}
