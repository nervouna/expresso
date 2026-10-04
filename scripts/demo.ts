import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, call, text, type Assistant } from "../test/helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-expresso-demo-"));
const agentDir = join(directory, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  quietStartup: true, theme: "dark", expresso: { nerdFonts: process.argv.includes("--nerd-fonts") },
}));
writeFileSync(join(directory, "sample.txt"), "before\n");

function png() {
  const width = 128, height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rows.set(x < width / 2 ? [30, 170, 155] : [240, 140, 45], offset);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const session = SessionManager.create(process.cwd(), join(directory, "sessions"));
session.appendSessionInfo("Expresso offline acceptance demo");
session.appendMessage({ role: "user", content: "Offline fixture: use Ctrl+O to inspect tool details.", timestamp: 1 });
const heading = (value: string) => session.appendMessage(assistant([text(value)], "stop"));
const add = (calls: Extract<Assistant["content"][number], { type: "toolCall" }>[], failed?: string) => {
  session.appendMessage(assistant(calls));
  for (const c of calls) {
    session.appendMessage({
      role: "toolResult", toolCallId: c.id, toolName: c.name, timestamp: 2,
      isError: c.id === failed,
      content: c.id === "image"
        ? [{ type: "image", mimeType: "image/png", data: png() }]
        : [text(`EXPRESSO_DETAIL_${c.id}\nFull output for ${c.name}.`)],
      details: c.name === "edit" ? { diff: "-1 before\n+1 after", firstChangedLine: 1 } : undefined,
    });
  }
};
heading("Three calls across two execution steps should share one summary.");
add([
  call("read", "read", { path: join(directory, "sample.txt") }),
  call("bash", "bash", { command: "printf 'first line'\nprintf 'EXPRESSO_COMMAND_BODY'" }),
]);
add([call("write", "write", { path: join(directory, "new.txt"), content: "EXPRESSO_WRITE_BODY\nsecond line" })]);
heading("A standalone edit keeps its original expanded diff.");
add([call("edit", "edit", { path: join(directory, "sample.txt"), oldText: "before", newText: "after" })]);
heading("Codemode and an unregistered MCP tool should group, with a failure marker.");
add([
  call("code", "codemode", { code: "const data = await tools.read({ path: 'sample.txt' });\ntext(data);" }),
  call("mcp", "mcp__demo__lookup", { query: "offline fixture" }),
], "mcp");
heading("The image stays between two groups of two calls.");
add([
  call("left1"), call("left2"), call("image", "read", { path: "demo.png" }),
  call("right1"), call("right2"),
]);
heading("End of fixture. Ctrl+O toggles details; /reload checks extension reload.");

const args = [
  "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
  "-e", resolve("src/index.ts"), "--session", session.getSessionFile()!,
  ...process.argv.slice(2).filter((arg) => arg !== "--prepare-only" && arg !== "--nerd-fonts"),
];
const command = process.env.PI_BIN ?? resolve("node_modules/.bin/pi");
if (process.argv.includes("--prepare-only")) {
  console.log(JSON.stringify({ directory, agentDir, command, args }));
} else {
  try {
    const child = spawnSync(command, args, {
      stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" },
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
