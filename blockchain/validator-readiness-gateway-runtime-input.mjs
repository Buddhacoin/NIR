import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyValidatorReadinessGatewayChildInput }
  from "./validator-readiness-gateway-child-protocol.mjs";

const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const FORMAT = "nir-validator-readiness-gateway-runtime-input-v1";
const DOMAIN = "VR_GATE_RUNTIME_INPUT_V1";

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function clone(value) { return JSON.parse(canonicalJson(value)); }
function pid(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
function tagged(value) { return `sha3-256:${hashObject(value, DOMAIN)}`; }

function childPins(input) {
  return { expectedBootstrapHash: input.expectedBootstrapHash,
    expectedBoundHost: input.expectedBoundHost, expectedBoundPort: input.expectedBoundPort,
    expectedLauncherNonce: input.expectedLauncherNonce,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedSessionHash: input.expectedSessionHash };
}

function payload(value, now) {
  exact(value, ["expectedConsensusPid", "expectedGatewayPid", "expectedTransportPid", "format",
    "gatewayInput", "messageType", "role", "version"],
  "validator readiness gateway runtime input payload");
  const gatewayInput = verifyValidatorReadinessGatewayChildInput(value.gatewayInput,
    childPins(value.gatewayInput), { now });
  if (value.format !== FORMAT || value.messageType !== "gateway-runtime-bootstrap" ||
      value.role !== "gateway" || value.version !== 1) {
    throw new Error("validator readiness gateway runtime input binding is invalid");
  }
  return { expectedConsensusPid: pid(value.expectedConsensusPid,
    "validator readiness gateway runtime expected consensus PID"),
  expectedGatewayPid: pid(value.expectedGatewayPid,
    "validator readiness gateway runtime expected gateway PID"),
  expectedTransportPid: pid(value.expectedTransportPid,
    "validator readiness gateway runtime expected transport PID"),
  format: FORMAT, gatewayInput, messageType: "gateway-runtime-bootstrap",
  role: "gateway", version: 1 };
}

export function createValidatorReadinessGatewayRuntimeInput({ expectedConsensusPid,
  expectedGatewayPid, expectedTransportPid, gatewayInput } = {}, { now = Date.now() } = {}) {
  const value = payload({ expectedConsensusPid, expectedGatewayPid, expectedTransportPid,
    format: FORMAT, gatewayInput, messageType: "gateway-runtime-bootstrap", role: "gateway",
    version: 1 }, now);
  return { ...value, runtimeInputHash: tagged(value) };
}

export function verifyValidatorReadinessGatewayRuntimeInput(value, { now = Date.now() } = {}) {
  exact(value, ["expectedConsensusPid", "expectedGatewayPid", "expectedTransportPid", "format",
    "gatewayInput", "messageType", "role", "runtimeInputHash", "version"],
  "validator readiness gateway runtime input");
  const { runtimeInputHash, ...unsigned } = value;
  const verified = payload(unsigned, now);
  if (!TAGGED_HASH.test(runtimeInputHash ?? "") || runtimeInputHash !== tagged(verified)) {
    throw new Error("validator readiness gateway runtime input hash is invalid");
  }
  return { ...verified, runtimeInputHash };
}
