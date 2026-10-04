import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutionComponent, initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, mixColors, setCapabilities, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
const padded = (label: string, width = 100) => [
  "", " ".repeat(width), ` ${label}${" ".repeat(Math.max(0, width - 1 - visibleWidth(label)))}`, " ".repeat(width),
];
const compactBackground = (line: string, failed: boolean) => failed
  ? theme.style(line, { bg: mixColors(theme.colors.toolPendingBg, theme.colors.warning, 0.12, "srgb") })
  : theme.bg("toolPendingBg", line);
const output = { content: [text("PRIVATE RESULT\nsecond line")], isError: false };
const mouse = (y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 100, height: 20, shift: false, alt: false, ctrl: false });

function setup(names = ["read", "bash"], originals: Record<string, ToolRenderers> = {}, nerdFonts = false,
  timingLabel?: (id: string) => string | undefined) {
  const groups = new ToolGroups();
  const calls = names.map((name, i) => call(String(i), name, { path: `${i}.txt`, command: "echo secret\nPRIVATE COMMAND", content: "PRIVATE CONTENT" }));
  groups.observe(assistant(calls), "history");
  let expanded = false;
  const renderers = new CompactRenderers(groups, () => {
    expanded = !expanded;
    for (const component of components) component.setExpanded(expanded);
  }, { nerdFonts }, timingLabel);
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
  assert.deepEqual(components.flatMap((c) => plain(c)), padded("Used 2 tools"));
  for (const c of components) c.setExpanded(true);
  const expanded = components.flatMap((c) => plain(c)).join("\n");
  assert.match(expanded, /PRIVATE RESULT/);
  assert.match(expanded, /PRIVATE COMMAND/);
  assert.match(expanded, /PRIVATE CONTENT/);
  for (const c of components) c.setExpanded(false);
  assert.deepEqual(components.flatMap((c) => plain(c)), padded("Used 2 tools"));
});

test("standalone collapsed calls never leak argument bodies or output", () => {
  for (const name of ["read", "bash", "write", "edit", "codemode", "mcp__server__tool"]) {
    const { components: [c], finish } = setup([name]);
    finish(0);
    assert.equal(plain(c).length, 4);
    assert.match(plain(c)[2], /\[done\]/);
    assert.doesNotMatch(plain(c).join("\n"), /PRIVATE/);
  }
});

test("pending, partial, completed, and failed runs update their shared summary", async () => {
  const { components, finish } = setup();
  assert.match(plain(components[0])[2], /Using 2 tools.*2 pending/);
  finish(1, { content: [text("streaming")], isError: false }, true);
  finish(0);
  await tick();
  assert.match(plain(components[0])[2], /1 pending/);
  finish(1, { content: [text("private failure detail")], isError: true });
  await tick();
  assert.match(plain(components[0])[2], /1 failed/);
  assert.doesNotMatch(plain(components[0])[2], /private failure/);
});

