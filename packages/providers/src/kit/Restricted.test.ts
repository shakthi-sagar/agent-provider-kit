import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  openRestrictedSession,
  RestrictedValidationError,
  UnsupportedRestrictedProviderError,
} from "./Restricted.ts";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
const schema = {
  type: "object",
  properties: { action: { type: "string", enum: ["pass"] } },
  required: ["action"],
  additionalProperties: false,
};
const inputSchema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
const options = { provider: "claude", model: "test-model", cwd: "/tmp/restricted-test" };
const turn = { text: "Choose an action", outputSchema: schema };
const sessions: ReturnType<typeof openRestrictedSession>[] = [];
const open = (overrides = {}) => {
  const session = openRestrictedSession({ ...options, ...overrides });
  sessions.push(session);
  return session;
};
const closes: ReturnType<typeof vi.fn>[] = [];
const success = (opts: Options, output: unknown = { action: "pass" }): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: output,
    session_id: opts.resume ?? opts.sessionId,
    result: "Done",
    total_cost_usd: 0,
  }) as SDKMessage;
function fake(scenario: (opts: Options) => AsyncGenerator<SDKMessage>) {
  queryMock.mockImplementationOnce(({ options }: { options: Options }) => {
    const close = vi.fn();
    closes.push(close);
    return Object.assign(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          tools: [...(options.allowedTools ?? []), "StructuredOutput"],
          permissionMode: "dontAsk",
          mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({
            name,
            status: "connected",
          })),
          skills: [],
          plugins: [],
          apiKeySource: "none",
          claude_code_version: "test",
          cwd: options.cwd ?? "/tmp",
          model: options.model ?? "test",
          slash_commands: [],
          output_style: "default",
          session_id: options.resume ?? options.sessionId ?? "test",
          uuid: "00000000-0000-4000-8000-000000000000",
        } as SDKMessage;
        yield* scenario(options);
      })(),
      { close },
    ) as unknown as Query;
  });
}
async function tools(opts: Options, task: (client: Client) => Promise<void>) {
  const config = opts.mcpServers?.kit_turn;
  if (!config || config.type !== "sdk") throw new Error("No SDK tool server");
  const client = new Client({ name: "test", version: "1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([config.instance.connect(a), client.connect(b)]);
  try {
    await task(client);
  } finally {
    await client.close();
  }
}
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  sessions.length = 0;
  closes.length = 0;
  queryMock.mockReset();
  vi.useRealTimers();
});

