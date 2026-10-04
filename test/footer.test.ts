import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { footerIcons, footerLines, footerUsage, registerFooter, thinkingIcon, type FooterSnapshot } from "../src/footer.ts";
import { readOptions } from "../src/settings.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { assistant, text } from "./helpers.ts";

const data: FooterSnapshot = { project: "expresso", branch: "main", provider: "openai", model: "gpt-6-astra",
  reasoning: true, thinking: "high", icons: true, usage: { input: 32000, output: 2800, cache: 135000, hit: 93.6 }, percent: 11.5 };

test("footer setting is strictly opt-in", () => {
  for (const footer of [true, false, "true", 1, null, undefined, [], {}]) {
    assert.equal(readOptions({ expresso: { footer } }).footer, footer === true);
  }
});

test("provider glyphs and five thinking phases use the agreed mapping", () => {
  assert.equal(footerIcons.provider, "\uec10");
  for (const provider of ["openai", "openai-codex", "anthropic", "other"]) {
    for (const width of [45, 100]) {
      const line = footerLines({ ...data, provider }, width)[0];
      assert.ok(line.includes("\uec10 gpt-6-astra"));
      assert.equal(line.split("\uec10").length - 1, 1);
    }
  }
  assert.deepEqual(["low", "medium", "high", "xhigh", "max"].map((level) => thinkingIcon(level, true)),
    ["\u{f0a9e}", "\u{f0a9f}", "\u{f0aa1}", "\u{f0aa3}", "\u{f0aa5}"]);
  assert.equal(thinkingIcon("off", true), "○");
  assert.equal(thinkingIcon("high", false), "·");
});

test("layout switches on content width and aligns provider with the model in both modes", () => {
  const full = footerLines(data, 100);
  assert.equal(full.length, 2);
  assert.match(full[0], /expresso.*main/);
  assert.ok(full[0].includes(`${footerIcons.provider} gpt-6-astra`));
  assert.equal(full[0].split(footerIcons.provider).length - 1, 1);
  assert.match(full[1], /32k.*2.8k.*135k.*93.6%.*11.5% $/);
  assert.equal(footerIcons.hit, "\uebf8");
  assert.ok(full[1].includes(`${footerIcons.hit} 93.6%`));
  assert.ok(full[1].includes("\uee03" + "\uee01".repeat(8) + "\uee02"));
  const compact = footerLines(data, 45);
  assert.equal(compact.length, 1);
  assert.ok(compact[0].includes(`  ${footerIcons.provider} gpt-6-astra`));
  assert.ok(!compact[0].includes("main"));
  assert.equal(footerLines(data, 100).length, 2);
  for (const line of [...full, ...compact]) assert.ok([45, 100].includes(visibleWidth(line)));
});

test("all widths, text fallback, unsafe labels, unknown context and long Unicode names are safe", () => {
  for (const icons of [false, true]) {
    for (const project of [data.project, "文件👋é".repeat(40), "bad\n\x1b[31mproject"]) {
      for (let width = 0; width < 160; width++) {
        const lines = footerLines({ ...data, icons, project, model: "模型".repeat(30), percent: null }, width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.every((line) => !/[\n\r\x1b]/.test(line)));
        if (width >= 2) assert.ok(lines.every((line) => line.startsWith(" ") && line.endsWith(" ")));
        else assert.deepEqual(lines, [" ".repeat(width)]);
      }
    }
  }
  assert.match(footerLines({ ...data, percent: null }, 100)[1], /\?% $/);
  assert.ok(footerLines({ ...data, percent: 200 }, 100)[1].endsWith("\uee03" + "\uee04".repeat(8) + "\uee05 200.0% "));
  assert.ok(footerLines({ ...data, percent: -1 }, 100)[1].endsWith("\uee00" + "\uee01".repeat(8) + "\uee02 -1.0% "));
  for (const percent of [0, 9.9, 10, 19.9, 20, 90, 99.9, 100]) {
    const line = footerLines({ ...data, percent }, 100)[1];
    assert.equal([...line].filter((char) => /[\uee03-\uee05]/.test(char)).length, Math.floor(percent / 10));
  }
});

const painted = (line: string) => {
    let fg = "default", bg = "default", dim = false;
    const chars: { char: string; fg: string; bg: string; dim: boolean }[] = [];
    for (const match of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
      if (match[2] !== undefined) {
        for (const char of match[2]) chars.push({ char, fg, bg, dim });
      } else {
        const codes = match[1].split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0) { fg = "default"; bg = "default"; dim = false; }
          else if (code === 2) dim = true;
          else if (code === 22) dim = false;
          else if (code === 39) fg = "default";
          else if (code === 49) bg = "default";
          else if (code === 38 || code === 48) {
            const size = codes[i + 1] === 2 ? 5 : 3;
            const value = codes.slice(i, i + size).join(";");
            if (code === 38) fg = value; else bg = value;
            i += size - 1;
          }
        }
      }
    }
    return chars;
};

test("truncation markers and padding retain effective footer colors in both themes", () => {
  try {
    for (const name of ["dark", "light"]) {
      initTheme(name, false);
      const expected = painted(theme.fg("muted", "x"))[0];
      for (const width of [8, 24, 45, 100]) {
        const lines = footerLines({ ...data, project: "long-project-name".repeat(10) }, width, theme);
        assert.ok(lines.join("").includes("…"));
        for (const line of lines) {
          for (const char of painted(line)) {
            assert.equal(char.fg, expected.fg, `foreground at ${JSON.stringify(char.char)}`);
            assert.equal(char.bg, expected.bg, `background at ${JSON.stringify(char.char)}`);
          }
        }
      }
    }
  } finally { initTheme("dark", false); }
});

