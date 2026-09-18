import {
  CREDIT_UNSTAKE_DELAY_BLOCKS,
  MIN_TRANSFER_FEE,
  SUPPORTED_PROTOCOL_VERSIONS,
  TRANSFER_CREDIT_STAKE_UNIT,
} from "./constants.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyPaymentRequest } from "./payment-request.mjs";
import { normalizePendingProtocolUpgrade } from "./protocol-upgrade.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,31})$/;
const HASH = /^[0-9a-f]{64}$/;
const NETWORK = /^[a-zA-Z0-9._:-]{3,128}$/;
const MAX_DELEGATIONS = 256;
const SYSTEM_NIR_ASSET_ID = "0".repeat(64);

function fail(message) { throw new Error(`transaction simulation: ${message}`); }

function atomic(value, field, { positive = false } = {}) {
  if (typeof value !== "string" || !AMOUNT.test(value)) fail(`${field} is not atomic`);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) fail(`${field} must be positive`);
  return parsed;
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} is invalid`);
  return value;
}

function address(value, field) {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail(`${field} is invalid`);
  return value;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has an unknown field`);
}

function account(value, expectedAddress) {
  exactKeys(value, new Set(["address", "atomicBalance", "history", "nextNonce", "resources"]), "account state");
  if (address(value.address, "account address") !== expectedAddress) fail("account state address does not match");
  const resources = value.resources;
  exactKeys(resources, new Set([
    "atomicStake", "availableTransferCredits", "delegations", "pendingUnstake",
  ]), "account resources");
  const result = {
    address: value.address,
    balance: atomic(value.atomicBalance, "account balance"),
    nonce: integer(value.nextNonce, "account nonce"),
    resources: {
      credits: atomic(resources.availableTransferCredits, "available transfer credits"),
      delegations: [],
      pendingUnstake: null,
      stake: atomic(resources.atomicStake, "stake"),
    },
  };
  if (!Array.isArray(resources.delegations) || resources.delegations.length > MAX_DELEGATIONS) {
    fail("delegations are invalid");
  }
  result.resources.delegations = resources.delegations.map((entry) => {
    exactKeys(entry, new Set(["delegate", "epoch", "limit", "owner", "spent"]), "delegation");
    if (entry.owner !== expectedAddress || address(entry.delegate, "delegation delegate") === expectedAddress ||
        !Number.isSafeInteger(entry.epoch) || entry.epoch < 0 ||
        !Number.isSafeInteger(entry.limit) || entry.limit < 1 || entry.limit > 1_000_000 ||
        !Number.isSafeInteger(entry.spent) || entry.spent < 0 || entry.spent > entry.limit) {
      fail("delegation is invalid");
    }
    return { ...entry };
  });
  if (resources.pendingUnstake !== null) {
    exactKeys(resources.pendingUnstake, new Set(["amount", "unlockHeight"]), "pending unstake");
    const unlockHeight = integer(resources.pendingUnstake.unlockHeight, "unstake unlock height");
    if (unlockHeight < 1) fail("unstake unlock height is invalid");
    result.resources.pendingUnstake = {
      amount: atomic(resources.pendingUnstake.amount, "pending unstake amount", { positive: true }),
      unlockHeight,
    };
  }
  return result;
}

