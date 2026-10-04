import type { MessageStartEvent } from "@earendil-works/pi-coding-agent";

export type Message = MessageStartEvent["message"];
export type Assistant = Extract<Message, { role: "assistant" }>;
export const text = (value: string) => ({ type: "text" as const, text: value });
export const call = (id: string, name = "read", args: Extract<Assistant["content"][number], { type: "toolCall" }>["arguments"] = { path: `${id}.txt` }) =>
  ({ type: "toolCall" as const, id, name, arguments: args });
export function assistant(content: Assistant["content"], stopReason: Assistant["stopReason"] = "toolUse"): Assistant {
  return {
    role: "assistant", content, api: "openai-completions", provider: "openai", model: "fixture",
    stopReason, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
export function result(id: string, content = [text(`result ${id}`)], isError = false): Extract<Message, { role: "toolResult" }> {
  return { role: "toolResult", toolCallId: id, toolName: "read", content, isError, timestamp: 2 };
}
export const png = {
  type: "image" as const, mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};
export const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
