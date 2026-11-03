// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - Isolated Promise/native transports; every process has explicit ownership.
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as Crypto from "node:crypto";
import type { OpenRestrictedOptions, AgentJsonSchema } from "../Restricted.ts";
import { OwnedProcess, JsonPeer, record, textBlocks, type Wire, type Launch } from "./process.ts";
import { copyCredential, type Profile, type RestrictedContext } from "./profile.ts";
export interface Completion {
  value: unknown;
  text: string;
  costUsd: number | null;
  outputMode: "native-schema" | "validated-json";
}
export interface CompletionInput {
  prompt: string;
  schema: AgentJsonSchema;
  signal: AbortSignal;
}
export interface RestrictedTransport {
  complete(input: CompletionInput): Promise<Completion>;
  close(): Promise<void>;
}
function executable(
  options: OpenRestrictedOptions,
  fallback: string,
  args: readonly string[],
): { command: string; args: string[] } {
  return {
    command: options.runtime?.command ?? fallback,
    args: [...(options.runtime?.args ?? []), ...args],
  };
}
function exactJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error("Provider did not return exactly one JSON response.");
  }
}
function bindAbort(proc: OwnedProcess, signal: AbortSignal): () => void {
  const stop = () => {
    void proc.stop();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return () => signal.removeEventListener("abort", stop);
}
function eventCompletion<T>(
  peer: JsonPeer,
  collect: (event: Wire, resolve: (value: T) => void, reject: (error: Error) => void) => void,
): { promise: Promise<T>; dispose(): void } {
  let off = () => {};
  let offFailure = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    off = peer.onEvent((event) => collect(event, resolve, reject));
    offFailure = peer.process.onFailure(reject);
  });
  // Request acceptance can fail before the caller starts awaiting completion.
  void promise.catch(() => {});
  return {
    promise,
    dispose: () => {
      off();
      offFailure();
    },
  };
}

export function piTransport(options: OpenRestrictedOptions, profile: Profile): RestrictedTransport {
  return {
    async complete({ prompt, signal }) {
      if (options.outputMode === "native-schema")
        throw new Error("Pi uses validated-json output, not native JSON Schema generation.");
      const agentDir = Path.join(profile.directory, "pi-agent");
      const source =
        profile.sourceEnvironment.PI_CODING_AGENT_DIR ??
        Path.join(profile.sourceHome, ".pi", "agent");
      await copyCredential(Path.join(source, "auth.json"), Path.join(agentDir, "auth.json"));
      await copyCredential(Path.join(source, "models.json"), Path.join(agentDir, "models.json"));
      const launch = executable(options, "pi", [
        "--mode",
        "rpc",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--offline",
        "--model",
        options.model,
        "--system-prompt",
        "Return only the requested JSON. No native tools are available.",
      ]);
      const proc = new OwnedProcess({
        ...launch,
        cwd: profile.workspace,
        env: { ...profile.environment, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      });
      const offAbort = bindAbort(proc, signal);
      const peer = new JsonPeer(proc, "pi");
      let final = "";
      let costUsd: number | null = null;
      let completion: ReturnType<typeof eventCompletion<string>> | undefined;
      try {
        await peer.request("get_state");
        await peer.request("set_auto_retry", { enabled: false });
        await peer.request("set_auto_compaction", { enabled: false });
        completion = eventCompletion<string>(peer, (event, resolve, reject) => {
          if (event.type === "tool_execution_start") {
            reject(new Error("Pi attempted a native tool in a tool-free session."));
            void proc.stop();
          }
          if (event.type === "message_end" && record(event.message).role === "assistant") {
            const message = record(event.message);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              reject(new Error("Pi inference failed or was aborted."));
              return;
            }
            final = textBlocks(message.content);
            const total = record(record(message.usage).cost).total;
            if (typeof total === "number") costUsd = total;
            if (
              Array.isArray(message.content) &&
              message.content.some((c) => record(c).type === "toolCall")
            ) {
              reject(new Error("Pi emitted a native tool call despite --no-tools."));
              void proc.stop();
            }
          }
          if (event.type === "agent_settled")
            event.aborted ? reject(new Error("Pi turn aborted.")) : resolve(final);
        });
        const accepted = await peer.request("prompt", { message: prompt });
        if (accepted.disposition !== "started")
          throw new Error("Pi did not start the restricted prompt.");
        const text = await completion.promise;
        signal.throwIfAborted();
        return { value: exactJson(text), text, costUsd, outputMode: "validated-json" };
      } finally {
        completion?.dispose();
        offAbort();
        await proc.stop();
      }
    },
    async close() {},
  };
}

