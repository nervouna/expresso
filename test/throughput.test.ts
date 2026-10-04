import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { registerThroughput, sessionThroughput, THROUGHPUT_ENTRY } from "../src/throughput.ts";
import { assistant } from "./helpers.ts";

function harness(footer = true) {
  const handlers = new Map<string, ((event: ExtensionEvent, ctx: ExtensionContext) => void)[]>();
  const session = SessionManager.inMemory("/work");
  let refreshes = 0;
  registerThroughput({
    on(name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => void) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
    getSettings: () => ({ expresso: { footer } }),
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI, () => { refreshes++; });
  const emit = (event: ExtensionEvent, mode = "tui") => {
    for (const handler of handlers.get(event.type) ?? []) handler(event, { mode } as ExtensionContext);
  };
  const end = (output: number, stopReason = "stop") => {
    const message = assistant([]);
    message.usage.output = output;
    message.stopReason = stopReason as typeof message.stopReason;
    emit({ type: "message_end", message });
  };
  emit({ type: "session_start", reason: "startup" });
  return { session, emit, end, get refreshes() { return refreshes; } };
}

test("request average weights elapsed time, includes first-token latency, and excludes tool and idle gaps", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  const start = () => h.emit({ type: "before_provider_request", payload: {} });
  assert.equal(sessionThroughput(h.session.getEntries()), undefined);
  start();
  now = 1500;
  h.emit({ type: "message_start", message: assistant([]) });
  now = 2000; h.end(100);
  assert.equal(sessionThroughput(h.session.getEntries()), 50);
  now = 102000; start();
  now += 30000; h.end(900);
  assert.equal(sessionThroughput(h.session.getEntries()), 31.25);
  h.end(900);
  assert.equal(h.refreshes, 2);
  h.emit({ type: "session_start", reason: "reload" });
  assert.equal(sessionThroughput(h.session.getEntries()), 31.25);
  h.session.branch(h.session.getEntries()[0].id);
  h.emit({ type: "session_tree", oldLeafId: null, newLeafId: h.session.getLeafId() });
  assert.equal(sessionThroughput(h.session.getEntries()), 31.25);
  h.session.appendCompaction("summary", h.session.getLeafId()!, 100);
  assert.equal(sessionThroughput(h.session.getEntries()), 31.25);
  assert.equal(h.session.buildSessionContext().messages.some((m) => JSON.stringify(m).includes(THROUGHPUT_ENTRY)), false);
});

test("request retries exclude backoff and failed or cancelled requests do not contaminate the average", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.emit({ type: "before_provider_request", payload: {} });
  now = 1000; h.end(0, "error");
  now = 10000;
  h.emit({ type: "before_provider_request", payload: {} });
  now += 2000; h.end(100);
  assert.equal(sessionThroughput(h.session.getEntries()), 50);
  for (const reason of ["error", "aborted"]) {
    h.emit({ type: "before_provider_request", payload: {} });
    now += 20000; h.end(999, reason);
  }
  h.emit({ type: "before_provider_request", payload: {} });
  now += 1000; h.emit({ type: "agent_settled" }); h.end(999);
  assert.equal(h.refreshes, 1);
  assert.equal(sessionThroughput(h.session.getEntries()), 50);
});

test("unknown durations, invalid usage, shutdown, and non-TUI modes never create samples", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.end(100);
  for (const output of [-1, NaN, Infinity, 100]) {
    h.emit({ type: "before_provider_request", payload: {} });
    if (output !== 100) now += 1000;
    h.end(output);
  }
  h.emit({ type: "before_provider_request", payload: {} });
  h.emit({ type: "session_shutdown", reason: "quit" });
  now += 1000; h.end(100);
  for (const mode of ["print", "json", "rpc"]) {
    h.emit({ type: "session_start", reason: "startup" }, mode);
    h.emit({ type: "before_provider_request", payload: {} }, mode);
    now += 1000; h.end(100);
  }
  assert.equal(h.session.getEntries().length, 0);
});

test("disabled footer collects no measurements", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness(false);
  h.emit({ type: "before_provider_request", payload: {} });
  now = 1000; h.end(100);
  assert.equal(h.session.getEntries().length, 0);
});

test("restoration ignores old tokens and malformed or future-version measurements", () => {
  const session = SessionManager.inMemory("/work");
  const old = assistant([]); old.usage.output = 10000;
  session.appendMessage(old);
  for (const data of [null, {}, { version: 2, output: 100, elapsedMs: 1000 },
    { version: 1, output: -1, elapsedMs: 1000 }, { version: 1, output: 100, elapsedMs: 0 }]) {
    session.appendCustomEntry(THROUGHPUT_ENTRY, data);
  }
  assert.equal(sessionThroughput(session.getEntries()), undefined);
  session.appendCustomEntry(THROUGHPUT_ENTRY, { version: 1, output: 0, elapsedMs: 1000 });
  assert.equal(sessionThroughput(session.getEntries()), 0);
  session.appendCustomEntry(THROUGHPUT_ENTRY, { version: 1, output: 100, elapsedMs: 1000 });
  assert.equal(sessionThroughput(session.getEntries()), 50);
});
