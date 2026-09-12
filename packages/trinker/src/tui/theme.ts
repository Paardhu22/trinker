/**
 * The console's visual vocabulary.
 *
 * Restrained on purpose: colour marks meaning, never decoration. Blue means "you are here", the
 * severity ramp means severity, grey means secondary, and everything else is left alone. A security
 * tool that colours every border teaches the reader to ignore colour.
 */

const enabled = (): boolean => process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

const sgr = (open: string) => (text: string): string => (enabled() ? `[${open}m${text}[0m` : text);

/* 256-colour ramp. Kept dark so the panels sit just above the terminal ground. */
export const BG_APP = "48;5;233";
export const BG_PANEL = "48;5;234";
export const BG_SELECTED = "48;5;24";

export const c = {
  title: sgr("1;38;5;252"),
  text: sgr("38;5;252"),
  dim: sgr("38;5;245"),
  faint: sgr("38;5;240"),
  border: sgr("38;5;238"),
  accent: sgr("38;5;75"),
  accentBold: sgr("1;38;5;75"),
  red: sgr("38;5;167"),
  yellow: sgr("38;5;179"),
  green: sgr("38;5;108"),
  magenta: sgr("38;5;140"),
};

/** Severity ramp. Only these four states earn colour in a findings table. */
export const severityColour = (severity: string): ((text: string) => string) => {
  switch (severity.toLowerCase()) {
    case "critical":
    case "high": return c.red;
    case "medium": return c.yellow;
    case "low": return c.green;
    default: return c.dim;
  }
};

/** Outcome ramp, matching the runner's five-way taxonomy. */
export const statusColour = (status: string): ((text: string) => string) => {
  switch (status) {
    case "passed": return c.green;
    case "failed": return c.red;
    case "inconclusive": return c.yellow;
    case "errored":
    case "unavailable": return c.magenta;
    case "running": return c.accent;
    default: return c.dim;
  }
};

/** Plain ASCII fallbacks are used when the terminal cannot be trusted with box drawing. */
export const glyph = {
  passed: "✓",
  failed: "✗",
  running: "⟳",
  pending: "○",
  inconclusive: "◐",
  errored: "!",
  bullet: "·",
  arrow: "❯",
  down: "↓",
};

export const paintBackground = (code: string, text: string): string =>
  enabled() ? `[${code}m${text}[49m` : text;

export const colourEnabled = enabled;
