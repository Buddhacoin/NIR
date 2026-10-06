import { canonicalJson } from "./crypto.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";
import { verifyValidatorReadinessGatewayProcessBootstrap }
  from "./validator-readiness-process-protocol.mjs";
import { verifyValidatorReadinessSession }
  from "./validator-readiness-session.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const ADDRESS = /^nir1[0-9a-f]{64}$/u;
const POLICY_KEYS = Object.freeze(["expectedAdmissionId", "expectedCandidateAddress",
  "expectedBoundHost", "expectedBoundPort", "expectedChainIdentityGenesisHash",
  "expectedCheckpointBlockHash",
  "expectedCheckpointHeight", "expectedCheckpointPolicyId", "expectedEndpoint",
  "expectedLauncherNonce", "expectedNetworkId", "expectedReleaseManifestHash",
  "expectedTlsCertificateSha256"]);

function exact(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function policy(value) {
  exact(value, POLICY_KEYS, "validator readiness trusted operator policy");
  for (const key of ["expectedAdmissionId", "expectedChainIdentityGenesisHash",
    "expectedCheckpointBlockHash", "expectedLauncherNonce",
    "expectedReleaseManifestHash", "expectedTlsCertificateSha256"]) {
    if (!HASH.test(value[key])) throw new Error(`validator readiness ${key} is invalid`);
  }
  if (!ADDRESS.test(value.expectedCandidateAddress) ||
      typeof value.expectedBoundHost !== "string" || value.expectedBoundHost.length < 1 ||
      value.expectedBoundHost.length > 255 ||
      /[\u0000-\u0020\u007f]/u.test(value.expectedBoundHost) ||
      !Number.isSafeInteger(value.expectedBoundPort) || value.expectedBoundPort < 1 ||
      value.expectedBoundPort > 65_535 ||
      !Number.isSafeInteger(value.expectedCheckpointHeight) ||
      value.expectedCheckpointHeight < 1 ||
      typeof value.expectedCheckpointPolicyId !== "string" ||
      value.expectedCheckpointPolicyId.length < 1 ||
      typeof value.expectedNetworkId !== "string" ||
      value.expectedNetworkId.length < 3 || value.expectedNetworkId.length > 64) {
    throw new Error("validator readiness trusted operator policy is invalid");
  }
  let endpoint;
  try { endpoint = new URL(value.expectedEndpoint); }
  catch { throw new Error("validator readiness trusted endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.origin !== value.expectedEndpoint ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/") {
    throw new Error("validator readiness trusted endpoint is invalid");
  }
  return { ...value };
}

/**
 * Verify the operator's separate release and local policy before accepting child bootstrap pins.
 * The caller remains responsible for obtaining policy and signed release from trusted sources.
 */
export function deriveValidatorReadinessTrustedPins(evidence = {}, cohortBootstraps,
{ now = Date.now() } = {}) {
  exact(evidence, ["policy", "session", "signedRelease", "trustedReleaseAddress"],
    "validator readiness trusted evidence");
  const { signedRelease, session, trustedReleaseAddress, policy: policyValue } = evidence;
  const trusted = policy(policyValue);
  if (!ADDRESS.test(trustedReleaseAddress)) {
    throw new Error("validator readiness trusted release address is invalid");
  }
  const { manifest, signer } = verifySignedRelease(signedRelease,
    { trustedAddress: trustedReleaseAddress });
  if (manifest.manifestHash !== trusted.expectedReleaseManifestHash) {
    throw new Error("validator readiness release manifest disagrees with operator policy");
  }
  const verifiedSession = verifyValidatorReadinessSession(session, { now });
  const provenance = { manifestHash: manifest.manifestHash,
    releaseVersion: manifest.releaseVersion, signerAddress: signer.address,
    sourceRevision: manifest.sourceRevision };
  if (canonicalJson(provenance) !== canonicalJson(verifiedSession.releaseProvenance)) {
    throw new Error("validator readiness signed release disagrees with session");
  }
  const join = verifiedSession.joinPlan; const context = verifiedSession.context;
  if (join.networkId !== trusted.expectedNetworkId ||
      join.expectedChainIdentityGenesisHash !== trusted.expectedChainIdentityGenesisHash ||
      join.expectedCheckpointPolicyId !== trusted.expectedCheckpointPolicyId ||
      join.consensus.address !== trusted.expectedCandidateAddress ||
      context.admissionId !== trusted.expectedAdmissionId ||
      context.checkpoint.blockHash !== trusted.expectedCheckpointBlockHash ||
      context.checkpoint.height !== trusted.expectedCheckpointHeight ||
      join.endpoint !== trusted.expectedEndpoint ||
      join.tlsCertificateSha256 !== trusted.expectedTlsCertificateSha256) {
    throw new Error("validator readiness session disagrees with operator policy");
  }
  exact(cohortBootstraps, ["consensus", "gateway", "transport"],
    "validator readiness cohort bootstraps");
  const gateway = verifyValidatorReadinessGatewayProcessBootstrap(cohortBootstraps.gateway, {
    consensusSignerBootstrap: cohortBootstraps.consensus,
    expectedLauncherNonce: trusted.expectedLauncherNonce,
    expectedReleaseProvenanceHash: verifiedSession.releaseProvenanceHash,
    expectedSessionHash: verifiedSession.sessionHash, now,
    transportSignerBootstrap: cohortBootstraps.transport,
  });
  for (const role of ["consensus", "gateway", "transport"]) {
    if (canonicalJson(cohortBootstraps[role].rolePackage.session) !==
        canonicalJson(verifiedSession)) {
      throw new Error(`validator readiness ${role} bootstrap uses another session`);
    }
  }
  if (gateway.tlsCertificateSha256 !== trusted.expectedTlsCertificateSha256) {
    throw new Error("validator readiness gateway certificate disagrees with operator policy");
  }
  return Object.freeze({ expectedBoundHost: trusted.expectedBoundHost,
    expectedBoundPort: trusted.expectedBoundPort,
    expectedConsensusBootstrapHash: cohortBootstraps.consensus.bootstrapHash,
    expectedGatewayBootstrapHash: gateway.bootstrapHash,
    expectedLauncherNonce: trusted.expectedLauncherNonce,
    expectedReleaseProvenanceHash: verifiedSession.releaseProvenanceHash,
    expectedSessionHash: verifiedSession.sessionHash,
    expectedTlsCertificateSha256: trusted.expectedTlsCertificateSha256,
    expectedTransportBootstrapHash: cohortBootstraps.transport.bootstrapHash });
}
