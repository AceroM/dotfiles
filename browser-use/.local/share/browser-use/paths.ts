import { homedir } from "node:os";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";

export const HOST_NAME = "dev.dotfiles.browser_use";
export const EXTENSION_ID = "aneibjcaiaipkjajpalppgijoekiedko";

export const STATE_DIR = `${process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`}/browser-use`;
export const HOSTS_DIR = `${STATE_DIR}/hosts`;
export const LOG_FILE = `${STATE_DIR}/host.log`;

// Real source dir (Bun resolves the stow symlink, so this lands in ~/.dotfiles/browser-use/...).
export const SRC_DIR = dirname(realpathSync(new URL(import.meta.url).pathname));
export const EXTENSION_DIR = `${SRC_DIR}/extension`;

// Where each Chromium-family browser looks for per-user native messaging manifests on macOS.
const APP_SUPPORT = `${homedir()}/Library/Application Support`;
export const BROWSERS: Record<string, string> = {
  chrome: `${APP_SUPPORT}/Google/Chrome`,
  "chrome-canary": `${APP_SUPPORT}/Google/Chrome Canary`,
  chromium: `${APP_SUPPORT}/Chromium`,
  helium: `${APP_SUPPORT}/net.imput.helium`,
  brave: `${APP_SUPPORT}/BraveSoftware/Brave-Browser`,
  arc: `${APP_SUPPORT}/Arc/User Data`,
};
