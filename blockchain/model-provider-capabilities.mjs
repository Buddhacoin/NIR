// Descriptive onboarding only. No provider API calls, credentials, or execution.
export const PROVIDERS = Object.freeze([
  Object.freeze({ id: "open-weight", label: "Open-weight model", kind: "local-files", executable: false }),
  Object.freeze({ id: "openai-api", label: "OpenAI API (ChatGPT models)", kind: "remote-api", executable: false }),
  Object.freeze({ id: "anthropic-api", label: "Anthropic API (Claude models)", kind: "remote-api", executable: false }),
  Object.freeze({ id: "google-api", label: "Google AI API (Gemini models)", kind: "remote-api", executable: false }),
]);

function looksLikeSecret(value) {
  return /(?:^|[/.:_-])sk-/i.test(value) || /^AIza/i.test(value) ||
    /^Bearer/i.test(value) || /[A-Za-z0-9_-]{32,}/.test(value);
}

export function createCapabilityDeclaration(input) {
  if (!input || Object.keys(input).sort().join(",") !== "modelId,provider" ||
      typeof input.provider !== "string" || typeof input.modelId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(input.modelId) ||
      input.modelId.includes("..") || input.modelId.includes("://") ||
      looksLikeSecret(input.modelId))
    throw new Error("Invalid model identifier");
  const selected = PROVIDERS.find((entry) => entry.id === input.provider);
  if (!selected) throw new Error("Unknown provider");
  return {
    format: "nir-operator-capability-intent-v1", scope: "operator-capability-intent-only",
    provider: selected.id, providerKind: selected.kind, modelId: input.modelId,
    modelExecuted: false, independentlyVerified: false, networkSubmitted: false,
    rewardEligible: false, walletChanged: false,
  };
}
