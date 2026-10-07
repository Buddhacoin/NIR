import { certificateHistoryHead, certificatePinsAtHeight }
  from "./certificate-lifecycle.mjs";
import { CERTIFICATE_MODE_LIFECYCLE, RuntimeCertificatePins }
  from "./certificate-runtime.mjs";
import { NirChain } from "./chain.mjs";
import { canonicalJson } from "./crypto.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES }
  from "./checkpoint-trust-package.mjs";
import { verifyCheckpointTrustPackageV2 }
  from "./checkpoint-trust-package-v2.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { advanceTransactionIngressFloor, loadTransactionIngressFloor }
  from "./validator-transaction-ingress-floor.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;

export function assertTransactionIngressCertificateCommitment(verified, context, history) {
  const head = certificateHistoryHead(history, context);
  if (verified?.certificateRecordCount !== history.length ||
      verified?.certificateHistoryHead !== head) {
    throw new Error("transaction ingress V2 checkpoint certificate head or count does not match verified history");
  }
  return head;
}

export function assertTransactionIngressValidatorSet(verified, genesisValidators, context) {
  if (!Array.isArray(genesisValidators) || !Array.isArray(context?.handoffs) ||
      !Array.isArray(verified?.trustedValidators) ||
      !Number.isSafeInteger(verified?.checkpoint?.height)) {
    throw new Error("transaction ingress checkpoint validator topology is unavailable");
  }
  let expected = genesisValidators;
  for (const handoff of context.handoffs) {
    if (handoff.activationHeight > verified.checkpoint.height) break;
    expected = handoff.nextValidators;
  }
  const ordered = (members) => [...members].sort((left, right) =>
    left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
  if (validatorSetId(expected) !== verified.checkpoint.validatorSetId ||
      canonicalJson(ordered(expected)) !== canonicalJson(ordered(verified.trustedValidators))) {
    throw new Error("transaction ingress checkpoint validator set does not match verified topology at height");
  }
}

/**
 * A local admission gate, not a claim that witnesses or the public network are independent.
 * All trust anchors are supplied out of band by the operator. Evidence is checked again for
 * every transaction; no stale result is cached across requests.
 */
export function createValidatorTransactionCheckpointGate({
  certificateDirectory, certificateHeadAnchorPath, checkpointPackagePath,
  expectedGenesisHash, expectedNetworkId, expectedPolicyId, floorDirectory, genesis,
  maxWitnessAgeMs, maxFutureSkewMs = 5_000, minimumCheckpointHeight = 1,
  minimumSequence = 0, now = Date.now, tlsCertificateSha256, validatorAddress,
} = {}) {
  if (typeof certificateDirectory !== "string" || !certificateDirectory ||
      typeof certificateHeadAnchorPath !== "string" || !certificateHeadAnchorPath ||
      typeof checkpointPackagePath !== "string" || !checkpointPackagePath ||
      typeof floorDirectory !== "string" || !floorDirectory ||
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
  const floorIdentity = { expectedGenesisHash, expectedNetworkId, expectedPolicyId,
    validatorAddress };
  // Explicit initialization is a separate operator step. A missing floor never resets here.
  loadTransactionIngressFloor(floorDirectory, floorIdentity);
  return () => {
    const floor = loadTransactionIngressFloor(floorDirectory, floorIdentity);
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0 ||
        observedAt < floor.observedAt) {
      throw new Error("transaction checkpoint gate clock moved backwards");
    }
    const packageValue = readBoundedPublicJsonFile(checkpointPackagePath, {
      label: "transaction checkpoint trust package",
      maximumBytes: MAX_CHECKPOINT_TRUST_PACKAGE_BYTES,
    });
    const verified = verifyCheckpointTrustPackageV2(packageValue, {
      expectedChainIdentityGenesisHash: expectedGenesisHash,
      expectedNetworkId, expectedPolicyId, maxAgeMs: maxWitnessAgeMs,
      maxFutureSkewMs, minimumCheckpointHeight: Math.max(minimumCheckpointHeight,
        floor.height), minimumSequence: Math.max(minimumSequence,
        floor.sequence), now: observedAt,
    });
    if (floor.height > 0 && (verified.sequence < floor.sequence ||
        verified.checkpoint.height < floor.height ||
        (verified.checkpoint.height === floor.height &&
          verified.checkpoint.tipHash !== floor.tipHash) ||
        (verified.sequence === floor.sequence &&
          verified.packageHash !== floor.packageHash))) {
      throw new Error("transaction checkpoint trust package rolled back or diverged");
    }
    if (!verified.trustedValidators.some(({ address }) => address === validatorAddress)) {
      throw new Error("transaction ingress validator is absent from finalized checkpoint quorum");
    }
    const { context, history } = certificatePins.loadVerifiedHistory();
    assertTransactionIngressValidatorSet(verified, genesis.validators, context);
    if (floor.historyCount > 0 && (history.length < floor.historyCount ||
        certificateHistoryHead(history.slice(0, floor.historyCount), context) !==
          floor.historyHead)) {
      throw new Error("transaction ingress certificate history rolled back or diverged");
    }
    const historyHead = assertTransactionIngressCertificateCommitment(verified, context, history);
    const latestCertificateHeight = history.reduce((height, record) =>
      record.validatorAddress === validatorAddress
        ? Math.max(height, record.activationHeight) : height, 0);
    if (verified.checkpoint.height < latestCertificateHeight ||
        !certificatePinsAtHeight(history, validatorAddress, verified.checkpoint.height)
          .includes(tlsCertificateSha256)) {
      throw new Error("transaction ingress TLS pin is not active at the accepted checkpoint");
    }
    advanceTransactionIngressFloor(floorDirectory, floorIdentity, {
      height: verified.checkpoint.height, historyCount: history.length,
      historyHead, observedAt,
      packageHash: verified.packageHash, sequence: verified.sequence,
      tipHash: verified.checkpoint.tipHash,
    });
    return { checkpointHeight: verified.checkpoint.height,
      checkpointSequence: verified.sequence };
  };
}
