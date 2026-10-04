import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  SessionManager, SettingsManager, ToolExecutionComponent, initTheme,
  type ExtensionContext, type ExtensionEvent, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { assistant, call, result, text, tick } from "./helpers.ts";
import { TIMING_ENTRY } from "../src/timing.ts";
import { THROUGHPUT_ENTRY } from "../src/throughput.ts";

initTheme("dark", false);

async function harness() {
  const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const settings = SettingsManager.inMemory({ expresso: { timing: "response" } } as Parameters<typeof SettingsManager.inMemory>[0]);
  loaded.runtime.getSettings = () => settings.getSettings();
  const session = SessionManager.inMemory(process.cwd());
  loaded.runtime.appendEntry = (type, data) => { session.appendCustomEntry(type, data); };
  let expanded = false;
  let renders = 0;
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
    const c = new ToolExecutionComponent(name, id, {}, {}, resolver(name, () => original), { requestRender() { renders++; } } as TUI, process.cwd());
    c.setExpanded(expanded);
    components.push(c);
    return c;
  };
  const render = () => components.flatMap((c) => c.render(80)).map(stripTerminalSequences).join("\n");
  const setSettings = (value: unknown) => settings.applyOverrides(value as Parameters<typeof settings.applyOverrides>[0]);
  const message = async (message: Parameters<typeof session.appendMessage>[0]) => {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    return session.appendMessage(message);
  };
  return { extension, session, ctx, components, emit, message, resolver, addComponent, render, setSettings,
    get renders() { return renders; },
  };
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

test("saved throughput metadata does not split adjacent tool groups on reload", async () => {
  const h = await harness();
  h.session.appendMessage(assistant([call("a")]));
  h.session.appendMessage(result("a"));
  h.session.appendCustomEntry(THROUGHPUT_ENTRY, { version: 1, output: 100, elapsedMs: 2000 });
  h.session.appendMessage(assistant([call("b")]));
  h.session.appendMessage(result("b"));
  await h.emit({ type: "session_start", reason: "reload" });
  h.addComponent("a"); h.addComponent("b");
  assert.match(h.render(), /Used 2 tools/);
});

test("Nerd Font settings update existing pre-start rows on reload and can be turned off", async () => {
  const h = await harness();
  h.setSettings({ expresso: { nerdFonts: true } });
  h.session.appendMessage(assistant([call("a"), call("b")]));
  h.session.appendMessage(result("a")); h.session.appendMessage(result("b"));
  const a = h.addComponent("a"), b = h.addComponent("b");
  a.updateResult({ content: [text("PRIVATE a")], isError: false });
  b.updateResult({ content: [text("PRIVATE b")], isError: false });
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), / Used 2 tools/);
  assert.doesNotMatch(h.render(), /PRIVATE/);
  h.ctx.ui.setToolsExpanded(true);
  assert.match(h.render(), /PRIVATE b/);
  h.ctx.ui.setToolsExpanded(false);
  assert.match(h.render(), / Used 2 tools/);
  h.setSettings({ expresso: { nerdFonts: false } });
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), /Used 2 tools/);
  assert.doesNotMatch(h.render(), //);
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
  assert.ok(compactionEntry.type === "compaction");
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
    await h.emit({ type: "agent_start" });
    await h.emit({ type: "message_start", message: assistant([call("a")]) });
    await h.emit({ type: "agent_settled" });
    assert.equal(h.session.getEntries().length, 0);
    for (const name of ["tool_call", "tool_result", "context"]) {
      assert.equal(h.extension.handlers.has(name), false);
    }
  }
});

test("round timing keeps ticking after tools finish and freezes only at settlement", async (t) => {
  const h = await harness();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.after(() => h.emit({ type: "session_shutdown", reason: "quit" }));
  await h.emit({ type: "session_start", reason: "startup" });
  await h.emit({ type: "agent_start" });
  await h.message({ role: "user", content: "work", timestamp: 1 });
  now = 36_000;
  await h.message(assistant([call("a"), call("b")]));
  h.addComponent("a"); h.addComponent("b");
  assert.match(h.render(), /Using 2 tools \(2 pending\), 36s elapsed/);
  await h.message(result("a")); await h.message(result("b"));
  await h.message(assistant([text("Still checking.")]));
  await h.message(assistant([call("c")]));
  h.addComponent("c");
  await h.message(result("c"));
  now = 42_000;
  assert.match(h.render(), /Used 2 tools, 42s elapsed/);
  assert.match(h.render(), /\[done\] unknown_mcp, 42s elapsed/);
  const beforeTick = h.renders;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(h.renders > beforeTick, "the shared timer invalidates compact summaries without tool updates");
  await h.emit({ type: "agent_end", messages: [] });
  await h.emit({ type: "agent_start" });
  now = 48_000;
  assert.match(h.render(), /48s elapsed/);
  const originalEntries = structuredClone(h.session.getEntries());
  await h.emit({ type: "agent_settled" });
  assert.equal((h.render().match(/took 48s/g) ?? []).length, 2);
  const entries = h.session.getEntries();
  assert.deepEqual(entries.slice(0, -1), originalEntries);
  const saved = entries.at(-1)!;
  assert.ok(saved.type === "custom");
  assert.equal(saved.customType, TIMING_ENTRY);
  assert.deepEqual(saved.data, { version: 1, elapsedMs: 48_000, toolCallIds: ["a", "b", "c"] });
  assert.equal(h.session.buildSessionContext().messages.some((m) => JSON.stringify(m).includes(TIMING_ENTRY)), false);
  now = 98_000;
  await h.emit({ type: "agent_settled" });
  assert.equal(h.session.getEntries().length, entries.length);
  await h.emit({ type: "session_start", reason: "reload" });
  assert.equal((h.render().match(/took 48s/g) ?? []).length, 2);
  h.ctx.ui.setToolsExpanded(true);
  assert.doesNotMatch(h.render(), /elapsed|took/);
});

