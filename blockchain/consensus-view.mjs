export function selectHighestCertifiedProposal(groups, validatorCount) {
  if (!(groups instanceof Map) || !Number.isSafeInteger(validatorCount) || validatorCount < 4) {
    throw new Error("view-change inputs are invalid");
  }
  const quorum = Math.floor((validatorCount * 2) / 3) + 1;
  const roundZeroThreshold = validatorCount - quorum + 1;
  const eligible = [];
  for (const [hash, group] of groups) {
    const proposal = group?.proposal;
    if (!/^[0-9a-f]{64}$/.test(hash) || !proposal ||
        !Number.isSafeInteger(proposal.round) || proposal.round < 0 ||
        !Number.isSafeInteger(group.count) || group.count < 1 || group.count > validatorCount) {
      throw new Error("view-change lock group is invalid");
    }
    // A later-round proposal already embeds a validator-quorum timeout
    // certificate, verified before this selector is called. Round zero has no
    // embedded certificate and therefore needs an intersection-sized set of
    // independently signed lock reports.
    if (proposal.round > 0 || group.count >= roundZeroThreshold) {
      eligible.push({ count: group.count, hash, proposal });
    }
  }
  if (eligible.length === 0) return null;
  const highestRound = Math.max(...eligible.map(({ proposal }) => proposal.round));
  const highest = eligible.filter(({ proposal }) => proposal.round === highestRound);
  if (highest.length > 1) {
    throw new Error("conflicting values carry the same highest view certificate");
  }
  return structuredClone(highest[0].proposal);
}
