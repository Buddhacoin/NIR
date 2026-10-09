// The background worker has no access to the decrypted recovery phrase.
(globalThis.browser ?? globalThis.chrome).runtime.onInstalled.addListener(() => {});