function evidence(value) {
  exactKeys(value, new Set([
    "accounts", "assetProofs", "height", "networkId", "proofVerified", "stateRoot", "tipHash", "verified",
  ]), "simulation evidence");
  if (value.verified !== true || value.proofVerified !== true || !NETWORK.test(value.networkId ?? "") ||
      !Number.isSafeInteger(value.height) || value.height < 0 ||
      !HASH.test(value.tipHash ?? "") || !HASH.test(value.stateRoot ?? "") ||
      !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
    fail("verified account evidence is required");
  }
  const result = new Map();
  for (const [key, valueAccount] of Object.entries(value.accounts)) {
    address(key, "evidence account key");
    result.set(key, account(valueAccount, key));
  }
  if (result.size === 0 || result.size > 3) fail("verified account evidence is invalid");
  const assetProofs = new Map();
  if (value.assetProofs !== undefined) {
    if (!Array.isArray(value.assetProofs) || value.assetProofs.length > 3) fail("verified asset evidence is invalid");
    for (const statement of value.assetProofs) {
      exactKeys(statement, new Set(["asset", "assetId", "balance", "format", "height", "holder",
        "networkId", "pendingProtocolUpgrade", "protocolVersion", "stateRoot", "tipHash", "validatorSetId"]), "asset proof statement");
      if (!HASH.test(statement.assetId ?? "") || statement.assetId === SYSTEM_NIR_ASSET_ID ||
          address(statement.holder, "asset holder") !== statement.holder ||
          statement.networkId !== value.networkId || statement.height !== value.height ||
          statement.tipHash !== value.tipHash || statement.stateRoot !== value.stateRoot ||
          statement.format !== "nir-native-asset-proof-v1" ||
          !HASH.test(statement.validatorSetId ?? "") ||
          !SUPPORTED_PROTOCOL_VERSIONS.includes(statement.protocolVersion)) {
        fail("asset proof does not match simulation checkpoint");
      }
      try {
        normalizePendingProtocolUpgrade(statement.pendingProtocolUpgrade, {
          currentHeight: statement.height, currentVersion: statement.protocolVersion,
        });
      } catch { fail("asset proof protocol state is invalid"); }
      const key = `${statement.assetId}:${statement.holder}`;
      if (assetProofs.has(key)) fail("asset proof is duplicated");
      const firstProof = assetProofs.values().next().value;
      if (firstProof && (firstProof.validatorSetId !== statement.validatorSetId ||
          firstProof.protocolVersion !== statement.protocolVersion ||
          canonicalJson(firstProof.pendingProtocolUpgrade) !==
            canonicalJson(statement.pendingProtocolUpgrade))) {
        fail("asset proofs disagree on protocol trust context");
      }
      const parsed = { ...structuredClone(statement), balance: atomic(statement.balance, "asset balance") };
      if (statement.asset !== null) {
        exactKeys(statement.asset, new Set(["assetId", "authority", "creationNonce", "creator", "fixedSupply",
          "maxSupply", "metadataHash", "minted", "supply"]), "asset state");
        if (statement.asset.assetId !== statement.assetId ||
            address(statement.asset.creator, "asset creator") !== statement.asset.creator ||
            !(statement.asset.authority === null ||
              address(statement.asset.authority, "asset authority") === statement.asset.creator) ||
            !Number.isSafeInteger(statement.asset.creationNonce) || statement.asset.creationNonce < 0 ||
            typeof statement.asset.fixedSupply !== "boolean" ||
            !HASH.test(statement.asset.metadataHash ?? "") ||
            statement.assetId !== hashObject({ creator: statement.asset.creator,
              networkId: statement.networkId, nonce: statement.asset.creationNonce },
            "NATIVE_ASSET_ID_V1")) fail("asset state definition does not match proof");
        parsed.asset = { ...statement.asset, maxSupply: atomic(statement.asset.maxSupply, "asset cap"),
          minted: atomic(statement.asset.minted, "asset minted"), supply: atomic(statement.asset.supply, "asset supply") };
        if (parsed.asset.maxSupply === 0n || parsed.asset.supply > parsed.asset.minted ||
            parsed.asset.minted > parsed.asset.maxSupply || parsed.balance > parsed.asset.supply ||
            (parsed.asset.fixedSupply && (parsed.asset.authority !== null ||
              parsed.asset.minted !== parsed.asset.maxSupply))) {
          fail("asset state supply or authority invariant is invalid");
        }
      } else if (parsed.balance !== 0n) fail("absent asset has a balance");
      assetProofs.set(key, parsed);
    }
  }
  return { accounts: result, assetProofs, height: value.height, networkId: value.networkId, stateRoot: value.stateRoot, tipHash: value.tipHash };
}

function operationKeys(intent, permitted) {
  exactKeys(intent, new Set(["type", ...permitted]), "transaction intent");
  if (!NETWORK.test(intent.networkId ?? "")) fail("network id is invalid");
  address(intent.sender, "sender");
  integer(intent.nonce, "nonce");
}

function fee(intent, required = true) {
  if (intent.fee === undefined && !required) return MIN_TRANSFER_FEE;
  const value = atomic(intent.fee, "fee");
  if (value < MIN_TRANSFER_FEE) fail("fee is below the protocol minimum");
  return value;
}

