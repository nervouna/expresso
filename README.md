# Expresso

A Pi extension that collapses consecutive tool calls into a one-line summary with a subdued, theme-aware background and vanilla Pi padding. Tested with `@earendil-works/pi-coding-agent` 1.0.2.

```text
Used 3 tools, took 48s

[1 failed] Used 2 tools, took 48s

[done] read src/index.ts, took 48s
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
- Adjacent calls share `Used X tools`. The count is tool invocations, including repeated uses of the same tool. Calls can span several execution steps.
- Visible assistant or user messages end a group. Thinking blocks also end groups because Pi displays either their contents or a collapsed thinking label. Visible custom messages and session summaries are boundaries too. Custom session entries conservatively end groups because their visibility depends on their renderer. Expresso's own hidden timing entries do not end groups.
- Running groups show `Using X tools` with a pending count. Failures remain visible even when their details are collapsed.
- Image-producing calls stay separate, with groups split on both sides. Pi still draws the images using its existing size, protocol, and visibility settings. Expresso never removes image data or changes your image preference.
- Built-in tools, codemode, extension tools, and MCP tools use the same grouping logic. Tools called inside codemode count as part of the codemode invocation unless Pi gives them their own transcript rows.

Each visible compact block has one column of horizontal padding and one blank row above and below its single content line. Waiting, running, and successful calls use muted text on Pi's `toolPendingBg`, a subdued gray in the built-in dark and light themes. If any call failed, the block uses Pi's warning text color on a subtle warning-tinted background (12% warning color blended into the neutral background). Expanded details retain their original tool styling. Pi retains its normal blank separator before the block. Hidden members take no lines and add no padding. At widths of one or two columns, horizontal padding is omitted to keep the summary within the terminal.

### Response timing

Compact summaries share one timer for each response to a user prompt. It includes reasoning, tool execution, and the final answer. The duration updates once per second until Pi finishes the response, including any automatic retries or continuations.

```text
Using 3 tools (1 pending), 36s elapsed
Used 3 tools, 42s elapsed
Used 3 tools, took 48s
```

Completed tool groups keep counting while the response is still running. Separate groups and image-producing calls in the same response show the same duration. Time stays muted, including on failed blocks, and does not appear in expanded details. Durations use seconds, minutes, or hours: `9s`, `1m 03s`, `1h 02m 05s`.

A queued follow-up or steering message starts a new timer when Pi begins handling it, ending the previous round. Time spent waiting in the input queue is excluded. Cancellation and orderly shutdown freeze the elapsed time so far.

Expresso saves one hidden `expresso:round-timing` entry per tool-using round, containing tool-call IDs and elapsed time. This metadata never enters model context. Final durations survive resume, `/reload`, tree navigation, and compaction on the active branch. Older rounds without a timing entry show no duration; a process crash can also leave an unfinished round without one.

### Nerd Font icons

Icons are opt-in. Add this key to your Pi settings, normally `~/.pi/agent/settings.json`, then run `/reload`:

```json
{
  "expresso": {
    "nerdFonts": true
  }
}
```

Pi's effective settings determine the value, so a trusted project's `.pi/settings.json` can override the user setting. If you use `PI_CODING_AGENT_DIR`, edit `settings.json` in that directory instead. Missing or invalid values default to `false`; only the boolean `true` enables icons. Expresso reads this preference on startup and reload without writing to your settings.

Your terminal must use a Nerd Font, such as Maple Mono NF, or a font fallback providing these glyphs. The spinner is static.

| State | Standalone call | Group |
|---|---|---|
| Waiting to start | ` read src/index.ts` | ` Using 3 tools` |
| Running | ` read src/index.ts` | ` Using 3 tools` |
| Completed successfully | ` read src/index.ts` | ` Used 3 tools` |
| Running with a failure | N/A | ` Using 3 tools ( 1)` |
| Finished with a failure | ` read src/index.ts` | ` Used 3 tools ( 1)` |

Icon-mode groups omit the pending count but retain the failure count. Text mode keeps the original labels and counts. Backgrounds, padding, expanded details, and images are unchanged. Set `nerdFonts` to `false` and run `/reload` to return to text labels.

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

The offline demo opens a generated session containing built-in calls, codemode, an unregistered MCP tool, a failure, and an image. Its recorded round has a 48-second duration. It makes no model requests and does not execute the recorded tool calls.

```sh
npm ci
npm run demo
# Preview Nerd Font icons using only the demo's temporary settings:
npm run demo -- --nerd-fonts
# Watch a live response timer with an offline mock provider:
npm run demo -- --live --nerd-fonts
# Or use regular terminal mode:
npm run demo -- --tui-mode regular
```

The demo uses temporary Pi settings and session files, which it removes on exit. Your personal settings and sessions are untouched. Without `--live`, a warning about missing model credentials is expected in this isolated environment. The live demo uses a local mock provider and harmless wait tools. It creates two groups, including one failure, then pauses before finishing its answer so you can watch both timers continue. It needs no credentials and makes no network requests.

Check the following:

1. The first three calls share one padded `Used 3 tools, took 48s` summary with a subdued background, even though they came from two execution steps.
2. The standalone edit has one content line with the same padding. The following group shows a failure marker with warning-colored text and a subtle warning-tinted background.
3. Ctrl+O reveals arguments, output, and the edit diff. Press it again to restore the summaries.
4. The colored image remains between two groups, each containing two calls, if your terminal supports Pi's image protocol.
5. `/reload` preserves the compact presentation and final duration. Resize the terminal and try both TUI modes.
6. In fullscreen mode, click a summary to toggle details. Check your rebound expansion shortcut too, if you use one.

For your normal working session, run `pi -e ./src/index.ts` and ask the agent to use several tools. Check that the count and pending/failure indicators update as calls arrive, that elapsed time keeps updating during the final answer, and that it freezes once the response ends.

## Development and checks

```sh
npm run verify       # TypeScript and unit/integration tests
npm run test:tui     # Real CLI smoke tests; requires Python 3 and a POSIX PTY
npm pack --dry-run   # Inspect the package contents
```

The automated tests cover streaming updates, boundaries, failures and aborts, image splits, width handling, theme changes, downstream renderer reuse, HTML results, lifecycle restoration, and non-TUI passthrough. Timer tests cover duration formatting, shared clocks, queued prompts, retries, final metadata, branch restoration, compaction, and cleanup. Clock ticks do not invalidate expanded renderers. Compact styling and padding are checked in dark and light themes: non-failed blocks use Pi's neutral pending background, and failures use warning text with a subtle warning tint, including mixed pending/failed groups. Built-in expanded output is also compared against Pi's tool components.

The PTY suite checks both fullscreen and regular modes with icons enabled and disabled, including Ctrl+O, image protocol output, changing the preference through `/reload`, and resizing. It also checks live timer updates, completion, cancellation, and saved durations using the offline mock provider. All checks use isolated settings and make no network requests. To check a different installed Pi binary:

```sh
PI_BIN="$(command -v pi)" npm run test:tui
```

Production code is in `src/index.ts`, `src/groups.ts`, `src/renderers.ts`, `src/settings.ts`, and `src/timing.ts`. Tests pin Pi 1.0.2 and inspect some of its internal components; those internal imports are confined to the tests.
