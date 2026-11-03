# Agent Provider Kit

Drive AI coding agents from your own code: Claude Code, Codex, Antigravity, Pi, OpenCode, any ACP agent,
and OpenAI- or Anthropic-compatible APIs (DeepSeek, OpenRouter, ...). One small Promise/async-iterator API.

This is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). The provider drivers are T3's;
this repo cuts them out of the app and adds a standalone API on top. See [UPSTREAM.md](UPSTREAM.md) for
what was kept, what changed, and how to pull in newer T3 code.

## Install

```sh
npm install agent-provider-kit
```

Needs Node 22.18+. The package is bundled JavaScript with type declarations; TypeScript projects get
the full types with no extra setup. The agents themselves (the `claude`, `codex`, `pi`, `opencode` CLIs)
are not bundled: install and sign in to the ones you want to use.

To work on the kit itself, clone this repo, run `pnpm install`, and link the source into another
project with `pnpm add link:/path/to/agent-provider-kit/packages/kit` (Node runs the `.ts` source
directly). `pnpm build:npm` produces the publishable package in `packages/kit/dist`.

## Use

```ts
import { createAgentKit, openaiCompatible } from "agent-provider-kit";

const kit = createAgentKit(); // state in ~/.agent-provider-kit
try {
  const agent = await kit.open({ provider: "claude", model: "claude-haiku-4-5", cwd: process.cwd() });
  for await (const event of agent.send("Fix the failing test")) {
    if (event.type === "message.updated") console.log(event.message.text);
  }
  // agent.respond({ requestId, decision }) answers approval requests; agent.interrupt() stops a turn.
} finally {
  await kit.dispose();
}
```

The `provider` option takes one of these values:

| `provider` | Needs |
| --- | --- |
| `claude` | The `claude` CLI, signed in |
| `codex` | The `codex` CLI, signed in (regular setup; managed Codex is not supported) |
| `antigravity` | `await kit.install("antigravity")`, then `kit.signIn({ provider: "antigravity" })` once |
| `pi` | The `pi` CLI with its provider credentials configured |
| `opencode` | The `opencode` CLI with its provider credentials configured |
| `acp` | `config: { source: "local", commandPath, commandArgs }` or a registry agent |

`send` yields T3's `ProviderAdapterV2Event`s until that turn's `turn.terminal`. Check the terminal
status for provider-reported failures; startup/protocol exceptions reject the iterator. To continue a conversation, pass `resume: agent.providerThread`, or persist `agent.serialize()`
and pass that string as `resume` after restarting. See [session support](SESSION_SUPPORT.md).

### Restricted execution (0.2.0)

`kit.open()` is a coding-agent API and defaults to full access. For game contestants or narrowly
scoped application actions, use `openRestricted()` instead. Claude, Pi, OpenCode, Codex and
Antigravity have dedicated restricted transports. Generic ACP requires explicit policy negotiation;
ordinary ACP permission callbacks alone cannot enforce this boundary.

```ts
const agent = await kit.openRestricted({
  provider: "claude",
  model: "claude-haiku-4-5",
  cwd: "/path/to/disposable-workspace",
  systemPrompt: "Choose an action from the supplied observation and tools.",
});
const result = await agent.send({
  text: JSON.stringify(playerObservation), // filter hidden state in your application
  outputSchema: {
    type: "object",
    properties: { action: { type: "string", enum: ["pass", "move"] } },
    required: ["action"], additionalProperties: false,
  },
  tools: [{
    name: "inspect_visible_item",
    description: "Inspect an item this player is authorized to see",
    inputSchema: {
      type: "object", properties: { id: { type: "string" } },
      required: ["id"], additionalProperties: false,
    },
    execute: async ({ id }, { signal }) => inspectAuthorizedItem(id, signal),
  }],
  maxTurns: 4,
  maxToolCalls: 1,
  timeoutMs: 30_000,
  signal: abortController.signal,
});
// result.output is unknown, validated against outputSchema. Apply domain validation too.
const action = gameEngine.validateAction(result.output);
const resumeToken = agent.serialize(); // reopen via openRestricted({ ...options, resume: resumeToken })
await agent.close();
```

Schemas are plain JSON Schema draft-07 with standard formats; no Zod types are required. Tool
inputs are validated before dispatch, and optional tool output schemas validate handler results.
The explicit per-turn tool list replaces the previous list and defaults to empty.

