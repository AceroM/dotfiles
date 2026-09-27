#!/usr/bin/env bun

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  render,
  Box,
  Text,
  useApp,
  useInput,
  useStdout,
} from "@dotfiles/opentui-cli";
import {
  ACCESS_MODES,
  DEFAULT_CONFIG,
  PROFILE_NAMES,
  codexArgs,
  commandPreview,
  configPath,
  isProfileName,
  loadConfig,
  normalizeConfig,
  resetProfile,
  saveConfig,
  type AgentConfig,
  type Profile,
  type ProfileName,
} from "./config";
import {
  loadModelCatalog,
  normalizeReasoningForModel,
  reasoningEffortsFor,
  type ModelOption,
} from "./models";

type EditableField = "model" | "reasoning" | "access";
const EDITABLE_FIELDS: EditableField[] = ["model", "reasoning", "access"];

function profileLine(name: ProfileName, profile: Profile): string {
  return [
    name.padEnd(4),
    profile.label.padEnd(8),
    profile.model.padEnd(15),
    profile.reasoning.padEnd(7),
    profile.access,
  ].join("  ");
}

function Header() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="brightWhite" bold>
        AGENT CONFIG
      </Text>
      <Text dimColor>Codex launch profiles.</Text>
    </Box>
  );
}

function ProfileRow({
  name,
  profile,
  active,
  compact,
  onSelect,
}: {
  name: ProfileName;
  profile: Profile;
  active: boolean;
  compact: boolean;
  onSelect: () => void;
}) {
  if (compact) {
    return (
      <Box
        flexDirection="column"
        backgroundColor={active ? "selected" : undefined}
        paddingX={1}
        onMouseUp={onSelect}
      >
        <Text color={active ? "brightWhite" : undefined} bold={active}>
          {active ? ">" : " "} {name} · {profile.label}
        </Text>
        <Text dimColor={!active}>
          {"  "}
          {profile.model} · {profile.reasoning} · {profile.access}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      backgroundColor={active ? "selected" : undefined}
      paddingX={1}
      onMouseUp={onSelect}
    >
      <Text color={active ? "brightWhite" : undefined} bold={active}>
        {active ? ">" : " "} {profileLine(name, profile)}
      </Text>
    </Box>
  );
}

function FieldRow({
  label,
  value,
  active,
  onSelect,
}: {
  label: string;
  value: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      backgroundColor={active ? "selected" : undefined}
      paddingX={1}
      onMouseUp={onSelect}
    >
      <Text color={active ? "brightWhite" : undefined} bold={active}>
        {active ? ">" : " "} {label.padEnd(11)} {value}  ›
      </Text>
    </Box>
  );
}

function ChoiceRow({
  value,
  active,
  current,
  onSelect,
}: {
  value: string;
  active: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      backgroundColor={active ? "selected" : undefined}
      paddingX={1}
      onMouseUp={onSelect}
    >
      <Text color={active ? "brightWhite" : undefined} bold={active}>
        {active ? ">" : " "} {current ? "●" : "○"} {value}
      </Text>
    </Box>
  );
}

function Key({ children }: { children: string }) {
  return <Text color="cyan">{children}</Text>;
}

function MainFooter({ status }: { status: string | null }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {status ? <Text color="green">{status}</Text> : null}
      <Text dimColor>
        <Key>↑↓</Key> navigate <Key>enter</Key> edit <Key>r</Key> reset{" "}
        <Key>q</Key> quit
      </Text>
    </Box>
  );
}

function EditorFooter({ dirty }: { dirty: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {dirty ? <Text color="yellow">Unsaved changes.</Text> : null}
      <Text dimColor>
        <Key>↑↓</Key> field <Key>enter</Key> select <Key>s</Key> save{" "}
        <Key>esc</Key> cancel
      </Text>
    </Box>
  );
}