function requireAccount(evidenceValue, addressValue, role) {
  const value = evidenceValue.accounts.get(addressValue);
  if (!value) fail(`${role} account lacks independently verified state`);
  return value;
}

function requireAsset(evidenceValue, assetId, holder, { absent = false } = {}) {
  if (!HASH.test(assetId ?? "") || assetId === SYSTEM_NIR_ASSET_ID) fail("asset id is invalid or reserved");
  const proof = evidenceValue.assetProofs.get(`${assetId}:${holder}`);
  if (!proof) fail("asset operation lacks independently verified asset proof");
  if (absent ? proof.asset !== null : proof.asset === null) fail(absent ? "asset already exists" : "asset is unknown");
  return proof;
}

function delta(addressValue, atomicDelta, role) {
  return { address: addressValue, atomicDelta: atomicDelta.toString(), role };
}

function nonceDelta(addressValue, before, role) {
  return { address: addressValue, after: before + 1, before, role };
}

function common({ intent, evidence: evidenceValue }) {
  if (intent.networkId !== evidenceValue.networkId) fail("intent belongs to another network");
  const sender = requireAccount(evidenceValue, intent.sender, "sender");
  if (intent.nonce !== sender.nonce) fail("intent nonce does not match independently verified state");
  return sender;
}

function transfer(intent, evidenceValue) {
  operationKeys(intent, [
    "amount", "creditOwner", "fee", "feePayer", "feePayerNonce", "networkId", "nonce",
    "recipient", "resource", "sender",
  ]);
  const sender = common({ intent, evidence: evidenceValue });
  const recipient = address(intent.recipient, "recipient");
  const amount = atomic(intent.amount, "amount", { positive: true });
  const creditPaid = intent.resource === "transfer-credit";
  if (intent.resource !== undefined && !creditPaid) fail("transfer resource is unknown");
  const sponsored = intent.feePayer !== undefined || intent.feePayerNonce !== undefined;
  if (sponsored !== (intent.feePayer !== undefined && intent.feePayerNonce !== undefined)) {
    fail("sponsored transfer fields are incomplete");
  }
  if (intent.creditOwner !== undefined && (!creditPaid || sponsored || intent.creditOwner === intent.sender)) {
    fail("delegated credit payer is invalid");
  }
  const balanceDeltas = [];
  const resourceDeltas = [];
  const nonces = [nonceDelta(intent.sender, sender.nonce, "sender")];
  let feeValue = 0n;
  let feePayer = intent.sender;
  let authority = [{ address: intent.sender, role: "sender", required: true }];
  const risks = ["Broadcast is never part of simulation; state may change before signing."];
  if (creditPaid) {
    if (intent.fee !== undefined && atomic(intent.fee, "fee") !== 0n) fail("credit-paid transfer fee must be zero");
    const creditOwner = sponsored ? address(intent.feePayer, "fee payer") :
      intent.creditOwner === undefined ? intent.sender : address(intent.creditOwner, "credit owner");
    const payer = requireAccount(evidenceValue, creditOwner, "transfer-credit payer");
    if (payer.resources.credits < 1n) fail("transfer-credit payer has no available credit");
    if (intent.creditOwner !== undefined) {
      const delegation = payer.resources.delegations.find(({ delegate }) => delegate === intent.sender);
      if (!delegation || delegation.spent >= delegation.limit) fail("transfer-credit delegation is unavailable");
      resourceDeltas.push({ after: delegation.spent + 1, before: delegation.spent, delegate: intent.sender,
        owner: creditOwner, role: "delegation-spend", unit: "transfer-credit" });
    }
    resourceDeltas.push({ address: creditOwner, after: (payer.resources.credits - 1n).toString(),
      before: payer.resources.credits.toString(), role: "transfer-credit", unit: "transfer-credit" });
    if (sponsored) {
      const sponsor = payer;
      integer(intent.feePayerNonce, "fee payer nonce");
      if (intent.feePayerNonce !== sponsor.nonce || intent.feePayer === intent.sender) fail("fee payer nonce is invalid");
      nonces.push(nonceDelta(intent.feePayer, sponsor.nonce, "fee-payer"));
      authority.push({ address: intent.feePayer, role: "transfer-credit payer", required: true });
      feePayer = intent.feePayer;
    }
  } else {
    feeValue = fee(intent);
    if (sponsored) {
      feePayer = address(intent.feePayer, "fee payer");
      if (feePayer === intent.sender) fail("fee payer must be distinct");
      const sponsor = requireAccount(evidenceValue, feePayer, "fee payer");
      integer(intent.feePayerNonce, "fee payer nonce");
      if (intent.feePayerNonce !== sponsor.nonce) fail("fee payer nonce does not match independently verified state");
      if (sender.balance < amount || sponsor.balance < feeValue) fail("insufficient independently verified balance");
      balanceDeltas.push(delta(feePayer, -feeValue, "fee-payer"));
      nonces.push(nonceDelta(feePayer, sponsor.nonce, "fee-payer"));
      authority.push({ address: feePayer, role: "fee-payer", required: true });
    } else if (sender.balance < amount + feeValue) {
      fail("insufficient independently verified balance");
    }
  }
  if (sender.balance < amount + (!sponsored ? feeValue : 0n)) fail("insufficient independently verified balance");
  balanceDeltas.unshift(delta(intent.sender, -(amount + (!sponsored ? feeValue : 0n)), "sender"));
  balanceDeltas.push(delta(recipient, amount, "recipient"));
  if (feeValue > 0n) balanceDeltas.push(delta(null, feeValue, "next-block-fee-recipient"));
  if (recipient === intent.sender) risks.push("Recipient is the sender; only the fee changes the sender balance.");
  if (creditPaid) risks.push("A renewable transfer credit is consumed; availability renews by protocol epoch.");
  if (sponsored) risks.push("A distinct fee payer must authorize this exact transaction and nonce.");
  return {
    authority, deltas: { balance: balanceDeltas, fee: { atomic: feeValue.toString(), payer: feePayer,
      recipient: feeValue > 0n ? "next-block-fee-recipient" : null }, resources: resourceDeltas, nonce: nonces },
    risks, title: sponsored ? "Sponsored transfer" : "Transfer",
  };
}

