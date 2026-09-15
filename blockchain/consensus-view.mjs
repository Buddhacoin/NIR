export function selectHighestCertifiedProposal(groups, validatorCount) {
  if (!(groups instanceof Map) || !Number.isSafeInteger(validatorCount) || validatorCount < 4) {
    throw new Error("view-change inputs are invalid");
  }
  const eligible = [];
  for (const [hash, group] of groups) {
    const proposal = group?.proposal;
    const prepareCertificate = group?.prepareCertificate;
    if (!/^[0-9a-f]{64}$/.test(hash) || !proposal ||
        !Number.isSafeInteger(proposal.round) || proposal.round < 0 ||
        !Array.isArray(prepareCertificate) || group.certified !== true ||
        !Number.isSafeInteger(group.count) ||
        group.count < 1 || group.count > validatorCount) {
      throw new Error("view-change lock group is invalid");
    }
    // Every group reaches this selector only after its prepare quorum and the
    // reporting validator's commit vote have been cryptographically verified.
    eligible.push({ count: group.count, hash, prepareCertificate, proposal });
  }
  if (eligible.length === 0) return null;
  const highestRound = Math.max(...eligible.map(({ proposal }) => proposal.round));
  const highest = eligible.filter(({ proposal }) => proposal.round === highestRound);
  if (highest.length > 1) {
    throw new Error("conflicting values carry the same highest view certificate");
  }
  return structuredClone({
    prepareCertificate: highest[0].prepareCertificate,
    proposal: highest[0].proposal,
  });
}
