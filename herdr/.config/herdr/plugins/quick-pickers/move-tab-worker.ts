import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveTab, MoveTabError } from "./move-tab";
import { call } from "./rpc";

type ErrorDetails = {
  recoveredTabId?: string;
  sourceWorkspaceId?: string;
  movedTabId?: string;
  destinationWorkspaceId?: string;
  partial: boolean;
};
type WorkerResult = { tabId: string } | { error: { message: string; details: ErrorDetails } };
const pidfile = `${homedir()}/.cache/herdr-quick-picker.pid`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownBusyMarker(pid: number): void {
  mkdirSync(dirname(pidfile), { recursive: true });
  const pending = `${pidfile}.${process.pid}.${pid}.tmp`;
  try {
    writeFileSync(pending, `${pid} move busy\n`, { mode: 0o600 });
    renameSync(pending, pidfile);
  } finally {
    rmSync(pending, { force: true });
  }
}

function clearBusyMarker(pid: number): void {
  try {
    if (readFileSync(pidfile, "utf8").trim().split(/\s+/u)[0] === String(pid)) rmSync(pidfile, { force: true });
  } catch {}
}

function cleanResult(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
}

function serializeFailure(error: unknown): WorkerResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      message,
      details: error instanceof MoveTabError ? {
        recoveredTabId: error.recoveredTabId,
        sourceWorkspaceId: error.sourceWorkspaceId,
        movedTabId: error.movedTabId,
        destinationWorkspaceId: error.destinationWorkspaceId,
        partial: error.partial,
      } : { partial: false },
    },
  };
}

async function reportFailure(result: WorkerResult): Promise<void> {
  if (!("error" in result)) return;
  try {
    writeFileSync(`${homedir()}/.cache/herdr-tab-move-error.log`, `${new Date().toISOString()} ${result.error.message}\n`, { mode: 0o600 });
  } catch {}
  try {
    await call("notification.show", { title: "Tab move failed", body: result.error.message, sound: "request" });
  } catch {}
}

async function run(sourceTabId: string, destinationId: string, parentPid: number, directory: string): Promise<void> {
  let result: WorkerResult;
  try {
    ownBusyMarker(process.pid);
    try {
      result = { tabId: await moveTab(call, sourceTabId, destinationId) };
    } catch (error) {
      result = serializeFailure(error);
    }

    let consumed = false;
    if (alive(parentPid)) {
      try {
        const pending = join(directory, "result.tmp");
        writeFileSync(pending, JSON.stringify(result), { mode: 0o600 });
        renameSync(pending, join(directory, "result.json"));
        // A live picker consumes the result; a removed owner tab kills it. Either
        // outcome releases this handshake and removes its temporary directory.
        for (let i = 0; i < 100 && alive(parentPid); i += 1) {
          if (!existsSync(directory)) {
            consumed = true;
            break;
          }
          await Bun.sleep(50);
        }
      } catch {}
    }
    if (!consumed && !alive(parentPid)) await reportFailure(result);
  } catch (error) {
    if (!alive(parentPid)) await reportFailure(serializeFailure(error));
  } finally {
    clearBusyMarker(process.pid);
    cleanResult(directory);
  }
}

/** A popup belongs to the source tab and dies when its last pane moves away. */
export async function moveTabInWorker(sourceTabId: string, destinationId: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "herdr-tab-move-"));
  let childPid: number | undefined;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", sourceTabId, destinationId, String(process.pid), directory], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    childPid = child.pid;
    if (!childPid) throw new Error("Could not start the tab move worker");
    // Own the busy guard immediately; the popup can disappear during the first
    // move, while the detached process still has focus/zoom work to finish.
    ownBusyMarker(childPid);
    let childError: Error | undefined;
    let childExited = false;
    child.once("error", (error) => { childError = error; });
    child.once("exit", () => { childExited = true; });
    child.unref();
    while (true) {
      const resultFile = join(directory, "result.json");
      if (existsSync(resultFile)) {
        const result = JSON.parse(readFileSync(resultFile, "utf8")) as WorkerResult;
        if ("error" in result) throw new MoveTabError(result.error.message, result.error.details);
        return result.tabId;
      }
      if (childError) throw childError;
      if (childExited || !alive(childPid)) {
        throw new MoveTabError("Tab move worker stopped before reporting its result; inspect the source and destination spaces", { partial: true, destinationWorkspaceId: destinationId });
      }
      await Bun.sleep(25);
    }
  } catch (error) {
    if (error instanceof MoveTabError) throw error;
    throw new MoveTabError(error instanceof Error ? error.message : String(error), {
      partial: childPid !== undefined,
      destinationWorkspaceId: destinationId,
    });
  } finally {
    cleanResult(directory);
    // A running child owns this marker until transfer completion, even if the
    // picker closes. Leave it intact while that process is still alive.
    if (childPid && !alive(childPid)) clearBusyMarker(childPid);
  }
}

if (import.meta.main && process.argv[2] === "--run") {
  await run(process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6]);
}
