# Contributing

Expresso is a personal project, but bug reports and fixes are welcome.

## Issues

- **Bugs:** use the bug report form. The most useful reports give your Pi version, terminal and TUI mode, the tool calls involved, what happened and what you expected; a suggested fix is a bonus.
- **Security problems:** report them privately, see [SECURITY.md](SECURITY.md).
- **Feature ideas:** open an issue to discuss it first. Expresso stays small on purpose, so not every idea will fit. Footer ideas belong in [Lungo](https://github.com/nervouna/lungo).

## How the project is developed

Most of the code is written by coding agents following `AGENTS.md`; its rules apply to human contributions too. In short:

- The behavior contract is the README's "Behavior" and "Scope and compatibility" sections. Keep it there and keep it true.
- For Pi integration, check the documentation and typings of the installed `@earendil-works/pi-coding-agent`; do not assume another Pi version has the same API.
- Before refactoring renderers, timing or lifecycle handling, read the related source comments and tests (`test/renderers.test.ts`, `test/lifecycle.test.ts`, `test/timing.test.ts`, `test/group-timing.test.ts`).
- `npm run verify` passes for code changes. Rendering or lifecycle changes also pass `npm run test:tui` (Python 3 and a POSIX PTY). Say which checks you could not run.
- Terminal color fixes add regression assertions on the effective foreground and background at the affected characters, including truncation markers and padding.

## Pull requests

Describe the change, link the issue if there is one, and list the commands you ran and their results. For visual changes, a terminal screenshot in both the dark and light themes helps.
