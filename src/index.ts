import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "./groups.ts";
import { CompactRenderers } from "./renderers.ts";
import { readOptions } from "./settings.ts";
import { RoundTimings, TIMING_ENTRY, type TimingRecord } from "./timing.ts";

export default function expresso(pi: ExtensionAPI) {
  const groups = new ToolGroups();
  const timings = new RoundTimings((ids) => groups.refresh(ids));
  const persist = (record: TimingRecord | undefined) => {
    if (record) pi.appendEntry(TIMING_ENTRY, record);
  };
  let enabled = true;
  let ui: ExtensionContext["ui"] | undefined;
  const options = readOptions(undefined);
  // Pi rebuilds the transcript before session_start during /reload.
  const renderers = new CompactRenderers(groups, () => {
    if (ui) ui.setToolsExpanded(!ui.getToolsExpanded());
  }, options, (id) => options.timing === "response" ? timings.label(id)
    : timings.groupLabel(groups.rows.get(id)?.group ?? []), (id) => timings.activityFrame(id));

  const restore = (event: { type: string }, ctx: ExtensionContext) => {
    groups.reset();
    enabled = ctx.mode === "tui";
    ui = enabled ? ctx.ui : undefined;
    if (!enabled) {
      timings.dispose();
      return;
    }
    timings.restore(ctx.sessionManager.getBranch(), event.type === "session_compact");
    Object.assign(options, readOptions(pi.getSettings()));
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (entry.type === "custom") {
        // Older Expresso versions saved hidden throughput entries between tool calls.
        if (entry.customType !== TIMING_ENTRY && entry.customType !== "expresso:request-throughput") groups.boundary();
      } else {
        for (const message of sessionEntryToContextMessages(entry)) {
          groups.observe(message, "history");
        }
      }
    }
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_compact", restore);
  pi.on("session_shutdown", () => {
    try {
      if (enabled) persist(timings.finish());
    } finally {
      timings.dispose();
      groups.dispose();
      enabled = false;
      ui = undefined;
    }
  });
  pi.on("agent_start", () => {
    if (enabled) timings.start();
  });
  pi.on("agent_settled", () => {
    if (enabled) persist(timings.finish());
  });
  pi.on("message_start", (event) => {
    if (!enabled) return;
    if (event.message.role === "user") persist(timings.userMessage());
    timings.observe(event.message);
    groups.observe(event.message, "start");
  });
  pi.on("message_update", (event) => {
    if (!enabled) return;
    timings.observe(event.message);
    groups.observe(event.message, "update");
  });
  pi.on("message_end", (event) => {
    if (!enabled) return;
    timings.observe(event.message);
    groups.observe(event.message, "end");
    if (event.message.role === "toolResult") timings.executionEnd(event.message.toolCallId);
  });
  pi.on("tool_execution_start", (event) => {
    if (enabled && !event.parentToolCallId) timings.executionStart(event.toolCallId);
  });
  pi.on("tool_execution_update", (event) => {
    if (enabled && !event.parentToolCallId) {
      groups.result(event.toolCallId, event.partialResult?.content, false);
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (enabled && !event.parentToolCallId) {
      groups.result(event.toolCallId, event.result?.content, true, event.isError);
      timings.executionEnd(event.toolCallId);
    }
  });
  pi.registerToolRenderer((name, next) => {
    const original = next();
    return enabled ? renderers.wrap(name, original) : original;
  });
}
