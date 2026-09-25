import { X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { compileGenesis, verifyGenesisCeremony } from "./genesis-ceremony.mjs";
import { verifyCeremonyRegistryAnchorForLatestPlan } from "./genesis-ceremony-anchor.mjs";

const INPUT_FORMAT = "nir-validator-deployment-input-v1";
const PLAN_FORMAT = "nir-validator-deployment-plan-v1";
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function path(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value) ||
      value.includes("\0")) throw new Error(`${label} must be an absolute public path`);
  return value;
}

function command(label, argv, environment = {}) {
  return { argv, environment, label };
}

export function validateValidatorDeploymentInput(value) {
  exact(value, ["artifacts", "certificateMode", "expected", "format", "listenPort", "operatorId",
    "paths", "trustedReleaseAddress", "validatorAddress", "version"],
  "deployment input");
  exact(value.artifacts, ["anchor", "approvals", "genesis", "plan", "signedRelease",
    "tlsCertificate"], "deployment artifacts");
  exact(value.paths, ["planOutput", "stateDirectory", "tlsPrivateKey", "transportVault", "validatorVault"],
    "deployment paths");
  exact(value.expected, ["endpoint", "genesisHash", "networkId", "releaseManifestHash",
    "tlsCertificateSha256"], "deployment expectations");
  if (value.format !== INPUT_FORMAT || value.version !== 1 || value.certificateMode !== "lifecycle" ||
      !OPERATOR.test(value.operatorId ?? "") || !ADDRESS.test(value.validatorAddress ?? "") ||
      !ADDRESS.test(value.trustedReleaseAddress ?? "") || !Number.isSafeInteger(value.listenPort) ||
      value.listenPort < 1 || value.listenPort > 65535 || typeof value.expected.networkId !== "string" ||
      value.expected.networkId.length < 3 || value.expected.networkId.length > 64 ||
      !HASH.test(value.expected.genesisHash ?? "") ||
      !HASH.test(value.expected.releaseManifestHash ?? "") ||
      !HASH.test(value.expected.tlsCertificateSha256 ?? "")) {
    throw new Error("deployment input identity or policy is invalid");
  }
  let endpoint;
  try { endpoint = new URL(value.expected.endpoint); }
  catch { throw new Error("deployment endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
      endpoint.hash || endpoint.pathname !== "/") throw new Error("deployment endpoint must be an HTTPS origin");
  const artifacts = Object.fromEntries(Object.entries(value.artifacts).map(([name, item]) =>
    [name, path(item, `${name} artifact`)]));
  const paths = Object.fromEntries(Object.entries(value.paths).map(([name, item]) =>
    [name, path(item, name)]));
  const allPaths = [...Object.values(artifacts), ...Object.values(paths)];
  if (new Set(allPaths).size !== allPaths.length) throw new Error("deployment paths must be distinct");
  return structuredClone({ ...value, artifacts, paths });
}

export function createValidatorDeploymentPlan(inputValue, {
  anchor, approvals, genesis, ceremonyPlan, signedRelease, tlsCertificatePem,
  nodeVersion = process.versions.node, platform = process.platform,
} = {}) {
  const input = validateValidatorDeploymentInput(inputValue);
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!["darwin", "linux"].includes(platform) || !Number.isSafeInteger(major) || major < 26) {
    throw new Error("deployment requires macOS or Linux and Node.js 26 or newer");
  }
  const releaseOptions = { signedRelease, trustedAddress: input.trustedReleaseAddress };
  verifyGenesisCeremony(ceremonyPlan, approvals, releaseOptions);
  const compiled = compileGenesis(ceremonyPlan, approvals, releaseOptions);
  if (canonicalJson(compiled.genesis) !== canonicalJson(genesis) ||
      compiled.genesisHash !== input.expected.genesisHash || genesis.networkId !== input.expected.networkId ||
      ceremonyPlan.networkId !== input.expected.networkId ||
      ceremonyPlan.sourceRelease.manifestHash !== input.expected.releaseManifestHash) {
    throw new Error("deployment genesis, network, or release expectation does not match ceremony evidence");
  }
  verifyCeremonyRegistryAnchorForLatestPlan(anchor, ceremonyPlan, compiled.genesisHash, releaseOptions);
  const participant = ceremonyPlan.validators.find(({ operatorId }) => operatorId === input.operatorId);
  const peer = genesis.peerRegistry?.peers?.find(({ validatorAddress }) =>
    validatorAddress === input.validatorAddress);
  if (!participant || participant.address !== input.validatorAddress || !peer ||
      peer.url !== input.expected.endpoint || participant.endpoint !== input.expected.endpoint ||
      peer.tlsCertificateSha256 !== input.expected.tlsCertificateSha256 ||
      participant.tlsCertificateSha256 !== input.expected.tlsCertificateSha256) {
    throw new Error("deployment validator endpoint or TLS identity is not ceremony-authorized");
  }
  const certificateBootstrapPeers = genesis.peerRegistry.peers.map((entry) => {
    const origin = new URL(entry.url).origin;
    if (origin !== entry.url) throw new Error("ceremony peer registry URL is not a canonical origin");
    return origin;
  });
  if (certificateBootstrapPeers.length !== genesis.validators.length ||
      new Set(certificateBootstrapPeers).size !== certificateBootstrapPeers.length) {
    throw new Error("ceremony peer registry cannot form an ordered certificate bootstrap list");
  }
  let fingerprint;
  try { fingerprint = new X509Certificate(tlsCertificatePem).fingerprint256
    .replaceAll(":", "").toLowerCase(); }
  catch { throw new Error("deployment TLS certificate is invalid"); }
  if (fingerprint !== input.expected.tlsCertificateSha256) {
    throw new Error("deployment TLS certificate does not match its pinned fingerprint");
  }
  const a = input.artifacts; const p = input.paths;
  const steps = [
    command("Verify encrypted validator vault", ["npm", "run", "wallet:verify", "--", p.validatorVault]),
    command("Verify encrypted transport vault", ["npm", "run", "wallet:verify", "--", p.transportVault]),
    command("Install ceremony evidence", ["npm", "run", "validator:ceremony", "--",
      "init-from-ceremony", p.stateDirectory, a.genesis, a.plan, a.approvals, a.signedRelease,
      input.trustedReleaseAddress, a.anchor, p.validatorVault, p.transportVault, a.tlsCertificate]),
    command("Bootstrap quorum-authenticated certificate lifecycle", ["npm", "run",
      "certificate:bootstrap", "--", p.stateDirectory, ...certificateBootstrapPeers]),
    command("Reverify installed ceremony evidence", ["npm", "run", "validator:ceremony", "--",
      "reverify", p.stateDirectory, input.trustedReleaseAddress]),
    command("Start validator", ["npm", "run", "network:validator", "--", p.stateDirectory,
      String(input.listenPort), input.trustedReleaseAddress], {
      NIR_CERTIFICATE_MODE: "lifecycle", NIR_TLS_KEY_PATH: p.tlsPrivateKey,
    }),
    command("Verify pinned public health", ["npm", "run", "validator:deploy", "--", "health",
      p.planOutput]),
  ];
  const unsigned = { certificateMode: "lifecycle", endpoint: input.expected.endpoint,
    format: PLAN_FORMAT, genesisHash: compiled.genesisHash, networkId: input.expected.networkId,
    operatorId: input.operatorId, releaseManifestHash: input.expected.releaseManifestHash,
    steps, tlsCertificateSha256: fingerprint, validatorAddress: input.validatorAddress, version: 1 };
  return { ...unsigned, planHash: `sha3-256:${hashObject(unsigned,
    "VALIDATOR_DEPLOYMENT_PLAN_V1")}` };
}

