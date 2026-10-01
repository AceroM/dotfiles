import { showHUD } from "@raycast/api";
import { quit, refreshMenuBar } from "./watcher";

export default async function Command() {
  await quit();
  await showHUD("Chrome remote debugging auto-allow quit");
  await refreshMenuBar();
}
