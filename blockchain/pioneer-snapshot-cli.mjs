#!/usr/bin/env node
// Pioneer points snapshots (docs/pioneer-program.md).
//   fetch [file] [--url <node>]  download the shared network's signed snapshot,
//                                check it and save it (default pioneers-<height>.json)
//   verify <file>                check a saved snapshot against NIR's pinned genesis
//   allocation <file>            what each address would receive from the pool
import { readFileSync, writeFileSync } from "node:fs";

import { formatNir } from "./chain.mjs";
import { MAX_PIONEER_SNAPSHOT_BYTES, pioneerAllocation, verifyPioneerSnapshot } from "./pioneer-snapshot.mjs";
import { SHARED_NETWORK } from "./shared-network.mjs";

function usage() {
  console.error("usage: pioneer-snapshot-cli.mjs fetch [file] [--url <node>] | verify <file> | allocation <file>");
  process.exit(2);
}

function load(path) {
  const text = readFileSync(path, "utf8");
  if (text.length > MAX_PIONEER_SNAPSHOT_BYTES) throw new Error("pioneer snapshot file is too large");
  return JSON.parse(text);
}

function check(snapshot) {
  const summary = verifyPioneerSnapshot(snapshot,
    { genesisHash: snapshot.networkId === SHARED_NETWORK.networkId ? SHARED_NETWORK.genesisHash : null });
  console.log(`valid: ${summary.networkId} at height ${summary.height}, ${summary.pioneers} pioneers, ` +
    `${formatNir(BigInt(summary.totalPoints))} in points, signed by ${summary.signers} genesis validator(s)`);
  if (snapshot.networkId !== SHARED_NETWORK.networkId) {
    console.log(`note: ${snapshot.networkId} is not NIR's pinned shared network; genesis ${snapshot.genesisHash}`);
  }
  return summary;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "fetch") {
    const urlIndex = rest.indexOf("--url");
    const base = urlIndex === -1 ? SHARED_NETWORK.url : rest[urlIndex + 1];
    if (!base) usage();
    const files = rest.filter((_, index) => urlIndex === -1 || (index !== urlIndex && index !== urlIndex + 1));
    const response = await fetch(new URL("/v1/pioneers/snapshot", base), { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`the node answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_PIONEER_SNAPSHOT_BYTES) throw new Error("pioneer snapshot is too large");
    const snapshot = JSON.parse(text);
    const summary = check(snapshot);
    const path = files[0] ?? `pioneers-${summary.networkId}-${summary.height}.json`;
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
    console.log(`saved: ${path}`);
  } else if (command === "verify" && rest.length === 1) {
    check(load(rest[0]));
  } else if (command === "allocation" && rest.length === 1) {
    const snapshot = load(rest[0]);
    check(snapshot);
    const { entries, unallocated } = pioneerAllocation(snapshot);
    for (const entry of [...entries].sort((left, right) => {
      const difference = BigInt(right.amount) - BigInt(left.amount);
      return difference > 0n ? 1 : difference < 0n ? -1 : 0;
    })) {
      console.log(`${entry.address}  ${formatNir(BigInt(entry.amount))}`);
    }
    console.log(`not handed out (rounding, or no pioneers yet): ${formatNir(BigInt(unallocated))}`);
  } else {
    usage();
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
