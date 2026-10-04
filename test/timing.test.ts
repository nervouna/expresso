import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RoundTimings, TIMING_ENTRY, formatDuration } from "../src/timing.ts";
import { assistant, call } from "./helpers.ts";

function clock() {
  let now = 0;
  let schedules = 0;
  const callbacks = new Set<() => void>();
  const redraws: string[][] = [];
  const timings = new RoundTimings((ids) => redraws.push([...ids]), () => now, (tick) => {
    schedules++;
    callbacks.add(tick);
    return () => { callbacks.delete(tick); };
  });
  return {
    timings, callbacks, redraws,
    get schedules() { return schedules; },
    advance(ms: number) { now += ms; },
    tick() { for (const callback of callbacks) callback(); },
  };
}

const entry = (data: unknown): SessionEntry => ({
  type: "custom", customType: TIMING_ENTRY, data,
  id: "timing", parentId: null, timestamp: new Date(0).toISOString(),
});
const record = (toolCallIds = ["a"], elapsedMs = 63_000) => ({ version: 1, toolCallIds, elapsedMs });

test("durations use seconds, minutes, and hours without rounding up", () => {
  for (const [ms, label] of [
    [-1, "0s"], [0, "0s"], [999, "0s"], [1_999, "1s"], [59_999, "59s"],
    [60_000, "1m 00s"], [63_000, "1m 03s"], [760_000, "12m 40s"],
    [3_599_999, "59m 59s"], [3_600_000, "1h 00m 00s"], [3_725_000, "1h 02m 05s"],
    [90_061_000, "25h 01m 01s"],
  ] as const) assert.equal(formatDuration(ms), label);
});

test("one clock covers reasoning, every tool group, and the final answer", () => {
  const c = clock();
  assert.equal(c.callbacks.size, 0);
  c.timings.start();
  c.advance(500);
  assert.equal(c.timings.userMessage(), undefined);
  c.advance(35_500);
  c.timings.observe(assistant([call(""), call("a"), call("b")]));
  c.timings.observe(assistant([call("a"), call("b")]));
  assert.equal(c.timings.label("a"), "36s elapsed");
  c.advance(6_000);
  c.timings.observe(assistant([call("c")]));
  c.tick();
  assert.deepEqual(c.redraws, [["a", "b", "c"]]);
  assert.equal(c.timings.label("a"), "42s elapsed");
  assert.equal(c.timings.label("c"), "42s elapsed");
  assert.equal(c.schedules, 1);
  c.advance(6_000);
  assert.deepEqual(c.timings.finish(), record(["a", "b", "c"], 48_000));
  assert.equal(c.callbacks.size, 0);
  c.advance(20_000);
  for (const id of ["a", "b", "c"]) assert.equal(c.timings.label(id), "took 48s");
  assert.equal(c.timings.finish(), undefined);
  assert.equal(c.timings.label("unknown"), undefined);
});

test("activity frames share the one-second round clock and stop after settlement", () => {
  const c = clock();
  assert.equal(c.timings.activityFrame("unknown"), 0);
  c.timings.start();
  c.timings.observe(assistant([call("a"), call("b")]));
  for (const [advance, frame] of [[0, 0], [999, 0], [1, 1], [999, 1], [1, 0], [1000, 1]]) {
    c.advance(advance);
    c.tick();
    for (const id of ["a", "b"]) assert.equal(c.timings.activityFrame(id), frame);
  }
  assert.equal(c.schedules, 1);
  c.timings.finish();
  assert.equal(c.callbacks.size, 0);
  assert.equal(c.timings.activityFrame("a"), 0);
  c.timings.restore([entry(record())]);
  assert.equal(c.timings.activityFrame("a"), 0);
});

test("automatic retries and continuations do not restart the clock", () => {
  const c = clock();
  c.timings.start();
  c.timings.observe(assistant([call("a")]));
  c.advance(36_000);
  c.timings.start();
  c.timings.start();
  c.advance(12_000);
  assert.equal(c.timings.label("a"), "48s elapsed");
  assert.equal(c.schedules, 1);
  c.timings.finish();
  c.timings.start();
  c.timings.observe(assistant([call("b")]));
  assert.equal(c.timings.label("b"), "0s elapsed");
  assert.equal(c.timings.label("a"), "took 48s");
  c.timings.dispose();
  assert.equal(c.callbacks.size, 0);
});

test("queued user messages close the previous round when Pi starts handling them", () => {
  const c = clock();
  c.timings.start();
  c.timings.userMessage();
  c.timings.observe(assistant([call("a")]));
  c.advance(10_000);
  assert.deepEqual(c.timings.userMessage(), record(["a"], 10_000));
  c.timings.observe(assistant([call("b")]));
  c.advance(2_000);
  assert.equal(c.timings.label("a"), "took 10s");
  assert.equal(c.timings.label("b"), "2s elapsed");
  assert.equal(c.callbacks.size, 1);
  assert.equal(c.schedules, 2);
  assert.deepEqual(c.timings.finish(), record(["b"], 2_000));
});

test("text-only rounds leave no timing record or live timer", () => {
  const c = clock();
  c.timings.start();
  c.advance(2_000);
  assert.equal(c.timings.finish(), undefined);
  assert.equal(c.callbacks.size, 0);
  c.timings.observe(assistant([call("history")]));
  assert.equal(c.timings.label("history"), undefined);
});

test("history restores recorded durations without starting a clock or inventing missing data", () => {
  const c = clock();
  c.timings.restore([entry(record(["a", "b"]))]);
  c.advance(90_000);
  assert.equal(c.timings.label("a"), "took 1m 03s");
  assert.equal(c.timings.label("b"), "took 1m 03s");
  assert.equal(c.timings.label("old"), undefined);
  assert.equal(c.schedules, 0);
  c.timings.restore([entry(record(["other"], 4_000))]);
  assert.equal(c.timings.label("a"), undefined);
  assert.equal(c.timings.label("other"), "took 4s");
});

test("unknown versions and malformed timing metadata are ignored", () => {
  const c = clock();
  for (const data of [
    null, [], "invalid", {}, { ...record(), version: 2 },
    ...[-1, Infinity, NaN, "1000", null].map((elapsedMs) => ({ ...record(), elapsedMs })),
    ...[null, "a", [], [1], [""], ["a", null]].map((toolCallIds) => ({ ...record(), toolCallIds })),
  ]) {
    c.timings.restore([entry(data)]);
    assert.equal(c.timings.label("a"), undefined);
  }
  c.timings.restore([entry(record(["a"], 0))]);
  assert.equal(c.timings.label("a"), "took 0s");
});

test("compaction keeps the active clock while session replacement cancels it", () => {
  const c = clock();
  c.timings.start();
  c.timings.observe(assistant([call("active")]));
  c.advance(36_000);
  c.timings.restore([entry(record(["old"], 10_000))], true);
  assert.equal(c.timings.label("old"), "took 10s");
  assert.equal(c.timings.label("active"), "36s elapsed");
  assert.equal(c.schedules, 1);
  c.advance(12_000);
  c.timings.observe(assistant([call("after-compaction")]));
  assert.equal(c.timings.label("after-compaction"), "48s elapsed");
  c.timings.restore([]);
  assert.equal(c.callbacks.size, 0);
  assert.equal(c.timings.label("active"), undefined);
  c.timings.dispose();
  c.timings.dispose();
  assert.equal(c.callbacks.size, 0);
});
