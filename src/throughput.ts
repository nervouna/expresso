import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readOptions } from "./settings.ts";

export const THROUGHPUT_ENTRY = "expresso:request-throughput";

interface Sample { version: 1; output: number; elapsedMs: number }

function validSample(value: unknown): value is Sample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Sample;
  return sample.version === 1 && Number.isFinite(sample.output) && sample.output >= 0
    && Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0;
}

export function sessionThroughput(entries: readonly SessionEntry[]): number | undefined {
  let output = 0, elapsedMs = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== THROUGHPUT_ENTRY || !validSample(entry.data)) continue;
    output += entry.data.output;
    elapsedMs += entry.data.elapsedMs;
  }
  return elapsedMs > 0 ? output / elapsedMs * 1000 : undefined;
}

export function registerThroughput(pi: ExtensionAPI, refresh: () => void) {
  let enabled = false;
  let started: number | undefined;
  const reset = () => { started = undefined; };
  pi.on("session_start", (_event, ctx) => {
    reset();
    enabled = ctx.mode === "tui" && readOptions(pi.getSettings()).footer === true;
  });
  pi.on("before_provider_request", () => {
    if (enabled) started = performance.now();
  });
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || started === undefined) return;
    const sample: Sample = { version: 1, output: message.usage.output, elapsedMs: performance.now() - started };
    reset();
    // Error and aborted streams may report zero or incomplete usage without marking it.
    if (message.stopReason === "error" || message.stopReason === "aborted" || !validSample(sample)) return;
    pi.appendEntry(THROUGHPUT_ENTRY, sample);
    refresh();
  });
  pi.on("agent_settled", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => { reset(); enabled = false; });
}
