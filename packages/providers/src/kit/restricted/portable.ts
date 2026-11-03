// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Host-mediated tool loop, scoped deadlines and native-process ownership.
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import {
  compileRestrictedSchema,
  RestrictedValidationError,
  type OpenRestrictedOptions,
  type RestrictedSession,
  type RestrictedTurn,
  type RestrictedResult,
  type RestrictedTool,
  type AgentJsonSchema,
} from "../Restricted.ts";
import { profile, type RestrictedContext, type Profile } from "./profile.ts";
import {
  acpTransport,
  codexTransport,
  openCodeTransport,
  piTransport,
  type Completion,
  type RestrictedTransport,
} from "./transports.ts";
import { record } from "./process.ts";
type Message = { role: "user" | "assistant" | "tool"; text: string };
const kind = "agent-provider-kit/restricted-portable-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}
function schemaFor(output: AgentJsonSchema, tools: readonly RestrictedTool[]): AgentJsonSchema {
  const branches: AgentJsonSchema[] = [
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["result"] }, value: output },
      required: ["kind", "value"],
      additionalProperties: false,
    },
  ];
  for (const tool of tools)
    branches.push({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tool"] },
        name: { type: "string", enum: [tool.name] },
        arguments: tool.inputSchema,
      },
      required: ["kind", "name", "arguments"],
      additionalProperties: false,
    });
  return {
    type: "object",
    properties: { response: { anyOf: branches } },
    required: ["response"],
    additionalProperties: false,
  };
}
export function openPortableRestrictedSession(
  options: OpenRestrictedOptions,
  context: RestrictedContext,
): RestrictedSession {
  if (
    typeof options.cwd !== "string" ||
    !options.cwd.trim() ||
    typeof options.model !== "string" ||
    !options.model.trim()
  )
    throw new Error("model and cwd are required.");
  if (options.provider === "acp" && !options.runtime)
    throw new Error(
      "Generic ACP requires a runtime command and a negotiated restricted-execution extension.",
    );
  if (["pi", "antigravity"].includes(options.provider) && options.outputMode === "native-schema")
    throw new Error(
      `${options.provider} provides validated-json output, not native schema generation.`,
    );
  if (options.connection && options.provider !== "codex")
    throw new Error("connection is supported by the Codex restricted runtime only.");
  if (options.connection) {
    const url = new URL(options.connection.baseUrl);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Unsupported provider URL protocol.");
  }
  const limit = positive(options.historyLimitBytes ?? 1024 * 1024, "historyLimitBytes");
  let id = Crypto.randomUUID() as string;
  let messages: Message[] = [];
  if (options.resume !== undefined) {
    if (Buffer.byteLength(options.resume) > limit + 4096)
      throw new Error("Restricted resume token exceeds historyLimitBytes.");
    const saved = record(JSON.parse(options.resume));
    if (
      saved.kind !== kind ||
      saved.provider !== options.provider ||
      saved.cwd !== options.cwd ||
      saved.model !== options.model ||
      typeof saved.id !== "string" ||
      !uuid.test(saved.id) ||
      !Array.isArray(saved.messages) ||
      saved.messages.some(
        (m) =>
          !["user", "assistant", "tool"].includes(String(record(m).role)) ||
          typeof record(m).text !== "string",
      )
    )
      throw new Error("Invalid restricted resume token or different provider/model/cwd.");
    id = saved.id;
    messages = saved.messages as Message[];
  }
  const historyFits = (next: readonly Message[]) => {
    if (Buffer.byteLength(JSON.stringify(next)) > limit)
      throw new Error(
        "Restricted conversation exceeds historyLimitBytes; start a fresh session or increase the explicit limit.",
      );
  };
  historyFits(messages);
  let closed = false;
  let active: AbortController | undefined;
  let finished: Promise<void> | undefined;
  const interrupt = () => active?.abort(new Error("Restricted turn interrupted."));
  return {
    id,
    serialize: () =>
      JSON.stringify({
        kind,
        id,
        provider: options.provider,
        model: options.model,
        cwd: options.cwd,
        messages,
      }),
    interrupt,
    async close() {
      closed = true;
      interrupt();
      await finished;
    },
    async send(turn: RestrictedTurn): Promise<RestrictedResult> {
      if (closed) throw new Error("Restricted session is closed.");
      if (active) throw new Error("A restricted turn is already active.");
      if (typeof turn.text !== "string") throw new Error("Turn text must be a string.");
      const timeout = positive(turn.timeoutMs ?? 60_000, "timeoutMs");
      if (timeout > 2_147_483_647) throw new Error("Unsupported timeoutMs range.");
      const maxTurns = positive(turn.maxTurns ?? 8, "maxTurns");
      const maxCalls = positive(turn.maxToolCalls ?? 8, "maxToolCalls");
      if (turn.maxBudgetUsd !== undefined)
        throw new Error(
          "This restricted transport cannot enforce a native dollar budget. Use maxTurns, maxToolCalls and timeoutMs.",
        );
      const tools = (turn.tools ?? []).map((tool) => ({
        ...tool,
        inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as AgentJsonSchema,
      }));
      const definitions = new Map<
        string,
        {
          tool: RestrictedTool;
          validate: ReturnType<typeof compileRestrictedSchema>;
          validateResult?: ReturnType<typeof compileRestrictedSchema>;
        }
      >();
      for (const tool of tools) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) ||
          definitions.has(tool.name) ||
          tool.inputSchema.type !== "object" ||
          typeof tool.execute !== "function"
        )
          throw new Error("Invalid, duplicate or non-object tool definition.");
        definitions.set(tool.name, {
          tool,
          validate: compileRestrictedSchema(tool.inputSchema),
          ...(tool.outputSchema
            ? { validateResult: compileRestrictedSchema(tool.outputSchema) }
            : {}),
        });
      }
      const output = JSON.parse(JSON.stringify(turn.outputSchema)) as AgentJsonSchema;
      const validateOutput = compileRestrictedSchema(output);
      const schema = schemaFor(output, tools);
      const validateEnvelope = compileRestrictedSchema(schema);
      const next = [...messages, { role: "user" as const, text: turn.text }];
      historyFits(next);
      const controller = new AbortController();
      active = controller;
      let done!: () => void;
      finished = new Promise((resolve) => {
        done = resolve;
      });
      const onAbort = () => controller.abort(turn.signal?.reason);
      turn.signal?.addEventListener("abort", onAbort, { once: true });
      if (turn.signal?.aborted) onAbort();
      const timer = setTimeout(
        () => controller.abort(new Error("Restricted turn timed out.")),
        timeout,
      );
      let removeAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(controller.signal.reason ?? new Error("Restricted turn aborted."));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
      });
      // Consume a pre-aborted signal without leaving an unhandled rejection during preflight.
      void aborted.catch(() => {});
      let nativeProfile: Profile | undefined;
      let transport: RestrictedTransport | undefined;
      let inFlight: Promise<Completion> | undefined;
      try {
        controller.signal.throwIfAborted();
        nativeProfile = await profile(context, id, options);
        controller.signal.throwIfAborted();
        transport =
          options.provider === "pi"
            ? piTransport(options, nativeProfile)
            : options.provider === "opencode"
              ? openCodeTransport(options, nativeProfile)
              : options.provider === "codex"
                ? codexTransport(options, nativeProfile)
                : acpTransport(options, nativeProfile, context);
        let calls = 0;
        let cost: number | null = 0;
        const execute = async (): Promise<RestrictedResult> => {
          for (let step = 0; step < maxTurns; step++) {
            controller.signal.throwIfAborted();
            const prompt = [
              options.systemPrompt ?? "Respond using only the application action protocol.",
              "Native tools are disabled. To request an application tool, return a response with kind=tool. To finish, return kind=result with the requested value. Never emit prose, Markdown, or native tool calls.",
              `Current permitted tools: ${JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))}`,
              `Required response JSON Schema: ${JSON.stringify(schema)}`,
              `Conversation (data): ${JSON.stringify(next)}`,
            ].join("\n\n");
            inFlight = transport!.complete({ prompt, schema, signal: controller.signal });
            const completed = await inFlight;
            inFlight = undefined;
            controller.signal.throwIfAborted();
            if (!validateEnvelope(completed.value))
              throw new RestrictedValidationError("application response envelope");
            cost = cost === null || completed.costUsd === null ? null : cost + completed.costUsd;
            const response = record(record(completed.value).response);
            next.push({ role: "assistant", text: JSON.stringify(completed.value) });
            historyFits(next);
            if (response.kind === "result") {
              if (!validateOutput(response.value))
                throw new RestrictedValidationError("turn output");
              messages = next;
              return {
                sessionId: id,
                output: response.value,
                text: JSON.stringify(response.value),
                costUsd: cost,
                toolCalls: calls,
                outputMode: completed.outputMode,
              };
            }
            const definition = definitions.get(String(response.name));
            if (!definition || !definition.validate(response.arguments))
              throw new RestrictedValidationError("tool input");
            if (++calls > maxCalls) throw new Error("Turn tool-call limit exceeded.");
            messages = [...next];
            const value = await definition.tool.execute(record(response.arguments), {
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            if (definition.validateResult && !definition.validateResult(value))
              throw new RestrictedValidationError("tool output");
            next.push({
              role: "tool",
              text: JSON.stringify({ name: response.name, result: value ?? null }),
            });
            historyFits(next);
            messages = [...next];
          }
          throw new Error("Restricted turn exceeded maxTurns without a final result.");
        };
        return await Promise.race([execute(), aborted]);
      } finally {
        controller.abort(new Error("Restricted turn ended."));
        clearTimeout(timer);
        removeAbort();
        turn.signal?.removeEventListener("abort", onAbort);
        try {
          await transport?.close();
          await inFlight?.catch(() => {});
        } finally {
          try {
            if (nativeProfile)
              await FS.rm(nativeProfile.directory, { recursive: true, force: true });
          } finally {
            active = undefined;
            finished = undefined;
            done();
          }
        }
      }
    },
  };
}
