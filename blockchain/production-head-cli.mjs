#!/usr/bin/env node
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import {
  advanceProductionHead, exportProductionHeadAnchor, loadProductionHeadStore,
  repairProductionHeadCopies, verifyProductionStartupFromHead,
} from "./production-head-store.mjs";
import { readBoundedPublicJson } from "./production-release-gate.mjs";

const [command, ...args] = process.argv.slice(2);
function signed(path) {
  return readBoundedPublicJson(path, { maximumBytes: 16 * 1024 * 1024 });
}
function anchor(path) {
  return path === undefined ? undefined : readBoundedPublicJson(path, {
    maximumBytes: 64 * 1024, requireCanonical: true,
  });
}
try {
  let result;
  if (command === "advance" && (args.length === 7 || args.length === 8)) {
    const [store, kind, installation, signedPath, trustedAddress, previous, packageHash,
      anchorPath] = args;
    result = advanceProductionHead(store, installation, {
      expectedPreviousPackageHash: previous === "-" ? null : previous,
      externalAnchor: anchor(anchorPath), kind, newPackageHash: packageHash,
      signedRelease: signed(signedPath), trustedAddress,
    });
  } else if (command === "startup" && (args.length === 4 || args.length === 5)) {
    const [store, installation, signedPath, trustedAddress, anchorPath] = args;
    result = verifyProductionStartupFromHead(store, installation, {
      externalAnchor: anchor(anchorPath), signedRelease: signed(signedPath), trustedAddress,
    });
  } else if (command === "verify" && (args.length === 1 || args.length === 2)) {
    result = loadProductionHeadStore(args[0], { externalAnchor: anchor(args[1]) });
  } else if (command === "export-anchor" && args.length === 1) {
    result = exportProductionHeadAnchor(args[0]);
  } else if (command === "repair" && (args.length === 1 || args.length === 2)) {
    result = repairProductionHeadCopies(args[0], { externalAnchor: anchor(args[1]) });
  } else {
    throw new Error("usage: production-head advance STORE <node|wallet> INSTALL SIGNED TRUSTED PREVIOUS_HASH|- NEW_HASH [EXTERNAL_ANCHOR] | production-head startup STORE INSTALL SIGNED TRUSTED [EXTERNAL_ANCHOR] | production-head verify STORE [EXTERNAL_ANCHOR] | production-head repair STORE [EXTERNAL_ANCHOR] | production-head export-anchor STORE");
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`Production head operation failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
