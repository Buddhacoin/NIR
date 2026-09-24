import fs from "node:fs";

import { generateWallet, hashObject, signObject } from "../blockchain/crypto.mjs";

const operation = process.argv[2];
if (operation === "generate") {
  process.stdout.write(JSON.stringify(generateWallet()) + "\n");
} else if (operation === "sign") {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify({
    signature: signObject(input.payload, input.wallet, input.domain),
  }) + "\n");
} else if (operation === "hash") {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify({
    hash: hashObject(input.payload, input.domain),
  }) + "\n");
} else {
  process.exitCode = 2;
}
