import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  Box, Spacer, Text, mixColors, stripTerminalSequences, truncateToWidth, visibleWidth,
  type Component, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { ToolGroups, type Redraw } from "./groups.ts";
import type { CompactOptions } from "./settings.ts";

const icons = {
  pending: "\uf017",
  running: "\uf110",
  done: "\uf00c",
  failed: "\uf00d",
  groupFailed: "\uf071",
};

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
export type RenderContext = Parameters<CallRenderer>[2];
type Result = Parameters<ResultRenderer>[0];
type SlotName = "call" | "result";

type State = Redraw & {
  args: unknown;
  prepared: boolean;
  result?: Result;
  contexts: Partial<Record<SlotName, RenderContext>>;
  theme: Theme;
  original: ToolRenderers;
  downstream: Record<string, unknown>;
  previous: Partial<Record<SlotName, Component>>;
  views: Partial<Record<SlotName, Slot>>;
};

export function oneLine(value: string): string {
  return stripTerminalSequences(value.slice(0, 4096))
    .split(/[\r\n\u2028\u2029]/, 1)[0]
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
}

function identifier(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file_path", "command", "url"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") {
      const line = oneLine(value);
      if (line) return line;
    }
  }
  return "";
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ""; }
  catch { return "[Arguments could not be formatted]"; }
}

class Slot implements Component {
  private child?: Component;

  constructor(
    private readonly name: string,
    private readonly kind: SlotName,
    private readonly state: State,
    private readonly groups: ToolGroups,
    private readonly toggleAll: () => void,
    private readonly options: CompactOptions,
    private readonly timingLabel: (toolCallId: string) => string | undefined,
  ) {}

  invalidate() {
    this.state.prepared = false;
    if (this.child) this.child.invalidate();
    else this.state.previous[this.kind]?.invalidate();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const { state, kind } = this;
    const context = state.contexts[kind]!;
    if (!context.expanded) {
      this.child = undefined;
      if (kind === "result") return [];
      const row = this.groups.rows.get(context.toolCallId);
      const group = row?.group;
      if (group && group[0] !== row) return [];
      const pending = group?.filter((entry) => entry.pending).length ?? Number(context.isPartial);
      const errors = group?.filter((entry) => entry.error).length ?? Number(context.isError);
      let label: string;
      let detail = "";
      if (group && group.length > 1) {
        label = `${pending ? "Using" : "Used"} ${group.length} tools`;
        if (this.options.nerdFonts) {
          const icon = pending ? icons.running : errors ? icons.groupFailed : icons.done;
          label = `${icon} ${label}`;
          if (errors) label += ` (${icons.failed} ${errors})`;
        } else {
          if (pending) label += ` (${pending} pending)`;
          if (errors) label = `[${errors} failed] ${label}`;
        }
      } else {
        label = oneLine(this.name);
        detail = identifier(state.args);
        const status = errors || context.isError ? "failed"
          : pending ? context.executionStarted ? "running" : "pending" : "done";
        // Put status first so narrow terminals do not truncate a failure marker.
        label = `${this.options.nerdFonts ? icons[status] : `[${status}]`} ${label}`;
      }
      const failed = errors > 0 || context.isError;
      const color = failed ? "warning" : "muted";
      const warningBackground = failed
        ? mixColors(state.theme.colors.toolPendingBg, state.theme.colors.warning, 0.12, "srgb")
        : undefined;
      const box = new Box(width > 2 ? 1 : 0, 1, (line) => warningBackground
        ? state.theme.style(line, { bg: warningBackground })
        : state.theme.bg("toolPendingBg", line));
      const timing = this.timingLabel(context.toolCallId);
      const suffix = timing ? state.theme.fg("muted", `, ${timing}`) : "";
      box.addChild({
        render: (contentWidth) => {
          let shownDetail = detail;
          const reserved = visibleWidth(label) + visibleWidth(suffix);
          if (detail && timing && reserved <= contentWidth) {
            shownDetail = truncateToWidth(detail, Math.max(0, contentWidth - reserved - 1));
          }
          const summary = label + (shownDetail ? ` ${shownDetail}` : "") + suffix;
          // Truncation inserts full resets that would clear the enclosing foreground and background.
          const clipped = truncateToWidth(summary, contentWidth).replaceAll("\x1b[0m", "");
          return [state.theme.fg(color, clipped)];
        },
        invalidate() {},
      });
      return box.render(width);
    }

    this.prepare();
    try {
      this.child = this.frame(state.previous[kind] ?? this.fallback(kind), context, width);
      return this.child.render(width);
    } catch {
      state.previous[kind] = undefined;
      this.child = this.frame(this.fallback(kind), context, width);
      return this.child.render(width);
    }
  }

