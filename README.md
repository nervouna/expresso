# Expresso

A Pi extension that collapses consecutive tool calls into a one-line summary with vanilla Pi tool-message backgrounds and padding. Tested with `@earendil-works/pi-coding-agent` 1.0.2.

```text
Used 3 tools...

[1 failed] Used 2 tools...

[done] read src/index.ts
```

## Try it

From this checkout:

```sh
pi -e ./src/index.ts
```

This loads Expresso for one invocation without changing your settings. Pi supplies the runtime dependencies; no build step is needed.

To install this checkout persistently, run this yourself:

```sh
pi install /absolute/path/to/expresso
```

Restart Pi after installation. Use `/reload` to pick up subsequent source edits.

Expresso targets the Earendil Pi package named above and requires its `registerToolRenderer()` API. It does not patch Pi or use private APIs at runtime.

## Behavior

- A single call shows its status, tool name, and a short identifier when available, such as a path or the first command line. Scripts, file contents, diffs, JSON arguments, and result previews stay hidden.
- Adjacent calls share `Used X tools...`. The count is tool invocations, including repeated uses of the same tool. Calls can span several execution steps.
- Visible assistant or user messages end a group. Thinking blocks also end groups because Pi displays either their contents or a collapsed thinking label. Visible custom messages and session summaries are boundaries too. Custom session entries conservatively end groups because their visibility depends on their renderer.
- Running groups show `Using X tools...` with a pending count. Failures remain visible even when their details are collapsed.
- Image-producing calls stay separate, with groups split on both sides. Pi still draws the images using its existing size, protocol, and visibility settings. Expresso never removes image data or changes your image preference.
- Built-in tools, codemode, extension tools, and MCP tools use the same grouping logic. Tools called inside codemode count as part of the codemode invocation unless Pi gives them their own transcript rows.

Each visible compact block uses Pi's themed tool background, one column of horizontal padding, and one blank row above and below its single content line. The background shows failure if any call failed, otherwise pending while calls remain, then success. Pi retains its normal blank separator before the block. Hidden members take no lines and add no padding. At widths of one or two columns, horizontal padding is omitted to keep the summary within the terminal.

### Expansion controls

Use Pi's `app.tools.expand` shortcut, **Ctrl+O** by default, to expand or collapse all tools. Rebound shortcuts continue to work. Expansion goes straight to full tool details, without an intermediate list of headers.

In fullscreen mode, clicking a header or tool output invokes the same global toggle. Using one expansion state keeps newly arriving calls consistent with the open group. Original renderer controls and links take precedence over the toggle. Regular mode leaves mouse interaction to the terminal; use the keyboard there.

Expanded views delegate to the original tool renderers, including their formatting and any limits they impose. Tools without renderers get a JSON-argument and text-result fallback. Renderer state is isolated per call, including parallel calls.

### Scope and compatibility

- This changes terminal presentation only. It does not reduce model context or token usage, rewrite session entries, change tool declarations, or intercept execution and permissions.
- Print, JSON, and RPC modes retain their normal behavior.
- Resume, `/reload`, tree navigation, and compaction rebuild groups from the active transcript.
- HTML exports retain Pi's per-tool cards and full expanded results. Custom-tool headers can carry the compact summary; exports do not reproduce terminal-level grouping.
- User-issued `!` shell commands use Pi's separate UI and are not compacted.
- Another extension can bypass Expresso if its renderer resolver runs first and does not delegate. Load Expresso before such overrides.
- Image support remains Pi's responsibility. For example, Pi 1.0.2 disables iTerm2-protocol images in fullscreen mode; this extension does not change that behavior.

## Acceptance demo

The offline demo opens a generated session containing built-in calls, codemode, an unregistered MCP tool, a failure, and an image. It makes no model requests and does not execute the recorded tool calls.

```sh
npm ci
npm run demo
# Or use regular terminal mode:
npm run demo -- --tui-mode regular
```

The demo uses temporary Pi settings and session files, which it removes on exit. Your personal settings and sessions are untouched. A warning about missing model credentials is expected in this isolated environment.

Check the following:

1. The first three calls share one padded `Used 3 tools...` summary with Pi's success background, even though they came from two execution steps.
2. The standalone edit has one content line with the same padding. The following group shows a failure marker and Pi's error background.
3. Ctrl+O reveals arguments, output, and the edit diff. Press it again to restore the summaries.
4. The colored image remains between two groups, each containing two calls, if your terminal supports Pi's image protocol.
5. `/reload` preserves the compact presentation. Resize the terminal and try both TUI modes.
6. In fullscreen mode, click a summary to toggle details. Check your rebound expansion shortcut too, if you use one.

For your normal working session, run `pi -e ./src/index.ts` and ask the agent to use several tools. Check that the count and pending/failure indicators update as calls arrive.

## Development and checks

```sh
npm run verify       # TypeScript and unit/integration tests
npm run test:tui     # Real CLI smoke tests; requires Python 3 and a POSIX PTY
npm pack --dry-run   # Inspect the package contents
```

The automated tests cover streaming updates, boundaries, failures and aborts, image splits, width handling, theme changes, downstream renderer reuse, HTML results, lifecycle restoration, and non-TUI passthrough. Compact backgrounds and padding are compared against Pi's own tool components in dark and light themes, including mixed pending/failed groups. Built-in expanded output is also compared against Pi's tool components.

The PTY suite checks both fullscreen and regular modes, including Ctrl+O, image protocol output, `/reload`, and resizing. It uses isolated settings and no model requests. To check a different installed Pi binary:

```sh
PI_BIN="$(command -v pi)" npm run test:tui
```

Production code is in `src/index.ts`, `src/groups.ts`, and `src/renderers.ts`. Tests pin Pi 1.0.2 and inspect some of its internal components; those internal imports are confined to the tests.