export function validateValidatorDeploymentPlan(value) {
  exact(value, ["certificateMode", "endpoint", "format", "genesisHash", "networkId", "operatorId",
    "planHash", "releaseManifestHash", "steps", "tlsCertificateSha256", "validatorAddress",
    "version"], "deployment plan");
  const { planHash, ...unsigned } = value;
  if (value.format !== PLAN_FORMAT || value.version !== 1 || value.certificateMode !== "lifecycle" ||
      !HASH.test(value.genesisHash ?? "") || !HASH.test(value.releaseManifestHash ?? "") ||
      !HASH.test(value.tlsCertificateSha256 ?? "") || !ADDRESS.test(value.validatorAddress ?? "") ||
      !OPERATOR.test(value.operatorId ?? "") || !Array.isArray(value.steps) || value.steps.length !== 7 ||
      value.steps.some((step) => !step || typeof step.label !== "string" ||
        !Array.isArray(step.argv) || step.argv.some((arg) => typeof arg !== "string") ||
        !step.environment || typeof step.environment !== "object" || Array.isArray(step.environment)) ||
      planHash !== `sha3-256:${hashObject(unsigned, "VALIDATOR_DEPLOYMENT_PLAN_V1")}`) {
    throw new Error("deployment plan is invalid");
  }
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("deployment plan endpoint is invalid");
  return structuredClone(value);
}
