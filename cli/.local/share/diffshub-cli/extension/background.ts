// Background service worker — the only job it has is the screenshotter.
//
// chrome.tabs.captureVisibleTab can't be called from a content script (it only
// runs off an extension page), so the composer's `s` screenshot tool messages us
// instead: it hides the diffshub UI, asks us to grab the visible tab, then crops
// the returned PNG to the dragged region itself. We just hand back the full
// viewport as a data URL (or an error string). Needs the <all_urls> host
// permission, which the manifest grants.

// Minimal ambient — Bun.build doesn't type-check, this is just for editor sanity.
declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        cb: (
          message: { type?: string } | undefined,
          sender: unknown,
          sendResponse: (response: { dataUrl?: string; error?: string }) => void,
        ) => boolean | void,
      ): void;
    };
  };
  tabs: { captureVisibleTab(options: { format: "png" | "jpeg" }): Promise<string> };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "diffshub-capture") return;
  chrome.tabs.captureVisibleTab({ format: "png" }).then(
    (dataUrl) => sendResponse({ dataUrl }),
    (err: unknown) => sendResponse({ error: String((err as { message?: string })?.message ?? err) }),
  );
  return true; // keep the message channel open for the async sendResponse
});
