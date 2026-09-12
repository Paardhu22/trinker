import { BG_PANEL, c, paintBackground } from "./theme.js";

/**
 * Layout primitives.
 *
 * Every helper is a pure function over strings, so a screen can be rendered and asserted in a test
 * with no terminal attached. That is the same split that keeps `scan-view.ts` testable: decide the
 * lines first, write them to a device second.
 */

const ANSI = /\[[0-9;]*m/g;

/** Printable width, ignoring colour codes. Everything below depends on getting this right. */
export const visibleWidth = (text: string): number => text.replace(ANSI, "").length;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** Truncate to `width` printable characters, preserving any colour already applied. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsis = "…";
  let out = "";
  let shown = 0;
  let index = 0;
  while (index < text.length && shown < width - 1) {
    const escape = /^\[[0-9;]*m/.exec(text.slice(index));
    if (escape) { out += escape[0]; index += escape[0].length; continue; }
    out += text[index];
    index += 1;
    shown += 1;
  }
  // Close any colour the truncation may have cut mid-run.
  return `${out}${ellipsis}${text.includes("[") ? "[0m" : ""}`;
}

export const padEnd = (text: string, width: number): string =>
  text + " ".repeat(Math.max(width - visibleWidth(text), 0));

export const fit = (text: string, width: number): string => padEnd(truncate(text, width), width);

export const center = (text: string, width: number): string => {
  const spare = Math.max(width - visibleWidth(text), 0);
  const left = Math.floor(spare / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(spare - left)}`;
};

/* --------------------------------------------------------------------- boxes */

export interface BoxOptions {
  width: number;
  title?: string | undefined;
  /** Rounded corners for the outer container; square for inner panels. */
  rounded?: boolean;
  /** Paint the interior with the panel background. */
  filled?: boolean;
}

const CORNERS = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯" },
  square: { tl: "┌", tr: "┐", bl: "└", br: "┘" },
};

/** Draw a bordered panel around already-laid-out content lines. */
export function box(lines: string[], options: BoxOptions): string[] {
  const inner = Math.max(options.width - 2, 0);
  const corner = options.rounded === true ? CORNERS.rounded : CORNERS.square;
  const paint = (text: string): string => (options.filled === true ? paintBackground(BG_PANEL, text) : text);

  const header = options.title === undefined || options.title === ""
    ? c.border(`${corner.tl}${"─".repeat(inner)}${corner.tr}`)
    : c.border(`${corner.tl}─ `) + c.title(options.title) + c.border(` ${"─".repeat(Math.max(inner - visibleWidth(options.title) - 3, 0))}${corner.tr}`);

  return [
    header,
    ...lines.map((line) => c.border("│") + paint(fit(line, inner)) + c.border("│")),
    c.border(`${corner.bl}${"─".repeat(inner)}${corner.br}`),
  ];
}

/** A horizontal rule sized to sit inside a box of `width`. */
export const rule = (width: number): string => c.border("─".repeat(Math.max(width, 0)));

/* ------------------------------------------------------------------- stacks */

/**
 * Place two columns side by side, padding the shorter one.
 *
 * Used for the sidebar/main split. The divider is drawn by the caller's box, so this only joins.
 */
export function columns(left: string[], right: string[], leftWidth: number, rightWidth: number, divider = " │ "): string[] {
  const height = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let index = 0; index < height; index++) {
    out.push(fit(left[index] ?? "", leftWidth) + c.border(divider) + fit(right[index] ?? "", rightWidth));
  }
  return out;
}

/** Key/value line used throughout the dashboard and detail screens. */
export const field = (label: string, value: string, labelWidth = 13): string =>
  c.dim(padEnd(label, labelWidth)) + value;

/* ---------------------------------------------------------------- scrolling */

/**
 * Window a list around the selection.
 *
 * Long findings and long evidence must scroll rather than overflow, and the selected row must stay
 * on screen — otherwise arrow keys appear to do nothing once the list is taller than the terminal.
 */
export function windowed<T>(items: T[], selected: number, height: number): { slice: T[]; offset: number } {
  if (items.length <= height || height <= 0) return { slice: items, offset: 0 };
  const half = Math.floor(height / 2);
  const offset = Math.min(Math.max(selected - half, 0), items.length - height);
  return { slice: items.slice(offset, offset + height), offset };
}

/** `3 of 12` style position marker, shown only when the list actually scrolls. */
export const scrollHint = (selected: number, total: number, height: number): string =>
  total > height ? c.faint(`${selected + 1} of ${total}`) : "";

/* ---------------------------------------------------------------- numbers */

export const formatNumber = (value: number): string => value.toLocaleString("en-US");

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

/** Best-effort relative timestamp for "last scan". */
export function formatWhen(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(Math.round((Date.now() - then) / 1000), 0);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(then).toISOString().slice(0, 16).replace("T", " ");
}

/** A thin progress bar. Ratio is clamped; the caller supplies real progress, never a guess. */
export function progressBar(ratio: number, width: number): string {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  const filled = Math.round(clamped * width);
  return c.accent("█".repeat(filled)) + c.faint("░".repeat(Math.max(width - filled, 0)));
}

/**
 * Mask credential-like patterns (Bearer tokens, API keys, JWTs) from display text.
 */
export function maskSensitiveSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "[REDACTED_JWT]");
}
