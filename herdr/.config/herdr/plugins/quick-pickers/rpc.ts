import { createConnection } from "node:net";
import { homedir } from "node:os";

const socketPath = process.env.HERDR_SOCKET_PATH || `${homedir()}/.config/herdr/herdr.sock`;
let requestNumber = 0;

export class RpcTransportError extends Error {
  readonly mayHaveExecuted: boolean;

  constructor(message: string, mayHaveExecuted: boolean) {
    super(message);
    this.name = "RpcTransportError";
    this.mayHaveExecuted = mayHaveExecuted;
  }
}

// Keep picker actions on the socket instead of paying for a CLI process per call.
export function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let sent = false;
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    }
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => fail(new RpcTransportError(`${method} timed out`, sent)));
    socket.on("connect", () => {
      // Once a request enters the socket, a missing reply cannot prove that the
      // server skipped it. Keep this separate from explicit API rejections.
      sent = true;
      socket.write(`${JSON.stringify({ id: `quick-picker-${process.pid}-${++requestNumber}`, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0 || settled) return;
      try {
        const response = JSON.parse(buffer.slice(0, end)) as { result?: T; error?: { message?: string } };
        if (response.error) {
          fail(new Error(response.error.message || `${method} failed`));
        } else if (!Object.hasOwn(response, "result")) {
          fail(new RpcTransportError(`Herdr returned no result for ${method}`, sent));
        } else {
          settled = true;
          socket.destroy();
          resolve(response.result as T);
        }
      } catch {
        fail(new RpcTransportError(`Herdr returned an invalid response for ${method}`, sent));
      }
    });
    socket.on("error", (error) => fail(new RpcTransportError(error.message, sent)));
    socket.on("close", () => fail(new RpcTransportError(`Herdr disconnected during ${method}`, sent)));
  });
}
