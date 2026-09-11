import { EventEmitter } from "node:events";

export type ScanEventType =
  | "scan.started" | "surface.discovered" | "phase.started" | "oracle.calibrated"
  | "check.started" | "check.progress" | "check.passed" | "check.failed" | "check.skipped"
  | "finding.confirmed" | "usage.updated" | "scan.completed";

export interface ScanEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  version: 1;
  scanId: string;
  sequence: number;
  timestamp: string;
  type: ScanEventType;
  data: T;
}

export class ScanEventBus implements AsyncIterable<ScanEvent> {
  private readonly emitter = new EventEmitter();
  private sequence = 0;
  public constructor(private readonly scanId: string, private readonly now: () => Date = () => new Date()) {}

  emit(type: ScanEventType, data: Record<string, unknown>): ScanEvent {
    const event: ScanEvent = { version: 1, scanId: this.scanId, sequence: ++this.sequence, timestamp: this.now().toISOString(), type, data };
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: ScanEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ScanEvent> {
    const queued: ScanEvent[] = [];
    let resume: (() => void) | undefined;
    const unsubscribe = this.subscribe((event) => { queued.push(event); resume?.(); });
    try {
      while (true) {
        if (queued.length === 0) await new Promise<void>((resolve) => { resume = resolve; });
        while (queued.length > 0) yield queued.shift()!;
      }
    } finally { unsubscribe(); }
  }
}
