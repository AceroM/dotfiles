import { showHUD } from "@raycast/api";
import { isRunning, refreshMenuBar, start, stop } from "./watcher";

export default async function Command() {
  if (await isRunning()) {
    await stop();
    await showHUD("Chrome remote debugging auto-allow off");
  } else {
    await start();
    await showHUD("Chrome remote debugging auto-allow on");
  }
  await refreshMenuBar();
}
