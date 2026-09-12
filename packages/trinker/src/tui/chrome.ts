import { box, center, columns, fit, visibleWidth } from "./render.js";
import { c } from "./theme.js";

/** The wordmark. Kept as one block so it is obvious what to edit. */
const LOGO = [
  "████████╗██████╗ ██╗███╗   ██╗██╗  ██╗███████╗██████╗ ",
  "╚══██╔══╝██╔══██╗██║████╗  ██║██║ ██╔╝██╔════╝██╔══██╗",
  "   ██║   ██████╔╝██║██╔██╗ ██║█████╔╝ █████╗  ██████╔╝",
  "   ██║   ██╔══██╗██║██║╚██╗██║██╔═██╗ ██╔══╝  ██╔══██╗",
  "   ██║   ██║  ██║██║██║ ╚████║██║  ██╗███████╗██║  ██║",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
];

const LOGO_WIDTH = Math.max(...LOGO.map((line) => line.length));

/** A compact wordmark for terminals too narrow for the block logo. */
const SMALL_LOGO = ["T R I N K E R"];

export interface HeaderOptions {
  width: number;
  version: string;
}

/**
 * The masthead.
 *
 * Degrades rather than wraps: on a narrow terminal the block logo is replaced by a wordmark and the
 * tagline column is dropped, because a broken ASCII logo reads as a bug.
 */
export function header(options: HeaderOptions): string[] {
  const inner = options.width - 2;
  const versionTag = c.faint(`v${options.version}`);
  const useBlock = inner >= LOGO_WIDTH + 34;

  if (!useBlock) {
    const lines = [
      "",
      c.accentBold(center(SMALL_LOGO[0]!, inner - 2)),
      c.dim(center("APPLICATION SECURITY TESTING", inner - 2)),
      "",
    ];
    return box(lines, { width: options.width, rounded: true });
  }

  const left = [
    ...LOGO.map((line) => c.accent(line)),
    "",
    c.dim("APPLICATION SECURITY TESTING"),
  ];
  const right = [
    "",
    c.title("SCAN. VERIFY. SECURE."),
    "",
    c.dim("Deterministic security testing"),
    c.dim("with AI-assisted plans"),
    "",
    versionTag,
  ];

  const leftWidth = LOGO_WIDTH;
  const rightWidth = Math.max(inner - leftWidth - 5, 10);
  const body = columns(left, right, leftWidth, rightWidth, "   ");
  return box(["", ...body, ""], { width: options.width, rounded: true });
}

/** `symbol` is a terminal-safe glyph; the label is what the reader actually scans for. */
export interface MenuItem { label: string; symbol: string }

export const MENU: readonly MenuItem[] = [
  { label: "Run Security Scan", symbol: "▸" },
  { label: "Compile Security Plan", symbol: "✦" },
  { label: "View Latest Report", symbol: "▤" },
  { label: "View Findings", symbol: "◆" },
  { label: "Verify Finding", symbol: "⟲" },
  { label: "Security Coverage", symbol: "◱" },
  { label: "Export Report", symbol: "⤓" },
  { label: "Configuration", symbol: "⚙" },
  { label: "Exit", symbol: "⏻" },
];

/** The sidebar. Selection is a filled blue row, which is the only strong colour on the screen. */
export function menu(items: readonly MenuItem[], selected: number, width: number): string[] {
  return items.map((item, index) => {
    const number = c.faint(`${index + 1}`);
    const label = `${item.symbol} ${item.label}`;
    if (index !== selected) return fit(`  ${number} ${c.text(label)}`, width);
    // Paint the whole row so the highlight reads as a block, not a coloured word.
    const row = fit(`${c.accentBold("❯")} ${number} ${c.accentBold(label)}`, width);
    return row;
  });
}

/** The persistent key hints along the bottom. */
export function footer(hints: Array<[string, string]>, width: number): string {
  const rendered = hints.map(([key, action]) => `${c.accent(key)} ${c.dim(action)}`).join(c.faint("   "));
  return fit(` ${rendered}`, width);
}

/** Pad a screen body to a fixed height so panels do not jump between renders. */
export const toHeight = (lines: string[], height: number): string[] =>
  lines.length >= height ? lines.slice(0, height) : [...lines, ...Array(height - lines.length).fill("")];

