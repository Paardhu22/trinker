import { EventEmitter } from "node:events";

export type ScanEventType =
  | "scan.started" | "surface.discovered" | "phase.started" | "oracle.calibrated"
  | "check.started" | "check.progress"
  | "check.passed" | "check.failed" | "check.inconclusive" | "check.errored" | "check.unavailable"
  | "finding.confirmed" | "usage.updated" | "scan.completed" | "scan.failed";

/** Event types after which no further event is emitted for a scan. */
const TERMINAL_EVENTS: ReadonlySet<ScanEventType> = new Set<ScanEventType>(["scan.completed", "scan.failed"]);

export interface ScanEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  version: 1;
  scanId: string;
  sequence: number;
  timestamp: string;
  type: ScanEventType;
  data: T;
}

export interface SubscribeOptions {
  /**
   * Replay events already emitted before this listener attached. Defaults to true so a consumer
   * always observes the complete, correctly ordered sequence regardless of when it subscribes.
   */
  replay?: boolean;
}

/**
 * Ordered, replayable scan event stream.
 *
 * The bus retains every event it emits. A listener attaching mid-scan is first given the backlog
 * synchronously, then live events, so `sequence` is always observed as 1..n with no gaps. This is
 * what makes the runner free to emit before any consumer exists.
 */
export class ScanEventBus implements AsyncIterable<ScanEvent> {
  private readonly emitter = new EventEmitter();
  private readonly history: ScanEvent[] = [];
  private sequence = 0;
  private terminated = false;

  public constructor(private readonly scanId: string, private readonly now: () => Date = () => new Date()) {
    // A scan can out-live the default listener cap when many consumers attach (TUI + reporters).
    this.emitter.setMaxListeners(0);
  }

  emit(type: ScanEventType, data: Record<string, unknown>): ScanEvent {
    const event: ScanEvent = { version: 1, scanId: this.scanId, sequence: ++this.sequence, timestamp: this.now().toISOString(), type, data };
    this.history.push(event);
    if (TERMINAL_EVENTS.has(type)) this.terminated = true;
    this.emitter.emit("event", event);
    return event;
  }

  /** Every event emitted so far, in order. */
  get events(): readonly ScanEvent[] { return this.history; }

  /** True once a terminal event (`scan.completed` / `scan.failed`) has been emitted. */
  get isTerminated(): boolean { return this.terminated; }

  subscribe(listener: (event: ScanEvent) => void, options: SubscribeOptions = {}): () => void {
    if (options.replay !== false) for (const event of this.history) listener(event);
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /**
   * Async iteration over the full stream. Replays the backlog, yields live events, and completes
   * after a terminal event so `for await` loops actually finish.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<ScanEvent> {
    const queued: ScanEvent[] = [];
    let resume: (() => void) | undefined;
    const unsubscribe = this.subscribe((event) => { queued.push(event); resume?.(); resume = undefined; });
    try {
      while (true) {
        while (queued.length > 0) {
          const event = queued.shift()!;
          yield event;
          if (TERMINAL_EVENTS.has(event.type)) return;
        }
        if (this.terminated) return;
        await new Promise<void>((resolve) => { resume = resolve; });
      }
    } finally { unsubscribe(); }
  }
}
