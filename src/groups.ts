import type { MessageStartEvent } from "@earendil-works/pi-coding-agent";

type Message = MessageStartEvent["message"];
type Slot = { boundary: boolean; ids: string[] };
export type ToolRow = {
  id: string;
  name: string;
  pending: boolean;
  error: boolean;
  image: boolean;
  group: ToolRow[];
  listeners: Set<WeakRef<Redraw>>;
};
export type Redraw = { redraw(compactOnly?: boolean): void };

export class ToolGroups {
  readonly rows = new Map<string, ToolRow>();
  private slots: Slot[] = [];
  private listeners = new Map<string, Set<WeakRef<Redraw>>>();
  private streaming?: Slot;
  private dirty = new Map<ToolRow, boolean>();
  private scheduled = false;
  private disposed = false;

  reset() {
    this.disposed = false;
    this.touch([...this.rows.values()]);
    this.rows.clear();
    this.slots = [];
    this.streaming = undefined;
  }

  dispose() {
    this.disposed = true;
    this.dirty.clear();
    this.rows.clear();
    this.slots = [];
    this.streaming = undefined;
    this.listeners.clear();
  }

  boundary() {
    this.slots.push({ boundary: true, ids: [] });
    this.streaming = undefined;
  }

  observe(message: Message, phase: "start" | "update" | "end" | "history") {
    if (message.role === "toolResult") {
      this.result(message.toolCallId, message.content, phase !== "update", message.isError);
      return;
    }
    if (message.role !== "assistant") {
      if (phase === "start" || phase === "history") {
        if (message.role !== "system" && !(message.role === "custom" && !message.display)) {
          this.boundary();
        }
      }
      return;
    }

    if (phase === "start" || phase === "history" || !this.streaming) {
      this.streaming = { boundary: false, ids: [] };
      this.slots.push(this.streaming);
    }
    const slot = this.streaming;
    const calls = message.content.filter((block) => block.type === "toolCall");
    const ids = calls.map((call) => call.id);
    const boundary = message.content.some((block) =>
      (block.type === "text" && !!block.text.trim()) ||
      (block.type === "thinking" && !!block.thinking.trim()),
    ) || message.stopReason === "length" ||
      (calls.length === 0 && (message.stopReason === "error" || message.stopReason === "aborted"));
    for (const call of calls) {
      if (!this.rows.has(call.id)) {
        const row: ToolRow = {
          id: call.id, name: call.name, pending: true, error: false,
          image: false, group: [], listeners: this.listeners.get(call.id) ?? new Set(),
        };
        row.group = [row];
        this.listeners.set(call.id, row.listeners);
        this.rows.set(call.id, row);
        this.touch([row]);
      }
    }
    if (slot.boundary !== boundary || slot.ids.join("\0") !== ids.join("\0")) {
      slot.boundary = boundary;
      slot.ids = ids;
      this.regroup();
    }
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      for (const id of ids) this.result(id, undefined, true, true);
    }
    if (phase === "end" || phase === "history") this.streaming = undefined;
  }

  result(id: string, content: unknown, complete: boolean, error = false) {
    const row = this.rows.get(id);
    if (!row) return;
    const image = Array.isArray(content)
      ? content.some((block) => block?.type === "image") : row.image;
    const changed = row.pending !== !complete || row.error !== error || row.image !== image;
    const regroup = row.image !== image;
    row.pending = !complete;
    row.error = error;
    row.image = image;
    if (regroup) this.regroup();
    if (changed) this.touch(row.group);
  }

  refresh(ids: Iterable<string>) {
    const leaders = new Set<ToolRow>();
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) leaders.add(row.group[0]);
    }
    if (leaders.size) this.touch([...leaders], true);
  }

  subscribe(id: string, listener: Redraw) {
    let listeners = this.listeners.get(id);
    if (!listeners) this.listeners.set(id, listeners = new Set());
    listeners.add(new WeakRef(listener));
  }

  private regroup() {
    const groups: ToolRow[][] = [];
    let group: ToolRow[] = [];
    const flush = () => {
      if (group.length) groups.push(group);
      group = [];
    };
    for (const slot of this.slots) {
      if (slot.boundary) flush();
      for (const id of slot.ids) {
        const row = this.rows.get(id)!;
        if (row.image) {
          flush();
          groups.push([row]);
        } else {
          group.push(row);
        }
      }
    }
    flush();
    for (const next of groups) {
      for (const row of next) {
        if (row.group.length !== next.length || row.group.some((old, i) => old !== next[i])) {
          this.touch(row.group);
          row.group = next;
          this.touch(next);
        }
      }
    }
  }

  private touch(rows: ToolRow[], compactOnly = false) {
    // A clock tick must not downgrade an already queued full invalidation.
    for (const row of rows) this.dirty.set(row, compactOnly && this.dirty.get(row) !== false);
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      const dirty = [...this.dirty];
      this.dirty.clear();
      for (const [row, compactOnly] of dirty) {
        for (const ref of row.listeners) {
          const listener = ref.deref();
          if (listener) listener.redraw(compactOnly);
          else row.listeners.delete(ref);
        }
      }
    });
  }
}