test("default group timing freezes completed bars and restores both timing modes", async (t) => {
  const h = await harness();
  h.setSettings({ expresso: { timing: "group" } });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.after(() => h.emit({ type: "session_shutdown", reason: "quit" }));
  await h.emit({ type: "session_start", reason: "startup" });
  await h.emit({ type: "agent_start" });
  await h.message(assistant([call("a"), call("b")]));
  h.addComponent("a"); h.addComponent("b");
  assert.doesNotMatch(h.render(), /elapsed|took/);
  now = 10_000;
  for (const id of ["a", "b"]) {
    await h.emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} });
  }
  now = 13_000;
  await h.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
  await h.message(result("a"));
  assert.match(h.render(), /3s elapsed/);
  now = 15_000;
  await h.message(result("b"));
  await h.message(assistant([text("Final answer")], "stop"));
  now = 45_000;
  assert.match(h.render(), /Used 2 tools, took 5s/);
  assert.doesNotMatch(h.render(), /elapsed/);
  await h.emit({ type: "agent_settled" });
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), /Used 2 tools, took 5s/);
  h.setSettings({ expresso: { timing: "response" } });
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), /Used 2 tools, took 45s/);
});

test("saved timing follows the active branch and survives compaction", async () => {
  const h = await harness();
  const first = h.session.appendMessage(assistant([call("a"), call("b")]));
  h.session.appendMessage(result("a")); h.session.appendMessage(result("b"));
  const completed = h.session.appendCustomEntry(TIMING_ENTRY, { version: 1, elapsedMs: 63_000, toolCallIds: ["a", "b"] });
  h.addComponent("a"); h.addComponent("b");
  await h.emit({ type: "session_start", reason: "resume" });
  assert.match(h.render(), /Used 2 tools, took 1m 03s/);
  h.session.branch(first);
  await h.emit({ type: "session_tree", oldLeafId: completed, newLeafId: first });
  assert.doesNotMatch(h.render(), /elapsed|took/);
  h.session.branch(completed);
  const id = h.session.appendCompaction("summary", first, 100);
  const compactionEntry = h.session.getEntry(id)!;
  if (compactionEntry.type !== "compaction") throw new Error("bad fixture");
  await h.emit({ type: "session_compact", compactionEntry, fromExtension: false, reason: "manual", willRetry: false });
  assert.match(h.render(), /Used 2 tools, took 1m 03s/);
});

test("automatic compaction preserves the active round and orderly shutdown freezes it", async (t) => {
  const h = await harness();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.after(() => h.emit({ type: "session_shutdown", reason: "quit" }));
  await h.emit({ type: "session_start", reason: "startup" });
  await h.emit({ type: "agent_start" });
  const first = await h.message(assistant([call("a")]));
  await h.message(result("a"));
  h.addComponent("a");
  now = 30_000;
  const id = h.session.appendCompaction("summary", first, 100);
  const compactionEntry = h.session.getEntry(id)!;
  if (compactionEntry.type !== "compaction") throw new Error("bad fixture");
  await h.emit({ type: "session_compact", compactionEntry, fromExtension: false, reason: "overflow", willRetry: true });
  await h.emit({ type: "agent_start" });
  now = 36_000;
  assert.match(h.render(), /36s elapsed/);
  await h.emit({ type: "session_shutdown", reason: "reload" });
  now = 90_000;
  await h.emit({ type: "session_start", reason: "reload" });
  assert.match(h.render(), /took 36s/);
});

test("a queued user prompt gets its own duration without ending the agent run", async (t) => {
  const h = await harness();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.after(() => h.emit({ type: "session_shutdown", reason: "quit" }));
  await h.emit({ type: "session_start", reason: "startup" });
  await h.emit({ type: "agent_start" });
  await h.message({ role: "user", content: "first", timestamp: 1 });
  await h.message(assistant([call("a")]));
  h.addComponent("a");
  await h.message(result("a"));
  now = 10_000;
  await h.message({ role: "user", content: "second", timestamp: 2 });
  await h.message(assistant([call("b")]));
  h.addComponent("b");
  now = 12_000;
  assert.match(h.render(), /took 10s/);
  assert.match(h.render(), /2s elapsed/);
  await h.emit({ type: "agent_settled" });
  assert.match(h.render(), /took 2s/);
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