function stake(intent, evidenceValue) {
  operationKeys(intent, ["amount", "fee", "networkId", "nonce", "sender"]);
  const sender = common({ intent, evidence: evidenceValue });
  const amount = atomic(intent.amount, "stake amount", { positive: true });
  const feeValue = fee(intent);
  if (sender.balance < amount + feeValue) fail("insufficient independently verified balance");
  return { title: "Stake for network credits", authority: [{ address: intent.sender, role: "stake-owner", required: true }],
    deltas: { balance: [delta(intent.sender, -amount - feeValue, "stake-owner"), delta(null, feeValue, "next-block-fee-recipient")],
      fee: { atomic: feeValue.toString(), payer: intent.sender, recipient: "next-block-fee-recipient" },
      nonce: [nonceDelta(intent.sender, sender.nonce, "stake-owner")], resources: [{ address: intent.sender,
        after: (sender.resources.stake + amount).toString(), before: sender.resources.stake.toString(), role: "stake" }] },
    risks: ["Staked funds are not spendable until an unstake request is completed."], };
}

function delegation(intent, evidenceValue) {
  operationKeys(intent, ["delegate", "fee", "limit", "networkId", "nonce", "sender"]);
  const sender = common({ intent, evidence: evidenceValue });
  const delegate = address(intent.delegate, "delegate");
  if (delegate === intent.sender || !Number.isSafeInteger(intent.limit) || intent.limit < 0 || intent.limit > 1_000_000) {
    fail("delegation is invalid");
  }
  const feeValue = fee(intent);
  const previous = sender.resources.delegations.find((entry) => entry.delegate === delegate) ?? null;
  const revocationFromStake = intent.limit === 0 && sender.balance < feeValue;
  if (intent.limit > 0 && sender.resources.stake < TRANSFER_CREDIT_STAKE_UNIT) fail("stake is below the delegation minimum");
  if (intent.limit === 0 && !previous) fail("delegation does not exist");
  if (!revocationFromStake && sender.balance < feeValue) fail("insufficient independently verified balance");
  if (revocationFromStake && sender.resources.stake < feeValue) fail("insufficient independently verified stake");
  return { title: intent.limit === 0 ? "Revoke credit delegation" : "Delegate transfer credits",
    authority: [{ address: intent.sender, role: "delegation-owner", required: true }],
    deltas: { balance: revocationFromStake ? [delta(null, feeValue, "next-block-fee-recipient")] :
      [delta(intent.sender, -feeValue, "delegation-owner"), delta(null, feeValue, "next-block-fee-recipient")],
    fee: { atomic: feeValue.toString(), payer: intent.sender, recipient: "next-block-fee-recipient",
      ...(revocationFromStake ? { paidFrom: "stake" } : {}) },
    nonce: [nonceDelta(intent.sender, sender.nonce, "delegation-owner")], resources: [
      intent.limit === 0 ? { delegate, owner: intent.sender, role: "delegation", after: null, before: previous } :
        { delegate, owner: intent.sender, role: "delegation", after: { limit: intent.limit, spent: previous?.spent ?? 0 }, before: previous },
      ...(revocationFromStake ? [{ address: intent.sender, after: (sender.resources.stake - feeValue).toString(), before: sender.resources.stake.toString(), role: "stake" }] : []),
    ] }, risks: ["A delegate can consume only the explicit credit limit; it cannot move your balance."], };
}

