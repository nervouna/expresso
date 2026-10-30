# Security

Expresso runs inside Pi with Pi's permissions and draws tool calls and their output in your terminal. That text comes from the model and from whatever the tools read: files, command output, web pages. Expresso must show it as text, must not hide a call or a failure from you, and must not change what a tool does.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/nervouna/expresso/security/advisories/new)). Include what you did, what happened, the commit you tested and your Pi version.

You will get an answer within a week. Fixes land on `main`; there are no maintained release branches.

## In scope

- Tool arguments or output that make Expresso's summary line send terminal escape sequences the terminal acts on
- A tool call, or a failed call, that Expresso hides so it does not appear in the summary count
- A way for Expresso to change tool execution, arguments, results or permissions, or to put its timing entries into model context

## Out of scope

- Expanded tool output, which Pi's own renderers draw: report those to [Pi](https://github.com/earendil-works/pi)
- Another extension that registers its renderer first and bypasses Expresso
- Anything that needs control of your Pi settings or of the machine Pi runs on
