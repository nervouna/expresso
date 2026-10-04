import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readOptions } from "./settings.ts";
import { registerThroughput, sessionThroughput } from "./throughput.ts";

// Codepoints from Nerd Fonts glyphnames.json.
export const footerIcons = {
  folder: "\uf07b", git: "\ue725", provider: "\uec10",
  input: "\uf062", output: "\uf063", cache: "\u{f01bc}", hit: "\uebf8", speed: "\u{f04c5}",
};

export function thinkingIcon(level: string, reasoning: boolean): string {
  if (!reasoning) return "·";
  return ({ low: "\u{f0a9e}", medium: "\u{f0a9f}", high: "\u{f0aa1}",
    xhigh: "\u{f0aa3}", max: "\u{f0aa5}" } as Record<string, string>)[level] ?? "○";
}

export function footerUsage(entries: readonly SessionEntry[]) {
  let input = 0, output = 0, cache = 0;
  let hit: number | undefined;
  for (const entry of entries) {
    const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.usage : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
        ? entry.message.usage : undefined;
    if (!usage) continue;
    input += usage.input;
    output += usage.output;
    cache += usage.cacheRead;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      hit = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
    }
  }
  return { input, output, cache, hit };
}

const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const cut = (value: string, width: number, ellipsis = "…") => stripTerminalSequences(truncateToWidth(value, width, ellipsis));
const tokens = (value: number) => value < 1000 ? String(value)
  : `${Number((value / (value < 1e6 ? 1000 : 1e6)).toFixed(1))}${value < 1e6 ? "k" : "m"}`;

export interface FooterSnapshot {
  project: string;
  branch: string | null;
  provider: string;
  model: string;
  thinking: string;
  reasoning: boolean;
  icons: boolean;
  usage: ReturnType<typeof footerUsage>;
  percent: number | null;
  throughput?: number;
}

const footerWidth = (width: number) => Math.max(0, Math.floor(width));
const innerWidth = (width: number) => Math.max(0, footerWidth(width) - 2);
const padded = (line: string, width: number) => width < 2 ? " ".repeat(width) : ` ${line} `;

export function footerLines(data: FooterSnapshot, width: number, theme?: Theme): string[] {
  width = footerWidth(width);
  const lines = contentLines(data, innerWidth(width));
  return lines.map((line, index) => {
    if (!theme) return padded(line, width);
    if (index !== 1 || data.percent === null || !Number.isFinite(data.percent)) {
      return theme.fg("muted", padded(line, width));
    }
    // The full layout ends with ten bar glyphs, a space, and the percentage.
    const barEnd = line.lastIndexOf(" ");
    const barStart = barEnd - 10;
    const color = data.percent < 50 ? "success" : data.percent < 80 ? "warning" : "error";
    return theme.fg("muted", ` ${line.slice(0, barStart)}`)
      + theme.style(line.slice(barStart, barEnd), { fg: color, dim: true })
      + theme.fg("muted", `${line.slice(barEnd)} `);
  });
}