function unstakeRequest(intent, evidenceValue) {
  operationKeys(intent, ["amount", "fee", "networkId", "nonce", "sender"]);
  const sender = common({ intent, evidence: evidenceValue });
  const amount = atomic(intent.amount, "unstake amount", { positive: true });
  const feeValue = fee(intent);
  if (sender.resources.pendingUnstake) fail("an unstake request is already pending");
  if (amount <= feeValue || sender.resources.stake < amount) fail("unstake amount or fee is invalid");
  return { title: "Request unstake", authority: [{ address: intent.sender, role: "stake-owner", required: true }],
    deltas: { balance: [delta(null, feeValue, "next-block-fee-recipient")],
      fee: { atomic: feeValue.toString(), payer: "unstaked-amount", recipient: "next-block-fee-recipient" },
      nonce: [nonceDelta(intent.sender, sender.nonce, "stake-owner")], resources: [
        { address: intent.sender, after: (sender.resources.stake - amount).toString(), before: sender.resources.stake.toString(), role: "stake" },
        { address: intent.sender, after: { amount: (amount - feeValue).toString(), unlockHeight: evidenceValue.height + 1 + CREDIT_UNSTAKE_DELAY_BLOCKS }, before: null, role: "pending-unstake" },
      ] }, risks: ["The principal is locked until its protocol unlock height; the fee is deducted from the requested stake."], };
}

function unstakeClaim(intent, evidenceValue) {
  operationKeys(intent, ["networkId", "nonce", "sender"]);
  const sender = common({ intent, evidence: evidenceValue });
  const pending = sender.resources.pendingUnstake;
  if (!pending || evidenceValue.height + 1 < pending.unlockHeight) fail("unstake is not unlocked in the next block");
  return { title: "Claim unstaked funds", authority: [{ address: intent.sender, role: "stake-owner", required: true }],
    deltas: { balance: [delta(intent.sender, pending.amount, "stake-owner")],
      fee: { atomic: "0", payer: null, recipient: null }, nonce: [nonceDelta(intent.sender, sender.nonce, "stake-owner")],
      resources: [{ address: intent.sender, after: null, before: pending, role: "pending-unstake" }] },
    risks: ["Claim availability is checked against the next finalized block height."], };
}

