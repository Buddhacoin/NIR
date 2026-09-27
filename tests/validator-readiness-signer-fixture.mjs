import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy,
} from "../blockchain/checkpoint-trust-package.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";
import {
  createValidatorReadinessRolePackage, createValidatorReadinessSession,
} from "../blockchain/validator-readiness-session.mjs";

export const READINESS_SIGNER_NOW = 1_800_000_000_000;

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

export function validatorReadinessSignerFixture() {
  const networkId = "nir-readiness-signer-test";
  const validatorWallets = Array.from({ length: 4 }, generateWallet);
  const validators = members(validatorWallets, "validator");
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const candidate = generateWallet(); const transport = generateWallet();
  const chain = new NirChain({
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, validators,
  });
  const append = (options = {}) => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1,
      ...options });
    const block = finalizeBlock(proposal, validatorWallets.slice(0, 3)); chain.appendBlock(block);
    return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  const checkpointBlock = chain.blocks().at(-1);
  const finalityProof = createFinalityProof(checkpointBlock);
  const genesisHash = chain.blocks()[0].hash;
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
    generation: 1, networkId, threshold: 3, witnesses: members(witnesses, "witness") });
  const attestations = witnesses.slice(0, 3).map((wallet, index) =>
    createCheckpointWitnessAttestation({ finalityProof,
      observedAt: READINESS_SIGNER_NOW - 1_000 + index, operatorId: `witness-${index}`,
      policy, sequence: 8, validators, wallet }));
  const checkpointTrustPackage = assembleCheckpointTrustPackage({ attestations, finalityProof,
    policy, sequence: 8, validators });
  const joinFields = { candidateContextMaxWitnessAgeMs: 300_000,
    candidateContextMinimumCheckpointHeight: 1, candidateContextMinimumSequence: 8,
    consensus: { ...publicWallet(candidate), label: "candidate consensus" },
    endpoint: "https://candidate.example", expectedChainIdentityGenesisHash: genesisHash,
    expectedCheckpointPolicyId: policy.policyId, networkId, operatorId: "candidate-one",
    tlsCertificateSha256: "a".repeat(64),
    transport: { ...publicWallet(transport), label: "candidate transport" } };
  const joinPlan = { ...joinFields, format: "nir-validator-admission-public-plan-v1",
    planCommitment: hashObject(joinFields, "VALIDATOR_ADMISSION_PLAN_V1"), version: 1 };
  const context = createValidatorAdmissionReadinessContext({ admission: {
    address: candidate.address, admissionId: "b".repeat(64), algorithm: candidate.algorithm,
    endpoint: joinPlan.endpoint, operatorId: joinPlan.operatorId, publicKey: candidate.publicKey,
    tlsCertificateSha256: joinPlan.tlsCertificateSha256, transport: publicWallet(transport),
  }, chainIdentityGenesisHash: genesisHash, checkpoint: { blockHash: checkpointBlock.hash,
    height: checkpointBlock.height, stateRoot: checkpointBlock.stateRoot,
    validatorSetId: validatorSetId(validators) }, expiresAtHeight: checkpointBlock.height + 16,
  networkId, nonce: 11 });
  const releaseSigner = generateWallet();
  const releasePayload = { files: [{ executable: false, path: "blockchain/example.mjs",
    sha3_256: "c".repeat(64), size: 42 }], format: "nir-source-release-v1",
  releaseVersion: "1.2.3", sourceRevision: "d".repeat(40) };
  const signedRelease = signReleaseManifest({ ...releasePayload,
    manifestHash: hashObject(releasePayload, "RELEASE_MANIFEST_HASH") }, releaseSigner);
  const session = createValidatorReadinessSession({ checkpointTrustPackage, context,
    expiresAt: READINESS_SIGNER_NOW + 30_000, issuedAt: READINESS_SIGNER_NOW, joinPlan,
    signedRelease, trustedReleaseAddress: releaseSigner.address,
    validators: checkpointTrustPackage.validators }, { now: READINESS_SIGNER_NOW });
  const gatewayRolePackage = createValidatorReadinessRolePackage(session, "gateway",
    { now: READINESS_SIGNER_NOW });
  const transportRolePackage = createValidatorReadinessRolePackage(session, "transport",
    { now: READINESS_SIGNER_NOW });
  const consensusRolePackage = createValidatorReadinessRolePackage(session, "consensus",
    { now: READINESS_SIGNER_NOW });
  const challenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "f".repeat(64), context, observerWallet: validatorWallets[0], validators,
  });
  return { candidate, challenge, consensusRolePackage, context, gatewayRolePackage, session,
    transport, transportRolePackage, validatorWallets, validators };
}
