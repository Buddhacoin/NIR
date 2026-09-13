import { createHash } from "node:crypto";

import {
  NirChain,
  createTransfer,
  finalizeBlock,
  formatNir,
} from "./chain.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";

const validators = Array.from({ length: 4 }, generateWallet);
const founder = generateWallet();
const alice = generateWallet();
const bob = generateWallet();
const chain = new NirChain({
  networkId: "nir-localnet-1",
  validators: validators.map(publicWallet),
  treasuryAddress: founder.address,
});

function quorumFor(block) {
  const proposer = validators.find((wallet) => wallet.address === block.proposer);
  return [
    proposer,
    ...validators.filter((wallet) => wallet !== proposer).slice(0, 2),
  ];
}

const proofFingerprint = createHash("sha256")
  .update("nir-genesis-proof-1")
  .digest("hex");
const rewardBlock = chain.buildBlock({
  rewardClaims: [
    { fingerprint: proofFingerprint, recipient: alice.address, score: "396112" },
  ],
  timestamp: 1,
});
chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock)));

const payment = createTransfer({
  wallet: alice,
  recipient: bob.address,
  amount: "200000000",
  nonce: chain.nextNonce(alice.address),
  fee: "1000",
});
const paymentBlock = chain.buildBlock({ transactions: [payment], timestamp: 2 });
chain.appendBlock(finalizeBlock(paymentBlock, quorumFor(paymentBlock)));

console.log(`height: ${chain.height}`);
console.log(`issued: ${formatNir(chain.issued)}`);
console.log(`alice: ${formatNir(chain.balance(alice.address))}`);
console.log(`bob: ${formatNir(chain.balance(bob.address))}`);
console.log(`final block: ${chain.blocks.at(-1).hash}`);
console.log("signature suite: ML-DSA-65");
