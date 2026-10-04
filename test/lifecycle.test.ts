import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  SessionManager, ToolExecutionComponent, initTheme,
  type ExtensionContext, type ExtensionEvent, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { assistant, call, result, text, tick } from "./helpers.ts";

initTheme("dark", false);

async function harness() {
  const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const session = SessionManager.inMemory(process.cwd());
  let expanded = false;
  const components: ToolExecutionComponent[] = [];
  const ctx = {
    mode: "tui", hasUI: true, sessionManager: session,
    ui: {
      getToolsExpanded: () => expanded,
      setToolsExpanded: (value: boolean) => {
        expanded = value;
        components.forEach((c) => c.setExpanded(value));
      },
    },
  } as unknown as ExtensionContext;
  const emit = async (event: ExtensionEvent) => {
    for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, ctx);
    await tick();
  };
  const resolver = extension.toolRenderers![0];
  const addComponent = (id: string, name = "unknown_mcp", original?: ToolRenderers) => {
    const c = new ToolExecutionComponent(name, id, {}, {}, resolver(name, () => original), { requestRender() {} } as TUI, process.cwd());
    c.setExpanded(expanded);
    components.push(c);
    return c;
  };
  const render = () => components.flatMap((c) => c.render(80)).map(stripTerminalSequences).join("\n");
  return { extension, session, ctx, components, emit, resolver, addComponent, render };
}

test("extension loads through Pi's TypeScript loader without replacing tools or shortcuts", async () => {
  const { extension } = await harness();
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
  assert.equal(extension.shortcuts.size, 0);
  assert.equal(extension.toolRenderers?.length, 1);
});

test("reload can construct tool components before session_start without leaking previews", async () => {
  const h = await harness();
  h.session.appendMessage(assistant([call("a"), call("b")]));
  h.session.appendMessage(result("a")); h.session.appendMessage(result("b"));
  const a = h.addComponent("a"), b = h.addComponent("b");
  a.updateResult({ content: [text("PRIVATE a")], isError: false });
  b.updateResult({ content: [text("PRIVATE b")], isError: false });
  assert.doesNotMatch(h.render(), /PRIVATE/);
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), /Used 2 tools/);
  assert.doesNotMatch(h.render(), /PRIVATE/);
  h.ctx.ui.setToolsExpanded(true);
  assert.match(h.render(), /PRIVATE a/);
  assert.match(h.render(), /PRIVATE b/);
});

test("live message and tool events group streaming calls, ignore nested calls, and retain data", async () => {
  const h = await harness();
  await h.emit({ type: "session_start", reason: "startup" });
  const message = assistant([call("a"), call("b")]);
  const saved = JSON.stringify(message);
  await h.emit({ type: "message_start", message: assistant([]) });
  await h.emit({ type: "message_update", message, assistantMessageEvent: { type: "start", partial: message } });
  const a = h.addComponent("a"), b = h.addComponent("b");
  assert.match(h.render(), /Using 2 tools/);
  await h.emit({ type: "message_end", message });
  await h.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: { content: [text("secret")] }, isError: false });
  b.updateResult({ content: [text("secret")], isError: false });
  await h.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [text("error")] }, isError: true });
  a.updateResult({ content: [text("error")], isError: true });
  await h.emit({ type: "tool_execution_end", toolCallId: "a/0", parentToolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
  assert.match(h.render(), /\[1 failed\] Used 2 tools/);
  assert.doesNotMatch(h.render(), /secret/);
  h.ctx.ui.setToolsExpanded(true);
  assert.match(h.render(), /secret/);
  assert.equal(JSON.stringify(message), saved);
});

test("resume, reload, tree navigation, and compaction rebuild only the active transcript", async () => {
  const h = await harness();
  const first = h.session.appendMessage(assistant([call("a"), call("b")]));
  h.session.appendMessage(result("a")); h.session.appendMessage(result("b"));
  for (const reason of ["resume", "reload"] as const) {
    await h.emit({ type: "session_start", reason });
    h.components.length = 0;
    h.addComponent("a"); h.addComponent("b");
    assert.match(h.render(), /Used 2 tools/);
  }
  h.session.branch(first);
  const sibling = h.session.appendMessage({ role: "user", content: "new branch", timestamp: 3 });
  h.session.appendMessage(assistant([call("c")]));
  h.session.appendMessage(result("c"));
  await h.emit({ type: "session_tree", oldLeafId: first, newLeafId: h.session.getLeafId() });
  h.components.length = 0;
  h.addComponent("c");
  assert.match(h.render(), /\[done\] unknown_mcp/);
  assert.doesNotMatch(h.render(), /Used 3/);
  const compactionId = h.session.appendCompaction("earlier work", sibling, 100);
  const compactionEntry = h.session.getEntry(compactionId)!;
  assert.equal(compactionEntry.type, "compaction");
  if (compactionEntry.type !== "compaction") throw new Error("wrong fixture entry");
  await h.emit({ type: "session_compact", compactionEntry, fromExtension: false, reason: "manual", willRetry: false });
  h.components.length = 0;
  h.addComponent("c");
  assert.match(h.render(), /\[done\]/);
  await h.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(h.resolver("read", () => undefined), undefined);
});

test("non-TUI modes pass original renderers through and register no execution hooks", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = await harness();
    Object.assign(h.ctx, { mode });
    await h.emit({ type: "session_start", reason: "startup" });
    const original: ToolRenderers = { renderShell: "default" };
    assert.equal(h.resolver("read", () => original), original);
    for (const name of ["tool_call", "tool_result", "context", "message_end"]) {
      if (name !== "message_end") assert.equal(h.extension.handlers.has(name), false);
    }
  }
});

test("unknown tools in resumed sessions gain original formatting when resolved later", async () => {
  const h = await harness();
  h.session.appendMessage(assistant([call("mcp", "mcp__demo__read")]));
  h.session.appendMessage(result("mcp"));
  await h.emit({ type: "session_start", reason: "resume" });
  const unknown = h.addComponent("mcp");
  unknown.updateResult({ content: [text("fallback details")], isError: false });
  h.ctx.ui.setToolsExpanded(true);
  assert.match(h.render(), /fallback details/);
  let delegated = false;
  const registered: ToolRenderers = { renderCall: () => {
    delegated = true;
    return { render: () => ["registered formatting"], invalidate() {} };
  } };
  const known = h.addComponent("mcp", "mcp__demo__read", registered);
  known.render(80);
  assert.equal(delegated, true);
});
