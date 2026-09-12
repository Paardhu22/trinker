import { describe, expect, it } from "vitest";
import {
  box, center, columns, field, fit, formatDuration, formatNumber, formatWhen, maskSensitiveSecrets, progressBar,
  stripAnsi, truncate, visibleWidth, windowed,
} from "../src/tui/render.js";
import { header, menu, toHeight, unifiedFrame } from "../src/tui/chrome.js";

/**
 * Layout is where a terminal UI actually breaks: a miscounted width wraps a line and the whole
 * frame shears. These assert printable width, never raw string length.
 */

const RED = "[31m";
const RESET = "[0m";

describe("printable width ignores colour codes", () => {
  it("measures the visible characters only", () => {
    expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("")).toBe(0);
  });

  it("pads a coloured string to a real column width", () => {
    const padded = fit(`${RED}ab${RESET}`, 6);
    expect(visibleWidth(padded)).toBe(6);
    expect(stripAnsi(padded)).toBe("ab    ");
  });

  it("truncates by visible width, not byte length", () => {
    expect(stripAnsi(truncate("abcdefgh", 5))).toBe("abcd…");
    expect(visibleWidth(truncate(`${RED}abcdefgh${RESET}`, 5))).toBe(5);
  });

  it("leaves short text alone", () => {
    expect(truncate("ab", 10)).toBe("ab");
  });

  it("centres within a width", () => {
    expect(stripAnsi(center("ab", 6))).toBe("  ab  ");
    expect(visibleWidth(center(`${RED}ab${RESET}`, 6))).toBe(6);
  });
});

describe("boxes", () => {
  it("draws a frame of exactly the requested width", () => {
    const lines = box(["hello"], { width: 20 });
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(visibleWidth(line)).toBe(20);
  });

  it("uses rounded corners for the outer container", () => {
    expect(stripAnsi(box([], { width: 10, rounded: true })[0]!)).toMatch(/^╭/);
    expect(stripAnsi(box([], { width: 10 })[0]!)).toMatch(/^┌/);
  });

  it("renders a title into the top border without changing the width", () => {
    const lines = box(["x"], { width: 30, title: "DASHBOARD" });
    expect(stripAnsi(lines[0]!)).toContain("DASHBOARD");
    expect(visibleWidth(lines[0]!)).toBe(30);
  });

  it("clips content that would overflow rather than wrapping it", () => {
    const lines = box(["a".repeat(100)], { width: 20 });
    expect(visibleWidth(lines[1]!)).toBe(20);
  });
});

describe("columns", () => {
  it("joins two panes at fixed widths and pads the shorter", () => {
    const rows = columns(["a", "b", "c"], ["1"], 5, 8);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(visibleWidth(row)).toBe(5 + 3 + 8);
  });
});

describe("scrolling window", () => {
  it("returns everything when it fits", () => {
    expect(windowed([1, 2, 3], 0, 10)).toEqual({ slice: [1, 2, 3], offset: 0 });
  });

  it("keeps the selection on screen when the list is longer than the viewport", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const { slice, offset } = windowed(items, 40, 10);
    expect(slice).toHaveLength(10);
    expect(offset).toBeLessThanOrEqual(40);
    expect(offset + slice.length).toBeGreaterThan(40);
  });

  it("clamps at the end of the list", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const { offset } = windowed(items, 19, 5);
    expect(offset).toBe(15);
  });
});

describe("formatting", () => {
  it("formats durations and counts", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(2400)).toBe("2.4s");
    expect(formatNumber(4492)).toBe("4,492");
  });

  it("says never rather than inventing a timestamp", () => {
    expect(formatWhen(undefined)).toBe("never");
    expect(formatWhen("")).toBe("never");
  });

  it("reports a recent timestamp relatively", () => {
    expect(formatWhen(new Date(Date.now() - 5000).toISOString())).toMatch(/^\d+s ago$/);
  });

  it("draws a progress bar of exactly the requested width, clamped", () => {
    expect(visibleWidth(progressBar(0.5, 10))).toBe(10);
    expect(visibleWidth(progressBar(5, 10))).toBe(10);
    expect(visibleWidth(progressBar(-1, 10))).toBe(10);
  });

  it("aligns key/value fields", () => {
    expect(stripAnsi(field("Target", "x"))).toBe("Target       x");
  });
});

