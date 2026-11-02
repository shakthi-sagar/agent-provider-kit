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
