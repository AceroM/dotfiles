import { useEffect, useState } from "react";
import { Color, getPreferenceValues, Icon, MenuBarExtra, open } from "@raycast/api";
import { isRunning, LOG, start, stop } from "./watcher";

export default function Command() {
  const [running, setRunning] = useState<boolean>();
  const { hideWhenInactive } = getPreferenceValues<Preferences>();

  useEffect(() => {
    isRunning().then(setRunning);
  }, []);

  if (running === false && hideWhenInactive) return null;

  const toggle = async () => {
    if (running) await stop();
    else await start();
    setRunning(await isRunning());
  };

  return (
    <MenuBarExtra
      isLoading={running === undefined}
      icon={running ? { source: Icon.Bug, tintColor: Color.Green } : { source: Icon.Bug }}
      tooltip={running ? "Auto-allowing Chrome remote debugging" : "Chrome remote debugging auto-allow off"}
    >
      <MenuBarExtra.Item title={running ? "Auto-allow is on" : "Auto-allow is off"} />
      <MenuBarExtra.Item title={running ? "Stop" : "Start"} icon={running ? Icon.Stop : Icon.Play} onAction={toggle} />
      <MenuBarExtra.Item title="Open Log" icon={Icon.Document} onAction={() => open(LOG)} />
    </MenuBarExtra>
  );
}
