import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "./groups.ts";
import { CompactRenderers } from "./renderers.ts";
import { readOptions } from "./settings.ts";

export default function expresso(pi: ExtensionAPI) {
  const groups = new ToolGroups();
  let enabled = true;
  let ui: ExtensionContext["ui"] | undefined;
  const options = readOptions(undefined);
  // Pi rebuilds the transcript before session_start during /reload.
  const renderers = new CompactRenderers(groups, () => {
    if (ui) ui.setToolsExpanded(!ui.getToolsExpanded());
  }, options);

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    groups.reset();
    enabled = ctx.mode === "tui";
    ui = enabled ? ctx.ui : undefined;
    if (!enabled) return;
    Object.assign(options, readOptions(pi.getSettings()));
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (entry.type === "custom") {
        groups.boundary();
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
    groups.dispose();
    enabled = false;
    ui = undefined;
  });
  pi.on("message_start", (event) => {
    if (enabled) groups.observe(event.message, "start");
  });
  pi.on("message_update", (event) => {
    if (enabled) groups.observe(event.message, "update");
  });
  pi.on("message_end", (event) => {
    if (enabled) groups.observe(event.message, "end");
  });
  pi.on("tool_execution_update", (event) => {
    if (enabled && !event.parentToolCallId) {
      groups.result(event.toolCallId, event.partialResult?.content, false);
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (enabled && !event.parentToolCallId) {
      groups.result(event.toolCallId, event.result?.content, true, event.isError);
    }
  });
  pi.registerToolRenderer((name, next) => {
    const original = next();
    return enabled ? renderers.wrap(name, original) : original;
  });
}