// Style after layout so truncation cannot reset the colors of markers or padding.
function contentLines(data: FooterSnapshot, width: number): string[] {
  const icon = (key: keyof typeof footerIcons, fallback: string) => data.icons ? footerIcons[key] : fallback;
  const project = `${icon("folder", "dir")} ${clean(data.project)}`;
  const thinking = data.icons ? thinkingIcon(data.thinking, data.reasoning) : data.reasoning ? data.thinking : "-";
  const provider = data.icons ? footerIcons.provider : clean(data.provider);
  const model = `${provider} ${clean(data.model)} ${thinking}`;
  const branch = data.branch ? ` ${icon("git", "git")} ${clean(data.branch)}` : "";
  const { input, output, cache, hit } = data.usage;
  const stats = `${icon("input", "↑")} ${tokens(input)}  ${icon("output", "↓")} ${tokens(output)}  ${icon("cache", "cache")} ${tokens(cache)}  ${icon("hit", "hit")} ${hit === undefined ? "?" : hit.toFixed(1)}%`;
  const percent = data.percent !== null && Number.isFinite(data.percent) ? data.percent : null;
  const filled = percent === null ? 0 : Math.floor(Math.max(0, Math.min(100, percent)) / 10);
  const bar = Array.from({ length: 10 }, (_, index) => {
    if (!data.icons) return index < filled ? "━" : "─";
    const position = index === 0 ? 0 : index === 9 ? 2 : 1;
    return String.fromCodePoint(0xee00 + position + (index < filled ? 3 : 0));
  }).join("");
  const rate = data.throughput !== undefined && Number.isFinite(data.throughput) && data.throughput >= 0
    ? data.throughput.toFixed(1) : "—";
  const progress = `${icon("speed", "avg")} ${rate} tok/s ${bar} ${percent === null ? "?" : percent.toFixed(1)}%`;
  const fits = (left: string, right: string) => visibleWidth(left) + 2 + visibleWidth(right) <= width;
  const join = (left: string, right: string) => left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
  if (fits(project + branch, model) && fits(stats, progress)) {
    return [join(project + branch, model), join(stats, progress)];
  }
  const right = model;
  if (fits(project, right)) return [join(project, right)];
  // Keep the thinking phase at the right edge even when the model itself must truncate.
  const suffix = ` ${thinking}`;
  const rightBudget = Math.max(0, width - Math.min(visibleWidth(project) + 2, Math.floor(width / 3)));
  const shortRight = rightBudget >= visibleWidth(suffix)
    ? cut(`${provider} ${clean(data.model)}`, rightBudget - visibleWidth(suffix)) + suffix
    : cut(thinking, width, "");
  const leftBudget = Math.max(0, width - visibleWidth(shortRight) - 2);
  return [join(cut(project, leftBudget), shortRight)];
}

export function registerFooter(pi: ExtensionAPI) {
  let refresh: (() => void) | undefined;
  let dispose: (() => void) | undefined;
  registerThroughput(pi, () => refresh?.());
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const options = readOptions(pi.getSettings());
    if (!options.footer) {
      if (dispose) ctx.ui.setFooter(undefined);
      return;
    }
    ctx.ui.setFooter((tui, _theme, footerData) => {
      let dirty = true;
      let key = "";
      let usage = footerUsage([]);
      let throughput: number | undefined;
      const update = () => { dirty = true; tui.requestRender(); };
      const unsub = footerData.onBranchChange(update);
      let disposed = false;
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        unsub();
        if (refresh === update) { refresh = undefined; dispose = undefined; }
      };
      refresh = update;
      dispose = cleanup;
      return {
        dispose: cleanup,
        invalidate() { dirty = true; },
        render(width: number) {
          const session = ctx.sessionManager;
          const nextKey = `${session.getSessionId()}:${session.getLeafId()}`;
          if (dirty || key !== nextKey) {
            const entries = session.getEntries();
            usage = footerUsage(entries);
            throughput = sessionThroughput(entries);
            key = nextKey;
            dirty = false;
          }
          const lines = footerLines({ ...snapshot(ctx, options.nerdFonts, footerData.getGitBranch(), usage, pi.getThinkingLevel()), throughput }, width, ctx.ui.theme);
          const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))
            .map(([, value]) => clean(value)).join(" ");
          if (statuses) {
            const status = cut(statuses, innerWidth(width));
            const content = status + " ".repeat(innerWidth(width) - visibleWidth(status));
            lines.push(ctx.ui.theme.fg("muted", padded(content, footerWidth(width))));
          }
          return lines;
        },
      };
    });
  });
  const update = () => refresh?.();
  pi.on("message_end", update);
  pi.on("agent_settled", update);
  pi.on("session_tree", update);
  pi.on("session_compact", update);
  pi.on("model_select", update);
  pi.on("thinking_level_select", update);
  pi.on("session_info_changed", update);
  pi.on("session_shutdown", () => dispose?.());
}

function snapshot(ctx: ExtensionContext, icons: boolean, branch: string | null,
  usage: ReturnType<typeof footerUsage>, thinking: string): FooterSnapshot {
  const cwd = ctx.sessionManager.getCwd();
  return { project: basename(cwd) || cwd, branch, provider: ctx.model?.provider ?? "unknown",
    model: ctx.model?.id ?? "no-model", reasoning: !!ctx.model?.reasoning, thinking, icons, usage,
    percent: ctx.getContextUsage()?.percent ?? null };
}
