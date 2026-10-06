#!/usr/bin/env node
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { readBoundedPublicJson } from "./production-release-gate.mjs";
import {
  verifyValidatorReadinessInstallation,
  verifyValidatorReadinessInstallationForSession,
} from "./validator-readiness-installation.mjs";
import { MAX_VALIDATOR_READINESS_SESSION_BYTES }
  from "./validator-readiness-session.mjs";

function read(path, maximumBytes, requireCanonical = true) {
  return readBoundedPublicJson(path, { maximumBytes, requireCanonical });
}

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "inspect" && args.length === 6) {
    const [expectedPath, signedPath, anchorPath, headStore, installationTarget,
      trustedAddress] = args;
    result = verifyValidatorReadinessInstallation({
      expected: read(expectedPath, 64 * 1024),
      signedRelease: read(signedPath, 16 * 1024 * 1024, false),
      externalAnchor: read(anchorPath, 64 * 1024), headStore, installationTarget,
      trustedAddress,
    });
  } else if (command === "session" && args.length === 7) {
    const [sessionPath, signedPath, anchorPath, headStore, installationTarget,
      trustedAddress, expectedPackageHash] = args;
    result = verifyValidatorReadinessInstallationForSession({
      session: read(sessionPath, MAX_VALIDATOR_READINESS_SESSION_BYTES),
      signedRelease: read(signedPath, 16 * 1024 * 1024, false),
      externalAnchor: read(anchorPath, 64 * 1024), headStore, installationTarget,
      trustedAddress, expectedPackageHash,
    });
  } else {
    throw new Error("usage: validator-readiness-installation inspect EXPECTED SIGNED ANCHOR HEAD INSTALL TRUSTED | validator-readiness-installation session SESSION SIGNED ANCHOR HEAD INSTALL TRUSTED PACKAGE_HASH");
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`Validator readiness installation check failed: ${error.message}\n`);
  process.exitCode = 1;
}