test("compact failures use warning text and a subtle tint with vanilla padding", () => {
  const check = (components: ToolExecutionComponent[], label: string, status: "pending" | "success" | "error") => {
    const color = status === "error" ? "warning" : "muted";
    const vanilla = new ToolExecutionComponent("reference", "reference", {}, {}, {
      renderCall: (_args, currentTheme) => ({
        render: (width) => [currentTheme.fg(color, truncateToWidth(label, width))],
        invalidate() {},
      }),
      renderResult: () => ({ render: () => [], invalidate() {} }),
    }, ui, process.cwd());
    vanilla.updateResult({ content: [], isError: status === "error" }, status !== "error");
    for (const width of [3, 8, 20, 80, 120]) {
      const lines = components.flatMap((c) => c.render(width));
      assert.deepEqual(lines.map(stripTerminalSequences), vanilla.render(width).map(stripTerminalSequences));
      assert.equal(lines.length, 4);
      assert.equal(lines[1], compactBackground(" ".repeat(width), status === "error"));
      const header = theme.fg(color, stripTerminalSequences(truncateToWidth(label, width - 2)));
      assert.equal(lines[2], compactBackground(` ${header}${" ".repeat(width - 1 - visibleWidth(header))}`, status === "error"));
      assert.equal(lines[3], lines[1]);
      if (status === "error") {
        assert.notEqual(lines[1], theme.bg("toolErrorBg", " ".repeat(width)));
      }
      assert.deepEqual(components.slice(1).flatMap((c) => c.render(width)), []);
    }
  };
  try {
    for (const name of ["dark", "light"]) {
      initTheme(name, false);
      const solo = setup(["read"]);
      check(solo.components, "[pending] read 0.txt", "pending");
      solo.components[0].markExecutionStarted();
      check(solo.components, "[running] read 0.txt", "pending");
      solo.finish(0);
      check(solo.components, "[done] read 0.txt", "success");
      solo.finish(0, { ...output, isError: true });
      check(solo.components, "[failed] read 0.txt", "error");

      const group = setup();
      check(group.components, "Using 2 tools (2 pending)", "pending");
      group.finish(1);
      check(group.components, "Using 2 tools (1 pending)", "pending");
      group.finish(1, { ...output, isError: true });
      check(group.components, "[1 failed] Using 2 tools (1 pending)", "error");
      group.finish(0);
      check(group.components, "[1 failed] Used 2 tools", "error");
      group.finish(1);
      check(group.components, "Used 2 tools", "success");
    }
  } finally {
    initTheme("dark", false);
  }
});

test("Nerd Font standalone statuses use the agreed clock, spinner, check, and cross", () => {
  const { components: [c], finish } = setup(["read"], {}, true);
  assert.deepEqual(plain(c), padded(" read 0.txt"));
  c.markExecutionStarted();
  assert.deepEqual(plain(c), padded(" read 0.txt"));
  finish(0, output, true);
  assert.deepEqual(plain(c), padded(" read 0.txt"));
  finish(0);
  assert.deepEqual(plain(c), padded(" read 0.txt"));
  finish(0, { ...output, isError: true });
  assert.deepEqual(plain(c), padded(" read 0.txt"));
});

test("Nerd Font groups distinguish running, success, and completed failures", () => {
  const { components, finish } = setup(["read", "bash", "write"], {}, true);
  const check = (label: string, failed = false) => {
    assert.deepEqual(components.flatMap((c) => plain(c)), padded(label));
    const lines = components[0].render(100);
    assert.equal(lines[1], compactBackground(" ".repeat(100), failed));
    assert.ok(lines[2].includes(theme.fg(failed ? "warning" : "muted", label)));
    assert.deepEqual(components.slice(1).flatMap((c) => plain(c)), []);
  };
  check(" Using 3 tools");
  finish(2);
  check(" Using 3 tools");
  finish(1, { ...output, isError: true });
  check(" Using 3 tools ( 1)", true);
  finish(0);
  check(" Used 3 tools ( 1)", true);
  finish(0, { ...output, isError: true });
  check(" Used 3 tools ( 2)", true);
  finish(0); finish(1);
  check(" Used 3 tools");
});