export function openCodeTransport(
  options: OpenRestrictedOptions,
  profile: Profile,
): RestrictedTransport {
  return {
    async complete({ prompt, schema, signal }) {
      const sourceData =
        profile.sourceEnvironment.XDG_DATA_HOME ?? Path.join(profile.sourceHome, ".local", "share");
      await copyCredential(
        Path.join(sourceData, "opencode", "auth.json"),
        Path.join(profile.directory, "data", "opencode", "auth.json"),
      );
      const provider = record(
        record(JSON.parse(profile.sourceEnvironment.OPENCODE_CONFIG_CONTENT ?? "{}")).provider,
      );
      const config = {
        provider,
        permission: { "*": "deny", StructuredOutput: "allow" },
        tools: { "*": false, StructuredOutput: true },
        plugin: [],
        mcp: {},
        instructions: [],
        agent: {
          kit_restricted: {
            mode: "primary",
            prompt: "Return the requested JSON response. Native tools are disabled.",
            permission: { "*": "deny", StructuredOutput: "allow" },
          },
        },
      };
      const password = Crypto.randomUUID();
      const environment: NodeJS.ProcessEnv = {
        ...profile.environment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: Path.join(profile.directory, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_SERVER_USERNAME: "kit",
        OPENCODE_SERVER_PASSWORD: password,
      };
      delete environment.OPENCODE_CONFIG;
      const proc = new OwnedProcess({
        ...executable(options, "opencode", ["serve", "--pure", "--hostname=127.0.0.1", "--port=0"]),
        cwd: profile.workspace,
        env: environment,
      });
      const offAbort = bindAbort(proc, signal);
      let offReady = () => {},
        offFailure = () => {};
      try {
        const base = await new Promise<string>((resolve, reject) => {
          offReady = proc.onLine((line) => {
            const found = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
            if (found) resolve(found[1]!);
          });
          offFailure = proc.onFailure(reject);
        });
        offReady();
        offFailure();
        const call = async (path: string, body?: Wire): Promise<Wire> => {
          const response = await fetch(
            `${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(profile.workspace)}`,
            {
              method: body === undefined ? "GET" : "POST",
              headers: {
                authorization: `Basic ${Buffer.from(`kit:${password}`).toString("base64")}`,
                "content-type": "application/json",
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              signal,
            },
          );
          if (!response.ok)
            throw new Error(`Restricted OpenCode HTTP request failed (${response.status}).`);
          return record(await response.json());
        };
        const health = await call("/global/health");
        if (
          health.healthy !== true ||
          typeof health.version !== "string" ||
          !/^1\./.test(health.version)
        )
          throw new Error("Restricted OpenCode currently requires its v1 server API.");
        const session = await call("/session", {
          title: "Kit restricted completion",
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "StructuredOutput", pattern: "*", action: "allow" },
          ],
        });
        if (typeof session.id !== "string") throw new Error("OpenCode did not create a session.");
        if (
          !Array.isArray(session.permission) ||
          session.permission.some(
            (r) =>
              record(r).action !== "deny" &&
              !(
                record(r).permission === "StructuredOutput" &&
                record(r).pattern === "*" &&
                record(r).action === "allow"
              ),
          ) ||
          !session.permission.some(
            (r) =>
              record(r).permission === "*" &&
              record(r).pattern === "*" &&
              record(r).action === "deny",
          )
        )
          throw new Error("OpenCode did not retain the deny-all session permission rule.");
        const separator = options.model.indexOf("/");
        if (separator < 1) throw new Error("OpenCode model must be provider/model.");
        const mode = options.outputMode ?? "native-schema";
        const response = await call(`/session/${encodeURIComponent(session.id)}/message`, {
          model: {
            providerID: options.model.slice(0, separator),
            modelID: options.model.slice(separator + 1),
          },
          agent: "kit_restricted",
          tools: { "*": false, StructuredOutput: true },
          format:
            mode === "native-schema"
              ? { type: "json_schema", schema, retryCount: 0 }
              : { type: "text" },
          system: "Return exactly the JSON response requested. No prose or Markdown.",
          parts: [{ type: "text", text: prompt }],
        });
        const info = record(response.info);
        if (info.error) throw new Error("Restricted OpenCode inference failed.");
        const parts = Array.isArray(response.parts) ? response.parts : [];
        if (parts.some((p) => record(p).type === "tool" && record(p).tool !== "StructuredOutput"))
          throw new Error("OpenCode attempted a non-formatting native tool.");
        const text = textBlocks(parts);
        const value = mode === "native-schema" ? info.structured : exactJson(text);
        if (value === undefined)
          throw new Error("OpenCode did not return native structured output.");
        return {
          value,
          text,
          costUsd: typeof info.cost === "number" ? info.cost : null,
          outputMode: mode,
        };
      } finally {
        offReady();
        offFailure();
        offAbort();
        await proc.stop();
      }
    },
    async close() {},
  };
}