function assetOperation(intent, evidenceValue) {
  const keys = {
    "asset-create": ["assetId", "fee", "fixedSupply", "initialSupply", "maxSupply", "metadataHash", "networkId", "nonce", "sender"],
    "asset-mint": ["amount", "assetId", "fee", "networkId", "nonce", "sender"],
    "asset-transfer": ["amount", "assetId", "fee", "networkId", "nonce", "recipient", "sender"],
    "asset-burn": ["amount", "assetId", "fee", "networkId", "nonce", "sender"],
    "asset-revoke-authority": ["assetId", "fee", "networkId", "nonce", "sender"],
  };
  operationKeys(intent, keys[intent.type]);
  const sender = common({ intent, evidence: evidenceValue });
  const feeValue = fee(intent);
  if (sender.balance < feeValue) fail("insufficient independently verified NIR balance for fee");
  const balance = [delta(intent.sender, -feeValue, "fee-payer"), delta(null, feeValue, "next-block-fee-recipient")];
  const nonce = [nonceDelta(intent.sender, sender.nonce, "asset-authority")];
  const risks = ["Asset state may change before signing; re-prove and re-simulate after any finalized-state change."];
  let assetDeltas;
  let authorityRole = "holder";
  if (intent.type === "asset-create") {
    const proof = requireAsset(evidenceValue, intent.assetId, intent.sender, { absent: true });
    const expectedId = hashObject({ creator: intent.sender, networkId: intent.networkId, nonce: intent.nonce }, "NATIVE_ASSET_ID_V1");
    const initial = atomic(intent.initialSupply, "initial supply"); const cap = atomic(intent.maxSupply, "maximum supply", { positive: true });
    if (intent.assetId !== expectedId || !HASH.test(intent.metadataHash ?? "") || typeof intent.fixedSupply !== "boolean" ||
        initial > cap || (intent.fixedSupply && initial !== cap)) fail("asset definition is invalid");
    assetDeltas = [{ assetId: intent.assetId, holder: intent.sender, balanceBefore: proof.balance.toString(),
      balanceAfter: initial.toString(), supplyBefore: null, supplyAfter: initial.toString(), mintedAfter: initial.toString() }];
    authorityRole = "creator";
    risks.push("The asset ID, metadata hash, fixed-supply flag, and maximum supply are immutable.");
  } else {
    const proof = requireAsset(evidenceValue, intent.assetId, intent.sender);
    const asset = proof.asset;
    if (intent.type === "asset-mint") {
      const amount = atomic(intent.amount, "mint amount", { positive: true });
      if (asset.authority !== intent.sender || asset.minted + amount > asset.maxSupply) fail("mint is unauthorized or exceeds the immutable cap");
      assetDeltas = [{ assetId: intent.assetId, holder: intent.sender, balanceBefore: proof.balance.toString(),
        balanceAfter: (proof.balance + amount).toString(), supplyBefore: asset.supply.toString(),
        supplyAfter: (asset.supply + amount).toString(), mintedAfter: (asset.minted + amount).toString() }];
      authorityRole = "mint-authority";
      risks.push("Minting consumes part of the immutable lifetime cap; burned units do not restore mint capacity.");
    } else if (intent.type === "asset-transfer") {
      const recipient = address(intent.recipient, "recipient"); const amount = atomic(intent.amount, "asset amount", { positive: true });
      if (recipient === intent.sender || proof.balance < amount) fail("asset transfer is invalid or unfunded");
      const recipientProof = requireAsset(evidenceValue, intent.assetId, recipient);
      if (["assetId", "authority", "creationNonce", "creator", "fixedSupply", "metadataHash"]
        .some((field) => recipientProof.asset[field] !== proof.asset[field]) ||
        ["maxSupply", "minted", "supply"].some((field) => recipientProof.asset[field] !== proof.asset[field])) {
        fail("asset proofs disagree on asset state");
      }
      assetDeltas = [{ assetId: intent.assetId, holder: intent.sender, balanceBefore: proof.balance.toString(), balanceAfter: (proof.balance - amount).toString() },
        { assetId: intent.assetId, holder: recipient, balanceBefore: recipientProof.balance.toString(), balanceAfter: (recipientProof.balance + amount).toString() }];
    } else if (intent.type === "asset-burn") {
      const amount = atomic(intent.amount, "burn amount", { positive: true });
      if (proof.balance < amount) fail("asset burn is unfunded");
      assetDeltas = [{ assetId: intent.assetId, holder: intent.sender, balanceBefore: proof.balance.toString(),
        balanceAfter: (proof.balance - amount).toString(), supplyBefore: asset.supply.toString(), supplyAfter: (asset.supply - amount).toString() }];
      risks.push("Burn is irreversible and does not restore lifetime mint capacity.");
    } else {
      if (asset.fixedSupply || asset.authority !== intent.sender) fail("authority revocation is unauthorized or already final");
      assetDeltas = [{ assetId: intent.assetId, authorityBefore: intent.sender, authorityAfter: null }];
      authorityRole = "mint-authority";
      risks.push("Revoking mint authority is irreversible; no future mint is possible.");
    }
  }
  return { title: intent.type.replaceAll("-", " "), authority: [{ address: intent.sender, role: authorityRole, required: true }],
    deltas: { asset: assetDeltas, balance, fee: { atomic: feeValue.toString(), payer: intent.sender,
      recipient: "next-block-fee-recipient" }, nonce, resources: [] }, risks };
}

