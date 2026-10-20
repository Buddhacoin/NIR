import { isAbsolute } from "node:path";

import { canonicalJson } from "./crypto.mjs";
import { compileGenesis, verifyGenesisCeremony } from "./genesis-ceremony.mjs";
import { verifyCeremonyRegistry } from "./genesis-ceremony-store.mjs";
import { WALLET_EXTENSION_ORIGIN } from "./validator-transaction-ingress.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const EXACT_FIREFOX_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function exactWalletReadOrigin(value) {
  if (value === WALLET_EXTENSION_ORIGIN ||
      (typeof value === "string" && EXACT_FIREFOX_ORIGIN.test(value))) return value;
  let url;
  try { url = new URL(value); }
  catch { throw new Error("wallet read requires an exact local browser origin"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.origin !== value) {
    throw new Error("wallet read requires an exact local browser origin");
  }
  return value;
}

export function pinWalletReadPeerUrls(compiledGenesis, localGenesis) {
  if (canonicalJson(localGenesis) !== canonicalJson(compiledGenesis) ||
      !Array.isArray(compiledGenesis?.validators) ||
      !Array.isArray(compiledGenesis?.peerRegistry?.peers)) {
    throw new Error("wallet read coordinator genesis differs from signed ceremony");
  }
  const peers = compiledGenesis.peerRegistry.peers;
  if (peers.length !== compiledGenesis.validators.length || peers.length < 4) {
    throw new Error("wallet read ceremony peer set is incomplete");
  }
  return compiledGenesis.validators.map(({ address }) => {
    const matching = peers.filter((peer) => peer.validatorAddress === address);
    const peer = matching[0];
    let url;
    try { url = new URL(peer?.url); }
    catch { throw new Error("wallet read ceremony peer endpoint is invalid"); }
    if (matching.length !== 1 || !HASH.test(peer.tlsCertificateSha256 ?? "") ||
        url.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.port || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || url.origin !== peer.url) {
      throw new Error("wallet read ceremony peer endpoint or TLS pin is invalid");
    }
    return peer.url;
  });
}

export function verifyCeremonyWalletReadEvidence({ anchor, expectedGenesisHash,
  registryDirectory, trustedReleaseSignerAddress, localGenesis } = {}) {
  if (!anchor || !HASH.test(expectedGenesisHash ?? "") ||
      !ADDRESS.test(trustedReleaseSignerAddress ?? "") ||
      typeof registryDirectory !== "string" || !isAbsolute(registryDirectory)) {
    throw new Error("wallet read requires external ceremony trust anchors");
  }
  const registry = verifyCeremonyRegistry(registryDirectory, {
    anchor, trustedAddress: trustedReleaseSignerAddress,
  });
  if (registry.count < 1 || registry.count !== anchor.payload?.count ||
      registry.head !== anchor.payload?.registryHead) {
    throw new Error("wallet read ceremony registry is not at its external anchor");
  }
  const record = registry.records.at(-1);
  if (record.plan.format !== "nir-public-genesis-plan-v2" ||
      record.genesisHash !== expectedGenesisHash ||
      anchor.payload.latestGenesisHash !== expectedGenesisHash) {
    throw new Error("wallet read ceremony genesis does not match its pin");
  }
  const releaseOptions = { signedRelease: record.signedRelease,
    trustedAddress: trustedReleaseSignerAddress };
  verifyGenesisCeremony(record.plan, record.envelope, releaseOptions);
  const compiled = compileGenesis(record.plan, record.envelope, releaseOptions);
  if (compiled.genesisHash !== expectedGenesisHash) {
    throw new Error("wallet read compiled genesis differs from its pin");
  }
  return { genesis: compiled.genesis,
    peerUrls: pinWalletReadPeerUrls(compiled.genesis, localGenesis) };
}