async function commandOutput(launch: Launch, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const proc = new OwnedProcess(launch);
  const off = bindAbort(proc, signal);
  let output = "";
  proc.onLine((line) => {
    output += line + "\n";
  });
  try {
    await proc.exited;
    signal.throwIfAborted();
    if (proc.child.exitCode !== 0)
      throw new Error("Restricted runtime configuration probe failed.");
    return output;
  } finally {
    off();
    await proc.stop();
  }
}
export function codexTransport(
  options: OpenRestrictedOptions,
  profile: Profile,
): RestrictedTransport {
  return {
    async complete({ prompt, schema, signal }) {
      const home = Path.join(profile.directory, "codex");
      const source =
        profile.sourceEnvironment.CODEX_HOME ?? Path.join(profile.sourceHome, ".codex");
      await copyCredential(Path.join(source, "auth.json"), Path.join(home, "auth.json"));
      const environment = { ...profile.environment, CODEX_HOME: home };
      const version = await commandOutput(
        {
          ...executable(options, "codex", ["--version"]),
          cwd: profile.workspace,
          env: environment,
        },
        signal,
      );
      // The catalog shape and default-tool removal are wire-tested against this protocol generation.
      if (!/codex-cli 0\.166\./.test(version))
        throw new Error("Restricted Codex requires the verified 0.166.x CLI tool contract.");
      const flags = await commandOutput(
        {
          ...executable(options, "codex", ["features", "list"]),
          cwd: profile.workspace,
          env: environment,
        },
        signal,
      );
      const { default: template } = await import("./codex-model.json", { with: { type: "json" } });
      const catalog = Path.join(profile.directory, "codex-model.json");
      await FS.writeFile(
        catalog,
        JSON.stringify({ models: [{ ...template, slug: options.model }] }),
        { mode: 0o600 },
      );
      const schemaFile = Path.join(profile.directory, "codex-output.json");
      await FS.writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
      const settings: Record<string, unknown> = {
        model_catalog_json: catalog,
        web_search: "disabled",
        project_doc_max_bytes: 0,
        "tools.update_plan.enabled": false,
        "agents.enabled": false,
        "plugins._default.enabled": false,
        "skills.bundled.enabled": false,
        "skills.include_instructions": false,
        suppress_unstable_features_warning: true,
        mcp_servers: {},
      };
      const featureNames = flags
        .split("\n")
        .map((line) => /^([a-z][a-z0-9_]*)\s+/.exec(line)?.[1])
        .filter((name): name is string => !!name);
      if (!featureNames.includes("shell_tool"))
        throw new Error("Codex did not expose its shell restriction feature.");
      for (const feature of featureNames) settings[`features.${feature}`] = false;
      settings["features.skip_host_skill_discovery"] = true;
      if (options.connection) {
        settings.model_provider = "kit_restricted";
        settings["model_providers.kit_restricted.name"] = "Kit configured provider";
        settings["model_providers.kit_restricted.base_url"] = options.connection.baseUrl;
        settings["model_providers.kit_restricted.wire_api"] = "responses";
        settings["model_providers.kit_restricted.env_key"] =
          options.connection.apiKeyEnv ?? "OPENAI_API_KEY";
        settings["model_providers.kit_restricted.requires_openai_auth"] = false;
      }
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--model",
        options.model,
      ];
      if (options.outputMode !== "validated-json") args.push("--output-schema", schemaFile);
      for (const [key, value] of Object.entries(settings))
        args.push("-c", `${key}=${JSON.stringify(value)}`);
      args.push("-");
      const proc = new OwnedProcess({
        ...executable(options, "codex", args),
        cwd: profile.workspace,
        env: environment,
      });
      const off = bindAbort(proc, signal);
      let text = "";
      let failure: Error | undefined;
      let completed = false;
      proc.onLine((line) => {
        let event: Wire;
        try {
          event = record(JSON.parse(line));
        } catch {
          failure = new Error("Invalid Codex event JSON.");
          return;
        }
        if (event.type === "turn.failed" || event.type === "error")
          failure = new Error("Restricted Codex inference failed.");
        const item = record(event.item);
        if (event.type === "item.completed" && item.type === "agent_message")
          text = String(item.text ?? "");
        if (event.type === "item.started" || event.type === "item.completed") {
          if (
            ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(
              String(item.type),
            )
          ) {
            failure = new Error("Codex attempted a native tool in the restricted profile.");
            void proc.stop();
          }
        }
        if (event.type === "turn.completed") completed = true;
      });
      proc.child.stdin.end(prompt);
      try {
        await proc.exited;
        signal.throwIfAborted();
        if (failure) throw failure;
        if (!completed || proc.child.exitCode !== 0)
          throw new Error("Codex did not complete the restricted response.");
        return {
          value: exactJson(text),
          text,
          costUsd: null,
          outputMode: options.outputMode ?? "native-schema",
        };
      } finally {
        off();
        await proc.stop();
      }
    },
    async close() {},
  };
}

