import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aggregateBeaconShares } from "../blockchain/beacon-aggregation.mjs";
import { canonicalJson, generateWallet } from "../blockchain/crypto.mjs";
import { createFallbackBeaconShare, createProgressBeaconShare } from "../blockchain/operators.mjs";

const CANDIDATE = "a".repeat(64);
const NETWORK = "nir-beacon-aggregation-test";
const ROUND = 7;

function fixture(createShare = createFallbackBeaconShare) {
  return Array.from({ length: 3 }, (_, index) => createShare({
    candidateId: CANDIDATE, generation: 2, networkId: NETWORK, round: ROUND,
    value: String(index + 1).repeat(64), wallet: generateWallet(),
  }));
}

test("beacon aggregation canonicalizes one unique share per authority", () => {
  const shares = fixture();
  const beacon = aggregateBeaconShares({ candidateId: CANDIDATE, networkId: NETWORK,
    purpose: "fallback", round: ROUND, shares: [shares[2], shares[0], shares[1]] });
  assert.equal(beacon.generation, 2);
  assert.equal(beacon.attestations.length, 3);
  assert.deepEqual(beacon.attestations.map(({ authority }) => authority),
    [...beacon.attestations.map(({ authority }) => authority)].sort());

  const progressShares = fixture(createProgressBeaconShare);
  const progress = aggregateBeaconShares({ candidateId: CANDIDATE, networkId: NETWORK,
    purpose: "progress", round: ROUND, shares: progressShares });
  assert.equal(progress.attestations.length, 3);
});

test("beacon aggregation rejects duplicate authorities and malformed share envelopes", () => {
  const shares = fixture();
  assert.throws(() => aggregateBeaconShares({ candidateId: CANDIDATE, networkId: NETWORK,
    round: ROUND, shares: [shares[0], shares[0], shares[1]] }), /duplicated/);
  assert.throws(() => aggregateBeaconShares({ candidateId: CANDIDATE, networkId: NETWORK,
    round: ROUND, shares: shares.map((share, index) => index === 1 ? { ...share, extra: true } : share) }),
  /schema/);
  assert.throws(() => aggregateBeaconShares({ candidateId: CANDIDATE, networkId: NETWORK,
    round: ROUND, shares: shares.map((share, index) => index === 1 ? { ...share, signature: "%%%" } : share) }),
  /encoding/);
});

test("beacon aggregation CLI reads only canonical, unique, safe regular files", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-beacon-aggregation-"));
  const shares = fixture(); const paths = shares.map((share, index) => join(root, `share-${index}.json`));
  try {
    shares.forEach((share, index) => writeFileSync(paths[index], `${canonicalJson(share)}\n`, { mode: 0o600 }));
    const command = ["blockchain/beacon-aggregate.mjs", NETWORK, CANDIDATE, String(ROUND), ...paths];
    const accepted = spawnSync(process.execPath, command, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(`${canonicalJson(JSON.parse(accepted.stdout))}\n`, accepted.stdout);

    const link = join(root, "share-link.json"); symlinkSync(paths[2], link);
    const linked = spawnSync(process.execPath, [...command.slice(0, -1), link],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /unsafe/);

    const hardlink = join(root, "share-hardlink.json"); linkSync(paths[1], hardlink);
    const repeated = spawnSync(process.execPath,
      ["blockchain/beacon-aggregate.mjs", NETWORK, CANDIDATE, String(ROUND), paths[0], paths[1], hardlink],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /unsafe|duplicated/);

    unlinkSync(hardlink);
    writeFileSync(paths[2], `${JSON.stringify(shares[2], null, 2)}\n`, { mode: 0o600 });
    const noncanonical = spawnSync(process.execPath, command, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(noncanonical.status, 1);
    assert.match(noncanonical.stderr, /canonical/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