| Provider | Native tool restriction | Output and conversation |
| --- | --- | --- |
| Claude | Empty SDK built-ins, isolated settings/MCP, deny outside explicit tools | Native schema; native conversation resume |
| Pi | `--no-tools`, extensions/MCP/skills/context disabled, private profile | Strict validated JSON; host-managed history |
| OpenCode | Private pure server, deny-all tools/permissions; only internal formatter allowed | Native schema; host-managed history |
| Codex | Private profile and tool-free catalog; features/skills/plugins/MCP disabled | Native schema; host-managed history; requires CLI 0.166.x |
| Antigravity | Native `enabledTools: []`, private profile, no client filesystem/terminal/MCP | Strict validated JSON; host-managed history; requires server 1.4.1+ |
| Generic ACP | Explicit restricted policy acknowledgment; see [session support](SESSION_SUPPORT.md) | Negotiated native schema or strict validated JSON; host-managed history |

For non-Claude providers, native tools stay disabled. The model returns a JSON action envelope,
and the kit validates it before invoking an application handler. Pi and Antigravity do not expose
native schema generation: the entire response must parse as JSON and pass schema validation;
invalid output rejects without executing an action. `result.outputMode` reports `native-schema`
or `validated-json`. Requiring `outputMode: "native-schema"` rejects incompatible transports.
Native providers may reject schemas outside their supported subset.

Defaults are a 60-second deadline, eight model turns and eight application tool calls. Claude also
supports `maxBudgetUsd`; other transports reject it because they cannot enforce a dollar budget.
Unknown cost is `null`. `interrupt()`, AbortSignal, `close()` and kit `dispose()` cancel active work.
Handlers receive a signal and must honour it; cancellation cannot undo completed side effects.
Calls are sequential per session. Portable history is replayed into fresh isolated native completions,
bounded to 1 MiB by default (`historyLimitBytes`). Serialized tokens contain conversation/tool text;
store them privately. They never contain copied credentials.

This is a **model tool boundary, not process/container isolation**. Trusted native executables still
use credentials and network; trusted handlers run in your process. Non-Claude transports use empty
private workspaces rather than exposing `cwd`; that option binds the logical session identity.
For AI Plays, provide filtered observations and validate authorization/actions again in the engine.
Archive can review proposed edits; Content Factory's handlers must preserve its user approval gate.
These changes do not replace backends in those applications. See [verification and version limits](SESSION_SUPPORT.md).

The npm build explicitly depends on the Claude SDK's peer packages, including its own Zod 4, so an
application using Zod 3 does not need to upgrade or suppress peer warnings.

### Continuing a session

Call `agent.send()` again to continue an open conversation. To close the runtime and resume later:

```ts
const saved = agent.serialize(); // save after consuming the turn's events
await agent.close();
// Store `saved` in your application's database or a file.
const resumed = await kit.open({ provider: "claude", model, cwd, resume: saved });
for await (const event of resumed.send("Continue where we left off")) {
  // Handle the same events as any other turn.
}
```

Keep the same provider, instance, configuration, working directory and kit state directory.
The token stores native session references and metadata; the provider must retain its native history.
It does not store a transcript or your provider credentials. Keep saved tokens private because they
can contain native paths and conversation metadata. Native resume support depends on the provider;
an arbitrary ACP agent must implement session resume/load. Send messages sequentially per session.

### Session controls

```ts
const capabilities = await agent.capabilities(); // negotiated for this opened session
const history = await agent.history();
const fork = await agent.fork();                 // independent AgentSession
await agent.rollback({ target, providerThreadTurns: history.providerTurns });
for await (const event of agent.compact("Keep the current task and decisions")) { /* ... */ }
await agent.configure({ model: nextModel, options: modelOptions });
await agent.configure({ runtimeMode: "approval-required" });
// While a native turn is running:
await agent.steer("Focus on the failing test first");
await agent.stopTask(taskId);
await agent.stopSubagent(nativeTaskId);
const { matched } = await agent.awaitBackgroundTasks(taskIds, true);
const pending = await agent.hasPendingBackgroundWork();
```

These methods delegate to the provider and reject unsupported operations. `rollback` takes T3's
checkpoint target (`thread_start` or `provider_turn`) and the known provider turns, exported as
`AgentRollbackOptions`. Rollback changes the conversation; it does not revert workspace files.
Forking a specific turn uses `agent.fork({ providerTurnId, sourceProviderTurns })` when supported.
`configure` applies model/option and runtime-policy changes while idle, using the provider's
transition plan. Changes that require a restart/handoff reject with instructions to reopen using
the serialized token. Provider option keys come from that provider's model settings; the kit does
not invent a universal effort key. `awaitBackgroundTasks` marks tasks as awaited/unawaited and
returns matched IDs; it does not block until those tasks complete.