  private prepare() {
    const state = this.state;
    if (state.prepared) return;
    state.prepared = true;
    // Some result renderers update the call component, so prepare both before drawing either.
    for (const kind of ["call", "result"] as const) {
      const context = state.contexts[kind];
      if (!context || (kind === "result" && !state.result)) continue;
      const downstreamContext = {
        ...context, expanded: true, state: state.downstream, lastComponent: state.previous[kind],
      };
      try {
        state.previous[kind] = kind === "call"
          ? state.original.renderCall?.(state.args, state.theme, downstreamContext) ?? this.fallback(kind)
          : state.original.renderResult?.(state.result!, {
            expanded: true, isPartial: context.isPartial,
          }, state.theme, downstreamContext) ?? this.fallback(kind);
      } catch {
        state.previous[kind] = this.fallback(kind);
      }
    }
  }

  handleMouse(event: TuiMouseEvent) {
    const childResult = this.child?.handleMouse?.(event);
    if (childResult) return childResult;
    if (event.type === "click" && event.button === "left") {
      this.toggleAll();
      return { handled: true };
    }
    return undefined;
  }

  private fallback(kind: SlotName): Component {
    const { theme } = this.state;
    if (kind === "call") {
      const args = stringify(this.state.args);
      return new Text(theme.fg("toolTitle", this.name) + (args ? `\n${args}` : ""), 0, 0);
    }
    const text = this.state.result?.content
      .filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
    return text ? new Text(theme.fg("toolOutput", text), 0, 0)
      : { render: () => [], invalidate() {} };
  }

  private frame(component: Component, context: RenderContext, width: number): Component {
    if (this.state.original.renderShell === "self") return component;
    const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
    const box = new Box(width > 2 ? 1 : 0, 0, (line) => this.state.theme.bg(color, line));
    if (this.kind === "call") box.addChild(new Spacer(1));
    box.addChild(component);
    if (this.kind === "result" || !this.state.result) box.addChild(new Spacer(1));
    return box;
  }
}

export class CompactRenderers {
  private readonly states = new WeakMap<object, State>();

  constructor(
    private readonly groups: ToolGroups,
    private readonly toggleAll: () => void,
    private readonly options: CompactOptions = { nerdFonts: false },
    private readonly timingLabel: (toolCallId: string) => string | undefined = () => undefined,
  ) {}

  wrap(name: string, original: ToolRenderers = {}): ToolRenderers {
    const getState = (theme: Theme, context: RenderContext): State => {
      let state = this.states.get(context.state);
      if (!state) {
        state = {
          args: context.args, prepared: false, theme, original, downstream: {}, previous: {}, views: {}, contexts: {},
          redraw(compactOnly = false) {
            const context = this.contexts.call ?? this.contexts.result;
            if (context && (!compactOnly || !context.expanded)) context.invalidate();
          },
        };
        this.states.set(context.state, state);
        this.groups.subscribe(context.toolCallId, state);
      }
      state.theme = theme;
      state.original = original;
      state.prepared = false;
      return state;
    };
    const view = (state: State, kind: SlotName) => state.views[kind] ??=
      new Slot(name, kind, state, this.groups, this.toggleAll, this.options, this.timingLabel);
    return {
      renderShell: "self",
      renderCall: (args, theme, context) => {
        const state = getState(theme, context);
        state.args = args;
        state.contexts.call = context;
        return view(state, "call");
      },
      renderResult: (result, _options, theme, context) => {
        const state = getState(theme, context);
        state.result = result;
        state.contexts.result = context;
        return view(state, "result");
      },
    };
  }
}