export interface UnifiedFrameOptions {
  width: number;
  height: number;
  selected: number;
  title: string;
  body: string[];
  hints: Array<[string, string]>;
  sidebarWidth?: number;
  version?: string;
  menuItems?: readonly MenuItem[];
}

/**
 * Unified application shell matching the reference terminal layout.
 *
 * Draws a single seamless bordered frame containing:
 * - Masthead (Logo + Tagline)
 * - Header divider with column junctions
 * - Sidebar (Main Menu) and Main Content region
 * - Footer divider and Key hints
 */
export function unifiedFrame(options: UnifiedFrameOptions): string[] {
  const { width, height } = options;
  const inner = Math.max(width - 2, 0);
  const sidebarWidth = options.sidebarWidth ?? 28;
  const mainWidth = Math.max(inner - sidebarWidth - 1, 10);
  const version = options.version ?? "0.1.0";
  const menuItems = options.menuItems ?? MENU;

  const useBlock = height >= 25 && inner >= LOGO_WIDTH + 34;

  let headerLines: string[];
  if (useBlock) {
    const left = [
      ...LOGO.map((line) => `  ${c.accent(line)}`),
      "",
      `  ${c.dim(center("APPLICATION SECURITY TESTING", LOGO_WIDTH))}`,
    ];
    const right = [
      "",
      c.title("SCAN. VERIFY. SECURE."),
      "",
      c.dim("Deterministic security testing"),
      c.dim("with AI-assisted plans"),
      c.green("Runtime LLM tokens: 0 by default"),
      c.faint(`v${version}`),
    ];
    const leftWidth = LOGO_WIDTH + 2;
    const rightWidth = Math.max(inner - leftWidth - 5, 10);
    const bodyCols = columns(left, right, leftWidth, rightWidth, "   ");
    headerLines = ["", ...bodyCols, ""];
  } else {
    headerLines = [
      "",
      ` ${c.accentBold(SMALL_LOGO[0]!)}  ${c.faint(`v${version}`)}   ${c.title("SCAN. VERIFY. SECURE.")}`,
      ` ${c.dim("APPLICATION SECURITY TESTING — DETERMINISTIC SCANS WITH AI-ASSISTED PLANS")}`,
    ];
  }

  // Fixed framing lines: 1 (top) + headerLines + 1 (div) + 1 (titles) + 1 (title-div) + 1 (footer-div) + 1 (footer) + 1 (bottom) = 7 + headerLines.length
  const chromeLineCount = 7 + headerLines.length;
  const bodyHeight = Math.max(height - chromeLineCount, 6);

  const sidebar = toHeight(menu(menuItems, options.selected, sidebarWidth - 1), bodyHeight);
  const main = toHeight(options.body, bodyHeight);

  const topBorder = c.border(`┌${"─".repeat(inner)}┐`);
  const headerRows = headerLines.map((line) => c.border("│") + fit(line, inner) + c.border("│"));
  const headerDivider = c.border(`├${"─".repeat(sidebarWidth)}┬${"─".repeat(mainWidth)}┤`);
  const gutter = (line: string, width: number): string => ` ${fit(line, Math.max(width - 1, 0))}`;

  const titlesRow =
    c.border("│") +
    gutter(c.title("MAIN MENU"), sidebarWidth) +
    c.border("│") +
    gutter(c.title(options.title), mainWidth) +
    c.border("│");
  const titlesUnderline = c.border(`├${"─".repeat(sidebarWidth)}┼${"─".repeat(mainWidth)}┤`);

  const bodyRows: string[] = [];
  for (let i = 0; i < bodyHeight; i++) {
    const sLine = sidebar[i] ?? "";
    const mLine = main[i] ?? "";
    bodyRows.push(
      c.border("│") +
      gutter(sLine, sidebarWidth) +
      c.border("│") +
      gutter(mLine, mainWidth) +
      c.border("│")
    );
  }

  const footerDivider = c.border(`├${"─".repeat(sidebarWidth)}┴${"─".repeat(mainWidth)}┤`);
  const footerRow = c.border("│") + footer(options.hints, inner) + c.border("│");
  const bottomBorder = c.border(`└${"─".repeat(inner)}┘`);

  return [
    topBorder,
    ...headerRows,
    headerDivider,
    titlesRow,
    titlesUnderline,
    ...bodyRows,
    footerDivider,
    footerRow,
    bottomBorder,
  ];
}
