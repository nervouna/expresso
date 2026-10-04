import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assistant } from "../test/helpers.ts";

// This provider is loaded only by the offline demo and never sends network requests.
export default function timerDemo(pi: ExtensionAPI) {
  pi.registerTool({
    name: "expresso_demo_wait", label: "Demo wait", description: "Wait briefly for the timer demo.",
    parameters: Type.Object({ fail: Type.Boolean() }),
    annotations: { readOnlyHint: true },
    async execute(_id, args, signal) {
      await delay(1800, undefined, { signal });
      if (args.fail) throw new Error("Intentional demo failure");
      return { content: [{ type: "text", text: "EXPRESSO_LIVE_DETAIL" }], details: undefined };
    },
  });
  pi.registerProvider("expresso-demo", {
    api: "expresso-demo", apiKey: "offline-fixture", baseUrl: "https://offline.invalid",
    models: [{
      id: "timer", name: "Expresso offline timer", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096,
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output = {
        ...assistant([], "pending"), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      };
      const prompt = context.messages.map((message) => message.role).lastIndexOf("user");
      const step = context.messages.slice(prompt + 1).filter((message) => message.role === "assistant").length;
      const addText = (value: string) => {
        const contentIndex = output.content.length;
        const block = { type: "text" as const, text: "" };
        output.content.push(block);
        stream.push({ type: "text_start", contentIndex, partial: output });
        block.text = value;
        stream.push({ type: "text_delta", contentIndex, delta: value, partial: output });
        stream.push({ type: "text_end", contentIndex, content: value, partial: output });
      };
      void (async () => {
        try {
          stream.push({ type: "start", partial: output });
          await delay(600, undefined, { signal: options?.signal });
          if (step < 2) {
            if (step === 1) addText("A second group shares the first group's response timer.");
            for (let i = 0; i < 2; i++) {
              const contentIndex = output.content.length;
              const toolCall = {
                type: "toolCall" as const, id: `live-${randomUUID()}`, name: "expresso_demo_wait", arguments: {},
              };
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
              toolCall.arguments = { fail: step === 1 && i === 1 };
              stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
            }
            output.stopReason = "toolUse";
          } else {
            addText("Tools finished; the response timer is still running.");
            await delay(3500, undefined, { signal: options?.signal });
            addText(" LIVE TIMER COMPLETE.");
            output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  });
}
