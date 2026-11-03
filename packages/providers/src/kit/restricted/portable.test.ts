// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native protocol fixture processes are scoped and terminated by the transport.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import {
  openRestrictedSession,
  type RestrictedSession,
  type OpenRestrictedOptions,
} from "../Restricted.ts";
const fixture = Path.resolve(import.meta.dirname, "../../../scripts/restricted-mock-runtime.mjs");
const result = (value: unknown = { ok: true }) => ({ response: { kind: "result", value } });
const outputSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const inputSchema = {
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
  additionalProperties: false,
};
const sessions: RestrictedSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((p) => FS.rm(p, { recursive: true, force: true })));
});
async function setup(
  provider: string,
  responses: unknown[] = [result()],
  env: Record<string, string> = {},
  extra: Partial<OpenRestrictedOptions> = {},
) {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "apk-portable-"));
  roots.push(root);
  const log = Path.join(root, "requests.jsonl");
  const options: OpenRestrictedOptions = {
    provider,
    model: provider === "pi" ? "test/model" : provider === "opencode" ? "test/model" : "test",
    cwd: root,
    runtime: { command: process.execPath, args: [fixture, provider] },
    env: {
      HOME: root,
      USERPROFILE: root,
      KIT_TEST_LOG: log,
      KIT_TEST_COUNTER: Path.join(root, "counter"),
      KIT_TEST_RESPONSES: JSON.stringify(responses),
      ...env,
    },
    ...extra,
  };
  const context = { directory: Path.join(root, "profiles") };
  const session = openRestrictedSession(options, context);
  sessions.push(session);
  const entries = async () =>
    (await FS.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  return { root, session, options, context, entries };
}
describe.each(["pi", "opencode", "codex", "antigravity", "acp"])(
  "%s restricted transport",
  (provider) => {
    it("runs validated application tools, maintains context, and removes private run profiles", async () => {
      const tool = { response: { kind: "tool", name: "inspect", arguments: { id: 7 } } };
      const { session, entries, root, options, context } = await setup(provider, [
        tool,
        result(),
        result(),
      ]);
      const execute = vi.fn(async () => ({ visible: "only this" }));
      const response = await session.send({
        text: "Use the allowed inspection tool",
        outputSchema,
        tools: [{ name: "inspect", description: "Read permitted data", inputSchema, execute }],
        timeoutMs: 10000,
      });
      expect(response.output).toEqual({ ok: true });
      expect(response.toolCalls).toBe(1);
      expect(execute).toHaveBeenCalledOnce();
      const restored = openRestrictedSession({ ...options, resume: session.serialize() }, context);
      sessions.push(restored);
      await restored.send({
        text: "Continue, without previous tools",
        outputSchema,
        timeoutMs: 10000,
      });
      const records = await entries();
      const prompts = records.filter((e) => e.kind === "prompt");
      expect(prompts).toHaveLength(3);
      expect(JSON.stringify(prompts[1])).toContain("only this");
      expect(JSON.stringify(prompts[2])).toContain("Continue, without previous tools");
      const profileRoot = Path.join(root, "profiles", session.id);
      expect(await FS.readdir(profileRoot)).toEqual([]);
      const launch = records.find((e) => e.kind === "launch");
      expect(launch.cwd).not.toBe(root);
      expect(launch.home).not.toBe(root);
      if (provider === "pi")
        for (const flag of [
          "--no-tools",
          "--no-extensions",
          "--no-mcp",
          "--no-context-files",
          "--no-skills",
        ])
          expect(launch.args).toContain(flag);
      if (provider === "opencode") {
        const config = JSON.parse(launch.config);
        expect(config.permission).toEqual({ "*": "deny", StructuredOutput: "allow" });
        expect(config.mcp).toEqual({});
        expect(launch.args).toContain("--pure");
      }
      if (provider === "codex") {
        const execution = records.find((e) => e.kind === "launch" && e.args.includes("exec"));
        expect(execution.args).toContain("features.shell_tool=false");
        expect(execution.args).toContain("features.hooks=false");
        expect(execution.args).toContain("--output-schema");
      }
      if (provider === "antigravity") {
        const creation = records.find((e) => e.request?.method === "session/new");
        expect(creation.request.params._meta.antigravity.enabledTools).toEqual([]);
        expect(creation.request.params.mcpServers).toEqual([]);
      }
    }, 20000);
    it("rejects invalid or unavailable tool arguments before invoking application code", async () => {
      const { session } = await setup(provider, [
        { response: { kind: "tool", name: "inspect", arguments: { id: "wrong" } } },
      ]);
      const execute = vi.fn(async () => null);
      await expect(
        session.send({
          text: "inspect",
          outputSchema,
          tools: [{ name: "inspect", description: "inspect", inputSchema, execute }],
          timeoutMs: 10000,
        }),
      ).rejects.toThrow(/validation/);
      expect(execute).not.toHaveBeenCalled();
    }, 15000);
    it("rejects invalid final output", async () => {
      const { session } = await setup(provider, [result({ ok: "invalid" })]);
      await expect(
        session.send({ text: "respond", outputSchema, timeoutMs: 10000 }),
      ).rejects.toThrow(/validation/);
    }, 15000);
    it("aborts stalled native work and allows no concurrent turn", async () => {
      const { session } = await setup(provider, [result()], { KIT_TEST_HANG: "1" });
      const pending = session.send({ text: "hang", outputSchema, timeoutMs: 1200 });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await expect(session.send({ text: "concurrent", outputSchema })).rejects.toThrow(
        /already active/,
      );
      await assertion;
    }, 10000);
  },
);
it("refuses generic ACP without an advertised restriction capability before prompting", async () => {
  const { session, entries } = await setup("acp", [result()], { KIT_TEST_NO_POLICY: "1" });
  await expect(session.send({ text: "secret observation", outputSchema })).rejects.toThrow(
    /does not negotiate/,
  );
  expect((await entries()).some((e) => e.kind === "prompt")).toBe(false);
});
it.each(["acp", "opencode"])(
  "refuses %s when the native session does not acknowledge deny-all",
  async (provider) => {
    const { session, entries } = await setup(provider, [result()], { KIT_TEST_BAD_POLICY: "1" });
    await expect(session.send({ text: "secret observation", outputSchema })).rejects.toThrow(
      /policy|permission rule/,
    );
    expect((await entries()).some((e) => e.kind === "prompt")).toBe(false);
  },
);

it.each(["pi", "opencode", "codex", "antigravity", "acp"])(
  "rejects unenforceable dollar budgets for %s before startup",
  async (provider) => {
    const { session } = await setup(provider);
    await expect(session.send({ text: "choose", outputSchema, maxBudgetUsd: 0.1 })).rejects.toThrow(
      /cannot enforce/,
    );
  },
);
it("honours explicit validated-json mode on schema-capable ACP", async () => {
  const { session, entries } = await setup("acp", [result()], {}, { outputMode: "validated-json" });
  expect((await session.send({ text: "choose", outputSchema })).outputMode).toBe("validated-json");
  const prompt = (await entries()).find((e) => e.request?.method === "session/prompt");
  expect(prompt.request.params._meta.outputSchema).toBeUndefined();
});
