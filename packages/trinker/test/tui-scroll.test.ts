import { describe, expect, it } from "vitest";
import { scrollFor } from "../src/tui/app.js";
import { frameBodyHeight, unifiedFrame } from "../src/tui/chrome.js";

describe("scrollFor", () => {
  it("clamps at both ends so a panel can never scroll into blank space", () => {
    expect(scrollFor("up", 0, 100, 20)).toBe(0);
    expect(scrollFor("down", 80, 100, 20)).toBe(80);
    expect(scrollFor("end", 0, 100, 20)).toBe(80);
    expect(scrollFor("home", 50, 100, 20)).toBe(0);
    expect(scrollFor("pagedown", 0, 100, 20)).toBe(18);
    expect(scrollFor("down", 0, 10, 20)).toBe(0); // content shorter than the panel never scrolls
  });

  it("ignores keys that are not scroll keys", () => {
    expect(scrollFor("x", 3, 100, 20)).toBeUndefined();
  });
});

describe("frameBodyHeight", () => {
  it.each([[100, 30], [180, 50], [80, 20], [72, 18]])("matches the rows unifiedFrame gives the body at %ix%i", (width, height) => {
    const body = Array.from({ length: 200 }, (_, index) => `line-${index}-end`);
    const frame = unifiedFrame({ width, height, selected: 0, title: "T", body, hints: [] }).join("\n");
    const shown = body.filter((line) => frame.includes(line)).length;
    expect(shown).toBe(frameBodyHeight(width, height));
    expect(frame.split("\n")).toHaveLength(height);
  });
});
