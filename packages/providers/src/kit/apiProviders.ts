// agent-provider-kit: API-key providers, run through a real agent loop instead of a raw chat API.
import type { InstanceOptions } from "./Agent.ts";

export interface ApiProviderOptions {
  /** API root, e.g. "https://api.deepseek.com/anthropic" or "https://openrouter.ai/api/v1". */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Instance name; give each endpoint its own. Defaults to one derived from the base URL host. */
  readonly instance?: string;
}

const instanceName = (prefix: string, options: ApiProviderOptions) =>
  options.instance ?? `${prefix}-${new URL(options.baseUrl).host.replaceAll(/[^a-z0-9]+/giu, "-")}`;

/**
 * Anthropic Messages-compatible endpoints (DeepSeek, OpenRouter, Moonshot, Z.ai, MiniMax, ...)
 * driven by Claude Code. Pass the endpoint's model slug to `open({ model })`.
 */
export const anthropicCompatible = (options: ApiProviderOptions): InstanceOptions => ({
  provider: "claude",
  instance: instanceName("anthropic-api", options),
  env: { ANTHROPIC_BASE_URL: options.baseUrl, ANTHROPIC_AUTH_TOKEN: options.apiKey },
});

const CODEX_KEY_ENV = "AGENT_PROVIDER_KIT_API_KEY";

/**
 * OpenAI Responses-compatible endpoints driven by Codex. Codex no longer speaks Chat
 * Completions (`wire_api = "chat"` is rejected), so chat-only endpoints need `anthropicCompatible`.
 */
export const openaiCompatible = (options: ApiProviderOptions): InstanceOptions => {
  const url = new URL(options.baseUrl);
  // Trust boundary: the URL lands inside a quoted CLI argument and a TOML string.
  if (!/^https?:$/u.test(url.protocol) || options.baseUrl.includes("'")) {
    throw new Error(`openaiCompatible needs a plain http(s) base URL, got ${options.baseUrl}`);
  }
  const provider = `{name="agent-provider-kit",base_url=${JSON.stringify(options.baseUrl)},env_key="${CODEX_KEY_ENV}",wire_api="responses"}`;
  return {
    provider: "codex",
    instance: instanceName("openai-api", options),
    config: { launchArgs: `-c model_provider=agent_provider_kit -c 'model_providers.agent_provider_kit=${provider}'` },
    env: { [CODEX_KEY_ENV]: options.apiKey },
  };
};
