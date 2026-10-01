import { useEffect, useState } from "react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Color, environment, Icon, LaunchType, MenuBarExtra, open, showToast, Toast } from "@raycast/api";
import { hasQuit, isRunning, LOG, quit, start } from "./watcher";

export default function Command() {
  const [running, setRunning] = useState<boolean>();
  const [quitting, setQuitting] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      if (environment.launchType === LaunchType.Background && (await hasQuit())) {
        setQuitting(true);
        return;
      }
      await start();
      setRunning(await isRunning());
    };
    initialize().catch(async (error: Error) => {
      setRunning(false);
      await showToast({ style: Toast.Style.Failure, title: "Could not start auto-allow", message: error.message });
    });
  }, []);

  if (quitting) return null;

  const quitApp = async () => {
    await quit();
    setQuitting(true);
  };

  const openLog = async () => {
    mkdirSync(dirname(LOG), { recursive: true });
    writeFileSync(LOG, "", { flag: "a" });
    await open(LOG, "com.apple.TextEdit");
  };

  return (
    <MenuBarExtra
      isLoading={running === undefined}
      icon={running ? { source: Icon.Bug, tintColor: Color.Green } : { source: Icon.Bug }}
      tooltip={running ? "Auto-allowing Chrome remote debugging" : "Chrome remote debugging auto-allow unavailable"}
    >
      <MenuBarExtra.Item
        title={
          running === undefined ? "Starting auto-allow…" : running ? "Auto-allow is on" : "Could not start auto-allow"
        }
      />
      <MenuBarExtra.Item title="Open Log" icon={Icon.Document} onAction={openLog} />
      <MenuBarExtra.Separator />
      <MenuBarExtra.Item title="Quit" icon={Icon.XMarkCircle} onAction={quitApp} />
    </MenuBarExtra>
  );
}