test("progress colors follow exact thresholds without leaking into the percentage or padding", () => {
  try {
    for (const name of ["dark", "light"]) {
      initTheme(name, false);
      const muted = painted(theme.fg("muted", "x"))[0];
      for (const icons of [false, true]) {
        for (const percent of [0, 49.9, 50, 79.9, 80, 100, 20, null, Number.NaN]) {
          const lines = footerLines({ ...data, icons, percent }, 120, theme);
          assert.equal(lines.length, 2);
          const chars = painted(lines[1]);
          const bar = chars.filter(({ char }) => /[━─\uee00-\uee05]/.test(char));
          assert.equal(bar.length, 10);
          const known = percent !== null && Number.isFinite(percent);
          const expected = known ? painted(theme.style("x", {
            fg: percent < 50 ? "success" : percent < 80 ? "warning" : "error", dim: true,
          }))[0] : muted;
          for (const char of chars) {
            const inBar = bar.includes(char);
            const style = inBar ? expected : muted;
            assert.equal(char.fg, style.fg, `${name}, ${percent}, foreground at ${JSON.stringify(char.char)}`);
            assert.equal(char.bg, style.bg, `${name}, ${percent}, background at ${JSON.stringify(char.char)}`);
            assert.equal(char.dim, style.dim, `${name}, ${percent}, dim at ${JSON.stringify(char.char)}`);
            if (inBar && known) assert.equal(char.dim, true);
          }
          assert.equal(chars[0].char, " ");
          assert.equal(chars.at(-1)!.char, " ");
          assert.equal(visibleWidth(lines[1]), 120);
        }
      }
    }
  } finally { initTheme("dark", false); }
});

test("usage includes all branches, tool usage, compaction and standalone usage", () => {
  const session = SessionManager.inMemory();
  const message = assistant([text("hello")]);
  message.usage = { input: 10, output: 20, cacheRead: 80, cacheWrite: 10, totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const first = session.appendMessage(message);
  session.appendMessage(message);
  session.branch(first);
  session.appendUsage("cache_warm", "openai", "test", message.usage);
  session.appendCompaction("summary", first, 100, undefined, false, message.usage);
  session.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "test", content: [], isError: false,
    timestamp: 1, usage: message.usage });
  assert.deepEqual(footerUsage(session.getEntries()), { input: 50, output: 100, cache: 400, hit: 80 });
});

test("footer lifecycle respects opt-in, modes, replacement ownership, statuses and cleanup", () => {
  initTheme("dark", false);
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void)[]>();
  let settings = { expresso: { footer: false, nerdFonts: true } };
  registerFooter({ on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
  }, getSettings: () => settings, getThinkingLevel: () => "max" } as unknown as ExtensionAPI);
  let installed = 0, unsubscribed = 0, requests = 0;
  let component: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>> | undefined;
  let branchChange: (() => void) | undefined;
  const session = SessionManager.inMemory("/work/expresso");
  const ctx = { mode: "tui", sessionManager: session, getContextUsage: () => ({ percent: 11.5 }),
    model: { id: "test-model", provider: "anthropic", reasoning: true },
    ui: { get theme() { return theme; },
      setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
        installed++;
        component?.dispose?.();
        component = factory?.({ requestRender() { requests++; } } as never, {} as never, {
          getGitBranch: () => "main", getExtensionStatuses: () => new Map([["status", "hello\nstatus"]]),
          onBranchChange(cb) { branchChange = cb; return () => { unsubscribed++; }; }, getAvailableProviderCount: () => 1,
        });
      } },
  } as unknown as ExtensionContext;
  const emit = (name: string) => handlers.get(name)?.forEach((handler) => handler({}, ctx));
  emit("session_start");
  assert.equal(installed, 0);
  settings = { expresso: { footer: true, nerdFonts: true } };
  for (const mode of ["print", "rpc", "json"]) { Object.assign(ctx, { mode }); emit("session_start"); }
  assert.equal(installed, 0);
  Object.assign(ctx, { mode: "tui" }); emit("session_start");
  assert.equal(installed, 1);
  assert.equal(component!.render(100).length, 3);
  assert.equal(stripTerminalSequences(component!.render(100)[2]), ` hello status${" ".repeat(87)}`);
  for (const width of [0, 1, 2, 8, 45, 100]) {
    const lines = component!.render(width).map(stripTerminalSequences);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 2) assert.ok(lines.every((line) => line.startsWith(" ") && line.endsWith(" ")));
  }
  branchChange?.(); emit("thinking_level_select");
  assert.equal(requests, 2);
  emit("session_start");
  assert.equal(unsubscribed, 1);
  component!.dispose?.(); // Another extension takes the slot.
  settings.expresso.footer = false;
  emit("session_start");
  assert.equal(installed, 2, "disabled Expresso must not clear another footer");
  settings.expresso.footer = true; emit("session_start");
  settings.expresso.footer = false; emit("session_start");
  assert.equal(component, undefined);
  emit("session_shutdown"); emit("session_shutdown");
  assert.equal(unsubscribed, 3);
});
