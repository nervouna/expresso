import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolGroups } from "../src/groups.ts";
import { assistant, call, png, result, text, tick } from "./helpers.ts";

const members = (groups: ToolGroups, id: string) => groups.rows.get(id)!.group.map((row) => row.id);

test("groups calls across tool-only assistant messages and counts invocations", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a"), call("b")]), "history");
  groups.observe(result("a"), "history");
  groups.observe(result("b"), "history");
  groups.observe(assistant([call("c")]), "history");
  assert.deepEqual(members(groups, "b"), ["a", "b", "c"]);
});

test("visible assistant text, thinking labels, and users break runs", () => {
  for (const content of [text("explanation"), { type: "thinking" as const, thinking: "reasoning" }]) {
    const groups = new ToolGroups();
    groups.observe(assistant([call("a")]), "history");
    groups.observe(assistant([content, call("b")]), "history");
    assert.deepEqual(members(groups, "a"), ["a"]);
    assert.deepEqual(members(groups, "b"), ["b"]);
    groups.observe({ role: "user", content: "next", timestamp: 1 }, "history");
    groups.observe(assistant([call("c")]), "history");
    assert.deepEqual(members(groups, "c"), ["c"]);
  }
});

test("whitespace-only content and invisible custom messages do not break runs", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a")]), "history");
  groups.observe({ role: "custom", customType: "hidden", content: "metadata", display: false, timestamp: 1 }, "history");
  groups.observe(assistant([text("  \n"), call("b")]), "history");
  assert.deepEqual(members(groups, "b"), ["a", "b"]);
});

test("late streaming text moves the boundary before all calls in that message", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a")]), "history");
  groups.observe(assistant([]), "start");
  groups.observe(assistant([call("b")]), "update");
  assert.deepEqual(members(groups, "b"), ["a", "b"]);
  groups.observe(assistant([call("b"), text("visible")]), "end");
  assert.deepEqual(members(groups, "b"), ["b"]);
});

test("streaming updates do not duplicate calls or groups", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([]), "start");
  for (let i = 0; i < 20; i++) groups.observe(assistant([call("a"), call("b")]), "update");
  groups.observe(assistant([call("a"), call("b")]), "end");
  groups.observe(assistant([call("c")]), "start");
  assert.equal(groups.rows.size, 3);
  assert.deepEqual(members(groups, "a"), ["a", "b", "c"]);
});

test("image results split on both sides, including when they arrive late", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a"), call("b"), call("c"), call("d")]), "history");
  groups.result("b", [png], false);
  assert.deepEqual(members(groups, "a"), ["a"]);
  assert.deepEqual(members(groups, "b"), ["b"]);
  assert.deepEqual(members(groups, "c"), ["c", "d"]);
  groups.result("b", [png], true);
  assert.equal(groups.rows.get("b")!.pending, false);
});

test("out-of-order completion, failures, and aborts retain status", () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a"), call("b"), call("c")]), "history");
  groups.result("b", [text("failure")], true, true);
  groups.result("a", [text("partial")], false);
  assert.equal(groups.rows.get("a")!.pending, true);
  assert.equal(groups.rows.get("b")!.error, true);
  groups.observe(assistant([call("d")], "aborted"), "history");
  assert.equal(groups.rows.get("d")!.pending, false);
  assert.equal(groups.rows.get("d")!.error, true);
  groups.result("not-in-transcript/nested", [], true);
  assert.equal(groups.rows.size, 4);
});

test("group growth and image splits invalidate affected siblings once per microtask", async () => {
  const groups = new ToolGroups();
  groups.observe(assistant([call("a"), call("b")]), "history");
  await tick();
  const counts = [0, 0];
  const listeners = counts.map((_, i) => ({ redraw() { counts[i]++; } }));
  groups.subscribe("a", listeners[0]);
  groups.subscribe("b", listeners[1]);
  groups.observe(assistant([call("c")]), "history");
  groups.result("b", [png], true);
  await tick();
  assert.deepEqual(counts, [1, 1]);
  groups.result("c", [], true);
  groups.dispose();
  await tick();
  assert.deepEqual(counts, [1, 1]);
});
