import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutionComponent, initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, setCapabilities, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createAllToolRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ToolGroups } from "../src/groups.ts";
import { CompactRenderers, oneLine } from "../src/renderers.ts";
import { assistant, call, png, text, tick } from "./helpers.ts";

initTheme("dark", false);
setCapabilities({ images: null, trueColor: true, hyperlinks: true });
const ui = { requestRender() {} } as TUI;
const plain = (component: ToolExecutionComponent, width = 100) => component.render(width).map(stripTerminalSequences);
const output = { content: [text("PRIVATE RESULT\nsecond line")], isError: false };
const mouse = (y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 100, height: 20, shift: false, alt: false, ctrl: false });

function setup(names = ["read", "bash"], originals: Record<string, ToolRenderers> = {}) {
  const groups = new ToolGroups();
  const calls = names.map((name, i) => call(String(i), name, { path: `${i}.txt`, command: "echo secret\nPRIVATE COMMAND", content: "PRIVATE CONTENT" }));
  groups.observe(assistant(calls), "history");
  let expanded = false;
  const renderers = new CompactRenderers(groups, () => {
    expanded = !expanded;
    for (const component of components) component.setExpanded(expanded);
  });
  const components = calls.map((c) => new ToolExecutionComponent(c.name, c.id, c.arguments, {}, renderers.wrap(c.name, originals[c.name]), ui, process.cwd()));
  const finish = (i: number, result = output, partial = false) => {
    groups.result(String(i), result.content, !partial, result.isError);
    components[i].updateResult(result, partial);
  };
  return { groups, renderers, components, finish };
}

test("real Pi components collapse a run to one content line and expand directly", async () => {
  const { components, finish } = setup();
  finish(0); finish(1);
  await tick();
  assert.deepEqual(components.flatMap((c) => plain(c)), ["", "Used 2 tools..."]);
  for (const c of components) c.setExpanded(true);
  const expanded = components.flatMap((c) => plain(c)).join("\n");
  assert.match(expanded, /PRIVATE RESULT/);
  assert.match(expanded, /PRIVATE COMMAND/);
  assert.match(expanded, /PRIVATE CONTENT/);
  for (const c of components) c.setExpanded(false);
  assert.deepEqual(components.flatMap((c) => plain(c)), ["", "Used 2 tools..."]);
});

test("standalone collapsed calls never leak argument bodies or output", () => {
  for (const name of ["read", "bash", "write", "edit", "codemode", "mcp__server__tool"]) {
    const { components: [c], finish } = setup([name]);
    finish(0);
    assert.equal(plain(c).length, 2);
    assert.match(plain(c)[1], /\[done\]/);
    assert.doesNotMatch(plain(c).join("\n"), /PRIVATE/);
  }
});

test("pending, partial, completed, and failed runs update their shared summary", async () => {
  const { components, finish } = setup();
  assert.match(plain(components[0])[1], /Using 2 tools.*2 pending/);
  finish(1, { content: [text("streaming")], isError: false }, true);
  finish(0);
  await tick();
  assert.match(plain(components[0])[1], /1 pending/);
  finish(1, { content: [text("private failure detail")], isError: true });
  await tick();
  assert.match(plain(components[0])[1], /1 failed/);
  assert.doesNotMatch(plain(components[0])[1], /private failure/);
});

test("header clicks use the vanilla global toggle", () => {
  const { components, finish } = setup();
  finish(0); finish(1);
  components.forEach((c) => c.render(100));
  assert.equal(components[0].handleMouse(mouse(1))?.handled, true);
  assert.match(plain(components[1]).join("\n"), /PRIVATE RESULT/);
  components[0].render(100);
  components[0].handleMouse(mouse(2));
  assert.deepEqual(plain(components[1]), []);
  const solo = setup(["read"]);
  solo.finish(0);
  solo.components[0].render(100);
  solo.components[0].handleMouse(mouse(1));
  assert.match(plain(solo.components[0]).join("\n"), /PRIVATE RESULT/);
});

test("clicking a standalone call keeps future calls on the global expansion state", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a")]), "history");
  let expanded = false;
  const components: ToolExecutionComponent[] = [];
  const renderers = new CompactRenderers(groups, () => {
    expanded = !expanded;
    components.forEach((c) => c.setExpanded(expanded));
  });
  const add = (id: string) => {
    const c = new ToolExecutionComponent("read", id, {}, {}, renderers.wrap("read"), ui, process.cwd());
    c.updateResult(output); c.setExpanded(expanded); components.push(c);
    return c;
  };
  const a = add("a");
  a.render(80); a.handleMouse(mouse(1));
  assert.equal(expanded, true);
  groups.observe(assistant([call("b")]), "history");
  assert.match(plain(add("b")).join("\n"), /PRIVATE RESULT/);
});

