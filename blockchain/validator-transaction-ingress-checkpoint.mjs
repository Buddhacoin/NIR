import { certificateHistoryHead, certificatePinsAtHeight }
  from "./certificate-lifecycle.mjs";
import { CERTIFICATE_MODE_LIFECYCLE, RuntimeCertificatePins }
  from "./certificate-runtime.mjs";
import { NirChain } from "./chain.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES, verifyCheckpointTrustPackage }
  from "./checkpoint-trust-package.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;

/**
 * A local admission gate, not a claim that witnesses or the public network are independent.
 * All trust anchors are supplied out of band by the operator. Evidence is checked again for
 * every transaction; no stale result is cached across requests.
 */
export function createValidatorTransactionCheckpointGate({
  certificateDirectory, certificateHeadAnchorPath, checkpointPackagePath,
  expectedGenesisHash, expectedNetworkId, expectedPolicyId, genesis,
  maxWitnessAgeMs, maxFutureSkewMs = 5_000, minimumCheckpointHeight = 1,
  minimumSequence = 0, now = Date.now, tlsCertificateSha256, validatorAddress,
} = {}) {
  if (typeof certificateDirectory !== "string" || !certificateDirectory ||
      typeof certificateHeadAnchorPath !== "string" || !certificateHeadAnchorPath ||
      typeof checkpointPackagePath !== "string" || !checkpointPackagePath ||
      !HASH.test(expectedGenesisHash ?? "") || !TAGGED_HASH.test(expectedPolicyId ?? "") ||
      !HASH.test(tlsCertificateSha256 ?? "") || !ADDRESS.test(validatorAddress ?? "") ||
      typeof expectedNetworkId !== "string" || expectedNetworkId !== genesis?.networkId ||
      !Array.isArray(genesis?.validators) ||
      !genesis.validators.some(({ address }) => address === validatorAddress) ||
      !Number.isSafeInteger(maxWitnessAgeMs) || maxWitnessAgeMs < 1 ||
      !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 ||
      !Number.isSafeInteger(minimumCheckpointHeight) || minimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(minimumSequence) || minimumSequence < 0 ||
      typeof now !== "function") {
    throw new Error("transaction checkpoint gate requires pinned identity and bounded freshness");
  }
  if (new NirChain(genesis).blocks()[0].hash !== expectedGenesisHash) {
    throw new Error("transaction checkpoint gate genesis configuration does not match pin");
  }
  const certificatePins = new RuntimeCertificatePins(certificateDirectory, genesis, {
    mode: CERTIFICATE_MODE_LIFECYCLE, externalAnchorPath: certificateHeadAnchorPath,
  });
  // Remember cryptographically verified evidence even when it later denies this endpoint.
  // A newer valid revocation/checkpoint must not be followed by an older admissible one.
  let seenPackage = null;
  let seenHistory = null;
  let lastNow = null;
  return () => {
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0 ||
        (lastNow !== null && observedAt < lastNow)) {
      throw new Error("transaction checkpoint gate clock moved backwards");
    }
    const packageValue = readBoundedPublicJsonFile(checkpointPackagePath, {
      label: "transaction checkpoint trust package",
      maximumBytes: MAX_CHECKPOINT_TRUST_PACKAGE_BYTES,
    });
    const verified = verifyCheckpointTrustPackage(packageValue, {
      expectedChainIdentityGenesisHash: expectedGenesisHash,
      expectedNetworkId, expectedPolicyId, maxAgeMs: maxWitnessAgeMs,
      maxFutureSkewMs, minimumCheckpointHeight: Math.max(minimumCheckpointHeight,
        seenPackage?.height ?? 1), minimumSequence: Math.max(minimumSequence,
        seenPackage?.sequence ?? 0), now: observedAt,
    });
    if (seenPackage && (verified.sequence < seenPackage.sequence ||
        verified.checkpoint.height < seenPackage.height ||
        (verified.sequence === seenPackage.sequence &&
          verified.packageHash !== seenPackage.packageHash))) {
      throw new Error("transaction checkpoint trust package rolled back or diverged");
    }
    seenPackage = { height: verified.checkpoint.height,
      packageHash: verified.packageHash, sequence: verified.sequence };
    lastNow = observedAt;
    if (!verified.trustedValidators.some(({ address }) => address === validatorAddress)) {
      throw new Error("transaction ingress validator is absent from finalized checkpoint quorum");
    }
    const { context, history } = certificatePins.loadVerifiedHistory();
    if (seenHistory && (history.length < seenHistory.count ||
        certificateHistoryHead(history.slice(0, seenHistory.count), context) !==
          seenHistory.head)) {
      throw new Error("transaction ingress certificate history rolled back or diverged");
    }
    seenHistory = { count: history.length, head: certificateHistoryHead(history, context) };
    const latestCertificateHeight = history.reduce((height, record) =>
      record.validatorAddress === validatorAddress
        ? Math.max(height, record.activationHeight) : height, 0);
    if (verified.checkpoint.height < latestCertificateHeight ||
        !certificatePinsAtHeight(history, validatorAddress, verified.checkpoint.height)
          .includes(tlsCertificateSha256)) {
      throw new Error("transaction ingress TLS pin is not active at the accepted checkpoint");
    }
    return { checkpointHeight: seenPackage.height, checkpointSequence: seenPackage.sequence };
  };
}
