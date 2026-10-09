// The background worker has no access to the decrypted recovery phrase.
const extensionApi = globalThis.browser ?? globalThis.chrome;
extensionApi.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    void extensionApi.tabs.create({ url: extensionApi.runtime.getURL("wallet.html") });
  }
});