test("built-in expanded output matches vanilla framing and content", () => {
  const builtins = createAllToolRenderers();
  const cases: { name: keyof typeof builtins; args: Parameters<typeof call>[2]; details: unknown }[] = [
    { name: "read", args: { path: "sample.ts" }, details: undefined },
    { name: "bash", args: { command: "printf 'hello'\nprintf 'world'" }, details: undefined },
    { name: "write", args: { path: "sample.ts", content: "const a = 1;\nconst b = 2;" }, details: undefined },
    { name: "edit", args: { path: "sample.ts", oldText: "before", newText: "after" }, details: { diff: "-1 before\n+1 after", firstChangedLine: 1 } },
  ];
  for (const { name, args, details } of cases) {
    const original: ToolRenderers = name === "edit"
      ? { ...builtins.edit, renderShell: "self" }
      : builtins[name];
    const groups = new ToolGroups();
    groups.observe(assistant([call(name, name, args)]), "history");
    const renderers = new CompactRenderers(groups, () => {});
    const make = (renderer: ToolRenderers) => {
      const c = new ToolExecutionComponent(name, name, args, {}, renderer, ui, process.cwd());
      c.markExecutionStarted(); c.setArgsComplete();
      c.updateResult({ ...output, details });
      c.setExpanded(true);
      return c;
    };
    const vanilla = make(original);
    const compact = make(renderers.wrap(name, original));
    for (const width of [20, 80, 120]) assert.deepEqual(plain(compact, width), plain(vanilla, width), name);
  }
});

test("downstream lastComponent and shared state never contain wrapper components", () => {
  const seen = new Set<object>();
  const shared = new Set<object>();
  const originals: ToolRenderers = {
    renderCall(_args, _theme, ctx) {
      if (ctx.lastComponent) assert.ok(seen.has(ctx.lastComponent));
      shared.add(ctx.state);
      ctx.state.called = true;
      const c = new Text("original call", 0, 0); seen.add(c); return c;
    },
    renderResult(_result, _options, _theme, ctx) {
      assert.equal(ctx.state.called, true);
      if (ctx.lastComponent) assert.ok(seen.has(ctx.lastComponent));
      shared.add(ctx.state);
      const c = new Text("original result", 0, 0); seen.add(c); return c;
    },
  };
  const { components, finish } = setup(["custom", "custom"], { custom: originals });
  finish(0); finish(1);
  for (let i = 0; i < 3; i++) {
    for (const c of components) { c.setExpanded(true); c.render(80); c.setExpanded(false); c.render(80); }
  }
  assert.equal(shared.size, 2);
});

test("broken original renderers fall back to readable full details", () => {
  const broken = () => { throw new Error("renderer broken"); };
  for (const original of [
    { renderCall: broken, renderResult: broken },
    { renderCall: () => ({ render: broken, invalidate() {} }), renderResult: broken },
  ]) {
    const { components: [c], finish } = setup(["custom"], { custom: original });
    finish(0);
    c.setExpanded(true);
    assert.match(plain(c).join("\n"), /PRIVATE RESULT/);
    c.setExpanded(false);
    assert.doesNotMatch(plain(c).join("\n"), /PRIVATE/);
  }
});

test("headers handle missing arguments, ANSI, Unicode, newlines, and narrow widths", () => {
  assert.equal(oneLine("\x1b[31m你好\x1b[0m\nsecret"), "你好");
  const groups = new ToolGroups();
  const renderer = new CompactRenderers(groups, () => {}).wrap("tool");
  for (const args of [undefined, null, {}, { path: "\x1b[31m文件👋\x1b[0m\nPRIVATE" }, { command: "echo hi\rPRIVATE" }]) {
    const c = new ToolExecutionComponent("tool", "unknown", args, {}, renderer, ui, process.cwd());
    for (const width of [1, 2, 3, 8, 20, 80]) {
      const lines = c.render(width);
      assert.equal(lines.length, 2);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /PRIVATE/);
    }
  }
});

test("inline image sequences survive collapse, expansion, and regrouping unchanged", async () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
  try {
    const { groups, components, finish } = setup(["read", "read", "read", "read"]);
    finish(0); finish(2); finish(3);
    groups.result("1", [png], true);
    components[1].updateResult({ content: [png, text("image description")], isError: false });
    await tick();
    const imageLines = (c: ToolExecutionComponent) => c.render(100).filter((line) => line.includes("\x1b]1337;File="));
    const collapsed = imageLines(components[1]);
    assert.equal(collapsed.length, 1);
    assert.match(plain(components[0])[1], /\[done\] read/);
    assert.match(plain(components[2])[1], /Used 2 tools/);
    components[1].setExpanded(true);
    assert.deepEqual(imageLines(components[1]), collapsed);
    components[1].setExpanded(false);
    assert.deepEqual(imageLines(components[1]), collapsed);
  } finally {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  }
});

test("theme changes rebuild styled headers without changing compact content", () => {
  const { components: [c], finish } = setup(["read"]);
  finish(0);
  const before = c.render(80);
  initTheme("light", false); c.invalidate();
  const after = c.render(80);
  assert.notDeepEqual(before, after);
  assert.deepEqual(before.map(stripTerminalSequences), after.map(stripTerminalSequences));
  initTheme("dark", false);
});

test("HTML export retains full results for hidden siblings and does not disturb TUI state", () => {
  const { renderers, components, finish } = setup(["custom", "custom"]);
  finish(0); finish(1);
  const before = components.flatMap((c) => c.render(80));
  const html = createToolHtmlRenderer({ getToolRenderers: (name) => renderers.wrap(name), theme, cwd: process.cwd() });
  for (const id of ["0", "1"]) {
    html.renderCall(id, "custom", { code: "full arguments" });
    const result = html.renderResult(id, "custom", output.content, undefined, false);
    assert.match(result!.expanded!, /PRIVATE RESULT/);
  }
  assert.deepEqual(components.flatMap((c) => c.render(80)), before);
});
