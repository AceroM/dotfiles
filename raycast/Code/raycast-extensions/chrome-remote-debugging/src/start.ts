import { showHUD } from "@raycast/api";
import { refreshMenuBar, start } from "./watcher";

export default async function Command() {
  await start();
  await showHUD("Chrome remote debugging auto-allow on");
  await refreshMenuBar();
}