export function acpTransport(
  options: OpenRestrictedOptions,
  profile: Profile,
  context: RestrictedContext,
): RestrictedTransport {
  return {
    async complete({ prompt, schema, signal }) {
      const antigravity = options.provider === "antigravity";
      const resolved = antigravity && !options.runtime ? await context.antigravity?.() : undefined;
      if (!resolved && !options.runtime)
        throw new Error("Generic ACP requires an explicit runtime command.");
      const environment: NodeJS.ProcessEnv = { ...profile.environment };
      let temp: string | undefined;
      if (antigravity) {
        const home = Path.join(profile.directory, "gemini");
        if (resolved)
          await copyCredential(
            Path.join(resolved.credentialDirectory, "antigravity-acp", "acp_token.json"),
            Path.join(home, "antigravity-acp", "acp_token.json"),
          );
        await FS.mkdir(Path.join(home, "antigravity-acp"), { recursive: true, mode: 0o700 });
        const auth = environment.GEMINI_API_KEY
          ? "gemini-api-key"
          : environment.GOOGLE_API_KEY
            ? "agent-platform"
            : "oauth-personal";
        await FS.writeFile(
          Path.join(home, "antigravity-acp", "settings.json"),
          JSON.stringify({ auth: { type: auth } }),
          { mode: 0o600 },
        );
        temp = await FS.mkdtemp(Path.join(profile.directory, "agy-runtime-"));
        Object.assign(environment, resolved?.env, {
          HOME: profile.directory,
          USERPROFILE: profile.directory,
          GEMINI_HOME: home,
          AGY_ACP_FORCE_FILE_STORAGE: "1",
          TMPDIR: temp,
          PYTHONUNBUFFERED: "1",
        });
        delete environment.T3CODE_THREAD_ID;
        // Authentication must already be configured. Never open a browser from restricted execution.
        environment.BROWSER = process.platform === "win32" ? "cmd /c exit 0" : "true";
      }
      signal.throwIfAborted();
      const launch = options.runtime
        ? executable(options, "", [])
        : { command: resolved!.command, args: [...resolved!.args] };
      const proc = new OwnedProcess({ ...launch, cwd: profile.workspace, env: environment });
      const off = bindAbort(proc, signal);
      const peer = new JsonPeer(proc, "rpc");
      let offEvent = () => {};
      try {
        const initialized = await peer.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "agent-provider-kit-restricted", version: "0.2.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });
        peer.notify("initialized");
        const info = record(initialized.agentInfo);
        const capabilities = record(record(initialized._meta).agentProviderKit);
        const version = String(info.version).split(".").map(Number);
        const knownAntigravity =
          info.name === "antigravity-acp" &&
          ((version[0] ?? 0) > 1 ||
            (version[0] === 1 &&
              ((version[1] ?? 0) > 4 || (version[1] === 4 && (version[2] ?? 0) >= 1))));
        if (antigravity && !knownAntigravity)
          throw new Error(
            "This Antigravity server does not have the verified enabledTools allowlist contract (requires 1.4.1+).",
          );
        if (
          !antigravity &&
          (capabilities.restrictedExecution !== 1 || capabilities.nativeTools !== "deny-all")
        )
          throw new Error(
            "ACP agent does not negotiate a deny-all native tool policy. No prompt was sent.",
          );
        if (antigravity) {
          const method = environment.GEMINI_API_KEY
            ? "gemini-api-key"
            : environment.GOOGLE_API_KEY
              ? "agent-platform"
              : "oauth-personal";
          await peer.request("authenticate", { methodId: method });
        }
        const policy = antigravity
          ? {
              antigravity: {
                enabledTools: [],
                systemPrompt:
                  "Return only the requested JSON. Native tools and inherited MCP are not available.",
              },
            }
          : {
              agentProviderKit: {
                restrictedExecution: 1,
                nativeTools: "deny-all",
                inheritedMcp: false,
                contextFiles: false,
                hooks: false,
              },
            };
        const session = await peer.request("session/new", {
          cwd: profile.workspace,
          mcpServers: [],
          _meta: policy,
        });
        if (typeof session.sessionId !== "string")
          throw new Error("ACP did not create a restricted session.");
        if (!antigravity) {
          const applied = record(record(session._meta).agentProviderKit);
          if (
            applied.nativeTools !== "deny-all" ||
            applied.inheritedMcp !== false ||
            applied.contextFiles !== false ||
            applied.hooks !== false
          )
            throw new Error("ACP did not acknowledge the complete restricted policy.");
        }
        const controls = Array.isArray(session.configOptions) ? session.configOptions : [];
        const model = controls.find((value) => record(value).category === "model");
        if (model)
          await peer.request("session/set_config_option", {
            sessionId: session.sessionId,
            configId: record(model).id ?? record(model).configId ?? "model",
            value: options.model,
          });
        else if (options.model !== "default")
          await peer.request("session/set_model", {
            sessionId: session.sessionId,
            modelId: options.model,
          });
        let text = "";
        let illegalTool = false;
        offEvent = peer.onEvent((event) => {
          const params = record(event.params);
          if (params.sessionId !== session.sessionId) return;
          const update = record(params.update);
          if (update.sessionUpdate === "agent_message_chunk") text += textBlocks([update.content]);
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            illegalTool = true;
            void proc.stop();
          }
        });
        const nativeSchema =
          !antigravity &&
          capabilities.outputSchema === true &&
          options.outputMode !== "validated-json";
        if (options.outputMode === "native-schema" && !nativeSchema)
          throw new Error(
            "This ACP runtime uses validated-json output, not native JSON Schema generation.",
          );
        const response = await peer.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
          _meta: { ...policy, ...(nativeSchema ? { outputSchema: schema } : {}) },
        });
        signal.throwIfAborted();
        if (illegalTool) throw new Error("ACP attempted a native tool in the restricted session.");
        if (response.stopReason !== "end_turn")
          throw new Error("ACP did not complete its restricted turn.");
        return {
          value: exactJson(text),
          text,
          costUsd: null,
          outputMode: nativeSchema ? "native-schema" : "validated-json",
        };
      } finally {
        offEvent();
        off();
        await proc.stop();
        if (temp) await FS.rm(temp, { recursive: true, force: true });
      }
    },
    async close() {},
  };
}
