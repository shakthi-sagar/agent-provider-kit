// Protocol fixtures for restricted execution. No models or real credentials are used.
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as http from "node:http";
const provider = process.argv[2];
const log = (entry) => {
  if (process.env.KIT_TEST_LOG)
    fs.appendFileSync(process.env.KIT_TEST_LOG, JSON.stringify(entry) + "\n");
};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
log({
  kind: "launch",
  provider,
  args: process.argv.slice(3),
  cwd: process.cwd(),
  home: process.env.HOME,
  geminiHome: process.env.GEMINI_HOME,
  config: process.env.OPENCODE_CONFIG_CONTENT,
});
function response() {
  const path = process.env.KIT_TEST_COUNTER;
  let index = 0;
  try {
    index = Number(fs.readFileSync(path, "utf8"));
  } catch {}
  if (path) fs.writeFileSync(path, String(index + 1));
  const values = JSON.parse(
    process.env.KIT_TEST_RESPONSES ?? '[{"response":{"kind":"result","value":{"ok":true}}}]',
  );
  return values[Math.min(index, values.length - 1)];
}
function finish(fn) {
  if (process.env.KIT_TEST_HANG !== "1") setTimeout(fn, Number(process.env.KIT_TEST_DELAY ?? "0"));
}
if (provider === "codex") {
  if (process.argv.includes("--version")) {
    console.log("codex-cli 0.166.0");
    process.exit(0);
  }
  if (process.argv.includes("features")) {
    console.log(
      "shell_tool stable true\ncode_mode stable true\nview_image stable true\nhooks stable true",
    );
    process.exit(0);
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  log({ kind: "prompt", provider, prompt: input });
  if (process.env.KIT_TEST_HANG === "1") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else {
    send({ type: "thread.started", thread_id: "test" });
    send({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(response()) },
    });
    send({ type: "turn.completed" });
  }
} else if (provider === "opencode") {
  const server = http.createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : undefined;
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/global/health")
      return res.end(JSON.stringify({ healthy: true, version: "1.18.35" }));
    if (path === "/session")
      return res.end(
        JSON.stringify({
          id: "test-session",
          permission: process.env.KIT_TEST_BAD_POLICY === "1" ? [] : body.permission,
        }),
      );
    if (path.endsWith("/message")) {
      log({ kind: "prompt", provider, body });
      finish(() => {
        const output = response();
        res.end(
          JSON.stringify({
            info: { structured: output, cost: 0 },
            parts: [{ type: "text", text: JSON.stringify(output) }],
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1", () =>
    console.log("opencode server listening on http://127.0.0.1:" + server.address().port),
  );
} else {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const req = JSON.parse(line);
    log({ kind: "request", provider, request: req });
    if (provider === "pi") {
      if (req.type === "prompt") {
        log({ kind: "prompt", provider, body: req });
        send({
          id: req.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { disposition: "started" },
        });
        finish(() => {
          send({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify(response()) }],
              stopReason: "stop",
              usage: { cost: { total: 0 } },
            },
          });
          send({ type: "agent_settled", aborted: false });
        });
      } else send({ id: req.id, type: "response", command: req.type, success: true, data: {} });
    } else {
      if (!req.method || req.id === undefined) continue;
      const result = (value) => send({ jsonrpc: "2.0", id: req.id, result: value });
      if (req.method === "initialize")
        result({
          protocolVersion: 1,
          agentInfo: {
            name: provider === "antigravity" ? "antigravity-acp" : "kit-test",
            version: "1.4.1",
          },
          _meta: {
            agentProviderKit:
              process.env.KIT_TEST_NO_POLICY === "1"
                ? {}
                : { restrictedExecution: 1, nativeTools: "deny-all", outputSchema: true },
          },
        });
      else if (req.method === "session/new")
        result({
          sessionId: "test-session",
          configOptions: [{ id: "model", category: "model" }],
          _meta: {
            agentProviderKit:
              process.env.KIT_TEST_BAD_POLICY === "1"
                ? {}
                : {
                    nativeTools: "deny-all",
                    inheritedMcp: false,
                    contextFiles: false,
                    hooks: false,
                  },
          },
        });
      else if (req.method === "session/prompt") {
        log({ kind: "prompt", provider, body: req.params });
        finish(() => {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "test-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: JSON.stringify(response()) },
              },
            },
          });
          result({ stopReason: "end_turn" });
        });
      } else result({});
    }
  }
}