describe("restricted sessions", () => {
  it.each(["not-a-provider"])("rejects unverified provider %s before startup", (provider) => {
    expect(() => open({ provider })).toThrow(UnsupportedRestrictedProviderError);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("disables built-ins, inherited settings/MCP/plugins/agents/hooks and denies unrelated tools", async () => {
    fake(async function* (opts) {
      expect(opts.tools).toEqual([]);
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.mcpServers).toEqual({});
      expect(opts.agents).toEqual({});
      expect(opts.plugins).toEqual([]);
      expect(opts.hooks).toEqual({});
      expect(opts.skills).toEqual([]);
      expect(opts.extraArgs).toEqual({ "disable-slash-commands": null });
      expect(opts.settings).toEqual({ disableAllHooks: true });
      expect(opts.permissionMode).toBe("dontAsk");
      expect(opts.env?.ENABLE_TOOL_SEARCH).toBe("false");
      const canUse = opts.canUseTool!;
      for (const name of [
        "Bash",
        "Read",
        "Write",
        "WebFetch",
        "Skill",
        "Agent",
        "mcp__inherited__tool",
      ]) {
        const result = await canUse(
          name,
          {},
          {
            signal: new AbortController().signal,
            toolUseID: "tool-test",
            requestId: "request-test",
          },
        );
        expect(result?.behavior).toBe("deny");
      }
      yield success(opts);
    });
    expect((await open().send(turn)).output).toEqual({ action: "pass" });
    expect(closes[0]).toHaveBeenCalledOnce();
  });
  it("rejects a provider that exposes an unexpected built-in tool", async () => {
    fake(async function* () {
      yield { type: "system", subtype: "init", tools: ["Bash"] } as SDKMessage;
    });
    await expect(open().send(turn)).rejects.toThrow(/outside the restricted allowlist/);
    expect(closes[0]).toHaveBeenCalledOnce();
  });
  it.each(["permission", "mcp", "plugins", "skills"])(
    "rejects unexpected %s configuration at initialization",
    async (kind) => {
      fake(async function* (opts) {
        yield {
          type: "system",
          subtype: "init",
          tools: [],
          session_id: opts.resume ?? opts.sessionId,
          permissionMode: kind === "permission" ? "bypassPermissions" : "dontAsk",
          mcp_servers: kind === "mcp" ? [{ name: "inherited", status: "connected" }] : [],
          skills: kind === "skills" ? ["inherited-skill"] : [],
          plugins: kind === "plugins" ? [{ name: "inherited", path: "/tmp/plugin" }] : [],
        } as unknown as SDKMessage;
      });
      await expect(open().send(turn)).rejects.toThrow(/did not apply restricted/);
    },
  );
  it("advertises only explicit tools, validates input before invocation, and validates handler output", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({ received: input.value }));
    fake(async function* (opts) {
      expect(opts.allowedTools).toEqual(["mcp__kit_turn__act"]);
      await tools(opts, async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["act"]);
        await expect(
          client.callTool({ name: "act", arguments: { value: "wrong" } }),
        ).rejects.toThrow(/validation failed/);
        await expect(
          client.callTool({ name: "act", arguments: { value: 1, extra: true } }),
        ).rejects.toThrow(/validation failed/);
        expect(execute).not.toHaveBeenCalled();
        const response = await client.callTool({ name: "act", arguments: { value: 3 } });
        expect(response.content).toEqual([{ type: "text", text: '{"received":3}' }]);
        expect(execute).toHaveBeenCalledOnce();
        await expect(client.callTool({ name: "not_allowed", arguments: {} })).rejects.toThrow(
          /not available/,
        );
      });
      yield success(opts);
    });
    const result = await open().send({
      ...turn,
      tools: [
        {
          name: "act",
          description: "Allowed action",
          inputSchema,
          outputSchema: {
            type: "object",
            properties: { received: { type: "integer" } },
            required: ["received"],
            additionalProperties: false,
          },
          execute,
        },
      ],
    });
    expect(result.toolCalls).toBe(3);
  });
  it("replaces per-turn tool definitions while resuming the same native conversation", async () => {
    const session = open();
    fake(async function* (opts) {
      yield success(opts);
    });
    await session.send({
      ...turn,
      tools: [{ name: "old_action", description: "old", inputSchema, execute: async () => null }],
    });
    const saved = session.serialize();
    expect(JSON.parse(saved).sessionId).toBe(session.id);
    fake(async function* (opts) {
      expect(opts.resume).toBe(session.id);
      expect(opts.allowedTools).toEqual(["mcp__kit_turn__new_action"]);
      await tools(opts, async (client) => {
        await expect(
          client.callTool({ name: "old_action", arguments: { value: 1 } }),
        ).rejects.toThrow(/not available/);
      });
      yield success(opts);
    });
    await session.send({
      ...turn,
      tools: [{ name: "new_action", description: "new", inputSchema, execute: async () => null }],
    });
    const restored = open({ resume: saved });
    fake(async function* (opts) {
      expect(opts.resume).toBe(session.id);
      expect(opts.tools).toEqual([]);
      yield success(opts);
    });
    await restored.send(turn);
    expect(() => open({ resume: saved, cwd: "/different" })).toThrow(/resume token/);
    expect(() => open({ resume: JSON.stringify({ sessionId: session.id }) })).toThrow(
      /resume token/,
    );
  });
  it("enforces a per-turn tool-call budget", async () => {
    const execute = vi.fn(async () => null);
    fake(async function* (opts) {
      await tools(opts, async (client) => {
        await client.callTool({ name: "act", arguments: { value: 1 } });
        await expect(client.callTool({ name: "act", arguments: { value: 2 } })).rejects.toThrow(
          /limit exceeded/,
        );
      });
      yield success(opts);
    });
    await open().send({
      ...turn,
      maxToolCalls: 1,
      tools: [{ name: "act", description: "act", inputSchema, execute }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("rejects invalid tool results", async () => {
    fake(async function* (opts) {
      await tools(opts, async (client) => {
        await expect(client.callTool({ name: "act", arguments: { value: 1 } })).rejects.toThrow(
          /tool act output/,
        );
      });
      yield success(opts);
    });
    await open().send({
      ...turn,
      tools: [
        {
          name: "act",
          description: "act",
          inputSchema,
          outputSchema: { type: "integer" },
          execute: async () => "invalid",
        },
      ],
    });
  });
  it.each([{ action: "illegal" }, { action: "pass", extra: true }, undefined])(
    "rejects invalid or missing structured output %j without text parsing fallback",
    async (output) => {
      fake(async function* (opts) {
        const result = success(opts);
        if (result.type === "result" && result.subtype === "success")
          result.structured_output = output;
        yield result;
      });
      await expect(open().send(turn)).rejects.toThrow(RestrictedValidationError);
    },
  );
  it("validates standard string formats instead of accepting them silently", async () => {
    fake(async function* (opts) {
      yield success(opts, { email: "not-an-email" });
    });
    await expect(
      open().send({
        ...turn,
        outputSchema: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
          additionalProperties: false,
        },
      }),
    ).rejects.toThrow(RestrictedValidationError);
  });
  it("checks schemas, tool names and budgets before starting the provider", async () => {
    const session = open();
    await expect(session.send({ ...turn, outputSchema: { type: "wrong" } })).rejects.toThrow();
    await expect(
      session.send({ ...turn, outputSchema: { $async: true, type: "object" } }),
    ).rejects.toThrow(/Asynchronous/);
    await expect(session.send({ ...turn, timeoutMs: 0 })).rejects.toThrow(/positive/);
    await expect(session.send({ ...turn, maxBudgetUsd: -1 })).rejects.toThrow(/positive/);
    await expect(
      session.send({
        ...turn,
        tools: [{ name: "../bad", description: "bad", inputSchema, execute: async () => null }],
      }),
    ).rejects.toThrow(/Invalid/);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("honours cancellation, rejects concurrent turns, and closes the SDK query", async () => {
    fake(async function* () {
      await new Promise(() => {});
    });
    const session = open();
    const controller = new AbortController();
    const result = session.send({ ...turn, signal: controller.signal });
    const rejection = expect(result).rejects.toThrow(/cancelled/);
    await expect(session.send(turn)).rejects.toThrow(/already active/);
    controller.abort(new Error("cancelled"));
    await rejection;
    expect(closes[0]).toHaveBeenCalled();
    fake(async function* (opts) {
      yield success(opts);
    });
    await session.send(turn);
    await session.close();
    await expect(session.send(turn)).rejects.toThrow(/closed/);
  });
  it("does not launch a query for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(open().send({ ...turn, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("enforces the deadline even if the SDK stops producing messages", async () => {
    vi.useFakeTimers();
    fake(async function* () {
      await new Promise(() => {});
    });
    const pending = open().send({ ...turn, timeoutMs: 20 });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(closes[0]).toHaveBeenCalled();
  });
  it("does not treat a provider error as a valid action", async () => {
    fake(async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true } as SDKMessage;
    });
    await expect(open().send(turn)).rejects.toThrow(/error_max_turns/);
  });
});
