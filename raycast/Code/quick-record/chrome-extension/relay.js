// Quick Record HAR: the content-script half of hook.js. The page's world can't reach the
// extension, so hook.js fires DOM events and this passes their bodies to the service worker, and
// passes the worker's on/off back to the hook.
(() => {
  const CONTROL = "quickrecord-har:control";
  const BODY = "quickrecord-har:body";
  const control = (on) => document.dispatchEvent(new CustomEvent(CONTROL, { detail: on ? "on" : "off" }));
  if (globalThis.__quickRecordHarRelay) {
    control(true);
    return;
  }
  globalThis.__quickRecordHarRelay = true;
  document.addEventListener(BODY, (event) => {
    try {
      chrome.runtime.sendMessage({ type: "har-body", record: JSON.parse(event.detail) }).catch(() => {});
    } catch {}
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "har-control") control(message.on);
  });
})();