test("Nerd Font glyphs remain width-safe and expanded output is unchanged", () => {
  const icons = setup(["read", "bash"], {}, true);
  const words = setup(["read", "bash"]);
  for (const fixture of [icons, words]) { fixture.finish(0); fixture.finish(1); }
  for (const width of [1, 2, 3, 4, 8, 20, 80]) {
    const lines = icons.components.flatMap((c) => c.render(width));
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  for (const fixture of [icons, words]) fixture.components.forEach((c) => c.setExpanded(true));
  assert.deepEqual(icons.components.flatMap((c) => c.render(100)), words.components.flatMap((c) => c.render(100)));
});

test("timing stays muted for successful and failed blocks in both themes and icon modes", () => {
  try {
    for (const themeName of ["dark", "light"]) {
      initTheme(themeName, false);
      for (const nerdFonts of [false, true]) {
        for (const names of [["read"], ["read", "bash"]]) {
          let timing = "36s elapsed";
          const fixture = setup(names, {}, nerdFonts, () => timing);
          const header = () => fixture.components[0].render(100)[2];
          assert.match(stripTerminalSequences(header()), /, 36s elapsed/);
          for (let i = 0; i < names.length; i++) fixture.finish(i);
          assert.match(stripTerminalSequences(header()), /, 36s elapsed/);
          fixture.finish(0, { ...output, isError: true });
          timing = "took 1h 02m 05s";
          assert.match(stripTerminalSequences(header()), /, took 1h 02m 05s/);
          assert.ok(header().includes(theme.fg("muted", `, ${timing}`)));
          assert.deepEqual(fixture.components.slice(1).flatMap((c) => plain(c)), []);
          for (const width of [1, 2, 3, 8, 20, 40, 80]) {
            const lines = fixture.components.flatMap((c) => c.render(width));
            assert.equal(lines.length, 4);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
          }
          for (const c of fixture.components) c.setExpanded(true);
          assert.doesNotMatch(fixture.components.flatMap((c) => plain(c)).join("\n"), /elapsed|took/);
        }
      }
    }
  } finally {
    initTheme("dark", false);
  }
});

test("long standalone identifiers preserve the timer, status, and tool name", () => {
  try {
    for (const themeName of ["dark", "light"]) {
      initTheme(themeName, false);
      for (const nerdFonts of [false, true]) {
        for (const key of ["path", "file_path", "command", "url"]) {
          for (const failed of [false, true]) {
            const args = { [key]: `\x1b[31m${"文件👋é".repeat(30)}TAIL\x1b[0m\nPRIVATE SECOND LINE` };
            const groups = new ToolGroups();
            groups.observe(assistant([call("long", "read", args)]), "history");
            groups.result("long", [], true, failed);
            let timing = "36s elapsed";
            const renderers = new CompactRenderers(groups, () => {}, { nerdFonts }, () => timing);
            const c = new ToolExecutionComponent("read", "long", args, {}, renderers.wrap("read"), ui, process.cwd());
            c.updateResult({ content: [], isError: failed });
            const prefix = `${nerdFonts ? failed ? "" : "" : failed ? "[failed]" : "[done]"} read`;
            for (timing of ["36s elapsed", "took 48s", "took 1m 03s", "took 1h 02m 05s"]) {
              const minimum = visibleWidth(`${prefix}, ${timing}`) + 2;
              for (const width of [minimum, minimum + 1, minimum + 2, minimum + 8, 80]) {
                const lines = c.render(width);
                const header = stripTerminalSequences(lines[2]).trim();
                assert.ok(header.startsWith(prefix));
                assert.ok(header.endsWith(`, ${timing}`));
                assert.ok(lines[2].includes(theme.fg("muted", `, ${timing}`)));
                assert.equal(lines.length, 4);
                assert.ok(lines.every((line) => visibleWidth(line) <= width));
                assert.doesNotMatch(header, /TAIL|PRIVATE/);
                if (width === minimum) assert.equal(header, `${prefix}, ${timing}`);
              }
              for (const width of [1, 2, 3, 8, minimum - 1]) {
                const lines = c.render(width);
                assert.equal(lines.length, 4);
                assert.ok(lines.every((line) => visibleWidth(line) <= width));
              }
              assert.ok(plain(c, minimum - 1)[2].trim().startsWith(prefix));
            }
            c.setExpanded(true);
            assert.match(plain(c, 120).join("\n"), /TAIL/);
            assert.doesNotMatch(plain(c, 120).join("\n"), /took|elapsed/);
          }
        }
      }
    }
  } finally {
    initTheme("dark", false);
  }
});

test("truncated headers retain foreground and background through ellipses and padding", () => {
  const paintedCharacters = (line: string) => {
    let fg: string | undefined, bg: string | undefined;
    const characters: { text: string; fg?: string; bg?: string }[] = [];
    for (const match of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
      if (match[2] !== undefined) {
        for (const text of match[2]) characters.push({ text, fg, bg });
        continue;
      }
      const codes = match[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) { fg = undefined; bg = undefined; }
        else if (code === 39) fg = undefined;
        else if (code === 49) bg = undefined;
        else if (code === 38 || code === 48) {
          const length = codes[i + 1] === 2 ? 5 : 3;
          const color = codes.slice(i, i + length).join(";");
          if (code === 38) fg = color;
          else bg = color;
          i += length - 1;
        }
      }
    }
    return characters;
  };
  try {
    for (const themeName of ["dark", "light"]) {
      initTheme(themeName, false);
      for (const nerdFonts of [false, true]) {
        for (const failed of [false, true]) {
          for (const timing of [undefined, "36s elapsed", "took 1h 02m 05s"]) {
            const renderers = new CompactRenderers(new ToolGroups(), () => {}, { nerdFonts }, () => timing);
            const c = new ToolExecutionComponent("bash", "long", { command: "echo 文件👋 ".repeat(40) }, {},
              renderers.wrap("bash"), ui, process.cwd());
            c.updateResult({ content: [], isError: failed });
            const background = paintedCharacters(compactBackground("x", failed))[0].bg;
            const foreground = paintedCharacters(theme.fg(failed ? "warning" : "muted", "x"))[0].fg;
            const muted = paintedCharacters(theme.fg("muted", "x"))[0].fg;
            assert.ok(background && foreground && muted);
            for (const width of [1, 2, 3, 8, 24, 40, 80]) {
              const line = c.render(width)[2];
              const characters = paintedCharacters(line);
              assert.ok(characters.some((c) => c.text === "."), "fixture must truncate");
              let inTiming = false;
              for (const character of characters) {
                assert.equal(character.bg, background, `background lost at ${JSON.stringify(character.text)}`);
                if (character.text === ",") inTiming = true;
                if (character.text.trim()) {
                  assert.equal(character.fg, inTiming ? muted : foreground,
                    `foreground lost at ${JSON.stringify(character.text)}`);
                }
              }
              assert.ok(visibleWidth(line) <= width);
            }
          }
        }
      }
    }
  } finally {
    initTheme("dark", false);
  }
});

