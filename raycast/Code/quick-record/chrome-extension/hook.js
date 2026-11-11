// Quick Record HAR: runs in the page's own world while a demo records, so it can see what the
// page's fetch/XHR calls get back. webRequest gives the extension every request but no response
// bodies; this fills those in for API calls. Bodies cross to relay.js as DOM events.
//
// Injected at most once per document; later injections only switch it back on.
(() => {
  const CONTROL = "quickrecord-har:control";
  const BODY = "quickrecord-har:body";
  if (window.__quickRecordHar) {
    window.__quickRecordHar.on = true;
    return;
  }
  const state = { on: true };
  Object.defineProperty(window, "__quickRecordHar", { value: state });
  document.addEventListener(CONTROL, (event) => {
    state.on = event.detail === "on";
  });

  const LIMIT = 1_000_000;
  const TEXTUAL = /json|text\/|xml|javascript|graphql|x-www-form-urlencoded|csv|yaml/i;

  function emit(record) {
    if (record.text.length > LIMIT) {
      record.text = record.text.slice(0, LIMIT);
      record.truncated = true;
    }
    try {
      document.dispatchEvent(new CustomEvent(BODY, { detail: JSON.stringify(record) }));
    } catch {}
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  }

  const fetch = window.fetch;
  if (typeof fetch === "function") {
    window.fetch = function (input, init) {
      const result = fetch.apply(this, arguments);
      if (!state.on) return result;
      const startedAt = Date.now();
      let method = "GET";
      let url = "";
      try {
        const request = input instanceof Request ? input : null;
        method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
        url = absolute(request ? request.url : (input?.href ?? input));
      } catch {
        return result;
      }
      result.then(
        (response) => {
          const type = response.headers.get("content-type") ?? "";
          if (!TEXTUAL.test(type) || /event-stream/i.test(type)) return;
          if (Number(response.headers.get("content-length") ?? 0) > LIMIT * 4) return;
          response
            .clone()
            .text()
            .then((text) => emit({ kind: "fetch", url: response.url || url, method, status: response.status, mimeType: type, text, startedAt }))
            .catch(() => {});
        },
        () => {},
      );
      return result;
    };
  }

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__quickRecordHar = { method: String(method).toUpperCase(), url: absolute(url) };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__quickRecordHar;
    if (info && state.on) {
      const startedAt = Date.now();
      this.addEventListener("loadend", () => {
        try {
          const type = this.getResponseHeader("content-type") ?? "";
          if (!TEXTUAL.test(type)) return;
          let text;
          if (this.responseType === "" || this.responseType === "text") text = this.responseText;
          else if (this.responseType === "json") text = JSON.stringify(this.response);
          else return;
          emit({ kind: "xhr", url: this.responseURL || info.url, method: info.method, status: this.status, mimeType: type, text, startedAt });
        } catch {}
      });
    }
    return send.apply(this, arguments);
  };
})();