describe("header", () => {
  it("renders the block logo when there is room", () => {
    const lines = header({ width: 110, version: "0.1.0" });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("████");
    expect(text).toContain("APPLICATION SECURITY TESTING");
    expect(text).toContain("SCAN. VERIFY. SECURE.");
    expect(text).toContain("v0.1.0");
  });

  it("degrades to a wordmark on a narrow terminal rather than shearing the logo", () => {
    const lines = header({ width: 72, version: "0.1.0" });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("████");
    expect(text).toContain("T R I N K E R");
  });

  it("keeps every line at the frame width at any size", () => {
    for (const width of [72, 90, 120, 160]) {
      for (const line of header({ width, version: "0.1.0" })) expect(visibleWidth(line)).toBe(width);
    }
  });
});

describe("menu", () => {
  const items = [
    { label: "Run Security Scan", symbol: "▸" },
    { label: "View Findings", symbol: "◆" },
  ];

  it("numbers every entry and marks the selection", () => {
    const rows = menu(items, 1, 26).map(stripAnsi);
    expect(rows[0]).toContain("1 ▸ Run Security Scan");
    expect(rows[1]).toContain("❯");
    expect(rows[1]).toContain("2 ◆ View Findings");
  });

  it("keeps every row at the sidebar width", () => {
    for (const row of menu(items, 0, 26)) expect(visibleWidth(row)).toBe(26);
  });
});

describe("fixed height", () => {
  it("pads and clips so panels do not jump between renders", () => {
    expect(toHeight(["a"], 3)).toEqual(["a", "", ""]);
    expect(toHeight(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });
});

describe("maskSensitiveSecrets", () => {
  it("masks Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcBQACt7FsKOhNmWYuferuhQqqL1nvIW91pouQ";
    const masked = maskSensitiveSecrets(input);
    expect(masked).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(masked).toContain("Bearer [REDACTED]");
  });

  it("masks API keys", () => {
    const input = "Using OPENAI_API_KEY=sk-proj-abc12345678901234567890 for compilation";
    const masked = maskSensitiveSecrets(input);
    expect(masked).not.toContain("sk-proj-abc");
    expect(masked).toContain("[REDACTED_KEY]");
  });

  it("leaves non-secret text intact", () => {
    const input = "GET /api/BasketItems/1 HTTP/1.1\nHost: localhost:3000";
    expect(maskSensitiveSecrets(input)).toBe(input);
  });
});

describe("unifiedFrame", () => {
  const hints: Array<[string, string]> = [["↑↓", "navigate"], ["Enter", "select"], ["q", "quit"]];

  it("renders a unified box where every line matches the exact requested width", () => {
    for (const width of [80, 100, 120]) {
      for (const height of [24, 30, 40]) {
        const frame = unifiedFrame({
          width,
          height,
          selected: 0,
          title: "DASHBOARD",
          body: ["Line 1", "Line 2", "Line 3"],
          hints,
          sidebarWidth: 28,
        });

        expect(frame.length).toBeGreaterThanOrEqual(height);
        for (const line of frame) {
          expect(visibleWidth(line)).toBe(width);
        }
      }
    }
  });

  it("includes all structural junctions and section titles", () => {
    const lines = unifiedFrame({
      width: 100,
      height: 30,
      selected: 2,
      title: "FINDINGS",
      body: ["finding row 1", "finding row 2"],
      hints,
      sidebarWidth: 28,
    });
    const text = lines.map(stripAnsi).join("\n");

    // Check top and bottom borders
    expect(text).toMatch(/^┌─+┐/);
    expect(text).toMatch(/└─+┘$/);

    // Check header divider with junction
    expect(text).toMatch(/├─+┬─+┤/);

    // Check column titles row
    expect(text).toContain("MAIN MENU");
    expect(text).toContain("FINDINGS");

    // Check column separator junction
    expect(text).toMatch(/├─+┼─+┤/);

    // Check footer divider with junction
    expect(text).toMatch(/├─+┴─+┤/);

    // Check footer key hints
    expect(text).toContain("navigate");
    expect(text).toContain("select");
    expect(text).toContain("quit");
  });

  it("highlights the selected menu row in the sidebar", () => {
    const lines = unifiedFrame({
      width: 100,
      height: 30,
      selected: 1, // Compile Security Plan
      title: "COMPILE",
      body: ["compiler body"],
      hints,
      sidebarWidth: 28,
    });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("❯ 2 ✦ Compile Security Plan");
  });
});