`kit.capabilities({ provider })` returns the driver's baseline. Prefer `agent.capabilities()` after
opening, because protocols such as ACP negotiate additional abilities during startup. Operations
on one session are serialized: consume the active turn before history, fork, rollback or configure.
Use `steer`, `respond`, `interrupt` or task controls to interact during a turn. A second `send` is
rejected while a turn is active; separate sessions can run concurrently.

### Attachments and session listing

```ts
const file = await kit.attachment("/path/to/notes.txt", { mimeType: "text/plain" });
const image = await kit.attachment("/path/to/screenshot.png", { mimeType: "image/png" });
for await (const event of agent.send("Review these", { attachments: [file, image] })) { /* ... */ }

const active = kit.listSessions(); // AgentSession handles opened by this kit
const native = await kit.listNativeSessions({ provider: "acp", config, cwd });
```

`attachment` validates metadata/size and copies the file into the kit's attachment directory.
The provider still decides which attachment formats it can consume. `listSessions` lists open kit
handles; it does not scan native CLI histories or persist transcripts. `listNativeSessions` calls
the driver's native inventory (currently exposed by the generic ACP driver) and rejects for drivers
that do not expose one. Save `serialize()` tokens in your application to build a durable session list.
The kit has task controls but does not run T3's autonomous continuation worker or filesystem checkpoint manager.

### Model listing

`await kit.models({ provider: "pi" })` returns the provider's model catalog. Each entry includes
`slug`, `name`, capabilities, and optional default metadata. Pass the chosen `slug` to `kit.open()`.
Use `{ refresh: true }` to reload. Pi and OpenCode use their own configured providers and credentials;
model IDs include the backing provider, such as `openai-codex/...` or `opencode/...`.

### Usage and plan limits

```ts
const models = await kit.models({ provider: "codex" }); // slug, name, isDefault, capabilities, ...
// Pass { refresh: true } to reload, or cwd for workspace-specific discovery.
const { account, limits } = await kit.usageLimits({ provider: "claude" }); // { refresh: true } re-probes
// account: email and plan ("Claude Pro Subscription"); limits.windows: [{ label: "Session", usedPercent: 85, resetsAt }, ...]
const report = await kit.usage(); // { total, byInstance, byModel, pricing }
```

- **Plan limits** are available for Claude and Codex subscriptions, and for Antigravity after sign-in.
- **`usage()`** counts the turns this kit instance has run. It keeps no history across restarts.
- **`costUsd`** is a list-price estimate from LiteLLM's rate table, cached for 24h in the kit directory. On subscription plans it is the API-equivalent cost, not what you're billed. Models with no known price are counted in `unpricedTurns` and add nothing to the cost.
- Each turn's raw usage is also on `provider_turn.updated` events (`providerTurn.tokenUsage` and `providerTurn.turnTokenUsage`).

### API providers (DeepSeek, OpenRouter, ...)

```ts
kit.open({ ...anthropicCompatible({ baseUrl: "https://api.deepseek.com/anthropic", apiKey }), model, cwd });
kit.open({ ...openaiCompatible({ baseUrl: "https://openrouter.ai/api/v1", apiKey }), model, cwd });
```

- `anthropicCompatible` runs Claude Code against the endpoint.
- `openaiCompatible` runs Codex against the endpoint. The endpoint must support the **Responses API**:
  Codex 0.166 no longer accepts Chat Completions.

### Effect API

`agent-provider-kit/effect` exports the drivers and `KitRuntime.layer(options)`, which provides
every service they need.

## Live checks

```sh
node packages/providers/scripts/signin.ts antigravity        # one-time Google sign-in
# Inside T3 Code on Linux: avoid its HTTP port probes consuming the OAuth callback
node packages/providers/scripts/signin.ts antigravity --isolated
node packages/providers/scripts/smoke.ts claude claude-haiku-4-5
node packages/providers/scripts/smoke.ts codex gpt-6.1-sol
node packages/providers/scripts/smoke.ts antigravity gemini-3.8-flash-low
```

`pnpm typecheck` and `pnpm test` run the offline checks. 32 tests in `packages/shared` (GFM-table math,
the composer's inline tokens and one hourly-usage formatter) currently fail. They cover UI-only code the kit
does not call; the markdown pipeline the Codex adapter uses passes.
