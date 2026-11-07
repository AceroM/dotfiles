// Zed One Dark, matching ghostty/.config/ghostty/themes/zed-one-dark.
export const theme = {
  background: "#282c34",
  panel: "#21252b",
  selected: "#3a4b5f",
  border: "#464b57",
  text: "#abb2bf",
  muted: "#636d83",
  accent: "#74ade8",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  gray: "#636d83",
  grey: "#636d83",
  brightBlack: "#636d83",
  brightRed: "#ea858b",
  brightGreen: "#aad581",
  brightYellow: "#ffd885",
  brightBlue: "#85c1ff",
  brightMagenta: "#d398eb",
  brightCyan: "#6ed5de",
  brightWhite: "#fafafa",
} as const;

export function themeColor(color: string | undefined): string | undefined {
  return color && Object.hasOwn(theme, color) ? theme[color as keyof typeof theme] : color;
}
