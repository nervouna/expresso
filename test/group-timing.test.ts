import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "../src/groups.ts";
import { RoundTimings, TIMING_ENTRY } from "../src/timing.ts";
import { readOptions } from "../src/settings.ts";
import { assistant, call, text } from "./helpers.ts";

function fixture() {
  let now = 0;
  const groups = new ToolGroups();
  const timings = new RoundTimings((ids) => groups.refresh(ids), () => now, () => () => {});
  timings.start();
  const message = (ids: string[]) => {
    const message = assistant(ids.map((id) => call(id)));
    timings.observe(message);
    groups.observe(message, "history");
  };
  return {
    timings, groups, message,
    at(ms: number) { now = ms; },
    start(id: string) { timings.executionStart(id); },
    end(id: string, image = false) {
      groups.result(id, image ? [{ type: "image" }] : [], true);
      timings.executionEnd(id);
    },
    label(id: string) { return timings.groupLabel(groups.rows.get(id)?.group ?? []); },
  };
}

const entry = (data: unknown): SessionEntry => ({
  type: "custom", customType: TIMING_ENTRY, data,
  id: "timing", parentId: null, timestamp: new Date(0).toISOString(),
});

test("group timing defaults safely and response timing is opt-in", () => {
  for (const timing of [undefined, null, false, true, "group", "invalid", [], {}]) {
    assert.equal(readOptions({ expresso: { timing } }).timing, "group");
  }
  assert.equal(readOptions({ expresso: { timing: "response" } }).timing, "response");
});

test("group clocks exclude initial reasoning, freeze after tools, and extend across adjacent steps", () => {
  const f = fixture();
  f.message(["a", "b"]);
  f.at(10_000);
  assert.equal(f.label("a"), undefined);
  f.start("a");
  f.at(12_000); f.start("b");
  f.at(14_000); f.end("a");
  assert.equal(f.label("a"), "4s elapsed");
  f.at(16_000); f.end("b");
  assert.equal(f.label("a"), "took 6s");
  f.at(25_000);
  assert.equal(f.label("a"), "took 6s");
  f.message(["c"]);
  assert.equal(f.label("a"), "15s elapsed");
  f.start("c");
  f.at(28_000); f.end("c");
  assert.equal(f.label("a"), "took 18s");
  f.groups.observe(assistant([text("Next group")]), "history");
  f.message(["d"]); f.start("d");
  f.at(30_000);
  assert.equal(f.label("d"), "2s elapsed");
  assert.equal(f.label("a"), "took 18s");
  f.end("d");
  f.at(50_000); f.timings.finish();
  assert.equal(f.label("d"), "took 2s");
  assert.equal(f.label("a"), "took 18s");
});

test("image splits recompute per-group wall time and saved intervals survive restoration", () => {
  const f = fixture();
  f.message(["a", "image", "b", "c"]);
  f.at(1_000); f.start("a");
  f.at(2_000); f.start("image");
  f.at(3_000); f.end("a"); f.start("b"); f.start("c");
  f.at(5_000); f.end("image", true);
  assert.equal(f.label("a"), "took 2s");
  assert.equal(f.label("image"), "took 3s");
  assert.equal(f.label("b"), "2s elapsed");
  f.at(6_000); f.end("c");
  f.at(7_000); f.end("b");
  f.at(40_000);
  const saved = f.timings.finish()!;
  f.timings.restore([entry(saved)]);
  assert.equal(f.label("a"), "took 2s");
  assert.equal(f.label("image"), "took 3s");
  assert.equal(f.label("b"), "took 4s");
  f.timings.restore([]);
  assert.equal(f.label("a"), undefined);
});

test("cancellation freezes unfinished calls and compaction preserves active intervals", () => {
  const f = fixture();
  f.message(["a", "queued"]);
  f.at(10_000); f.start("a");
  f.at(12_000); f.timings.restore([], true);
  assert.equal(f.label("a"), "2s elapsed");
  f.at(15_000);
  const saved = f.timings.finish()!;
  f.at(90_000);
  assert.equal(f.label("a"), "took 5s");
  assert.deepEqual(saved.tools, [{ id: "a", startedMs: 10_000, endedMs: 15_000 }]);
  f.timings.restore([entry(saved)]);
  assert.equal(f.label("a"), "took 5s");
});

test("old response-only records and malformed intervals never invent group durations", () => {
  const f = fixture();
  f.message(["a"]);
  const record = { version: 1, toolCallIds: ["a"], elapsedMs: 48_000 };
  for (const tools of [undefined, null, {}, [null], [{ id: "a", startedMs: 5, endedMs: 4 }],
    [{ id: "a", startedMs: "0", endedMs: 1000 }], [{ id: "a", startedMs: 0, endedMs: 50_000 }]]) {
    f.timings.restore([entry({ ...record, tools })]);
    assert.equal(f.label("a"), undefined);
    assert.equal(f.timings.label("a"), "took 48s");
  }
});
