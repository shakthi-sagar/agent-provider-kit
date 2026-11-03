// Runs real installed CLIs against a local fake model API. No live inference or real credentials.
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const { createAgentKit } = await import(
  process.env.APK_KIT_ENTRY ??
    (process.env.APK_TEST_DIST === "1"
      ? "../packages/kit/dist/index.mjs"
      : "../packages/kit/src/index.ts")
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "apk-native-restricted-"));
const requests = [];

let calls = 0;
const finalEnvelope = { response: { kind: "result", value: { ok: true } } };
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const envelope =
    calls++ === 0
      ? { response: { kind: "tool", name: "inspect", arguments: { id: 7 } } }
      : finalEnvelope;
  requests.push({ url: req.url, tools: body.tools ?? [], body });
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (req.url.includes("responses")) {
    const text = JSON.stringify(envelope);
    const item = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    for (const [name, data] of [
      [
        "response.created",
        { response: { id: "resp_test", object: "response", status: "in_progress", output: [] } },
      ],
      ["response.output_item.added", { output_index: 0, item }],
      [
        "response.output_text.delta",
        { item_id: "msg_test", output_index: 0, content_index: 0, delta: text },
      ],
      ["response.output_item.done", { output_index: 0, item }],
      [
        "response.completed",
        {
          response: {
            id: "resp_test",
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ],
    ])
      res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
  } else {
    const format = (body.tools ?? []).find((t) => t.function?.name === "StructuredOutput");
    const delta = format
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_test",
              type: "function",
              function: { name: "StructuredOutput", arguments: JSON.stringify(envelope) },
            },
          ],
        }
      : { role: "assistant", content: JSON.stringify(envelope) };
    const base = {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 0,
      model: "model",
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: format ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
  }
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
const piHome = path.join(root, "source-pi");
await fs.mkdir(piHome, { recursive: true });
await fs.writeFile(
  path.join(piHome, "models.json"),
  JSON.stringify({
    providers: {
      "kit-test": {
        baseUrl: baseURL,
        api: "openai-completions",
        apiKey: "dummy",
        models: [
          {
            id: "model",
            name: "Mock",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  }),
);
const kit = createAgentKit({ baseDir: path.join(root, "kit") });
try {
  for (const provider of ["codex", "pi", "opencode"]) {
    const from = requests.length;
    calls = 0;
    let handled = 0;
    const opts = {
      provider,
      cwd: root,
      model: provider === "codex" ? "kit-test" : "kit-test/model",
      env: {
        HOME: root,
        USERPROFILE: root,
        PI_CODING_AGENT_DIR: piHome,
        OPENAI_API_KEY: "dummy",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            "kit-test": {
              npm: "@ai-sdk/openai-compatible",
              name: "Mock",
              options: { baseURL, apiKey: "dummy" },
              models: {
                model: { name: "Mock", tool_call: true, limit: { context: 128000, output: 8192 } },
              },
            },
          },
        }),
      },
      ...(provider === "codex" ? { connection: { baseUrl: baseURL } } : {}),
    };
    const session = await kit.openRestricted(opts);
    try {
      const result = await session.send({
        text: "Return the final result",
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        timeoutMs: 45000,
        tools: [
          {
            name: "inspect",
            description: "Inspect an authorized item",
            inputSchema: {
              type: "object",
              properties: { id: { type: "integer" } },
              required: ["id"],
              additionalProperties: false,
            },
            execute: async (input) => {
              if (input.id !== 7) throw Error("Invalid application tool input");
              handled++;
              return { visible: "only visible data" };
            },
          },
        ],
      });
      if (
        handled !== 1 ||
        !JSON.stringify(requests.slice(from).at(-1)?.body).includes("only visible data")
      )
        throw Error("Application tool context was not propagated");
      const sent = requests.slice(from).map((r) => ({
        url: r.url,
        tools: r.tools.map((t) => t.name ?? t.function?.name ?? t.type),
      }));
      if (sent.some((r) => r.tools.some((t) => t !== "StructuredOutput")))
        throw Error("Native tool leaked into model request");
      console.log(
        JSON.stringify({
          provider,
          ok: result.output,
          outputMode: result.outputMode,
          handled,
          sent,
        }),
      );
    } catch (e) {
      console.log(
        JSON.stringify({
          provider,
          error: String(e),
          sent: requests.slice(from).map((r) => ({
            url: r.url,
            tools: r.tools.map((t) => t.name ?? t.function?.name ?? t.type),
          })),
        }),
      );
      process.exitCode = 1;
    } finally {
      await session.close();
    }
  }
} finally {
  await kit.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
