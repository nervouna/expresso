import type { MessageStartEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

export const TIMING_ENTRY = "expresso:round-timing";
export interface TimingRecord {
  version: 1;
  toolCallIds: string[];
  elapsedMs: number;
  // Offsets from the response start; older version-1 records omit execution intervals.
  tools?: { id: string; startedMs: number; endedMs: number }[];
}

type Round = {
  startedAt: number;
  elapsedMs?: number;
  toolCallIds: Set<string>;
  prompted: boolean;
  responded: boolean;
  tools: Map<string, { startedMs: number; endedMs?: number }>;
};
type Schedule = (tick: () => void) => () => void;

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${remainingSeconds}s`;
}

function isTimingRecord(value: unknown): value is TimingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.elapsedMs === "number" &&
    Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 &&
    Array.isArray(record.toolCallIds) && record.toolCallIds.length > 0 &&
    record.toolCallIds.every((id) => typeof id === "string" && id.length > 0);
}

const scheduleSeconds: Schedule = (tick) => {
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => clearInterval(timer);
};

export class RoundTimings {
  private readonly byTool = new Map<string, Round>();
  private active?: Round;
  private cancelTick?: () => void;

  constructor(
    private readonly redraw: (toolCallIds: Iterable<string>) => void,
    private readonly now = () => performance.now(),
    private readonly schedule: Schedule = scheduleSeconds,
  ) {}

  start() {
    // Retries and automatic continuations can emit agent_start again before settlement.
    if (this.active) return;
    this.active = { startedAt: this.now(), toolCallIds: new Set(), prompted: false, responded: false, tools: new Map() };
    this.cancelTick = this.schedule(() => {
      if (this.active) this.redraw(this.active.toolCallIds);
    });
  }

  userMessage(): TimingRecord | undefined {
    const completed = this.active && (this.active.prompted || this.active.responded)
      ? this.finish() : undefined;
    this.start();
    this.active!.prompted = true;
    return completed;
  }

  observe(message: MessageStartEvent["message"]) {
    if (message.role !== "assistant" || !this.active) return;
    this.active.responded = true;
    for (const block of message.content) {
      if (block.type !== "toolCall" || !block.id) continue;
      this.active.toolCallIds.add(block.id);
      this.byTool.set(block.id, this.active);
    }
  }

  executionStart(id: string) {
    const round = this.byTool.get(id);
    if (!round || round !== this.active || round.tools.has(id)) return;
    round.tools.set(id, { startedMs: Math.max(0, this.now() - round.startedAt) });
    this.redraw(round.toolCallIds);
  }

  executionEnd(id: string) {
    const round = this.byTool.get(id);
    const tool = round?.tools.get(id);
    if (!round || !tool || tool.endedMs !== undefined) return;
    tool.endedMs = Math.max(tool.startedMs, this.now() - round.startedAt);
    this.redraw(round.toolCallIds);
  }

  // Derive the span from current membership because streamed images can split a group.
  groupLabel(rows: readonly { id: string; pending: boolean }[]): string | undefined {
    const round = this.byTool.get(rows[0]?.id);
    if (!round || rows.some((row) => this.byTool.get(row.id) !== round)) return undefined;
    const tools = rows.flatMap((row) => {
      const tool = round.tools.get(row.id);
      return tool ? [tool] : [];
    });
    if (!tools.length) return undefined;
    const running = round.elapsedMs === undefined && rows.some((row) => row.pending);
    const start = Math.min(...tools.map((tool) => tool.startedMs));
    const end = running ? this.now() - round.startedAt
      : Math.max(...tools.map((tool) => tool.endedMs ?? tool.startedMs));
    const duration = formatDuration(end - start);
    return running ? `${duration} elapsed` : `took ${duration}`;
  }

  label(toolCallId: string): string | undefined {
    const round = this.byTool.get(toolCallId);
    if (!round) return undefined;
    return round.elapsedMs === undefined
      ? `${formatDuration(this.now() - round.startedAt)} elapsed`
      : `took ${formatDuration(round.elapsedMs)}`;
  }

  activityFrame(toolCallId: string): number {
    const round = this.byTool.get(toolCallId);
    if (!round || round.elapsedMs !== undefined) return 0;
    return Math.floor(Math.max(0, this.now() - round.startedAt) / 1000) % 2;
  }

  finish(): TimingRecord | undefined {
    const round = this.active;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.active = undefined;
    if (!round) return undefined;
    round.elapsedMs = Math.max(0, this.now() - round.startedAt);
    for (const tool of round.tools.values()) tool.endedMs ??= round.elapsedMs;
    this.redraw(round.toolCallIds);
    if (round.toolCallIds.size === 0) return undefined;
    const tools = [...round.tools].map(([id, tool]) => ({
      id, startedMs: tool.startedMs, endedMs: tool.endedMs!,
    }));
    return { version: 1, toolCallIds: [...round.toolCallIds], elapsedMs: round.elapsedMs,
      ...(tools.length ? { tools } : {}),
    };
  }

  restore(entries: SessionEntry[], preserveActive = false) {
    if (!preserveActive) {
      this.cancelTick?.();
      this.cancelTick = undefined;
      this.active = undefined;
    }
    this.byTool.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== TIMING_ENTRY || !isTimingRecord(entry.data)) continue;
      const round: Round = {
        startedAt: 0, elapsedMs: entry.data.elapsedMs,
        toolCallIds: new Set(entry.data.toolCallIds), prompted: true, responded: true,
        tools: new Map(),
      };
      if (Array.isArray(entry.data.tools)) {
        for (const tool of entry.data.tools) {
          if (!tool || !round.toolCallIds.has(tool.id) ||
            !Number.isFinite(tool.startedMs) || !Number.isFinite(tool.endedMs) ||
            tool.startedMs < 0 || tool.endedMs < tool.startedMs || tool.endedMs > entry.data.elapsedMs) continue;
          round.tools.set(tool.id, { startedMs: tool.startedMs, endedMs: tool.endedMs });
        }
      }
      for (const id of round.toolCallIds) this.byTool.set(id, round);
    }
    if (this.active) {
      for (const id of this.active.toolCallIds) this.byTool.set(id, this.active);
    }
  }

  dispose() {
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.active = undefined;
    this.byTool.clear();
  }
}
