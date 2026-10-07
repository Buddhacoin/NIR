chrome.action.onClicked.addListener(() => {
  // A browser-action popup is destroyed when the user focuses Terminal to approve a signature.
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
