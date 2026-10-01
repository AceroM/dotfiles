import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { environment, getPreferenceValues, LaunchType, launchCommand, LocalStorage } from "@raycast/api";

const execFileAsync = promisify(execFile);

const SCRIPT = join(homedir(), ".local/bin/allow-chrome-remote-debugging");
// Matches the script however it was started (Raycast or a terminal).
const PATTERN = "allow-chrome-remote-debugging";
export const LOG = join(environment.supportPath, "watcher.log");
const QUIT_KEY = "watcher-quit";

export async function hasQuit(): Promise<boolean> {
  return (await LocalStorage.getItem<boolean>(QUIT_KEY)) === true;
}

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
  await LocalStorage.removeItem(QUIT_KEY);
  if (await isRunning()) return;
  const { interval } = getPreferenceValues<Preferences>();
  mkdirSync(environment.supportPath, { recursive: true });
  const log = openSync(LOG, "a");
  try {
    const child = spawn(SCRIPT, [interval?.trim() || "3"], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export async function quit(): Promise<void> {
  await LocalStorage.setItem(QUIT_KEY, true);
  try {
    await execFileAsync("/usr/bin/pkill", ["-f", PATTERN]);
  } catch (error) {
    // pkill exits 1 when nothing matched.
    if ((error as { code?: number }).code !== 1) throw error;
  }
}

export async function refreshMenuBar(): Promise<void> {
  try {
    await launchCommand({ name: "status", type: LaunchType.Background });
  } catch {
    // Menu bar command not enabled.
  }
}
