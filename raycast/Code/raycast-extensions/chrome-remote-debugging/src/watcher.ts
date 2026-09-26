import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { environment, getPreferenceValues, LaunchType, launchCommand } from "@raycast/api";

const execFileAsync = promisify(execFile);

const SCRIPT = join(homedir(), ".local/bin/allow-chrome-remote-debugging");
// Matches the script however it was started (Raycast or a terminal).
const PATTERN = "allow-chrome-remote-debugging";
export const LOG = join(environment.supportPath, "watcher.log");

// Call pgrep/pkill directly (no shell) so the pattern can't match our own `sh -c` wrapper.
export async function isRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-f", PATTERN]);
    return true;
  } catch {
    return false;
  }
}

export async function start(): Promise<void> {
  if (await isRunning()) return;
  const { interval } = getPreferenceValues<Preferences>();
  mkdirSync(environment.supportPath, { recursive: true });
  const log = openSync(LOG, "a");
  const child = spawn(SCRIPT, [interval?.trim() || "3"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export async function stop(): Promise<void> {
  try {
    await execFileAsync("/usr/bin/pkill", ["-f", PATTERN]);
  } catch {
    // pkill exits 1 when nothing matched.
  }
}

export async function refreshMenuBar(): Promise<void> {
  try {
    await launchCommand({ name: "status", type: LaunchType.Background });
  } catch {
    // Menu bar command not enabled.
  }
}
