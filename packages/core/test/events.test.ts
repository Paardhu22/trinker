import { describe, expect, it } from "vitest";
import { ScanEventBus, type ScanEvent } from "../src/index.js";

const at = () => new Date("2026-09-11T00:00:00.000Z");

describe("ScanEventBus ordering", () => {
  it("assigns monotonic, core-owned sequence numbers", () => {
    const bus = new ScanEventBus("scan_test", at);
    expect(bus.emit("scan.started", {}).sequence).toBe(1);
    expect(bus.emit("check.started", {}).sequence).toBe(2);
    expect(bus.emit("scan.completed", {}).sequence).toBe(3);
  });
});

describe("ScanEventBus replay (regression: the first events were lost to a subscription race)", () => {
  it("gives a late subscriber the complete sequence from the beginning", () => {
    const bus = new ScanEventBus("scan_test", at);
    bus.emit("scan.started", { a: 1 });
    bus.emit("phase.started", {});
    bus.emit("usage.updated", {});
    bus.emit("check.started", {});

    const seen: ScanEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.emit("scan.completed", {});

    expect(seen.map((event) => event.type)).toEqual([
      "scan.started", "phase.started", "usage.updated", "check.started", "scan.completed",
    ]);
    expect(seen.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("can opt out of replay when a consumer only wants live events", () => {
    const bus = new ScanEventBus("scan_test", at);
    bus.emit("scan.started", {});
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type), { replay: false });
    bus.emit("scan.completed", {});
    expect(seen).toEqual(["scan.completed"]);
  });

  it("delivers the same complete sequence to every subscriber regardless of attach time", () => {
    const bus = new ScanEventBus("scan_test", at);
    const early: number[] = [];
    bus.subscribe((event) => early.push(event.sequence));
    bus.emit("scan.started", {});
    bus.emit("check.started", {});
    const late: number[] = [];
    bus.subscribe((event) => late.push(event.sequence));
    bus.emit("scan.completed", {});
    expect(early).toEqual([1, 2, 3]);
    expect(late).toEqual([1, 2, 3]);
  });

  it("stops delivering to an unsubscribed listener", () => {
    const bus = new ScanEventBus("scan_test", at);
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type));
    bus.emit("scan.started", {});
    unsubscribe();
    bus.emit("scan.completed", {});
    expect(seen).toEqual(["scan.started"]);
  });
});

describe("ScanEventBus async iteration", () => {
  it("terminates after scan.completed instead of hanging forever", async () => {
    const bus = new ScanEventBus("scan_test", at);
    const collected: string[] = [];
    const consume = (async () => { for await (const event of bus) collected.push(event.type); })();
    bus.emit("scan.started", {});
    bus.emit("check.passed", {});
    bus.emit("scan.completed", {});
    await consume; // would time out if the iterator never returned
    expect(collected).toEqual(["scan.started", "check.passed", "scan.completed"]);
  });

  it("terminates after scan.failed", async () => {
    const bus = new ScanEventBus("scan_test", at);
    const collected: string[] = [];
    const consume = (async () => { for await (const event of bus) collected.push(event.type); })();
    bus.emit("scan.started", {});
    bus.emit("scan.failed", { reason: "blocked" });
    await consume;
    expect(collected).toEqual(["scan.started", "scan.failed"]);
  });

  it("replays a scan that already finished before iteration started", async () => {
    const bus = new ScanEventBus("scan_test", at);
    bus.emit("scan.started", {});
    bus.emit("scan.completed", {});
    const collected: string[] = [];
    for await (const event of bus) collected.push(event.type);
    expect(collected).toEqual(["scan.started", "scan.completed"]);
    expect(bus.isTerminated).toBe(true);
  });
});
