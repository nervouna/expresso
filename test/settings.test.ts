import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readOptions } from "../src/settings.ts";

test("Nerd Fonts require an explicit boolean true and do not mutate settings", () => {
  for (const settings of [undefined, null, {}, [], true, "true", { expresso: null }, { expresso: [] }]) {
    assert.deepEqual(readOptions(settings), { nerdFonts: false, timing: "group" });
  }
  for (const nerdFonts of [true, false, undefined, "true", "false", 0, 1, null, {}, []]) {
    const settings = Object.freeze({ expresso: Object.freeze({ nerdFonts }) });
    assert.deepEqual(readOptions(settings), { nerdFonts: nerdFonts === true, timing: "group" });
  }
});

test("Pi merges the preference from global and trusted project settings", () => {
  const contents = {
    global: JSON.stringify({ expresso: { nerdFonts: true } }),
    project: JSON.stringify({ expresso: { nerdFonts: false } }),
  };
  const storage = {
    withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined) {
      const next = fn(contents[scope]);
      if (next !== undefined) contents[scope] = next;
    },
  };
  for (const projectTrusted of [false, true]) {
    const manager = SettingsManager.fromStorage(storage, { projectTrusted });
    assert.equal(readOptions(manager.getSettings()).nerdFonts, !projectTrusted);
  }
});
