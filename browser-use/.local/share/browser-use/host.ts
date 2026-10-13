// Native messaging host. The browser launches this (one per browser process) when the extension
// calls connectNative, and kills it when the extension disconnects. It relays newline-delimited
// JSON requests from `browser-use` CLI clients on a unix socket to the extension over the native
// messaging stdio framing (4-byte little-endian length + JSON), and routes responses back.
//
// Nothing may be written to stdout except framed messages; diagnostics go to host.log.

import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { HOSTS_DIR, LOG_FILE, STATE_DIR } from "./paths.ts";

mkdirSync(HOSTS_DIR, { recursive: true });
const sockPath = `${HOSTS_DIR}/${process.pid}.sock`;
const metaPath = `${HOSTS_DIR}/${process.pid}.json`;

function log(...parts: unknown[]) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${parts.join(" ")}\n`);
  } catch {}
}

// ------------------------------------------------------------ extension side (stdio)

function sendToExtension(msg: unknown) {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

const pending = new Map<string, net.Socket>();
let seq = 0;

let inbuf = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const raw = inbuf.subarray(4, 4 + len).toString("utf8");
    inbuf = inbuf.subarray(4 + len);
    try {
      onExtensionMessage(JSON.parse(raw));
    } catch (e) {
      log("bad message from extension:", e);
    }
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

function onExtensionMessage(msg: any) {
  if (msg.type === "hello") {
    writeFileSync(
      metaPath,
      JSON.stringify({ pid: process.pid, socket: sockPath, browser: msg.browser, version: msg.version, started: Date.now() }),
    );
    log("hello from", msg.browser, msg.version);
    return;
  }
  if (msg.type === "response") {
    const client = pending.get(msg.id);
    pending.delete(msg.id);
    if (client && !client.destroyed) client.write(JSON.stringify(msg) + "\n");
  }
}

// ------------------------------------------------------------ CLI side (unix socket)

try {
  unlinkSync(sockPath);
} catch {}

const server = net.createServer((client) => {
  let buf = "";
  client.setEncoding("utf8");
  client.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req: any;
      try {
        req = JSON.parse(line);
      } catch {
        client.write(JSON.stringify({ error: "invalid JSON request" }) + "\n");
        continue;
      }
      const id = `${process.pid}-${++seq}`;
      pending.set(id, client);
      sendToExtension({ type: "request", id, cmd: req.cmd, args: req.args ?? {}, owner: req.owner });
    }
  });
  client.on("close", () => {
    for (const [id, c] of pending) if (c === client) pending.delete(id);
  });
  client.on("error", () => {});
});
server.listen(sockPath, () => log("listening on", sockPath, "state", STATE_DIR));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  log("extension disconnected; exiting");
  server.close();
  for (const p of [sockPath, metaPath]) {
    try {
      unlinkSync(p);
    } catch {}
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