test("short standalone identifiers and missing timing keep their existing layout", () => {
  for (const timing of [undefined, "took 48s"]) {
    const { components: [c], finish } = setup(["read"], {}, false, () => timing);
    finish(0);
    assert.deepEqual(plain(c), padded(`[done] read 0.txt${timing ? `, ${timing}` : ""}`));
  }
});

test("clock ticks do not invalidate expanded downstream renderers", async () => {
  let calls = 0;
  const h = setup(["read"], { read: { renderCall: () => {
    calls++;
    return new Text("original details", 0, 0);
  } } }, false, () => "1s elapsed");
  await tick();
  h.components[0].setExpanded(true);
  plain(h.components[0]);
  const before = calls;
  h.groups.refresh(["0"]);
  await tick();
  plain(h.components[0]);
  assert.equal(calls, before);
});

test("compact padding and headers remain clickable across the full block width", () => {
  for (const y of [1, 2, 3]) {
    for (const x of [0, 1, 99]) {
      const { components, finish } = setup();
      finish(0); finish(1);
      components[0].render(100);
      assert.equal(components[0].handleMouse({ ...mouse(y), x, screenX: x })?.handled, true);
      assert.match(plain(components[1]).join("\n"), /PRIVATE RESULT/);
    }
  }
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
      assert.equal(lines.length, 4);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /PRIVATE/);
    }
  }
});

test("inline image sequences survive collapse, expansion, and regrouping unchanged", async () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
  try {
    let timing = "36s elapsed";
    const { groups, components, finish } = setup(["read", "read", "read", "read"], {}, false, () => timing);
    finish(0); finish(2); finish(3);
    groups.result("1", [png], true);
    components[1].updateResult({ content: [png, text("image description")], isError: false });
    await tick();
    const imageLines = (c: ToolExecutionComponent) => c.render(100).filter((line) => line.includes("\x1b]1337;File="));
    const collapsed = imageLines(components[1]);
    assert.equal(collapsed.length, 1);
    assert.equal((components.flatMap((c) => plain(c)).join("\n").match(/36s elapsed/g) ?? []).length, 3);
    timing = "took 48s";
    groups.refresh(["0", "1", "2", "3"]);
    await tick();
    assert.equal((components.flatMap((c) => plain(c)).join("\n").match(/took 48s/g) ?? []).length, 3);
    assert.deepEqual(imageLines(components[1]), collapsed);
    assert.match(plain(components[0])[2], /\[done\] read/);
    assert.match(plain(components[2])[2], /Used 2 tools/);
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