function paymentRequest(intent, evidenceValue, now) {
  let request;
  if (intent.signature === undefined) {
    exactKeys(intent, new Set(["amount", "expiresAt", "memo", "networkId", "recipient", "requestId", "type"]), "payment request intent");
    if (intent.type !== "payment-request" || !NETWORK.test(intent.networkId ?? "")) fail("payment request network is invalid");
    address(intent.recipient, "payment request recipient");
    if (typeof intent.requestId !== "string" || !HASH.test(intent.requestId) ||
        typeof intent.memo !== "string" || Buffer.byteLength(intent.memo, "utf8") > 160 ||
        /[\u0000-\u001f\u007f]/u.test(intent.memo) || !Number.isSafeInteger(intent.expiresAt) ||
        intent.expiresAt <= now || atomic(intent.amount, "payment request amount", { positive: true }) === 0n) {
      fail("payment request intent is invalid");
    }
    request = structuredClone(intent);
  } else {
    request = verifyPaymentRequest(intent, { networkId: evidenceValue.networkId, now });
  }
  return { title: "Payment request", authority: [{ address: request.recipient, role: "request-recipient", required: true }],
    deltas: { balance: [], fee: { atomic: "0", payer: null, recipient: null }, nonce: [], resources: [] },
    risks: ["A payment request is not a transfer and cannot authorize a broadcast.", "Its amount and expiry must be rechecked when a transfer is later prepared."],
    request: { amount: request.amount, expiresAt: request.expiresAt, memo: request.memo, recipient: request.recipient } };
}

/**
 * Deterministically decode and simulate a wallet operation against quorum-verified account state.
 * It is intentionally side-effect free and rejects unknown transaction types and unverifiable state.
 */
export function simulateWalletOperation({ intent, stateEvidence, now = Date.now() } = {}) {
  const evidenceValue = evidence(stateEvidence);
  if (!intent || typeof intent !== "object" || Array.isArray(intent) || !Number.isSafeInteger(now) || now < 0) {
    fail("input is invalid");
  }
  let decoded;
  switch (intent.type) {
    case "transfer": decoded = transfer(intent, evidenceValue); break;
    case "credit-stake": decoded = stake(intent, evidenceValue); break;
    case "credit-delegation": decoded = delegation(intent, evidenceValue); break;
    case "credit-unstake-request": decoded = unstakeRequest(intent, evidenceValue); break;
    case "credit-unstake-claim": decoded = unstakeClaim(intent, evidenceValue); break;
    case "payment-request": decoded = paymentRequest(intent, evidenceValue, now); break;
    case "asset-create": case "asset-mint": case "asset-transfer": case "asset-burn":
    case "asset-revoke-authority": decoded = assetOperation(intent, evidenceValue); break;
    default: fail("operation type is not supported");
  }
  const canonicalIntent = JSON.parse(canonicalJson(intent));
  return {
    ...decoded,
    intent: canonicalIntent,
    intentHash: hashObject(canonicalIntent, "WALLET_SIMULATION_INTENT_V1"),
    networkId: evidenceValue.networkId,
    proof: { stateRoot: evidenceValue.stateRoot, tipHash: evidenceValue.tipHash, verified: true },
    stateHeight: evidenceValue.height,
    type: intent.type,
    verified: true,
  };
}

export function decodeWalletOperation(input, options = {}) {
  const simulation = simulateWalletOperation({ ...options, intent: input });
  return { authority: simulation.authority, risks: simulation.risks, title: simulation.title,
    type: simulation.type, networkId: simulation.networkId, intentHash: simulation.intentHash };
}
