import { verifyProductionStartupFromHead } from "./production-head-store.mjs";
import { verifyValidatorReadinessSession } from "./validator-readiness-session.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const CHAIN_HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/u;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const EXPECTATION_KEYS = Object.freeze(["expectedGenesisHash", "expectedNetworkId",
  "expectedPackageHash", "expectedReleaseManifestHash", "expectedReleaseVersion",
  "expectedSourceRevision"]);

function expectations(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== EXPECTATION_KEYS.length ||
      !EXPECTATION_KEYS.every((key) => Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) ||
      !CHAIN_HASH.test(value.expectedGenesisHash) ||
      typeof value.expectedNetworkId !== "string" || value.expectedNetworkId.length < 3 ||
      value.expectedNetworkId.length > 128 ||
      !HASH.test(value.expectedPackageHash) || !HASH.test(value.expectedReleaseManifestHash) ||
      !VERSION.test(value.expectedReleaseVersion) ||
      !REVISION.test(value.expectedSourceRevision)) {
    throw new Error("validator readiness installation expectations are invalid");
  }
  return { ...value };
}

/** Verify the complete installed node generation against the external monotonic head anchor. */
export function verifyValidatorReadinessInstallation({ externalAnchor, headStore,
  installationTarget, signedRelease, trustedAddress, expected } = {}) {
  if (!externalAnchor || Object.getPrototypeOf(externalAnchor) !== Object.prototype ||
      typeof headStore !== "string" || !headStore ||
      typeof installationTarget !== "string" || !installationTarget ||
      typeof trustedAddress !== "string") {
    throw new Error("validator readiness installation trust inputs are required");
  }
  const pins = expectations(expected);
  const installed = verifyProductionStartupFromHead(headStore, installationTarget, {
    externalAnchor, signedRelease, trustedAddress,
  });
  const target = installed.productionTarget;
  if (installed.kind !== "node" || installed.packageHash !== pins.expectedPackageHash ||
      !installed.copiesSynchronized ||
      target.networkId !== pins.expectedNetworkId ||
      target.genesisHash !== pins.expectedGenesisHash ||
      target.releaseManifestHash !== pins.expectedReleaseManifestHash ||
      target.releaseVersion !== pins.expectedReleaseVersion ||
      target.sourceRevision !== pins.expectedSourceRevision) {
    throw new Error("validator readiness installed release disagrees with operator policy");
  }
  return Object.freeze({ anchorHead: installed.anchorHead, kind: "node",
    packageHash: installed.packageHash,
    releaseManifestHash: target.releaseManifestHash, verified: true });
}

/** Pin installed-release expectations to a verified readiness session and an external package hash. */
export function deriveValidatorReadinessInstallationExpectations(sessionValue,
  expectedPackageHash, { now = Date.now() } = {}) {
  if (!HASH.test(expectedPackageHash ?? "")) {
    throw new Error("validator readiness expected package hash is invalid");
  }
  const session = verifyValidatorReadinessSession(sessionValue, { now });
  return Object.freeze(expectations({
    expectedGenesisHash: session.joinPlan.expectedChainIdentityGenesisHash,
    expectedNetworkId: session.joinPlan.networkId,
    expectedPackageHash,
    expectedReleaseManifestHash: session.releaseProvenance.manifestHash,
    expectedReleaseVersion: session.releaseProvenance.releaseVersion,
    expectedSourceRevision: session.releaseProvenance.sourceRevision,
  }));
}

/** Verify a node installation against the same session that authorizes the readiness cohort. */
export function verifyValidatorReadinessInstallationForSession({ session, expectedPackageHash,
  now = Date.now(), externalAnchor, headStore, installationTarget, signedRelease,
  trustedAddress } = {}) {
  const expected = deriveValidatorReadinessInstallationExpectations(session,
    expectedPackageHash, { now });
  if (session.releaseProvenance.signerAddress !== trustedAddress) {
    throw new Error("validator readiness session signer disagrees with operator policy");
  }
  return verifyValidatorReadinessInstallation({ externalAnchor, headStore, installationTarget,
    signedRelease, trustedAddress, expected });
}
