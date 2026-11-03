# Session support

## Coding sessions

`kit.open()` creates a coding-agent session. Repeated `send()` calls keep its conversation.
Save `agent.serialize()` and pass the token as `open({ resume })` to reopen later. Keep the same
provider, instance, credentials, working directory and kit state directory. Native history must
still exist; a token is not a transcript. Resume preserves native identity and turn numbering.

The Promise API exposes capabilities, model catalogs, history, fork, rollback, compaction,
configuration changes, attachments, steering, approvals/user input, interruption and task/subagent
controls. Support depends on the provider; unsupported operations reject rather than emulate success.
`listSessions()` returns coding handles currently owned by this kit. `listNativeSessions()` uses
native driver inventory, currently exposed by generic ACP. Durable session lists/transcripts belong
to the application. The kit does not run T3's autonomous continuation worker or filesystem checkpoint manager.

Coding sessions default to full access. They are intended for applications that deliberately give
an agent workspace/editor/shell access. `approval-required` alone is not a game-only tool policy.

## Restricted sessions (0.2.0)

`kit.openRestricted()` supports Claude, Pi, OpenCode, Codex and Antigravity through separate
restricted transports. Ordinary coding defaults are unchanged. `send()` accepts plain JSON Schema,
per-turn application tools, deadlines, cancellation, turn limits and tool-call limits. Tool inputs
are validated before handlers execute; final values and optional tool outputs are validated too.
Missing or invalid output rejects. The default tool list is empty and replaces the prior list.

Claude uses native SDK tools and native resume. The other transports disable native tools and use a
host-mediated JSON action protocol. Their `serialize()` tokens preserve bounded conversation history,
replayed into fresh native processes. Tokens bind provider, model and logical cwd, contain conversation
and tool-result text, and must be kept private. They are incompatible with ordinary coding tokens.
The native workspaces/profiles are private and disposable; caller cwd is not exposed to the model.

Pi and Antigravity return `outputMode: "validated-json"`: exact JSON parsing followed by local schema
validation. Codex/OpenCode default to `native-schema` and also support explicit `validated-json`.
There is no automatic fallback from schema generation or extraction of JSON from arbitrary prose.
Claude supports native-schema only. Unknown cost is `null`; `maxBudgetUsd` is Claude-only and rejects
on other transports. All support cancellation and kit-owned cleanup.

Verified native contracts: Pi 1.4.0 flags, OpenCode v1 API (tested 1.18.35), Codex 0.166.x
(explicit version guard), Antigravity 1.4.1+ enabledTools allowlist. Runtime executables are trusted.
Updates may require adapter changes; rejection is preferable to weakening tool policy.

Generic ACP requires `runtime: { command, args? }` and an extension, since standard ACP cannot disable
internal tools. Initialization must advertise `_meta.agentProviderKit` with `restrictedExecution: 1`
and `nativeTools: "deny-all"`. The session must acknowledge the requested policy with
`nativeTools: "deny-all"`, `inheritedMcp: false`, `contextFiles: false`, `hooks: false`.
The client disables filesystem/terminal callbacks and requests no MCP servers. Native output schema
support must also be explicitly advertised; otherwise the transport uses validated-json. Unmodified
ACP servers without this enforcement contract reject before a prompt is sent.

## Trust boundary

Restricted execution is a model-tool boundary, not an OS sandbox. The native CLI still accesses its
own credentials, network and session files. Application-supplied schemas and handlers are trusted;
handlers must enforce authorization and honour cancellation. Already-performed side effects cannot
be undone by aborting a turn. Host administrator-managed policy is outside the kit's control; the
normal user/project hooks are disabled. Isolate the process separately where untrusted host policy
or process-level access is a concern.

For contestants, supply only filtered observations, use a disposable cwd containing no hidden data,
and validate actions again inside the game engine. For Archive, structured edits can be reviewed
before applying them. For Content Factory, explicit studio handlers must preserve the human approval
step; coding sessions remain appropriate when shell/editor access is intentional.

The package supplies the Claude SDK's Zod 4 dependency independently of a host application's Zod 3.
The public schema boundary accepts JSON Schema, with no Zod types required.

## Verification

Facade and restricted tests cover lifecycle, resume, schema rejection, per-turn tool dispatch,
policy acknowledgment, cancellation, timeouts and teardown using protocol fixtures and mocked SDK
queries. Run the targeted kit tests and workspace typecheck before packaging.

`pnpm verify:restricted-native` exercises real installed Pi, Codex and OpenCode binaries against a
local fake model API with dummy credentials. It checks that only the internal OpenCode formatter
(or no native tools) reaches the API and that application tool results reach the next completion.
`pnpm verify:restricted-antigravity` checks the installed native Python allowlist implementation:
an empty allowlist disables all 15 built-ins. Antigravity protocol behavior is also fixture-tested;
live Antigravity authentication/inference has not been exercised. These checks use no live inference
credits. Claude SDK enforcement is fixture-tested plus an initialization-only native control check.

The npm build is checked separately after these tests. No release is published by these commands.
