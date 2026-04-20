#!/usr/bin/env bun

import { readdir, readFile, mkdir, copyFile, cp } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";

const SKILLS_DIR =
  "/Users/miguel/Documents/Obsidian/miguel-remote/Agents/Skills";
const TARGET_DIR = "./.claude/skills";

interface Skill {
  name: string;
  description: string;
  sourcePath: string;
  isFolder: boolean;
}

async function parseFrontmatter(
  content: string,
): Promise<{ name?: string; description?: string }> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return {};

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return frontmatter;
}

async function discoverSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(SKILLS_DIR, entry.name);

    if (entry.isDirectory()) {
      const skillFile = join(fullPath, "SKILL.md");
      if (existsSync(skillFile)) {
        const content = await readFile(skillFile, "utf-8");
        const { name, description } = await parseFrontmatter(content);
        if (name) {
          skills.push({
            name,
            description: description || "",
            sourcePath: fullPath,
            isFolder: true,
          });
        }
      }
    } else if (entry.name.endsWith(".md")) {
      const content = await readFile(fullPath, "utf-8");
      const { name, description } = await parseFrontmatter(content);
      if (name) {
        skills.push({
          name,
          description: description || "",
          sourcePath: fullPath,
          isFolder: false,
        });
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function installSkill(skill: Skill): Promise<void> {
  const targetSkillDir = join(TARGET_DIR, skill.name);

  await mkdir(targetSkillDir, { recursive: true });

  if (skill.isFolder) {
    // Copy the entire folder contents
    const entries = await readdir(skill.sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(skill.sourcePath, entry.name);
      const destPath = join(targetSkillDir, entry.name);

      if (entry.isDirectory()) {
        await cp(srcPath, destPath, { recursive: true });
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  } else {
    // Copy single markdown file as SKILL.md
    await copyFile(skill.sourcePath, join(targetSkillDir, "SKILL.md"));
  }
}

// Terminal UI helpers
const ESC = "\x1b";
const CSI = `${ESC}[`;

const term = {
  clear: () => process.stdout.write(`${CSI}2J${CSI}H`),
  moveTo: (row: number, col: number) =>
    process.stdout.write(`${CSI}${row};${col}H`),
  clearLine: () => process.stdout.write(`${CSI}2K`),
  hideCursor: () => process.stdout.write(`${CSI}?25l`),
  showCursor: () => process.stdout.write(`${CSI}?25h`),
  bold: (text: string) => `${CSI}1m${text}${CSI}0m`,
  dim: (text: string) => `${CSI}2m${text}${CSI}0m`,
  green: (text: string) => `${CSI}32m${text}${CSI}0m`,
  cyan: (text: string) => `${CSI}36m${text}${CSI}0m`,
  yellow: (text: string) => `${CSI}33m${text}${CSI}0m`,
  inverse: (text: string) => `${CSI}7m${text}${CSI}0m`,
};

async function interactiveSelect(skills: Skill[]): Promise<Skill[]> {
  const selected = new Set<number>();
  let cursor = 0;
  let searchQuery = "";
  let filteredIndices: number[] = skills.map((_, i) => i);
  let scrollOffset = 0;

  const getTerminalHeight = () => process.stdout.rows || 24;
  const getVisibleCount = () => Math.max(1, getTerminalHeight() - 8);

  const filterSkills = () => {
    const query = searchQuery.toLowerCase();
    filteredIndices = skills
      .map((skill, i) => ({ skill, i }))
      .filter(
        ({ skill }) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      )
      .map(({ i }) => i);

    if (cursor >= filteredIndices.length) {
      cursor = Math.max(0, filteredIndices.length - 1);
    }
    scrollOffset = 0;
  };

  const render = () => {
    term.clear();
    term.moveTo(1, 1);

    console.log(term.bold(term.cyan("🎯 Add Claude Skills")));
    console.log(
      term.dim("Navigate: ↑/↓  Toggle: Space  Confirm: Enter  Quit: q/Esc\n"),
    );

    console.log(
      `${term.yellow("Search:")} ${searchQuery}${term.inverse(" ")}\n`,
    );

    const visibleCount = getVisibleCount();

    if (cursor < scrollOffset) {
      scrollOffset = cursor;
    } else if (cursor >= scrollOffset + visibleCount) {
      scrollOffset = cursor - visibleCount + 1;
    }

    const currentScrollOffset = scrollOffset;
    const currentCursor = cursor;

    const visibleItems = filteredIndices.slice(
      currentScrollOffset,
      currentScrollOffset + visibleCount,
    );

    if (filteredIndices.length === 0) {
      console.log(term.dim("  No skills match your search"));
    } else {
      for (let i = 0; i < visibleItems.length; i++) {
        const skillIndex = visibleItems[i];
        if (skillIndex === undefined) continue;
        const skill = skills[skillIndex];
        if (!skill) continue;
        const isSelected = selected.has(skillIndex);
        const isCursor = currentScrollOffset + i === currentCursor;

        const checkbox = isSelected ? term.green("◉") : "○";
        const prefix = isCursor ? term.cyan("❯") : " ";
        const nameText = isCursor ? term.bold(skill.name) : skill.name;
        const typeIndicator = skill.isFolder
          ? term.dim(" 📁")
          : term.dim(" 📄");

        console.log(`${prefix} ${checkbox} ${nameText}${typeIndicator}`);

        if (isCursor && skill.description) {
          const maxDescLen = (process.stdout.columns || 80) - 8;
          const desc =
            skill.description.length > maxDescLen
              ? skill.description.slice(0, maxDescLen - 3) + "..."
              : skill.description;
          console.log(term.dim(`     ${desc}`));
        }
      }

      if (filteredIndices.length > visibleCount) {
        console.log(
          term.dim(
            `\n  Showing ${currentScrollOffset + 1}-${Math.min(currentScrollOffset + visibleCount, filteredIndices.length)} of ${filteredIndices.length}`,
          ),
        );
      }
    }

    const selectedCount = selected.size;
    console.log(
      `\n${term.dim(`Selected: ${selectedCount} skill${selectedCount !== 1 ? "s" : ""}`)}`,
    );
  };

  return new Promise((resolve) => {
    // Check if we're running in an interactive terminal
    if (!process.stdin.isTTY) {
      console.error(
        "Error: This script must be run in an interactive terminal.",
      );
      process.exit(1);
    }

    term.hideCursor();
    render();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const cleanup = () => {
      term.showCursor();
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    let escapeSequence = "";

    process.stdin.on("data", (key: string) => {
      // Handle escape sequences
      if (escapeSequence || key === ESC) {
        escapeSequence += key;

        if (escapeSequence === ESC) {
          // Wait for more input
          setTimeout(() => {
            if (escapeSequence === ESC) {
              // Just Escape key
              cleanup();
              term.clear();
              console.log("Cancelled.");
              resolve([]);
            }
            escapeSequence = "";
          }, 50);
          return;
        }

        if (escapeSequence === `${ESC}[A`) {
          // Up arrow
          if (cursor > 0) cursor--;
          escapeSequence = "";
          render();
          return;
        }

        if (escapeSequence === `${ESC}[B`) {
          // Down arrow
          if (cursor < filteredIndices.length - 1) cursor++;
          escapeSequence = "";
          render();
          return;
        }

        if (escapeSequence.length >= 3) {
          escapeSequence = "";
        }
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        term.clear();
        console.log("Cancelled.");
        process.exit(0);
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        term.clear();
        resolve(
          Array.from(selected)
            .map((i) => skills[i])
            .filter((s): s is Skill => s !== undefined),
        );
        return;
      }

      // Space - toggle selection
      if (key === " ") {
        if (filteredIndices.length > 0) {
          const skillIndex = filteredIndices[cursor];
          if (skillIndex !== undefined) {
            if (selected.has(skillIndex)) {
              selected.delete(skillIndex);
            } else {
              selected.add(skillIndex);
            }
          }
        }
        render();
        return;
      }

      // q - quit
      if (key === "q") {
        cleanup();
        term.clear();
        console.log("Cancelled.");
        resolve([]);
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        searchQuery = searchQuery.slice(0, -1);
        filterSkills();
        render();
        return;
      }

      // Regular character for search
      if (key.length === 1 && key >= " " && key <= "~") {
        searchQuery += key;
        filterSkills();
        render();
        return;
      }
    });
  });
}

async function main() {
  console.log(term.dim("Loading skills..."));

  const skills = await discoverSkills();

  if (skills.length === 0) {
    console.log("No skills found in", SKILLS_DIR);
    process.exit(1);
  }

  const selectedSkills = await interactiveSelect(skills);

  if (selectedSkills.length === 0) {
    process.exit(0);
  }

  console.log(term.bold("\nInstalling skills...\n"));

  for (const skill of selectedSkills) {
    try {
      await installSkill(skill);
      console.log(term.green("✓") + ` ${skill.name}`);
    } catch (error) {
      console.log(term.yellow("✗") + ` ${skill.name}: ${error}`);
    }
  }

  console.log(
    term.bold(
      term.green(
        `\n✨ Installed ${selectedSkills.length} skill(s) to ${TARGET_DIR}`,
      ),
    ),
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
