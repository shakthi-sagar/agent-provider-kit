# Upstream

The code comes from [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit
`955e2bfbb5c092c54ad795c8d379fec99702a6b5`.

The upstream MIT license and copyright notice are preserved in [LICENSE](LICENSE).

## Layout

- `packages/{contracts,shared,provider-core,provider-acp,provider-acp-registry,provider-testing,provider-pi,provider-opencode,effect-acp,effect-codex-app-server}`
  are copied verbatim. The only change is the test runner: vite-plus was replaced by vitest
  (`from "vitest"`).
- `packages/providers/src` holds the relative-import closure of `apps/server/src/provider/Drivers/{Claude,Codex,Antigravity}Driver.ts`.
  Paths are kept the same as upstream, so updated files can be copied over directly.
- `packages/providers/src/kit` and `packages/kit` are new code for this repo.

To recopy the closure from a fresh T3 checkout:

```sh
node scripts/copy-closure.mjs <t3>/apps/server/src packages/providers/src \
  serverSettings.ts,preview/PortScanner.ts,provider/ProviderAuthService.ts,provider/CodexManagedRuntime.ts,textGeneration/ClaudeTextGeneration.ts,textGeneration/CodexTextGeneration.ts,textGeneration/AntigravityTextGeneration.ts \
  provider/Drivers/ClaudeDriver.ts provider/Drivers/CodexDriver.ts provider/Drivers/AntigravityDriver.ts
```

## Local changes (grep `agent-provider-kit`)

- **`usage/usagePricing.ts`** is copied unchanged from T3. The rest of T3's `usage/` service (transcript history) is not ported.
- **Shims** replace app-only modules and keep the same exports:
  - `serverSettings.ts` (in memory)
  - `preview/PortScanner.ts` (no-op)
  - `provider/ProviderAuthService.ts` (type re-export)
  - `provider/CodexManagedRuntime.ts` (interface only)
  - `textGeneration/*` (unsupported)
- **`provider/Drivers/CodexDriver.ts`**: managed Codex was removed, and `setupMode: "managed"` now fails.
  Reapply this edit after recopying.
- **`effect-codex-app-server/scripts/generate.ts`**: `CodexErrorInfo` now accepts unknown string
  codes. Without this, newer Codex error codes (for example `modelNotFound`) dropped the
  notification and the turn hung. Regenerate with:
  `PATH=../../node_modules/.bin:$PATH node scripts/generate.ts`.
- **`tsconfig.base.json`**: `deterministicKeys` is turned off.

## Pi and OpenCode

`packages/provider-pi` and `packages/provider-opencode` are copied from the same commit above,
including their RPC/server adapters, model discovery, session handling, usage readers and tests.
Their drivers are registered in the Promise facade and exported by `agent-provider-kit/effect`.
`KitRuntime` supplies OpenCode's runtime and server ownership ledger using the kit state directory.

Local adaptations:

- Test imports and scripts use Vitest instead of vite-plus.
- Pi's adapter test imports the copied `client-runtime/src/work-log/itemDetail.ts` as a local
  `itemDetail.testkit.ts`, avoiding a dependency on T3's client application.
- The root pnpm override pins Effect to the kit's 4.0.5 throughout OpenCode's dependencies.
  The OpenCode v2 packages otherwise pull in Effect 4.0.1, causing incompatible types and runtime identities.

## Promise facade session controls

The kit adds negotiated capability queries, explicit native resume, JSON tokens, history, fork,
rollback, compaction, idle selection/runtime-policy changes, attachments, steering and task controls.
Active kit session listing is separate from provider-native session listing. These wrappers reuse
upstream driver behavior; unsupported native operations remain unsupported. See `SESSION_SUPPORT.md`.

## Not ported

- Managed Codex
- Text generation
- The ACP MCP bridge
- Remote sign-in completion
- The Cursor, Grok and other drivers
- The upstream Claude and Codex adapter tests, which need about 250 app files each
