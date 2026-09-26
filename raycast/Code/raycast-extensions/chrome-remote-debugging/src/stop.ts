import { showHUD } from "@raycast/api";
import { refreshMenuBar, stop } from "./watcher";

export default async function Command() {
  await stop();
  await showHUD("Chrome remote debugging auto-allow off");
  await refreshMenuBar();
}
