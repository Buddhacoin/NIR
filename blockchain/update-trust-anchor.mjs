// This module is bundled by the local Mac wallet build. Other application
// targets still require integration. The address is the hash
// of the release public key carried by the signed catalog. A project-controlled
// address must be reviewed and embedded in a future signed release; never read
// it from a response, environment variable, or user-editable settings.
import { selectVerifiedUpdate, verifyDownloadedUpdateBytes,
  verifyGithubUpdateRelease } from "./update-catalog.mjs";

export const pinnedUpdateSignerAddress = null;
const pinnedCatalogs = new WeakSet();

export function verifyPinnedGithubUpdateRelease(release, envelope) {
  if (pinnedUpdateSignerAddress === null) {
    throw new Error("update trust anchor is not configured in this build");
  }
  const catalog = verifyGithubUpdateRelease(release, envelope,
    { trustedAddress: pinnedUpdateSignerAddress });
  pinnedCatalogs.add(catalog);
  return catalog;
}

export function selectPinnedUpdate(catalog, installedIdentity) {
  if (!pinnedCatalogs.has(catalog)) {
    throw new Error("update catalog was not verified with the pinned signer");
  }
  return selectVerifiedUpdate(catalog, installedIdentity);
}

export function verifyPinnedDownloadedUpdateBytes(catalog, installedIdentity, bytes) {
  if (!pinnedCatalogs.has(catalog)) {
    throw new Error("update catalog was not verified with the pinned signer");
  }
  return verifyDownloadedUpdateBytes(catalog, installedIdentity, bytes);
}
