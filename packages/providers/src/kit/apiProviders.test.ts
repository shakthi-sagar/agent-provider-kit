import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { assert, describe, it } from "vitest";

import { anthropicCompatible, openaiCompatible } from "./apiProviders.ts";

describe("API providers", () => {
  it("points Claude Code at an Anthropic-compatible endpoint", () => {
    const options = anthropicCompatible({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-1" });
    assert.equal(options.provider, "claude");
    assert.equal(options.instance, "anthropic-api-api-deepseek-com");
    assert.deepEqual(options.env, {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-1",
    });
  });

  it("gives Codex a custom Responses provider that survives T3's argument tokenizer", () => {
    const options = openaiCompatible({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-2" });
    const launchArgs = (options.config as { launchArgs: string }).launchArgs;
    assert.deepEqual(tokenizeCliArgs(launchArgs), [
      "-c",
      "model_provider=agent_provider_kit",
      "-c",
      'model_providers.agent_provider_kit={name="agent-provider-kit",base_url="https://openrouter.ai/api/v1",env_key="AGENT_PROVIDER_KIT_API_KEY",wire_api="responses"}',
    ]);
    assert.deepEqual(options.env, { AGENT_PROVIDER_KIT_API_KEY: "sk-2" });
  });

  it("rejects base URLs that could break out of the quoted argument", () => {
    assert.throws(() => openaiCompatible({ baseUrl: "https://x.test/'v1", apiKey: "k" }));
    assert.throws(() => openaiCompatible({ baseUrl: "file:///etc/passwd", apiKey: "k" }));
  });
});