function ChoiceFooter() {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        <Key>↑↓</Key> navigate <Key>enter</Key> choose <Key>esc</Key> back
      </Text>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const compact = (stdout?.columns ?? 80) < 66;

  const [config, setConfig] = useState<AgentConfig>(() =>
    normalizeConfig(DEFAULT_CONFIG),
  );
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const [editing, setEditing] = useState<ProfileName | null>(null);
  const [field, setField] = useState(0);
  const fieldRef = useRef(0);
  const [choosing, setChoosing] = useState<EditableField | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const choiceIndexRef = useRef(0);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [original, setOriginal] = useState<Profile | null>(null);

  useEffect(() => {
    Promise.all([loadConfig(), loadModelCatalog()])
      .then(([loadedConfig, loadedCatalog]) => {
        setConfig(loadedConfig);
        setCatalog(loadedCatalog);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);

  const beginEdit = useCallback(
    (name: ProfileName) => {
      const profile = structuredClone(config.profiles[name]);
      setEditing(name);
      setDraft(profile);
      setOriginal(structuredClone(profile));
      setField(0);
      fieldRef.current = 0;
      setChoosing(null);
      setStatus(null);
    },
    [config],
  );

  const choicesFor = useCallback(
    (selectedField: EditableField, profile: Profile): string[] => {
      if (selectedField === "model")
        return [...new Set([...catalog.map((option) => option.model), profile.model])];
      if (selectedField === "reasoning")
        return [...reasoningEffortsFor(catalog, profile.model, profile.reasoning)];
      return [...ACCESS_MODES];
    },
    [catalog],
  );

  const beginChoice = useCallback(
    (index: number) => {
      if (!draft) return;
      const selectedField = EDITABLE_FIELDS[index];
      const choices = choicesFor(selectedField, draft);
      const selectedIndex = Math.max(0, choices.indexOf(draft[selectedField]));
      fieldRef.current = index;
      setField(index);
      choiceIndexRef.current = selectedIndex;
      setChoiceIndex(selectedIndex);
      setChoosing(selectedField);
    },
    [choicesFor, draft],
  );

  const chooseValue = useCallback(
    (selectedField: EditableField, value: string) => {
      setDraft((current) => {
        if (!current) return current;
        const next = structuredClone(current);
        if (selectedField === "model") {
          next.model = value;
          next.reasoning = normalizeReasoningForModel(
            catalog,
            value,
            next.reasoning,
          );
        } else if (selectedField === "reasoning") {
          next.reasoning = value;
        } else if (value === "yolo" || value === "standard") {
          next.access = value;
        }
        return next;
      });
      setChoosing(null);
    },
    [catalog],
  );

  const persistDraft = useCallback(async () => {
    if (!editing || !draft) return;
    const next = structuredClone(config);
    next.profiles[editing] = structuredClone(draft);
    setConfig(next);
    setStatus("Saving…");
    try {
      await saveConfig(next);
      setStatus(`${editing} saved.`);
      setEditing(null);
      setDraft(null);
      setOriginal(null);
    } catch (cause) {
      setStatus(null);
      setError((cause as Error).message);
    }
  }, [config, draft, editing]);

  const resetSelected = useCallback(async () => {
    const name = PROFILE_NAMES[selectedRef.current];
    const next = structuredClone(config);
    next.profiles[name] = resetProfile(name);
    setConfig(next);
    setStatus("Saving…");
    try {
      await saveConfig(next);
      setStatus(`${name} reset to its default.`);
    } catch (cause) {
      setStatus(null);
      setError((cause as Error).message);
    }
  }, [config]);

  useInput((input, key) => {
    if (loading) return;

    if (error) {
      if (input === "q" || key.escape) exit();
      return;
    }

    if (editing && choosing && draft) {
      const choices = choicesFor(choosing, draft);
      if (key.escape) {
        setChoosing(null);
      } else if (key.upArrow || input === "k") {
        choiceIndexRef.current = Math.max(0, choiceIndexRef.current - 1);
        setChoiceIndex(choiceIndexRef.current);
      } else if (key.downArrow || input === "j") {
        choiceIndexRef.current = Math.min(
          choices.length - 1,
          choiceIndexRef.current + 1,
        );
        setChoiceIndex(choiceIndexRef.current);
      } else if (key.return) {
        chooseValue(choosing, choices[choiceIndexRef.current]);
      }
      return;
    }

    if (editing) {
      if (key.escape) {
        setEditing(null);
        setDraft(null);
        setOriginal(null);
      } else if (key.upArrow || input === "k") {
        fieldRef.current = Math.max(0, fieldRef.current - 1);
        setField(fieldRef.current);
      } else if (key.downArrow || input === "j") {
        fieldRef.current = Math.min(
          EDITABLE_FIELDS.length - 1,
          fieldRef.current + 1,
        );
        setField(fieldRef.current);
      } else if (key.rightArrow || input === "l" || key.return) {
        beginChoice(fieldRef.current);
      } else if (input === "s") {
        void persistDraft();
      } else if (input === "r") {
        setDraft(resetProfile(editing));
      }
      return;
    }

    if (input === "q" || key.escape) {
      exit();
    } else if (key.upArrow || input === "k") {
      selectedRef.current = Math.max(0, selectedRef.current - 1);
      setSelected(selectedRef.current);
      setStatus(null);
    } else if (key.downArrow || input === "j") {
      selectedRef.current = Math.min(
        PROFILE_NAMES.length - 1,
        selectedRef.current + 1,
      );
      setSelected(selectedRef.current);
      setStatus(null);
    } else if (key.return) {
      beginEdit(PROFILE_NAMES[selectedRef.current]);
    } else if (input === "r") {
      void resetSelected();
    } else if (/^[1-9]$/.test(input) && Number(input) <= PROFILE_NAMES.length) {
      const index = Number(input) - 1;
      selectedRef.current = index;
      setSelected(index);
      beginEdit(PROFILE_NAMES[index]);
    }
  });

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  if (loading) {
    return (
      <Box key="loading" flexDirection="column" padding={1}>
        <Header />
        <Text>Loading profiles…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box key="error" flexDirection="column" padding={1}>
        <Header />
        <Text color="red">Could not load agent config: {error}</Text>
        <Text dimColor>Press q to quit.</Text>
      </Box>
    );
  }

  if (editing && choosing && draft) {
    const choices = choicesFor(choosing, draft);
    return (
      <Box key="choices" flexDirection="column" padding={1}>
        <Header />
        <Box flexDirection="column" marginBottom={1}>
          <Text color="brightWhite" bold>
            {editing} · {draft.label} · {choosing}
          </Text>
          <Text dimColor>Choose a value.</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="border" padding={1}>
          {choices.map((value, index) => (
            <ChoiceRow
              key={value}
              value={value}
              active={choiceIndex === index}
              current={draft[choosing] === value}
              onSelect={() => chooseValue(choosing, value)}
            />
          ))}
        </Box>
        <ChoiceFooter />
      </Box>
    );
  }

  if (editing && draft) {
    return (
      <Box key="editor" flexDirection="column" padding={1}>
        <Header />
        <Box flexDirection="column" marginBottom={1}>
          <Text color="brightWhite" bold>
            {editing} · {draft.label}
          </Text>
          <Text dimColor>Choose how this profile starts Codex.</Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="border"
          padding={1}
        >
          <FieldRow
            label="Model"
            value={draft.model}
            active={field === 0}
            onSelect={() => beginChoice(0)}
          />
          <FieldRow
            label="Reasoning"
            value={draft.reasoning}
            active={field === 1}
            onSelect={() => beginChoice(1)}
          />
          <FieldRow
            label="Access"
            value={draft.access}
            active={field === 2}
            onSelect={() => beginChoice(2)}
          />
        </Box>

        {draft.access === "yolo" ? (
          <Box marginTop={1}>
            <Text color="yellow">Yolo bypasses approvals and sandboxing.</Text>
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Command preview.</Text>
          <Text color="cyan" wrap="truncate-end">
            {commandPreview(draft)}
          </Text>
        </Box>

        <EditorFooter dirty={dirty} />
      </Box>
    );
  }

  return (
    <Box key="profiles" flexDirection="column" padding={1}>
      <Header />
      {!compact ? (
        <Box paddingX={1} marginBottom={1}>
          <Text dimColor>
            {"  "}
            {"NAME".padEnd(4)} {"PROFILE".padEnd(8)} {"MODEL".padEnd(15)}{" "}
            {"EFFORT".padEnd(7)} ACCESS
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {PROFILE_NAMES.map((name, index) => (
          <ProfileRow
            key={name}
            name={name}
            profile={config.profiles[name]}
            active={selected === index}
            compact={compact}
            onSelect={() => {
              selectedRef.current = index;
              setSelected(index);
              beginEdit(name);
            }}
          />
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Selected command.</Text>
        <Text color="cyan" wrap="truncate-end">
          {commandPreview(config.profiles[PROFILE_NAMES[selected]])}
        </Text>
      </Box>

      <MainFooter status={status} />
    </Box>
  );
}

function printHelp(): void {
  console.log(`Agent config for Codex launch profiles.

Usage:
  ac                  Open the profile editor
  ac show             Print the resolved profiles
  ac path             Print the config file path
  ac run <profile>    Launch Codex with ${PROFILE_NAMES.join(", ")}
  ac --help           Show this help`);
}

async function runCodex(args: string[]): Promise<never> {
  const name = args[0];
  if (!name || !isProfileName(name)) {
    console.error(`ac: expected a profile: ${PROFILE_NAMES.join(", ")}`);
    process.exit(2);
  }

  const config = await loadConfig();
  const forwarded = args.slice(1);
  if (forwarded[0] === "--") forwarded.shift();

  const child = Bun.spawn(
    ["codex", ...codexArgs(config.profiles[name]), ...forwarded],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await child.exited);
}

async function showProfiles(): Promise<void> {
  const config = await loadConfig();
  for (const name of PROFILE_NAMES) {
    console.log(profileLine(name, config.profiles[name]));
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
} else if (command === "show") {
  await showProfiles();
} else if (command === "path") {
  console.log(configPath());
} else if (command === "run") {
  await runCodex(args);
} else if (command) {
  console.error(`ac: unknown command: ${command}`);
  printHelp();
  process.exit(2);
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "ac requires an interactive terminal. Use 'ac show' for text output.",
    );
    process.exit(1);
  }
  await (await render(<App />)).waitUntilExit();
}
