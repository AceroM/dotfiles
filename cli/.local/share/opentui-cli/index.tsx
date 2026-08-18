import { TextAttributes, createCliRenderer, type KeyEvent } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import React, { createContext, useContext, type ReactNode } from "react";

// Hooks must come from the same React instance as OpenTUI's reconciler. Re-export
// React so file-linked consumers do not accidentally load a second module copy.
export {
  default,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
export type { ReactNode } from "react";

type BoxProps = {
  children?: ReactNode;
  borderStyle?: string;
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  [name: string]: unknown;
};

type TextProps = {
  children?: ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
  [name: string]: unknown;
};

export type InputKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  tab: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
};

const insideText = createContext(false);
const decoder = new TextDecoder();

function textAttributes(props: TextProps): number | undefined {
  let attributes = TextAttributes.NONE;
  if (props.bold) attributes |= TextAttributes.BOLD;
  if (props.dimColor) attributes |= TextAttributes.DIM;
  if (props.italic) attributes |= TextAttributes.ITALIC;
  if (props.underline) attributes |= TextAttributes.UNDERLINE;
  if (props.strikethrough) attributes |= TextAttributes.STRIKETHROUGH;
  if (props.inverse) attributes |= TextAttributes.INVERSE;
  return attributes === TextAttributes.NONE ? undefined : attributes;
}

/** Layout primitive backed by OpenTUI's BoxRenderable. */
export function Box({
  children,
  borderStyle,
  flexDirection = "row",
  ...props
}: BoxProps) {
  return React.createElement(
    "box",
    {
      ...props,
      flexDirection,
      borderStyle: borderStyle === "round" ? "rounded" : borderStyle,
    },
    children,
  );
}

/** Text primitive that turns nested text into OpenTUI span nodes. */
export function Text({
  children,
  color,
  backgroundColor,
  bold,
  dimColor,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  ...props
}: TextProps) {
  const nested = useContext(insideText);
  const attributes = textAttributes({
    bold,
    dimColor,
    italic,
    underline,
    strikethrough,
    inverse,
  });
  const style = {
    ...props,
    fg: color,
    bg: backgroundColor,
    attributes,
    wrapMode: wrap && wrap !== "wrap" ? "none" : undefined,
    truncate: wrap ? wrap !== "wrap" : undefined,
  };

  if (nested) return React.createElement("span", style, children);

  return React.createElement(
    "text",
    style,
    React.createElement(insideText.Provider, { value: true }, children),
  );
}

function inputFor(key: KeyEvent): string {
  if (key.name === "space") return " ";
  if (key.ctrl || key.meta) return key.name.length === 1 ? key.name : "";
  if (key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) return key.sequence;
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name;
  return "";
}

function keyFor(key: KeyEvent): InputKey {
  return {
    upArrow: key.name === "up",
    downArrow: key.name === "down",
    leftArrow: key.name === "left",
    rightArrow: key.name === "right",
    pageUp: key.name === "pageup",
    pageDown: key.name === "pagedown",
    return: key.name === "return" || key.name === "linefeed",
    escape: key.name === "escape",
    backspace: key.name === "backspace",
    delete: key.name === "delete",
    tab: key.name === "tab",
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta || key.option || Boolean(key.super),
  };
}

/** Subscribe to OpenTUI keyboard and bracketed-paste events. */
export function useInput(
  handler: (input: string, key: InputKey) => void,
  options: { isActive?: boolean } = {},
) {
  useKeyboard((key) => {
    if (options.isActive === false) return;
    handler(inputFor(key), keyFor(key));
  });
  usePaste((event) => {
    if (options.isActive === false) return;
    handler(decoder.decode(event.bytes), {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      pageUp: false,
      pageDown: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
      ctrl: false,
      shift: false,
      meta: false,
    });
  });
}

export function useApp() {
  const renderer = useRenderer();
  return { exit: () => renderer.destroy() };
}

export function useStdout() {
  useTerminalDimensions();
  return { stdout: process.stdout };
}

export function useStdin() {
  return { stdin: process.stdin, isRawModeSupported: Boolean(process.stdin.isTTY) };
}

export type RenderInstance = {
  waitUntilExit: () => Promise<void>;
};

/** Start a full-screen OpenTUI React application. */
export async function render(node: ReactNode): Promise<RenderInstance> {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
    onDestroy: finish,
  });
  createRoot(renderer).render(node);
  return { waitUntilExit: () => exited };
}
