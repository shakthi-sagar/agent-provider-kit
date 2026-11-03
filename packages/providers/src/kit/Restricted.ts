// @effect-diagnostics nodeBuiltinImport:off - restricted sessions use the SDK's Promise API directly.
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv, type ValidateFunction } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import * as Crypto from "node:crypto";
import { openPortableRestrictedSession } from "./restricted/portable.ts";
import type { RestrictedContext } from "./restricted/profile.ts";

/** JSON Schema draft-07. External/remote references are not fetched. */
export type AgentJsonSchema = Record<string, unknown>;
export interface RestrictedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentJsonSchema;
  readonly outputSchema?: AgentJsonSchema;
  /** Trusted application code. Honour signal and enforce authorization in the handler. */
  readonly execute: (
    input: Record<string, unknown>,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
}
export interface RestrictedTurn {
  readonly text: string;
  readonly outputSchema: AgentJsonSchema;
  /** Replaced every turn, never merged with the previous turn's tools. Empty by default. */
  readonly tools?: readonly RestrictedTool[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxBudgetUsd?: number;
}
export interface RestrictedResult {
  readonly sessionId: string;
  readonly output: unknown;
  readonly text: string;
  readonly costUsd: number | null;
  readonly outputMode: "native-schema" | "validated-json";
  readonly toolCalls: number;
}
export interface OpenRestrictedOptions {
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Only tokens produced by RestrictedSession.serialize() are accepted. */
  readonly resume?: string;
  /** Trusted executable override. Arguments precede the enforced isolation flags. */
  readonly runtime?: { readonly command: string; readonly args?: readonly string[] };
  /** Native schema generation or explicit strict-JSON + local validation (Pi/Antigravity). */
  readonly outputMode?: "native-schema" | "validated-json";
  readonly historyLimitBytes?: number;
  /** Explicit Responses-compatible endpoint for the Codex runtime; credentials remain in env. */
  readonly connection?: { readonly baseUrl: string; readonly apiKeyEnv?: string };
  readonly instance?: string;
}
export interface RestrictedSession {
  readonly id: string;
  send(turn: RestrictedTurn): Promise<RestrictedResult>;
  serialize(): string;
  interrupt(): void;
  close(): Promise<void>;
}
export class UnsupportedRestrictedProviderError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(
      `Restricted execution is not verified for ${provider}. Supported providers: claude, pi, opencode, codex, antigravity, and ACP with a negotiated restriction extension. No coding-session fallback was started.`,
    );
    this.name = "UnsupportedRestrictedProviderError";
    this.provider = provider;
  }
}
export class RestrictedValidationError extends Error {
  readonly boundary: string;
  constructor(boundary: string) {
    super(`JSON Schema validation failed at ${boundary}.`);
    this.name = "RestrictedValidationError";
    this.boundary = boundary;
  }
}
export const compileRestrictedSchema = (schema: AgentJsonSchema): ValidateFunction => {
  // Copy so neither the SDK nor a caller can change the validation contract in flight.
  const validator = new Ajv({ allErrors: false, strict: true, ownProperties: true });
  for (const [name, format] of Object.entries(fullFormats)) validator.addFormat(name, format);
  const copy = JSON.parse(JSON.stringify(schema)) as AgentJsonSchema;
  if (copy.$async) throw new Error("Asynchronous JSON Schemas are not supported.");
  return validator.compile(copy);
};
const positive = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} must be a positive integer.`);
  return value;
};
const serverName = "kit_turn";
const resumeKind = "agent-provider-kit/restricted-claude-v1";

/**
 * Enforces a model-tool boundary, not an OS sandbox. The CLI still accesses its own
 * credentials/session files/network. No built-in coding tools, inherited MCP, skills or hooks
 * are enabled. Application handlers are trusted code, not isolated by this API.
 */
export function openRestrictedSession(
  options: OpenRestrictedOptions,
  context?: RestrictedContext,
): RestrictedSession {
  if (options.provider !== "claude") {
    if (!["pi", "opencode", "codex", "antigravity", "acp"].includes(options.provider))
      throw new UnsupportedRestrictedProviderError(options.provider);
    if (!context)
      throw new Error("Portable restricted sessions require kit-owned profile storage.");
    return openPortableRestrictedSession(options, context);
  }
  if (options.connection)
    throw new Error("connection is supported by the Codex restricted runtime only.");
  if (options.historyLimitBytes !== undefined)
    throw new Error("historyLimitBytes applies to host-managed restricted sessions only.");
  if (options.runtime)
    throw new Error(
      "Claude uses its pinned SDK runtime; executable overrides are not supported here.",
    );
  if (options.outputMode === "validated-json")
    throw new Error("Claude restricted sessions always use native-schema output.");
  if (!options.model.trim() || !options.cwd.trim()) throw new Error("model and cwd are required.");
  const model = options.model;
  const cwd = options.cwd;
  const systemPrompt =
    options.systemPrompt ??
    "Use only the tools provided for this turn. Return the requested structured response.";
  const environment = { ...process.env, ...options.env, ENABLE_TOOL_SEARCH: "false" };
  let nativeId: string | undefined;
  if (options.resume !== undefined) {
    const saved: unknown = JSON.parse(options.resume);
    if (
      !saved ||
      typeof saved !== "object" ||
      !("kind" in saved) ||
      saved.kind !== resumeKind ||
      !("sessionId" in saved) ||
      typeof saved.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.sessionId) ||
      !("cwd" in saved) ||
      saved.cwd !== cwd
    ) {
      throw new Error("Invalid restricted-session resume token or different working directory.");
    }
    nativeId = saved.sessionId;
  }
  const id = nativeId ?? Crypto.randomUUID();
  let closed = false;
  let active: AbortController | undefined;
  let activeQuery: Query | undefined;
  let activeFinished: Promise<void> | undefined;
  const abort = () => {
    active?.abort(new Error("Restricted turn interrupted."));
    activeQuery?.close();
  };
  return {
    id,
    serialize() {
      if (!nativeId) throw new Error("No initialized native session to serialize yet.");
      return JSON.stringify({ kind: resumeKind, sessionId: nativeId, cwd });
    },
    interrupt: abort,
    async close() {
      closed = true;
      abort();
      await activeFinished;
    },
    async send(turn) {
      if (closed) throw new Error("Restricted session is closed.");
      if (active) throw new Error("A restricted turn is already active.");
      if (typeof turn.text !== "string") throw new Error("Turn text must be a string.");
      const timeoutMs = positive(turn.timeoutMs ?? 60_000, "timeoutMs");
      if (timeoutMs > 2_147_483_647)
        throw new Error("timeoutMs exceeds the supported timer range.");
      const maxTurns = positive(turn.maxTurns ?? 8, "maxTurns");
      const maxToolCalls = positive(turn.maxToolCalls ?? 8, "maxToolCalls");
      if (
        turn.maxBudgetUsd !== undefined &&
        (!Number.isFinite(turn.maxBudgetUsd) || turn.maxBudgetUsd <= 0)
      )
        throw new Error("maxBudgetUsd must be positive.");
      const outputSchema = JSON.parse(JSON.stringify(turn.outputSchema)) as AgentJsonSchema;
      const validateOutput = compileRestrictedSchema(outputSchema);
      const definitions = new Map<
        string,
        { tool: RestrictedTool; validate: ValidateFunction; validateResult?: ValidateFunction }
      >();
      for (const tool of turn.tools ?? []) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || definitions.has(tool.name))
          throw new Error(`Invalid or duplicate tool name: ${tool.name}`);
        if (tool.inputSchema.type !== "object")
          throw new Error(`Tool ${tool.name} must have an object input schema.`);
        const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema)) as AgentJsonSchema;
        definitions.set(tool.name, {
          tool: { ...tool, inputSchema },
          validate: compileRestrictedSchema(inputSchema),
          ...(tool.outputSchema
            ? { validateResult: compileRestrictedSchema(tool.outputSchema) }
            : {}),
        });
      }
      const controller = new AbortController();
      active = controller;
      let finishTurn!: () => void;
      activeFinished = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      const onAbort = () => {
        controller.abort(turn.signal?.reason);
        activeQuery?.close();
      };
      turn.signal?.addEventListener("abort", onAbort, { once: true });
      if (turn.signal?.aborted) onAbort();
      // @effect-diagnostics-next-line globalTimers:off - This Promise transport owns and clears its deadline timer.
      const timer = setTimeout(() => {
        controller.abort(new Error("Restricted turn timed out."));
        activeQuery?.close();
      }, timeoutMs);
      const server = new McpServer(
        { name: serverName, version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      let toolCalls = 0;
      let acceptingCalls = true;
      let initialized = false;
      let finishInput!: () => void;
      const inputFinished = new Promise<void>((resolve) => {
        finishInput = resolve;
      });
      const allowedNames = new Set(
        [...definitions.keys()].map((name) => `mcp__${serverName}__${name}`),
      );
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...definitions.values()].map(({ tool }) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { ...tool.inputSchema, type: "object" as const },
        })),
      }));
      server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        controller.signal.throwIfAborted();
        if (!acceptingCalls) throw new Error("Turn has ended.");
        if (!initialized)
          throw new Error("Provider has not passed restricted initialization checks.");
        const definition = definitions.get(request.params.name);
        if (!definition) throw new Error("Tool is not available for this turn.");
        if (++toolCalls > maxToolCalls) throw new Error("Turn tool-call limit exceeded.");
        const input = request.params.arguments ?? {};
        if (!definition.validate(input))
          throw new RestrictedValidationError(`tool ${request.params.name} input`);
        const value = await definition.tool.execute(input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!acceptingCalls) throw new Error("Turn has ended.");
        if (definition.validateResult && !definition.validateResult(value))
          throw new RestrictedValidationError(`tool ${request.params.name} output`);
        return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
      });
      // Streaming input stays open for in-process MCP exchanges until the result arrives.
      async function* prompt(): AsyncIterable<SDKUserMessage> {
        yield {
          type: "user",
          session_id: nativeId ?? id,
          parent_tool_use_id: null,
          message: { role: "user", content: turn.text },
        };
        await inputFinished;
      }
      let removeAbortListener = () => {};
      try {
        controller.signal.throwIfAborted();
        const run = query({
          prompt: prompt(),
          options: {
            model,
            cwd,
            systemPrompt,
            env: environment,
            ...(nativeId ? { resume: nativeId } : { sessionId: id }),
            abortController: controller,
            tools: [],
            agents: {},
            plugins: [],
            hooks: {},
            skills: [],
            settingSources: [],
            extraArgs: { "disable-slash-commands": null },
            settings: { disableAllHooks: true },
            strictMcpConfig: true,
            mcpServers: definitions.size
              ? { [serverName]: { type: "sdk", name: serverName, instance: server } }
              : {},
            allowedTools: [...allowedNames],
            permissionMode: "dontAsk",
            canUseTool: async (name, input) =>
              allowedNames.has(name) || name === "StructuredOutput"
                ? { behavior: "allow", updatedInput: input }
                : {
                    behavior: "deny",
                    message: "Only the application's tools for this turn are permitted.",
                  },
            outputFormat: { type: "json_schema", schema: outputSchema },
            maxTurns,
            ...(turn.maxBudgetUsd !== undefined ? { maxBudgetUsd: turn.maxBudgetUsd } : {}),
            persistSession: true,
          },
        });
        activeQuery = run;
        const aborted = new Promise<never>((_, reject) => {
          const listener = () =>
            reject(controller.signal.reason ?? new Error("Restricted turn aborted."));
          controller.signal.addEventListener("abort", listener, { once: true });
          removeAbortListener = () => controller.signal.removeEventListener("abort", listener);
          if (controller.signal.aborted) listener();
        });
        const consume = async (): Promise<RestrictedResult> => {
          for await (const message of run) {
            controller.signal.throwIfAborted();
            if (message.type === "system" && message.subtype === "init") {
              if (
                message.tools.some((name) => !allowedNames.has(name) && name !== "StructuredOutput")
              )
                throw new Error("Provider exposed tools outside the restricted allowlist.");
              if (
                message.permissionMode !== "dontAsk" ||
                message.mcp_servers.some((server) => server.name !== serverName) ||
                message.skills.length ||
                message.plugins.length
              )
                throw new Error("Provider did not apply restricted session settings.");
              if (message.session_id !== (nativeId ?? id))
                throw new Error("Provider initialized a different session.");
              nativeId = message.session_id;
              initialized = true;
            }
            if (message.type !== "result") continue;
            if (!initialized)
              throw new Error(
                "Provider returned a result without verified restricted initialization.",
              );
            if (message.subtype !== "success" || message.is_error)
              throw new Error(`Restricted provider failed: ${message.subtype}`);
            // No text/JSON extraction fallback: only native structured output is accepted.
            if (!validateOutput(message.structured_output))
              throw new RestrictedValidationError("turn output");
            if (message.session_id !== (nativeId ?? id))
              throw new Error("Provider returned a result for a different session.");
            nativeId = message.session_id;
            return {
              sessionId: message.session_id,
              output: message.structured_output,
              text: message.result,
              costUsd: message.total_cost_usd,
              outputMode: "native-schema",
              toolCalls,
            };
          }
          throw new Error("Provider ended without a structured result.");
        };
        return await Promise.race([consume(), aborted]);
      } finally {
        acceptingCalls = false;
        controller.abort(new Error("Restricted turn ended."));
        finishInput();
        clearTimeout(timer);
        removeAbortListener();
        turn.signal?.removeEventListener("abort", onAbort);
        try {
          activeQuery?.close();
        } finally {
          activeQuery = undefined;
          // A cancelled query may already have closed its transport.
          await server.close().catch(() => {});
          active = undefined;
          activeFinished = undefined;
          finishTurn();
        }
      }
    },
  };
}
