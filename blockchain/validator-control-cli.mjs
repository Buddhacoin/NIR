#!/usr/bin/env node
import { requestValidatorControl } from "./validator-control-socket.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";

const [operation, socketPath, ...extra] = process.argv.slice(2);
try {
  const usage = "usage: validator:control <sync|produce> <socket> | " +
    "stage-reward <socket> <signed-claim.json> <network-id> <expected-height> <previous-tip-hash> | " +
    "reward-status <socket> <claim-digest>";
  if (!socketPath) throw new Error(usage);
  let response;
  if (["sync", "produce"].includes(operation) && extra.length === 0) {
    response = await requestValidatorControl(socketPath, operation);
  } else if (operation === "stage-reward" && extra.length === 4) {
    const [claimPath, networkId, heightText, previousHash] = extra;
    if (!/^[1-9][0-9]*$/.test(heightText) ||
        !Number.isSafeInteger(Number(heightText))) throw new Error("expected height is invalid");
    const claim = readBoundedPublicJsonFile(claimPath, {
      label: "signed progress claim", maximumBytes: 48 * 1024,
    });
    response = await requestValidatorControl(socketPath, "stageRewardClaim", {
      claim, expectedHeight: Number(heightText), networkId, previousHash,
    });
  } else if (operation === "reward-status" && extra.length === 1) {
    response = await requestValidatorControl(socketPath, "rewardClaimStatus",
      { claimDigest: extra[0] });
  } else {
    throw new Error(usage);
  }
  console.log(JSON.stringify(response));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Validator control failed: ${error.message}`);
  process.exitCode = 1;
}
