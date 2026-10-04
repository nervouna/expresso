# Working on Expresso

Before changing behavior, read README.md sections "Behavior" and "Scope and
compatibility". Keep the behavior contract there rather than duplicating it here.

For Pi integration changes, check the documentation and typings for the installed
@earendil-works/pi-coding-agent package. Do not assume another Pi version has the
same API.

Before refactoring renderers, timing, or lifecycle handling, read the related
source comments and tests in test/renderers.test.ts, test/lifecycle.test.ts,
test/timing.test.ts, and test/group-timing.test.ts. They cover host ordering
dependencies and timing invariants that are easy to break.

Run npm run verify for code changes. For rendering or lifecycle changes, also run
the PTY checks documented under README.md "Development and checks". Report any
checks you could not run.

For terminal-color fixes, add regression assertions for effective foreground and
background at the affected characters, including truncation markers and padding.
Checking stripped text or the presence of color escape sequences is insufficient.

Do not commit or push unless requested.
