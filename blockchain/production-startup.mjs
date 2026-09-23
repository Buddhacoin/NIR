import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedPublicJson } from "./production-release-gate.mjs";
import { verifyProductionStartupFromHead } from "./production-head-store.mjs";

function readAnchor(path) {
  return path ? readBoundedPublicJson(path, {
    maximumBytes: 64 * 1024, requireCanonical: true,
  }) : undefined;
}

function assertActiveLink(installationTarget) {
  const target = resolve(installationTarget); const metadata = lstatSync(target);
  if (!metadata.isSymbolicLink()) throw new Error("production startup installation is not active");
  const link = readlinkSync(target);
  if (!/^\.[^/\x00-\x1f\x7f]{1,200}\.nir-generation-[0-9a-f]{32}$/.test(link)) {
    throw new Error("production startup activation link is invalid");
  }
  const generation = realpathSync(join(dirname(target), link));
  const current = lstatSync(target);
  if (!current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino ||
      readlinkSync(target) !== link) throw new Error("production startup activation changed");
  return generation;
}

function assertEntrypointIsInstalled(installationTarget, moduleUrl) {
  const generation = assertActiveLink(installationTarget);
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  if (!modulePath.startsWith(`${generation}${sep}`)) {
    throw new Error("production node entrypoint is not from the anchored active generation");
  }
}

export function createProductionStartupGuard({
  externalAnchorPath, headStore, installationTarget, kind, moduleUrl,
  requireExternalAnchor = true, requireInstalledEntrypoint = kind === "node",
  signedReleasePath, trustedAddress,
} = {}) {
  if (!["node", "wallet"].includes(kind)) throw new Error("production startup kind is invalid");
  if (requireExternalAnchor && !externalAnchorPath) {
    throw new Error("production startup requires an external monotonic anchor");
  }
  const signedRelease = readBoundedPublicJson(signedReleasePath, {
    maximumBytes: 16 * 1024 * 1024,
  });
  const externalAnchor = readAnchor(externalAnchorPath);
  const verify = () => {
    if (requireInstalledEntrypoint) assertEntrypointIsInstalled(installationTarget, moduleUrl);
    const result = verifyProductionStartupFromHead(headStore, installationTarget, {
      externalAnchor, signedRelease, trustedAddress,
    });
    if (result.kind !== kind) throw new Error("production startup anchor kind is mixed");
    if (requireInstalledEntrypoint) assertEntrypointIsInstalled(installationTarget, moduleUrl);
    else assertActiveLink(installationTarget);
    return result;
  };
  return { initial: verify(), verifyBeforeOpen: verify };
}
